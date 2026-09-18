const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');const {createHash}=require('node:crypto');
const {createStore}=require('../store.cjs');const {createDocumentRecovery,createAppStorage}=require('../document-recovery.cjs');
const bytes=Buffer.from('%PDF-1.7\npublic tender\n%%EOF'),sha256=createHash('sha256').update(bytes).digest('hex');
const taskId='11111111-1111-1111-1111-111111111111',actionId='22222222-2222-2222-2222-222222222222';
const sourceUrl='https://ggzy.guizhou.gov.cn/tradeInfo/detailHtml?metaId=123456';
const project={title:'A项目采购',officialUrl:sourceUrl,sourceMessageId:'om_daily'};const result={status:'triggered',taskId,acquisition:{status:'waiting_upload',errorCode:'complete_tender_document_missing',actionId}};
const receipt={status:'processed',messageId:'om_daily',projects:[project],results:[result]};
function setup(t,overrides={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bid-doc-recovery-')),store=createStore(':memory:');t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
 const calls={download:0,upload:0,sign:0,attach:0};let body;
 const config={dataRoot:root,companyId:'company',chatId:'oc_target',operatorIds:['ou_actor'],documentRecovery:{enabled:true,root,appId:'app_17agc8m97f2',cliPath:process.execPath,profile:'authorized-user'}};
 const defaults={store,config,provider:{recover:async()=>{calls.download++;return {status:'obtained',bytes,fileName:'正文.pdf',sha256,sourceUrl};}},storage:{upload:async()=>{calls.upload++;return {remotePath:'/stored.pdf'};},sign:async()=>{calls.sign++;return {url:'https://files.example/public.pdf?signature=private'};}},attach:async input=>{calls.attach++;body=input;return {acquisition:{status:'acquired',documentId:'document',documentVersion:1},report:null};}};
 const make=extra=>createDocumentRecovery({...defaults,...overrides,...extra});const recovery=make();return{root,store,config,calls,recovery,make,body:()=>body};
}
test('only real supported waiting-upload results queue; selection results use selectedProjects',t=>{
 const {recovery,store}=setup(t);assert.equal(recovery.queueReceipt(receipt).length,1);assert.equal(recovery.queueReceipt(receipt).length,1);
 for(const changed of [{...result,acquisition:{...result.acquisition,actionId:''}},{...result,status:'waiting_confirmation'},{...result,taskId:''}])assert.equal(recovery.queueReceipt({...receipt,results:[changed]}).length,0);
 assert.equal(recovery.queueReceipt({...receipt,projects:[{...project,officialUrl:'https://evil.example/file.pdf'}]}).length,0);
 const selected={...result,taskId:'33333333-3333-3333-3333-333333333333',acquisition:{...result.acquisition,actionId:'44444444-4444-4444-4444-444444444444'}};
 assert.equal(recovery.queueReceipt({status:'selection_processed',selection:{status:'processed',selectedProjects:[project],results:[selected]}}).length,1);assert.equal(recovery.list().length,2);
});
test('waiting candidates expose only safe task matching fields',t=>{
 const {recovery}=setup(t);recovery.queueReceipt(receipt);assert.deepEqual(recovery.waitingCandidates(),[{taskId,manualActionId:actionId,title:'A项目采购',statusCardMessageId:null,sourceInboxId:null}]);
});
test('one phase per tick preserves checksum source and attaches once without persisting signed URL',async t=>{
 const {recovery,store,calls,make,body}=setup(t);recovery.queueReceipt(receipt);await recovery.tick();assert.equal(recovery.list()[0].stage,'downloaded');assert.equal(calls.upload,0);
 await make().tick();assert.equal(recovery.list()[0].stage,'uploaded');assert.equal(calls.attach,0);
 await make().tick();await make().tick();assert.deepEqual(calls,{download:1,upload:1,sign:1,attach:1});assert.equal(recovery.list()[0].stage,'attached');
 assert.equal(body().taskId,taskId);assert.equal(body().body.manualActionId,actionId);assert.equal(body().body.candidate.officialCategory,'tender_document');assert.match(body().body.candidate.fileName,/招标文件正文\.pdf$/);
 const saved=store.get('document-source:'+taskId);assert.equal(saved.sha256,sha256);assert.equal(fs.readFileSync(saved.sourcePath).equals(bytes),true);assert.equal(store.listWatches(Infinity)[0].payload.sourcePath,saved.sourcePath);
 const serialized=JSON.stringify(store.db.prepare('SELECT value FROM settings').all());assert.ok(!serialized.includes('signature=private'));
});
test('uncertain upload or restart during uploading never retries the remote write',async t=>{
 const {recovery,make,calls}=setup(t,{storage:{upload:async()=>{calls.upload++;throw Error('ambiguous secret');},sign:async()=>assert.fail()}});recovery.queueReceipt(receipt);await recovery.tick();await recovery.tick();await make().tick();assert.equal(calls.upload,1);assert.equal(recovery.list()[0].stage,'manual');assert.equal(recovery.list()[0].error,'document_upload_unknown');
});
test('unknown attachment response retains the verified local original and never repeats POST',async t=>{
 const {recovery,calls,make,store}=setup(t,{attach:async()=>{calls.attach++;throw Error('500 after action resolved');}});recovery.queueReceipt(receipt);await recovery.tick();await recovery.tick();await recovery.tick();await make().tick();assert.equal(calls.attach,1);assert.equal(recovery.list()[0].error,'document_attach_unknown');assert.equal(store.get('document-source:'+taskId).sha256,sha256);
});
test('source checksum failure and source edits block uploads without leaking provider errors',async t=>{
 let active=true;const {recovery,calls,root}=setup(t,{isSourceActive:()=>active});recovery.queueReceipt(receipt);await recovery.tick();active=false;await recovery.tick();assert.equal(calls.upload,0);assert.equal(recovery.list()[0].error,'document_source_edited');
});
test('an already attached verified private receipt seed prevents duplicate acquisition',async t=>{
 const {recovery,calls,root}=setup(t);const sourcePath=path.join(root,sha256+'-招标文件正文.pdf');fs.writeFileSync(sourcePath,bytes);
 recovery.seedAttached({taskId,actionId,sourceUrl,sourcePath,sha256,documentId:'verified-doc',documentVersion:1});recovery.queueReceipt(receipt);await recovery.tick();assert.deepEqual(calls,{download:0,upload:0,sign:0,attach:0});assert.equal(recovery.list()[0].stage,'attached');
});
test('restart during remote write and lease loss after upload remain ambiguous, never repeated',async t=>{
 let owned=true;const {recovery,store,calls,make}=setup(t,{assertOwnership:()=>{if(!owned)throw Error('lease_lost');},storage:{upload:async()=>{calls.upload++;owned=false;return {remotePath:'/stored.pdf'};},sign:()=>assert.fail()}});
 recovery.queueReceipt(receipt);await recovery.tick();await assert.rejects(recovery.tick(),/lease_lost/);assert.equal(recovery.list()[0].stage,'uploading');owned=true;await make().tick();assert.equal(recovery.list()[0].stage,'manual');assert.equal(calls.upload,1);
});
test('local file tampering blocks before upload and aborted ticks do not perform side effects',async t=>{
 const {recovery,calls}=setup(t);recovery.queueReceipt(receipt);await recovery.tick();fs.appendFileSync(recovery.list()[0].sourcePath,'changed');await recovery.tick();assert.equal(recovery.list()[0].error,'document_local_invalid');assert.equal(calls.upload,0);
 const controller=new AbortController();controller.abort();await recovery.tick({signal:controller.signal});assert.equal(calls.attach,0);
});
test('Miaoda adapter honors observed success envelope, user profile, relative local path and absolute CLI',async()=>{
 const calls=[],options={cliPath:'C:/fixed/lark-cli.exe',appId:'app_17agc8m97f2',profile:'authorized-user'};
 const storage=createAppStorage(options,{runImpl:async(exe,args,opts)=>{calls.push({exe,args,opts});return {stdout:JSON.stringify({ok:true,data:args.includes('+file-upload')?{path:'/remote.pdf',download_url:'ignored'}:{signed_url:'https://files.example/x?signature=private',expires_at:'later'}})};}});
 assert.deepEqual(await storage.upload({sourcePath:'C:/local documents/file.pdf'}),{remotePath:'/remote.pdf'});assert.deepEqual(await storage.sign({remotePath:'/remote.pdf'}),{url:'https://files.example/x?signature=private'});
 assert.equal(calls[0].exe,options.cliPath);assert.equal(calls[0].args[calls[0].args.indexOf('--file')+1],'./file.pdf');assert.equal(calls[0].args[calls[0].args.indexOf('--as')+1],'user');assert.equal(calls[0].args[calls[0].args.indexOf('--profile')+1],options.profile);assert.equal(calls[0].opts.windowsHide,true);
});
test('oversized local originals are rejected by stat before any byte read, including existing download destinations',async t=>{
 const {recovery,root,calls}=setup(t);const sourcePath=path.join(root,sha256+'-招标文件正文.pdf'),fd=fs.openSync(sourcePath,'w');fs.ftruncateSync(fd,20*1024*1024+1);fs.closeSync(fd);
 let reads=0;const originalRead=fs.readSync;fs.readSync=(...args)=>{reads++;return originalRead(...args);};
 try{assert.throws(()=>recovery.seedAttached({taskId,actionId,sourceUrl,sourcePath,sha256,documentId:'doc'}),/document_local_invalid/);assert.equal(reads,0);recovery.queueReceipt(receipt);await recovery.tick();assert.equal(reads,0);assert.equal(recovery.list()[0].error,'document_local_invalid');assert.equal(calls.upload,0);}finally{fs.readSync=originalRead;}
});
test('seed source identity and replay backfill preserve editing isolation without reopening inactive watches',async t=>{
 let active=false;const {recovery,store,root}=setup(t,{isSourceActive:job=>active&&job.sourceInboxId==='source-inbox'});const sourcePath=path.join(root,sha256+'-招标文件正文.pdf');fs.writeFileSync(sourcePath,bytes);
 const seeded=recovery.seedAttached({taskId,actionId,sourceUrl,sourcePath,sha256,documentId:'doc',sourceInboxId:'source-inbox'});assert.equal(seeded.sourceInboxId,'source-inbox');assert.equal(store.listWatches(Infinity).length,0);
 const existing={...seeded};delete existing.sourceInboxId;store.set('document-recovery-job:'+seeded.id,existing);recovery.queueReceipt(receipt,{inboxId:'source-inbox'});assert.equal(recovery.list()[0].sourceInboxId,'source-inbox');assert.equal(store.listWatches(Infinity).length,0);
 active=true;recovery.seedAttached({...seeded,sourceInboxId:'source-inbox'});assert.equal(store.listWatches(Infinity)[0].payload.sourceInboxId,'source-inbox');
});

test('partial announcement attachment stays monitored without binding writing source, then upgrades once',async t=>{
 let now=1000,index=0;const partial=Buffer.from('%PDF-1.7\npublic requirement\n%%EOF'),partialSha=hashBytes(partial),full=Buffer.from('%PDF-1.7\ncomplete tender\n%%EOF'),fullSha=hashBytes(full),categories=[];
 const results=[
  {status:'partial_obtained',bytes:partial,fileName:'采购需求-公告附件-非完整招标文件.pdf',sha256:partialSha,sourceUrl,officialCategory:'announcement_attachment'},
  {status:'partial_obtained',bytes:partial,fileName:'采购需求-公告附件-非完整招标文件.pdf',sha256:partialSha,sourceUrl,officialCategory:'announcement_attachment'},
  {status:'obtained',bytes:full,fileName:'项目-招标文件正文.pdf',sha256:fullSha,sourceUrl},
 ];
 const {recovery,make,store,calls}=setup(t,{clock:()=>now,provider:{recover:async()=>{calls.download++;return results[Math.min(index++,results.length-1)];}},attach:async input=>{calls.attach++;categories.push(input.body.candidate.officialCategory);return {acquisition:{status:'acquired',documentId:'document-'+calls.attach,documentVersion:calls.attach},report:{}};}});
 recovery.queueReceipt(receipt);
 await recovery.tick();await make().tick();await make().tick();
 assert.equal(recovery.list()[0].stage,'monitoring');
 assert.deepEqual(categories,['announcement_attachment']);
 assert.equal(store.get('document-source:'+taskId),null);
 assert.equal(store.listWatches(Infinity).length,0);
 now=recovery.list()[0].nextAt;await make().tick();
 assert.equal(recovery.list()[0].stage,'monitoring');assert.equal(calls.upload,1);assert.equal(calls.attach,1);
 now=recovery.list()[0].nextAt;await make().tick();
 assert.equal(recovery.list()[0].stage,'downloaded');assert.equal(recovery.list()[0].sha256,fullSha);
 await make().tick();await make().tick();
 assert.equal(recovery.list()[0].stage,'attached');
 assert.deepEqual(categories,['announcement_attachment','tender_document']);
 assert.equal(store.get('document-source:'+taskId).sha256,fullSha);
 assert.equal(calls.upload,2);assert.equal(calls.attach,2);
});

test('monitoring retries provider reads only and never repeats a partial remote write',async t=>{
 let now=1000,index=0;const partial=Buffer.from('%PDF-1.7\npublic requirement\n%%EOF'),partialSha=hashBytes(partial);
 const sequence=[{status:'partial_obtained',bytes:partial,fileName:'采购需求-公告附件-非完整招标文件.pdf',sha256:partialSha,sourceUrl,officialCategory:'announcement_attachment'},{status:'manual',reason:'source_request_failed',sourceUrl}];
 const {recovery,make,calls}=setup(t,{clock:()=>now,provider:{recover:async()=>{calls.download++;return sequence[Math.min(index++,sequence.length-1)];}}});
 recovery.queueReceipt(receipt);await recovery.tick();await make().tick();await make().tick();
 now=recovery.list()[0].nextAt;await make().tick();
 assert.equal(recovery.list()[0].stage,'monitoring');assert.equal(recovery.list()[0].error,'source_request_failed');
 assert.equal(calls.upload,1);assert.equal(calls.attach,1);
});

function hashBytes(value){return createHash('sha256').update(value).digest('hex');}
