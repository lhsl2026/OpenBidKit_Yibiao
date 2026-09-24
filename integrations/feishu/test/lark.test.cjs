const {test}=require('node:test');const assert=require('node:assert/strict');
const {createLarkClient,deliverGroupFileStatus,deliverOutbox,reconcilePrereadDeliveries}=require('../lark.cjs');const {buildCard,buildWritingPortalCard}=require('../card.cjs');
const {createStore}=require('../store.cjs');
const {createWorkflow}=require('../workflow.cjs');
test('card uses Card2 grouped layout, escaped text and versioned callbacks',()=>{const p={id:'p',version:'v1',companyId:'公司',input:{handoff:{task:{title:'<at id=all>恶意</at>'},requirements:[]},deadline:'2026-12-01'},assessment:{decision:'review',blockers:['缺证书'],actions:['补证书']},humanDecision:null};const c=buildCard(p);assert.equal(c.schema,'2.0');assert.ok(c.body.elements.some(e=>e.tag==='column_set'));assert.ok(!JSON.stringify(c.body).includes('<at'));assert.ok(JSON.stringify(c).includes('v1'));});
test('decision card exposes a desktop Yibiao entry with a web fallback',()=>{
 const p={id:'p',version:'v1',companyId:'公司',input:{handoff:{task:{title:'测试项目'},requirements:[]}},assessment:{decision:'review',blockers:[],actions:[]},humanDecision:null};
 const card=buildCard(p);
 const portal=card.body.elements.flatMap(element=>element.columns?.[0]?.elements||[]).find(element=>element.text?.content==='生成其他标书');
 assert.deepEqual(portal.behaviors,[{type:'open_url',default_url:'https://yibiao.pro',pc_url:'yibiao://new-bid'}]);
 assert.match(portal.hover_tips.content,/首次启动约需 5 秒/);
 assert.match(portal.confirm.text.content,/任务栏/);
});
test('draft action explains why it is disabled and confirms visible progress before enqueueing',()=>{
 const base={id:'p',version:'v1',companyId:'公司',input:{handoff:{task:{title:'测试项目'},requirements:[]}},assessment:{decision:'follow',blockers:[],actions:[]},current:true};
 const blocked=buildCard({...base,humanDecision:null});
 const blockedAction=blocked.body.elements.flatMap(element=>element.columns?.[0]?.elements||[]).find(element=>element.text?.content==='确认跟进后可生成初稿');
 assert.equal(blockedAction.disabled,true);
 assert.match(blockedAction.disabled_tips.content,/确认跟进/);
 const ready=buildCard({...base,humanDecision:'follow',input:{deadline:'2026-12-01T09:00:00+08:00',handoff:{status:'ready',superseded:false,task:{title:'测试项目'},requirements:[],warnings:[]}}},null,0,{now:Date.parse('2026-09-21T00:00:00Z')});
 const readyAction=ready.body.elements.flatMap(element=>element.columns?.[0]?.elements||[]).find(element=>element.text?.content==='生成标书初稿');
 assert.equal(readyAction.disabled,false);
 assert.match(readyAction.confirm.text.content,/约 5 秒内刷新/);
 assert.match(readyAction.confirm.text.content,/目录确认/);
});
test('decision card puts a status-coloured employee decision block after risk details and before auxiliary information',()=>{
 const base={id:'p',version:'v1',companyId:'公司',input:{handoff:{task:{title:'测试项目'},requirements:[]}},assessment:{decision:'review',blockers:[],actions:[]}};
 for(const [humanDecision,status,color] of [[null,'等待员工判断','orange-50'],['follow','已确认跟进','green-50'],['defer','暂缓','orange-50'],['decline','不投','red-50']]){
  const card=buildCard({...base,humanDecision});
  const groups=card.body.elements;
  const decisionIndex=groups.findIndex(group=>JSON.stringify(group).includes('📌 处理决定'));
  const riskIndex=groups.findIndex(group=>JSON.stringify(group).includes('主要风险'));
  const auxiliaryIndex=groups.findIndex(group=>JSON.stringify(group).includes('辅助信息'));
  assert.equal(decisionIndex,3);
  assert.ok(riskIndex<decisionIndex);
  assert.ok(decisionIndex<auxiliaryIndex);
  assert.equal(groups.length,5);
  assert.equal(groups[decisionIndex].background_style,color);
  assert.match(JSON.stringify(groups[decisionIndex]),new RegExp(status));
  const actions=groups[decisionIndex].columns[0].elements.filter(element=>element.tag==='button');
  assert.deepEqual(actions.map(action=>action.text.content),['确认跟进','暂缓','不投']);
  assert.ok(actions.every(action=>action.width==='fill'));
 }
});
test('followed projects with evidence gaps expose a placeholder draft action',()=>{
 const p={id:'p',version:'v1',companyId:'隆创信息有限公司',input:{deadline:'2026-10-09T09:30:00+08:00',handoff:{status:'ready',superseded:false,warnings:[],task:{title:'测试项目'},requirements:[]}},assessment:{decision:'review',blockers:['q-license:structured_rule_missing'],actions:['request_verification'],items:[{requirementId:'q-license',category:'qualification',status:'review',reasons:['structured_rule_missing']}]},humanDecision:'follow',current:true};
 const card=buildCard(p,null,0,{now:Date.parse('2026-09-17T12:00:00+08:00')});
 const action=card.body.elements.flatMap(element=>element.columns?.[0]?.elements||[]).find(element=>element.text?.content==='生成待补初稿');
 assert.equal(action.disabled,false);
});
test('a followed visual-review project explains the review step and exposes the reviewed placeholder draft action',()=>{
 const checksum='a'.repeat(64);
 const p={
  id:'p-review',taskId:'task-review',version:'7',checksum,current:true,humanDecision:'follow',companyId:'隆创信息有限公司',
  input:{deadline:'',reportUrl:'https://example.com/report',handoff:{
   status:'invalid',superseded:false,latestDocumentVersion:'7',task:{taskId:'task-review',title:'稀疏页复核项目'},requirements:[],
   snapshot:{documentVersion:'7',reportId:'report-review',reportVersion:'r3',checksum,generatedAt:'2026-09-21T01:00:00Z',completeness:0.8,confidence:0.92},
   warnings:[{code:'report_requires_review',blocked:true},{code:'five_module_run_incomplete',blocked:true}],
  }},
  assessment:{decision:'review',items:[],blockers:['handoff_snapshot_incomplete','handoff_invalid','handoff_warning_blocked','deadline_invalid'],actions:['request_verification']},
 };
 const card=buildCard(p,null,0,{now:Date.parse('2026-09-21T02:00:00Z')});
 const text=JSON.stringify(card);
 assert.match(text,/复核处理/);
 assert.match(text,/打开预读报告核对待核实项/);
 assert.match(text,/不会把待核实的资格、参数或证明材料写成已满足/);
 const action=card.body.elements.flatMap(element=>element.columns?.[0]?.elements||[]).find(element=>element.text?.content==='复核后生成待补初稿');
 assert.equal(action.disabled,false);
});
test('company review is rendered inside the existing project card as a compact useful summary',()=>{
 const taskId='task-1',runId='11111111-1111-4111-8111-111111111111';
 const companyMatchCard={taskId,runId,documentVersion:1,scopeType:'group',scopeId:'oc_test',sourceCardMessageId:'om_card',selectedCompanyId:'company-a',selectedCompanyProfileVersion:'profile-a',companies:[{companyId:'company-a',companyName:'甲公司',profileVersion:'profile-a',enabled:true}]};
 const p={id:'p',taskId,version:'1',companyId:'公司',messageId:'om_card',input:{companyMatchCard,handoff:{task:{taskId,title:'测试项目'},requirements:[],companyMatch:{companyId:'company-a',companyName:'甲公司',profileVersion:'profile-a',syncStatus:'synced',qualificationCount:2,counts:{profileEvidenceSatisfied:1,pendingReview:1,gaps:0}}}},assessment:{decision:'review',blockers:[],actions:[]},humanDecision:null};
 const companyMatchReview={taskId,runId,companyId:'company-a',companyProfileVersion:'profile-a',counts:{confirmed:1,pending:1,gaps:0,notApplicable:0},items:[{id:'q-1',requirement:'提供有效营业执照',evidenceRequirement:'营业执照复印件',matchStatus:'confirmed_met',page:4},{id:'q-2',requirement:'提供本年度社保证明',evidenceRequirement:'社保缴纳证明',matchStatus:'unconfirmed',page:5}]};
 const text=JSON.stringify(buildCard(p,null,0,{companyMatchReview}));
 for(const expected of ['公司匹配复核','已核验 1','待核验 1','明确缺口 0','提供有效营业执照','第4页','营业执照复印件','提供本年度社保证明'])assert.match(text,new RegExp(expected));
 assert.match(text,/刷新公司匹配复核/);assert.doesNotMatch(text,/company\/a\.pdf/);
});
test('standalone writing portal card supports bids that have no preread report',()=>{
 const card=buildWritingPortalCard();
 const text=JSON.stringify(card);
 assert.equal(card.schema,'2.0');
 assert.equal(card.config.width_mode,'default');
 assert.match(text,/未进入预读报告/);
 assert.match(text,/上传招标文件/);
 assert.match(text,/选择本标书使用的模型/);
 const buttons=card.body.elements.flatMap(element=>element.columns?.[0]?.elements||[element]).filter(element=>element.tag==='button');
 assert.equal(buttons.length,2);
 assert.deepEqual(buttons.map(button=>button.text.content),['生成技术标','生成商务标']);
 assert.ok(buttons.every(button=>button.type==='primary_filled'&&button.width==='fill'));
 assert.deepEqual(buttons.map(button=>button.behaviors),[
  [{type:'open_url',default_url:'https://yibiao.pro',pc_url:'yibiao://new-bid?type=technical'}],
  [{type:'open_url',default_url:'https://yibiao.pro',pc_url:'yibiao://new-bid?type=business'}],
 ]);
 assert.ok(buttons.every(button=>/首次启动约需 5 秒/.test(button.hover_tips.content)));
 assert.ok(buttons.every(button=>/任务栏/.test(button.confirm.text.content)));
 assert.doesNotMatch(text,/"type":"callback"/);
});
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
test('message readback exposes exact card message and chat identity',async()=>{const calls=[];const f=async(url,options)=>{calls.push({url,options});return Response.json(url.includes('tenant_access_token')?{code:0,tenant_access_token:'token',expire:7200}:{code:0,data:{items:[{message_id:'om_card',chat_id:'oc_test',msg_type:'interactive',content:'{}',deleted:false}]}});};const l=createLarkClient({appId:'a',appSecret:'secret',fetchImpl:f});assert.deepEqual(await l.getMessages(['om_card']),[{messageId:'om_card',chatId:'oc_test',messageType:'interactive',content:'{}',deleted:false}]);assert.match(calls[1].url,/messages\/mget/);assert.match(calls[1].url,/message_ids=om_card/);});
test('verified unified card closes the exact preread outbox without sending another card',async()=>{
 const store=createStore(':memory:'),taskId='11111111-1111-4111-8111-111111111111',runId='22222222-2222-4222-8222-222222222222',reportId='33333333-3333-4333-8333-333333333333',outboxId='44444444-4444-4444-8444-444444444444',checksum='sha256:'+'a'.repeat(64);
 const handoff={status:'ready',task:{taskId,title:'测试项目'},snapshot:{reportId,reportVersion:'r3',documentVersion:3,checksum},warnings:[]};
 const p={id:'project',taskId,companyId:'company',version:'3',checksum,generatedAt:'2026-09-23T08:00:00.000Z',input:{handoff,companyMatchCard:{runId,sourceCardMessageId:'om_card'},reportArchive:{reportId,reportVersion:'r3',documentVersion:3,checksum}},assessment:{decision:'review',blockers:[],actions:[]},messageId:'om_card',created:1,revision:1};
 store.saveProject(p);store.sent(store.listOutbox(0)[0].id);
 const confirmations=[],preread={getDeliveryStatus:async()=>({status:'pending_delivery',delivery:{id:outboxId,reportId,targetType:'chat',targetId:'oc_test',report:{taskId,documentVersion:3,sourceTenderRunId:runId}}}),confirmUnifiedCardDelivered:async body=>{confirmations.push(body);return{status:'sent',updated:true};}};
 const client={getMessages:async()=>[{messageId:'om_card',chatId:'oc_test',messageType:'interactive',content:'{}',deleted:false}],sendCard:async()=>assert.fail('must not send a second card')};
 await reconcilePrereadDeliveries({store,client,preread,mode:'test',chatId:'oc_test',allowedChats:['oc_test']});
 assert.deepEqual(confirmations,[{outboxId,reportId,taskId,runId,messageId:'om_card',targetType:'chat',targetId:'oc_test'}]);store.close();
});
test('verified first unified card closes preread delivery using the stable tender run identity before company options exist',async()=>{
 const store=createStore(':memory:'),taskId='11111111-1111-4111-8111-111111111111',runId='22222222-2222-4222-8222-222222222222',reportId='33333333-3333-4333-8333-333333333333',outboxId='44444444-4444-4444-8444-444444444444',checksum='sha256:'+'a'.repeat(64);
 const handoff={status:'needs_manual',task:{taskId,title:'测试项目'},snapshot:{reportId,reportVersion:'r3',documentVersion:3,checksum},warnings:[]};
 const p={id:'project',taskId,companyId:'company',version:'3',checksum,generatedAt:'2026-09-23T08:00:00.000Z',input:{handoff,reportArchive:{reportId,reportVersion:'r3',documentVersion:3,checksum}},assessment:{decision:'review',blockers:[],actions:[]},messageId:'om_card',created:1,revision:1};
 store.saveProject(p);store.set('preread-run-identity:project',{taskId,runId,documentVersion:3});store.sent(store.listOutbox(0)[0].id);
 const bindings=[],confirmations=[],preread={getDeliveryStatus:async()=>({status:'pending_delivery',delivery:{id:outboxId,reportId,targetType:'chat',targetId:'oc_test',report:{taskId,documentVersion:3,sourceTenderRunId:runId}}}),confirmTenderDeliveryCard:async(id,body)=>{bindings.push({id,body});return{runId:id,deliveryStatusCardMessageId:body.messageId};},confirmUnifiedCardDelivered:async body=>{confirmations.push(body);return{status:'sent',updated:true};}};
 const client={getMessages:async()=>[{messageId:'om_card',chatId:'oc_test',messageType:'interactive',content:'{}',deleted:false}]};
 await reconcilePrereadDeliveries({store,client,preread,mode:'test',chatId:'oc_test',allowedChats:['oc_test']});
 assert.deepEqual(bindings,[{id:runId,body:{messageId:'om_card'}}]);assert.deepEqual(confirmations,[{outboxId,reportId,taskId,runId,messageId:'om_card',targetType:'chat',targetId:'oc_test'}]);store.close();
});
test('verified first unified card binds the tender run before a report archive exists',async()=>{
 const store=createStore(':memory:'),taskId='11111111-1111-4111-8111-111111111111',runId='22222222-2222-4222-8222-222222222222',reportId='33333333-3333-4333-8333-333333333333',checksum='sha256:'+'a'.repeat(64);
 const handoff={status:'invalid',task:{taskId,title:'测试项目'},snapshot:{reportId,reportVersion:'r1',documentVersion:3,checksum},requirements:[],evidence:[],warnings:[{code:'five_module_run_incomplete',blocked:true}]};
 const p={id:'project',taskId,companyId:'company',version:'3',checksum,generatedAt:'2026-09-23T08:00:00.000Z',input:{handoff},assessment:{decision:'review',blockers:[],actions:[]},messageId:'om_card',created:1,revision:1};
 store.saveProject(p);store.set('preread-run-identity:project',{taskId,runId,documentVersion:3});store.sent(store.listOutbox(0)[0].id);
 const bindings=[],preread={getDeliveryStatus:async()=>assert.fail('report delivery must wait for a verified archive'),confirmTenderDeliveryCard:async(id,body)=>{bindings.push({id,body});return{runId:id,deliveryStatusCardMessageId:body.messageId};},confirmUnifiedCardDelivered:async()=>assert.fail('report delivery must wait for a verified archive')};
 const client={getMessages:async()=>[{messageId:'om_card',chatId:'oc_test',messageType:'interactive',content:'{}',deleted:false}]};
 await reconcilePrereadDeliveries({store,client,preread,mode:'test',chatId:'oc_test',allowedChats:['oc_test']});
 assert.deepEqual(bindings,[{id:runId,body:{messageId:'om_card'}}]);store.close();
});
test('verified relocated unified card rebinds the tender run to the current card before company review',async()=>{
 const store=createStore(':memory:'),taskId='11111111-1111-4111-8111-111111111111',runId='22222222-2222-4222-8222-222222222222',reportId='33333333-3333-4333-8333-333333333333',checksum='sha256:'+'a'.repeat(64);
 const handoff={status:'needs_manual',task:{taskId,title:'测试项目'},snapshot:{reportId,reportVersion:'r1',documentVersion:3,checksum},requirements:[],evidence:[],warnings:[]};
 const companyMatchCard={taskId,runId,documentVersion:3,sourceCardMessageId:'om_old',scopeType:'group',scopeId:'oc_test',companies:[{companyId:'company-a',companyName:'甲公司',profileVersion:'profile-a',enabled:true}]};
 const p={id:'project',taskId,companyId:'company',version:'3',checksum,generatedAt:'2026-09-23T08:00:00.000Z',input:{handoff,companyMatchCard},assessment:{decision:'review',blockers:[],actions:[]},messageId:'om_current',created:1,revision:1};
 store.saveProject(p);store.sent(store.listOutbox(0)[0].id);
 const bindings=[],preread={getDeliveryStatus:async()=>assert.fail('report delivery must wait for an archive'),confirmTenderDeliveryCard:async(id,body)=>{bindings.push({id,body});return{runId:id,deliveryStatusCardMessageId:body.messageId};},confirmUnifiedCardDelivered:async()=>assert.fail('report delivery must wait for an archive')};
 const client={getMessages:async()=>[{messageId:'om_current',chatId:'oc_test',messageType:'interactive',content:'{}',deleted:false}]};
 await reconcilePrereadDeliveries({store,client,preread,mode:'production',chatId:'oc_test',allowedChats:['oc_test']});
 assert.deepEqual(bindings,[{id:runId,body:{messageId:'om_current',replaceExisting:true}}]);store.close();
});
test('verified relocated card rebinds after its obsolete delivery revision was quarantined',async()=>{
 const store=createStore(':memory:'),taskId='11111111-1111-4111-8111-111111111111',runId='22222222-2222-4222-8222-222222222222',reportId='33333333-3333-4333-8333-333333333333',checksum='sha256:'+'a'.repeat(64);
 const handoff={status:'needs_manual',task:{taskId,title:'测试项目'},snapshot:{reportId,reportVersion:'r1',documentVersion:3,checksum},requirements:[],evidence:[],warnings:[]};
 const companyMatchCard={taskId,runId,documentVersion:3,sourceCardMessageId:'om_old',scopeType:'group',scopeId:'oc_test',companies:[{companyId:'company-a',companyName:'甲公司',profileVersion:'profile-a',enabled:true}]};
 const p={id:'project',taskId,companyId:'company',version:'3',checksum,generatedAt:'2026-09-23T08:00:00.000Z',input:{handoff,companyMatchCard},assessment:{decision:'review',blockers:[],actions:[]},messageId:'om_current',created:1,revision:1};
 store.saveProject(p);const outbox=store.listOutbox(0)[0],stream=store.messageStream(p,'oc_test');store.bindStream(stream.id,'om_current');store.rejectDelivery(outbox.id,'card_scope_mismatch');
 const bindings=[],preread={getDeliveryStatus:async()=>assert.fail('report delivery must wait for an archive'),confirmTenderDeliveryCard:async(id,body)=>{bindings.push({id,body});return{runId:id,deliveryStatusCardMessageId:body.messageId};},confirmUnifiedCardDelivered:async()=>assert.fail('report delivery must wait for an archive')};
 const client={getMessages:async()=>[{messageId:'om_current',chatId:'oc_test',messageType:'interactive',content:'{}',deleted:false}]};
 await reconcilePrereadDeliveries({store,client,preread,mode:'production',chatId:'oc_test',allowedChats:['oc_test']});
 assert.deepEqual(bindings,[{id:runId,body:{messageId:'om_current',replaceExisting:true}}]);store.close();
});
test('report delivery waits when the report is not bound to the verified tender run',async()=>{
 const store=createStore(':memory:'),taskId='11111111-1111-4111-8111-111111111111',runId='22222222-2222-4222-8222-222222222222',reportId='33333333-3333-4333-8333-333333333333',outboxId='44444444-4444-4444-8444-444444444444',checksum='sha256:'+'a'.repeat(64);
 const handoff={status:'invalid',task:{taskId,title:'测试项目'},snapshot:{reportId,reportVersion:'r1',documentVersion:3,checksum},requirements:[],evidence:[],warnings:[]};
 const p={id:'project',taskId,companyId:'company',version:'3',checksum,generatedAt:'2026-09-23T08:00:00.000Z',input:{handoff,companyMatchCard:{runId,sourceCardMessageId:'om_card'},reportArchive:{reportId,reportVersion:'r1',documentVersion:3,checksum}},assessment:{decision:'review',blockers:[],actions:[]},messageId:'om_card',created:1,revision:1};
 store.saveProject(p);store.sent(store.listOutbox(0)[0].id);let confirmations=0;
 const preread={getDeliveryStatus:async()=>({status:'pending_delivery',delivery:{id:outboxId,reportId,targetType:'chat',targetId:'oc_test',report:{taskId,documentVersion:3}}}),confirmUnifiedCardDelivered:async()=>{confirmations++;return{status:'sent',updated:true};}};
 const client={getMessages:async()=>[{messageId:'om_card',chatId:'oc_test',messageType:'interactive',content:'{}',deleted:false}]};
 await reconcilePrereadDeliveries({store,client,preread,mode:'test',chatId:'oc_test',allowedChats:['oc_test']});
 assert.equal(confirmations,0);assert.deepEqual(store.get('preread-reconcile:project'),{status:'waiting_report_run_binding',runId,messageId:'om_card',reportId});store.close();
});
test('preread card reconciliation records a retryable binding error instead of swallowing it',async()=>{
 const store=createStore(':memory:'),taskId='11111111-1111-4111-8111-111111111111',runId='22222222-2222-4222-8222-222222222222',reportId='33333333-3333-4333-8333-333333333333',checksum='sha256:'+'a'.repeat(64);
 const handoff={status:'invalid',task:{taskId,title:'测试项目'},snapshot:{reportId,reportVersion:'r1',documentVersion:3,checksum},requirements:[],evidence:[],warnings:[]};
 const p={id:'project',taskId,companyId:'company',version:'3',checksum,generatedAt:'2026-09-23T08:00:00.000Z',input:{handoff},assessment:{decision:'review',blockers:[],actions:[]},messageId:'om_card',created:1,revision:1};
 store.saveProject(p);store.set('preread-run-identity:project',{taskId,runId,documentVersion:3});store.sent(store.listOutbox(0)[0].id);
 const preread={getDeliveryStatus:async()=>assert.fail('report delivery must not run'),confirmTenderDeliveryCard:async()=>{throw Error('preread_unavailable');},confirmUnifiedCardDelivered:async()=>assert.fail('report delivery must not run')};
 const client={getMessages:async()=>[{messageId:'om_card',chatId:'oc_test',messageType:'interactive',content:'{}',deleted:false}]};
 await reconcilePrereadDeliveries({store,client,preread,mode:'test',chatId:'oc_test',allowedChats:['oc_test']});
 assert.deepEqual(store.get('preread-reconcile:project'),{status:'error',code:'preread_unavailable',runId,messageId:'om_card'});store.close();
});
test('a unified card read back from another chat never confirms preread delivery',async()=>{
 const store=createStore(':memory:'),taskId='11111111-1111-4111-8111-111111111111',runId='22222222-2222-4222-8222-222222222222',reportId='33333333-3333-4333-8333-333333333333',checksum='sha256:'+'a'.repeat(64);
 const handoff={status:'ready',task:{taskId,title:'测试项目'},snapshot:{reportId,reportVersion:'r3',documentVersion:3,checksum},warnings:[]};
 const p={id:'project',taskId,companyId:'company',version:'3',checksum,generatedAt:'2026-09-23T08:00:00.000Z',input:{handoff,companyMatchCard:{runId,sourceCardMessageId:'om_card'},reportArchive:{reportId,reportVersion:'r3',documentVersion:3,checksum}},assessment:{decision:'review',blockers:[],actions:[]},messageId:'om_card',created:1,revision:1};
 store.saveProject(p);store.sent(store.listOutbox(0)[0].id);let confirmed=0;
 const preread={getDeliveryStatus:async()=>({status:'pending_delivery'}),confirmUnifiedCardDelivered:async()=>{confirmed++;}};
 const client={getMessages:async()=>[{messageId:'om_card',chatId:'oc_other',messageType:'interactive',content:'{}',deleted:false}]};
 await reconcilePrereadDeliveries({store,client,preread,mode:'test',chatId:'oc_test',allowedChats:['oc_test']});
 assert.equal(confirmed,0);store.close();
});
test('a project scoped to another group is rejected before creating a cross-group card stream',async()=>{
 const store=createStore(':memory:'),handoff={task:{taskId:'task-test',title:'测试项目'},snapshot:{documentVersion:1,reportId:'report-test',checksum:'a'.repeat(64),generatedAt:'2026-09-23T08:00:00.000Z'},requirements:[],warnings:[]};
 store.saveProject({id:'project',taskId:'task-test',companyId:'company',version:'1',checksum:'a'.repeat(64),generatedAt:'2026-09-23T08:00:00.000Z',input:{handoff,companyMatchCard:{scopeType:'group',scopeId:'oc_test',sourceCardMessageId:'om_test'}},assessment:{decision:'review',blockers:[],actions:[]},messageId:'om_test',created:1,revision:1});
 const client={getMessages:async()=>assert.fail('wrong-scope project must not read a card'),updateCard:async()=>assert.fail('wrong-scope project must not update a card'),sendCard:async()=>assert.fail('wrong-scope project must not create a replacement card')};
 await deliverOutbox({store,client,mode:'production',chatId:'oc_formal',allowedChats:['oc_formal'],clock:()=>1000});
 assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM card_streams WHERE chat='oc_formal'").get().count,0);
 assert.equal(store.db.prepare('SELECT delivered,last_error FROM outbox').get().delivered,-1);
 assert.equal(store.db.prepare('SELECT delivered,last_error FROM outbox').get().last_error,'card_scope_mismatch');store.close();
});
test('a bound project card from another chat is rejected before update without sending a replacement',async()=>{
 const store=createStore(':memory:'),handoff={task:{taskId:'task-formal',title:'正式项目'},snapshot:{documentVersion:1,reportId:'report-formal',checksum:'b'.repeat(64),generatedAt:'2026-09-23T08:00:00.000Z'},requirements:[],warnings:[]};
 store.saveProject({id:'project',taskId:'task-formal',companyId:'company',version:'1',checksum:'b'.repeat(64),generatedAt:'2026-09-23T08:00:00.000Z',input:{handoff,companyMatchCard:{scopeType:'group',scopeId:'oc_formal',sourceCardMessageId:'om_wrong'}},assessment:{decision:'review',blockers:[],actions:[]},messageId:'om_wrong',created:1,revision:1});
 let reads=0;const client={getMessages:async ids=>{reads++;assert.deepEqual(ids,['om_wrong']);return[{messageId:'om_wrong',chatId:'oc_test',messageType:'interactive',content:'{}',deleted:false}];},updateCard:async()=>assert.fail('cross-chat binding must not be updated'),sendCard:async()=>assert.fail('cross-chat binding must not create a replacement card')};
 await deliverOutbox({store,client,mode:'production',chatId:'oc_formal',allowedChats:['oc_formal'],clock:()=>1000});
 assert.equal(reads,1);assert.equal(store.db.prepare('SELECT delivered,last_error FROM outbox').get().delivered,-1);
 assert.equal(store.db.prepare('SELECT delivered,last_error FROM outbox').get().last_error,'card_scope_mismatch');store.close();
});
test('a bound project card in the expected chat is read back before its update is accepted',async()=>{
 const store=createStore(':memory:'),handoff={task:{taskId:'task-formal',title:'正式项目'},snapshot:{documentVersion:1,reportId:'report-formal',checksum:'c'.repeat(64),generatedAt:'2026-09-23T08:00:00.000Z'},requirements:[],warnings:[]};
 store.saveProject({id:'project',taskId:'task-formal',companyId:'company',version:'1',checksum:'c'.repeat(64),generatedAt:'2026-09-23T08:00:00.000Z',input:{handoff,companyMatchCard:{scopeType:'group',scopeId:'oc_formal',sourceCardMessageId:'om_formal'}},assessment:{decision:'review',blockers:[],actions:[]},messageId:'om_formal',created:1,revision:1});
 let reads=0,updates=0;const client={getMessages:async ids=>{reads++;assert.deepEqual(ids,['om_formal']);return[{messageId:'om_formal',chatId:'oc_formal',messageType:'interactive',content:'{}',deleted:false}];},updateCard:async messageId=>{updates++;assert.equal(messageId,'om_formal');},sendCard:async()=>assert.fail('a verified binding must be updated, not replaced')};
 await deliverOutbox({store,client,mode:'production',chatId:'oc_formal',allowedChats:['oc_formal'],clock:()=>1000});
 const row=store.db.prepare('SELECT delivered,last_error FROM outbox').get();assert.equal(reads,1);assert.equal(updates,1);assert.equal(row.delivered,1);assert.equal(row.last_error,null);store.close();
});
test('disabled delivery and wrong target never call external API',async()=>{const store=createStore(':memory:');store.enqueueSummary('2026-09-09',{schema:'2.0'});let calls=0;const client={sendCard:async()=>{calls++;return'm';}};await deliverOutbox({store,client,mode:'disabled',chatId:'a',allowedChats:['a']});await deliverOutbox({store,client,mode:'test',chatId:'a',allowedChats:['b']});assert.equal(calls,0);assert.equal(store.listOutbox(Date.now()).length,1);store.close();});
test('production delivery uses the same durable outbox only for its active allowlisted target',async()=>{const store=createStore(':memory:');store.enqueueSummary('2026-09-10',{schema:'2.0'});let calls=0;const client={sendCard:async(chat)=>{calls++;assert.equal(chat,'formal');return'om_formal';}};await deliverOutbox({store,client,mode:'production',chatId:'formal',allowedChats:['formal']});assert.equal(calls,1);assert.equal(store.listOutbox(Date.now()).length,0);store.close();});
test('selection delivery quarantines a persisted card whose target is retired or forbidden',async t=>{
 const store=createStore(':memory:');t.after(()=>store.close());const outboxId='legacy-selection';
 store.db.prepare('INSERT INTO outbox(id,project_id,revision,payload) VALUES(?,NULL,0,?)').run(outboxId,JSON.stringify({schema:'2.0'}));
 store.set('selection-outbox:'+outboxId,'selection:legacy');store.set('selection:legacy',{outboxId,targetChatId:'oc_retired',status:'selected'});store.set('outbox-message:'+outboxId,'om_retired_card');
 let calls=0;const client={sendCard:async()=>{calls++;return'om_new';},updateCard:async()=>{calls++;}};
 await deliverOutbox({store,client,mode:'production',chatId:'oc_active',allowedChats:['oc_active'],forbiddenChats:['oc_retired'],clock:()=>1000});
 assert.equal(calls,0);const row=store.db.prepare('SELECT delivered,last_error FROM outbox WHERE id=?').get(outboxId);assert.equal(row.delivered,-1);assert.equal(row.last_error,'selection_delivery_target_mismatch');
});
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
test('group file status creates once with a stable UUID and later revisions patch the same card',async()=>{
 const store=createStore(':memory:');const job=store.receiveGroupFile({id:'job',companyId:'company',chatId:'formal',messageId:'source',senderId:'member',createTime:'1',fileName:'a.pdf',fileKey:'file',replyTo:null},1);store.enqueueGroupFileStatus(job.id,{schema:'2.0',state:'received'},1);
 const calls=[];const client={sendCard:async(chat,card,uuid)=>{calls.push({kind:'send',chat,card,uuid});return'om_status';},updateCard:async(messageId,card)=>calls.push({kind:'update',messageId,card})};
 await deliverGroupFileStatus({store,client,mode:'production',chatId:'formal',allowedChats:['formal'],clock:()=>2});assert.equal(calls[0].uuid,job.statusCreateId);assert.equal(store.getGroupFileJob(job.id).statusMessageId,'om_status');
 store.enqueueGroupFileStatus(job.id,{schema:'2.0',state:'working'},3);await deliverGroupFileStatus({store,client,mode:'production',chatId:'formal',allowedChats:['formal'],clock:()=>4});assert.deepEqual(calls.map(call=>call.kind),['send','update']);assert.equal(calls[1].messageId,'om_status');
});
test('an uncertain group file status create never sends a second card after reconciliation expires',async()=>{
 const store=createStore(':memory:');const job=store.receiveGroupFile({id:'job',companyId:'company',chatId:'formal',messageId:'source',senderId:'member',createTime:'1',fileName:'a.pdf',fileKey:'file',replyTo:null},1);store.enqueueGroupFileStatus(job.id,{schema:'2.0'},1);let now=2,calls=0;const client={sendCard:async()=>{calls++;throw Error('unknown');}};
 await deliverGroupFileStatus({store,client,mode:'production',chatId:'formal',allowedChats:['formal'],clock:()=>now});now+=46*60000;await deliverGroupFileStatus({store,client,mode:'production',chatId:'formal',allowedChats:['formal'],clock:()=>now});assert.equal(calls,1);assert.equal(store.db.prepare('SELECT delivered FROM group_file_status_outbox').get().delivered,-1);store.close();
});

