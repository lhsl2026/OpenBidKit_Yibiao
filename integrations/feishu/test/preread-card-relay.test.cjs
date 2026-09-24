const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {PassThrough}=require('node:stream');
let createPrereadCardRelay;
try{({createPrereadCardRelay}=require('../preread-card-relay.cjs'));}catch{}

function child(exitCode=0){
 const proc=new EventEmitter();proc.stdin=new PassThrough();proc.stdout=new PassThrough();proc.stderr=new PassThrough();proc.killed=false;
 proc.kill=()=>{proc.killed=true;proc.emit('close',null,'SIGTERM');};
 proc.stdin.on('finish',()=>proc.emit('close',exitCode));
 return proc;
}

test('preread callback adapter runs the existing relay once under the unified bot profile',async()=>{
 assert.equal(typeof createPrereadCardRelay,'function');
 const calls=[];let input='';
 const config={chatId:'oc_test',prereadUrl:'http://127.0.0.1:3101',relayAuthorization:'Bearer '+('a'.repeat(43)),cardSource:{profile:'openbidkit-feishu'},prereadCardRelay:{enabled:true,scriptPath:'C:\\agent\\scripts\\preread-lark-card-relay.js'}};
 const relay=createPrereadCardRelay({config,spawnImpl:(exe,args,options)=>{calls.push({exe,args,options});const proc=child();proc.stdin.on('data',chunk=>{input+=chunk.toString('utf8');});return proc;},timeoutMs:1000});
 const raw={type:'card.action.trigger',event_id:'evt-1',operator_id:'ou_actor',chat_id:'oc_test',message_id:'om_card',host:'im_message',action_tag:'button',action_value:JSON.stringify({action:'confirm_preprocess_review',runId:'11111111-1111-4111-8111-111111111111',documentVersion:3})};
 await relay.handle(raw);
 assert.equal(calls.length,1);assert.equal(calls[0].exe,process.execPath);assert.deepEqual(calls[0].args,[config.prereadCardRelay.scriptPath]);
 assert.equal(calls[0].options.windowsHide,true);assert.deepEqual(calls[0].options.stdio,['pipe','ignore','ignore']);
 assert.equal(calls[0].options.env.PREREAD_LARK_BOT_PROFILE,'openbidkit-feishu');
 assert.equal(calls[0].options.env.PREREAD_LARK_DELIVERY_CHAT_ID,'oc_test');
 assert.equal(calls[0].options.env.PREREAD_LARK_CARD_ACTION_URL,'http://127.0.0.1:3101/openapi/preread/events/lark-card-action');
 assert.equal(input,JSON.stringify(raw)+'\n');assert.deepEqual(relay.status(),{enabled:true,ready:true,error:null});
});

test('preread callback adapter fails closed on a missing relay or child failure',async()=>{
 assert.equal(typeof createPrereadCardRelay,'function');
 const base={chatId:'oc_test',prereadUrl:'http://127.0.0.1:3101',relayAuthorization:'Bearer '+('a'.repeat(43)),cardSource:{profile:'openbidkit-feishu'}};
 const disabled=createPrereadCardRelay({config:{...base,prereadCardRelay:{enabled:false,scriptPath:''}}});
 await assert.rejects(()=>disabled.handle({}),/preread_card_relay_not_configured/);
 const failed=createPrereadCardRelay({config:{...base,prereadCardRelay:{enabled:true,scriptPath:'C:\\agent\\relay.js'}},spawnImpl:()=>child(1),timeoutMs:1000});
 await assert.rejects(()=>failed.handle({type:'card.action.trigger'}),/preread_card_relay_failed/);
 assert.deepEqual(failed.status(),{enabled:true,ready:false,error:'preread_card_relay_failed'});
});
