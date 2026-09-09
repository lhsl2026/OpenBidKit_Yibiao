const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const WRITING_RESULT_PREFIX = 'FEISHU_WRITING_RESULT:';
const allowedStages = new Set(['prepare', 'outline', 'content', 'export']);
const allowedSourceExtensions = new Set(['.txt', '.md', '.markdown', '.docx', '.pdf', '.doc', '.wps', '.xls', '.xlsx']);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value, code) {
  const normalized = String(value || '').trim();
  if (!normalized) fail(code);
  return normalized;
}

function hashText(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function ensureInside(root, candidate, code = 'path_outside_project') {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)) {
    fail(code);
  }
  return resolvedCandidate;
}

function ensureRealFileInside(root, filePath, code) {
  let realRoot;
  let realFile;
  try {
    realRoot = fs.realpathSync(root);
    realFile = fs.realpathSync(filePath);
  } catch {
    fail('source_not_found');
  }
  const relative = path.relative(realRoot, realFile);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail(code);
  }
  return realFile;
}

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, filePath);
}

function renderCoordinate(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  try { return JSON.stringify(value); } catch { return ''; }
}

function renderRequirement(requirement) {
  const key = String(requirement?.key || requirement?.id || requirement?.requirementId || '未编号');
  const value = String(requirement?.value || requirement?.text || requirement?.requirement || requirement?.title || '待核验');
  const metadata = [];
  if (requirement?.category) metadata.push(`类别 ${requirement.category}`);
  const coordinate = renderCoordinate(requirement?.coordinate);
  if (coordinate) metadata.push(coordinate);
  if (Number.isFinite(Number(requirement?.confidence))) metadata.push(`置信度 ${Number(requirement.confidence)}`);
  if (requirement?.requiresConfirmation === true) metadata.push('待人工确认');
  return `${key}：${value}${metadata.length ? `（${metadata.join('；')}）` : ''}`;
}

function renderEvidenceMarkdown(handoff) {
  const lines = [
    '# 预读交接证据',
    '',
    `- 预读任务：${handoff.task.taskId}`,
    `- 文档版本：${handoff.snapshot.documentVersion}`,
    `- 报告：${handoff.snapshot.reportId}`,
    `- 快照校验和：${handoff.snapshot.checksum}`,
    '',
    '## 要求',
    '',
  ];
  if (!handoff.requirements.length) lines.push('- 暂无结构化要求，须人工核验。');
  for (const requirement of handoff.requirements) {
    lines.push(`- ${renderRequirement(requirement)}`);
  }
  lines.push('', '## 原文证据', '');
  if (!handoff.evidence.length) lines.push('- 尚无可用证据。');
  for (const evidence of handoff.evidence) {
    const requirementId = String(evidence?.requirementId || evidence?.requirement_id || evidence?.key || '未关联');
    const coordinate = renderCoordinate(evidence?.coordinate)
      || (evidence?.page === undefined || evidence?.page === null ? '页码待核验' : `PDF 第 ${evidence.page} 页`);
    const quote = String(evidence?.quote || evidence?.value || evidence?.text || evidence?.content || '待查看原文');
    const confirmation = evidence?.requiresConfirmation === true ? '；待人工确认' : '';
    lines.push(`- ${requirementId}（${coordinate}${confirmation}）：${quote}`);
  }
  lines.push('', '## 预读警告', '');
  if (!handoff.warnings.length) lines.push('- 无。');
  for (const warning of handoff.warnings) {
    lines.push(`- ${String(warning?.message || warning?.text || warning?.code || '待核验警告')}`);
  }
  lines.push('', '> 未知人员、证书、业绩、参数和承诺必须保留为待填写，不得自动杜撰。', '');
  return lines.join('\n');
}

function validateHandoff(handoff) {
  if (!isPlainObject(handoff)) fail('invalid_handoff');
  requiredString(handoff.schemaVersion, 'invalid_handoff_schema');
  if (!isPlainObject(handoff.task)) fail('invalid_handoff_task');
  requiredString(handoff.task.taskId, 'invalid_handoff_task');
  requiredString(handoff.task.title, 'invalid_handoff_task');
  if (!isPlainObject(handoff.snapshot)) fail('invalid_handoff_snapshot');
  const documentVersion = requiredString(handoff.snapshot.documentVersion, 'invalid_document_version');
  requiredString(handoff.snapshot.reportId, 'invalid_report_id');
  const checksum = requiredString(handoff.snapshot.checksum, 'invalid_snapshot_checksum');
  const checksumMatch = /^(?:sha256:)?([a-f0-9]{64})$/i.exec(checksum);
  if (!checksumMatch) fail('invalid_snapshot_checksum');
  if (handoff.status !== 'ready') fail('handoff_not_ready');
  if (handoff.superseded === true || handoff.latestDocumentVersion !== documentVersion) fail('handoff_superseded');
  if (![handoff.requirements, handoff.evidence, handoff.warnings].every(Array.isArray)) fail('invalid_handoff_collections');
  if (handoff.warnings.some((warning) => warning?.blocked === true)) fail('handoff_not_ready');
  return { documentVersion, checksum, checksumDigest: checksumMatch[1].toLowerCase() };
}

