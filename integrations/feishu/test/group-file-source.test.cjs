'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {createStore}=require('../store.cjs');
const {createFileDownloader,createGroupFileSource,historyArguments,inspectLocalFile,normalizeFileMessage}=require('../group-file-source.cjs');

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
