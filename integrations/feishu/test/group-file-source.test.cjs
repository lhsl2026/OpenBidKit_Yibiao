'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {createStore}=require('../store.cjs');
const {buildGroupFileStatusCard,createFileDownloader,createGroupFileSource,historyArguments,inspectLocalFile,matchWaitingTask,normalizeFileMessage}=require('../group-file-source.cjs');

const input={id:'job',companyId:'隆创信息有限公司',chatId:'chat',messageId:'message',senderId:'sender',createTime:'1785190080000',fileName:'招标文件.pdf',fileKey:'file_key',replyTo:null};

test('file jobs deduplicate messages and reject conflicting identity',t=>{
 const store=createStore(':memory:');t.after(()=>store.close());
 assert.equal(store.receiveGroupFile(input,1000).stage,'discovered');
 assert.equal(store.receiveGroupFile(input,2000).id,'job');
 assert.throws(()=>store.receiveGroupFile({...input,fileKey:'different'},2000),/group_file_conflict/);
 assert.equal(store.db.prepare('SELECT COUNT(*) count FROM group_file_jobs').get().count,1);
});

test('stage changes use compare and set and hash lookup is company scoped',t=>{
 const store=createStore(':memory:');t.after(()=>store.close());
 store.receiveGroupFile(input,1);
 assert.equal(store.updateGroupFileJob('job','discovered',{stage:'downloaded',sha256:'a'.repeat(64),sourcePath:'C:/safe/a.pdf'},2).stage,'downloaded');
 assert.throws(()=>store.updateGroupFileJob('job','discovered',{stage:'uploaded'},3),/group_file_stage_conflict/);
 assert.equal(store.findGroupFileByHash('隆创信息有限公司','a'.repeat(64)).id,'job');
 assert.equal(store.findGroupFileByHash('另一家公司','a'.repeat(64)),null);
});

test('status outbox keeps one row per revision and preserves the stable create id',t=>{
 const store=createStore(':memory:');t.after(()=>store.close());store.receiveGroupFile(input,1);
 const first=store.enqueueGroupFileStatus('job',{schema:'2.0',body:{elements:[]}},2);const duplicate=store.enqueueGroupFileStatus('job',{schema:'2.0',body:{elements:[]}},3);
 assert.equal(first.id,duplicate.id);assert.equal(store.listGroupFileStatus(3).length,1);
 const changed=store.enqueueGroupFileStatus('job',{schema:'2.0',body:{elements:[{tag:'markdown',content:'处理中'}]}},4);
 assert.notEqual(changed.id,first.id);assert.equal(store.getGroupFileJob('job').statusRevision,2);
 assert.equal(store.getGroupFileJob('job').statusCreateId,store.getGroupFileJob('job').statusCreateId);
});

const historyMessage={chat_id:'decision',message_id:'om_file',msg_type:'file',create_time:'2026-09-16 09:30',content:'[File: 招标文件.pdf](file_key)',sender:{sender_type:'user',id:'ou_member'},parent_id:'om_parent'};
const sourceConfig={chatId:'decision',companyId:'隆创信息有限公司',groupFileSource:{enabled:true,profile:'decision-user',allowedExtensions:['pdf','doc','docx'],startAt:'2026-09-16T00:00:00+08:00',maxBytes:31457280}};

test('history messages accept only supported files from human members of the active group',()=>{
 const event=normalizeFileMessage(historyMessage,sourceConfig);assert.equal(event.fileName,'招标文件.pdf');assert.equal(event.fileKey,'file_key');assert.equal(event.replyTo,'om_parent');
 assert.equal(normalizeFileMessage({...historyMessage,chat_id:'other'},sourceConfig),null);assert.equal(normalizeFileMessage({...historyMessage,sender:{sender_type:'bot',id:'bot'}},sourceConfig),null);assert.equal(normalizeFileMessage({...historyMessage,msg_type:'text'},sourceConfig),null);assert.equal(normalizeFileMessage({...historyMessage,create_time:'2026-09-15 23:59'},sourceConfig),null);
 const args=historyArguments({chatId:'decision',start:0,end:1000,profile:'decision-user'});assert.equal(args[args.indexOf('--as')+1],'user');assert.equal(args[args.indexOf('--profile')+1],'decision-user');assert.equal(args[args.indexOf('--chat-id')+1],'decision');
});

test('history messages accept the XML file descriptor returned by the real CLI',()=>{
 const event=normalizeFileMessage({...historyMessage,content:'<file key="file_v3_example-key" name="采购文件.pdf"/>'},sourceConfig);
 assert.equal(event.fileName,'采购文件.pdf');
 assert.equal(event.fileKey,'file_v3_example-key');
});

