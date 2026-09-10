const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const RESULT_PREFIX = 'FEISHU_WRITING_RESULT:';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function challengeFor(prepared, stage, type, value) {
  return sha256(JSON.stringify(stable({
    companyId: prepared.companyId,
    projectId: prepared.projectId,
    documentVersion: prepared.documentVersion,
    checksumDigest: prepared.checksumDigest,
    handoffDigest: prepared.handoffDigest,
    stage,
    type,
    value,
  })));
}

function inside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function validatePrepared(prepared) {
  if (!prepared || prepared.status !== 'ready' || !prepared.projectDir) throw Object.assign(new Error('invalid_prepared_job'), { code: 'invalid_prepared_job' });
  for (const field of ['userData', 'workspace', 'artifacts', 'inputPath', 'evidencePath', 'manifestPath']) {
    if (!inside(prepared.projectDir, prepared[field])) throw Object.assign(new Error('prepared_path_outside_project'), { code: 'prepared_path_outside_project' });
  }
}

function readInput() {
  const raw = fs.readFileSync(0, 'utf8');
  const input = JSON.parse(raw);
  validatePrepared(input.prepared);
  return input;
}

const input = readInput();
const codexTextBackend = input.modelConfig?.backend === 'codex';
const { createCodexWritingAdapter, createTextOnlyAgentService, textOnlyContentOptions, assertTextOnlyPlan, normalizeCodexModelConfig } = require('./codex-writing.cjs');
app.disableHardwareAcceleration();
app.setPath('userData', input.prepared.userData);
app.setPath('downloads', input.prepared.artifacts);
app.setPath('temp', path.join(input.prepared.projectDir, 'tmp'));

function requireService(relativePath) {
  return require(path.join(input.clientRoot, 'electron', 'services', relativePath));
}

function normalizeModelConfig(modelConfig) {
  if (codexTextBackend) return normalizeCodexModelConfig(modelConfig);
  const provider = String(modelConfig.text_model_provider || modelConfig.provider || 'custom').trim();
  const profile = modelConfig.text_model_profiles?.[provider] || modelConfig;
  return {
    ...modelConfig,
    ...profile,
    text_model_provider: provider,
    text_model_profiles: {
      ...(modelConfig.text_model_profiles || {}),
      [provider]: { ...profile },
    },
    agent_auto_answer_enabled: false,
    developer_mode: false,
  };
}

function createServices() {
  const { createConfigStore } = requireService('configStore.cjs');
  const { createAiService } = requireService('aiService.cjs');
  const { createAutoConfirmationService } = requireService('autoConfirmationService.cjs');
  const { createLicenseService } = requireService('licenseService.cjs');
  const { createAgentService } = requireService('agentService.cjs');
  const { createFileService } = requireService('fileService.cjs');
  const { createOpenXmlHelperService } = requireService('openXmlHelperService.cjs');
  const { createSqliteDatabase } = requireService('sqliteDatabase.cjs');
  const { createTaskLogStore } = requireService('taskLogStore.cjs');
  const { createKnowledgeBaseStore } = requireService('knowledgeBaseStore.cjs');
  const { createKnowledgeBaseService } = requireService('knowledgeBaseService.cjs');
  const { createTechnicalPlanStore } = requireService('technicalPlanStore.cjs');
  const { createFeasibilityReportStore } = requireService('feasibilityReportStore.cjs');
  const { createDuplicateCheckStore } = requireService('duplicateCheckStore.cjs');
  const { createRejectionCheckStore } = requireService('rejectionCheckStore.cjs');
  const { createDuplicateCheckService } = requireService('duplicateCheckService.cjs');
  const { createTaskService } = requireService('taskService.cjs');
  const { initLocalImageRenderService } = requireService('localImageRenderService.cjs');

  const configStore = createConfigStore(app);
  configStore.save(normalizeModelConfig(input.modelConfig));
  initLocalImageRenderService({ configStore });
  const licenseService = createLicenseService({ app, configStore });
  const aiService = createAiService({ app, configStore });
  const autoConfirmationService = createAutoConfirmationService({ configStore });
  const agentService = codexTextBackend ? createTextOnlyAgentService() : createAgentService({ app, configStore, aiService, licenseService, autoConfirmationService });
  const fileService = createFileService({ app, configStore });
  const openXmlHelperService = createOpenXmlHelperService({ app, configStore });
  const sqliteDatabase = createSqliteDatabase(app);
  const taskLogStore = createTaskLogStore({ db: sqliteDatabase.db });
  const knowledgeBaseStore = createKnowledgeBaseStore({ app, db: sqliteDatabase.db });
  const knowledgeBaseService = createKnowledgeBaseService({ app, aiService, configStore, knowledgeBaseStore });
  const technicalPlanStore = createTechnicalPlanStore({ app, db: sqliteDatabase.db, fileService, agentService, taskLogStore });
  const feasibilityReportStore = createFeasibilityReportStore({ app, db: sqliteDatabase.db, fileService, taskLogStore, agentService });
  const duplicateCheckStore = createDuplicateCheckStore({ app, db: sqliteDatabase.db, taskLogStore });
  const rejectionCheckStore = createRejectionCheckStore({ app, db: sqliteDatabase.db, fileService, technicalPlanStore, taskLogStore });
  const duplicateCheckService = createDuplicateCheckService({ app, configStore, workspaceStore: duplicateCheckStore });
  const taskService = createTaskService({
    aiService,
    agentService,
    autoConfirmationService,
    technicalPlanStore,
    rejectionCheckStore,
    duplicateCheckStore,
    feasibilityReportStore,
    knowledgeBaseService,
    duplicateCheckService,
    openXmlHelperService,
  });
  return {
    configStore,
    technicalPlanStore,
    taskService,
    codexWriting: codexTextBackend ? createCodexWritingAdapter({ aiService, workspaceStore: technicalPlanStore, knowledgeBaseService, runGlobalFactsTask: requireService('globalFactsTask.cjs').runGlobalFactsTask }) : null,
    async close() {
      await agentService.close?.();
      autoConfirmationService.close?.();
      await openXmlHelperService.close?.();
      sqliteDatabase.close();
    },
  };
}

