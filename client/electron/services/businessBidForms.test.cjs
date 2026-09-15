const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildBusinessForm, resolveBusinessValues, companyProfileValues, applyBusinessFormValues } = require('./businessBidForms.cjs');
const company = '合成甲公司';
function state(fields, values = {}) { return { companyName: company, fieldValues: values, analysis: { fields }, companyProfiles: {} }; }
const f = (id, title, section = '投标函') => ({ id, title, section, kind: 'text' });

test('repeated company and representative fields are filled once without losing original ids', () => {
  const s = state([f('a','投标人名称'),f('b','供应商名称','报价表'),f('c','法定代表人姓名'),f('d','法定代表人姓名','授权书')], { representative: '合成人员' });
  const plan = buildBusinessForm(s);
  assert.equal(plan.fields.filter(x => x.key === 'representative').length, 1);
  assert.equal(plan.fields.find(x => x.key === 'representative').occurrences, 3);
  const v = resolveBusinessValues(s);
  assert.equal(v.a, company); assert.equal(v.b, company);
  assert.equal(v.c, '合成人员'); assert.equal(v.d, '合成人员');
});
test('manufacturer, historical project contacts and ambiguous people remain separate', () => {
  const s = state([f('m','单位名称','制造商资格声明'), f('p','联系人','历史业绩表'), f('n','姓名','人员名单')], { contact: '本公司联系人' });
  const plan = buildBusinessForm(s);
  for (const id of ['m','p','n']) assert.ok(plan.fields.some(x => x.key === id && x.scope === 'other'));
  assert.equal(resolveBusinessValues(s).p, '');
});
test('conflicting legacy values are preserved individually instead of overwritten by a common field', () => {
  const s = state([f('a','法定代表人姓名'),f('b','法定代表人姓名','授权书')], { a: '历史甲', b:'历史乙' });
  const plan = buildBusinessForm(s);
  assert.ok(plan.fields.some(x => x.key === 'a' && x.conflict));
  assert.equal(resolveBusinessValues(s).a, '历史甲'); assert.equal(resolveBusinessValues(s).b, '历史乙');
});
test('company profiles never leak to another company and do not persist project-specific delegates', () => {
  const s = state([f('a','法定代表人姓名')]);
  s.companyProfiles = { [company]: { representative: '甲法人', purchaser: '不应复用采购人', delegate:'不应复用授权人' }, '合成乙公司': { representative:'乙法人' } };
  assert.equal(resolveBusinessValues(s).a, '甲法人');
  s.companyName = '合成乙公司'; assert.equal(resolveBusinessValues(s).a, '乙法人');
  assert.deepEqual(companyProfileValues({ representative:'甲法人', purchaser:'采购方', delegate:'授权人', date:'日期' }), { representative:'甲法人' });
});
test('prices and signing fields stay manual even when populated in legacy storage', () => {
  const s = state([f('p','投标总价'), f('s','法定代表人签字')], { p:'123元',s:'代签名' });
  const plan = buildBusinessForm(s);
  assert.ok(plan.fields.find(x=>x.key==='s').readOnly);
  const v = resolveBusinessValues(s);
  assert.equal(v.p, ''); assert.equal(v.s, '');
});
test('template tags share known facts while unknown tags remain distinct inputs', () => {
  const s = state([], { representative:'合成人员', 'template:服务地点':'合成地点' });
  s.wordTemplate = { fields: ['公司名称','法定代表人姓名','服务地点','报价金额'] };
  const v = resolveBusinessValues(s);
  assert.equal(v['template:公司名称'], company);
  assert.equal(v['template:法定代表人姓名'], '合成人员');
  assert.equal(v['template:服务地点'], '合成地点');
  assert.equal(v['template:报价金额'], '');
});

test('editing or clearing one grouped value updates its occurrences without stale conflicts', () => {
  const s = state([f('a','法定代表人姓名'),f('b','法定代表人姓名')], { representative:'旧法人',a:'旧法人',b:'旧法人' });
  s.companyProfiles = { [company]: { representative:'已存法人' } };
  s.fieldValues = applyBusinessFormValues(s, { representative:'新法人' });
  assert.equal(resolveBusinessValues(s).a, '新法人');
  assert.equal(buildBusinessForm(s).fields.find(x=>x.key==='representative').conflict, false);
  s.fieldValues = applyBusinessFormValues(s, { representative:'' });
  assert.equal(resolveBusinessValues(s).a, '');
  assert.equal(resolveBusinessValues(s).representative, '');
});

