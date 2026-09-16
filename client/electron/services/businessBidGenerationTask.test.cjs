const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runBusinessBidGenerationTask } = require('./businessBidGenerationTask.cjs');

function stateFixture() {
  const req = (id, title, section) => ({ id, title, quote: `${title}原文`, section, kind: 'text', sourceName: '招标文件.pdf', segment: 1 });
  return {
    analysisConfirmed: true,
    companyName: '贵州云界科创信息技术有限公司',
    projectName: '智慧医院项目', deadline: '2026-10-01', fieldValues: {}, evidence: [],
    analysis: {
      directory: [req('d1', '投标函', '投标文件格式')],
      qualifications: [req('q1', '营业执照', '资格审查')],
      disqualifications: [req('x1', '未签章无效', '无效投标')],
      fields: [], terms: [req('t1', '服务期三年', '商务要求')],
    },
  };
}

test('generation task calls the selected AI flow for every packet and persists one complete draft', async () => {
  const calls = [];
  const checkpoints = [];
  const state = stateFixture();
  await runBusinessBidGenerationTask({
    workspaceStore: { loadBusinessBid: () => state, verifyGenerationInputs: () => undefined },
    aiService: { requestJson: async request => {
      calls.push(request);
      const packet = JSON.parse(request.messages[1].content.match(/当前要求（id 是覆盖审校键）：\n([\s\S]*?)\n\n输出要求：/)[1]);
      return { sections: [{ title: `专业章节${calls.length}`, content: `已根据${packet.map(item => item.title).join('、')}形成完整正文。`, requirementIds: packet.map(item => item.id) }], pending: [] };
    } },
    updateTask: () => undefined,
    checkpointTask: (task, workspace = {}) => { checkpoints.push({ task, workspace }); },
    taskControl: { signal: { throwIfAborted: () => undefined } },
  });
  assert.equal(calls.length, 4);
  assert.ok(calls.every(call => call.messages[0].content.includes('资深商务投标文件编制人员')));
  const final = checkpoints.at(-1);
  assert.equal(final.task.status, 'success');
  assert.equal(final.workspace.generationComplete, true);
  assert.ok(final.workspace.draft.sections.some(section => section.title === '资格审查符合性对照表'));
  assert.equal(final.workspace.draft.coverage.total, 4);
});

test('generation task rejects empty model chapters without replacing a previous draft', async () => {
  const checkpoints = [];
  await assert.rejects(() => runBusinessBidGenerationTask({
    workspaceStore: { loadBusinessBid: () => stateFixture(), verifyGenerationInputs: () => undefined },
    aiService: { requestJson: async () => ({ sections: [], pending: [] }) },
    updateTask: () => undefined,
    checkpointTask: (task, workspace = {}) => { checkpoints.push({ task, workspace }); },
    taskControl: { signal: { throwIfAborted: () => undefined } },
  }), /没有生成有效章节/);
  assert.ok(checkpoints.every(checkpoint => !Object.hasOwn(checkpoint.workspace, 'draft')));
});
