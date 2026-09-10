'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { runWritingJob } = require('./writing.cjs');
const { createLarkClient } = require('./lark.cjs');
const { createStore } = require('./store.cjs');

const run = promisify(execFile);
const ACCEPTANCE_MARKER = '真实文件流程验收稿，不代表公司决定投标';
const TARGET_COMPANY = '隆创信息有限公司';
const digest = value => String(value || '').replace(/^sha256:/iu, '').toLowerCase();
const sha256File = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const stableId = (...values) => createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 40);

function ensureEmptyAcceptanceRoot(config, outputRoot) {
  const root = path.resolve(String(outputRoot || ''));
  if (!outputRoot || root === path.resolve(config.dataRoot) || root === path.parse(root).root) throw Error('acceptance_root_invalid');
  fs.mkdirSync(root, { recursive: true });
  if (fs.readdirSync(root).length) throw Error('acceptance_root_must_be_empty');
  return root;
}

function validateProject(config, project) {
  if (!project?.current || project.companyId !== TARGET_COMPANY || config.companyId !== TARGET_COMPANY) throw Error('acceptance_company_or_project_invalid');
  const handoff = project.input?.handoff;
  if (!handoff || !['ready', 'needs_manual'].includes(handoff.status) || handoff.superseded === true || !handoff.snapshot?.reportVersion) throw Error('acceptance_handoff_not_ready');
  const sourcePath = path.resolve(String(project.input?.sourcePath || ''));
  if (!sourcePath || !fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) throw Error('acceptance_source_missing');
  const expected = digest(handoff.snapshot.checksum);
  if (!/^[a-f0-9]{64}$/u.test(expected) || digest(project.checksum) !== expected || sha256File(sourcePath) !== expected) throw Error('acceptance_source_checksum_mismatch');
  return { handoff, sourcePath, expected };
}

function sourceIdentity(project) {
  const snapshot = project.input.handoff.snapshot;
  return {
    projectId: project.id,
    taskId: project.taskId,
    companyId: project.companyId,
    projectVersion: project.version,
    reportId: snapshot.reportId,
    reportVersion: snapshot.reportVersion,
    documentVersion: snapshot.documentVersion,
    checksum: digest(snapshot.checksum),
    humanDecisionBefore: project.humanDecision ?? null,
    handoffStatus: project.input.handoff.status,
    blockedWarningCount: (project.input.handoff.warnings || []).filter(item => item?.blocked === true).length,
  };
}

function writeReport(root, report) {
  const target = path.join(root, 'acceptance.json');
  const temporary = target + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(report, null, 2) + '\n', 'utf8');
  fs.renameSync(temporary, target);
}

function xmlText(value) {
  return String(value || '').replace(/<[^>]+>/gu, '').replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&amp;/gu, '&').replace(/&quot;/gu, '"').replace(/&apos;/gu, "'");
}

async function inspectDocxArtifact({ artifact, config }) {
  if (!artifact?.path || path.extname(artifact.path).toLowerCase() !== '.docx' || !fs.existsSync(artifact.path)) throw Error('acceptance_docx_missing');
  const bytes = fs.readFileSync(artifact.path);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== digest(artifact.sha256) || bytes.length !== artifact.size) throw Error('acceptance_docx_receipt_mismatch');
  const JSZip = require(path.join(config.clientRoot, 'node_modules', 'jszip'));
  const zip = await JSZip.loadAsync(bytes);
  if (!zip.file('[Content_Types].xml') || !zip.file('word/document.xml')) throw Error('acceptance_docx_structure_invalid');
  const documentXml = await zip.file('word/document.xml').async('string');
  const markerPresent = xmlText(documentXml).includes(ACCEPTANCE_MARKER);
  const headingParagraphs = [...documentXml.matchAll(/<w:p\b[\s\S]*?<w:pStyle\b[^>]*w:val="(?:Heading[1-9]|标题 ?[1-9])"[^>]*\/>[\s\S]*?<\/w:p>/gu)].map(match => xmlText(match[0]).trim()).filter(Boolean);
  if (!markerPresent || headingParagraphs.length < 2) throw Error('acceptance_docx_content_invalid');
  return { markerPresent, headingCount: headingParagraphs.length, titles: headingParagraphs.slice(0, 40), size: bytes.length, sha256: actual };
}

function findMessage(value, messageId) {
  if (!value || typeof value !== 'object') return null;
  if ((value.message_id === messageId || value.messageId === messageId) && (value.msg_type || value.msgType)) return value;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = findMessage(child, messageId); if (found) return found;
  }
  return null;
}

