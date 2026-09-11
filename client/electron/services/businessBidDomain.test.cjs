const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { normalizeAnalysis, importEvidence, buildDraft, mergeAnalysis, businessDate } = require('./businessBidDomain.cjs');
const emptyAnalysis = { directory: [], qualifications: [], disqualifications: [], fields: [], terms: [] };

const companyId = '隆创信息有限公司';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '商务标-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, '原件.pdf'), 'synthetic evidence');
  const sha256 = createHash('sha256').update('synthetic evidence').digest('hex');
  const row = { id: 'p1', kind: 'performance', name: '合成医院业绩', companyId, verified: true,
    attachments: [{ relative_path: '原件.pdf', verified: true, sha256 }] };
  return { root, row };
}
test('only verified target ownership and intact attachments make a candidate eligible', (t) => {
  const { root, row } = fixture(t);
  const result = importEvidence({ records: [row, { ...row, id: 'p2', companyId: '江苏隆创信息技术有限公司' },
    { ...row, id: 'p3', verified: false }, { ...row, id: 'p4', attachments: [] }] }, root, '2026-09-11');
  assert.equal(result.excluded, 1);
  assert.deepEqual(result.items.map(x => x.eligible), [true, false, false]);
  assert.ok(result.items.every(x => x.confirmed === false));
});
test('tampered originals and personnel without employment proof cannot be used', (t) => {
  const { root, row } = fixture(t);
  const snapshot = { records: [{ ...row, kind: 'certificate', expires_on: '2030-01-01' }] };
  assert.equal(importEvidence(snapshot, root, '2026-09-11').items[0].eligible, false);
  fs.writeFileSync(path.join(root, '原件.pdf'), 'changed');
  assert.equal(importEvidence({ records: [row] }, root, '2026-09-11').items[0].eligible, false);
});
test('expired certificates remain pending', (t) => {
  const { root, row } = fixture(t);
  const result = importEvidence({ records: [{ ...row, kind: 'qualification', expires_on: '2026-01-01' }] }, root, '2026-09-11');
  assert.equal(result.items[0].eligible, false);
  assert.match(result.items[0].reason, /有效期/);
});
test('analysis accepts only quotes present in this source and preserves provenance', () => {
  const source = { id: 'f1', name: '合成招标.md', segment: 1, text: '投标人须提供营业执照。' };
  const result = normalizeAnalysis({ ...emptyAnalysis, qualifications: [{ title: '营业执照', quote: '须提供营业执照' }] }, source);
  assert.equal(result.qualifications[0].sourceId, 'f1');
  assert.throws(() => normalizeAnalysis({ ...emptyAnalysis, fields: [{ title: '凭空字段', quote: '没有的原文' }] }, source), /原文/);
});

test('same field in different forms and segments is preserved', () => {
  const source = { id: 'f1', name: '合成.md', segment: 1, text: '投标人名称：' };
  const part = normalizeAnalysis({ ...emptyAnalysis, fields: [
    { title: '投标人名称', quote: '投标人名称：', section: '投标函' },
    { title: '投标人名称', quote: '投标人名称：', section: '授权书' },
  ] }, source);
  assert.equal(mergeAnalysis([part]).fields.length, 2);
  const another = normalizeAnalysis({ ...emptyAnalysis, fields: [{ title: '投标人名称', quote: '投标人名称：', section: '授权书' }] }, { ...source, segment: 2 });
  assert.equal(mergeAnalysis([part, another]).fields.length, 3);
});
test('malformed model shape is not accepted as empty complete extraction', () => {
  assert.throws(() => normalizeAnalysis({ unexpected: 'wrong' }, { text: '' }), /格式/);
});
test('SQLite integer permanent certificates remain eligible', (t) => {
  const { root, row } = fixture(t);
  assert.equal(importEvidence({ records: [{ ...row, kind: 'qualification', permanent: 1 }] }, root, '2026-09-11').items[0].eligible, true);
});
test('certificate date follows Shanghai business date across UTC midnight', () => {
  assert.equal(businessDate(new Date('2026-09-10T17:00:00Z')), '2026-09-11');
});
test('draft blocks unreviewed analysis and never inserts quote values', () => {
  assert.throws(() => buildDraft({}), /确认/);
  const state = { analysisConfirmed: true, analysis: { directory: [], qualifications: [], disqualifications: [], terms: [],
    fields: [{ id: 'f', title: '投标总价', quote: '总价', sourceName: '合成', segment: 1 }] }, fieldValues: { f: '999999元' }, evidence: [], projectName: '合成验收' };
  const draft = buildDraft(state);
  const text = JSON.stringify(draft);
  assert.ok(!text.includes('999999'));
  for (const title of ['投标函', '法定代表人身份证明', '授权委托书', '资格资料', '商务偏离表', '政策声明', '报价表', '待补资料清单']) assert.ok(text.includes(title), title);
  assert.match(text, /待核实/);
});
test('unconfirmed or ineligible evidence never enters the document as company material', () => {
  const state = { analysisConfirmed: true, analysis: {}, evidence: [
    { id: 'x', name: '不应采用的资质', eligible: false, confirmed: true },
    { id: 'y', name: '尚未选择的业绩', eligible: true, confirmed: false }], fieldValues: {} };
  const draft = buildDraft(state);
  assert.ok(!JSON.stringify(draft.sections).includes('不应采用的资质'));
  assert.ok(!JSON.stringify(draft.sections).includes('尚未选择的业绩'));
});
