const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');const {createHash}=require('node:crypto');
const {createStore}=require('../store.cjs');
const {createReportArchive,createDriveArchiveClient}=require('../report-archive.cjs');
const digest=s=>createHash('sha256').update(s).digest('hex');
function setup(t,overrides={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'report-archive-')),store=createStore(path.join(root,'state.sqlite3'));t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
 const handoff={status:'ready',snapshot:{documentVersion:1,checksum:'sha256:'+digest('source'),reportId:'report-1'},task:{taskId:'task',title:'报告'},warnings:[]};
 const project={id:'project',taskId:'task',companyId:'company',version:'1',checksum:handoff.snapshot.checksum,generatedAt:'2026-09-10',created:1,revision:1,input:{handoff},assessment:{decision:'review'}};store.saveProject(project);
 let now=1000,publication={status:'publication_required',projectKey:'project-key',title:'报告',documentVersion:1,markdownContent:'# 报告\n\n完整结果',knowledgeContent:{sourceTrace:{sha256:digest('source'),documentVersion:1}}};
 const updateHash=()=>publication.contentHash=digest(`${publication.projectKey}\n${publication.documentVersion}\n${publication.markdownContent}`);updateHash();
 const config={mode:'test',dataRoot:root,chatId:'oc_target',allowedChats:['oc_target'],reportArchive:{enabled:true,root,cliPath:process.execPath,profile:'bot',identity:'bot',folderToken:'folder',allowedFolderTokens:['folder']}};
 const calls={import:0,poll:0,grant:0,verify:0};const client={importMarkdown:async()=>{calls.import++;return{ready:true,token:'doc123',url:'https://tenant.feishu.cn/docx/doc123'};},pollImport:async()=>{calls.poll++;return{ready:true,token:'doc123',url:'https://tenant.feishu.cn/docx/doc123'};},grantGroup:async()=>{calls.grant++;},hasGroup:async()=>{calls.verify++;return true;}};
 const preread={getPublication:async()=>publication,getHandoff:async()=>store.getProject('project').input.handoff};
 const make=extra=>createReportArchive({store,config,preread,client,clock:()=>now,...overrides,...extra});let archive=make();
 const tick=async(n=1)=>{for(let i=0;i<n;i++){now+=61000;await archive.tick();}};
 return{store,config,calls,client,preread,publication,updateHash,make,tick,archive,restart:()=>archive=make()};
}
test('persists import once and binds card URL only after the target group permission is verified',async t=>{
 const x=setup(t);await x.tick();assert.equal(x.calls.import,1);assert.equal(x.store.getProject('project').input.reportUrl,undefined);
 x.restart();await x.tick(3);assert.equal(x.calls.import,1);assert.equal(x.calls.grant,1);assert.equal(x.store.getProject('project').input.reportUrl,'https://tenant.feishu.cn/docx/doc123');
 await x.tick(3);assert.equal(x.calls.import,1);
});
test('unknown import outcome survives restart and does not recreate even after content changes',async t=>{
 const x=setup(t);x.client.importMarkdown=async()=>{x.calls.import++;throw Error('secret remote failure');};await x.tick();x.restart();await x.tick(2);
 x.publication.markdownContent+=' changed';x.updateHash();await x.tick(2);assert.equal(x.calls.import,1);assert.equal(x.archive.list()[0].stage,'manual');assert.equal(x.archive.list()[0].error,'report_import_unknown');
 assert.ok(!JSON.stringify(x.archive.list()).includes('secret remote failure'));
});
test('pending ticket is polled after restart instead of a second import',async t=>{
 const x=setup(t);x.client.importMarkdown=async()=>{x.calls.import++;return{ready:false,ticket:'ticket123'};};await x.tick();x.restart();await x.tick(4);assert.equal(x.calls.import,1);assert.equal(x.calls.poll,1);assert.ok(x.store.getProject('project').input.reportUrl);
});
test('wrong content hash, source checksum or latest report identity cannot publish',async t=>{
 const x=setup(t);x.publication.contentHash='0'.repeat(64);await x.tick();assert.equal(x.calls.import,0);
 x.updateHash();x.publication.knowledgeContent.sourceTrace.sha256='0'.repeat(64);await x.tick();assert.equal(x.calls.import,0);
 x.publication.knowledgeContent.sourceTrace.sha256=digest('source');x.preread.getHandoff=async()=>({snapshot:{reportId:'new-report'}});await x.tick();assert.equal(x.calls.import,0);
});
test('new report content creates a new version and immediately removes the previous content link',async t=>{
 const x=setup(t);await x.tick(4);assert.ok(x.store.getProject('project').input.reportUrl);x.publication.markdownContent+=' new';x.updateHash();await x.tick();assert.equal(x.calls.import,2);assert.equal(x.store.getProject('project').input.reportUrl,undefined);
});
test('unauthorized targets and disabled delivery never publish',async t=>{
 const x=setup(t);x.config.mode='disabled';await x.tick();assert.equal(x.calls.import,0);x.config.mode='test';x.config.reportArchive.allowedFolderTokens=[];await x.tick();assert.equal(x.calls.import,0);
});
test('permission failure retains imported doc and never exposes its URL',async t=>{
 const x=setup(t);x.client.hasGroup=async()=>false;await x.tick(4);assert.equal(x.calls.import,1);assert.equal(x.calls.grant,1);assert.equal(x.archive.list()[0].stage,'manual');assert.equal(x.store.getProject('project').input.reportUrl,undefined);
});
test('CLI uses fixed identity, relative file and explicit private group collaborator arguments',async()=>{
 const calls=[];const c=createDriveArchiveClient({cliPath:process.execPath,profile:'profile',identity:'bot'},{runImpl:async(exe,args,options)=>{calls.push({exe,args,options});return{stdout:JSON.stringify({ok:true,data:{items:[{member_type:'openchat',member_id:'oc_target',perm:'view'}]}})};}});
 await c.importMarkdown({sourcePath:path.resolve('report.md'),folderToken:'folder',title:'report'});await c.grantGroup({token:'doc123',chatId:'oc_target'});assert.equal(await c.hasGroup({token:'doc123',chatId:'oc_target'}),true);
 assert.ok(calls[0].args.includes('./report.md'));assert.ok(calls.every(c=>c.args.includes('--as')&&c.args.includes('bot')&&c.options.windowsHide));assert.ok(calls[1].args.includes('openchat'));assert.ok(calls[1].args.includes('view'));assert.ok(calls[1].args.includes('--yes'));assert.ok(!calls.some(c=>c.args.some(a=>a.includes('public'))));
});
test('a pending older content version finishes polling so newer reports can proceed',async t=>{
 const x=setup(t);x.client.importMarkdown=async()=>{x.calls.import++;return{ready:false,ticket:'ticket123'};};await x.tick();x.publication.markdownContent+=' new';x.updateHash();await x.tick(2);assert.equal(x.calls.poll,1);assert.equal(x.calls.import,2);
});
test('publication GET uses relay authorization instead of handoff credentials',async()=>{
 const {createPrereadClient}=require('../preread.cjs');let call;
 const c=createPrereadClient({baseUrl:'http://localhost',apiKey:'handoff-key',relayAuthorization:'Bearer relay-key',fetchImpl:async(url,options)=>{call={url,options};return Response.json({status:'publication_required'});}});
 await c.getPublication('task/id');assert.equal(call.url,'http://localhost/openapi/preread/tasks/task%2Fid/knowledge-publication');assert.equal(call.options.method,'GET');assert.equal(call.options.headers.authorization,'Bearer relay-key');
});
test('archive configuration requires an explicit approved folder and identity',()=>{
 const {loadConfig}=require('../config.cjs');assert.throws(()=>loadConfig({BID_REPORT_ARCHIVE_ENABLED:'true'}),/report_archive_not_configured/);
});