function baseResult(status, stage, extra = {}) {
  return {
    status,
    stage,
    projectId: input.prepared.projectId,
    documentVersion: input.prepared.documentVersion,
    globalFactsMode: 'placeholder',
    ...extra,
  };
}

function resultPaths() {
  const prepared = input.prepared;
  return {
    projectDir: prepared.projectDir,
    userData: prepared.userData,
    workspace: prepared.workspace,
    artifacts: prepared.artifacts,
    inputPath: prepared.inputPath,
    evidencePath: prepared.evidencePath,
  };
}

function renderCoordinate(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  try { return JSON.stringify(value); } catch { return ''; }
}

function renderRequirements(handoff) {
  const requirements = handoff.requirements.map((item) => {
    const key = String(item?.key || item?.id || item?.requirementId || '未编号');
    const value = String(item?.value || item?.text || item?.requirement || item?.title || '待核验');
    const metadata = [];
    if (item?.category) metadata.push(`类别 ${item.category}`);
    const coordinate = renderCoordinate(item?.coordinate);
    if (coordinate) metadata.push(coordinate);
    if (Number.isFinite(Number(item?.confidence))) metadata.push(`置信度 ${Number(item.confidence)}`);
    if (item?.requiresConfirmation === true) metadata.push('待人工确认');
    return `- ${key}：${value}${metadata.length ? `（${metadata.join('；')}）` : ''}`;
  });
  return requirements.length ? requirements.join('\n') : '- 暂无结构化要求，须人工核验。';
}

async function prepareStage(services) {
  const { technicalPlanStore, taskService } = services;
  let state = technicalPlanStore.loadTechnicalPlan();
  if (!state.tenderFile) {
    const imported = await taskService.importTenderDocument([input.prepared.inputPath, input.prepared.evidencePath]);
    if (!imported?.success) {
      throw Object.assign(new Error(imported?.message || 'tender_import_failed'), { code: 'tender_import_failed' });
    }
  }
  const projectOverview = String(input.job?.project?.overview || input.job?.handoff?.task?.title || '未命名项目');
  technicalPlanStore.updateTechnicalPlan({
    workflowKind: 'technical-plan',
    step: 'outline-edit',
    projectOverview,
    techRequirements: renderRequirements(input.job.handoff),
    globalFactsMode: 'placeholder',
    ...(codexTextBackend && input.job?.project?.wordControlOptions ? { outlineWordControlOptions: input.job.project.wordControlOptions } : {}),
  });
  state = technicalPlanStore.loadTechnicalPlan();
  return baseResult('completed', 'prepare', {
    nextStage: 'outline',
    paths: resultPaths(),
    source: {
      sha256: input.prepared.sourceHash,
      inputPath: input.prepared.inputPath,
      evidencePath: input.prepared.evidencePath,
    },
    workspaceState: {
      tenderImported: Boolean(state.tenderFile),
      projectOverviewReady: Boolean(state.projectOverview),
    },
  });
}

