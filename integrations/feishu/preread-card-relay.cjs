'use strict';

const {spawn}=require('node:child_process');

function createPrereadCardRelay({config,spawnImpl=spawn,timeoutMs=120000}){
 const settings=config.prereadCardRelay??{enabled:false,scriptPath:''};
 const state={enabled:settings.enabled===true,ready:settings.enabled===true,error:settings.enabled===true?null:'preread_card_relay_not_configured'};
 async function handle(raw){
  if(!state.enabled)throw Error('preread_card_relay_not_configured');
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||raw.type!=='card.action.trigger')throw Error('preread_card_relay_event_invalid');
  const target=new URL('/openapi/preread/events/lark-card-action',config.prereadUrl).toString();
  try{
   await new Promise((resolve,reject)=>{
    let child,timer,settled=false;
    const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolve();};
    try{
     child=spawnImpl(process.execPath,[settings.scriptPath],{windowsHide:true,stdio:['pipe','ignore','ignore'],env:{...process.env,PREREAD_LARK_CARD_ACTION_URL:target,PREREAD_LARK_RELAY_AUTHORIZATION:config.relayAuthorization,PREREAD_LARK_DELIVERY_CHAT_ID:config.chatId,PREREAD_LARK_BOT_PROFILE:config.cardSource.profile,LARKSUITE_CLI_NO_UPDATE_NOTIFIER:'1',LARKSUITE_CLI_NO_SKILLS_NOTIFIER:'1'}});
    }catch{return finish(Error('preread_card_relay_failed'));}
    timer=setTimeout(()=>{try{child.kill();}catch{}finish(Error('preread_card_relay_timeout'));},timeoutMs);timer.unref?.();
    child.once('error',()=>finish(Error('preread_card_relay_failed')));
    child.once('close',code=>finish(code===0?null:Error('preread_card_relay_failed')));
    child.stdin.once('error',()=>finish(Error('preread_card_relay_failed')));
    child.stdin.end(JSON.stringify(raw)+'\n');
   });
   state.ready=true;state.error=null;
  }catch(error){state.ready=false;state.error=error?.message==='preread_card_relay_timeout'?'preread_card_relay_timeout':'preread_card_relay_failed';throw Error(state.error);}
 }
 return {handle,status:()=>({...state})};
}

module.exports={createPrereadCardRelay};