async function deliverAcceptanceArtifact({ config, artifact, receiptId, client, runImpl = run }) {
  if (config.mode !== 'test' || !config.chatId || !config.allowedChats?.includes(config.chatId)) throw Error('acceptance_test_delivery_required');
  if (!artifact?.path || sha256File(artifact.path) !== digest(artifact.sha256)) throw Error('acceptance_artifact_changed');
  const lark = client || createLarkClient({ appId: config.appId, appSecret: config.appSecret });
  const fileKey = await lark.uploadFile(artifact.path);
  const messageId = await lark.sendFile(config.chatId, fileKey, receiptId);
  const cliPath = config.cardSource?.cliPath, profile = config.cardSource?.profile;
  if (!path.isAbsolute(String(cliPath || '')) || !profile) throw Error('acceptance_readback_not_configured');
  const { stdout } = await runImpl(cliPath, ['im', '+messages-mget', '--message-ids', messageId, '--as', 'bot', '--profile', profile, '--no-reactions', '--format', 'json'], {
    windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' },
  });
  let envelope; try { envelope = JSON.parse(stdout); } catch { throw Error('acceptance_readback_invalid'); }
  const message = envelope?.ok === true ? findMessage(envelope.data, messageId) : null;
  const msgType = message?.msg_type || message?.msgType;
  const chatId = message?.chat_id || message?.chatId || config.chatId;
  if (!message || msgType !== 'file' || chatId !== config.chatId) throw Error('acceptance_readback_mismatch');
  return { messageId, chatId, fileName: path.basename(artifact.path), receiptId, msgType, readBack: true };
}