function prepareWritingJob({ job, root }) {
  if (!isPlainObject(job)) fail('invalid_writing_job');
  const id = requiredString(job.id, 'invalid_job_id');
  const projectId = requiredString(job.projectId, 'invalid_project_id');
  const companyId = requiredString(job.companyId, 'invalid_company_id');
  const stage = requiredString(job.stage, 'invalid_stage');
  if (!allowedStages.has(stage)) fail('invalid_stage');
  if (job.confirmed !== true) fail('writing_not_confirmed');
  const { documentVersion, checksum, checksumDigest } = validateHandoff(job.handoff);
  const rootPath = path.resolve(requiredString(root, 'invalid_writing_root'));
  const acquisitionRoot = path.join(rootPath, 'sources');
  const suppliedSourcePath = ensureRealFileInside(
    acquisitionRoot,
    path.resolve(requiredString(job.sourcePath, 'invalid_source_path')),
    'source_outside_acquisition_root',
  );
  let sourceStats;
  try {
    sourceStats = fs.statSync(suppliedSourcePath);
  } catch {
    fail('source_not_found');
  }
  if (!sourceStats.isFile()) fail('invalid_source_path');
  const extension = path.extname(suppliedSourcePath).toLowerCase();
  if (!allowedSourceExtensions.has(extension)) fail('unsupported_source_type');

  const companyKey = hashText(companyId).slice(0, 20);
  const projectKey = hashText(`${companyId}\0${projectId}`).slice(0, 24);
  const handoffDigest = hashText(JSON.stringify(stable({
    schemaVersion: job.handoff.schemaVersion,
    task: job.handoff.task,
    snapshot: { ...job.handoff.snapshot, checksum: checksumDigest },
    latestDocumentVersion: job.handoff.latestDocumentVersion,
    superseded: job.handoff.superseded,
    status: job.handoff.status,
    requirements: job.handoff.requirements,
    evidence: job.handoff.evidence,
    warnings: job.handoff.warnings,
  })));
  const versionKey = hashText(`${documentVersion}\0${checksumDigest}\0${handoffDigest}`).slice(0, 24);
  const projectDir = ensureInside(rootPath, path.join(rootPath, 'projects', companyKey, projectKey, versionKey));
  const inputDir = ensureInside(projectDir, path.join(projectDir, 'input'));
  const userData = ensureInside(projectDir, path.join(projectDir, 'user-data'));
  const workspace = ensureInside(userData, path.join(userData, 'workspace'));
  const artifacts = ensureInside(projectDir, path.join(projectDir, 'artifacts'));
  const inputPath = ensureInside(projectDir, path.join(inputDir, `tender${extension}`));
  const evidencePath = ensureInside(projectDir, path.join(inputDir, 'preread-evidence.md'));
  const manifestPath = ensureInside(projectDir, path.join(projectDir, 'manifest.json'));
  const sourceHash = hashFile(suppliedSourcePath);
  if (sourceHash !== checksumDigest) fail('source_checksum_mismatch');

  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(artifacts, { recursive: true });
  if (fs.existsSync(manifestPath)) {
    let existing;
    try {
      existing = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      fail('invalid_project_manifest');
    }
    if (existing.companyId !== companyId || existing.projectId !== projectId || existing.documentVersion !== documentVersion || existing.checksumDigest !== checksumDigest || existing.handoffDigest !== handoffDigest) {
      fail('snapshot_manifest_conflict');
    }
    if (existing.sourceHash !== sourceHash) fail('snapshot_source_conflict');
  }

  fs.mkdirSync(inputDir, { recursive: true });
  fs.copyFileSync(suppliedSourcePath, inputPath);
  atomicWrite(evidencePath, renderEvidenceMarkdown(job.handoff));
  atomicWrite(manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    companyId,
    projectId,
    prereadTaskId: job.handoff.task.taskId,
    documentVersion,
    reportId: job.handoff.snapshot.reportId,
    checksum,
    checksumDigest,
    handoffDigest,
    sourceHash,
    inputFile: path.relative(projectDir, inputPath).replace(/\\/g, '/'),
    evidenceFile: path.relative(projectDir, evidencePath).replace(/\\/g, '/'),
    globalFactsMode: 'placeholder',
  }, null, 2)}\n`);

  return {
    status: 'ready',
    id,
    stage,
    companyId,
    projectId,
    prereadTaskId: job.handoff.task.taskId,
    documentVersion,
    checksum,
    checksumDigest,
    handoffDigest,
    sourceHash,
    globalFactsMode: 'placeholder',
    projectDir,
    userData,
    workspace,
    artifacts,
    inputPath,
    evidencePath,
    manifestPath,
  };
}

function resolveTextModel(modelConfig) {
  if (!isPlainObject(modelConfig)) return null;
  const provider = String(modelConfig.text_model_provider || modelConfig.provider || '').trim();
  const profile = isPlainObject(modelConfig.text_model_profiles?.[provider])
    ? modelConfig.text_model_profiles[provider]
    : modelConfig;
  if (!provider || !String(profile.api_key || '').trim() || !String(profile.base_url || '').trim() || !String(profile.model_name || '').trim()) {
    return null;
  }
  return { provider, profile };
}

async function runWritingJob({ job, root, electronPath, clientRoot, modelConfig, signal, timeoutMs }) {
  const stage = allowedStages.has(job?.stage) ? job.stage : String(job?.stage || 'prepare');
  if (signal?.aborted) {
    return { status: 'failed', stage, code: 'worker_interrupted', message: '易标编写 Worker 已中断' };
  }
  if (!job?.sourcePath) {
    try {
      requiredString(job?.id, 'invalid_job_id');
      requiredString(job?.projectId, 'invalid_project_id');
      requiredString(job?.companyId, 'invalid_company_id');
      if (!allowedStages.has(stage)) fail('invalid_stage');
      if (job?.confirmed !== true) fail('writing_not_confirmed');
      validateHandoff(job?.handoff);
    } catch (error) {
      return { status: 'failed', stage, code: error.code || 'invalid_writing_job', message: error.message || 'invalid_writing_job' };
    }
    return {
      status: 'waiting_confirmation',
      stage,
      code: 'source_required',
      message: '缺少可用的本地招标文件',
      confirmation: { type: 'source_file' },
    };
  }
  if (!resolveTextModel(modelConfig)) {
    return { status: 'not_ready', stage, code: 'model_not_configured', message: '易标文本模型尚未配置' };
  }

  let prepared;
  try {
    prepared = prepareWritingJob({ job, root });
  } catch (error) {
    return { status: 'failed', stage, code: error.code || 'invalid_writing_job', message: error.message || 'invalid_writing_job' };
  }

  const executable = path.resolve(requiredString(electronPath, 'invalid_electron_path'));
  const resolvedClientRoot = path.resolve(requiredString(clientRoot, 'invalid_client_root'));
  const workerPath = path.join(__dirname, 'electron-worker.cjs');
  const environment = { ...process.env, YIBIAO_FEISHU_WRITING_WORKER: '1' };
  delete environment.ELECTRON_RUN_AS_NODE;

  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    let timeout;
    const child = spawn(executable, [workerPath], {
      cwd: resolvedClientRoot,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener?.('abort', onAbort);
      resolve(result);
    };
    const stop = (code, message) => {
      if (settled) return;
      try { child.kill(); } catch {}
      finish({ status: 'failed', stage, code, message });
    };
    const onAbort = () => stop('worker_interrupted', '易标编写 Worker 已中断');
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const boundedTimeoutMs = Math.min(
      30 * 60 * 1000,
      Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : 30 * 60 * 1000,
    );
    timeout = setTimeout(
      () => stop('worker_timeout', '易标编写 Worker 执行超时'),
      boundedTimeoutMs,
    );
    timeout.unref?.();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.resume();
    child.once('error', () => finish({ status: 'failed', stage, code: 'worker_spawn_failed', message: '易标编写 Worker 无法启动' }));
    child.once('close', (code) => {
      const resultLine = stdout.split(/\r?\n/).reverse().find((line) => line.startsWith(WRITING_RESULT_PREFIX));
      if (resultLine) {
        try {
          finish(JSON.parse(resultLine.slice(WRITING_RESULT_PREFIX.length)));
          return;
        } catch {}
      }
      finish({
        status: 'failed',
        stage,
        code: code === 0 ? 'worker_result_missing' : 'worker_process_failed',
        message: '易标编写 Worker 未返回有效结果',
      });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ job, prepared, modelConfig, clientRoot: resolvedClientRoot }));
  });
}

module.exports = {
  prepareWritingJob,
  runWritingJob,
};
