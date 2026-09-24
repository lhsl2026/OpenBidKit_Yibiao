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
const { createPrereadCardRelay } = require('./preread-card-relay.cjs');
const { createSelection } = require('./selection.cjs');
const { createDocumentRecovery } = require('./document-recovery.cjs');
const { createReportArchive } = require('./report-archive.cjs');
const { createWritingConfirmationDoc } = require('./writing-confirmation-doc.cjs');
const { createGroupFileSource } = require('./group-file-source.cjs');
const { isSourceInboxActive } = require('./receipt.cjs');
const { deadlineFrom, resolveDeadline } = require('./handoff-fields.cjs');
const { buildCompanyEvidenceProfile, createCompanyEvidenceSync } = require('./company-evidence.cjs');

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
const reviewText=(value,max=240)=>typeof value==='string'&&value.trim()?value.trim().slice(0,max):undefined;
function compactCompanyReview(review,state,company){
  const enabled=Array.isArray(state?.companies)?state.companies.filter(candidate=>candidate?.enabled!==false):[];
  const implicitSingle=state?.selectedCompanyId==null&&state?.selectedCompanyProfileVersion==null&&enabled.length===1&&enabled[0]?.companyId===company?.companyId&&enabled[0]?.profileVersion===company?.profileVersion;
  const identityMatches=implicitSingle?review?.companyId==null&&review?.companyProfileVersion==null:review?.companyId===state?.selectedCompanyId&&review?.companyProfileVersion===state?.selectedCompanyProfileVersion;
  if(!review||review.taskId!==state.taskId||review.runId!==state.runId||!identityMatches||!Array.isArray(review.items))throw Error('company_match_review_stale');
  const statuses=new Set(['confirmed_met','gap','not_applicable','unconfirmed','company_profile_missing','pending_manual_confirmation','pending_match']);
  const items=review.items.slice(0,50).flatMap(item=>{
    const id=reviewText(item?.id,128),requirement=reviewText(item?.requirement),matchStatus=reviewText(item?.matchStatus,64);
    if(!id||!requirement||!matchStatus||!statuses.has(matchStatus))return[];
    const page=Number.isInteger(item?.evidence?.page)&&item.evidence.page>0?item.evidence.page:undefined;
    return[{id,requirement,matchStatus,...(reviewText(item.evidenceRequirement)?{evidenceRequirement:reviewText(item.evidenceRequirement)}:{}),...(reviewText(item.gapAction)?{gapAction:reviewText(item.gapAction)}:{}),...(page?{page}:{})}];
  });
  const counts={confirmed:0,pending:0,gaps:0,notApplicable:0};
  for(const item of items){if(item.matchStatus==='confirmed_met')counts.confirmed++;else if(item.matchStatus==='gap')counts.gaps++;else if(item.matchStatus==='not_applicable')counts.notApplicable++;else counts.pending++;}
  return{taskId:review.taskId,runId:review.runId,companyId:implicitSingle?company.companyId:review.companyId,companyProfileVersion:implicitSingle?company.profileVersion:review.companyProfileVersion,counts,items};
}
function createApplication(config, { readEvidence = readEvidenceInWorker, clock = Date.now, cardSourceFactory = createCardSource, prereadCardRelayFactory = createPrereadCardRelay, selectionFactory = createSelection, documentRecoveryFactory = createDocumentRecovery, groupFileSourceFactory = createGroupFileSource, codexBridgeFactory, prereadFactory = createPrereadClient } = {}) {
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
    refreshing = Promise.resolve().then(() => readEvidence(config, { signal: snapshotController.signal })).then(async value => {
      if (closed) return;
      if (!Array.isArray(value?.rules) || !Array.isArray(value?.snapshot?.records)) throw Error('snapshot_invalid');
      snapshot = value.snapshot; rules = value.rules; vaultReady = true; snapshotAt = startedAt;
      if (companyEvidence) {
        try { await companyEvidence.replace(buildCompanyEvidenceProfile(snapshot, { companyId: config.companyId })); } catch {}
      }
      revalidateAll();
    }).catch(() => {
      if (closed) return;
      snapshot = { records: [], warnings: ['vault_unavailable'] }; rules = []; vaultReady = false;
      revalidateAll();
    }).finally(() => { refreshing = null; });
    return refreshing;
  }
  const preread = config.prereadUrl ? prereadFactory({ baseUrl: config.prereadUrl, apiKey: config.prereadKey, relayAuthorization: config.relayAuthorization }) : null;
  const companyEvidence = config.companyEvidence?.enabled ? createCompanyEvidenceSync({ store, client: preread, companyId: config.companyId }) : null;
  const lark = config.appId && config.appSecret ? createLarkClient({ appId: config.appId, appSecret: config.appSecret }) : null;
  const write = (job, { signal } = {}) => require('./writing.cjs').runWritingJob({
    job, root: config.writingRoot, electronPath: config.electronPath, clientRoot: config.clientRoot,
    modelConfig: require('./codex-attempt.cjs').writingModelConfig({ config, store, job }), signal
  });
  let selection, documentRecovery, reportArchive, writingConfirmationDoc, runner;
  const groupFileSource = groupFileSourceFactory({store,config,preread,clock,assertOwnership:()=>runner.assertOwnership(),waitingCandidates:()=>documentRecovery?.waitingCandidates?.()??[],onReceipt:(receipt,meta)=>{selection?.queue(receipt,meta);documentRecovery?.queueReceipt(receipt,meta);}});
  runner = createRunner({ store, config, workflow, preread, lark, write, clock,groupFileSource,
    onReceipt: (receipt, meta) => { selection.queue(receipt, meta); documentRecovery.queueReceipt(receipt, meta); },
    onSourceEdited: inboxId => selection.invalidateInbox(inboxId), onTick: async args => { await documentRecovery.tick(args); await reportArchive.tick(args); await writingConfirmationDoc.tick(args); } });
  documentRecovery = documentRecoveryFactory({ store, config, clock, assertOwnership: () => runner.assertOwnership(), isSourceActive: job => !job.sourceInboxId || isSourceInboxActive(store, job.sourceInboxId) });
  reportArchive = createReportArchive({ store, config, preread, clock, assertOwnership: () => runner.assertOwnership() });
  writingConfirmationDoc = createWritingConfirmationDoc({ store, config, clock, assertOwnership: () => runner.assertOwnership() });
  selection = selectionFactory({ store, config, preread, clock, assertOwnership: () => runner.assertOwnership(), onReceipt: (receipt, meta) => documentRecovery.queueReceipt(receipt, meta) });
  const handleCompanyMatchAction=async(value,event)=>{
    if(!preread||!['select','review'].includes(value.action))throw Error('company_match_action_invalid');
    const action={eventId:event.eventId,chatId:event.chatId,operatorId:event.actorId,sourceCardMessageId:event.messageId,action:value.action==='select'?'select_company':'review_company_match',taskId:value.taskId,runId:value.runId,documentVersion:value.documentVersion,companyId:value.companyId,companyProfileVersion:value.companyProfileVersion,scopeType:value.scopeType,scopeId:value.scopeId};
    const hash=store.key(action),saved=store.getAction(event.eventId);if(saved){if(saved.hash!==hash)throw Error('event_conflict');return saved.result;}
    const p=store.getProject(value.projectId),state=p?.input?.companyMatchCard;
    if(!p?.current||p.version!==value.version||!p.messageId||p.messageId!==event.messageId||value.sourceCardMessageId!==event.messageId||store.key(p.input,p.assessment)!==value.cardKey)throw Error('company_match_card_stale');
    const groupMember=value.scopeType==='group'&&value.scopeId===event.chatId&&event.chatId===config.chatId;
    const privateOperator=value.scopeType==='private'&&value.scopeId===event.actorId&&config.operatorIds?.includes(event.actorId);
    if(!groupMember&&!privateOperator)throw Error('company_match_scope_mismatch');
    const company=state?.companies?.find(candidate=>candidate.enabled!==false&&candidate.companyId===value.companyId);
    if(state?.taskId!==value.taskId||state?.runId!==value.runId||state?.documentVersion!==value.documentVersion||state?.sourceCardMessageId!==value.sourceCardMessageId||!company||company.profileVersion!==value.companyProfileVersion)throw Error('company_match_card_stale');
    const result=await preread.select(action);
    if(value.action==='select'){
      const [handoff,companyState]=await Promise.all([preread.getHandoff(value.taskId),preread.getCompanyMatchCard(value.taskId)]);
      workflow.ingest({...p.input,handoff,companyMatchCard:{...companyState,scopeType:companyState.scopeType??value.scopeType,scopeId:companyState.scopeId??value.scopeId}});
    }else{
      store.set('company-match-review:'+p.id,compactCompanyReview(result?.review,state,company));
      store.touchCard(p.id,clock());
    }
    store.saveAction(event.eventId,hash,result,clock());return result;
  };
  const prereadCardRelay=prereadCardRelayFactory({config});
  const dispatchCardAction = (value, event, route) => route==='preread_callback'?prereadCardRelay.handle(value.raw):(route==='preread'||(!route&&value.agent==='openbidkit-group-file')) ? groupFileSource.select(value,event) : (route==='selection'||(!route&&value.agent==='openbidkit-selection')) ? selection.act(value, event) : route==='company_match'&&['select','review'].includes(value.action)?handleCompanyMatchAction(value,event):workflow.act(toWorkflowAction(value, event));
  const cardSource = cardSourceFactory({ config, workflow, assertOwnership: () => runner.assertOwnership(), clock,
    onAction: dispatchCardAction });
  const makeCodexBridge = codexBridgeFactory ?? (args => require('./codex-bridge.cjs').createCodexBridge({
    ...args, executor: require('./codex-executor.cjs').createCodexExecutor(config.codexBridge)
  }));
  const codexBridge = config.codexBridge?.enabled ? makeCodexBridge({
    config, store, clock, assertOwnership: () => runner.assertOwnership()
  }) : null;
  function readiness() {
    const missing = [];
    const cardState = cardSource.status();
    const prereadCardState=prereadCardRelay.status();
    if (!config.companyId) missing.push('company');
    if (!config.apiKey) missing.push('internal_api_key');
    if (!fresh()) missing.push('vault');
    if (!config.mappingsPath) missing.push('ownership_mappings');
    if (config.companyEvidence?.enabled && !companyEvidence?.status().ready) missing.push('company_profile');
    if (codexBridge ? !codexBridge.status().ready : !config.modelConfig.api_key || !config.modelConfig.model_name || !config.modelConfig.base_url) missing.push('model');
    if (!preread || !config.prereadKey || !config.relayAuthorization) missing.push('preread');
    if (!config.sourceChats.length || !config.sourceSenders.length) missing.push('radar_allowlist');
    if (config.radarPolling?.enabled && config.sourceChats.some(chat=>{const s=store.get('radar-source:'+chat);return !s?.lastSuccessAt||s.error||clock()-s.lastSuccessAt>300000;})) missing.push('radar_source');
    const groupFileState=groupFileSource.status();if(config.groupFileSource?.enabled&&(!groupFileState.lastSuccessAt||groupFileState.error||clock()-groupFileState.lastSuccessAt>300000))missing.push('group_file_source');
    if (!config.operatorIds.length || (config.cardSource?.enabled ? !cardState.ready : !config.verificationToken || !config.encryptKey)) missing.push('card_callback');
    if(config.prereadCardRelay?.enabled&&!prereadCardState.ready)missing.push('preread_card_callback');
    const delivery = config.mode === 'production'
      ? { target: 'production', configured: Boolean(config.production?.cutover && config.chatId === config.production.chatId && config.allowedChats?.includes(config.chatId)) }
      : config.mode === 'test'
        ? { target: 'test', configured: Boolean(config.chatId && config.allowedChats?.includes(config.chatId)) }
        : { target: 'disabled', configured: false };
    if (config.mode === 'production' && !delivery.configured) missing.push('production_delivery');
    else if (config.mode === 'test' && !delivery.configured) missing.push('test_delivery');
    else if (config.mode === 'disabled') missing.push('delivery_disabled');
    try { assertRuntime(); } catch { missing.push('service_ownership'); }
    const cardCallback = {
      enabled: Boolean(config.cardSource?.enabled),
      ready: config.cardSource?.enabled ? Boolean(cardState.ready) : Boolean(config.operatorIds.length && config.verificationToken && config.encryptKey),
      accepted: Number.isSafeInteger(cardState.accepted) ? cardState.accepted : 0,
      rejected: Number.isSafeInteger(cardState.rejected) ? cardState.rejected : 0,
      error: typeof cardState.error === 'string' ? cardState.error : null,
      lastReadyAt: Number.isFinite(cardState.lastReadyAt) ? cardState.lastReadyAt : null,
      lastEventAt: Number.isFinite(cardState.lastEventAt) ? cardState.lastEventAt : null,
    };
    return { ready: missing.length === 0, mode: config.mode, delivery, cardCallback, prereadCardCallback:prereadCardState, missing };
  }
  const server = createHttpServer({ config, workflow, store, readiness, radar: runner.receiveRadar, onCardAction: dispatchCardAction, assertOwnership: assertRuntime });
  return { store, workflow, runner, cardSource, prereadCardRelay, selection, documentRecovery, groupFileSource, reportArchive, writingConfirmationDoc, companyEvidence, codexBridge, server, readiness, refreshEvidence,
    async start() {
      if (!runner.acquire()) throw Error('runner_instance_active');
      fenced = true;
      try {
        selection.refreshWaitingCards?.();
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
