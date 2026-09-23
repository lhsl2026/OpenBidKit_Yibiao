const {test}=require('node:test');const assert=require('node:assert/strict');const http=require('node:http');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {createHash}=require('node:crypto');
const {createStore}=require('../store.cjs');const {createWorkflow}=require('../workflow.cjs');const {createRunner}=require('../runner.cjs');
const {createPrereadClient}=require('../preread.cjs');const {createLarkClient}=require('../lark.cjs');const {createHttpServer}=require('../server.cjs');const {assessTender}=require('../assessment.cjs');
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',()=>r('http://127.0.0.1:'+s.address().port)));
test('HTTP radar → preread → one Feishu card → confirmed draft file, with durable restart',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bid-e2e-'));
 const hash=createHash('sha256').update('synthetic document').digest('hex');
 const handoff={schemaVersion:'1.0',task:{taskId:'t',title:'离线联调示例'},snapshot:{documentVersion:'doc:1',reportVersion:'report:1',reportId:'r',checksum:'sha256:'+hash,generatedAt:'2026-09-09T00:00:00Z',confidence:1,completeness:1},latestDocumentVersion:'doc:1',superseded:false,status:'ready',requirements:[{id:'q',key:'示例资格',category:'qualification',value:'已核实',requiresConfirmation:false,confidence:1}],warnings:[],evidence:[]};
 let cards=0,files=0,radars=0;const auth=[];
 const fake=http.createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);const raw=Buffer.concat(chunks);auth.push([req.url,req.headers.authorization]);let data;
  if(req.url==='/openapi/preread/events/lark-message'){radars++;data={status:'processed',results:[{status:'triggered',taskId:'t'}]};}
  else if(req.url==='/api/preread/tasks/t/handoff')data=handoff;
  else if(req.url==='/open-apis/auth/v3/tenant_access_token/internal')data={code:0,tenant_access_token:'fake-token',expire:7200};
  else if(req.url==='/open-apis/im/v1/files')data={code:0,data:{file_key:'fake-file'}};
  else if(req.method==='POST'&&req.url.startsWith('/open-apis/im/v1/messages')){const body=JSON.parse(raw);body.msg_type==='interactive'?cards++:files++;data={code:0,data:{message_id:body.msg_type==='interactive'?'om_card':'om_file'}};}
  else data={code:0,data:{}};
  res.setHeader('content-type','application/json');res.end(JSON.stringify(data));
 });const fakeUrl=await listen(fake);t.after(()=>fake.close());
 let store=createStore(path.join(dir,'state.db'));t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const deadline='2026-12-01T10:00:00+08:00';const rules=[{requirementId:'q',kind:'manual',verified:true,result:'satisfied'}];
 const config={companyId:'synthetic-company',apiKey:'k'.repeat(32),verificationToken:'token',encryptKey:'encrypt',chatId:'test-chat',allowedChats:['test-chat'],operatorIds:['actor'],sourceChats:['radar'],sourceSenders:['bot'],mode:'test',summaryHour:23,writingRoot:dir};
 const clock=()=>Date.parse('2026-09-09T01:00:00Z');
 const workflow=createWorkflow({store,clock,chatId:config.chatId,operatorIds:config.operatorIds,assess:input=>assessTender({...input,rules,snapshot:{records:[],warnings:[]},deadline,now:new Date(clock()).toISOString()})});
 const wrapped={...workflow,ingest:input=>workflow.ingest({...input,deadline,rules})};
 const preread=createPrereadClient({baseUrl:fakeUrl,apiKey:'handoff-key',relayAuthorization:'Bearer relay-key'});
 const lark=createLarkClient({appId:'synthetic',appSecret:'synthetic',fetchImpl:(url,options)=>fetch(fakeUrl+new URL(url).pathname+new URL(url).search,options)});
 const runner=createRunner({store,config,workflow:wrapped,preread,lark,clock,write:async job=>{const file=path.join(dir,'draft.txt');fs.writeFileSync(file,'Synthetic draft — no model called');return{status:'completed',stage:'export',artifacts:[{path:file,sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')}]};}});
 const server=createHttpServer({config,workflow:wrapped,store,readiness:()=>({ready:true}),radar:runner.receiveRadar});const url=await listen(server);t.after(()=>server.close());
 const event={eventType:'im.message.receive_v1',eventId:'event',messageId:'notice',chatId:'radar',senderId:'bot',messageType:'text',content:'{"text":"synthetic"}'};
 for(let n=0;n<2;n++)assert.equal((await fetch(url+'/radar',{method:'POST',headers:{authorization:'Bearer '+config.apiKey},body:JSON.stringify(event)})).status,202);
 await runner.tick();assert.equal(radars,1);assert.equal(cards,1);const p=store.listProjects()[0];assert.equal(p.assessment.decision,'follow');
 async function callback(action,id){const raw=JSON.stringify({header:{token:config.verificationToken,event_type:'card.action.trigger',event_id:id},event:{operator:{open_id:'actor'},context:{open_chat_id:'test-chat',open_message_id:'om_card'},action:{value:{agent:'openbidkit',projectId:p.id,version:p.version,cardKey:store.key(p.input,p.assessment),action}}}});const ts=String(Math.floor(Date.now()/1000));return fetch(url+'/lark/events',{method:'POST',headers:{'x-lark-request-timestamp':ts,'x-lark-request-nonce':'n','x-lark-signature':createHash('sha256').update(ts+'n'+config.encryptKey+raw).digest('hex')},body:raw});}
 assert.equal((await callback('follow','follow-event')).status,200);assert.equal((await callback('write','write-event')).status,200);await runner.tick();await runner.tick();assert.equal(files,1);assert.equal(cards,1);
 assert.ok(auth.some(([u,a])=>u.includes('handoff')&&a==='Bearer handoff-key'));assert.ok(auth.some(([u,a])=>u.includes('lark-message')&&a==='Bearer relay-key'));
 await new Promise(r=>server.close(r));store.close();store=createStore(path.join(dir,'state.db'));assert.equal(store.getProject(p.id).humanDecision,'follow');assert.equal(store.listWriting()[0].status,'completed');assert.equal(store.listFiles(clock()).length,0);
});
