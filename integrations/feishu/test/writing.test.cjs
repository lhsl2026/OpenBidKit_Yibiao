const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { prepareWritingJob, runWritingJob } = require('../writing.cjs');

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-writing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, 'worker-root');
  const sourcePath = path.join(workspaceRoot, 'sources', '招标文件.md');
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, '# 测试项目\n\n不得杜撰人员、证书或业绩。', 'utf8');
  return { root, workspaceRoot, sourcePath };
}

function makeJob(sourcePath, overrides = {}) {
  const checksum = fs.existsSync(sourcePath)
    ? require('node:crypto').createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex')
    : 'a'.repeat(64);
  const job = {
    id: 'writing-job-1',
    projectId: 'project-1',
    companyId: 'company-1',
    stage: 'prepare',
    confirmed: true,
    sourcePath,
    globalFactsMode: 'fabricate',
    handoff: {
      schemaVersion: '1.0',
      task: { taskId: 'preread-task-1', title: '测试项目' },
      snapshot: {
        documentVersion: 'v1',
        reportId: 'report-v1',
        checksum,
        generatedAt: '2026-09-09T01:00:00.000Z',
      },
      latestDocumentVersion: 'v1',
      superseded: false,
      status: 'ready',
      requirements: [{
        key: 'project_manager_qualification',
        value: '项目经理资格待核验',
        category: 'qualification',
        coordinate: 'PDF 第 12 页',
        confidence: 0.82,
        requiresConfirmation: true,
      }],
      evidence: [{ requirementId: 'r-1', page: 12, quote: '项目经理要求' }],
      warnings: [],
    },
  };
  return { ...job, ...overrides };
}

test('isolates userData by company, project, and snapshot version while forcing placeholder facts', (t) => {
  const { workspaceRoot, sourcePath } = createFixture(t);
  const first = prepareWritingJob({ job: makeJob(sourcePath), root: workspaceRoot });
  const otherProject = prepareWritingJob({
    job: makeJob(sourcePath, { id: 'job-2', projectId: 'project-2' }),
    root: workspaceRoot,
  });
  const otherCompany = prepareWritingJob({
    job: makeJob(sourcePath, { id: 'job-3', companyId: 'company-2' }),
    root: workspaceRoot,
  });
  const v2 = makeJob(sourcePath, { id: 'job-4' });
  v2.handoff = {
    ...v2.handoff,
    snapshot: { ...v2.handoff.snapshot, documentVersion: 'v2' },
    latestDocumentVersion: 'v2',
  };
  const otherVersion = prepareWritingJob({ job: v2, root: workspaceRoot });

  assert.equal(first.status, 'ready');
  assert.equal(first.globalFactsMode, 'placeholder');
  assert.notEqual(first.userData, otherProject.userData);
  assert.notEqual(first.userData, otherCompany.userData);
  assert.notEqual(first.userData, otherVersion.userData);
  assert.ok(path.isAbsolute(first.userData));
  assert.ok(first.userData.startsWith(`${path.resolve(workspaceRoot)}${path.sep}`));
  assert.ok(first.inputPath.startsWith(`${first.projectDir}${path.sep}`));
  assert.equal(fs.readFileSync(first.inputPath, 'utf8'), fs.readFileSync(sourcePath, 'utf8'));
  const evidenceMarkdown = fs.readFileSync(first.evidencePath, 'utf8');
  assert.match(evidenceMarkdown, /project_manager_qualification：项目经理资格待核验/);
  assert.match(evidenceMarkdown, /PDF 第 12 页/);
  assert.match(evidenceMarkdown, /待人工确认/);
});

test('official prefixed and legacy bare snapshot checksums identify the same isolated version', (t) => {
  const { workspaceRoot, sourcePath } = createFixture(t);
  const bare = prepareWritingJob({ job: makeJob(sourcePath), root: workspaceRoot });
  const officialJob = makeJob(sourcePath);
  const bareChecksum = officialJob.handoff.snapshot.checksum;
  officialJob.handoff = {
    ...officialJob.handoff,
    snapshot: { ...officialJob.handoff.snapshot, checksum: `sha256:${bareChecksum}` },
  };
  const official = prepareWritingJob({ job: officialJob, root: workspaceRoot });
  assert.equal(official.userData, bare.userData);
  assert.equal(official.checksum, `sha256:${bareChecksum}`);
});

