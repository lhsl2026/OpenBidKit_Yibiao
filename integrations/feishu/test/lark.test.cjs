const {test}=require('node:test');const assert=require('node:assert/strict');
const {createLarkClient,deliverOutbox}=require('../lark.cjs');const {buildCard}=require('../card.cjs');
const {createStore}=require('../store.cjs');
test('card uses Card2 grouped layout, escaped text and versioned callbacks',()=>{const p={id:'p',version:'v1',companyId:'公司',input:{handoff:{task:{title:'<at id=all>恶意</at>'},requirements:[]},deadline:'2026-12-01'},assessment:{decision:'review',blockers:['缺证书'],actions:['补证书']},humanDecision:null};const c=buildCard(p);assert.equal(c.schema,'2.0');assert.ok(c.body.elements.some(e=>e.tag==='column_set'));assert.ok(!JSON.stringify(c.body).includes('<at'));assert.ok(JSON.stringify(c).includes('v1'));});
test('decision card shows a one-screen bid brief instead of paginated source clauses',()=>{
 const requirements=[
  {id:'basic:budget',key:'基础信息：budget',category:'basic',value:'300万元',coordinate:'第2页'},
  {id:'basic:duration',key:'基础信息：duration',category:'basic',value:'合同后30日',coordinate:'第3页'},
  {id:'q-company',key:'资格要求',category:'qualification',value:'提供有效营业执照',coordinate:'第4页'},
  {id:'q-person',key:'资格要求',category:'qualification',value:'项目负责人须持注册证书',coordinate:'第5页'},
  {id:'r-sign',key:'废标条款',category:'redline',value:'未签章的投标文件无效',coordinate:'第6页'},
 ];
 const p={id:'p',version:'v1',companyId:'隆创信息有限公司',input:{deadline:'2026-09-30T09:30:00+08:00',handoff:{task:{title:'测试项目'},requirements}},assessment:{decision:'review',blockers:['q-person:verified_evidence_missing','r-sign:structured_rule_missing'],actions:['request_verification','defer'],items:[{requirementId:'q-company',key:'资格要求',category:'qualification',status:'satisfied',reasons:[]},{requirementId:'q-person',key:'资格要求',category:'qualification',status:'review',reasons:['verified_evidence_missing']},{requirementId:'r-sign',key:'废标条款',category:'redline',status:'not_satisfied',reasons:['manual_result_not_satisfied']}]},humanDecision:null};
 const text=JSON.stringify(buildCard(p,null,0,{now:Date.parse('2026-09-10T00:00:00+08:00')}));
 for(const expected of ['资格结论：暂缓核实','商务判断：待测算','明确不满足 1','待核验 1','已核验满足 1','预算/最高限价：300万元','工期/服务期：合同后30日','主要风险','下一步（最多3项）'])assert.match(text,new RegExp(expected));
 assert.doesNotMatch(text,/预读条款摘录|上一页条款|下一页条款/);
 assert.match(text,/距截止 20 天/);
});
test('token reused, send UUID stable and message binding exposed',async()=>{const calls=[];const f=async(url,options)=>{calls.push({url,options});return Response.json(url.includes('tenant_access_token')?{code:0,tenant_access_token:'token',expire:7200}:{code:0,data:{message_id:'m'}});};const l=createLarkClient({appId:'a',appSecret:'secret',fetchImpl:f});assert.equal(await l.sendCard('chat',{},'uuid'),'m');await l.sendCard('chat',{},'uuid');assert.equal(calls.length,3);assert.equal(JSON.parse(calls[1].options.body).uuid,'uuid');});
test('disabled delivery and wrong target never call external API',async()=>{const store=createStore(':memory:');store.enqueueSummary('2026-09-09',{schema:'2.0'});let calls=0;const client={sendCard:async()=>{calls++;return'm';}};await deliverOutbox({store,client,mode:'disabled',chatId:'a',allowedChats:['a']});await deliverOutbox({store,client,mode:'test',chatId:'a',allowedChats:['b']});assert.equal(calls,0);assert.equal(store.listOutbox(Date.now()).length,1);store.close();});
test('uncertain send failure keeps retry UUID and bounded reconciliation',async()=>{const store=createStore(':memory:');store.enqueueSummary('d',{});const ids=[];let now=1000;const client={sendCard:async(c,p,id)=>{ids.push(id);throw Error('secret must not reach persisted errors');}};await deliverOutbox({store,client,mode:'test',chatId:'a',allowedChats:['a'],clock:()=>now});now+=10000;await deliverOutbox({store,client,mode:'test',chatId:'a',allowedChats:['a'],clock:()=>now});assert.equal(ids[0],ids[1]);now+=3600000;await deliverOutbox({store,client,mode:'test',chatId:'a',allowedChats:['a'],clock:()=>now});assert.equal(ids.length,2);assert.equal(store.db.prepare('SELECT last_error FROM outbox').get().last_error,'delivery_uncertain');store.close();});
test('non-project card changes during send or update remain queued for the latest patch',async()=>{
 for(const alreadyBound of [false,true]){
  const store=createStore(':memory:');const id='selection-'+alreadyBound;store.db.prepare('INSERT INTO outbox(id,project_id,revision,payload) VALUES(?,NULL,0,?)').run(id,JSON.stringify({state:'waiting'}));if(alreadyBound)store.set('outbox-message:'+id,'om_bound');
  let release,started;const underway=new Promise(r=>{started=r;});const blocked=new Promise(r=>{release=r;});const calls=[];const client={sendCard:async()=>{calls.push('send');started();await blocked;return'om_sent';},updateCard:async(_,card)=>{calls.push(card.state);started();await blocked;}};
  const first=deliverOutbox({store,client,mode:'test',chatId:'a',allowedChats:['a']});await underway;store.db.prepare('UPDATE outbox SET payload=?,delivered=0 WHERE id=?').run(JSON.stringify({state:'edited'}),id);release();await first;
  assert.equal(store.db.prepare('SELECT delivered FROM outbox WHERE id=?').get(id).delivered,0);assert.equal(store.get('outbox-message:'+id),alreadyBound?'om_bound':'om_sent');
  client.sendCard=async()=>assert.fail('binding must be reused');client.updateCard=async(_,card)=>{calls.push(card.state);};await deliverOutbox({store,client,mode:'test',chatId:'a',allowedChats:['a']});
  assert.equal(store.db.prepare('SELECT delivered FROM outbox WHERE id=?').get(id).delivered,1);assert.equal(calls.at(-1),'edited');store.close();
 }
});