test('a scheduled project card rebind creates one new active card, retires the old card and rejects old callbacks',async t=>{
 const store=createStore(':memory:');t.after(()=>store.close());const now=Date.parse('2026-09-21T03:30:00Z');
 const input={companyId:'company',handoff:{schemaVersion:'1.0',status:'ready',superseded:false,latestDocumentVersion:'1',task:{taskId:'task',title:'项目'},snapshot:{documentVersion:'1',reportId:'report',checksum:'a'.repeat(64),generatedAt:'2026-09-18T01:00:00Z'},requirements:[],warnings:[],evidence:[]},companyMatchCard:{taskId:'task',runId:'22222222-2222-4222-8222-222222222222',documentVersion:1,sourceCardMessageId:'om_old',scopeType:'group',scopeId:'formal',companies:[{companyId:'company',companyName:'甲公司',profileVersion:'profile-1',enabled:true}]}};
 const assessment={decision:'review',blockers:[],actions:[],items:[]};
 store.saveProject({id:'project',taskId:'task',companyId:'company',version:'1',checksum:'a'.repeat(64),generatedAt:'2026-09-18T01:00:00Z',input,assessment,messageId:'om_old',created:now-1000,revision:1});
 store.transaction(()=>store.scheduleCardRebind({sourceJobId:'group-job',projectId:'project',chatId:'formal',now}));
 const calls=[];const client={sendCard:async(chat,card,uuid)=>{calls.push({kind:'send',chat,card,uuid});return'om_new';},updateCard:async(messageId,card)=>calls.push({kind:'update',messageId,card})};
 await deliverOutbox({store,client,mode:'production',chatId:'formal',allowedChats:['formal'],clock:()=>now});
 assert.equal(calls.filter(call=>call.kind==='send').length,1);assert.deepEqual(calls.filter(call=>call.kind==='update').map(call=>call.messageId),['om_new','om_old']);
 const activeCard=calls.find(call=>call.kind==='update'&&call.messageId==='om_new').card,reviewButton=activeCard.body.elements.flatMap(element=>element.columns?.[0]?.elements??[]).find(element=>element.text?.content==='查看公司匹配复核');
 assert.equal(reviewButton.behaviors[0].value.sourceCardMessageId,'om_new');
 assert.doesNotMatch(JSON.stringify(calls.at(-1).card),/"type":"callback"/);assert.match(JSON.stringify(calls.at(-1).card),/请使用最新项目卡/);
 assert.equal(store.getProject('project').messageId,'om_new');assert.equal(store.getPendingCardRebind('project','formal'),null);
 await deliverOutbox({store,client,mode:'production',chatId:'formal',allowedChats:['formal'],clock:()=>now+60000});assert.equal(calls.filter(call=>call.kind==='send').length,1);
 const workflow=createWorkflow({store,assess:()=>assessment,clock:()=>now,chatId:'formal',operatorIds:['actor']});const current=store.getProject('project'),base={projectId:'project',version:'1',cardKey:store.key(current.input,current.assessment),action:'follow',actorId:'actor',chatId:'formal'};
 assert.throws(()=>workflow.act({...base,messageId:'om_old',eventId:'old'}),/message_mismatch/);
 assert.equal(workflow.act({...base,messageId:'om_new',eventId:'new'}).status,'follow');
});