async function runRealWritingAcceptance({ config, project, outputRoot, runStage = runWritingJob, inspectDocx = inspectDocxArtifact, deliver = deliverAcceptanceArtifact, assertOriginalUnchanged = async () => {}, modelConfigForJob = () => config.modelConfig, ids = [randomUUID(), randomUUID()], now = () => new Date() }) {
  const { handoff, sourcePath, expected } = validateProject(config, project);
  const root = ensureEmptyAcceptanceRoot(config, outputRoot);
  const writingRoot = path.join(root, 'writing');
  const copiedSource = path.join(writingRoot, 'sources', path.basename(sourcePath));
  fs.mkdirSync(path.dirname(copiedSource), { recursive: true }); fs.copyFileSync(sourcePath, copiedSource);
  const title = '【' + ACCEPTANCE_MARKER + '】' + handoff.task.title;
  const acceptanceHandoff = structuredClone(handoff); acceptanceHandoff.task = { ...acceptanceHandoff.task, title };
  acceptanceHandoff.status = 'ready';
  acceptanceHandoff.warnings = [
    { code: 'real_writing_acceptance_only', blocked: false, message: '原始预读状态 ' + handoff.status + '；本任务只验收写标流程，不解除任何待复核项，也不代表公司决定投标。' },
    ...(handoff.warnings || []).map(item => ({ ...item, originalBlocked: item?.blocked === true, blocked: false, message: '【原始待复核】' + String(item?.message || item?.text || item?.code || '待核实') })),
  ];
  const baseJob = {
    id: ids[0], projectId: ids[1], companyId: TARGET_COMPANY, confirmed: true, sourcePath: copiedSource,
    project: { overview: title + '\n仅验收真实文件驱动的目录、事实、正文与 Word 流程；从模型建议中选取前两个代表性一级技术章节，不构成完整投标文件；所有未知公司事实保留【待填写】。', wordControlOptions: { sectionWords: 300, strictSectionWords: false, minimumWords: 0, maximumWords: 0 } },
    handoff: acceptanceHandoff,
  };
  const report = { schemaVersion: 1, marker: ACCEPTANCE_MARKER, completed: false, startedAt: now().toISOString(), source: sourceIdentity(project), sourceFile: { name: path.basename(sourcePath), sha256: expected, size: fs.statSync(sourcePath).size }, steps: [] };
  writeReport(root, report);
  const verify = async () => { await assertOriginalUnchanged(sourceIdentity(project)); };
  await verify();
  const execute = async (label, stage, confirmations = {}, jobPatch = {}) => {
    const stageJob = { ...baseJob, ...jobPatch, stage, confirmations };
    const result = await runStage({ job: stageJob, root: writingRoot, electronPath: config.electronPath, clientRoot: config.clientRoot, modelConfig: modelConfigForJob(stageJob), timeoutMs: 30 * 60 * 1000 });
    report.steps.push({ label, result }); writeReport(root, report); await verify();
    if (result?.status === 'failed') throw Error('acceptance_' + label + '_failed:' + (result.code || 'unknown'));
    return result;
  };
  const prepared = await execute('prepare', 'prepare'); if (prepared.status !== 'completed') throw Error('acceptance_prepare_incomplete');
  const selection = await execute('outline_selection', 'outline');
  if (selection.confirmation?.type !== 'outline_selection' || !selection.confirmation.items?.length) throw Error('acceptance_outline_selection_missing');
  const selectedIds = selection.confirmation.items.slice(0, 2).map(item => String(item.id));
  report.scope = { availableOutlineRoots: selection.confirmation.items.length, selectedOutlineRoots: selectedIds.length, contentScope: '流程验收代表章节' }; writeReport(root, report);
  const outline = await execute('outline', 'outline', { outlineSelection: { taskId: selection.confirmation.taskId, challenge: selection.confirmation.challenge, selectedIds } });
  if (outline.confirmation?.type !== 'outline' || !outline.confirmation.outlineData?.outline?.length) throw Error('acceptance_outline_confirmation_missing');
  const outlineApproval = { challenge: outline.confirmation.challenge, approved: true };
  const facts = await execute('global_facts', 'content', { outlineApproval });
  if (facts.confirmation?.type !== 'global_facts' || !facts.confirmation.groups?.length) throw Error('acceptance_facts_confirmation_missing');
  const confirmations = { outlineApproval, globalFacts: { challenge: facts.confirmation.challenge, groups: facts.confirmation.groups } };
  let content = await execute('content_decision', 'content', confirmations);
  if (content.confirmation?.type === 'content_decision') {
    const modelAttempt = stableId('real-writing-acceptance-content-retry', report.source, content.confirmation.challenge);
    content = await execute('content', 'content', { ...confirmations, contentDecision: { challenge: content.confirmation.challenge, action: 'retry_failed' } }, { modelAttempt });
  } else {
    report.steps.at(-1).label = 'content'; writeReport(root, report);
  }
  if (content.status !== 'completed') throw Error('acceptance_content_incomplete');
  const exported = await execute('export', 'export');
  const artifact = exported.artifacts?.find(item => item.kind === 'word'); if (!artifact) throw Error('acceptance_export_missing');
  const docx = await inspectDocx({ artifact, config });
  const receiptId = stableId('real-writing-acceptance', report.source, artifact.sha256);
  const delivery = await deliver({ config, artifact, receiptId });
  report.steps.push({ label: 'delivery', result: delivery }); report.docx = docx; report.artifact = artifact; report.delivery = delivery; report.completed = true; report.completedAt = now().toISOString();
  writeReport(root, report); await verify();
  return report;
}

async function main() {
  const args = process.argv.slice(2), value = flag => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : ''; };
  const projectId = value('--project-id'), outputRoot = value('--output-root');
  if (!projectId || !outputRoot) throw Error('usage: real-writing-acceptance.cjs --project-id <current project id> --output-root <new directory>');
  const config = require('./config.cjs').loadConfig();
  const store = createStore(path.join(config.dataRoot, 'workflow.sqlite3'));
  try {
    const project = store.getProject(projectId); if (!project) throw Error('acceptance_project_missing');
    const initial = sourceIdentity(project);
    const assertOriginalUnchanged = async () => {
      const current = store.getProject(projectId); if (!current?.current || JSON.stringify(sourceIdentity(current)) !== JSON.stringify(initial)) throw Error('acceptance_original_project_changed');
    };
    const modelConfigForJob = job => require('./codex-attempt.cjs').writingModelConfig({ config, store, job });
    const report = await runRealWritingAcceptance({ config, project, outputRoot, assertOriginalUnchanged, modelConfigForJob });
    console.log(JSON.stringify({ completed: report.completed, sourceProjectId: report.source.projectId, artifact: { path: report.artifact.path, sha256: report.artifact.sha256, size: report.artifact.size }, delivery: report.delivery }));
  } finally { store.close(); }
}

if (require.main === module) main().catch(error => { console.error(JSON.stringify({ completed: false, error: String(error?.message || error).slice(0, 300) })); process.exitCode = 1; });
module.exports = { ACCEPTANCE_MARKER, runRealWritingAcceptance, inspectDocxArtifact, deliverAcceptanceArtifact, sourceIdentity };
