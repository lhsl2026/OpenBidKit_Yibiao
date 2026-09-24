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

test('application sends preread review callbacks only through the unified consumer adapter',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bid-preread-card-main-'));const config={...loadConfig({BID_DATA_ROOT:dir,BID_CHAT_ID:'oc_test',BID_OPERATOR_IDS:'ou_actor'}),port:0,prereadCardRelay:{enabled:true,scriptPath:'C:/agent/preread-lark-card-relay.js'}};
 let actionHandler,forwarded;const relay={handle:async raw=>{forwarded=raw;},status:()=>({enabled:true,ready:true,error:null})};
 const app=createApplication(config,{readEvidence:async()=>({snapshot:{records:[],warnings:[]},rules:[]}),prereadCardRelayFactory:()=>relay,cardSourceFactory:({onAction})=>{actionHandler=onAction;return{start(){},close:async()=>{},status:()=>({ready:true})};}});t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
 const raw={type:'card.action.trigger',event_id:'evt-1',operator_id:'ou_actor',chat_id:'oc_test',message_id:'om_card',host:'im_message',action_tag:'button',action_value:'{}'};
 await actionHandler({agent:'preread',action:'confirm_preprocess_review',raw},{eventId:'evt-1',actorId:'ou_actor',chatId:'oc_test',messageId:'om_card'},'preread_callback');
 assert.deepEqual(forwarded,raw);assert.equal(app.readiness().missing.includes('preread_card_callback'),false);
});

test('company selection callback reaches preread and refreshes only the existing project card',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bid-company-select-'));const config={...loadConfig({BID_DATA_ROOT:dir,BID_COMPANY_ID:'company',BID_CHAT_ID:'oc_test',BID_OPERATOR_IDS:'ou_actor'}),prereadUrl:'http://127.0.0.1:3101',relayAuthorization:'Bearer '+('a'.repeat(43)),port:0};
 const calls=[];let actionHandler;const handoff={schemaVersion:'1.0',task:{taskId:'8154f64c-81e1-4fc4-849f-95cbd4e9ff41',title:'项目'},snapshot:{documentVersion:'3',reportId:'r1',checksum:'a'.repeat(64),generatedAt:'2026-09-23T00:00:00Z'},latestDocumentVersion:'3',status:'ready',requirements:[],warnings:[],evidence:[],companyMatch:{companyId:'company-b',companyName:'乙公司',profileVersion:'profile-b',syncStatus:'synced',qualificationCount:1,completeness:1,counts:{profileEvidenceSatisfied:1,humanConfirmedCurrent:0,humanConfirmedReused:0,pendingReview:0,gaps:0,notApplicable:0}}};
 const companyMatchCard={taskId:handoff.task.taskId,runId:'11111111-1111-4111-8111-111111111111',documentVersion:3,sourceCardMessageId:'om_card',scopeType:'group',scopeId:'oc_test',selectedCompanyId:'company-b',selectedCompanyProfileVersion:'profile-b',companies:[{companyId:'company-a',companyName:'甲公司',profileVersion:'profile-a',enabled:true},{companyId:'company-b',companyName:'乙公司',profileVersion:'profile-b',enabled:true}]};
 const preread={select:async payload=>{calls.push(payload);return{status:'company_selection_processed'};},getHandoff:async()=>handoff,getCompanyMatchCard:async()=>companyMatchCard};
 const app=createApplication(config,{prereadFactory:()=>preread,readEvidence:async()=>({snapshot:{records:[],warnings:[]},rules:[]}),cardSourceFactory:({onAction})=>{actionHandler=onAction;return{start(){},close:async()=>{},status:()=>({ready:true})};}});t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
 const p=app.workflow.ingest({companyId:'company',handoff,companyMatchCard:{...companyMatchCard,selectedCompanyId:'company-a',selectedCompanyProfileVersion:'profile-a'}});app.store.bindMessage(p.id,'om_card');
 const value={agent:'openbidkit',action:'select',projectId:p.id,version:p.version,cardKey:app.store.key(p.input,p.assessment),taskId:handoff.task.taskId,runId:companyMatchCard.runId,documentVersion:3,companyId:'company-b',companyProfileVersion:'profile-b',scopeType:'group',scopeId:'oc_test',sourceCardMessageId:'om_card'};
 for(const [changedValue,changedEvent] of [
  [{...value,sourceCardMessageId:'om_old'},{}],
  [{...value,companyId:'company-disabled',companyProfileVersion:'profile-disabled'},{}],
  [{...value,companyProfileVersion:'profile-old'},{}],
  [{...value,scopeId:'oc_other'},{}],
  [{...value,scopeType:'private',scopeId:'ou_other'},{}],
 ])await assert.rejects(()=>actionHandler(changedValue,{eventId:'evt-reject',actorId:'ou_actor',chatId:'oc_test',messageId:'om_card',...changedEvent},'company_match'));
 assert.equal(calls.length,0);
 await actionHandler(value,{eventId:'evt-select',actorId:'ou_actor',chatId:'oc_test',messageId:'om_card'},'company_match');
 await actionHandler(value,{eventId:'evt-select',actorId:'ou_actor',chatId:'oc_test',messageId:'om_card'},'company_match');
 assert.deepEqual(calls,[{eventId:'evt-select',chatId:'oc_test',operatorId:'ou_actor',sourceCardMessageId:'om_card',action:'select_company',taskId:handoff.task.taskId,runId:companyMatchCard.runId,documentVersion:3,companyId:'company-b',companyProfileVersion:'profile-b',scopeType:'group',scopeId:'oc_test'}]);
 assert.equal(app.store.listProjects().length,1);assert.equal(app.store.getProject(p.id).input.companyMatchCard.selectedCompanyId,'company-b');assert.equal(app.store.db.prepare('SELECT COUNT(*) count FROM card_streams').get().count,0);assert.equal(new Set(app.store.listOutbox(Infinity).filter(row=>row.project_id).map(row=>row.project_id)).size,1);
});

