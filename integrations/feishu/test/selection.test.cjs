const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {createStore}=require('../store.cjs');
const {createSelection}=require('../selection.cjs');
const {recordReceipt}=require('../receipt.cjs');

const ids=['123e4567-e89b-12d3-a456-426614174000','123e4567-e89b-12d3-a456-426614174001'];
const receipt={status:'processed',messageId:'om_daily',projects:[{sourceMessageId:'om_daily',title:'项目一',budgetText:'100 万元'},{sourceMessageId:'om_daily',title:'项目二'}],results:[{status:'waiting_confirmation',eventId:ids[0]},{status:'waiting_confirmation',eventId:ids[1]}]};
function setup(t,select=async()=>({status:'selection_processed',selection:{status:'processed',results:[{status:'triggered',taskId:'task-1'}]}})){
 const store=createStore(':memory:');t.after(()=>store.close());const calls=[];
 const selection=createSelection({store,config:{chatId:'oc_target',operatorIds:['ou_allowed'],companyId:'company'},preread:{select:async body=>{calls.push(body);return select(body);}},clock:()=>1000,assertOwnership:()=>{}});
 store.transaction(()=>selection.queue(receipt,{inboxId:'source-inbox'}));
 const stateRow=store.db.prepare("SELECT key,value FROM settings WHERE key LIKE 'selection:%'").get();
 const state=JSON.parse(stateRow.value);store.set('outbox-message:'+state.outboxId,'om_selection');
 return {store,selection,calls,state,stateKey:stateRow.key};
}
function event(eventId='callback-1',events=ids){return{eventId,actorId:'ou_allowed',chatId:'oc_target',messageId:'om_selection',formValue:{events}};}
function value(state,action='select'){return{agent:'openbidkit-selection',batchKey:state.batchKey,challenge:state.challenge,action};}

test('queue creates one stable Card 2.0 outbox entry and never calls preread',t=>{
 const {store,calls,state}=setup(t);assert.equal(calls.length,0);assert.match(state.batchKey,/^[a-f0-9]{40}$/);assert.match(state.challenge,/^[a-f0-9]{32}$/);
 assert.equal(state.selectionToken,createHash('sha256').update([...ids].sort().join('\n')).digest('hex').slice(0,32));
 const rows=store.listOutbox(Infinity);assert.equal(rows.length,1);assert.equal(rows[0].project_id,null);assert.equal(rows[0].id,state.outboxId);
 const card=JSON.parse(rows[0].payload);assert.equal(card.schema,'2.0');assert.equal(card.body.elements.length,3);
 assert.match(card.body.elements[0].content,/进入处理队列/);
 assert.match(card.body.elements[0].content,/第 1 步.*第 2 步/s);
 const form=card.body.elements[1],select=form.elements.find(e=>e.tag==='multi_select_static'),submit=form.elements.find(e=>e.form_action_type==='submit');
 assert.equal(form.tag,'form');assert.equal(select.name,'events');assert.deepEqual(select.options.map(o=>o.value),ids);
 assert.equal(submit.name,`selection_select_${state.batchKey}_${state.challenge}`);assert.equal('behaviors' in submit,false);
 const decline=card.body.elements[2].columns[0].elements[0];assert.deepEqual(decline.behaviors[0].value,{action:'selection.decline',batchKey:state.batchKey,challenge:state.challenge});
 store.transaction(()=>setupQueueAgain(store));assert.equal(store.listOutbox(Infinity).length,1);
 function setupQueueAgain(target){createSelection({store:target,config:{chatId:'oc_target',operatorIds:['ou_allowed'],companyId:'company'},preread:{select:()=>assert.fail('queue posted')}}).queue(receipt);}
});

test('refresh updates an existing waiting card once without creating another message',t=>{
 const {store,selection,state}=setup(t);
 store.db.prepare("UPDATE outbox SET payload='{}',delivered=1 WHERE id=?").run(state.outboxId);
 assert.equal(selection.refreshWaitingCards(),1);
 const refreshed=store.db.prepare('SELECT payload,delivered FROM outbox WHERE id=?').get(state.outboxId);
 assert.equal(refreshed.delivered,0);assert.match(JSON.parse(refreshed.payload).body.elements[0].content,/第 1 步.*第 2 步/s);
 assert.equal(selection.refreshWaitingCards(),0);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM outbox').get().n,1);
});

