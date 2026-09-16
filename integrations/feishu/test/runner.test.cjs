const {test}=require('node:test');const assert=require('node:assert/strict');
const {createStore}=require('../store.cjs');const {createRunner}=require('../runner.cjs');const {loadConfig}=require('../config.cjs');
test('config defaults to disabled, rejects unprotected bind and public preread',()=>{
  const c=loadConfig({});assert.equal(c.mode,'disabled');assert.equal(c.host,'127.0.0.1');
  assert.throws(()=>loadConfig({BID_HOST:'0.0.0.0'}),/api_key/);
  assert.throws(()=>loadConfig({PREREAD_BASE_URL:'https://example.com'}),/internal/);
});
test('radar inbox durable, allowlisted, deduplicated and records the complete preread receipt',async()=>{
 const store=createStore(':memory:');let received=0;
 const config={companyId:'c',sourceChats:['source'],sourceSenders:['bot'],mode:'disabled',summaryHour:18};
 const response={status:'processed',actionId:'relay-action',acquisition:{source:'lark'},results:[{taskId:'t',status:'triggered'},{status:'waiting_confirmation',eventId:'manual'}]};
 const runner=createRunner({store,config,workflow:{ingest:()=>{}},preread:{receiveRadar:async()=>{received++;return response;},getHandoff:async()=>{throw Error('pending');}},clock:()=>Date.parse('2026-09-09T11:00:00Z')});
 const event={eventType:'im.message.receive_v1',eventId:'e',chatId:'source',messageId:'m',senderId:'bot',content:'{"text":"tender"}',messageType:'text'};
 assert.throws(()=>runner.receiveRadar({...event,chatId:'other'}),/source_not_allowed/);
 runner.receiveRadar(event);runner.receiveRadar(event);await runner.tick();await runner.tick();
 const receipt=store.db.prepare("SELECT value FROM settings WHERE key LIKE 'radar-receipt:%'").get();
 assert.equal(received,1);assert.equal(store.listWatches(Infinity).length,1);assert.deepEqual(JSON.parse(receipt.value),response);assert.equal(store.listOutbox(Infinity).length,1);store.close();
});

test('an edited radar body is held for review and invalidates work linked to the original body',async()=>{
 const store=createStore(':memory:');const config={companyId:'company',sourceChats:['source'],sourceSenders:['bot'],mode:'disabled',summaryHour:18};
 const runner=createRunner({store,config,workflow:{ingest:()=>{}},clock:()=>1000});
 const original={eventType:'im.message.receive_v1',eventId:'live-1',chatId:'source',messageId:'same-message',senderId:'bot',messageType:'text',content:'{"text":"original"}'};
 runner.receiveRadar(original);const row=store.db.prepare('SELECT id FROM inbox').get();
 store.set('radar-receipt:'+row.id,{status:'processed',results:[{status:'triggered',taskId:'old-task'}]});store.watch('old-task',{companyId:'company'});
 store.saveProject({id:'project',taskId:'old-task',companyId:'company',version:'v1',checksum:'sum',generatedAt:'now',input:{handoff:{}},assessment:{decision:'follow',items:[],blockers:[],actions:[]},revision:1,created:0});
 const outcome=runner.receiveRadar({...original,eventId:'live-2',content:'{"text":"edited"}'});
 assert.equal(outcome.status,'edited_requires_review');assert.equal(store.listWatches(Infinity).length,0);
 const project=store.getProject('project');assert.equal(project.assessment.decision,'review');assert.ok(project.assessment.blockers.includes('source_message_edited'));
 assert.equal(store.db.prepare('SELECT delivered FROM inbox WHERE id=?').get(row.id).delivered,1);
 const saved=JSON.parse(store.db.prepare("SELECT value FROM settings WHERE key LIKE 'radar-message:%'").get().value);assert.equal(saved.original.content,'{"text":"original"}');assert.equal(saved.edits[0].content,'{"text":"edited"}');
 await runner.close();store.close();
});