test('a group member can open company review and the existing project card is queued with a compact review snapshot',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bid-company-review-'));const config={...loadConfig({BID_DATA_ROOT:dir,BID_COMPANY_ID:'company',BID_CHAT_ID:'oc_test',BID_OPERATOR_IDS:'ou_admin'}),prereadUrl:'http://127.0.0.1:3101',relayAuthorization:'Bearer '+('a'.repeat(43)),port:0};
 let actionHandler;const taskId='8154f64c-81e1-4fc4-849f-95cbd4e9ff41',runId='11111111-1111-4111-8111-111111111111';
 const handoff={schemaVersion:'1.0',task:{taskId,title:'项目'},snapshot:{documentVersion:'3',reportId:'r1',checksum:'a'.repeat(64),generatedAt:'2026-09-23T00:00:00Z'},latestDocumentVersion:'3',status:'ready',requirements:[],warnings:[],evidence:[],companyMatch:{companyId:'company-a',companyName:'甲公司',profileVersion:'profile-a',syncStatus:'synced',qualificationCount:2,completeness:.5,counts:{profileEvidenceSatisfied:1,humanConfirmedCurrent:0,humanConfirmedReused:0,pendingReview:1,gaps:0,notApplicable:0}}};
 const companyMatchCard={taskId,runId,documentVersion:3,sourceCardMessageId:'om_card',scopeType:'group',scopeId:'oc_test',selectedCompanyId:'company-a',selectedCompanyProfileVersion:'profile-a',companies:[{companyId:'company-a',companyName:'甲公司',profileVersion:'profile-a',enabled:true}]};
 const review={taskId,runId,companyId:'company-a',companyProfileVersion:'profile-a',items:[{id:'q-1',requirement:'提供有效营业执照',evidenceRequirement:'营业执照复印件',matchStatus:'confirmed_met',companyEvidencePaths:['company/a.pdf'],gapAction:'已找到有效证据',evidence:{page:4}},{id:'q-2',requirement:'提供本年度社保证明',evidenceRequirement:'社保缴纳证明',matchStatus:'unconfirmed',companyEvidencePaths:[],gapAction:'待补充证明',evidence:{page:5}}]};
 const preread={select:async()=>({status:'company_match_review',review})};
 const app=createApplication(config,{prereadFactory:()=>preread,readEvidence:async()=>({snapshot:{records:[],warnings:[]},rules:[]}),cardSourceFactory:({onAction})=>{actionHandler=onAction;return{start(){},close:async()=>{},status:()=>({ready:true})};}});t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
 const p=app.workflow.ingest({companyId:'company',handoff,companyMatchCard});app.store.bindMessage(p.id,'om_card');for(const row of app.store.listOutbox(Infinity))app.store.sent(row.id);
 const value={agent:'openbidkit',action:'review',projectId:p.id,version:p.version,cardKey:app.store.key(p.input,p.assessment),taskId,runId,documentVersion:3,companyId:'company-a',companyProfileVersion:'profile-a',scopeType:'group',scopeId:'oc_test',sourceCardMessageId:'om_card'};
 const result=await actionHandler(value,{eventId:'evt-review',actorId:'ou_group_member',chatId:'oc_test',messageId:'om_card'},'company_match');
 assert.equal(result.status,'company_match_review');const saved=app.store.get('company-match-review:'+p.id);assert.deepEqual(saved.counts,{confirmed:1,pending:1,gaps:0,notApplicable:0});assert.equal(saved.items.length,2);assert.equal(saved.items[0].requirement,'提供有效营业执照');assert.equal(saved.items[0].companyEvidencePaths,undefined);assert.equal(app.store.listOutbox(Infinity).filter(row=>row.project_id===p.id).length,1);
});