function observeTask(taskService, type, start) {
  return new Promise((resolve, reject) => {
    let done = false;
    let unsubscribe = () => {};
    const finish = (value, isError = false) => {
      if (done) return;
      done = true;
      unsubscribe();
      if (isError) reject(value);
      else resolve(value);
    };
    unsubscribe = taskService.subscribeCallback((event) => {
      if (event?.task?.type !== type) return;
      const task = event.task;
      if (type === 'outline-generation' && task.stats?.outline_selection?.items?.length && task.stats.outline_selection.confirmed !== true) {
        finish({ kind: 'outline-selection', task });
        return;
      }
      if (['success', 'error', 'interrupted', 'paused'].includes(task.status)) finish({ kind: 'terminal', task });
    });
    try {
      const active = taskService.getActiveTasks().some((task) => task.type === type);
      if (!active && start) start();
    } catch (error) {
      finish(error, true);
    }
  });
}

function outlineSelectionResult(task) {
  const selection = task.stats.outline_selection;
  const value = { taskId: task.task_id, items: selection.items, selectedIds: selection.selected_ids || [] };
  return baseResult('waiting_confirmation', 'outline', {
    code: 'outline_selection_required',
    message: '一级目录已生成，等待人工确认',
    confirmation: {
      type: 'outline_selection',
      challenge: challengeFor(input.prepared, 'outline', 'outline_selection', value),
      ...value,
    },
  });
}

function outlineApprovalResult(outlineData) {
  return baseResult('waiting_confirmation', 'outline', {
    code: 'outline_confirmation_required',
    message: '完整目录已生成，等待人工确认',
    confirmation: {
      type: 'outline',
      challenge: challengeFor(input.prepared, 'outline', 'outline', outlineData),
      outlineData,
    },
  });
}

async function outlineStage(services) {
  const { technicalPlanStore, taskService } = services;
  let state = technicalPlanStore.loadTechnicalPlan();
  if (!state.tenderFile || !state.projectOverview) {
    return baseResult('failed', 'outline', { code: 'prepare_required', message: '请先完成 prepare 阶段' });
  }
  if (state.outlineGenerationTask?.status === 'success' && state.outlineData?.outline?.length) {
    return outlineApprovalResult(state.outlineData);
  }

  const pendingSelection = state.outlineGenerationTask?.stats?.outline_selection;
  const supplied = input.job?.confirmations?.outlineSelection;
  if (pendingSelection?.items?.length && pendingSelection.confirmed !== true) {
    const pendingResult = outlineSelectionResult(state.outlineGenerationTask);
    if (!supplied) return pendingResult;
    if (supplied.challenge !== pendingResult.confirmation.challenge || supplied.taskId !== state.outlineGenerationTask.task_id) {
      return baseResult('failed', 'outline', { code: 'stale_confirmation', message: '目录确认已过期' });
    }
    const allowedIds = new Set(pendingSelection.items.map((item) => item.id));
    const selectedIds = Array.isArray(supplied.selectedIds) ? [...new Set(supplied.selectedIds.map(String))] : [];
    if (!selectedIds.length || selectedIds.some((id) => !allowedIds.has(id))) {
      return baseResult('failed', 'outline', { code: 'invalid_outline_selection', message: '目录选择无效' });
    }
    if (services.codexWriting) {
      await services.codexWriting.expandOutline(selectedIds);
      return outlineApprovalResult(technicalPlanStore.loadTechnicalPlan().outlineData);
    }
    taskService.confirmOutlineSelection({
      taskId: state.outlineGenerationTask.task_id,
      items: pendingSelection.items,
      selectedIds,
    });
  }

  if (services.codexWriting) {
    await services.codexWriting.generateInitialOutline();
    return outlineSelectionResult(technicalPlanStore.loadTechnicalPlan().outlineGenerationTask);
  }
  const observed = await observeTask(taskService, 'outline-generation', () => {
    state = technicalPlanStore.loadTechnicalPlan();
    taskService.startOutlineGeneration({
      reference_knowledge_document_ids: [],
      outline_mode: 'aligned',
      outline_expansion_mode: 'ai-complement',
      word_control_options: state.outlineWordControlOptions,
    });
  });
  if (observed.kind === 'outline-selection') return outlineSelectionResult(observed.task);
  if (observed.task.status !== 'success') {
    return baseResult('failed', 'outline', { code: 'outline_generation_failed', message: observed.task.error || '目录生成失败' });
  }
  state = technicalPlanStore.loadTechnicalPlan();
  return outlineApprovalResult(state.outlineData);
}

