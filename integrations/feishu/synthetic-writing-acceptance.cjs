'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { runWritingJob } = require('./writing.cjs');

// This fixture is wholly synthetic. Only this isolated acceptance entry point
// confirms its own generated directory and fact candidates automatically.
async function runSyntheticWritingAcceptance({ config, outputRoot, onStep = () => {} }) {
  const root = path.resolve(outputRoot);
  const relative = path.relative(path.resolve(config.dataRoot), root);
  if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw Error('acceptance_requires_separate_root');
  if (config.modelConfig?.backend !== 'codex') throw Error('acceptance_requires_codex_backend');
  fs.mkdirSync(root, { recursive: true });
  if (fs.readdirSync(root).length) throw Error('acceptance_root_must_be_empty');
  const writingRoot = path.join(root, 'writing'), sourcePath = path.join(writingRoot, 'sources', '合成验收招标文件.md');
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  const title = '【合成验收・非真实投标】两节短技术方案';
  const source = '# ' + title + '\n\n这是软件联调的合成材料，不对应真实采购、投标、公司或人员。\n技术响应仅含两个一级叶子章节，不增设下级目录：一、实施方案；二、质量保障。每节约200字。实施方案说明需求确认、任务安排及交付检查；质量保障说明过程记录、问题复核及验收核对。无需插图、表格、预算、商务或报价内容。\n未知人员、证书、设备及日期必须逐字写【待填写】，不得杜撰。\n';
  fs.writeFileSync(sourcePath, source, 'utf8');
  const checksum = createHash('sha256').update(source).digest('hex');
  const taskId = randomUUID(), projectId = randomUUID();
  const job = { id: randomUUID(), projectId, companyId: 'synthetic-acceptance-company', stage: 'prepare', confirmed: true, sourcePath, project: { overview: title, wordControlOptions: { sectionWords: 200, strictSectionWords: false, minimumWords: 0, maximumWords: 0 } }, handoff: { schemaVersion: '1.0', task: { taskId, title }, snapshot: { documentVersion: 'synthetic-v1', reportId: randomUUID(), checksum, generatedAt: new Date().toISOString() }, latestDocumentVersion: 'synthetic-v1', status: 'ready', requirements: [{ key: 'synthetic_scope', value: '仅实施方案和质量保障两个一级叶子章节，每节约200字；未知事实【待填写】', category: 'technical', confidence: 1, requiresConfirmation: false, coordinate: '合成材料第1段' }], evidence: [{ requirementId: 'synthetic_scope', quote: '技术响应仅含两个一级叶子章节', page: 1 }], warnings: [] } };
  fs.writeFileSync(path.join(root, 'fixture.json'), JSON.stringify(job, null, 2));
  const report = { synthetic: true, title, steps: [] };
  const run = async (label, stage, confirmations = {}) => {
    const result = await runWritingJob({ job: { ...job, stage, confirmations }, root: writingRoot, electronPath: config.electronPath, clientRoot: config.clientRoot, modelConfig: config.modelConfig, timeoutMs: 30 * 60 * 1000 });
    report.steps.push({ label, result }); fs.writeFileSync(path.join(root, 'acceptance.json'), JSON.stringify(report, null, 2)); onStep(label, result);
    if (result.status === 'failed') throw Error('synthetic_' + label + '_failed:' + result.code);
    return result;
  };
  const prepared = await run('prepare', 'prepare'); if (prepared.status !== 'completed') throw Error('synthetic_prepare_incomplete');
  const selection = await run('outline_selection', 'outline');
  if (selection.confirmation?.type !== 'outline_selection' || selection.confirmation.items.length !== 2) throw Error('synthetic_expected_two_roots');
  const outline = await run('outline', 'outline', { outlineSelection: { taskId: selection.confirmation.taskId, challenge: selection.confirmation.challenge, selectedIds: selection.confirmation.items.map(x => x.id) } });
  if (outline.confirmation?.type !== 'outline') throw Error('synthetic_outline_confirmation_missing');
  const roots = outline.confirmation.outlineData.outline;
  if (roots.length !== 2 || roots.some(x => x.children?.length)) throw Error('synthetic_expected_two_leaf_sections');
  const outlineApproval = { challenge: outline.confirmation.challenge, approved: true };
  const facts = await run('global_facts', 'content', { outlineApproval });
  if (facts.confirmation?.type !== 'global_facts' || !facts.confirmation.groups.length) throw Error('synthetic_fact_confirmation_missing');
  const content = await run('content', 'content', { outlineApproval, globalFacts: { challenge: facts.confirmation.challenge, groups: facts.confirmation.groups } });
  if (content.status !== 'completed') throw Error('synthetic_content_requires_review');
  const exported = await run('export', 'export');
  if (exported.status !== 'completed' || !exported.artifacts?.length) throw Error('synthetic_export_missing');
  report.completed = true; fs.writeFileSync(path.join(root, 'acceptance.json'), JSON.stringify(report, null, 2));
  return report;
}
if (require.main === module) {
  const index = process.argv.indexOf('--output-root');
  if (index < 0 || !process.argv[index + 1]) { console.error('usage: node --env-file=<config> synthetic-writing-acceptance.cjs --output-root <new separate directory>'); process.exitCode = 1; }
  else runSyntheticWritingAcceptance({ config: require('./config.cjs').loadConfig(), outputRoot: process.argv[index + 1], onStep: (stage, result) => console.log(JSON.stringify({ stage, status: result.status, code: result.code })) }).then(report => console.log(JSON.stringify({ completed: report.completed, artifact: report.steps.at(-1).result.artifacts[0].path }))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { runSyntheticWritingAcceptance };
