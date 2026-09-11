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
