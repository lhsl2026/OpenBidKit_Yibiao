const {test}=require('node:test');const assert=require('node:assert/strict');const {createHash}=require('node:crypto');
const {createHttpServer,openCallback}=require('../server.cjs');
test('callback requires signature, fresh timestamp and token',()=>{const raw=Buffer.from(JSON.stringify({header:{token:'t',event_type:'card.action.trigger',event_id:'e'},event:{}}));const ts=String(Math.floor(Date.now()/1000));const headers={'x-lark-request-timestamp':ts,'x-lark-request-nonce':'n','x-lark-signature':createHash('sha256').update(ts+'n'+'k').update(raw).digest('hex')};assert.equal(openCallback(raw,headers,{verificationToken:'t',encryptKey:'k'}).header.event_id,'e');assert.throws(()=>openCallback(raw,{}, {verificationToken:'t',encryptKey:'k'}),/signature/);assert.throws(()=>openCallback(raw,{...headers,'x-lark-request-timestamp':'1'},{verificationToken:'t',encryptKey:'k'}),/expired/);});
test('unauthorized and oversized HTTP requests cannot reach workflow',async t=>{let calls=0;const server=createHttpServer({config:{apiKey:'x'.repeat(32),companyId:'c'},workflow:{ingest:()=>{calls++;return{};}},store:{},readiness:()=>({ready:false,missing:['model']})});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());const base='http://127.0.0.1:'+server.address().port;assert.equal((await fetch(base+'/health')).status,200);assert.equal((await fetch(base+'/ready')).status,503);assert.equal((await fetch(base+'/handoffs',{method:'POST',body:'{}'})).status,401);assert.equal(calls,0);assert.equal((await fetch(base+'/handoffs',{method:'POST',headers:{authorization:'Bearer '+'x'.repeat(32)},body:'x'.repeat(2*1024*1024)})).status,413);assert.equal(calls,0);});

test('signed HTTP callbacks accept new namespaced project actions and legacy payloads',async t=>{
 const actions=[],config={verificationToken:'token',encryptKey:'encrypt-key',chatId:'oc_formal',operatorIds:['ou_actor']};
 const server=createHttpServer({config,workflow:{act:action=>{actions.push(action);return{status:action.action};}},store:{},readiness:()=>({ready:true,missing:[]})});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());const url='http://127.0.0.1:'+server.address().port+'/lark/events';
 async function submit(value,eventId){
  const raw=JSON.stringify({type:'event_callback',header:{token:'token',event_type:'card.action.trigger',event_id:eventId},event:{operator:{open_id:'ou_actor'},context:{open_chat_id:'oc_formal',open_message_id:'om_card'},action:{tag:'button',value}}});
  const ts=String(Math.floor(Date.now()/1000)),nonce='nonce-'+eventId,signature=createHash('sha256').update(ts+nonce+'encrypt-key').update(Buffer.from(raw)).digest('hex');
  return fetch(url,{method:'POST',headers:{'content-type':'application/json','x-lark-request-timestamp':ts,'x-lark-request-nonce':nonce,'x-lark-signature':signature},body:raw});
 }
 const common={projectId:'project',version:'v1',cardKey:'card-key'};
 assert.equal((await submit({action:'company_match.defer',...common},'new-action')).status,200);
 assert.equal((await submit({agent:'openbidkit',action:'follow',...common},'legacy-action')).status,200);
 assert.deepEqual(actions.map(action=>({action:action.action,eventId:action.eventId})),[{action:'defer',eventId:'new-action'},{action:'follow',eventId:'legacy-action'}]);
});
