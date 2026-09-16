'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createStore}=require('../store.cjs');

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
