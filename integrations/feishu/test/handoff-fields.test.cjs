const {test}=require('node:test');const assert=require('node:assert/strict');
const {deadlineFrom}=require('../main.cjs');const {buildCard}=require('../card.cjs');
const {resolveDeadline}=require('../handoff-fields.cjs');
const deadline=value=>({id:'basic:bidDeadline',key:'基础信息：bidDeadline',category:'basic',value,confidence:0.8,requiresConfirmation:false});
test('recognizes the real preread deadline field and Chinese time while rejecting ambiguity and invalid dates',()=>{
 assert.equal(deadlineFrom({requirements:[deadline('2026年09月30日 09时30分00秒')]}),'2026-09-30T09:30:00+08:00');
 assert.equal(deadlineFrom({requirements:[deadline('2026年10月09日 09时30分 （北京时间）')]}),'2026-10-09T09:30:00+08:00');
 for(const value of ['2026年02月30日 09时30分00秒','2026年09月30日 25时30分00秒'])assert.equal(deadlineFrom({requirements:[deadline(value)]}),'');
 assert.equal(deadlineFrom({requirements:[{...deadline('2026-09-30T09:30:00+08:00'),requiresConfirmation:true}]}),'');
 assert.equal(deadlineFrom({requirements:[{...deadline('2026-09-30T09:30:00+08:00'),confidence:undefined}]}),'');
 assert.equal(deadlineFrom({requirements:[{...deadline('2026-09-30T09:30:00+08:00'),confidence:1.1}]}),'');
 assert.equal(deadlineFrom({requirements:[deadline('2026-09-30T09:30:00+08:00'),deadline('2026-10-01T09:30:00+08:00')]}),'');
});
test('a corrected deadline replaces a persisted value and an unconfirmed correction clears it',()=>{
 const previous={deadline:'2026-09-30T09:30:00+08:00',handoff:{snapshot:{reportVersion:'r1'}}};
 const input={handoff:{snapshot:{reportVersion:'r2'},requirements:[deadline('2026-10-01T09:30:00+08:00')]}};
 assert.equal(resolveDeadline(input,previous),'2026-10-01T09:30:00+08:00');
 input.handoff.requirements[0].requiresConfirmation=true;assert.equal(resolveDeadline(input,previous),'');
 input.handoff.requirements=[];assert.equal(resolveDeadline(input,previous),'');
});
test('employee cards display Chinese field names for the real preread handoff',()=>{
 const card=buildCard({id:'p',version:'1',companyId:'测试公司',input:{handoff:{task:{title:'测试项目'},requirements:[deadline('2026年09月30日 09时30分00秒'),{id:'basic:ownerName',key:'基础信息：ownerName',category:'basic',value:'采购人',coordinate:'第3页'}]}},assessment:{decision:'review',blockers:[],actions:[]}});
 const text=JSON.stringify(card);assert.match(text,/投标截止/);assert.match(text,/招标人/);assert.doesNotMatch(text,/bidDeadline|ownerName/);
});
