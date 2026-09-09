const {test}=require('node:test');const assert=require('node:assert/strict');
const {createStore}=require('../store.cjs');const {createRunner}=require('../runner.cjs');const {loadConfig}=require('../config.cjs');
test('config defaults to disabled, rejects unprotected bind and public preread',()=>{
  const c=loadConfig({});assert.equal(c.mode,'disabled');assert.equal(c.host,'127.0.0.1');
  assert.throws(()=>loadConfig({BID_HOST:'0.0.0.0'}),/api_key/);
  assert.throws(()=>loadConfig({PREREAD_BASE_URL:'https://example.com'}),/internal/);
});
test('radar inbox durable, allowlisted, deduplicated and registers only actual task IDs',async()=>{
 const store=createStore(':memory:');let received=0;
 const config={companyId:'c',sourceChats:['source'],sourceSenders:['bot'],mode:'disabled',summaryHour:18};
 const runner=createRunner({store,config,workflow:{ingest:()=>{}},preread:{receiveRadar:async()=>{received++;return{results:[{taskId:'t',status:'triggered'}]};},getHandoff:async()=>{throw Error('pending');}},clock:()=>Date.parse('2026-09-09T11:00:00Z')});
 const event={eventType:'im.message.receive_v1',eventId:'e',chatId:'source',messageId:'m',senderId:'bot',content:'{"text":"tender"}',messageType:'text'};
 assert.throws(()=>runner.receiveRadar({...event,chatId:'other'}),/source_not_allowed/);
 runner.receiveRadar(event);runner.receiveRadar(event);await runner.tick();await runner.tick();
 assert.equal(received,1);assert.equal(store.listWatches(Infinity).length,1);assert.equal(store.listOutbox(Infinity).length,1);store.close();
});
