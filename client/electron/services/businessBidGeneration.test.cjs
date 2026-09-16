const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildBusinessDraftPackets,
  normalizeGeneratedPart,
  mergeGeneratedParts,
} = require('./businessBidGeneration.cjs');

function stateFixture() {
  const item = (id, title, group, section, kind = 'text') => ({
    id, title, group, section, kind, quote: `${title}原文`, sourceName: '招标文件.pdf', segment: 1,
  });
  return {
    analysisConfirmed: true,
    companyName: '贵州云界科创信息技术有限公司',
    projectName: '智慧医院项目',
    deadline: '2026-10-01',
    fieldValues: {
      purchaser: '某医院', projectNo: 'GZ-2026-01', representative: '李某', delegate: '王某',
    },
    analysis: {
      directory: [item('d1', '投标函', 'directory', '投标文件格式')],
      qualifications: [
        item('q1', '提供营业执照', 'qualifications', '资格审查'),
        item('q2', '提供近三年类似业绩', 'qualifications', '资格审查'),
      ],
      disqualifications: [item('x1', '未按要求签字盖章的投标无效', 'disqualifications', '无效投标')],
      fields: [
        item('f1', '法定代表人姓名', 'fields', '法定代表人身份证明'),
        item('f2', '投标总价', 'fields', '开标一览表', 'pricing'),
      ],
      terms: [
        item('t1', '服务期三年', 'terms', '商务要求'),
        item('t2', '验收合格后付款', 'terms', '合同条款'),
      ],
    },
    evidence: [{
      id: 'e1', kind: 'qualification', name: '营业执照', certificateName: '', companyId: '贵州云界科创信息技术有限公司',
      eligible: true, confirmed: true, requirementIds: ['q1'], files: [{ name: '营业执照.pdf', sha256: 'a'.repeat(64) }], details: {},
    }],
  };
}

test('draft packets keep every extracted requirement exactly once and stay bounded', () => {
  const packets = buildBusinessDraftPackets(stateFixture(), { maxItems: 2, maxChars: 4000 });
  const ids = packets.flatMap(packet => packet.requirements.map(item => item.id));
  assert.deepEqual(ids.sort(), ['d1', 'f1', 'f2', 'q1', 'q2', 't1', 't2', 'x1'].sort());
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(packets.every(packet => packet.requirements.length <= 2));
  assert.ok(packets.every(packet => packet.context.companyName === '贵州云界科创信息技术有限公司'));
  assert.ok(packets.some(packet => packet.context.evidence.some(item => item.name === '营业执照')));
});

test('generated part rejects unknown coverage ids and completed signature claims', () => {
  const packet = buildBusinessDraftPackets(stateFixture(), { maxItems: 20 })[0];
  assert.throws(() => normalizeGeneratedPart({ sections: [{ title: '投标函', content: '完整正文', requirementIds: ['unknown'] }], pending: [] }, packet), /未知要求编号/);
  assert.throws(() => normalizeGeneratedPart({ sections: [{ title: '投标函', content: '法定代表人已签字并盖章完毕', requirementIds: [packet.requirements[0].id] }], pending: [] }, packet), /签字或盖章/);
});

test('merged draft contains useful prose and deterministic full-coverage matrices', () => {
  const state = stateFixture();
  const packets = buildBusinessDraftPackets(state, { maxItems: 20 });
  const parts = packets.map(packet => normalizeGeneratedPart({
    sections: [{
      title: packet.title,
      content: `本章节根据${packet.requirements.map(item => item.title).join('、')}编制。缺失位置使用【待补：必要信息】。`,
      requirementIds: packet.requirements.slice(0, 1).map(item => item.id),
    }],
    pending: [{ label: '必要信息', reason: '资料未提供', source: packet.title }],
  }, packet));
  const draft = mergeGeneratedParts(state, parts);
  const text = draft.sections.map(section => `${section.title}\n${section.content}`).join('\n');
  for (const id of ['q1', 'q2', 't1', 't2', 'x1']) assert.match(text, new RegExp(id));
  assert.match(text, /营业执照\.pdf/);
  assert.match(text, /提交前人工确认/);
  assert.doesNotMatch(text, /草稿，需逐项核对招标文件原始格式/);
  assert.ok(draft.pending.some(item => item.label === '投标总价'));
});

test('same chapter title from split packets is merged into one ordered chapter', () => {
  const state = stateFixture();
  const draft = mergeGeneratedParts(state, [
    { sections: [{ id: 'p1', title: '资格审查响应', content: '第一批资格要求正文', requirementIds: ['q1'] }], pending: [] },
    { sections: [{ id: 'p2', title: '资格审查响应', content: '第二批资格要求正文', requirementIds: ['q2'] }], pending: [] },
  ]);
  const matches = draft.sections.filter(section => section.title === '资格审查响应');
  assert.equal(matches.length, 1);
  assert.match(matches[0].content, /第一批资格要求正文[\s\S]*第二批资格要求正文/);
  assert.equal(draft.coverage.modelCovered, 2);
});
