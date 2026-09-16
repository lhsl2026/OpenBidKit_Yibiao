const fs=require('node:fs/promises');const path=require('node:path');
const {buildCard}=require('./card.cjs');
function createLarkClient({appId,appSecret,fetchImpl=fetch}){
  const base='https://open.feishu.cn/open-apis';let token='',expires=0,pending;
  async function accessToken(){if(token&&Date.now()<expires)return token;if(pending)return pending;pending=(async()=>{const r=await fetchImpl(base+'/auth/v3/tenant_access_token/internal',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({app_id:appId,app_secret:appSecret}),signal:AbortSignal.timeout(20000),redirect:'error'});const j=await r.json();if(!r.ok||j.code!==0||!j.tenant_access_token)throw new Error('lark_auth_failed');token=j.tenant_access_token;expires=Date.now()+Math.max(1,(j.expire??3600)-120)*1000;return token;})();try{return await pending;}finally{pending=null;}}
  async function request(endpoint,method,body){const auth=await accessToken();const form=body instanceof FormData;const r=await fetchImpl(base+endpoint,{method,headers:{authorization:'Bearer '+auth,...(!form?{'content-type':'application/json'}:{})},body:form?body:JSON.stringify(body),signal:AbortSignal.timeout(form?120000:20000),redirect:'error'});let j;try{j=await r.json();}catch{throw new Error('lark_response_invalid');}if(!r.ok||j.code!==0){if(r.status===401||[99991663,99991664,99991668].includes(j.code)){token='';expires=0;}throw new Error('lark_request_failed');}return j.data??j;}
  return {
    async sendCard(chatId,card,uuid){const data=await request('/im/v1/messages?receive_id_type=chat_id','POST',{receive_id:chatId,msg_type:'interactive',content:JSON.stringify(card),uuid});if(!data.message_id)throw new Error('lark_message_missing');return data.message_id;},
    updateCard:(id,card)=>request('/im/v1/messages/'+encodeURIComponent(id),'PATCH',{content:JSON.stringify(card)}),
    async uploadFile(file){const stat=await fs.stat(file);if(!stat.isFile()||stat.size>30*1024*1024)throw new Error('file_size_not_supported');const form=new FormData();form.set('file_type','stream');form.set('file_name',path.basename(file));form.set('file',new Blob([await fs.readFile(file)]),path.basename(file));const data=await request('/im/v1/files','POST',form);if(!data.file_key)throw new Error('lark_file_missing');return data.file_key;},
    async sendFile(chatId,fileKey,uuid){const data=await request('/im/v1/messages?receive_id_type=chat_id','POST',{receive_id:chatId,msg_type:'file',content:JSON.stringify({file_key:fileKey}),uuid});if(!data.message_id)throw new Error('lark_message_missing');return data.message_id;}
  };
}
async function deliverOutbox({store,client,mode,chatId,allowedChats=[],clock=Date.now,assertOwnership=()=>{},revalidate=id=>store.getProject(id)}){
  if(!['test','production'].includes(mode)||!chatId||!allowedChats.includes(chatId))return;
  for(const row of store.listOutbox(clock())){
    assertOwnership();
    const p=row.project_id?revalidate(row.project_id):null;
    if(row.project_id&&(!p?.current)){store.sent(row.id);continue;}
    const stream=p?store.messageStream(p,chatId):null;
    const messageId=p?(stream?.message_id??p?.messageId):store.get('outbox-message:'+row.id);
    const firstAttempt=stream?stream.first_attempt:row.first_attempt;
    // Once the deduplication window may have elapsed, a possibly-sent create needs reconciliation.
    if(!messageId&&firstAttempt!==null&&clock()-firstAttempt>45*60000){store.manualDelivery(row.id);continue;}
    store.attempted(row.id,clock());
    if(stream&&!messageId)store.attemptStream(stream.id,clock());
    try{
      const cardFor=project=>{
        const writing=store.listWriting().find(w=>w.project_id===project.id);
        if(writing?.result?.confirmation?.challenge)writing.previewDelivered=Boolean(store.get('previewDelivered:'+writing.result.confirmation.challenge));
        return buildCard(project,writing,store.get('cardPage:'+project.id)||0);
      };
      const card=p?cardFor(p):JSON.parse(row.payload);
      assertOwnership();
      if(messageId){await client.updateCard(messageId,card);assertOwnership();}
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
    }catch{assertOwnership();store.retry(row,clock());}
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
module.exports={createLarkClient,deliverGroupFileStatus,deliverOutbox};