test('same completed callback posts once and nested selection task becomes a watch',async t=>{
 const {store,selection,calls,state}=setup(t);const first=await selection.act(value(state),event());const second=await selection.act(value(state),event());
 assert.equal(calls.length,1);assert.deepEqual(second,first);assert.deepEqual(store.listWatches(Infinity).map(r=>r.task_id),['task-1']);assert.equal(store.getWatch('task-1').payload.sourceInboxId,'source-inbox');
});

test('completed selection card keeps the selected project visible and shows document acquisition stage',async t=>{
 const response={status:'selection_processed',selection:{status:'processed',selectedProjects:[{title:'项目二'}],results:[{status:'triggered',taskId:'task-2',acquisition:{status:'waiting_upload',errorCode:'complete_tender_document_missing',actionId:'123e4567-e89b-12d3-a456-426614174099'}}]}};
 const {store,selection,state}=setup(t,async()=>response);
 await selection.act(value(state),event('selected-project-visible',[ids[1]]));
 const card=JSON.parse(store.db.prepare('SELECT payload FROM outbox WHERE id=?').get(state.outboxId).payload);
 const text=JSON.stringify(card);
 assert.equal(card.header.title.content,'已转入预读');
 assert.match(text,/选择卡已退役并移除操作按钮，后续以最新预读卡为准/);
 assert.equal(text.includes('"tag":"button"'),false);
 assert.match(text,/项目二/);
 assert.match(text,/正在获取招标文件/);
 assert.doesNotMatch(text,/项目一/);
});

test('startup refresh upgrades an already completed selection card without creating another message',async t=>{
 const response={status:'selection_processed',selection:{status:'processed',selectedProjects:[{title:'项目二'}],results:[{status:'triggered',taskId:'task-2',acquisition:{status:'waiting_upload',errorCode:'complete_tender_document_missing',actionId:'123e4567-e89b-12d3-a456-426614174099'}}]}};
 const {store,selection,state}=setup(t,async()=>response);
 await selection.act(value(state),event('selected-project-refresh',[ids[1]]));
 store.db.prepare("UPDATE outbox SET payload='{}',delivered=1 WHERE id=?").run(state.outboxId);
 assert.equal(selection.refreshWaitingCards(),1);
 const card=JSON.parse(store.db.prepare('SELECT payload FROM outbox WHERE id=?').get(state.outboxId).payload);
 assert.match(JSON.stringify(card),/项目二/);
 assert.match(JSON.stringify(card),/正在获取招标文件/);
 assert.equal(store.db.prepare('SELECT COUNT(*) n FROM outbox').get().n,1);
});

test('startup refresh never requeues a selection card from a retired or forbidden chat',t=>{
 const store=createStore(':memory:');t.after(()=>store.close());
 const legacy=createSelection({store,config:{chatId:'oc_retired',allowedChats:['oc_retired'],forbiddenChats:[],operatorIds:['ou_allowed'],companyId:'company'},preread:{select:()=>assert.fail('posted')}});
 const state=store.transaction(()=>legacy.queue(receipt,{inboxId:'legacy-source'}));
 store.db.prepare("UPDATE outbox SET payload='{}',delivered=1 WHERE id=?").run(state.outboxId);
 const current=createSelection({store,config:{chatId:'oc_target',allowedChats:['oc_target'],forbiddenChats:['oc_retired'],operatorIds:['ou_allowed'],companyId:'company'},preread:{select:()=>assert.fail('posted')}});
 assert.equal(current.refreshWaitingCards(),0);
 const row=store.db.prepare('SELECT payload,delivered FROM outbox WHERE id=?').get(state.outboxId);assert.equal(row.payload,'{}');assert.equal(row.delivered,1);
});

test('identity, message, challenge, token integrity and selection subset fail before POST',async t=>{
 const {store,selection,calls,state,stateKey}=setup(t);const attempts=[
  [value(state),{...event(),actorId:'ou_other'}],[value(state),{...event(),chatId:'oc_other'}],[value(state),{...event(),messageId:'om_other'}],
  [{...value(state),challenge:'0'.repeat(32)},event()],[value(state),event('bad-subset',[ids[0],'123e4567-e89b-12d3-a456-426614174099'])],[value(state),event('empty',[])]
 ];
 for(const [v,e] of attempts)await assert.rejects(selection.act(v,e));
 store.set(stateKey,{...state,selectionToken:'0'.repeat(32)});await assert.rejects(selection.act(value(state),event('token')));
 assert.equal(calls.length,0);
});