test('text facts in a pricing form remain fillable while monetary amounts stay blank', () => {
  const s = state([f('a','法定代表人姓名','报价表'),f('b','投标人名称','报价表'),f('c','合计金额','报价表')], { representative:'合成人员' });
  const v = resolveBusinessValues(s);
  assert.equal(v.a, '合成人员'); assert.equal(v.b, company); assert.equal(v.c, '');
});

test('reviewer-only forms are retained as references without asking bidder to enter scores', () => {
  const s = state([f('r','总分','评分汇总表'),f('c','项目名称','资格审查表')], {r:'100'});
  const plan = buildBusinessForm(s);
  assert.ok(plan.fields.find(x=>x.key==='r').manualReason.includes('评审'));
  assert.equal(plan.editableCount,5);
  assert.equal(resolveBusinessValues(s).r,'');
});

test('a monetary section classification does not disable an ordinary project fact', () => {
  const item = {...f('place','项目地点','投标函—投标报价'),kind:'pricing'};
  const plan = buildBusinessForm(state([item],{place:'合成地点'}));
  assert.equal(plan.fields.find(x=>x.key==='place').readOnly,false);
  assert.equal(resolveBusinessValues(state([item],{place:'合成地点'})).place,'合成地点');
});

test('a verified single representative value survives an empty canonical value saved with legacy conflicts', () => {
  const s = state([f('a','法定代表人姓名'), f('b','法定代表人姓名','授权书')], { a:'旧甲', b:'旧乙' });
  const saved = applyBusinessFormValues(s, { representative:'', a:'核对后同一人', b:'核对后同一人' });
  assert.equal(saved.representative, '核对后同一人');
  assert.equal(saved.a, '核对后同一人');
  assert.equal(saved.b, '核对后同一人');
});

test('uppercase amount in a pricing form stays manual while ordinary pricing-form facts stay editable', () => {
  const s = state([
    {...f('amountUpper','大写','投标报价表'), kind:'pricing'},
    {...f('place','项目地点','投标报价表'), kind:'pricing'},
    {...f('term','合同期限','投标报价表'), kind:'pricing'},
  ], { amountUpper:'壹万元整', place:'贵阳', term:'30日' });
  const plan = buildBusinessForm(s);
  assert.equal(plan.fields.find(x => x.key === 'amountUpper').readOnly, true);
  assert.equal(resolveBusinessValues(s).amountUpper, '');
  assert.equal(plan.fields.find(x => x.key === 'place').readOnly, false);
  assert.equal(plan.fields.find(x => x.key === 'term').readOnly, false);
  assert.equal(resolveBusinessValues(s).place, '贵阳');
  assert.equal(resolveBusinessValues(s).term, '30日');
});

test('production supplier declaration keeps its unit name independent from the current bidder', () => {
  const s = state([f('manufacturer','单位名称','生产商资格声明')], { manufacturer:'第三方生产商' });
  const plan = buildBusinessForm(s);
  assert.equal(plan.fields.find(x => x.key === 'manufacturer').scope, 'other');
  assert.equal(resolveBusinessValues(s).manufacturer, '第三方生产商');
  assert.equal(resolveBusinessValues(state([f('manufacturer','单位名称','生产商资格声明')])).manufacturer, '');
});

test('verified representative aliases survive a simultaneous empty canonical save', () => {
  const s = state([f('a','法定代表人'), f('b','法人代表姓名','授权书')], { a:'旧甲', b:'旧乙' });
  const saved = applyBusinessFormValues(s, { representative:'', a:'核对后同一人', b:'核对后同一人' });
  assert.equal(saved.representative, '核对后同一人');
  assert.equal(saved.a, '核对后同一人');
  assert.equal(saved.b, '核对后同一人');
});

test('an existing representative can be explicitly cleared despite legacy conflict rows', () => {
  const s = state([f('a','法定代表人姓名'), f('b','法定代表人姓名','授权书')], {
    representative:'原法人', a:'另一个人', b:'另一个人',
  });
  const saved = applyBusinessFormValues(s, { representative:'' });
  assert.equal(saved.representative, '');
  assert.equal(saved.a, '另一个人');
  assert.equal(saved.b, '另一个人');
});

test('a profile-provided representative can be explicitly cleared despite legacy conflict rows', () => {
  const s = state([f('a','法定代表人姓名'), f('b','法定代表人姓名','授权书')], { a:'旧甲', b:'旧乙' });
  s.companyProfiles = { [company]: { representative:'公司资料法人' } };
  assert.equal(buildBusinessForm(s).fields.find(x => x.key === 'representative').value, '公司资料法人');
  const saved = applyBusinessFormValues(s, { representative:'', a:'核对后同一人', b:'核对后同一人' });
  assert.equal(saved.representative, '');
  assert.equal(saved.a, '核对后同一人');
  assert.equal(saved.b, '核对后同一人');
});
