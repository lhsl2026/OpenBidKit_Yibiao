const {test}=require('node:test');const assert=require('node:assert/strict');
const {createPrereadClient,pollWatches}=require('../preread.cjs');const {createStore}=require('../store.cjs');
test('handoff uses observed contract, bearer and rejects redirect',async()=>{let call;const c=createPrereadClient({baseUrl:'http://127.0.0.1:1234',apiKey:'key',fetchImpl:async(u,o)=>{call={u,o};return Response.json({schemaVersion:'1.0'});}});await c.getHandoff('task/id');assert.ok(call.u.endsWith('/api/preread/tasks/task%2Fid/handoff'));assert.equal(call.o.headers.authorization,'Bearer key');assert.equal(call.o.redirect,'error');});
test('company profiles use the protected relay import endpoint',async()=>{let call;const c=createPrereadClient({baseUrl:'http://127.0.0.1:1234',apiKey:'key',relayAuthorization:'Bearer relay',fetchImpl:async(u,o)=>{call={u,o};return Response.json({status:'company_profiles_imported',companyCount:1,defaultCompanyId:'隆创信息有限公司'});}});const body={version:1,defaultCompanyId:'隆创信息有限公司',companies:[]};await c.replaceCompanyProfiles(body);assert.ok(call.u.endsWith('/openapi/preread/company-profiles/import'));assert.equal(call.o.headers.authorization,'Bearer relay');assert.deepEqual(JSON.parse(call.o.body),body);});
test('group file uses the protected preread ingress',async()=>{
 let call;const client=createPrereadClient({baseUrl:'http://127.0.0.1:3101',apiKey:'handoff',relayAuthorization:'Bearer relay',fetchImpl:async(url,options)=>{call={url,options};return Response.json({status:'processed',results:[]},{status:201});}});
 const body={eventId:'openbidkit-group-file-job',chatId:'chat',messageId:'message',createTime:'1785190080000',senderId:'sender',candidate:{url:'https://files.example/tender.pdf',fileName:'招标文件.pdf'}};
 assert.deepEqual(await client.receiveGroupFile(body),{status:'processed',results:[]});assert.ok(call.url.endsWith('/openapi/preread/events/lark-group-file'));assert.equal(call.options.headers.authorization,'Bearer relay');assert.deepEqual(JSON.parse(call.options.body),body);
});
test('manual document attachment escapes task id and preserves the candidate',async()=>{
 let call;const client=createPrereadClient({baseUrl:'http://127.0.0.1:3101',apiKey:'handoff',relayAuthorization:'Bearer relay',fetchImpl:async(url,options)=>{call={url,options};return Response.json({acquisition:{status:'acquired',documentId:'document',documentVersion:1}});}});
 const body={chatId:'chat',manualActionId:'action',actorId:'sender',candidate:{url:'https://files.example/tender.docx',fileName:'招标文件.docx',officialCategory:'tender_document'}};
 await client.attachManualDocument('task/id',body);assert.ok(call.url.endsWith('/openapi/preread/tasks/task%2Fid/manual-documents'));assert.deepEqual(JSON.parse(call.options.body),body);
});
test('pending handoff stays on persistent watch, errors do not drop it',async()=>{const store=createStore(':memory:');store.watch('t',{companyId:'c'});let calls=0;await pollWatches({store,client:{getHandoff:async()=>{throw Error('not yet');}},workflow:{ingest:()=>{calls++;}},clock:()=>0});assert.equal(calls,0);assert.equal(store.listWatches(60001).length,1);assert.equal(store.listWatches(1).length,0);store.close();});

test('real preread parser receives text lines instead of the Feishu JSON envelope',async()=>{
 let received;const c=createPrereadClient({baseUrl:'http://localhost',apiKey:'k',relayAuthorization:'Bearer relay',fetchImpl:async(_,o)=>{received=JSON.parse(o.body);return{ok:true,json:async()=>({status:'ignored'})};}});
 await c.receiveRadar({messageType:'text',content:JSON.stringify({text:'今日优先看：\n1. 重点关注｜90分｜项目'})});
 assert.equal(received.content,'今日优先看：\n1. 重点关注｜90分｜项目');
});

test('plain radar text is unchanged at the preread boundary',async()=>{
 let received;const c=createPrereadClient({baseUrl:'http://localhost',apiKey:'k',relayAuthorization:'Bearer relay',fetchImpl:async(_,o)=>{received=JSON.parse(o.body);return{ok:true,json:async()=>({status:'ignored'})};}});
 await c.receiveRadar({messageType:'text',content:'今日优先看：\n1. 重点关注｜90分｜项目'});
 assert.equal(received.content,'今日优先看：\n1. 重点关注｜90分｜项目');
});

test('post radar content preserves paragraph numbers and official links',async()=>{
 let received;const c=createPrereadClient({baseUrl:'http://localhost',apiKey:'k',relayAuthorization:'Bearer relay',fetchImpl:async(_,o)=>{received=JSON.parse(o.body);return{ok:true,json:async()=>({status:'ignored'})};}});
 const content={zh_cn:{title:'今日优先看：',content:[[{tag:'text',text:'1. 重点关注｜90分｜项目｜'},{tag:'a',text:'官方公告',href:'https://official.example/tender'}],[{tag:'text',text:'2. 应该关注｜80分｜项目｜'},{tag:'a',text:'https://official.example/second',href:'https://official.example/second'}]]}};
 await c.receiveRadar({messageType:'post',content:JSON.stringify(content)});
 assert.equal(received.content,'今日优先看：\n1. 重点关注｜90分｜项目｜官方公告 https://official.example/tender\n2. 应该关注｜80分｜项目｜https://official.example/second');
});

test('direct post content is accepted and unsupported JSON is rejected without a request',async()=>{
 const calls=[];const c=createPrereadClient({baseUrl:'http://localhost',apiKey:'k',relayAuthorization:'Bearer relay',fetchImpl:async(_,o)=>{calls.push(JSON.parse(o.body));return{ok:true,json:async()=>({status:'ignored'})};}});
 await c.receiveRadar({messageType:'post',content:{title:'日报',content:[[{tag:'text',text:'1. 重点关注｜90分｜项目'}]]}});
 assert.equal(calls[0].content,'日报\n1. 重点关注｜90分｜项目');
 assert.throws(()=>c.receiveRadar({messageType:'post',content:JSON.stringify({en_us:{title:'one',content:[]},ja_jp:{title:'two',content:[]}})}),/unsupported/);
 assert.throws(()=>c.receiveRadar({messageType:'text',content:JSON.stringify({text:'日报',extra:true})}),/unsupported/);
 assert.equal(calls.length,1);
});
