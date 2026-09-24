const fs=require('node:fs/promises');const path=require('node:path');
const {buildCard,buildRelocatedCard}=require('./card.cjs');
function createLarkClient({appId,appSecret,fetchImpl=fetch}){
  const base='https://open.feishu.cn/open-apis';let token='',expires=0,pending;
  async function accessToken(){if(token&&Date.now()<expires)return token;if(pending)return pending;pending=(async()=>{const r=await fetchImpl(base+'/auth/v3/tenant_access_token/internal',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({app_id:appId,app_secret:appSecret}),signal:AbortSignal.timeout(20000),redirect:'error'});const j=await r.json();if(!r.ok||j.code!==0||!j.tenant_access_token)throw new Error('lark_auth_failed');token=j.tenant_access_token;expires=Date.now()+Math.max(1,(j.expire??3600)-120)*1000;return token;})();try{return await pending;}finally{pending=null;}}
  async function request(endpoint,method,body){const auth=await accessToken();const form=body instanceof FormData;const r=await fetchImpl(base+endpoint,{method,headers:{authorization:'Bearer '+auth,...(!form?{'content-type':'application/json'}:{})},body:form?body:JSON.stringify(body),signal:AbortSignal.timeout(form?120000:20000),redirect:'error'});let j;try{j=await r.json();}catch{throw new Error('lark_response_invalid');}if(!r.ok||j.code!==0){if(r.status===401||[99991663,99991664,99991668].includes(j.code)){token='';expires=0;}throw new Error('lark_request_failed');}return j.data??j;}
  return {
    async sendCard(chatId,card,uuid){const data=await request('/im/v1/messages?receive_id_type=chat_id','POST',{receive_id:chatId,msg_type:'interactive',content:JSON.stringify(card),uuid});if(!data.message_id)throw new Error('lark_message_missing');return data.message_id;},
    updateCard:(id,card)=>request('/im/v1/messages/'+encodeURIComponent(id),'PATCH',{content:JSON.stringify(card)}),
    async getMessages(messageIds){
      if(!Array.isArray(messageIds)||messageIds.length===0)return[];
      const query=messageIds.map(id=>encodeURIComponent(id)).join(',');
      const data=await request('/im/v1/messages/mget?card_msg_content_type=raw_card_content&message_ids='+query,'GET');
      const items=Array.isArray(data?.items)?data.items:Array.isArray(data?.messages)?data.messages:[];
      return items.flatMap(item=>{
        const content=typeof item?.content==='string'?item.content:typeof item?.body?.content==='string'?item.body.content:'';
        return typeof item?.message_id==='string'&&typeof item?.chat_id==='string'&&typeof item?.msg_type==='string'&&content?[{messageId:item.message_id,chatId:item.chat_id,messageType:item.msg_type,content,deleted:item.deleted===true}]:[];
      });
    },
    async uploadFile(file){const stat=await fs.stat(file);if(!stat.isFile()||stat.size>30*1024*1024)throw new Error('file_size_not_supported');const form=new FormData();form.set('file_type','stream');form.set('file_name',path.basename(file));form.set('file',new Blob([await fs.readFile(file)]),path.basename(file));const data=await request('/im/v1/files','POST',form);if(!data.file_key)throw new Error('lark_file_missing');return data.file_key;},
    async sendFile(chatId,fileKey,uuid){const data=await request('/im/v1/messages?receive_id_type=chat_id','POST',{receive_id:chatId,msg_type:'file',content:JSON.stringify({file_key:fileKey}),uuid});if(!data.message_id)throw new Error('lark_message_missing');return data.message_id;}
  };
}
const sameChecksum=(left,right)=>String(left??'').replace(/^sha256:/i,'').toLowerCase()===String(right??'').replace(/^sha256:/i,'').toLowerCase();
function prereadCardIdentity(project,chatId,storedRun){
 const input=project?.input,handoff=input?.handoff,snapshot=handoff?.snapshot,card=input?.companyMatchCard,run=input?.prereadRunIdentity??storedRun,messageId=project?.messageId;
 if(!project?.current||handoff?.superseded||handoff?.task?.taskId!==project.taskId||snapshot?.documentVersion===undefined||typeof messageId!=='string'||!/^om_[A-Za-z0-9_-]+$/.test(messageId))return null;
 let runId;
 if(typeof card?.runId==='string'&&card.runId){
  if((card.taskId&&card.taskId!==project.taskId)||(card.documentVersion!==undefined&&String(card.documentVersion)!==String(snapshot.documentVersion)))return null;
  runId=card.runId;
 }
 else if(run?.taskId===project.taskId&&typeof run.runId==='string'&&run.runId&&String(run.documentVersion)===String(snapshot.documentVersion))runId=run.runId;
 else return null;
 return{taskId:project.taskId,runId,messageId,targetType:'chat',targetId:chatId};
}
function prereadDeliveryIdentity(project,chatId,storedRun){
 const identity=prereadCardIdentity(project,chatId,storedRun),snapshot=project?.input?.handoff?.snapshot,archive=project?.input?.reportArchive;
 if(!identity||typeof snapshot?.reportId!=='string'||!snapshot.reportId)return null;
 if(archive?.reportId!==snapshot.reportId||archive?.reportVersion!==snapshot.reportVersion||String(archive?.documentVersion)!==String(snapshot.documentVersion)||!sameChecksum(archive?.checksum,snapshot.checksum))return null;
 return{...identity,outboxId:null,reportId:snapshot.reportId};
}
async function reconcilePrereadDeliveries({store,client,preread,mode,chatId,allowedChats=[],assertOwnership=()=>{}}){
 if(!preread||typeof preread.getDeliveryStatus!=='function'||typeof preread.confirmUnifiedCardDelivered!=='function'||typeof client?.getMessages!=='function'||!['test','production'].includes(mode)||!chatId||!allowedChats.includes(chatId))return;
 for(const project of store.listProjects()){
  const storedRun=store.get('preread-run-identity:'+project.id),cardIdentity=prereadCardIdentity(project,chatId,storedRun);if(!cardIdentity)continue;
  const reconcileKey='preread-reconcile:'+project.id,record=value=>{if(JSON.stringify(store.get(reconcileKey))!==JSON.stringify(value))store.set(reconcileKey,value);};
  const local=store.db.prepare('SELECT delivered,last_error FROM outbox WHERE project_id=? AND revision=?').get(project.id,project.revision);
  const activeStream=store.db.prepare('SELECT message_id FROM card_streams WHERE task=? AND company=? AND chat=?').get(project.taskId,project.companyId,chatId);
  const verifiedRelocation=local?.delivered===-1&&local.last_error==='card_scope_mismatch'&&activeStream?.message_id===cardIdentity.messageId&&project.input?.companyMatchCard?.sourceCardMessageId!==cardIdentity.messageId;
  if(local?.delivered!==1&&!verifiedRelocation)continue;
  try{
   assertOwnership();const messages=await client.getMessages([cardIdentity.messageId]);assertOwnership();
   const verified=messages.some(message=>message.messageId===cardIdentity.messageId&&message.chatId===chatId&&message.messageType==='interactive'&&typeof message.content==='string'&&message.content.trim()&&!message.deleted);if(!verified)continue;
   const previousCardMessageId=project.input?.companyMatchCard?.sourceCardMessageId;
   if(!project.input?.companyMatchCard?.runId||previousCardMessageId!==cardIdentity.messageId){
    if(typeof preread.confirmTenderDeliveryCard!=='function')continue;
    const bound=await preread.confirmTenderDeliveryCard(cardIdentity.runId,{messageId:cardIdentity.messageId,...(previousCardMessageId&&previousCardMessageId!==cardIdentity.messageId?{replaceExisting:true}:{})});assertOwnership();
    if(bound?.deliveryStatusCardMessageId!==cardIdentity.messageId)continue;
   }
   const identity=prereadDeliveryIdentity(project,chatId,storedRun);if(!identity){record({status:'waiting_report_archive',runId:cardIdentity.runId,messageId:cardIdentity.messageId});continue;}
   const receiptKey='preread-delivery-reconciled:'+identity.reportId+':'+identity.messageId;if(store.get(receiptKey))continue;
   const status=await preread.getDeliveryStatus({reportId:identity.reportId,targetType:'chat',targetId:chatId});assertOwnership();
   const delivery=['pending_delivery','sent'].includes(status?.status)?status.delivery:null;
   const reportRunId=delivery?.report?.sourceTenderRunId;
   if(!delivery||typeof delivery.id!=='string'||delivery.reportId!==identity.reportId||delivery.targetType!=='chat'||delivery.targetId!==chatId||delivery.report?.taskId!==identity.taskId||String(delivery.report?.documentVersion)!==String(project.input?.handoff?.snapshot?.documentVersion)||(reportRunId&&reportRunId!==identity.runId))continue;
   if(!reportRunId){record({status:'waiting_report_run_binding',runId:identity.runId,messageId:identity.messageId,reportId:identity.reportId});continue;}
   if(status.status==='sent'){store.set(receiptKey,{status:'sent'});continue;}
   const confirmation={...identity,outboxId:delivery.id};
   const result=await preread.confirmUnifiedCardDelivered(confirmation);assertOwnership();
   if(result?.status==='sent'&&result.updated===true)store.set(receiptKey,{status:'sent'});
  }catch(error){assertOwnership();const code=typeof error?.message==='string'&&/^[A-Za-z0-9_.:-]{1,80}$/.test(error.message)?error.message:'reconcile_failed';record({status:'error',code,runId:cardIdentity.runId,messageId:cardIdentity.messageId});}
 }
}
function projectGroupScope(project){
 const card=project?.input?.companyMatchCard;
 return card?.scopeType==='group'&&typeof card.scopeId==='string'&&card.scopeId?card.scopeId:null;
}
async function assertProjectCardScope(client,messageId,chatId){
 if(typeof client?.getMessages!=='function')throw new Error('card_scope_unverified');
 const messages=await client.getMessages([messageId]);
 const exact=messages.some(message=>message?.messageId===messageId&&message?.chatId===chatId&&message?.messageType==='interactive'&&typeof message.content==='string'&&message.content.trim()&&!message.deleted);
 if(!exact)throw new Error(messages.some(message=>message?.messageId===messageId&&message?.chatId!==chatId)?'card_scope_mismatch':'card_scope_unverified');
}
async function deliverOutbox({store,client,mode,chatId,allowedChats=[],forbiddenChats=[],clock=Date.now,assertOwnership=()=>{},revalidate=id=>store.getProject(id)}){
  if(!['test','production'].includes(mode)||!chatId||!allowedChats.includes(chatId)||forbiddenChats.includes(chatId))return;
  for(const row of store.listOutbox(clock())){
    assertOwnership();
    const selectionKey=store.get('selection-outbox:'+row.id);
    if(selectionKey){
      const selection=store.get(selectionKey),target=selection?.targetChatId;
      if(target!==chatId||!allowedChats.includes(target)||forbiddenChats.includes(target)){store.rejectDelivery(row.id,'selection_delivery_target_mismatch');continue;}
    }
    const p=row.project_id?revalidate(row.project_id):null;
    if(row.project_id&&(!p?.current)){store.sent(row.id);continue;}
    const scopedChat=projectGroupScope(p);
    if(scopedChat&&scopedChat!==chatId){store.rejectDelivery(row.id,'card_scope_mismatch');continue;}
    const rebind=p?store.getPendingCardRebind(p.id,chatId):null;
    const stream=p?store.messageStream(p,chatId):null;
    const messageId=p?(stream?.message_id??p?.messageId):store.get('outbox-message:'+row.id);
    const firstAttempt=stream?stream.first_attempt:row.first_attempt;
    // Once the deduplication window may have elapsed, a possibly-sent create needs reconciliation.
    if(rebind&&!rebind.new_message_id&&rebind.first_attempt!==null&&clock()-rebind.first_attempt>45*60000){store.manualCardRebind(rebind.id,clock());store.manualDelivery(row.id);continue;}
    if(!rebind&&!messageId&&firstAttempt!==null&&clock()-firstAttempt>45*60000){store.manualDelivery(row.id);continue;}
    store.attempted(row.id,clock());
    if(rebind&&!rebind.new_message_id)store.attemptCardRebind(rebind.id,clock());
    if(stream&&!messageId)store.attemptStream(stream.id,clock());
    try{
      const cardFor=project=>{
        const writing=store.listWriting().find(w=>w.project_id===project.id);
        if(writing?.result?.confirmation?.challenge)writing.confirmationPublished=Boolean(store.get('confirmationPublished:'+writing.result.confirmation.challenge));
        return buildCard(project,writing,store.get('cardPage:'+project.id)||0,{companyMatchReview:store.get('company-match-review:'+project.id)});
      };
      const card=p?cardFor(p):JSON.parse(row.payload);
      assertOwnership();
      if(rebind){
        let activeMessageId=rebind.new_message_id;
        if(!activeMessageId){activeMessageId=await client.sendCard(chatId,card,rebind.create_id);assertOwnership();store.transaction(()=>store.activateCardRebind(rebind.id,activeMessageId));}
        const reboundProject=revalidate(p.id);if(!reboundProject?.current)throw Error('card_rebind_project_stale');
        await client.updateCard(activeMessageId,cardFor(reboundProject));assertOwnership();
        await client.updateCard(rebind.old_message_id,buildRelocatedCard(p));assertOwnership();
        store.finishCardRebind(rebind.id,clock());
      }
      else if(messageId){if(p){await assertProjectCardScope(client,messageId,chatId);assertOwnership();}await client.updateCard(messageId,card);assertOwnership();}
      else{
        const id=await client.sendCard(chatId,card,stream?.create_id??row.id);assertOwnership();
        if(p){
          store.transaction(()=>store.bindStream(stream.id,id));
          // A duplicate UUID may return the earlier version's card. Always patch the latest state.
          const latest=store.current(p.taskId,p.companyId);
          if(latest){const fresh=revalidate(latest.id);assertOwnership();await client.updateCard(id,cardFor(fresh));assertOwnership();}
        }else store.transaction(()=>{store.set('outbox-message:'+row.id,id);const stateKey=store.get('selection-outbox:'+row.id);if(stateKey){const state=store.get(stateKey);if(state)store.set(stateKey,{...state,messageId:id});}});
      }
      if(row.project_id)store.sent(row.id);
      else{
        const current=store.db.prepare('SELECT payload FROM outbox WHERE id=? AND delivered=0').get(row.id);
        if(current?.payload===row.payload)store.sent(row.id);
      }
    }catch(error){assertOwnership();if(error?.message==='card_scope_mismatch')store.rejectDelivery(row.id,error.message);else store.retry(row,clock(),error?.message==='card_scope_unverified'?error.message:'delivery_failed');}
  }
}
async function deliverGroupFileStatus({store,client,mode,chatId,allowedChats=[],clock=Date.now,assertOwnership=()=>{}}){
 if(!['test','production'].includes(mode)||!chatId||!allowedChats.includes(chatId))return;
 for(const row of store.listGroupFileStatus(clock())){
  assertOwnership();const job=store.getGroupFileJob(row.job_id);if(!job||job.chatId!==chatId){store.finishGroupFileStatus(row.id);continue;}
  if(!job.statusMessageId&&row.first_attempt!==null&&clock()-row.first_attempt>45*60000){store.manualGroupFileStatus(row.id);continue;}
  store.attemptGroupFileStatus(row.id,clock());
  try{
   if(job.statusMessageId){await client.updateCard(job.statusMessageId,row.card);assertOwnership();}
   else{const messageId=await client.sendCard(chatId,row.card,job.statusCreateId);assertOwnership();store.bindGroupFileStatus(job.id,messageId);}
   store.finishGroupFileStatus(row.id);
  }catch{assertOwnership();store.retryGroupFileStatus(row.id,clock());}
 }
}
module.exports={createLarkClient,deliverGroupFileStatus,deliverOutbox,reconcilePrereadDeliveries};