function factsConfirmationResult(groups) {
  return baseResult('waiting_confirmation', 'content', {
    code: 'global_facts_confirmation_required',
    message: '全局事实候选已生成，等待人工确认',
    confirmation: {
      type: 'global_facts',
      challenge: challengeFor(input.prepared, 'content', 'global_facts', groups),
      groups,
    },
  });
}

function approvalStatePath() {
  return path.join(input.prepared.projectDir, 'confirmations.json');
}

function loadApprovals() {
  try { return JSON.parse(fs.readFileSync(approvalStatePath(), 'utf8')); } catch { return {}; }
}

function saveApprovals(approvals) {
  const target = approvalStatePath();
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(approvals, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, target);
}

function findOutlineTitle(items, id) {
  for (const item of items || []) {
    if (String(item?.id) === String(id)) return String(item?.title || id);
    const nested = findOutlineTitle(item?.children, id);
    if (nested) return nested;
  }
  return '';
}

function compactSectionError(value) {
  return String(value || '')
    .split(/\r?\n/, 1)[0]
    .replace(/[a-zA-Z]:\\[^\s]+/g, '<path>')
    .slice(0, 240);
}

function contentDecisionResult(state) {
  const failedSections = Object.entries(state.contentGenerationSections || {})
    .filter(([, section]) => section?.status === 'error')
    .slice(0, 20)
    .map(([id, section]) => ({
      id,
      title: findOutlineTitle(state.outlineData?.outline, id) || id,
      ...(section?.error ? { error: compactSectionError(section.error) } : {}),
    }));
  const value = { taskId: state.contentGenerationTask?.task_id, failedSections };
  return baseResult('waiting_confirmation', 'content', {
    code: 'content_decision_required',
    message: '正文有未完成小节，等待人工重试',
    confirmation: {
      type: 'content_decision',
      challenge: challengeFor(input.prepared, 'content', 'content_decision', value),
      actions: ['retry_failed'],
      failedSections,
    },
  });
}

async function contentStage(services) {
  const { technicalPlanStore, taskService } = services;
  let state = technicalPlanStore.loadTechnicalPlan();
  if (state.outlineGenerationTask?.status !== 'success' || !state.outlineData?.outline?.length) {
    return baseResult('failed', 'content', { code: 'outline_required', message: '请先生成完整目录' });
  }
  const outlineWait = outlineApprovalResult(state.outlineData);
  const outlineApproval = input.job?.confirmations?.outlineApproval;
  const approvals = loadApprovals();
  const outlineApproved = approvals.outline === outlineWait.confirmation.challenge
    || (outlineApproval?.approved === true && outlineApproval.challenge === outlineWait.confirmation.challenge);
  if (!outlineApproved) return { ...outlineWait, stage: 'content' };
  if (approvals.outline !== outlineWait.confirmation.challenge) {
    approvals.outline = outlineWait.confirmation.challenge;
    saveApprovals(approvals);
  }

  technicalPlanStore.saveGlobalFactsConfig({ globalFactsMode: 'placeholder' });
  if (state.globalFactsTask?.status !== 'success' || !state.globalFacts?.length) {
    if (services.codexWriting) {
      await services.codexWriting.generateFacts();
    } else {
      const observed = await observeTask(taskService, 'global-facts-generation', () => {
        taskService.startGlobalFactsGeneration({ globalFactsMode: 'placeholder' });
      });
      if (observed.task.status !== 'success') {
        return baseResult('failed', 'content', { code: 'global_facts_generation_failed', message: observed.task.error || '全局事实生成失败' });
      }
    }
    state = technicalPlanStore.loadTechnicalPlan();
  }

  const factsWait = factsConfirmationResult(state.globalFacts || []);
  const factsApproval = input.job?.confirmations?.globalFacts;
  const factsApproved = approvals.globalFacts === factsWait.confirmation.challenge
    || (factsApproval?.challenge === factsWait.confirmation.challenge
      && JSON.stringify(stable(factsApproval.groups)) === JSON.stringify(stable(state.globalFacts || [])));
  if (!factsApproved) return factsWait;
  if (approvals.globalFacts !== factsWait.confirmation.challenge) {
    technicalPlanStore.saveGlobalFacts(factsApproval.groups);
    approvals.globalFacts = factsWait.confirmation.challenge;
    saveApprovals(approvals);
  }

  state = technicalPlanStore.loadTechnicalPlan();
  if (state.contentGenerationTask?.status === 'success') {
    return baseResult('completed', 'content', { nextStage: 'export', paths: resultPaths() });
  }
  let contentStartPayload = {
    regenerate: false,
    generationOptions: {
      useAiImages: false,
      maxAiImages: 0,
      useMermaidImages: false,
      maxMermaidImages: 0,
      useHtmlImages: false,
      maxHtmlImages: 0,
      enableConsistencyAudit: true,
      consistencyRepairMode: 'normal',
    },
  };
  if (state.contentGenerationTask?.status === 'paused' && state.contentGenerationTask?.stats?.content?.awaiting_content_decision === true) {
    const waiting = contentDecisionResult(state);
    const decision = input.job?.confirmations?.contentDecision;
    if (!decision) return waiting;
    if (decision.challenge !== waiting.confirmation.challenge || decision.action !== 'retry_failed') {
      return baseResult('failed', 'content', { code: 'stale_confirmation', message: '正文重试确认已过期或无效' });
    }
    contentStartPayload = { retryFailedSections: true };
  }
  if (services.codexWriting) {
    assertTextOnlyPlan(state);
    const generationOptions = textOnlyContentOptions(contentStartPayload.generationOptions || state.contentGenerationOptions);
    technicalPlanStore.updateTechnicalPlan({ contentGenerationOptions: generationOptions });
    contentStartPayload = { ...contentStartPayload, generationOptions };
  }
  const observed = await observeTask(taskService, 'content-generation', () => {
    taskService.startContentGeneration(contentStartPayload);
  });
  if (observed.task.status !== 'success') {
    const waiting = observed.task.status === 'paused' && observed.task.stats?.content?.awaiting_content_decision === true;
    if (waiting) {
      return contentDecisionResult(technicalPlanStore.loadTechnicalPlan());
    }
    return baseResult('failed', 'content', { code: 'content_generation_failed', message: observed.task.error || '正文生成失败' });
  }
  return baseResult('completed', 'content', { nextStage: 'export', paths: resultPaths() });
}

