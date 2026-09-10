const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const run=promisify(execFile);
function cliArguments({chatId,start,end,token,profile}){
 const args=['im','+chat-messages-list','--chat-id',chatId,'--as','user','--profile',profile,'--start',new Date(start).toISOString(),'--end',new Date(end).toISOString(),'--order','asc','--page-size','50','--no-reactions','--format','json'];
 if(token)args.push('--page-token',token);return args;
}
function normalizeMessage(m,config){
 const sender=m?.sender?.open_bot_id??m?.sender?.id;
 if(m?.deleted||!config.sourceChats.includes(m?.chat_id)||!config.sourceSenders.includes(sender)||!['app','bot'].includes(m?.sender?.sender_type)||m?.msg_type!=='text')return null;
 const stamp=String(m.create_time??'');
 const time=/^\d{13}$/.test(stamp)?Number(stamp):Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d(?::\d\d)?$/.test(stamp)?stamp.replace(' ','T')+'+08:00':stamp);
 if(!/^om_[A-Za-z0-9_-]+$/.test(m.message_id)||!Number.isFinite(time)||typeof m.content!=='string')throw Error('radar_message_invalid');
 return {eventType:'im.message.receive_v1',eventId:'openbidkit-history-'+m.message_id,messageId:m.message_id,chatId:m.chat_id,chatType:'group',senderId:sender,senderType:'bot',messageType:'text',createTime:String(time),content:JSON.stringify({text:m.content})};
}
function createRadarSource({store,config,receive,clock=Date.now,assertOwnership=()=>{},signal,fetchPage}){
 let running=false;const options=config.radarPolling;
 const fetchMessages=fetchPage??(async window=>{
   const {stdout}=await run(options.cliPath,cliArguments({...window,profile:options.profile}),{windowsHide:true,timeout:30000,maxBuffer:8*1024*1024,signal,env:{...process.env,LARKSUITE_CLI_NO_UPDATE_NOTIFIER:'1',LARKSUITE_CLI_NO_SKILLS_NOTIFIER:'1'}});
   return JSON.parse(stdout);
 });
 async function poll(){
  if(!options?.enabled||running||signal?.aborted)return;running=true;
  try{for(const chatId of config.sourceChats){
   assertOwnership();const name='radar-source:'+chatId;let state=store.get(name)??{};const now=clock();
   if(state.nextAt>now)continue;
   const window=state.window??{start:state.cursor?Math.max(0,state.cursor-120000):Date.parse(options.startAt)||now-86400000,end:now};
   // Persist the fixed range before I/O so retries cannot skip an unfinished page.
   state={...state,window};store.set(name,state);
   try{
    const result=await fetchMessages({...window,chatId});assertOwnership();
    if(!result?.ok||!Array.isArray(result.data?.messages))throw Error('radar_history_unavailable');
    const data=result.data;if(data.has_more&&(!data.page_token||data.page_token===window.token))throw Error('radar_pagination_invalid');
    for(const m of data.messages){const e=normalizeMessage(m,config);if(e){assertOwnership();await receive(e);}}
    assertOwnership();store.set(name,{...(data.has_more?{...state,window:{...window,token:data.page_token}}:{cursor:window.end}),nextAt:now+(data.has_more?5000:60000),lastSuccessAt:now,error:null});
   }catch{assertOwnership();store.set(name,{...state,nextAt:now+60000,error:'radar_poll_failed'});}
  }}finally{running=false;}
 }
 return {poll};
}
module.exports={createRadarSource,normalizeMessage,cliArguments};
