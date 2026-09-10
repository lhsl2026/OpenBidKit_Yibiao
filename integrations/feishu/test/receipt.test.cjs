const {test}=require('node:test');const assert=require('node:assert/strict');
const {createStore}=require('../store.cjs');
const {recordReceipt}=require('../receipt.cjs');

function inbox(store,id){store.receiveRadar(id,{messageId:'m',chatId:'source',messageType:'text',content:'daily'});}

test('processed receipt is preserved atomically and only triggered tasks become watches',()=>{
 const store=createStore(':memory:');const id='inbox-processed';inbox(store,id);
 const response={status:'processed',actionId:'action-1',acquisition:{source:'lark'},results:[{status:'triggered',eventId:'event-1',taskId:'task-1',acquisition:{mode:'automatic'}},{status:'waiting_confirmation',eventId:'event-2',acquisition:{mode:'manual'}}]};
 recordReceipt({store,inboxId:id,response,companyId:'company',now:100});
 assert.deepEqual(store.get('radar-receipt:'+id),response);
 assert.deepEqual(store.listWatches(Infinity).map(row=>row.task_id),['task-1']);
 assert.equal(store.db.prepare('SELECT delivered FROM inbox WHERE id=?').get(id).delivered,1);
 store.close();
});

test('selection receipt reads only validated selection results and rejected selections add no watches',()=>{
 const store=createStore(':memory:');inbox(store,'selected');inbox(store,'rejected');
 recordReceipt({store,inboxId:'selected',response:{status:'selection_processed',messageId:'m',selection:{status:'processed',actionId:'select-1',results:[{status:'triggered',taskId:'task-selected'}]}},companyId:'company',now:100});
 recordReceipt({store,inboxId:'rejected',response:{status:'selection_rejected',selection:{status:'rejected',results:[{status:'triggered',taskId:'must-not-watch'}]}},companyId:'company',now:100});
 assert.deepEqual(store.listWatches(Infinity).map(row=>row.task_id),['task-selected']);
 assert.equal(store.db.prepare('SELECT delivered FROM inbox WHERE id=?').get('selected').delivered,1);
 assert.equal(store.db.prepare('SELECT delivered FROM inbox WHERE id=?').get('rejected').delivered,1);
 store.close();
});

test('pure processing receipt remains pending without losing the complete response',()=>{
 const store=createStore(':memory:');const id='pending';inbox(store,id);
 const response={status:'processed',actionId:'pending-action',results:[{status:'processing',eventId:'event-pending',acquisition:{stage:'download'}}]};
 const recorded=recordReceipt({store,inboxId:id,response,companyId:'company',now:500});
 assert.equal(recorded.pending,true);assert.deepEqual(store.get('radar-receipt:'+id),response);
 const row=store.db.prepare('SELECT delivered,next_at FROM inbox WHERE id=?').get(id);assert.equal(row.delivered,0);assert.equal(row.next_at,60500);
 store.close();
});

test('a mixed triggered and processing receipt registers the task but keeps the inbox pending',()=>{
 const store=createStore(':memory:');const id='mixed-pending';inbox(store,id);
 const response={status:'processed',results:[{status:'triggered',taskId:'ready-task'},{status:'processing',eventId:'still-running'}]};
 const recorded=recordReceipt({store,inboxId:id,response,companyId:'company',now:800});
 assert.equal(recorded.pending,true);assert.deepEqual(store.listWatches(Infinity).map(row=>row.task_id),['ready-task']);
 const row=store.db.prepare('SELECT delivered,next_at FROM inbox WHERE id=?').get(id);assert.equal(row.delivered,0);assert.equal(row.next_at,60800);
 store.close();
});

test('unsupported receipt status rolls back every local side effect',()=>{
 const store=createStore(':memory:');const id='bad';inbox(store,id);
 assert.throws(()=>recordReceipt({store,inboxId:id,response:{status:'processed',results:[{status:'invented',taskId:'unsafe'}]},companyId:'company',now:0}),/receipt|status/);
 assert.equal(store.get('radar-receipt:'+id),null);assert.equal(store.listWatches(Infinity).length,0);
 assert.equal(store.db.prepare('SELECT delivered FROM inbox WHERE id=?').get(id).delivered,0);
 store.close();
});
