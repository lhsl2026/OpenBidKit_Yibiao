const {key}=require('./store.cjs');
function validateInput(input){
  const h=input?.handoff,s=h?.snapshot;
  if(!input.companyId||h?.schemaVersion!=='1.0'||!h.task?.taskId||!h.task?.title||!s?.documentVersion||!s.reportId||!s.checksum||!Number.isFinite(Date.parse(s.generatedAt))||!Array.isArray(h.requirements)||!Array.isArray(h.warnings)||!Array.isArray(h.evidence))throw new Error('invalid_handoff');
  if(h.superseded||h.latestDocumentVersion!==s.documentVersion)throw new Error('stale_handoff');
}
function createWorkflow({store,assess,normalizeInput=input=>input,clock=Date.now,chatId,operatorIds=[]}){
  const assessed=input=>{
    const value=assess(input);
    if(input?.sourceMessage?.status!=='edited_requires_review')return value;
    return {...value,decision:'review',blockers:[...new Set([...(value.blockers??[]),'source_message_edited'])],actions:[...new Set([...(value.actions??[]),'review_edited_source_message'])]};
  };
  function revalidate(id){return store.transaction(()=>{
    const p=store.getProject(id);if(!p?.current)return p;
    const input=normalizeInput(p.input),assessment=assessed(input);
    if(JSON.stringify(p.input)!==JSON.stringify(input)||JSON.stringify(p.assessment)!==JSON.stringify(assessment))return store.reassess(id,assessment,clock(),input);
    return p;
  });}
  return {
    revalidate,
    ingest(input){validateInput(input);input=normalizeInput(input);return store.transaction(()=>{
      const h=input.handoff,s=h.snapshot,now=clock();const version=String(s.documentVersion);const id=key(h.task.taskId,input.companyId,version);
      const existing=store.getProject(id);const assessment=assessed(input);
      if(existing){if(!existing.current)throw new Error('stale_handoff');if(existing.checksum!==s.checksum)throw new Error('version_conflict');if(JSON.stringify(existing.assessment)!==JSON.stringify(assessment)||JSON.stringify(existing.input)!==JSON.stringify(input))return store.reassess(id,assessment,now,input);return existing;}
      const current=store.current(h.task.taskId,input.companyId);
      if(current&&Date.parse(current.generatedAt)>=Date.parse(s.generatedAt))throw new Error('stale_handoff');
      if(current)store.supersede(current.id);
      const p={id,taskId:h.task.taskId,companyId:input.companyId,version,checksum:s.checksum,generatedAt:s.generatedAt,input,assessment,messageId:current?.messageId,created:now,revision:1};store.saveProject(p);return store.getProject(id);
    });},
    act(action){
      if(!chatId||action.chatId!==chatId||!operatorIds.includes(action.actorId))throw new Error('actor_not_allowed');
      // Persist revocations even when the requested action is rejected below.
      revalidate(action.projectId);
      return store.transaction(()=>{
      if(!chatId||action.chatId!==chatId||!operatorIds.includes(action.actorId))throw new Error('actor_not_allowed');
      if(!action.eventId||!['follow','defer','decline','write','continue','retry','page'].includes(action.action))throw new Error('invalid_action');
      const p=store.getProject(action.projectId);
      if(!p||!p.current||action.version!==p.version)throw new Error('stale_card');
      if(p.input?.sourceMessage?.status==='edited_requires_review'&&['follow','write','continue','retry'].includes(action.action))throw new Error('source_message_edited');
      if(!p.messageId||action.messageId!==p.messageId)throw new Error('message_mismatch');
      if(action.cardKey!==key(p.input,p.assessment))throw new Error('stale_card');
      const hash=key(action);const previous=store.getAction(action.eventId);if(previous){if(previous.hash!==hash)throw new Error('event_conflict');return previous.result;}
      let result;
      if(action.action==='page'){
        const pages=Math.max(1,Math.ceil(p.input.handoff.requirements.length/4));
        if(!Number.isInteger(action.page)||action.page<0||action.page>=pages)throw Error('page_invalid');
        store.set('cardPage:'+p.id,action.page);store.touchCard(p.id,clock());result={projectId:p.id,status:'view_updated'};
      }else if(['write','continue','retry'].includes(action.action)){
        if(p.humanDecision!=='follow')throw new Error('follow_required');
        const h=p.input.handoff;const deadline=Date.parse(p.input.deadline);
        if(h.status!=='ready'||h.superseded||h.warnings.some(w=>w.blocked)||!Number.isFinite(deadline)||deadline<=clock()||p.assessment.decision!=='follow'||assessed(p.input).decision!=='follow')throw new Error('writing_not_ready');
        let jobId;
        if(action.action==='write')jobId=store.enqueueWriting(p,clock());
        else{
          const job=store.listWriting().find(j=>j.project_id===p.id);if(!job)throw Error('writing_missing');jobId=job.id;
          if(action.action==='retry'){
            if(!['failed','not_ready','interrupted'].includes(job.status))throw Error('retry_not_allowed');
            store.resumeWriting(job,job.payload,clock());
          }else{
            const c=job.result?.confirmation;
            if(job.status!=='waiting_confirmation'||!c?.challenge||c.challenge!==action.challenge)throw Error('confirmation_stale');
            if(!store.get('previewDelivered:'+c.challenge))throw Error('confirmation_preview_pending');
            const confirmations={...job.payload.confirmations};let stage=job.stage;
            if(c.type==='outline_selection')confirmations.outlineSelection={challenge:c.challenge,taskId:c.taskId,selectedIds:c.selectedIds};
            else if(c.type==='outline'){confirmations.outlineApproval={challenge:c.challenge,approved:true};stage='content';}
            else if(c.type==='global_facts')confirmations.globalFacts={challenge:c.challenge,groups:c.groups};
            else if(c.type==='content_decision')confirmations.contentDecision={challenge:c.challenge,action:'retry_failed'};
            else throw Error('confirmation_requires_material');
            store.resumeWriting(job,{...job.payload,confirmations},clock(),stage);
          }
        }
        result={projectId:p.id,writingJobId:jobId,status:'queued'};store.touchCard(p.id,clock());
      }else{const updated=store.decide(p.id,action.action,action.actorId,clock());result={projectId:p.id,status:updated.humanDecision};}
      store.saveAction(action.eventId,hash,result,clock());return result;
    });}
  };
}
module.exports={createWorkflow,validateInput};