test('a corrected handoff report gets fresh state even when the document bytes and version are unchanged', (t) => {
  const { workspaceRoot, sourcePath } = createFixture(t);
  const originalJob = makeJob(sourcePath);
  const original = prepareWritingJob({ job: originalJob, root: workspaceRoot });
  const repeated = prepareWritingJob({ job: makeJob(sourcePath), root: workspaceRoot });
  assert.equal(repeated.userData, original.userData);

  const correctedJob = makeJob(sourcePath);
  correctedJob.handoff = {
    ...correctedJob.handoff,
    snapshot: { ...correctedJob.handoff.snapshot, reportVersion: 'report-v2' },
    requirements: correctedJob.handoff.requirements.map((item) => ({ ...item, value: '项目经理资格已更正，仍待核验' })),
  };
  const corrected = prepareWritingJob({ job: correctedJob, root: workspaceRoot });
  assert.notEqual(corrected.userData, original.userData);
});

test('rejects unauthorized, incomplete, stale, and non-checksummed snapshots', (t) => {
  const { workspaceRoot, sourcePath } = createFixture(t);
  const cases = [
    [makeJob(sourcePath, { confirmed: false }), /writing_not_confirmed/],
    [makeJob(sourcePath, { projectId: '' }), /invalid_project_id/],
    [makeJob(sourcePath, { handoff: { ...makeJob(sourcePath).handoff, status: 'needs_manual' } }), /handoff_not_ready/],
    [makeJob(sourcePath, { handoff: { ...makeJob(sourcePath).handoff, superseded: true } }), /handoff_superseded/],
    [makeJob(sourcePath, { handoff: { ...makeJob(sourcePath).handoff, latestDocumentVersion: 'v2' } }), /handoff_superseded/],
    [makeJob(sourcePath, { handoff: { ...makeJob(sourcePath).handoff, snapshot: { ...makeJob(sourcePath).handoff.snapshot, checksum: 'placeholder' } } }), /invalid_snapshot_checksum/],
  ];

  for (const [job, expected] of cases) {
    assert.throws(() => prepareWritingJob({ job, root: workspaceRoot }), expected);
  }
});

test('accepts only a controlled local tender file and detects source changes for an existing snapshot', (t) => {
  const { root, workspaceRoot, sourcePath } = createFixture(t);
  const job = makeJob(sourcePath);
  prepareWritingJob({ job, root: workspaceRoot });
  fs.appendFileSync(sourcePath, '\n更正后的文件', 'utf8');
  assert.throws(() => prepareWritingJob({ job, root: workspaceRoot }), /source_checksum_mismatch/);

  const executable = path.join(workspaceRoot, 'sources', 'payload.exe');
  fs.writeFileSync(executable, 'not a tender');
  assert.throws(
    () => prepareWritingJob({ job: makeJob(executable, { id: 'job-exe' }), root: workspaceRoot }),
    /unsupported_source_type/,
  );

  const outside = path.join(root, 'outside.md');
  fs.writeFileSync(outside, '# outside');
  assert.throws(
    () => prepareWritingJob({ job: makeJob(outside, { id: 'job-outside' }), root: workspaceRoot }),
    /source_outside_acquisition_root/,
  );

  const mismatch = makeJob(path.join(workspaceRoot, 'sources', 'mismatch.md'), { id: 'job-mismatch', projectId: 'project-mismatch' });
  fs.writeFileSync(mismatch.sourcePath, '# mismatch');
  assert.throws(() => prepareWritingJob({ job: mismatch, root: workspaceRoot }), /source_checksum_mismatch/);
});

test('returns not_ready before spawning Electron when the text model is not configured', async (t) => {
  const { root, workspaceRoot, sourcePath } = createFixture(t);
  const result = await runWritingJob({
    job: makeJob(sourcePath),
    root: workspaceRoot,
    electronPath: path.join(root, 'electron-must-not-run.exe'),
    clientRoot: path.join(root, 'client'),
    modelConfig: {},
  });

  assert.deepEqual(result, {
    status: 'not_ready',
    stage: 'prepare',
    code: 'model_not_configured',
    message: '易标文本模型尚未配置',
  });
});

test('returns a source confirmation wait when the preread handoff has no local attachment', async (t) => {
  const { root, workspaceRoot, sourcePath } = createFixture(t);
  const job = makeJob(sourcePath);
  delete job.sourcePath;
  const result = await runWritingJob({
    job,
    root: workspaceRoot,
    electronPath: path.join(root, 'electron-must-not-run.exe'),
    clientRoot: path.join(root, 'client'),
    modelConfig: {
      provider: 'custom',
      api_key: 'test-only',
      base_url: 'http://127.0.0.1:1/v1',
      model_name: 'offline-test',
    },
  });
  assert.equal(result.status, 'waiting_confirmation');
  assert.equal(result.code, 'source_required');
  assert.deepEqual(result.confirmation, { type: 'source_file' });
});