function safeArtifactName(value) {
  return String(value || '投标文件').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 80) || '投标文件';
}

async function exportStage(services) {
  const state = services.technicalPlanStore.loadTechnicalPlan();
  if (state.contentGenerationTask?.status !== 'success' || !state.outlineData?.outline?.length) {
    return baseResult('failed', 'export', { code: 'content_required', message: '请先完成正文生成' });
  }
  const { buildDocxResult } = requireService('exportService.cjs');
  const built = await buildDocxResult({
    project_name: state.outlineData.project_name || input.job?.handoff?.task?.title,
    outline: state.outlineData.outline,
    export_format: services.configStore.load().export_format,
  });
  const filePath = path.join(input.prepared.artifacts, `${safeArtifactName(input.job?.handoff?.task?.title)}-${safeArtifactName(input.prepared.documentVersion)}.docx`);
  fs.writeFileSync(filePath, built.buffer);
  const stat = fs.statSync(filePath);
  return baseResult('completed', 'export', {
    artifacts: [{ kind: 'word', path: filePath, sha256: sha256(built.buffer), size: stat.size, warnings: built.warnings || [] }],
    paths: resultPaths(),
  });
}

async function run() {
  const services = createServices();
  try {
    if (input.prepared.stage === 'prepare') return await prepareStage(services);
    if (input.prepared.stage === 'outline') return await outlineStage(services);
    if (input.prepared.stage === 'content') return await contentStage(services);
    if (input.prepared.stage === 'export') return await exportStage(services);
    return baseResult('failed', input.prepared.stage, { code: 'invalid_stage', message: '未知编写阶段' });
  } finally {
    await services.close();
  }
}

function sanitizeError(error) {
  const code = /^[a-z0-9_]+$/i.test(String(error?.code || '')) ? String(error.code) : 'worker_failed';
  let message = String(error?.message || '易标编写阶段执行失败');
  for (const sensitivePath of [input.prepared.projectDir, input.clientRoot]) {
    if (sensitivePath) message = message.split(sensitivePath).join('<workspace>');
  }
  return baseResult('failed', input.prepared.stage, { code, message: message.slice(0, 500) });
}

app.whenReady().then(async () => {
  let result;
  try {
    fs.mkdirSync(app.getPath('temp'), { recursive: true });
    result = await run();
  } catch (error) {
    result = sanitizeError(error);
  }
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(result)}\n`, () => app.exit(result.status === 'failed' ? 1 : 0));
}, (error) => {
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(sanitizeError(error))}\n`, () => process.exit(1));
});