test('a legacy single-company review with no stored selection is bound to that sole displayed company',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bid-company-review-legacy-'));const config={...loadConfig({BID_DATA_ROOT:dir,BID_COMPANY_ID:'company',BID_CHAT_ID:'oc_test',BID_OPERATOR_IDS:'ou_admin'}),prereadUrl:'http://127.0.0.1:3101',relayAuthorization:'Bearer '+('a'.repeat(43)),port:0};
 let actionHandler;const taskId='8154f64c-81e1-4fc4-849f-95cbd4e9ff42',runId='11111111-1111-4111-8111-111111111112';
 const handoff={schemaVersion:'1.0',task:{taskId,title:'旧项目'},snapshot:{documentVersion:'3',reportId:'r1',checksum:'a'.repeat(64),generatedAt:'2026-09-23T00:00:00Z'},latestDocumentVersion:'3',status:'ready',requirements:[],warnings:[],evidence:[],companyMatch:{companyId:null,companyName:null,profileVersion:null,syncStatus:'missing',qualificationCount:1,completeness:0,counts:{profileEvidenceSatisfied:0,humanConfirmedCurrent:0,humanConfirmedReused:0,pendingReview:1,gaps:0,notApplicable:0}}};
 const companyMatchCard={taskId,runId,documentVersion:3,sourceCardMessageId:'om_card',scopeType:'group',scopeId:'oc_test',selectedCompanyId:null,selectedCompanyProfileVersion:null,companies:[{companyId:'company-a',companyName:'甲公司',profileVersion:'profile-a',enabled:true}]};
 const review={taskId,runId,companyId:null,companyProfileVersion:null,items:[{id:'q-1',requirement:'提供有效营业执照',evidenceRequirement:'营业执照复印件',matchStatus:'company_profile_missing',companyEvidencePaths:[],gapAction:'待选择公司并核验',evidence:{page:4}}]};
 const preread={select:async()=>({status:'company_match_review',review})};
 const app=createApplication(config,{prereadFactory:()=>preread,readEvidence:async()=>({snapshot:{records:[],warnings:[]},rules:[]}),cardSourceFactory:({onAction})=>{actionHandler=onAction;return{start(){},close:async()=>{},status:()=>({ready:true})};}});t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
 const p=app.workflow.ingest({companyId:'company',handoff,companyMatchCard});app.store.bindMessage(p.id,'om_card');for(const row of app.store.listOutbox(Infinity))app.store.sent(row.id);
 const value={agent:'openbidkit',action:'review',projectId:p.id,version:p.version,cardKey:app.store.key(p.input,p.assessment),taskId,runId,documentVersion:3,companyId:'company-a',companyProfileVersion:'profile-a',scopeType:'group',scopeId:'oc_test',sourceCardMessageId:'om_card'};
 await actionHandler(value,{eventId:'evt-review-legacy',actorId:'ou_group_member',chatId:'oc_test',messageId:'om_card'},'company_match');
 const saved=app.store.get('company-match-review:'+p.id);assert.equal(saved.companyId,'company-a');assert.equal(saved.companyProfileVersion,'profile-a');assert.deepEqual(saved.counts,{confirmed:0,pending:1,gaps:0,notApplicable:0});
});
