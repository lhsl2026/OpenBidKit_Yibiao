'use strict';
const path=require('node:path');
const {spawn}=require('node:child_process');
const {StringDecoder}=require('node:string_decoder');
const EVENT='card.action.trigger';
const READY='[event] ready event_key='+EVENT;
// Project at the trusted CLI boundary: delayed-update tokens and original card bodies never enter our cache.
const PROJECTION='{type,event_id,operator_id,chat_id,message_id,host,action_tag,action_name,action_value,form_value}';
const text=(v,max=256)=>typeof v==='string'&&v.length>0&&v.length<=max;
function cliArguments(options){return ['event','consume',EVENT,'--as','bot','--profile',options.profile,'--jq',PROJECTION];}
function normalizeCardCallback(e,config){
 if(e?.type!==EVENT||e.host!=='im_message'||e.action_tag!=='button'||e.chat_id!==config.chatId||!config.operatorIds?.includes(e.operator_id))return null;
 if(!text(e.event_id)||!text(e.message_id)||!/^om_[A-Za-z0-9_-]+$/.test(e.message_id)||!text(e.operator_id)||!text(e.chat_id))return null;
 const formName=typeof e.action_name==='string'?e.action_name.match(/^openbidkit_selection_([a-f0-9]{40})_([a-f0-9]{32})$/):null;
 let v;
 if(formName)v={agent:'openbidkit-selection',batchKey:formName[1],challenge:formName[2],action:'select'};
 else{if(!text(e.action_value,8192))return null;try{v=JSON.parse(e.action_value);}catch{return null;}}
 const context={eventId:e.event_id,actorId:e.operator_id,chatId:e.chat_id,messageId:e.message_id};
 if(v?.agent==='openbidkit-selection'){
  if(!/^[a-f0-9]{40}$/.test(v.batchKey??'')||!/^[a-f0-9]{32}$/.test(v.challenge??'')||!['select','decline'].includes(v.action))return null;
  let form={events:[]};
  if(e.form_value){
   if(!text(e.form_value,16384))return null;
   try{form=JSON.parse(e.form_value);}catch{return null;}
   if(!form||Array.isArray(form)||Object.keys(form).some(k=>k!=='events'))return null;
  }
  if(!Array.isArray(form.events)||form.events.length>100||form.events.some(id=>typeof id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)))return null;
  if(v.action==='select'&&!form.events.length)return null;
  return {value:{agent:v.agent,batchKey:v.batchKey,challenge:v.challenge,action:v.action},event:{...context,formValue:{events:[...new Set(form.events)]}}};
 }
 if(v?.agent!=='openbidkit'||!text(v.projectId)||!text(v.version)||!text(v.cardKey)||!['follow','defer','decline','write','continue','retry','page'].includes(v.action))return null;
 if(v.action==='continue'&&!text(v.challenge))return null;
 if(v.action==='page'&&(!Number.isInteger(v.page)||v.page<0))return null;
 return {value:{agent:v.agent,projectId:v.projectId,version:v.version,cardKey:v.cardKey,action:v.action,
  ...(v.action==='continue'?{challenge:v.challenge}:{}),...(v.action==='page'?{page:v.page}:{})},event:context};
}
function toWorkflowAction(v,e){
 // Preserve the existing HTTP adapter's field order because workflow action hashes are order-sensitive.
 return Object.fromEntries(Object.entries({projectId:v.projectId,version:v.version,action:v.action,cardKey:v.cardKey,challenge:v.challenge,page:v.page,actorId:e.actorId,chatId:e.chatId,messageId:e.messageId,eventId:e.eventId}).filter(([,value])=>value!==undefined));
}
function normalizeCardEvent(e,config){const normalized=normalizeCardCallback(e,config);if(normalized?.value.agent!=='openbidkit')return null;return toWorkflowAction(normalized.value,normalized.event);}
function createCardSource({config,workflow,onAction,assertOwnership=()=>{},spawnImpl=spawn,clock=Date.now,reconnectMs=5000,startupTimeoutMs=30000,stopTimeoutMs=5000}){
 const options=config.cardSource;
 if(options?.enabled&&(!path.isAbsolute(options.cliPath)||!text(options.profile)||!text(config.chatId)||!config.operatorIds?.length))throw Error('card_source_not_configured');
 for(const ms of [reconnectMs,startupTimeoutMs,stopTimeoutMs])if(!Number.isFinite(ms)||ms<10)throw Error('card_source_timing_invalid');
 let started=false,closed=false,lost=false,task=null,active=null,wake=null;
 const dispatch=onAction??((value,event)=>{if(value.agent!=='openbidkit')throw Error('card_handler_missing');return workflow.act(toWorkflowAction(value,event));});
 const state={enabled:!!options?.enabled,ready:false,accepted:0,rejected:0,error:null,lastReadyAt:null,lastEventAt:null};
 function own(){try{assertOwnership();return true;}catch{lost=true;state.ready=false;state.error='card_source_ownership_lost';return false;}}
 function connect(){return new Promise(resolve=>{
  let child;try{child=spawnImpl(options.cliPath,cliArguments(options),{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,LARKSUITE_CLI_NO_UPDATE_NOTIFIER:'1',LARKSUITE_CLI_NO_SKILLS_NOTIFIER:'1'}});}catch{state.error='card_source_spawn_failed';resolve();return;}
  let finished=false,stopping=false,startTimer,stopTimer,draining=false,drainTask=null;const queue=[];
  const outDecoder=new StringDecoder('utf8'),errDecoder=new StringDecoder('utf8');let out='',err='';
  child.stdout.pause();
  function stop(){
   if(finished||stopping)return;stopping=true;state.ready=false;clearTimeout(startTimer);
   // CLI's unbounded consumer exits gracefully on stdin EOF; only terminate our own child if it hangs.
   stopTimer=setTimeout(()=>{if(!finished)child.kill();},stopTimeoutMs);
   child.stdin.end();
  }
  active={child,stop};
  function finish(){
   if(finished)return;finished=true;state.ready=false;clearTimeout(startTimer);clearTimeout(stopTimer);
   child.stdout.removeListener('data',onOut);child.stderr.removeListener('data',onErr);out='';err='';
   if(active?.child===child)active=null;
   if(!closed&&!lost&&!state.error)state.error='card_source_disconnected';
   Promise.resolve(drainTask).then(resolve);
  }
  function fail(code){if(!lost)state.error=code;stop();}
  function accept(line){
   if(closed||lost||stopping||!state.ready)return;
   let e;try{e=JSON.parse(line);}catch{state.rejected++;return;}
   const normalized=normalizeCardCallback(e,config);if(!normalized){state.rejected++;return;}
   if(queue.length>=100){fail('card_source_queue_full');return;}
   queue.push(normalized);drain();
  }
  function drain(){
   if(draining)return;draining=true;
   drainTask=(async()=>{
    while(queue.length&&!closed&&!lost){
     if(!own()){stop();break;}const {value,event}=queue.shift();
     // Keep original event IDs across reconnect. Workflow/selection handlers own durable business deduplication.
     try{await dispatch(value,event);state.accepted++;state.lastEventAt=clock();}catch{state.rejected++;}
    }
    state.rejected+=queue.length;queue.length=0;draining=false;
   })();
  }
  function consume(buffer,chunk,decoder,callback){
   buffer+=decoder.write(chunk);let end;
   while((end=buffer.indexOf('\n'))>=0){
    if(end>65536){fail('card_source_line_too_large');return '';}
    const line=buffer.slice(0,end).replace(/\r$/,'');buffer=buffer.slice(end+1);if(line)callback(line);
    if(finished||stopping)return '';
   }
   if(buffer.length>65536){fail('card_source_line_too_large');return '';}
   return buffer;
  }
  function onOut(chunk){out=consume(out,chunk,outDecoder,accept);}
  function onErr(chunk){err=consume(err,chunk,errDecoder,line=>{
   if(line===READY&&!closed&&!lost&&!stopping){clearTimeout(startTimer);state.ready=true;state.error=null;state.lastReadyAt=clock();child.stdout.resume();return;}
   // Store fixed diagnostics only; CLI envelopes can contain credentials, callback tokens or message bodies.
   try{const envelope=JSON.parse(line);if(envelope?.ok===false){fail('card_source_cli_failed');return;}}catch{}
   if(/\b(?:WARN|dropped)\b/i.test(line))fail('card_source_stream_warning');
  });}
  child.stdout.on('data',onOut);child.stderr.on('data',onErr);
  child.stdin.on('error',()=>fail('card_source_stdin_failed'));
  child.stdout.on('error',()=>fail('card_source_stream_failed'));
  child.stderr.on('error',()=>fail('card_source_stream_failed'));
  child.once('error',()=>fail('card_source_spawn_failed'));child.once('close',finish);
  startTimer=setTimeout(()=>fail('card_source_ready_timeout'),startupTimeoutMs);
 });}
 async function run(){
  while(!closed&&!lost){
   if(!own())break;await connect();if(closed||lost)break;
   await new Promise(resolve=>{const timer=setTimeout(done,reconnectMs);function done(){clearTimeout(timer);wake=null;resolve();}wake=done;});
  }
 }
 function start(){if(started||closed||!options?.enabled)return;started=true;task=run().catch(()=>{state.ready=false;state.error='card_source_failed';active?.stop();});}
 async function close(){closed=true;state.ready=false;wake?.();active?.stop();await task;}
 return {start,close,status:()=>({...state})};
}
module.exports={createCardSource,normalizeCardEvent,normalizeCardCallback,toWorkflowAction,cliArguments};