test('API failure retries only the same event payload and then persists success',async t=>{
 let attempt=0;const {store,selection,calls,state}=setup(t,async()=>{if(attempt++===0)throw Error('down');return{status:'selection_rejected',selection:{status:'rejected'}};});
 const v=value(state,'decline'),e=event('retryable',[]);await assert.rejects(selection.act(v,e));
 await assert.rejects(selection.act(value(state,'select'),{...e,formValue:{events:[ids[0]]}}),/payload/);
 const result=await selection.act(v,e);assert.equal(result.status,'selection_rejected');assert.equal(calls.length,2);
 const card=JSON.parse(store.db.prepare('SELECT payload FROM outbox WHERE id=?').get(state.outboxId).payload);assert.doesNotMatch(JSON.stringify(card),/未选择的项目将关闭/);
 assert.deepEqual(calls[0],{eventId:'retryable',chatId:'oc_target',operatorId:'ou_allowed',batchMessageId:'om_daily',action:'decline_all_events',selectionToken:state.selectionToken});
});

test('processing keeps the original event retryable and never widens selection',async t=>{
 let attempt=0;const {selection,calls,state}=setup(t,async()=>attempt++?{status:'selection_processed',selection:{status:'processed',results:[]}}:{status:'processing'});
 const chosen=[ids[1]];const first=await selection.act(value(state),event('processing',chosen));assert.equal(first.status,'processing');
 await selection.act(value(state),event('processing',chosen));assert.equal(calls.length,2);assert.deepEqual(calls.map(c=>c.eventIds),[chosen,chosen]);assert.ok(calls.every(c=>c.action==='select_events'));
});

test('terminal batches return explicit idempotent results for new callback event IDs',async t=>{
 const selected=setup(t);await selected.selection.act(value(selected.state),event('selected-once'));
 assert.deepEqual(await selected.selection.act(value(selected.state),event('selected-replay')), {status:'already_transferred'});assert.equal(selected.calls.length,1);
 const {store,selection,calls,state,stateKey}=setup(t,async()=>({status:'selection_processed',selection:{status:'processed',selectedProjects:[],declinedProjects:[{}],results:[]}}));
 await selection.act(value(state,'decline'),event('decline',[]));assert.equal(store.get(stateKey).status,'declined');
 assert.deepEqual(await selection.act(value(state,'decline'),event('new-event',[])),{status:'already_closed'});assert.equal(calls.length,1);
});

test('an incomplete waiting-project mapping makes the whole batch manual with no card',t=>{
 const store=createStore(':memory:');t.after(()=>store.close());const selection=createSelection({store,config:{chatId:'oc_target',operatorIds:['ou_allowed'],companyId:'company'},preread:{select:()=>assert.fail('posted')}});
 const broken={...receipt,projects:[receipt.projects[0]]};const result=selection.queue(broken,{inboxId:'source'});assert.equal(result.status,'manual');assert.equal(store.listOutbox(Infinity).length,0);
});

test('a receipt for another delivery chat is held for manual repair instead of sending a broken card',t=>{
 const store=createStore(':memory:');t.after(()=>store.close());const selection=createSelection({store,config:{chatId:'oc_target',operatorIds:['ou_allowed'],companyId:'company'},preread:{select:()=>assert.fail('posted')}});
 const mismatched={...receipt,projects:receipt.projects.map(project=>({...project,deliveryTarget:{targetType:'chat',targetId:'oc_old'}}))};
 const result=selection.queue(mismatched,{inboxId:'source'});assert.equal(result.status,'manual');assert.equal(result.reason,'selection_delivery_target_mismatch');assert.equal(store.listOutbox(Infinity).length,0);
});

test('a stale upstream selection response tells employees to use a refreshed card',async t=>{
 const {store,selection,state}=setup(t,async()=>({status:'selection_rejected',selection:{status:'rejected',reason:'stale_selection_card'}}));
 await selection.act(value(state),event('stale-upstream',[ids[0]]));
 const card=JSON.parse(store.db.prepare('SELECT payload FROM outbox WHERE id=?').get(state.outboxId).payload);
 assert.equal(card.header.title.content,'选择卡已失效');assert.match(JSON.stringify(card),/本次没有启动预读/);assert.match(JSON.stringify(card),/最新选择卡/);
});

