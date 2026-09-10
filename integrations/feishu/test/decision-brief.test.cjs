'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {buildDecisionBrief}=require('../decision-brief.cjs');

test('missing business facts stay unverified instead of borrowing words from redline clauses',()=>{
 const requirements=[
  {id:'q-license',key:'资格要求',category:'qualification',value:'提供统一社会信用代码营业执照'},
  {id:'q-credit',key:'资格要求',category:'qualification',value:'未列入重大税收违法失信主体名单'},
  {id:'r-budget',key:'废标条款',category:'redline',value:'报价超过预算且采购人不能支付时废标'},
  {id:'r-guarantee',key:'废标条款',category:'redline',value:'未交投标保证金则投标无效'},
 ];
 const project={companyId:'隆创信息有限公司',input:{handoff:{task:{title:'测试'},requirements}},assessment:{decision:'review',items:[{requirementId:'q-license',category:'qualification',status:'review',reasons:[]},{requirementId:'q-credit',category:'qualification',status:'review',reasons:[]},{requirementId:'r-budget',category:'redline',status:'review',reasons:[]},{requirementId:'r-guarantee',category:'redline',status:'review',reasons:[]}]}};
 const brief=buildDecisionBrief(project);
 assert.equal(brief.facts.find(f=>f.label==='预算/最高限价').value,'待核实');
 assert.equal(brief.facts.find(f=>f.label==='付款条件').value,'待核实');
 assert.equal(brief.facts.find(f=>f.label==='投标保证金').value,'待核实');
 assert.match(brief.risks.join('\n'),/主体资格/);
 assert.match(brief.risks.join('\n'),/信用记录/);
});
test('the top three risks omit non-blocking disclosures and surface evidence checks first',()=>{
 const requirements=[
  {id:'q-sme',key:'资格要求',category:'qualification',value:'本项目非专门面向中小企业采购'},
  {id:'q-none',key:'资格要求',category:'qualification',value:'本项目无特殊行业资质或要求'},
  {id:'q-finance',key:'资格要求',category:'qualification',value:'提供2025年度财务审计报告或银行资信证明'},
 ];
 const project={companyId:'隆创信息有限公司',input:{handoff:{task:{title:'测试'},requirements}},assessment:{decision:'review',items:requirements.map(requirement=>({requirementId:requirement.id,category:requirement.category,status:'review',reasons:['structured_rule_missing']}))}};
 const risks=buildDecisionBrief(project).risks.join('\n');
  assert.doesNotMatch(risks,/非专门面向中小企业|无特殊行业资质/);
  assert.match(risks,/财务能力/);
  assert.match(risks.split('\n')[0],/财务能力/);
});
