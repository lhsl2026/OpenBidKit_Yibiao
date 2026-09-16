const { randomUUID } = require('node:crypto');
const { key } = require('./store.cjs');
const { deliverGroupFileStatus, deliverOutbox } = require('./lark.cjs');
const { buildSummary } = require('./card.cjs');
const { enqueueArtifacts, deliverFiles } = require('./files.cjs');
const { recordReceipt, inspectReceipt, isSourceInboxActive } = require('./receipt.cjs');
const { normalizeRadarContent } = require('./preread.cjs');

function createRunner({ store, config, workflow, preread, lark, write, onReceipt, onSourceEdited, onTick, groupFileSource, clock = Date.now }) {
  const owner = randomUUID(), controller = new AbortController();
  let running = false, acquired = false, lost = false, closing = false, renewal;
  const radarSource = require('./radar-source.cjs').createRadarSource({store,config,receive:receiveRadar,clock,assertOwnership,signal:controller.signal});
  const revalidate = id => workflow.revalidate ? workflow.revalidate(id) : store.getProject(id);
  const watchActive=w=>{const current=store.getWatch(w.task_id);return !!current&&JSON.stringify(current.payload)===JSON.stringify(w.payload)&&(!w.payload.sourceInboxId||isSourceInboxActive(store,w.payload.sourceInboxId));};

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
            assertOwnership(); const handoff = await preread.getHandoff(w.task_id); assertOwnership();
            if(!watchActive(w))continue;
            workflow.ingest({ ...w.payload, handoff }); store.deferWatch(w.task_id, clock());
          } catch { assertOwnership(); if(watchActive(w))store.deferWatch(w.task_id, clock(), 'handoff_unavailable'); }
        }
      }
      if(onTick){assertOwnership();await onTick({signal:controller.signal});assertOwnership();}
      recoverArtifacts();
      if (write) for (const selected of store.listWriting().filter(j => j.status === 'queued')) {
        assertOwnership(); let p = revalidate(selected.project_id);
        const job = store.listWriting().find(j => j.id === selected.id);
        if (!canWrite(p, clock()) || job.status !== 'queued') {
          if (job.status === 'queued') store.updateWriting(job.id, 'cancelled', { code: 'project_not_ready' }, clock());
          continue;
        }
        store.transaction(() => { store.updateWriting(job.id, 'running', job.result, clock()); store.touchCard(p.id, clock()); });
        let result;
        try { result = await write({ ...job.payload, stage: job.stage }, { signal: controller.signal }); }
        catch { result = { status: 'failed', code: 'worker_failed' }; }
        assertOwnership(); p = revalidate(job.project_id);
        const current = store.listWriting().find(j => j.id === job.id);
        if (!canWrite(p, clock()) || current.status !== 'running') {
          store.updateWriting(job.id, 'cancelled', { code: 'project_changed' }, clock()); continue;
        }
        if (!result || typeof result.status !== 'string') result = { status: 'failed', code: 'worker_result_invalid' };
        store.transaction(() => {
          if (result.status === 'completed' && result.nextStage) store.updateWriting(job.id, 'queued', result, clock(), result.nextStage);
          else store.updateWriting(job.id, result.status, result, clock());
          store.touchCard(p.id, clock());
        });
        recoverArtifacts();
      }
      assertOwnership();
      const local = new Date(clock() + 8 * 3600000), day = local.toISOString().slice(0, 10);
      if (local.getUTCHours() >= config.summaryHour) store.enqueueSummary(day, buildSummary(day, store.listProjects(), store.countPendingWatches(config.companyId)));
      if (lark) {
        const args = { store, client: lark, mode: config.mode, chatId: config.chatId, allowedChats: config.allowedChats, clock, assertOwnership, revalidate };
        if(groupFileSource)await deliverGroupFileStatus(args);
        if (config.writingRoot) await deliverFiles({ ...args, root: config.writingRoot });
        await deliverOutbox(args);
      }
    } finally { running = false; }
  }
  async function close() {
    closing = true; controller.abort(new Error('runner_stopping'));
    while (running) await new Promise(r => setTimeout(r, 20));
    clearInterval(renewal); if (acquired) store.release('runner', owner); acquired = false;
  }
  return { tick, receiveRadar, acquire, assertOwnership, close, isRunning: () => running };
}
function canWrite(p, now) {
  return p?.current && p.humanDecision === 'follow' && p.assessment.decision === 'follow' && p.input.handoff.status === 'ready'
    && !p.input.handoff.superseded && !p.input.handoff.warnings.some(w => w.blocked) && Date.parse(p.input.deadline) > now;
}
module.exports = { createRunner, canWrite };
