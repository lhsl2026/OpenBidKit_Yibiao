const {test}=require('node:test');const assert=require('node:assert/strict');
const {createStore}=require('../store.cjs');
const {createRadarSource,normalizeMessage,cliArguments}=require('../radar-source.cjs');
const {createRunner}=require('../runner.cjs');
const message={chat_id:'source',message_id:'om_real',msg_type:'text',create_time:'2026-09-10 07:04',content:'招标日报',sender:{sender_type:'app',id:'app',open_bot_id:'bot'}};
const config={sourceChats:['source'],sourceSenders:['bot'],radarPolling:{enabled:true,profile:'configured-app',startAt:'2026-09-10T00:00:00+08:00'}};
test('CLI user history maps to the exact preread DTO without accepting other senders',()=>{
 const e=normalizeMessage(message,config);assert.equal(e.createTime,String(Date.parse('2026-09-10T07:04:00+08:00')));assert.equal(e.senderType,'bot');assert.equal(e.content,'{"text":"招标日报"}');
 assert.equal(normalizeMessage({...message,sender:{...message.sender,open_bot_id:'other'}},config),null);
 assert.equal(normalizeMessage({...message,deleted:true},config),null);
 const args=cliArguments({chatId:'source',start:0,end:1000,profile:'configured-app'});assert.equal(args[args.indexOf('--as')+1],'user');assert.equal(args[args.indexOf('--profile')+1],'configured-app');
});
test('persistent pagination only advances the time cursor after every page is accepted',async t=>{
 const store=createStore(':memory:');t.after(()=>store.close());let now=Date.parse('2026-09-10T09:00:00+08:00'),calls=[];
 const receive=e=>calls.push(e.messageId);let page=0;
 const fetchPage=async()=>({ok:true,data:{messages:[{...message,message_id:'om_'+(++page)}],has_more:page===1,page_token:page===1?'next':''}});
 let source=createRadarSource({store,config,receive,fetchPage,clock:()=>now});await source.poll();
 let state=store.get('radar-source:source');assert.equal(state.window.token,'next');assert.equal(state.cursor,undefined);
 now+=5000;source=createRadarSource({store,config,receive,fetchPage,clock:()=>now});await source.poll();
 state=store.get('radar-source:source');assert.equal(state.window,undefined);assert.equal(state.cursor,Date.parse('2026-09-10T09:00:00+08:00'));assert.deepEqual(calls,['om_1','om_2']);
});
test('failed receive and failed authorization retain the window and never advance past lost data',async t=>{
 const store=createStore(':memory:');t.after(()=>store.close());const now=Date.parse('2026-09-10T09:00:00+08:00');
 const source=createRadarSource({store,config,receive:()=>{throw Error('inbox_failed');},fetchPage:async()=>({ok:true,data:{messages:[message],has_more:false}}),clock:()=>now});
 await source.poll();assert.equal(store.get('radar-source:source').cursor,undefined);assert.equal(store.get('radar-source:source').error,'radar_poll_failed');
 const failed=createRadarSource({store,config,receive:()=>assert.fail(),fetchPage:async()=>({ok:false,error:{message:'private detail'}}),clock:()=>now+120000});await failed.poll();
 assert.equal(store.get('radar-source:source').cursor,undefined);assert.equal(JSON.stringify(store.get('radar-source:source')).includes('private detail'),false);
});

test('history replay with a different transport event id deduplicates while an edited body gets a separate inbox version',async t=>{
 const store=createStore(':memory:');t.after(()=>store.close());const now=Date.parse('2026-09-10T09:00:00+08:00');
 const runner=createRunner({store,config:{...config,companyId:'company',mode:'disabled',summaryHour:18,radarPolling:{enabled:false}},workflow:{ingest:()=>{}},clock:()=>now});t.after(()=>runner.close());
 runner.receiveRadar({...normalizeMessage(message,config),eventId:'evt-live-original',content:'招标日报'});
 const edited={...message,content:'招标日报（已编辑）'};
 const source=createRadarSource({store,config,receive:runner.receiveRadar,clock:()=>now,fetchPage:async()=>({ok:true,data:{messages:[message,edited],has_more:false}})});
 await source.poll();
 const state=store.get('radar-source:source');assert.equal(state.error,null);assert.equal(state.cursor,now);
 const rows=store.db.prepare('SELECT id,payload FROM inbox ORDER BY rowid').all().map(row=>({...row,payload:JSON.parse(row.payload)}));
 assert.equal(rows.length,1);assert.equal(rows[0].payload.content,'招标日报');assert.equal(rows[0].delivered,undefined);
 const edit=store.db.prepare("SELECT value FROM settings WHERE key LIKE 'radar-message:%'").get();const saved=JSON.parse(edit.value);
 assert.equal(saved.status,'edited_requires_review');assert.equal(saved.original.content,'招标日报');assert.equal(saved.edits[0].content,'{"text":"招标日报（已编辑）"}');
});