test('history polling persists a fixed paginated window and never advances on failure',async t=>{
 const store=createStore(':memory:');t.after(()=>store.close());let now=Date.parse('2026-09-16T10:00:00+08:00'),page=0;
 const source=createGroupFileSource({store,config:sourceConfig,clock:()=>now,fetchPage:async()=>({ok:true,data:{messages:[{...historyMessage,message_id:'om_'+(++page)}],has_more:page===1,page_token:page===1?'next':''}})});
 await source.poll();assert.equal(store.get('group-file-source:decision').window.token,'next');now+=5000;await source.poll();assert.equal(store.get('group-file-source:decision').cursor,Date.parse('2026-09-16T10:00:00+08:00'));assert.equal(store.db.prepare('SELECT COUNT(*) count FROM group_file_jobs').get().count,2);
 now+=60000;const failed=createGroupFileSource({store,config:sourceConfig,clock:()=>now,fetchPage:async()=>({ok:false,error:{private:'hidden'}})});await failed.poll();const state=store.get('group-file-source:decision');assert.equal(state.cursor,Date.parse('2026-09-16T10:00:00+08:00'));assert.equal(state.error,'group_file_history_unavailable');assert.equal(JSON.stringify(state).includes('hidden'),false);
});

test('local inspection validates path, size, extension and file signature',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'openbidkit-group-file-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const pdfBytes=Buffer.from('%PDF-1.7\nbody'),pdf=path.join(root,'source.pdf');fs.writeFileSync(pdf,pdfBytes);
 const inspected=inspectLocalFile({filePath:pdf,fileName:'招标文件.pdf',maxBytes:1024,allowedExtensions:['pdf','doc','docx'],root});assert.equal(inspected.sha256,createHash('sha256').update(pdfBytes).digest('hex'));assert.equal(inspected.extension,'.pdf');
 assert.throws(()=>inspectLocalFile({filePath:pdf,fileName:'../escape.pdf',maxBytes:1024,allowedExtensions:['pdf'],root}),/group_file_name_invalid/);
 assert.throws(()=>inspectLocalFile({filePath:pdf,fileName:'fake.docx',maxBytes:1024,allowedExtensions:['docx'],root}),/group_file_content_invalid/);
 const doc=path.join(root,'source.doc');fs.writeFileSync(doc,Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1,1]));assert.equal(inspectLocalFile({filePath:doc,fileName:'a.doc',maxBytes:1024,allowedExtensions:['doc'],root}).extension,'.doc');
 const docx=path.join(root,'source.docx');fs.writeFileSync(docx,Buffer.concat([Buffer.from([0x50,0x4b,0x03,0x04]),Buffer.from('[Content_Types].xml word/document.xml')]));assert.equal(inspectLocalFile({filePath:docx,fileName:'a.docx',maxBytes:1024,allowedExtensions:['docx'],root}).extension,'.docx');
 assert.throws(()=>inspectLocalFile({filePath:pdf,fileName:'a.pdf',maxBytes:4,allowedExtensions:['pdf'],root}),/group_file_too_large/);
});

test('message resources download through the user profile into a content-addressed object',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'openbidkit-group-download-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));let invocation;
 const downloader=createFileDownloader({cliPath:process.execPath,profile:'decision-user',root,maxBytes:1024,allowedExtensions:['pdf']},{runImpl:async(_executable,args,options)=>{invocation={args,options};const output=args[args.indexOf('--output')+1];const target=path.resolve(options.cwd,output);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,Buffer.from('%PDF-1.7\ndownload'));return {stdout:'{"ok":true,"data":{}}'};}});
 const result=await downloader.download({id:'job',messageId:'om_file',fileKey:'file_key',fileName:'招标文件.pdf'});
 assert.equal(invocation.args[invocation.args.indexOf('--as')+1],'user');assert.equal(invocation.args[invocation.args.indexOf('--profile')+1],'decision-user');assert.equal(invocation.args[invocation.args.indexOf('--message-id')+1],'om_file');assert.equal(invocation.args[invocation.args.indexOf('--file-key')+1],'file_key');
 assert.equal(path.dirname(result.sourcePath),path.join(root,'objects'));assert.equal(fs.existsSync(result.sourcePath),true);assert.equal(path.basename(result.sourcePath),result.sha256+'.pdf');
});

