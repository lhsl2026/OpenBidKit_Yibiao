const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {loadConfig}=require('../config.cjs'),{createApplication}=require('../main.cjs');
const {createRunner}=require('../runner.cjs'),{createWorkflow}=require('../workflow.cjs'),{createStore}=require('../store.cjs');
const handoff=()=>({schemaVersion:'1.0',task:{taskId:'task',title:'report'},snapshot:{documentVersion:1,reportId:'report-1',reportVersion:'r1',checksum:'a'.repeat(64),generatedAt:'2026-09-10T00:00:00Z'},latestDocumentVersion:1,status:'ready',requirements:[],warnings:[],evidence:[]});
function bind(store,p){const input={...p.input,reportUrl:'https://tenant.feishu.cn/docx/doc123',reportArchive:{id:'archive-id',contentHash:'b'.repeat(64),reportId:'report-1',reportVersion:'r1',documentVersion:1,checksum:'a'.repeat(64)}};store.db.prepare('UPDATE projects SET payload=? WHERE id=?').run(JSON.stringify(input),p.id);store.touchCard(p.id,1);store.decide(p.id,'follow','operator',1);return store.getProject(p.id);}
test('real runner watch refresh through application normalization preserves archive and human decision without revisions',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'archive-watch-'));let now=Date.parse('2026-09-10T01:00:00Z');
 const config={...loadConfig({BID_DATA_ROOT:root,BID_COMPANY_ID:'company'}),port:0};const app=createApplication(config,{clock:()=>now});
 const h=handoff();let latest=h;const runner=createRunner({store:app.store,config,workflow:app.workflow,clock:()=>now,preread:{getHandoff:async()=>latest}});
 t.after(async()=>{await runner.close();await app.close();fs.rmSync(root,{recursive:true,force:true});});
 const p=bind(app.store,app.workflow.ingest({companyId:'company',handoff:h}));app.store.watch('task',{companyId:'company'});
 const advance=()=>{now+=61000;app.store.db.prepare('UPDATE leases SET expires=? WHERE name=?').run(now+60000,'runner');};
 await runner.tick();advance();await runner.tick();const refreshed=app.store.getProject(p.id);
 assert.equal(refreshed.input.reportUrl,p.input.reportUrl);assert.equal(refreshed.humanDecision,'follow');assert.equal(refreshed.revision,p.revision);
 // Same source file, regenerated report: the prior content link must disappear in ingest itself.
 latest={...h,snapshot:{...h.snapshot,reportId:'report-2',generatedAt:'2026-09-10T00:01:00Z'}};advance();await runner.tick();
 const changed=app.store.getProject(p.id);assert.equal(changed.input.reportUrl,undefined);assert.equal(changed.input.reportArchive,undefined);assert.equal(changed.humanDecision,null);
});
test('workflow also preserves managed archive metadata when a caller supplies only the same handoff',t=>{
 const store=createStore(':memory:');t.after(()=>store.close());const workflow=createWorkflow({store,assess:()=>({decision:'review'}),clock:()=>1});
 const input={companyId:'company',handoff:handoff()},p=bind(store,workflow.ingest(input));const next=workflow.ingest(input);
 assert.equal(next.input.reportUrl,p.input.reportUrl);assert.equal(next.revision,p.revision);assert.equal(next.humanDecision,'follow');
});
test('revoked content link is not resurrected by a subsequent unchanged watch refresh',t=>{
 const store=createStore(':memory:');t.after(()=>store.close());const workflow=createWorkflow({store,assess:()=>({decision:'review'}),clock:()=>1});
 const input={companyId:'company',handoff:handoff()},p=bind(store,workflow.ingest(input));
 const revoked={...p.input};delete revoked.reportUrl;delete revoked.reportArchive;store.db.prepare('UPDATE projects SET payload=? WHERE id=?').run(JSON.stringify(revoked),p.id);
 const next=workflow.ingest(input);assert.equal(next.input.reportUrl,undefined);assert.equal(next.input.reportArchive,undefined);assert.equal(next.humanDecision,'follow');
});
test('same report ID with a new reportVersion immediately revokes its old link in workflow ingest',t=>{
 const store=createStore(':memory:');t.after(()=>store.close());const workflow=createWorkflow({store,assess:()=>({decision:'review'}),clock:()=>1});
 const input={companyId:'company',handoff:handoff()},p=bind(store,workflow.ingest(input));const changed=structuredClone(p.input);changed.handoff.snapshot.reportVersion='r2';
 const next=workflow.ingest(changed);assert.equal(next.input.reportUrl,undefined);assert.equal(next.input.reportArchive,undefined);assert.equal(next.humanDecision,null);
});
