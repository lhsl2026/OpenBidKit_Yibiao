'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

const marker = '真实文件流程验收稿，不代表公司决定投标';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'real-writing-acceptance-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, 'live-data');
  const sourcePath = path.join(dataRoot, 'writing', 'sources', '真实招标文件.pdf');
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, '%PDF-1.7\n真实招标文件\n%%EOF');
  const checksum = createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex');
  const project = {
    id: 'live-project', taskId: 'live-task', companyId: '隆创信息有限公司', version: '1', checksum,
    current: true, humanDecision: null, assessment: { decision: 'review' },
    input: { sourcePath, handoff: {
      schemaVersion: '1.0', task: { taskId: 'live-task', title: '医院信息化采购项目' },
      snapshot: { documentVersion: '1', reportVersion: 'r4', reportId: 'report-1', checksum: 'sha256:' + checksum, generatedAt: '2026-09-10T00:00:00Z' },
      latestDocumentVersion: '1', status: 'needs_manual', superseded: false,
      requirements: [{ key: '资格', value: '材料待核实', category: 'qualification', requiresConfirmation: true, confidence: 0.9 }],
      evidence: [{ requirementId: '资格', page: 6, quote: '材料待核实' }], warnings: [{ code: 'report_requires_review', blocked: true, message: '存在未通过原文核验的提取条目' }],
    } },
  };
  return { root, dataRoot, sourcePath, project };
}

test('runs the real document through every isolated confirmation stage and records delivery readback', async t => {
  const { runRealWritingAcceptance } = require('../real-writing-acceptance.cjs');
  const { root, dataRoot, project } = fixture(t);
  const original = structuredClone(project);
  const calls = [];
  const runStage = async ({ job }) => {
    calls.push(structuredClone(job));
    assert.match(job.handoff.task.title, new RegExp(marker));
    assert.match(job.project.overview, new RegExp(marker));
    assert.equal(job.handoff.status, 'ready');
    assert.match(JSON.stringify(job.handoff.warnings), /原始预读状态 needs_manual/);
    if (job.stage === 'prepare') return { status: 'completed', stage: 'prepare' };
    if (job.stage === 'outline' && !job.confirmations?.outlineSelection) return { status: 'waiting_confirmation', confirmation: { type: 'outline_selection', taskId: 'outline-task', challenge: 'select-1', items: [{ id: 'a', title: '项目理解' }, { id: 'b', title: '实施方案' }, { id: 'c', title: '质量保障' }] } };
    if (job.stage === 'outline') return { status: 'waiting_confirmation', confirmation: { type: 'outline', challenge: 'outline-1', outlineData: { project_name: marker, outline: [{ id: 'a', title: '项目理解', children: [] }, { id: 'b', title: '实施方案', children: [] }] } } };
    if (job.stage === 'content' && !job.confirmations?.globalFacts) return { status: 'waiting_confirmation', confirmation: { type: 'global_facts', challenge: 'facts-1', groups: [{ name: '公司人员', items: [{ key: '项目经理', value: '【待填写】' }] }] } };
    if (job.stage === 'content' && !job.confirmations?.contentDecision) return { status: 'waiting_confirmation', confirmation: { type: 'content_decision', challenge: 'retry-1', failedSections: [{ id: 'b', title: '实施方案' }] } };
    if (job.stage === 'content') return { status: 'completed', stage: 'content' };
    if (job.stage === 'export') {
      const artifact = path.join(root, 'result.docx'); fs.writeFileSync(artifact, 'docx');
      return { status: 'completed', stage: 'export', artifacts: [{ kind: 'word', path: artifact, sha256: createHash('sha256').update('docx').digest('hex'), size: 4 }] };
    }
    throw Error('unexpected stage');
  };
  let checks = 0;
  const report = await runRealWritingAcceptance({
    config: { dataRoot, companyId: '隆创信息有限公司', mode: 'test', chatId: 'test-chat', allowedChats: ['test-chat'] },
    project, outputRoot: path.join(root, 'acceptance'), runStage,
    inspectDocx: async () => ({ markerPresent: true, headingCount: 2, titles: ['项目理解', '实施方案'] }),
    assertOriginalUnchanged: async () => { checks += 1; assert.deepEqual(project, original); },
    deliver: async ({ artifact, receiptId }) => ({ messageId: 'om_file', chatId: 'test-chat', fileName: path.basename(artifact.path), receiptId, msgType: 'file', readBack: true }),
    ids: ['acceptance-job', 'acceptance-project'], now: () => new Date('2026-09-10T12:00:00Z'),
  });
  assert.equal(report.completed, true);
  assert.deepEqual(report.steps.map(item => item.label), ['prepare', 'outline_selection', 'outline', 'global_facts', 'content_decision', 'content', 'export', 'delivery']);
  assert.equal(report.delivery.readBack, true);
  assert.equal(report.source.projectId, 'live-project');
  assert.equal(report.source.humanDecisionBefore, null);
  assert.equal(report.source.handoffStatus, 'needs_manual');
  assert.equal(report.source.blockedWarningCount, 1);
  assert.equal(checks, 9);
  assert.deepEqual(project, original);
  assert.equal(calls.at(-1).projectId, 'acceptance-project');
  assert.deepEqual(calls.find(item => item.confirmations?.outlineSelection).confirmations.outlineSelection.selectedIds, ['a', 'b']);
  const retryCall = calls.find(item => item.confirmations?.contentDecision);
  assert.match(retryCall.modelAttempt, /^[a-f0-9]{40}$/);
  assert.deepEqual(report.scope, { availableOutlineRoots: 3, selectedOutlineRoots: 2, contentScope: '流程验收代表章节' });
  assert.ok(fs.existsSync(path.join(root, 'acceptance', 'acceptance.json')));
});

test('stops before generation when the source checksum no longer matches the current handoff', async t => {
  const { runRealWritingAcceptance } = require('../real-writing-acceptance.cjs');
  const { root, dataRoot, project, sourcePath } = fixture(t);
  fs.appendFileSync(sourcePath, 'changed');
  await assert.rejects(() => runRealWritingAcceptance({
    config: { dataRoot, companyId: '隆创信息有限公司', mode: 'test', chatId: 'test-chat', allowedChats: ['test-chat'] },
    project, outputRoot: path.join(root, 'acceptance'), runStage: async () => assert.fail('generation must not start'),
  }), /acceptance_source_checksum_mismatch/);
});

test('refuses delivery unless the target is the configured test group', async t => {
  const { deliverAcceptanceArtifact } = require('../real-writing-acceptance.cjs');
  const { root } = fixture(t);
  const filePath = path.join(root, 'draft.docx'); fs.writeFileSync(filePath, 'draft');
  await assert.rejects(() => deliverAcceptanceArtifact({
    config: { mode: 'production', chatId: 'formal-chat', allowedChats: ['formal-chat'] },
    artifact: { path: filePath, sha256: createHash('sha256').update('draft').digest('hex') }, receiptId: 'receipt',
  }), /acceptance_test_delivery_required/);
});