test('waiting-task matching prefers an exact card reply and never guesses among title candidates',()=>{
 const direct={taskId:'t1',manualActionId:'a1',title:'A项目',statusCardMessageId:'om_parent'};
 assert.deepEqual(matchWaitingTask({job:{replyTo:'om_parent',fileName:'任意名称.pdf'},candidates:[direct]}),{status:'unique',candidate:direct,mode:'reply'});
 const unique={taskId:'t2',manualActionId:'a2',title:'钟山区人民医院采购项目',statusCardMessageId:null};
 assert.deepEqual(matchWaitingTask({job:{replyTo:null,fileName:'钟山区人民医院采购项目招标文件.pdf'},candidates:[unique]}),{status:'unique',candidate:unique,mode:'title'});
 assert.equal(matchWaitingTask({job:{replyTo:null,fileName:'A项目二标段招标文件.pdf'},candidates:[{taskId:'t1',title:'A项目二标段'},{taskId:'t2',title:'A项目二标段补充'}]}).status,'ambiguous');
 assert.deepEqual(matchWaitingTask({job:{replyTo:null,fileName:'招标文件正文.pdf'},candidates:[unique]}),{status:'none'});
 assert.deepEqual(matchWaitingTask({job:{replyTo:null,fileName:'完全不同项目.pdf'},candidates:[unique]}),{status:'none'});
});

function stateSetup(t,{candidates=[],response,uploadError=false,attachError=false,reconciliationResponse={status:'missing'}}={}){
 const store=createStore(':memory:');t.after(()=>store.close());let now=1000;const calls={download:0,upload:0,sign:0,submit:0,attach:0,reconcile:0};let submitted;
 const config={...sourceConfig,groupFileSource:{...sourceConfig.groupFileSource,root:'C:/group-files',appId:'app_17agc8m97f2',cliPath:process.execPath}};
 const source=createGroupFileSource({store,config,clock:()=>now,downloader:{download:async()=>{calls.download++;return {sha256:'b'.repeat(64),size:20,extension:'.pdf',sourcePath:'C:/group-files/objects/'+('b'.repeat(64))+'.pdf'};}},storage:{upload:async()=>{calls.upload++;if(uploadError)throw Error('unknown');return {remotePath:'/group/file.pdf'};},sign:async()=>{calls.sign++;return {url:'https://files.example/group.pdf?private=1'};}},preread:{receiveGroupFile:async body=>{calls.submit++;submitted=body;return response??{status:'processed',results:[{status:'triggered',taskId:'new-task'}]};},attachManualDocument:async(taskId,body)=>{calls.attach++;submitted={taskId,body};if(attachError)throw Error('unknown');return {acquisition:{status:'acquired',documentId:'doc',documentVersion:1}};},reconcileManualDocument:async(taskId,sha256)=>{calls.reconcile++;return {...reconciliationResponse,taskId,sha256};}},waitingCandidates:()=>candidates});
 const job=store.receiveGroupFile({...input,id:'new-job',messageId:'new-message',fileName:'钟山区人民医院采购项目招标文件.pdf'},now);return {store,source,job,calls,submitted:()=>submitted,advance:(milliseconds=1000)=>{now+=milliseconds;}};
}

test('a new file uploads once and submits one stable group-file event before watching',async t=>{
 const {store,source,calls,submitted,advance}=stateSetup(t);await source.tick();advance();await source.tick();advance();await source.tick();advance();await source.tick();
 assert.deepEqual(calls,{download:1,upload:1,sign:1,submit:1,attach:0,reconcile:0});const job=store.getGroupFileJob('new-job');assert.equal(job.stage,'watching');assert.equal(job.taskId,'new-task');assert.equal(submitted().eventId,'openbidkit-group-file-new-job');assert.equal(submitted().candidate.fileName,'钟山区人民医院采购项目招标文件.pdf');assert.equal(submitted().candidate.sha256,'b'.repeat(64));assert.deepEqual(store.getWatch('new-task').payload,{companyId:'隆创信息有限公司',sourceInboxId:'group-file:new-job',sourceGroupFileId:'new-job',sourcePath:'C:/group-files/objects/'+('b'.repeat(64))+'.pdf',sourceChecksum:'b'.repeat(64)});
});