test('more than one hundred waiting projects makes the whole batch manual',t=>{
 const store=createStore(':memory:');t.after(()=>store.close());const selection=createSelection({store,config:{chatId:'oc_target',operatorIds:['ou_allowed'],companyId:'company'},preread:{select:()=>assert.fail('posted')}});
 const many=Array.from({length:101},(_,i)=>`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`),large={status:'processed',messageId:'om_many',projects:many.map((_,i)=>({sourceMessageId:'om_many',title:'项目'+i})),results:many.map(eventId=>({status:'waiting_confirmation',eventId}))};
 assert.equal(selection.queue(large).status,'manual');assert.equal(store.listOutbox(Infinity).length,0);
});

test('source edit while selection request is in flight audits response without watches or downstream receipt work',async t=>{
 const store=createStore(':memory:');t.after(()=>store.close());let resolve,downstream=0;const pending=new Promise(r=>{resolve=r;});
 store.set('radar-inbox:source-inbox','radar-message:key');store.set('radar-message:key',{status:'active',original:{inboxId:'source-inbox'}});
 const selection=createSelection({store,config:{chatId:'oc_target',operatorIds:['ou_allowed'],companyId:'company'},preread:{select:()=>pending},onReceipt:()=>{downstream++;},clock:()=>1000});store.transaction(()=>selection.queue(receipt,{inboxId:'source-inbox'}));
 const state=store.get(store.get('selection-inbox:source-inbox'));store.set('outbox-message:'+state.outboxId,'om_selection');const action=selection.act(value(state),event('edited-flight'));
 await new Promise(setImmediate);store.set('radar-message:key',{status:'edited_requires_review',original:{inboxId:'source-inbox'}});resolve({status:'selection_processed',selection:{status:'processed',results:[{status:'triggered',taskId:'must-not-watch'}]}});await action;
 assert.equal(store.listWatches(Infinity).length,0);assert.equal(downstream,0);assert.equal(store.get('selection:'+state.batchKey).status,'edited');
});

test('source edit during a failed request keeps the card edited instead of uncertain',async t=>{
 const store=createStore(':memory:');t.after(()=>store.close());let reject;const pending=new Promise((_,r)=>{reject=r;});store.set('radar-inbox:source-inbox','radar-message:key');store.set('radar-message:key',{status:'active',original:{inboxId:'source-inbox'}});
 const selection=createSelection({store,config:{chatId:'oc_target',operatorIds:['ou_allowed'],companyId:'company'},preread:{select:()=>pending},clock:()=>1000});store.transaction(()=>selection.queue(receipt,{inboxId:'source-inbox'}));const state=store.get(store.get('selection-inbox:source-inbox'));store.set('outbox-message:'+state.outboxId,'om_selection');const action=selection.act(value(state),event('failed-after-edit'));
 await new Promise(setImmediate);store.set('radar-message:key',{status:'edited_requires_review',original:{inboxId:'source-inbox'}});reject(Error('network'));await assert.rejects(action,/source_edited/);assert.equal(store.get('selection:'+state.batchKey).status,'edited');
});

test('an already queued selection card is invalidated when its source inbox is edited',async t=>{
 const {store,selection,calls,state}=setup(t);assert.equal(selection.invalidateInbox('source-inbox'),true);assert.equal(store.get('selection:'+state.batchKey).status,'edited');
 await assert.rejects(selection.act(value(state),event('after-edit')),/edited/);assert.equal(calls.length,0);const card=JSON.parse(store.listOutbox(Infinity)[0].payload);assert.equal(card.header.title.content,'来源消息已编辑');
});

test('a completed event still returns its persisted result after later source invalidation',async t=>{
 const {selection,calls,state}=setup(t);const result=await selection.act(value(state),event('completed-before-edit'));selection.invalidateInbox('source-inbox');
 assert.deepEqual(await selection.act(value(state),event('completed-before-edit')),result);assert.equal(calls.length,1);
});

test('receipt invokes selection queue inside its transaction',t=>{
 const store=createStore(':memory:');t.after(()=>store.close());store.receiveRadar('inbox',{messageId:'om_daily',chatId:'source',messageType:'text'});
 let inside=false;assert.throws(()=>recordReceipt({store,inboxId:'inbox',response:receipt,companyId:'company',onReceipt:()=>{inside=true;store.db.prepare("INSERT INTO settings VALUES('callback-proof','true')").run();throw Error('rollback');}}),/rollback/);
 assert.equal(inside,true);assert.equal(store.get('callback-proof'),null);assert.equal(store.get('radar-receipt:inbox'),null);assert.equal(store.db.prepare('SELECT delivered FROM inbox WHERE id=?').get('inbox').delivered,0);
});
