'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createServer } = require('node:http');
const { runSyntheticWritingAcceptance } = require('../synthetic-writing-acceptance.cjs');

test('synthetic Codex text route completes real isolated Electron prepare, both directory gates, facts gate, content and DOCX export', { timeout: 120000 }, async t => {
  const clientRoot = path.resolve(__dirname, '../../../client');
  const electronPath = path.join(clientRoot, 'node_modules/electron/dist/electron.exe');
  if (!fs.existsSync(electronPath)) { t.skip('Electron binary not installed'); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-writing-acceptance-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    if (body.tools || body.messages.some(x => !['system', 'user', 'assistant', 'developer'].includes(x.role))) { res.writeHead(400); res.end('{"error":{"message":"tools_forbidden"}}'); return; }
    const structured = { outline: [{ id: '1', title: '实施方案', description: '需求确认、安排与交付检查' }, { id: '2', title: '质量保障', description: '过程记录、问题复核与验收核对' }], groups: [{ id: 'scope', title: '项目范围', content: '- 人员：【待填写】\n- 范围：实施方案及质量保障。' }], writing_focus: '围绕合成材料的技术要求编写，未知人员使用【待填写】', knowledge: { item_ids: [] }, facts: { titles: ['项目范围'] }, table: { needed: false }, conflicts: [], patches: [] };
    const content = body.response_format ? JSON.stringify(structured) : '本方案仅用于合成验收，围绕需求确认、任务安排、交付检查与过程记录开展工作。实施前核对任务范围，形成清晰的工作清单；实施中记录关键活动，发现问题后组织复核并保存处理结果；交付时根据原始要求逐项核对，保证材料完整、口径一致。人员信息使用【待填写】，未经核实的信息不作为承诺依据。质量检查遵循材料要求，持续跟踪问题处理情况，相关记录由指定人员复核，确认后归档保存。';
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const config = { dataRoot: path.join(root, 'unused-live-data'), clientRoot, electronPath, modelConfig: { backend: 'codex', provider: 'custom', api_key: 'synthetic-fake-model', base_url: 'http://127.0.0.1:' + server.address().port + '/v1', model_name: 'fake-model' } };
  const report = await runSyntheticWritingAcceptance({ config, outputRoot: path.join(root, 'acceptance') });
  assert.equal(report.completed, true);
  assert.deepEqual(report.steps.map(x => x.label), ['prepare', 'outline_selection', 'outline', 'global_facts', 'content', 'export']);
  assert.ok(requests.length >= 6); assert.ok(requests.every(x => !x.tools && !x.reasoning_effort));
  assert.ok(fs.statSync(report.steps.at(-1).result.artifacts[0].path).size > 1000);
});