test('does not spawn a writing worker after its lease signal is already aborted', async (t) => {
  const { root, workspaceRoot, sourcePath } = createFixture(t);
  const controller = new AbortController();
  controller.abort(new Error('lease lost'));
  const result = await runWritingJob({
    job: makeJob(sourcePath),
    root: workspaceRoot,
    electronPath: path.join(root, 'electron-must-not-run.exe'),
    clientRoot: path.join(root, 'client'),
    modelConfig: { provider: 'custom', api_key: 'x', base_url: 'http://127.0.0.1:1/v1', model_name: 'offline' },
    signal: controller.signal,
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'worker_interrupted');
});

test('aborts an in-flight Electron worker and returns a bounded interrupted result', { timeout: 30_000 }, async (t) => {
  const { workspaceRoot, sourcePath } = createFixture(t);
  const clientRoot = path.resolve(__dirname, '..', '..', '..', 'client');
  const electronPath = path.join(clientRoot, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  if (!fs.existsSync(electronPath)) {
    t.skip('Electron binary is not installed');
    return;
  }
  const controller = new AbortController();
  const running = runWritingJob({
    job: makeJob(sourcePath),
    root: workspaceRoot,
    electronPath,
    clientRoot,
    modelConfig: { provider: 'custom', api_key: 'x', base_url: 'http://127.0.0.1:1/v1', model_name: 'offline' },
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(new Error('lease lost')), 10);
  const result = await running;
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'worker_interrupted');
});

test('prepare stage runs through Electron services in its isolated userData', { timeout: 60_000 }, async (t) => {
  const { workspaceRoot, sourcePath } = createFixture(t);
  const clientRoot = path.resolve(__dirname, '..', '..', '..', 'client');
  const electronPath = path.join(clientRoot, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  if (!fs.existsSync(electronPath)) {
    t.skip('Electron binary is not installed');
    return;
  }
  const result = await runWritingJob({
    job: makeJob(sourcePath),
    root: workspaceRoot,
    electronPath,
    clientRoot,
    modelConfig: {
      provider: 'custom',
      api_key: 'offline-smoke-only',
      base_url: 'http://127.0.0.1:1/v1',
      model_name: 'offline-smoke',
    },
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.stage, 'prepare');
  assert.equal(result.nextStage, 'outline');
  assert.ok(result.paths.userData.startsWith(`${path.resolve(workspaceRoot)}${path.sep}`));
  assert.ok(fs.existsSync(path.join(result.paths.workspace, 'yibiao.sqlite')));
  assert.equal(result.globalFactsMode, 'placeholder');
  const { DatabaseSync } = require('node:sqlite');
  const database = new DatabaseSync(path.join(result.paths.workspace, 'yibiao.sqlite'), { readOnly: true });
  const requirementRow = database.prepare("SELECT content FROM technical_plan_bid_items WHERE item_id='techRequirements'").get();
  database.close();
  assert.match(requirementRow.content, /project_manager_qualification：项目经理资格待核验/);
  assert.match(requirementRow.content, /PDF 第 12 页/);
});

test('content stage waits on the current outline challenge without changing the requested stage', { timeout: 60_000 }, async (t) => {
  const { DatabaseSync } = require('node:sqlite');
  const { workspaceRoot, sourcePath } = createFixture(t);
  const clientRoot = path.resolve(__dirname, '..', '..', '..', 'client');
  const electronPath = path.join(clientRoot, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  if (!fs.existsSync(electronPath)) {
    t.skip('Electron binary is not installed');
    return;
  }
  const base = makeJob(sourcePath);
  const modelConfig = {
    provider: 'custom',
    api_key: 'offline-smoke-only',
    base_url: 'http://127.0.0.1:1/v1',
    model_name: 'offline-smoke',
  };
  const prepared = await runWritingJob({ job: base, root: workspaceRoot, electronPath, clientRoot, modelConfig });
  assert.equal(prepared.status, 'completed');

  const database = new DatabaseSync(path.join(prepared.paths.workspace, 'yibiao.sqlite'));
  const timestamp = '2026-09-09T02:00:00.000Z';
  database.prepare(`INSERT INTO technical_plan_outline_nodes
    (node_id,parent_node_id,sort_order,level,title,description,content,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run('1', null, 0, 1, '技术方案', '响应招标要求', '', timestamp, timestamp);
  database.prepare(`INSERT INTO technical_plan_tasks
    (type,task_id,status,progress,stats_json,error,pause_requested,started_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run('outline-generation', 'outline-task-1', 'success', 100, '{}', null, 0, timestamp, timestamp);
  database.prepare(`INSERT INTO technical_plan_global_fact_groups
    (group_id,title,content,sort_order,created_at,updated_at)
    VALUES (?,?,?,?,?,?)`).run('facts-1', '人员与证书', '【待填写：核验后补充】', 0, timestamp, timestamp);
  database.prepare(`INSERT INTO technical_plan_tasks
    (type,task_id,status,progress,stats_json,error,pause_requested,started_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run('global-facts-generation', 'facts-task-1', 'success', 100, '{}', null, 0, timestamp, timestamp);
  database.close();

  const contentJob = { ...base, stage: 'content' };
  const result = await runWritingJob({ job: contentJob, root: workspaceRoot, electronPath, clientRoot, modelConfig });
  assert.equal(result.status, 'waiting_confirmation');
  assert.equal(result.stage, 'content');
  assert.equal(result.code, 'outline_confirmation_required');
  assert.equal(result.confirmation.type, 'outline');
  assert.match(result.confirmation.challenge, /^[a-f0-9]{64}$/);

  const outlineResult = await runWritingJob({ job: { ...base, stage: 'outline' }, root: workspaceRoot, electronPath, clientRoot, modelConfig });
  assert.equal(outlineResult.code, 'outline_confirmation_required');
  const approvedContent = await runWritingJob({
    job: {
      ...base,
      stage: 'content',
      confirmations: { outlineApproval: { challenge: outlineResult.confirmation.challenge, approved: true } },
    },
    root: workspaceRoot,
    electronPath,
    clientRoot,
    modelConfig,
  });
  assert.equal(approvedContent.status, 'waiting_confirmation');
  assert.equal(approvedContent.stage, 'content');
  assert.equal(approvedContent.code, 'global_facts_confirmation_required');
  fs.writeFileSync(
    path.join(prepared.paths.projectDir, 'confirmations.json'),
    JSON.stringify({ outline: outlineResult.confirmation.challenge, globalFacts: approvedContent.confirmation.challenge }),
  );

  const pausedDatabase = new DatabaseSync(path.join(prepared.paths.workspace, 'yibiao.sqlite'));
  pausedDatabase.prepare(`INSERT INTO technical_plan_content_sections
    (node_id,status,error,updated_at) VALUES (?,?,?,?)`).run('1', 'error', '缺少可核验参数', timestamp);
  pausedDatabase.prepare(`INSERT INTO technical_plan_tasks
    (type,task_id,status,progress,stats_json,error,pause_requested,started_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    'content-generation',
    'content-task-1',
    'paused',
    60,
    JSON.stringify({ content: { phase: 'generating', awaiting_content_decision: true } }),
    null,
    0,
    timestamp,
    timestamp,
  );
  pausedDatabase.close();
  const pausedResult = await runWritingJob({
    job: {
      ...base,
      stage: 'content',
      confirmations: {
        outlineApproval: { challenge: outlineResult.confirmation.challenge, approved: true },
      },
    },
    root: workspaceRoot,
    electronPath,
    clientRoot,
    modelConfig,
    timeoutMs: 10_000,
  });
  assert.equal(pausedResult.status, 'waiting_confirmation', JSON.stringify(pausedResult));
  assert.equal(pausedResult.code, 'content_decision_required');
  assert.deepEqual(pausedResult.confirmation.actions, ['retry_failed']);
  assert.deepEqual(pausedResult.confirmation.failedSections, [{ id: '1', title: '技术方案', error: '缺少可核验参数' }]);

  const decisionDatabase = new DatabaseSync(path.join(prepared.paths.workspace, 'yibiao.sqlite'));
  decisionDatabase.prepare(`UPDATE technical_plan_tasks
    SET status=?, stats_json=?, error=?, updated_at=? WHERE type='content-generation'`).run(
    'error',
    JSON.stringify({ content: { phase: 'generating', awaiting_content_decision: true } }),
    '正文小节生成结束，1 个小节失败或未完成。',
    timestamp,
  );
  decisionDatabase.close();
  const decisionResult = await runWritingJob({
    job: {
      ...base,
      stage: 'content',
      confirmations: {
        outlineApproval: { challenge: outlineResult.confirmation.challenge, approved: true },
      },
    },
    root: workspaceRoot,
    electronPath,
    clientRoot,
    modelConfig,
    timeoutMs: 10_000,
  });
  assert.equal(decisionResult.status, 'waiting_confirmation', JSON.stringify(decisionResult));
  assert.equal(decisionResult.code, 'content_decision_required');
  assert.deepEqual(decisionResult.confirmation.failedSections, [{ id: '1', title: '技术方案', error: '缺少可核验参数' }]);
});
