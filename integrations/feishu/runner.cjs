const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { key } = require('./store.cjs');
const { deliverGroupFileStatus, deliverOutbox, reconcilePrereadDeliveries } = require('./lark.cjs');
const { buildSummary } = require('./card.cjs');
const { enqueueArtifacts, deliverFiles } = require('./files.cjs');
const { recordReceipt, inspectReceipt, isSourceInboxActive } = require('./receipt.cjs');
const { normalizeRadarContent } = require('./preread.cjs');
const { canGenerateDraft } = require('./writing-policy.cjs');
const { recoverWritingSource, stageVerifiedWritingSource } = require('./source-recovery.cjs');

function createRunner({ store, config, workflow, preread, lark, write, recoverSource, stageSource, onReceipt, onSourceEdited, onTick, groupFileSource, clock = Date.now }) {
  const owner = randomUUID(), controller = new AbortController();
  let running = false, writingLane = null, acquired = false, lost = false, closing = false, renewal;
  const radarSource = require('./radar-source.cjs').createRadarSource({store,config,receive:receiveRadar,clock,assertOwnership,signal:controller.signal});
  const revalidate = id => workflow.revalidate ? workflow.revalidate(id) : store.getProject(id);
  const watchActive=w=>{const current=store.getWatch(w.task_id);return !!current&&JSON.stringify(current.payload)===JSON.stringify(w.payload)&&(!w.payload.sourceInboxId||isSourceInboxActive(store,w.payload.sourceInboxId));};
  const sourceRecovery=recoverSource??(preread&&config.writingRoot?({project})=>recoverWritingSource({project,root:config.writingRoot,client:preread}):null);
  const sourceStaging=stageSource??(config.writingRoot?input=>stageVerifiedWritingSource({
    ...input,
    root:config.writingRoot,
    allowedRoots:[config.groupFileSource?.root?path.join(config.groupFileSource.root,'objects'):null,config.documentRecovery?.root].filter(Boolean),
  }):null);

  function loseOwnership() {
    lost = true; clearInterval(renewal); controller.abort(new Error('runner_lease_lost'));
  }
  function assertOwnership() {
    if (lost || !acquired || !store.ownsLease('runner', owner, clock())) {
      loseOwnership(); throw Error('runner_lease_lost');
    }
  }
  function acquire() {
    if (closing || lost) return false;
    if (acquired) { assertOwnership(); return true; }
    const ok = store.transaction(() => {
      if (!store.lease('runner', owner, clock(), 60000)) return false;
      // Recovery is protected by the same ownership used throughout this service lifetime.
      for (const job of store.listWriting().filter(j => j.status === 'running')) {
        store.updateWriting(job.id, 'interrupted', { code: 'process_interrupted' }, clock());
        store.touchCard(job.project_id, clock());
      }
      return true;
    });
    if (!ok) return false;
    acquired = true;
    renewal = setInterval(() => {
      try { if (!store.renewLease('runner', owner, clock(), 60000)) loseOwnership(); }
      catch { loseOwnership(); }
    }, 15000);
    renewal.unref(); return true;
  }
  function receiveRadar(input) {
    if (acquired || lost) assertOwnership();
    if (!config.sourceChats?.includes(input.chatId) || !config.sourceSenders?.includes(input.senderId)) throw Error('source_not_allowed');
    if (input.eventType !== 'im.message.receive_v1' || !input.messageId || !input.eventId) throw Error('radar_invalid');
    const normalizedContent=normalizeRadarContent(input.messageType,input.content);
    const messageKey=key('radar-message',input.chatId,input.messageId),stateKey='radar-message:'+messageKey;
    const inboxId=key('radar',input.chatId,input.messageId,input.messageType,normalizedContent);
    const payload = Object.fromEntries(['eventType', 'chatId', 'chatType', 'messageId', 'messageType', 'createTime', 'senderId', 'senderType', 'content'].filter(k => input[k] !== undefined).map(k => [k, input[k]]));
    payload.eventId='openbidkit-radar-'+inboxId;
    return store.transaction(()=>{
      const state=store.get(stateKey);
      if(!state){
        store.receiveRadar(inboxId,payload);store.set(stateKey,{status:'active',original:{inboxId,messageType:input.messageType,content:input.content,normalizedContent},edits:[]});store.set('radar-inbox:'+inboxId,stateKey);
        return {status:'accepted'};
      }
      if(state.original.inboxId===inboxId){store.receiveRadar(inboxId,payload);store.set('radar-inbox:'+inboxId,stateKey);return {status:state.status==='edited_requires_review'?state.status:'accepted'};}
      const edits=Array.isArray(state.edits)?state.edits:[];
      if(!edits.some(edit=>edit.inboxId===inboxId))edits.push({inboxId,messageType:input.messageType,content:input.content,normalizedContent,receivedAt:clock()});
      let taskIds=[...(state.linkedTaskIds??[]),...store.listWatchesBySource(state.original.inboxId).map(w=>w.task_id)];const receipt=store.get('radar-receipt:'+state.original.inboxId);
      if(receipt)try{taskIds.push(...inspectReceipt(receipt).taskIds);}catch{}
      taskIds=[...new Set([...taskIds,...store.listWatchesBySource(state.original.inboxId).map(w=>w.task_id)])];
      for(const taskId of taskIds){
        store.unwatch(taskId);const project=store.current(taskId,config.companyId);
        if(project)store.reassess(project.id,{...project.assessment,decision:'review',blockers:[...new Set([...(project.assessment.blockers??[]),'source_message_edited'])],actions:[...new Set([...(project.assessment.actions??[]),'review_edited_source_message'])]},clock(),{...project.input,sourceMessage:{status:'edited_requires_review',inboxId:state.original.inboxId}});
      }
      store.finishInbox(state.original.inboxId);store.set(stateKey,{...state,status:'edited_requires_review',edits,linkedTaskIds:taskIds});if(onSourceEdited)onSourceEdited(state.original.inboxId);
      return {status:'edited_requires_review'};
    });
  }
  function recoverArtifacts() {
    if (!config.writingRoot) return;
    for (const job of store.listWriting()) {
      if (!['queued', 'completed', 'waiting_confirmation'].includes(job.status) || !job.result) continue;
      const marker = 'artifactsQueued:' + key(job.id, job.payload.deliveryEpoch, job.result);
      if (store.get(marker)) continue;
      assertOwnership(); const p = revalidate(job.project_id);
      if (!canWrite(p, clock())) continue;
      // Result already persisted: disk/SQL failure is safely retried next tick, never by rerunning the model.
      store.transaction(() => {
        enqueueArtifacts(store, p.id, job.result, config.writingRoot);
        store.set(marker, true); store.touchCard(p.id, clock());
      });
    }
  }
  async function recoverWritingSources(){
    if(!sourceRecovery&&!sourceStaging)return;
    for(const candidate of store.listWriting().filter(job=>job.status==='queued'||(job.status==='waiting_confirmation'&&job.result?.code==='source_required'))){
      assertOwnership();let project=revalidate(candidate.project_id);if(!canWrite(project,clock()))continue;
      const expected=String(project?.checksum??'').replace(/^sha256:/i,'').toLowerCase();
      if(candidate.payload?.sourcePath){
        if(!sourceStaging)continue;
        let source;try{source=await sourceStaging({project,job:candidate,sourcePath:candidate.payload.sourcePath,sha256:expected});}
        catch{assertOwnership();store.transaction(()=>{store.updateWriting(candidate.id,'failed',{status:'failed',stage:candidate.stage,code:'source_import_failed',message:'招标原文件导入写标工作区失败'},clock());store.touchCard(project.id,clock());});continue;}
        assertOwnership();project=revalidate(candidate.project_id);const current=store.listWriting().find(job=>job.id===candidate.id);
        if(!current||!canWrite(project,clock())||current.status!=='queued'||source?.sha256!==expected||typeof source?.sourcePath!=='string')continue;
        if(current.payload.sourcePath!==source.sourcePath||current.payload.sourceChecksum!==source.sha256){
          store.transaction(()=>{store.resumeWriting(current,{...current.payload,sourcePath:source.sourcePath,sourceChecksum:source.sha256},clock(),current.stage);store.touchCard(project.id,clock());});
        }
        continue;
      }
      if(!sourceRecovery)continue;
      const stateKey='sourceRecovery:'+candidate.id,backoff=store.get(stateKey);if(backoff?.nextAt>clock())continue;
      let source;try{source=await sourceRecovery({project,job:candidate});}catch{assertOwnership();store.set(stateKey,{nextAt:clock()+60000});continue;}
      assertOwnership();project=revalidate(candidate.project_id);const current=store.listWriting().find(job=>job.id===candidate.id);
      if(!current||!canWrite(project,clock())||current.payload?.sourcePath||source?.sha256!==expected||typeof source?.sourcePath!=='string')continue;
      store.transaction(()=>{store.resumeWriting(current,{...current.payload,sourcePath:source.sourcePath,sourceChecksum:source.sha256},clock(),current.stage);store.set(stateKey,{completed:true});store.touchCard(project.id,clock());});
    }
  }
  function recoverLegacyOutlineSelections(){
    for(const candidate of store.listWriting().filter(job=>job.status==='failed'&&job.stage==='outline'&&job.result?.code==='invalid_outline_selection'&&Array.isArray(job.payload?.confirmations?.outlineSelection?.selectedIds)&&job.payload.confirmations.outlineSelection.selectedIds.length===0)){
      assertOwnership();const project=revalidate(candidate.project_id);if(!canWrite(project,clock()))continue;
      const stateKey='legacyOutlineRecovery:'+candidate.id;if(store.get(stateKey))continue;
      store.transaction(()=>{store.resumeWriting(candidate,candidate.payload,clock(),candidate.stage);store.set(stateKey,{completed:true});store.touchCard(project.id,clock());});
    }
  }
  function startWritingLane() {
    if (!write || writingLane || closing || controller.signal.aborted) return;
    const selected = store.listWriting().find(job => job.status === 'queued');
    if (!selected) return;
    assertOwnership();
    let project = revalidate(selected.project_id);
    const job = store.listWriting().find(item => item.id === selected.id);
    if (!job || !canWrite(project, clock()) || job.status !== 'queued') {
      if (job?.status === 'queued') store.updateWriting(job.id, 'cancelled', { code: 'project_not_ready' }, clock());
      return;
    }
    store.transaction(() => { store.updateWriting(job.id, 'running', job.result, clock()); store.touchCard(project.id, clock()); });
    const lane = (async () => {
      let result;
      try { result = await write({ ...job.payload, stage: job.stage }, { signal: controller.signal }); }
      catch { result = controller.signal.aborted ? { status: 'interrupted', code: 'runner_stopping' } : { status: 'failed', code: 'worker_failed' }; }
      if (lost) return;
      assertOwnership(); project = revalidate(job.project_id);
      const current = store.listWriting().find(item => item.id === job.id);
      if (!current || !canWrite(project, clock()) || current.status !== 'running') {
        if (current?.status === 'running') store.updateWriting(job.id, 'cancelled', { code: 'project_changed' }, clock());
        return;
      }
      if (controller.signal.aborted) result = { status: 'interrupted', code: 'runner_stopping' };
      if (!result || typeof result.status !== 'string') result = { status: 'failed', code: 'worker_result_invalid' };
      store.transaction(() => {
        if (result.status === 'completed' && result.nextStage) store.updateWriting(job.id, 'queued', result, clock(), result.nextStage);
        else if (current.stage === 'content' && result.status === 'interrupted' && result.code === 'worker_timeout' && result.checkpointProgressed === true) {
          store.updateWriting(job.id, 'queued', { ...result, automaticContinuation: true }, clock(), current.stage);
        }
        else store.updateWriting(job.id, result.status, result, clock());
        store.touchCard(project.id, clock());
      });
      recoverArtifacts();
    })();
    writingLane = lane;
    lane.catch(() => {}).finally(() => { if (writingLane === lane) writingLane = null; });
  }
  async function tick() {
    if (running || closing || !acquire()) return;
    running = true;
    try {
      assertOwnership();
      await radarSource.poll();
      assertOwnership();
      if(groupFileSource){await groupFileSource.poll();assertOwnership();await groupFileSource.tick({signal:controller.signal});assertOwnership();}
      if (preread) {
        for (const row of store.listInbox(clock())) {
          try {
            assertOwnership(); const result = await preread.receiveRadar(row.payload); assertOwnership();
            if(!isSourceInboxActive(store,row.id)){store.set('radar-receipt:'+row.id,result);continue;}
            recordReceipt({store,inboxId:row.id,response:result,companyId:config.companyId,now:clock(),onReceipt});
          } catch { assertOwnership(); store.retryInbox(row.id, clock()); }
        }
        for (const w of store.listWatches(clock())) {
          try {
            assertOwnership(); const handoff=await preread.getHandoff(w.task_id); assertOwnership();
            let tenderRun,companyState,companyError;
            if(typeof preread.getTenderRun==='function'){
              try{tenderRun=await preread.getTenderRun(w.task_id);}catch{}
              assertOwnership();
            }
            if(typeof preread.getCompanyMatchCard==='function'){
              try{companyState=await preread.getCompanyMatchCard(w.task_id);}catch{companyError='company_match_unavailable';}
              assertOwnership();
            }
            if(!watchActive(w))continue;
            const prereadRunIdentity=tenderRun?.engine==='five_module'&&typeof tenderRun.runId==='string'&&tenderRun.runId&&handoff?.task?.taskId===w.task_id&&String(tenderRun.documentVersion)===String(handoff?.snapshot?.documentVersion)?{taskId:w.task_id,runId:tenderRun.runId,documentVersion:tenderRun.documentVersion}:undefined;
            const companyMatchCard=companyState?{...companyState,scopeType:companyState.scopeType??'group',scopeId:companyState.scopeId??config.chatId}:undefined;
            const project=workflow.ingest({ ...w.payload, handoff, ...(companyMatchCard?{companyMatchCard}:{}) });
            if(prereadRunIdentity){
              const identityKey='preread-run-identity:'+project.id,previous=store.get(identityKey);
              if(JSON.stringify(previous)!==JSON.stringify(prereadRunIdentity))store.set(identityKey,prereadRunIdentity);
            }
            if(tenderRun){
              const messageId=typeof tenderRun?.deliveryStatusCardMessageId==='string'?tenderRun.deliveryStatusCardMessageId.trim():'';
              const runId=typeof tenderRun?.runId==='string'?tenderRun.runId.trim():'';
              const deliveredAt=typeof tenderRun?.deliveredAt==='string'?tenderRun.deliveredAt.trim():'';
              if(tenderRun?.engine==='five_module'&&tenderRun.deliveryStatus==='delivered'&&runId&&messageId&&Number.isFinite(Date.parse(deliveredAt))&&String(tenderRun.documentVersion)===String(project.version)){
                const marker={runId,deliveredAt,messageId,documentVersion:String(project.version)},markerKey='preread-delivery-handoff:'+project.id;
                store.transaction(()=>{const current=store.getProject(project.id),previous=store.get(markerKey);if(current?.current&&current.messageId===messageId&&JSON.stringify(previous)!==JSON.stringify(marker)){store.set(markerKey,marker);store.touchCard(current.id,clock());}});
              }
            }
            store.deferWatch(w.task_id, clock(),companyError);
          } catch { assertOwnership(); if(watchActive(w))store.deferWatch(w.task_id, clock(), 'handoff_unavailable'); }
        }
      }
      if(onTick){assertOwnership();await onTick({signal:controller.signal});assertOwnership();}
      recoverLegacyOutlineSelections();
      recoverArtifacts();
      await recoverWritingSources();
      startWritingLane();
      assertOwnership();
      const local = new Date(clock() + 8 * 3600000), day = local.toISOString().slice(0, 10);
      if (local.getUTCHours() >= config.summaryHour) store.enqueueSummary(day, buildSummary(day, store.listProjects(), store.countPendingWatches(config.companyId)));
      if (lark) {
        const args = { store, client: lark, preread, mode: config.mode, chatId: config.chatId, allowedChats: config.allowedChats, forbiddenChats: config.forbiddenChats, clock, assertOwnership, revalidate };
        if(groupFileSource)await deliverGroupFileStatus(args);
        if (config.writingRoot) await deliverFiles({ ...args, root: config.writingRoot });
        await deliverOutbox(args);
        await reconcilePrereadDeliveries(args);
      }
    } finally { running = false; }
  }
  async function close() {
    closing = true; controller.abort(new Error('runner_stopping'));
    while (running) await new Promise(r => setTimeout(r, 20));
    if (writingLane) await writingLane.catch(() => {});
    clearInterval(renewal); if (acquired) store.release('runner', owner); acquired = false;
  }
  return { tick, receiveRadar, acquire, assertOwnership, close, isRunning: () => running, isWriting: () => Boolean(writingLane) };
}
function canWrite(p, now) {
  return canGenerateDraft(p, now);
}
module.exports = { createRunner, canWrite };
