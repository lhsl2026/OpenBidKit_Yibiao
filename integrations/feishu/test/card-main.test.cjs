const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {loadConfig}=require('../config.cjs');const {createApplication}=require('../main.cjs');
test('WS readiness uses the consumer marker and lifecycle stays inside runner ownership',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bid-card-main-'));
 const config={...loadConfig({BID_DATA_ROOT:dir,BID_CARD_SOURCE_ENABLED:'true',BID_LARK_CLI_PATH:process.execPath,BID_CARD_CLI_PROFILE:'openbidkit-feishu',BID_CHAT_ID:'oc_test',BID_OPERATOR_IDS:'ou_actor'}),port:0};
 let ready=false;const order=[];
 const app=createApplication(config,{readEvidence:async()=>({snapshot:{records:[],warnings:[]},rules:[]}),cardSourceFactory:({assertOwnership})=>({start(){assertOwnership();order.push('source-start');},close:async()=>{assertOwnership();order.push('source-close');},status:()=>({ready,accepted:3,rejected:1,error:ready?null:'card_source_disconnected',lastReadyAt:100,lastEventAt:200})})});t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
 assert.equal(app.readiness().missing.includes('card_callback'),true);await app.start();assert.deepEqual(order,['source-start']);ready=true;assert.equal(app.readiness().missing.includes('card_callback'),false);
 assert.deepEqual(app.readiness().cardCallback,{enabled:true,ready:true,accepted:3,rejected:1,error:null,lastReadyAt:100,lastEventAt:200});
 let httpActions=0;app.workflow.act=()=>{httpActions++;};
 const response=await fetch('http://127.0.0.1:'+app.server.address().port+'/lark/events',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({header:{event_type:'card.action.trigger',event_id:'forged'},event:{action:{value:{agent:'openbidkit'}}}})});
 assert.ok(response.status>=400);assert.equal(httpActions,0);
 ready=false;assert.equal(app.readiness().missing.includes('card_callback'),true);await app.close();assert.deepEqual(order,['source-start','source-close']);assert.throws(()=>app.runner.assertOwnership());
});
test('HTTP callback readiness still requires verification and encryption when WS is disabled',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bid-card-http-'));const config={...loadConfig({BID_DATA_ROOT:dir,BID_OPERATOR_IDS:'ou_actor'}),port:0};const app=createApplication(config);t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
 assert.ok(app.readiness().missing.includes('card_callback'));config.verificationToken='token';config.encryptKey='encrypt';assert.equal(app.readiness().missing.includes('card_callback'),false);
});
test('readiness reports the active production delivery gate instead of a test-only error',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bid-production-ready-'));
 const base=loadConfig({BID_DATA_ROOT:dir,BID_COMPANY_ID:'隆创信息有限公司',BID_API_KEY:'x'.repeat(32)});
 const config={...base,mode:'production',chatId:'oc_production',allowedChats:['oc_production'],production:{cutover:true,chatId:'oc_production',allowedChats:['oc_production']},port:0};
 const app=createApplication(config);t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
 const ready=app.readiness();assert.equal(ready.mode,'production');assert.deepEqual(ready.delivery,{target:'production',configured:true});
 assert.equal(ready.missing.includes('test_delivery'),false);assert.equal(ready.missing.includes('production_delivery'),false);
 config.production.cutover=false;assert.equal(app.readiness().missing.includes('production_delivery'),true);assert.equal(app.readiness().delivery.configured,false);
});
test('recovered local source binds to matching handoff digest and a mismatch stays blocked',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bid-source-match-'));const app=createApplication({...loadConfig({BID_DATA_ROOT:dir,BID_COMPANY_ID:'company'}),port:0});t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
 const sha='a'.repeat(64),sourcePath=path.join(dir,'writing','sources','source.pdf');app.store.set('document-source:task',{sourcePath,sha256:sha});
 const handoff={schemaVersion:'1.0',task:{taskId:'task',title:'test'},snapshot:{documentVersion:'v1',reportId:'r1',checksum:'sha256:'+sha.toUpperCase(),generatedAt:'2026-09-09T00:00:00Z'},latestDocumentVersion:'v1',status:'ready',requirements:[],warnings:[],evidence:[]};
 const p=app.workflow.ingest({companyId:'company',handoff});assert.equal(p.input.sourcePath,sourcePath);assert.equal(p.input.sourceChecksum,sha);
 const changed={...handoff,snapshot:{...handoff.snapshot,documentVersion:'v2',reportId:'r2',checksum:'b'.repeat(64),generatedAt:'2026-09-10T00:00:00Z'},latestDocumentVersion:'v2'};
 const p2=app.workflow.ingest({companyId:'company',handoff:changed});assert.equal(p2.input.sourcePath,undefined);assert.ok(p2.input.handoff.warnings.some(w=>w.code==='source_checksum_mismatch'&&w.blocked));assert.ok(app.workflow.revalidate(p2.id).input.handoff.warnings.some(w=>w.code==='source_checksum_mismatch'));
});
test('application routes group file choices and reports stale source readiness without private identifiers',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bid-group-file-main-'));const config={...loadConfig({BID_DATA_ROOT:dir,BID_CHAT_ID:'oc_test',BID_OPERATOR_IDS:'ou_actor'}),port:0};config.groupFileSource={enabled:true};let action,sourceState={enabled:true,lastSuccessAt:null,error:null};
 const app=createApplication(config,{readEvidence:async()=>({snapshot:{records:[],warnings:[]},rules:[]}),groupFileSourceFactory:()=>({poll:async()=>{},tick:async()=>{},select:async(value,event)=>{action={value,event};return {status:'selected'};},status:()=>sourceState}),cardSourceFactory:({onAction})=>({start(){},close:async()=>{},status:()=>({ready:false}),act:onAction})});t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
 assert.equal(app.readiness().missing.includes('group_file_source'),true);sourceState={enabled:true,lastSuccessAt:Date.now(),error:null};assert.equal(app.readiness().missing.includes('group_file_source'),false);
 const result=await app.cardSource.act({agent:'openbidkit-group-file',action:'select_task',jobId:'job',taskId:'task',revision:1},{eventId:'event'});assert.deepEqual(result,{status:'selected'});assert.equal(action.value.jobId,'job');assert.equal(JSON.stringify(app.readiness()).includes('oc_test'),false);
});
