'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCodexWritingAdapter, createTextOnlyAgentService, textOnlyContentOptions, normalizeCodexModelConfig } = require('../codex-writing.cjs');

function fixture(responses) {
  let state = { workflowKind: 'technical-plan', projectOverview: '合成验收项目', techRequirements: '仅技术方案；未知事实用【待填写】', globalFactsMode: 'placeholder', outlineWordControlOptions: { sectionWords: 200 } };
  const calls = [];
  const workspaceStore = { loadTechnicalPlan: () => structuredClone(state), readTenderMarkdown: () => '# 合成验收\n仅两节短技术方案。', updateTechnicalPlan: partial => { state = { ...state, ...partial }; return state; } };
  const aiService = { chat: async request => { calls.push(request); return JSON.stringify(responses.shift()); } };
  const adapter = createCodexWritingAdapter({ aiService, workspaceStore, knowledgeBaseService: {}, runGlobalFactsTask: async ({ payload, checkpointTask }) => { assert.equal(payload.globalFactsMode, 'placeholder'); checkpointTask({ status: 'success', progress: 100 }, { globalFacts: [{ id: 'fact', title: '项目事实', content: '人员：【待填写】' }] }); } });
  return { adapter, calls, state: () => workspaceStore.loadTechnicalPlan(), workspaceStore };
}
test('pure text outline has durable root selection, expands only selected scope and uses AI leaves', async () => {
  const f = fixture([{ outline: [{ title: '实施方案', description: '实施' }, { title: '质量保障', description: '质量' }] }, { outline: [{ id: '2', title: '质量保障', description: '质量', children: [{ title: '检查流程', description: '检查' }] }] }]);
  await f.adapter.generateInitialOutline();
  const before = f.state();
  assert.equal(before.outlineData, undefined); assert.equal(before.outlineGenerationTask.stats.outline_selection.confirmed, false);
  assert.equal(before.outlineGenerationTask.stats.outline_selection.items.length, 2);
  await f.adapter.expandOutline(['2']);
  const after = f.state(); assert.equal(after.outlineGenerationTask.status, 'success');
  assert.equal(after.outlineData.outline.length, 1); assert.equal(after.outlineData.outline[0].title, '质量保障');
  assert.equal(after.outlineData.outline[0].children[0].content_mode, 'ai-generate');
  assert.equal(after.outlineWordControlSnapshot.sectionWords, 200);
  assert.ok(f.calls.every(x => x.response_format.type === 'json_object' && !x.tools));
  assert.ok(f.calls.every(x => x.timeout_ms === 600000));
});
test('invalid root scope or tool-dependent output is rejected without replacing the selected directory', async () => {
  const f = fixture([{ outline: [{ title: '技术方案', description: '方案' }] }, { outline: [{ id: '1', title: '伪造新范围', children: [{ title: 'x' }] }] }]);
  await f.adapter.generateInitialOutline();
  await assert.rejects(f.adapter.expandOutline(['missing']), /outline_selection_invalid/);
  assert.equal(f.calls.length, 1);
  await assert.rejects(f.adapter.expandOutline(['1']), /outline_scope_changed/);
  assert.equal(f.state().outlineData, undefined);
});
test('existing pure text V1 fact runner persists candidate facts with placeholder mode', async () => {
  const f = fixture([]); await f.adapter.generateFacts();
  assert.equal(f.state().globalFactsTask.status, 'success'); assert.match(f.state().globalFacts[0].content, /待填写/);
});
test('global fact bridge timeouts remain distinguishable from generic generation failures', async () => {
  let state = { workflowKind: 'technical-plan', projectOverview: '合成验收项目', techRequirements: '', globalFactsMode: 'placeholder', outlineData: { outline: [{ id: '1', title: '实施方案', content_mode: 'ai-generate' }] } };
  const workspaceStore = { loadTechnicalPlan: () => structuredClone(state), readTenderMarkdown: () => '# 招标文件', updateTechnicalPlan: partial => { state = { ...state, ...partial }; return state; } };
  const adapter = createCodexWritingAdapter({
    aiService: {}, workspaceStore, knowledgeBaseService: {},
    runGlobalFactsTask: async () => { throw Object.assign(new Error('execution_timeout'), { code: 'execution_timeout' }); },
  });
  await assert.rejects(adapter.generateFacts(), error => error.code === 'codex_fact_generation_timeout');
  assert.equal(state.globalFactsTask.status, 'error');
  assert.equal(state.globalFactsTask.error, 'codex_fact_generation_timeout');
});
test('Codex Agent facade cannot start tools even from a bound task context; content options cannot enable Agent features', async () => {
  const agent = createTextOnlyAgentService();
  await assert.rejects(agent.runTask({}), /codex_nested_agent_disabled/);
  await assert.rejects(agent.bindTaskContext().runTask({}), /codex_nested_agent_disabled/);
  assert.equal(agent.hasPersistentTaskSession(), false);
  const options = textOnlyContentOptions({ useAiImages: true, useHtmlImages: true, useMermaidImages: true, consistencyRepairMode: 'agent', enableOriginalPlanCoverageAudit: true });
  assert.equal(options.useAiImages, false); assert.equal(options.useHtmlImages, false); assert.equal(options.useMermaidImages, false);
  assert.equal(options.consistencyRepairMode, 'normal'); assert.equal(options.enableOriginalPlanCoverageAudit, false);
});

test('Codex explicitly replaces an existing custom model profile in the real EasyBid config store', t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-writing-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { createConfigStore } = require('../../../client/electron/services/configStore.cjs');
  const store = createConfigStore({ getPath: () => root });
  store.save({ text_model_provider: 'custom', text_model_profiles: { custom: { api_key: 'old-key', base_url: 'https://old.invalid/v1', model_name: 'old-model', reasoning_effort: 'high' } } });
  const config = normalizeCodexModelConfig({ backend: 'codex', provider: 'custom', api_key: 'bridge-key', base_url: 'http://127.0.0.1:4383/v1', model_name: 'gpt-6-astra' });
  assert.equal(store.save(config).success, true);
  const saved = store.load();
  assert.equal(saved.api_key, 'bridge-key'); assert.equal(saved.base_url, config.base_url); assert.equal(saved.model_name, 'gpt-6-astra');
  assert.equal(saved.text_model_profiles.custom.api_key, 'bridge-key'); assert.equal(saved.reasoning_effort, ''); assert.equal(saved.concurrency_limit, 1);
});