test('a card rebind retries retiring the old card without creating a second new card',async t=>{
 const store=createStore(':memory:');t.after(()=>store.close());let now=1000;
 const input={companyId:'company',handoff:{task:{taskId:'task',title:'项目'},requirements:[]}},assessment={decision:'review',blockers:[],actions:[]};
 store.saveProject({id:'project',taskId:'task',companyId:'company',version:'1',checksum:'a'.repeat(64),generatedAt:'2026-09-18T01:00:00Z',input,assessment,messageId:'om_old',created:1,revision:1});
 store.transaction(()=>store.scheduleCardRebind({sourceJobId:'group-job',projectId:'project',chatId:'formal',now}));
 let sends=0,oldUpdates=0;const client={sendCard:async()=>{sends++;return'om_new';},updateCard:async(messageId)=>{if(messageId==='om_old'&&oldUpdates++===0)throw Error('temporary');}};
 await deliverOutbox({store,client,mode:'production',chatId:'formal',allowedChats:['formal'],clock:()=>now});
 assert.equal(store.getProject('project').messageId,'om_new');assert.ok(store.getPendingCardRebind('project','formal'));
 now+=60000;await deliverOutbox({store,client,mode:'production',chatId:'formal',allowedChats:['formal'],clock:()=>now});
 assert.equal(sends,1);assert.equal(oldUpdates,2);assert.equal(store.getPendingCardRebind('project','formal'),null);
});
