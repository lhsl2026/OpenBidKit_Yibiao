const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runBusinessBidAnalysisTask } = require('./businessBidTask.cjs');
const emptyAnalysis = { directory: [], qualifications: [], disqualifications: [], fields: [], terms: [] };

function context(texts, responder) {
  const state = { files: texts.map((text, i) => ({ id: String(i), name: `合成${i}.md` })) };
  return { state, args: { workspaceStore: { loadBusinessBid: () => state, readSource: id => texts[Number(id)] },
    aiService: { getConfig: () => ({ context_length_limit: 400000 }), requestJson: responder },
    taskControl: { signal: new AbortController().signal }, updateTask() {},
    checkpointTask(task, patch) { Object.assign(state, patch, { analysisTask: task }); } } };
}
test('long tender is extracted in bounded segments without losing the last segment', async () => {
  let calls = 0;
  const text = '资格要求须提供有效证照。\n'.repeat(4000) + '\n最后要求：投标函须签章。';
  const ctx = context([text], async ({ messages }) => {
    calls += 1;
    return { ...emptyAnalysis, disqualifications: messages[1].content.includes('最后要求') ? [{ title: '投标函须签章', quote: '投标函须签章' }] : [] };
  });
  await runBusinessBidAnalysisTask(ctx.args);
  assert.ok(calls > 1, 'long files must not rely on a single oversized extraction');
  assert.equal(ctx.state.analysis.disqualifications.length, 1);
  assert.equal(ctx.state.analysisComplete, true);
  assert.equal(ctx.state.analysisCoverage.completed, calls);
});
test('failure preserves prior checkpoint without reporting complete', async () => {
  let calls = 0;
  const ctx = context(['第一文件要求', '第二文件要求'], async () => {
    if (++calls === 2) throw new Error('合成模型失败');
    return { ...emptyAnalysis, terms: [{ title: '第一文件要求', quote: '第一文件要求' }] };
  });
  await assert.rejects(() => runBusinessBidAnalysisTask(ctx.args), /合成模型失败/);
  assert.equal(ctx.state.analysis.terms.length, 1);
  assert.notEqual(ctx.state.analysisComplete, true);
});
test('cancelled analysis never requests a model', async () => {
  const ctx = context(['原文'], async () => { throw Error('must not call'); });
  ctx.args.taskControl.signal = AbortSignal.abort(new Error('cancelled'));
  await assert.rejects(() => runBusinessBidAnalysisTask(ctx.args), /cancelled/);
});

test('empty parsed sources fail preflight before any model call, including later files', async () => {
  let calls = 0;
  const ctx = context(['正常原文', ' \r\n\t'], async () => { calls++; return emptyAnalysis; });
  await assert.rejects(() => runBusinessBidAnalysisTask(ctx.args), /合成1.md.*原文.*空/);
  assert.equal(calls, 0);
  assert.notEqual(ctx.state.analysisComplete, true);
});

test('an entirely empty model extraction cannot be reported as complete', async () => {
  const ctx = context(['资格要求：营业执照'], async () => emptyAnalysis);
  await assert.rejects(() => runBusinessBidAnalysisTask(ctx.args), /未提取到.*要求/);
  assert.notEqual(ctx.state.analysisComplete, true);
});

test('a segment with no business requirements is allowed when another has requirements', async () => {
  let calls = 0;
  const ctx = context(['封面', '须提供营业执照'], async () => ++calls === 1 ? emptyAnalysis
    : { ...emptyAnalysis, qualifications: [{ title: '营业执照', quote: '须提供营业执照' }] });
  await runBusinessBidAnalysisTask(ctx.args);
  assert.equal(ctx.state.analysisComplete, true);
  assert.equal(ctx.state.analysis.qualifications.length, 1);
});

test('model errors identify the failing file and segment while keeping previous results', async () => {
  let calls = 0;
  const ctx = context(['第一条要求', '第二条要求'], async () => {
    if (++calls === 2) throw new Error('连接超时');
    return { ...emptyAnalysis, terms: [{ title: '第一条要求', quote: '第一条要求' }] };
  });
  await assert.rejects(() => runBusinessBidAnalysisTask(ctx.args), /合成1.md.*第 1 段.*连接超时/);
  assert.equal(ctx.state.analysis.terms.length, 1);
  assert.notEqual(ctx.state.analysisComplete, true);
});

test('cross-page quotes are repaired once using exact source lines without losing other requirements', async () => {
  let calls = 0;
  const source = '须提供功能截图，\n12\n| 类别 | 要求 |\n并加盖投标人公章。\n保证金须缴纳。';
  const ctx = context([source], async () => {
    calls++;
    if (calls === 1) return { ...emptyAnalysis, qualifications: [{ title: '截图盖章证明', quote: '须提供功能截图，并加盖投标人公章。' }], terms: [{ title: '缴纳保证金', quote: '保证金须缴纳。' }] };
    return { citations: [{ key: 'qualifications:0', startLine: 1, endLine: 4 }] };
  });
  await runBusinessBidAnalysisTask(ctx.args);
  assert.equal(calls, 2);
  assert.equal(ctx.state.analysis.qualifications[0].quote, source.split('\n').slice(0, 4).join('\n'));
  assert.equal(ctx.state.analysis.qualifications[0].title, '截图盖章证明');
  assert.equal(ctx.state.analysis.terms[0].quote, '保证金须缴纳。');
  assert.equal(ctx.state.analysisComplete, true);
});

test('missing, duplicate and out-of-source repair locations stop with a specific error and never loop', async () => {
  for (const citations of [[], [{ key: 'terms:0', startLine: 1, endLine: 99 }],
    [{ key: 'terms:0', startLine: 1, endLine: 1 }, { key: 'terms:0', startLine: 1, endLine: 1 }],
    [{ key: 'terms:0', startLine: null, endLine: null }]]) {
    let calls = 0;
    const ctx = context(['第一条原文'], async () => ++calls === 1
      ? { ...emptyAnalysis, terms: [{ title: '应复核的条款', quote: '模型改写的摘录' }] } : { citations });
    await assert.rejects(() => runBusinessBidAnalysisTask(ctx.args), /第 1 段.*原文定位/);
    assert.equal(calls, 2);
    assert.notEqual(ctx.state.analysisComplete, true);
  }
});