test('edited source gate survives workflow revalidation and blocks follow',async()=>{
 const {createWorkflow}=require('../workflow.cjs');const store=createStore(':memory:');const now=Date.parse('2026-09-10T00:00:00Z');
 const workflow=createWorkflow({store,assess:()=>({decision:'follow',items:[],blockers:[],actions:[]}),clock:()=>now,chatId:'target',operatorIds:['actor']});
 const handoff={schemaVersion:'1.0',task:{taskId:'task',title:'项目'},snapshot:{documentVersion:'1',reportId:'r',checksum:'sum',generatedAt:'2026-09-09T00:00:00Z'},latestDocumentVersion:'1',status:'ready',requirements:[],warnings:[],evidence:[]};
 const p=workflow.ingest({companyId:'company',deadline:'2026-12-01T00:00:00Z',handoff});store.bindMessage(p.id,'om_card');
 store.reassess(p.id,{decision:'review',items:[],blockers:['source_message_edited'],actions:[]},now,{...p.input,sourceMessage:{status:'edited_requires_review',inboxId:'old'}});
 const current=workflow.revalidate(p.id);assert.equal(current.assessment.decision,'review');assert.ok(current.assessment.blockers.includes('source_message_edited'));
 assert.throws(()=>workflow.act({projectId:p.id,version:p.version,cardKey:store.key(current.input,current.assessment),actorId:'actor',chatId:'target',messageId:'om_card',eventId:'follow-edited',action:'follow'}),/source_message_edited/);store.close();
});

test('editing during preread await preserves only an audit receipt and creates no watch or selection card',async()=>{
 const store=createStore(':memory:');let resolveReceive,queued=0;const pending=new Promise(resolve=>{resolveReceive=resolve;});
 const config={companyId:'company',sourceChats:['source'],sourceSenders:['bot'],mode:'disabled',summaryHour:18};
 const runner=createRunner({store,config,workflow:{ingest:()=>assert.fail('handoff')},preread:{receiveRadar:()=>pending,getHandoff:()=>assert.fail('watch')},onReceipt:()=>{queued++;},clock:()=>1000});
 const original={eventType:'im.message.receive_v1',eventId:'one',chatId:'source',messageId:'same',senderId:'bot',messageType:'text',content:'original'};runner.receiveRadar(original);
 const ticking=runner.tick();await new Promise(setImmediate);runner.receiveRadar({...original,eventId:'two',content:'edited'});
 const response={status:'processed',messageId:'same',projects:[{sourceMessageId:'same',title:'待选'}],results:[{status:'waiting_confirmation',eventId:'123e4567-e89b-12d3-a456-426614174000'},{status:'triggered',taskId:'stale'}]};resolveReceive(response);await ticking;
 assert.deepEqual(store.db.prepare("SELECT value FROM settings WHERE key LIKE 'radar-receipt:%'").all().map(r=>JSON.parse(r.value)),[response]);assert.equal(store.listWatches(Infinity).length,0);assert.equal(queued,0);await runner.close();store.close();
});

test('editing during handoff await prevents stale ingest and watch resurrection',async()=>{
 const store=createStore(':memory:');let resolveHandoff,ingested=0;const pending=new Promise(resolve=>{resolveHandoff=resolve;});
 const config={companyId:'company',sourceChats:['source'],sourceSenders:['bot'],mode:'disabled',summaryHour:18};const runner=createRunner({store,config,workflow:{ingest:()=>{ingested++;}},preread:{receiveRadar:()=>assert.fail('inbox'),getHandoff:()=>pending},clock:()=>1000});
 const original={eventType:'im.message.receive_v1',eventId:'one',chatId:'source',messageId:'same',senderId:'bot',messageType:'text',content:'original'};runner.receiveRadar(original);const inboxId=store.db.prepare('SELECT id FROM inbox').get().id;
 store.finishInbox(inboxId);store.set('radar-receipt:'+inboxId,{status:'processed',results:[{status:'triggered',taskId:'task'}]});store.watch('task',{companyId:'company',sourceInboxId:inboxId});
 const ticking=runner.tick();await new Promise(setImmediate);runner.receiveRadar({...original,eventId:'two',content:'edited'});resolveHandoff({schemaVersion:'1.0'});await ticking;
 assert.equal(ingested,0);assert.equal(store.getWatch('task'),null);await runner.close();store.close();
});
test('formal group file polling and advancement run only while the runner lease is owned',async t=>{
 const store=createStore(':memory:');const calls=[];const groupFileSource={poll:async()=>{calls.push('poll');},tick:async()=>{calls.push('tick');}};
 const runner=createRunner({store,config:{companyId:'company',sourceChats:[],sourceSenders:[],mode:'disabled',summaryHour:18,radarPolling:{enabled:false}},workflow:{ingest:()=>{}},groupFileSource,clock:()=>1000});t.after(()=>runner.close());
 await runner.tick();assert.deepEqual(calls,['poll','tick']);assert.equal(runner.isRunning(),false);
 await runner.close();await runner.tick();assert.deepEqual(calls,['poll','tick']);store.close();
});