test('a uniquely matched waiting task attaches instead of creating another preread task',async t=>{
 const candidate={taskId:'waiting-task',manualActionId:'manual-action',title:'钟山区人民医院采购项目',statusCardMessageId:null};const {store,source,calls,submitted,advance}=stateSetup(t,{candidates:[candidate]});
 await source.tick();advance();await source.tick();advance();await source.tick();advance();await source.tick();
 assert.equal(calls.submit,0);assert.equal(calls.attach,1);assert.equal(submitted().taskId,'waiting-task');assert.equal(submitted().body.manualActionId,'manual-action');assert.equal(submitted().body.candidate.officialCategory,'tender_document');assert.equal(store.getGroupFileJob('new-job').stage,'watching');
 assert.deepEqual(store.getWatch('waiting-task').payload,{companyId:'隆创信息有限公司',sourceGroupFileId:'new-job',sourcePath:'C:/group-files/objects/'+('b'.repeat(64))+'.pdf',sourceChecksum:'b'.repeat(64)});
});

test('an uncertain manual attachment reconciles by task and sha without repeating the post',async t=>{
 const candidate={taskId:'waiting-task',manualActionId:'manual-action',title:'钟山区人民医院采购项目',statusCardMessageId:null};
 const {store,source,calls,advance}=stateSetup(t,{candidates:[candidate],attachError:true,reconciliationResponse:{status:'attached',documentId:'doc-2',documentVersion:2,parseStatus:'parsing'}});
 await source.tick();advance();await source.tick();advance();await source.tick();advance();await source.tick();
 assert.equal(store.getGroupFileJob('new-job').stage,'reconciling');
 advance(60000);await source.tick();
 assert.equal(store.getGroupFileJob('new-job').stage,'watching');
 assert.equal(calls.attach,1);assert.equal(calls.reconcile,1);assert.equal(calls.submit,0);
 assert.deepEqual(store.getWatch('waiting-task').payload,{companyId:'隆创信息有限公司',sourceGroupFileId:'new-job',sourcePath:'C:/group-files/objects/'+('b'.repeat(64))+'.pdf',sourceChecksum:'b'.repeat(64)});
});

test('ambiguous matches wait for selection before upload and interrupted remote writes fail closed',async t=>{
 const candidates=[{taskId:'one',manualActionId:'a1',title:'钟山区人民医院采购项目一'},{taskId:'two',manualActionId:'a2',title:'钟山区人民医院采购项目二'}];const ambiguous=stateSetup(t,{candidates});ambiguous.store.updateGroupFileJob('new-job','discovered',{stage:'downloaded',sha256:'c'.repeat(64),sourcePath:'C:/group-files/c.pdf',fileSize:1},1001);await ambiguous.source.tick();assert.equal(ambiguous.store.getGroupFileJob('new-job').stage,'waiting_selection');assert.equal(ambiguous.calls.upload,0);
 const uncertain=stateSetup(t,{uploadError:true});await uncertain.source.tick();uncertain.advance();await uncertain.source.tick();uncertain.advance();await uncertain.source.tick();assert.equal(uncertain.store.getGroupFileJob('new-job').stage,'manual_review');assert.equal(uncertain.calls.upload,1);
});

test('a repeated file reuses the canonical completed task without upload or model submission',async t=>{
 const {store,source,calls}=stateSetup(t);store.receiveGroupFile({...input,id:'canonical',messageId:'canonical-message'},1);store.updateGroupFileJob('canonical','discovered',{stage:'downloaded',sha256:'b'.repeat(64),sourcePath:'C:/group-files/canonical.pdf',fileSize:20,taskId:'canonical-task'},2);store.updateGroupFileJob('canonical','downloaded',{stage:'completed'},3);
 await source.tick();const repeated=store.getGroupFileJob('new-job');assert.equal(repeated.stage,'completed');assert.equal(repeated.canonicalJobId,'canonical');assert.equal(repeated.taskId,'canonical-task');assert.deepEqual(calls,{download:1,upload:0,sign:0,submit:0,attach:0,reconcile:0});
});

test('a completed group file schedules one visible card rebind when the existing project card predates the file',async t=>{
 const {store,source}=stateSetup(t);const fileTime=Number(input.createTime);
 store.saveProject({id:'existing-project',taskId:'existing-task',companyId:'隆创信息有限公司',version:'1',checksum:'b'.repeat(64),generatedAt:'2026-09-21T03:30:00Z',input:{handoff:{task:{title:'既有项目'},requirements:[]}},assessment:{decision:'review'},messageId:'om_old_card',created:fileTime+1000,revision:1});
 const project=store.getProject('existing-project'),stream=store.messageStream(project,'chat');store.attemptStream(stream.id,fileTime-1);
 store.updateGroupFileJob('new-job','discovered',{stage:'watching',taskId:'existing-task',sha256:'b'.repeat(64),sourcePath:'C:/group-files/objects/'+('b'.repeat(64))+'.pdf'},1001);
 await source.tick();
 assert.equal(store.getGroupFileJob('new-job').stage,'completed');
 const rebind=store.getPendingCardRebind('existing-project','chat');
 assert.equal(rebind.source_job_id,'new-job');assert.equal(rebind.old_message_id,'om_old_card');
 await source.tick();
 assert.equal(store.db.prepare('SELECT COUNT(*) count FROM card_rebindings').get().count,1);
});

