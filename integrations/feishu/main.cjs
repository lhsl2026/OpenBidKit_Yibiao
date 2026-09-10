const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { loadConfig } = require('./config.cjs');
const { createStore } = require('./store.cjs');
const { createWorkflow } = require('./workflow.cjs');
const { assessTender } = require('./assessment.cjs');
const { createHttpServer } = require('./server.cjs');
const { createPrereadClient } = require('./preread.cjs');
const { createLarkClient } = require('./lark.cjs');
const { createRunner } = require('./runner.cjs');
const { createCardSource, toWorkflowAction } = require('./card-source.cjs');
const { createSelection } = require('./selection.cjs');
const { createDocumentRecovery } = require('./document-recovery.cjs');
const { isSourceInboxActive } = require('./receipt.cjs');
const { deadlineFrom, resolveDeadline } = require('./handoff-fields.cjs');

function readEvidenceInWorker(config, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Error('snapshot_cancelled'));
    const worker = new Worker(path.join(__dirname, 'snapshot-worker.cjs'), {
      workerData: Object.fromEntries(['databasePath', 'filesRoot', 'mappingsPath', 'rulesPath', 'companyId'].map(k => [k, config[k]]))
    });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (error) { worker.terminate().catch(() => {}); reject(Error('snapshot_unavailable')); } else resolve(value);
    };
    const cancel = () => finish(Error('snapshot_cancelled'));
    const timer = setTimeout(() => finish(Error('snapshot_timeout')), 60000);
    timer.unref(); signal?.addEventListener('abort', cancel, { once: true });
    worker.once('message', result => result?.ok ? finish(null, result.value) : finish(Error('snapshot_unavailable')));
    worker.once('error', () => finish(Error('snapshot_unavailable')));
    worker.once('exit', () => { if (!settled) finish(Error('snapshot_unavailable')); });
  });
}
function createApplication(config, { readEvidence = readEvidenceInWorker, clock = Date.now, cardSourceFactory = createCardSource, selectionFactory = createSelection, documentRecoveryFactory = createDocumentRecovery, codexBridgeFactory } = {}) {
  const store = createStore(path.join(config.dataRoot, 'workflow.sqlite3'));
  const snapshotController = new AbortController();
  let snapshot = { records: [], warnings: ['vault_not_configured'] }, snapshotAt = 0, vaultReady = false, rules = [];
  let refreshing = null, closed = false, fenced = false, timer, refreshTimer;
  const fresh = () => vaultReady && clock() - snapshotAt <= 90000 && clock() >= snapshotAt;
  const assess = input => {
    const a = assessTender({ ...input, snapshot, now: new Date(clock()).toISOString() });
    if (!fresh()) { a.decision = 'review'; a.blockers.push('vault_unavailable'); }
    return a;
  };
  const normalizeInput = input => {
    const h = input.handoff;
    const existing = store.current(h.task.taskId, config.companyId);
    const previous = existing?.version === String(h.snapshot.documentVersion) && existing.checksum === h.snapshot.checksum ? existing.input : {};
    const match = rules.find(r => r.taskId === h.task.taskId && String(r.documentVersion) === String(h.snapshot.documentVersion) && r.checksum === h.snapshot.checksum);
    // A configured rule file is authoritative; persisted handoffs cannot revive removed rules.
    const resolvedRules = config.rulesPath ? match?.rules ?? [] : input.rules ?? previous.rules ?? [];
    const localSource = store.get('document-source:' + h.task.taskId);
    const checksumMatches = localSource && String(h.snapshot.checksum).replace(/^sha256:/i, '').toLowerCase() === localSource.sha256;
    const handoff = localSource ? { ...h, warnings: [...h.warnings.filter(w => w.code !== 'source_checksum_mismatch'), ...(checksumMatches ? [] : [{ code: 'source_checksum_mismatch', blocked: true }])] } : h;
    return { ...previous, ...input, handoff, ...(localSource ? { sourcePath: checksumMatches ? localSource.sourcePath : undefined, sourceChecksum: localSource.sha256 } : {}), companyId: config.companyId, deadline: resolveDeadline(input, previous), rules: resolvedRules };
  };
  const core = createWorkflow({ store, assess, normalizeInput, clock, chatId: config.chatId, operatorIds: config.operatorIds });
  const assertRuntime = () => { if (fenced) runner.assertOwnership(); };
  const workflow = Object.fromEntries(['ingest', 'act', 'revalidate'].map(method => [method, (...args) => { assertRuntime(); return core[method](...args); }]));
  function revalidateAll() {
    try { assertRuntime(); } catch { return; }
    for (const p of store.listProjects()) workflow.revalidate(p.id);
  }
  function refreshEvidence() {
    if (closed) return Promise.resolve();
    if (refreshing) return refreshing;
    const startedAt = clock();
    refreshing = Promise.resolve().then(() => readEvidence(config, { signal: snapshotController.signal })).then(value => {
      if (closed) return;
      if (!Array.isArray(value?.rules) || !Array.isArray(value?.snapshot?.records)) throw Error('snapshot_invalid');
      snapshot = value.snapshot; rules = value.rules; vaultReady = true; snapshotAt = startedAt;
      revalidateAll();
    }).catch(() => {
      if (closed) return;
      snapshot = { records: [], warnings: ['vault_unavailable'] }; rules = []; vaultReady = false;
      revalidateAll();
    }).finally(() => { refreshing = null; });
    return refreshing;
  }
  const preread = config.prereadUrl ? createPrereadClient({ baseUrl: config.prereadUrl, apiKey: config.prereadKey, relayAuthorization: config.relayAuthorization }) : null;
  const lark = config.appId && config.appSecret ? createLarkClient({ appId: config.appId, appSecret: config.appSecret }) : null;
  const write = (job, { signal } = {}) => require('./writing.cjs').runWritingJob({
    job, root: config.writingRoot, electronPath: config.electronPath, clientRoot: config.clientRoot,
    modelConfig: require('./codex-attempt.cjs').writingModelConfig({ config, store, job }), signal
  });
  let selection, documentRecovery;
  const runner = createRunner({ store, config, workflow, preread, lark, write, clock,
    onReceipt: (receipt, meta) => { selection.queue(receipt, meta); documentRecovery.queueReceipt(receipt, meta); },
    onSourceEdited: inboxId => selection.invalidateInbox(inboxId), onTick: args => documentRecovery.tick(args) });
  documentRecovery = documentRecoveryFactory({ store, config, clock, assertOwnership: () => runner.assertOwnership(), isSourceActive: job => !job.sourceInboxId || isSourceInboxActive(store, job.sourceInboxId) });
  selection = selectionFactory({ store, config, preread, clock, assertOwnership: () => runner.assertOwnership(), onReceipt: (receipt, meta) => documentRecovery.queueReceipt(receipt, meta) });
  const cardSource = cardSourceFactory({ config, workflow, assertOwnership: () => runner.assertOwnership(), clock,
    onAction: (value, event) => value.agent === 'openbidkit-selection' ? selection.act(value, event) : workflow.act(toWorkflowAction(value, event)) });
  const makeCodexBridge = codexBridgeFactory ?? (args => require('./codex-bridge.cjs').createCodexBridge({
    ...args, executor: require('./codex-executor.cjs').createCodexExecutor(config.codexBridge)
  }));
  const codexBridge = config.codexBridge?.enabled ? makeCodexBridge({
    config, store, clock, assertOwnership: () => runner.assertOwnership()
  }) : null;
  function readiness() {
    const missing = [];
    if (!config.companyId) missing.push('company');
    if (!config.apiKey) missing.push('internal_api_key');
    if (!fresh()) missing.push('vault');
    if (!config.mappingsPath) missing.push('ownership_mappings');
    if (codexBridge ? !codexBridge.status().ready : !config.modelConfig.api_key || !config.modelConfig.model_name || !config.modelConfig.base_url) missing.push('model');
    if (!preread || !config.prereadKey || !config.relayAuthorization) missing.push('preread');
    if (!config.sourceChats.length || !config.sourceSenders.length) missing.push('radar_allowlist');
    if (config.radarPolling?.enabled && config.sourceChats.some(chat=>{const s=store.get('radar-source:'+chat);return !s?.lastSuccessAt||s.error||clock()-s.lastSuccessAt>300000;})) missing.push('radar_source');
    if (!config.operatorIds.length || (config.cardSource?.enabled ? !cardSource.status().ready : !config.verificationToken || !config.encryptKey)) missing.push('card_callback');
    if (config.mode !== 'test') missing.push('test_delivery');
    try { assertRuntime(); } catch { missing.push('service_ownership'); }
    return { ready: missing.length === 0, mode: config.mode, missing };
  }
  const server = createHttpServer({ config, workflow, store, readiness, radar: runner.receiveRadar, assertOwnership: assertRuntime });
  return { store, workflow, runner, cardSource, selection, documentRecovery, codexBridge, server, readiness, refreshEvidence,
    async start() {
      if (!runner.acquire()) throw Error('runner_instance_active');
      fenced = true;
      try {
        cardSource.start();
        if (codexBridge) await codexBridge.start();
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
      } catch (error) {
        await cardSource.close();
        if (codexBridge) await codexBridge.close();
        await runner.close();
        throw error;
      }
      await refreshEvidence();
      if (closed) return;
      timer = setInterval(() => runner.tick().catch(() => console.error('runner_tick_failed')), 5000);
      refreshTimer = setInterval(refreshEvidence, 60000);
      await runner.tick();
    },
    async close() {
      if (closed) return; closed = true;
      clearInterval(timer); clearInterval(refreshTimer); snapshotController.abort();
      await cardSource.close();
      if (codexBridge) await codexBridge.close();
      await new Promise(r => server.close(r));
      await runner.close(); store.close();
    }
  };
}
if (require.main === module) {
  try {
    const app = createApplication(loadConfig());
    app.start().then(() => console.log(JSON.stringify({ status: 'listening', ...app.readiness() }))).catch(() => { console.error('startup_failed'); process.exit(1); });
    let closing = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { if (closing) return; closing = true; await app.close(); process.exit(0); });
  } catch { console.error('configuration_invalid'); process.exit(1); }
}
module.exports = { createApplication, deadlineFrom, readEvidenceInWorker };
