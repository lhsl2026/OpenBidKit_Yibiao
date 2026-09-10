const {createHash,randomBytes}=require('node:crypto');
const {isSourceInboxActive}=require('./receipt.cjs');

const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const sha=value=>createHash('sha256').update(value).digest('hex');
const safe=value=>String(value??'').slice(0,200).replace(/[&<>*_[\]()`#~]/g,c=>`&#${c.charCodeAt(0)};`);
const selectionToken=eventIds=>sha([...eventIds].sort().join('\n')).slice(0,32);
const batchKeyFor=(chatId,messageId,eventIds)=>sha(JSON.stringify(['selection',chatId,messageId,[...eventIds].sort()])).slice(0,40);

function initialCard(state){
 const options=state.projects.map((project,index)=>({text:{tag:'plain_text',content:`${index+1}. ${String(project.title).slice(0,90)}`},value:project.eventId}));
 const details=state.projects.map((project,index)=>`${index+1}. **${safe(project.title)}**${project.budgetText?`\n预算：${safe(project.budgetText)}`:''}${project.deadlineText?`\n截止：${safe(project.deadlineText)}`:''}`).join('\n\n');
 return {schema:'2.0',config:{update_multi:true,width_mode:'default',enable_forward:false},header:{title:{tag:'plain_text',content:'请选择需要预读的项目'},template:'yellow'},body:{direction:'vertical',vertical_spacing:'12px',padding:'12px',elements:[
  {tag:'markdown',content:'**重点项目已进入处理队列，预读结果以完成后的项目卡为准。** 以下项目只有在确认后才会开始查找和预读。'},
  {tag:'form',name:'openbidkit_selection_form',direction:'vertical',vertical_spacing:'12px',elements:[{tag:'markdown',content:details},{tag:'multi_select_static',name:'events',required:true,width:'fill',placeholder:{tag:'plain_text',content:'选择一个或多个项目'},options},{tag:'button',name:`openbidkit_selection_${state.batchKey}_${state.challenge}`,text:{tag:'plain_text',content:'预读所选项目'},type:'primary_filled',width:'fill',form_action_type:'submit'}]},
  {tag:'column_set',flex_mode:'none',columns:[{tag:'column',width:'weighted',weight:1,elements:[{tag:'button',text:{tag:'plain_text',content:'本批都不预读'},type:'danger',width:'fill',behaviors:[{type:'callback',value:{agent:'openbidkit-selection',batchKey:state.batchKey,challenge:state.challenge,action:'decline'}}]}]}]}
 ]}};
}

function resultCard(status,count){
 const states={selected:['已提交所选项目','green','所选项目已进入预读；后续结果会通过项目卡片呈现。'],declined:['本批项目已关闭','grey','本批待选项目不会开始预读。'],waiting:['请求仍在处理中','yellow','服务仍在处理本次请求，请人工核对处理状态。'],failed:['提交状态待核对','red','服务未确认执行本次请求，请人工核对处理状态。'],edited:['来源消息已编辑','orange','原选择卡已失效，请核对编辑后的来源消息。']};
 const [title,template,message]=states[status]??states.failed;
 const outcome=['selected','declined'].includes(status)?'未选择的项目将关闭；预读结果仍需人工判断。':'处理状态确认前，请勿据此判断项目是否已关闭。';
 return {schema:'2.0',config:{update_multi:true,width_mode:'default',enable_forward:false},header:{title:{tag:'plain_text',content:title},template},body:{direction:'vertical',vertical_spacing:'12px',padding:'12px',elements:[{tag:'markdown',content:`**处理状态**\n${message}`},{tag:'markdown',content:`本批共 ${count} 个待确认项目。`},{tag:'markdown',content:outcome}]}};
}

function createSelection({store,config,preread,onReceipt,clock=Date.now,assertOwnership=()=>{}}){
 const inFlight=new Map();
 function queue(receipt,meta){
  if(receipt?.status!=='processed')return null;
  if(typeof receipt.messageId!=='string'||!receipt.messageId||!Array.isArray(receipt.projects)||!Array.isArray(receipt.results))return null;
  const projects=[],waiting=[];
  for(let i=0;i<receipt.results.length;i++){
   const result=receipt.results[i],project=receipt.projects[i];
   if(result?.status!=='waiting_confirmation')continue;
   waiting.push(i);
   if(!uuid(result.eventId)||!project||Array.isArray(project)||typeof project!=='object'||project.sourceMessageId!==receipt.messageId||typeof project.title!=='string'||!project.title.trim())continue;
   projects.push({eventId:result.eventId,title:project.title.trim(),...(typeof project.budgetText==='string'&&project.budgetText.trim()?{budgetText:project.budgetText.trim()}:{}),...(typeof project.deadlineText==='string'&&project.deadlineText.trim()?{deadlineText:project.deadlineText.trim()}:{})});
  }
  if(!waiting.length)return null;
  if(projects.length!==waiting.length||projects.length>100||new Set(projects.map(project=>project.eventId)).size!==projects.length){
   const manualKey=sha(JSON.stringify(['selection-manual',receipt.messageId]));const state={status:'manual',reason:'selection_mapping_invalid',targetChatId:config.chatId,batchMessageId:receipt.messageId,sourceInboxId:meta?.inboxId??null,createdAt:clock()};store.set('selection-manual:'+manualKey.slice(0,40),state);return state;
  }
  const eventIds=[...new Set(projects.map(project=>project.eventId))],batchKey=batchKeyFor(config.chatId,receipt.messageId,eventIds),stateKey='selection:'+batchKey;
  const existing=store.get(stateKey);
  if(existing){
   if(!existing.sourceInboxId&&meta?.inboxId){const restored={...existing,sourceInboxId:meta.inboxId};store.set(stateKey,restored);store.set('selection-inbox:'+meta.inboxId,stateKey);return restored;}
   return existing;
  }
  const outboxId=sha(JSON.stringify(['selection-card',batchKey])).slice(0,40);
  const state={status:'waiting',targetChatId:config.chatId,batchMessageId:receipt.messageId,sourceMessageId:receipt.messageId,sourceInboxId:meta?.inboxId??null,eventIds,selectionToken:selectionToken(eventIds),batchKey,challenge:randomBytes(16).toString('hex'),outboxId,messageId:null,projects,createdAt:clock()};
  store.set(stateKey,state);store.set('selection-outbox:'+outboxId,stateKey);
  if(state.sourceInboxId)store.set('selection-inbox:'+state.sourceInboxId,stateKey);
  store.db.prepare('INSERT OR IGNORE INTO outbox(id,project_id,revision,payload) VALUES(?,NULL,0,?)').run(outboxId,JSON.stringify(initialCard(state)));
  return state;
 }
 function updateCard(state,status){
  store.db.prepare("UPDATE outbox SET payload=?,delivered=0,next_at=0,last_error=NULL WHERE id=?").run(JSON.stringify(resultCard(status,state.eventIds.length)),state.outboxId);
 }
 function validate(value,event){
  if(!value||value.agent!=='openbidkit-selection'||!['select','decline'].includes(value.action)||!/^[a-f0-9]{40}$/.test(value.batchKey??'')||!/^[a-f0-9]{32}$/.test(value.challenge??''))throw Error('selection_action_invalid');
  const state=store.get('selection:'+value.batchKey);if(!state)throw Error('selection_stale');
  if(state.batchKey!==batchKeyFor(state.targetChatId,state.batchMessageId,state.eventIds)||state.selectionToken!==selectionToken(state.eventIds)||(value.selectionToken!==undefined&&value.selectionToken!==state.selectionToken))throw Error('selection_token_invalid');
  if(value.challenge!==state.challenge)throw Error('selection_challenge_invalid');
  if(!event||typeof event.eventId!=='string'||!event.eventId||event.chatId!==state.targetChatId||!config.operatorIds?.includes(event.actorId))throw Error('selection_identity_invalid');
  const messageId=store.get('outbox-message:'+state.outboxId);if(typeof messageId!=='string'||!messageId||event.messageId!==messageId)throw Error('selection_message_invalid');
  const selected=event.formValue?.events;if(!Array.isArray(selected)||selected.some(id=>!uuid(id)))throw Error('selection_events_invalid');
  const eventIds=[...new Set(selected)];if(value.action==='select'&&!eventIds.length)throw Error('selection_events_required');
  if(eventIds.some(id=>!state.eventIds.includes(id)))throw Error('selection_events_invalid');
  return {state,eventIds};
 }
 async function perform(value,event,payload,state,hash){
  const actionKey='selection-action:'+event.eventId;
  store.transaction(()=>{store.set(actionKey,{hash,status:'pending',payload,updatedAt:clock()});store.set('selection:'+state.batchKey,{...state,status:'submitting',activeEventId:event.eventId,updatedAt:clock()});});
  let response;
  try{assertOwnership();response=await preread.select(payload);assertOwnership();}
  catch(error){assertOwnership();const edited=state.sourceInboxId&&!isSourceInboxActive(store,state.sourceInboxId);store.transaction(()=>{store.set(actionKey,{hash,status:'failed',payload,updatedAt:clock()});store.set('selection:'+state.batchKey,{...state,status:edited?'edited':'uncertain',activeEventId:event.eventId,updatedAt:clock()});updateCard(state,edited?'edited':'failed');});throw Error(edited?'selection_source_edited':'selection_request_failed');}
  if(state.sourceInboxId&&!isSourceInboxActive(store,state.sourceInboxId)){
   store.transaction(()=>{store.set('radar-receipt:selection-'+event.eventId,response);store.set(actionKey,{hash,status:'completed',payload,result:response,updatedAt:clock()});store.set('selection:'+state.batchKey,{...state,status:'edited',activeEventId:event.eventId,lastResult:response,updatedAt:clock()});updateCard(state,'edited');});return response;
  }
  const {recordReceipt}=require('./receipt.cjs');let inspected;
  inspected=recordReceipt({store,inboxId:'selection-'+event.eventId,sourceInboxId:state.sourceInboxId??'selection-'+event.eventId,response,companyId:config.companyId,now:clock(),onReceipt:(saved,meta)=>{
   const status=meta.inspected.pending?'retryable':'completed';store.set(actionKey,{hash,status,payload,result:saved,updatedAt:clock()});
   const next=meta.inspected.pending?'waiting':saved.status==='selection_rejected'?'failed':value.action==='decline'?'declined':'selected';updateCard(state,next);store.set('selection:'+state.batchKey,{...state,status:next,activeEventId:event.eventId,lastResult:saved,updatedAt:clock()});
   if(onReceipt)onReceipt(saved,meta);
  }});
  void inspected;return response;
 }
 async function act(value,event){
  const {state,eventIds}=validate(value,event);
  const payload={eventId:event.eventId,chatId:event.chatId,operatorId:event.actorId,batchMessageId:state.batchMessageId,action:value.action==='select'?'select_events':'decline_all_events',...(value.action==='select'?{eventIds}:{}),selectionToken:state.selectionToken};
  const hash=sha(JSON.stringify(payload)),actionKey='selection-action:'+event.eventId,saved=store.get(actionKey);
  if(saved&&saved.hash!==hash)throw Error('selection_payload_changed');
  if(saved?.status==='completed')return saved.result;
  if(state.status==='edited'||(state.sourceInboxId&&!isSourceInboxActive(store,state.sourceInboxId)))throw Error('selection_source_edited');
  const current=store.get('selection:'+state.batchKey);
  if(['selected','declined','edited','failed'].includes(current.status)||(['submitting','uncertain','waiting'].includes(current.status)&&current.activeEventId&&current.activeEventId!==event.eventId))throw Error('selection_batch_closed');
  if(inFlight.has(event.eventId))return inFlight.get(event.eventId);
  const task=perform(value,event,payload,state,hash).finally(()=>inFlight.delete(event.eventId));inFlight.set(event.eventId,task);return task;
 }
 function invalidateInbox(inboxId){
  const stateKey=store.get('selection-inbox:'+inboxId);if(!stateKey)return false;const state=store.get(stateKey);if(!state)return false;
  store.set(stateKey,{...state,status:'edited',updatedAt:clock()});updateCard(state,'edited');return true;
 }
 return {queue,act,invalidateInbox};
}

module.exports={createSelection,selectionToken,batchKeyFor};