test('a completed group file does not rebind a project card created for the same or a later intake',async t=>{
 const {store,source}=stateSetup(t);const fileTime=Number(input.createTime);
 store.saveProject({id:'current-project',taskId:'current-task',companyId:'隆创信息有限公司',version:'1',checksum:'b'.repeat(64),generatedAt:'2026-09-21T03:30:00Z',input:{handoff:{task:{title:'当前项目'},requirements:[]}},assessment:{decision:'review'},messageId:'om_current_card',created:fileTime-1000,revision:1});
 const project=store.getProject('current-project'),stream=store.messageStream(project,'chat');store.attemptStream(stream.id,fileTime);
 store.updateGroupFileJob('new-job','discovered',{stage:'watching',taskId:'current-task',sha256:'b'.repeat(64),sourcePath:'C:/group-files/objects/'+('b'.repeat(64))+'.pdf'},1001);
 await source.tick();
 assert.equal(store.getGroupFileJob('new-job').stage,'completed');
 assert.equal(store.getPendingCardRebind('current-project','chat'),null);
 assert.equal(store.db.prepare('SELECT COUNT(*) count FROM card_rebindings').get().count,0);
});

test('status cards use fixed safe copy and ambiguous matches expose bounded callbacks',()=>{
 const received=buildGroupFileStatusCard({id:'a'.repeat(40),fileName:'<at id=all>项目.pdf</at>',stage:'discovered',statusRevision:1,errorCode:null,candidates:null});const receivedText=JSON.stringify(received);assert.equal(received.schema,'2.0');assert.match(receivedText,/已收到招标文件，正在下载并校验/);assert.doesNotMatch(receivedText,/<at/);
 const waiting=buildGroupFileStatusCard({id:'a'.repeat(40),fileName:'项目.pdf',stage:'waiting_selection',statusRevision:2,errorCode:'group_file_selection_required',candidates:[{taskId:'task-1',title:'项目一',manualActionId:'action-1'},{taskId:'task-2',title:'项目二',manualActionId:'action-2'}]});const callbacks=waiting.body.elements.filter(element=>element.tag==='button').map(element=>element.behaviors[0].value);assert.equal(callbacks.length,2);assert.deepEqual(callbacks[0],{action:'preread.select_task',jobId:'a'.repeat(40),taskId:'task-1',revision:2});
 const failed=JSON.stringify(buildGroupFileStatusCard({id:'a'.repeat(40),fileName:'项目.pdf',stage:'failed',statusRevision:3,errorCode:'group_file_too_large'}));assert.match(failed,/文件超过 30 MiB/);for(const secret of ['C:\\','file_key','https://signed','a'.repeat(64)])assert.equal(failed.includes(secret),false);
});

test('manual task selection is authorized, revisioned and idempotent',async t=>{
 const candidates=[{taskId:'one',manualActionId:'a1',title:'钟山区人民医院采购项目一'},{taskId:'two',manualActionId:'a2',title:'钟山区人民医院采购项目二'}];const {store,source}=stateSetup(t,{candidates});store.updateGroupFileJob('new-job','discovered',{stage:'downloaded',sha256:'d'.repeat(64),sourcePath:'C:/group-files/d.pdf',fileSize:1},1001);await source.tick();const waiting=store.getGroupFileJob('new-job');store.bindGroupFileStatus(waiting.id,'om_status');
 const value={agent:'openbidkit-group-file',action:'select_task',jobId:waiting.id,taskId:'two',revision:waiting.statusRevision},event={eventId:'evt-select',actorId:waiting.senderId,chatId:waiting.chatId,messageId:'om_status'};
 assert.deepEqual(await source.select(value,event),{status:'selected',jobId:'new-job',taskId:'two'});assert.deepEqual(await source.select(value,event),{status:'selected',jobId:'new-job',taskId:'two'});const selected=store.getGroupFileJob('new-job');assert.equal(selected.stage,'ready_upload');assert.equal(selected.manualActionId,'a2');await assert.rejects(source.select({...value,taskId:'one'},{...event,eventId:'evt-forged',actorId:'outsider'}),/group_file_selection/);
});
