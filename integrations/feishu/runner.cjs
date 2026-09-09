const { randomUUID } = require('node:crypto');
const { key } = require('./store.cjs');
const { deliverOutbox } = require('./lark.cjs');
const { buildSummary } = require('./card.cjs');
const { enqueueArtifacts, deliverFiles } = require('./files.cjs');

function createRunner({ store, config, workflow, preread, lark, write, clock = Date.now }) {
  const owner = randomUUID(), controller = new AbortController();
  let running = false, acquired = false, lost = false, closing = false, renewal;
  const revalidate = id => workflow.revalidate ? workflow.revalidate(id) : store.getProject(id);

  function loseOwnership() {
    lost = true; clearInterval(renewal); controller.abort(new Error('runner_lease_lost'));
  }
  function assertOwnership() {
    if (lost || !acquired || !store.ownsLease('runner', owner, clock())) {
      loseOwnership(); throw Error('runner_lease_lost');
    }
  }
  function acquire() {
    if (closing || lost) return false;
    if (acquired) { assertOwnership(); return true; }
    const ok = store.transaction(() => {
      if (!store.lease('runner', owner, clock(), 60000)) return false;
      // Recovery is protected by the same ownership used throughout this service lifetime.
      for (const job of store.listWriting().filter(j => j.status === 'running')) {
        store.updateWriting(job.id, 'interrupted', { code: 'process_interrupted' }, clock());
        store.touchCard(job.project_id, clock());
      }
      return true;
    });
    if (!ok) return false;
    acquired = true;
    renewal = setInterval(() => {
      try { if (!store.renewLease('runner', owner, clock(), 60000)) loseOwnership(); }
      catch { loseOwnership(); }
    }, 15000);
    renewal.unref(); return true;
  }
  function receiveRadar(input) {
    if (acquired || lost) assertOwnership();
    if (!config.sourceChats?.includes(input.chatId) || !config.sourceSenders?.includes(input.senderId)) throw Error('source_not_allowed');
    if (input.eventType !== 'im.message.receive_v1' || !input.messageId || !input.eventId) throw Error('radar_invalid');
    const payload = Object.fromEntries(['eventType', 'eventId', 'chatId', 'chatType', 'messageId', 'messageType', 'createTime', 'senderId', 'senderType', 'content'].filter(k => input[k] !== undefined).map(k => [k, input[k]]));
    store.receiveRadar(key('radar', input.chatId, input.messageId), payload); return { status: 'accepted' };
  }
  function recoverArtifacts() {
    if (!config.writingRoot) return;
    for (const job of store.listWriting()) {
      if (!['queued', 'completed', 'waiting_confirmation'].includes(job.status) || !job.result) continue;
      const marker = 'artifactsQueued:' + key(job.id, job.payload.deliveryEpoch, job.result);
      if (store.get(marker)) continue;
      assertOwnership(); const p = revalidate(job.project_id);
      if (!canWrite(p, clock())) continue;
      // Result already persisted: disk/SQL failure is safely retried next tick, never by rerunning the model.
      store.transaction(() => {
        enqueueArtifacts(store, p.id, job.result, config.writingRoot);
        store.set(marker, true); store.touchCard(p.id, clock());
      });
    }
  }
  async function tick() {
    if (running || closing || !acquire()) return;
    running = true;
    try {
      assertOwnership();
      if (preread) {
        for (const row of store.listInbox(clock())) {
          try {
            assertOwnership(); const result = await preread.receiveRadar(row.payload); assertOwnership();
            if (result.status === 'processing') throw Error('pending');
            store.transaction(() => {
              for (const r of result.results ?? []) if (typeof r.taskId === 'string' && r.taskId) store.watch(r.taskId, { companyId: config.companyId });
              store.finishInbox(row.id);
            });
          } catch { assertOwnership(); store.retryInbox(row.id, clock()); }
        }
        for (const w of store.listWatches(clock())) {
          try {
            assertOwnership(); const handoff = await preread.getHandoff(w.task_id); assertOwnership();
            workflow.ingest({ ...w.payload, handoff }); store.deferWatch(w.task_id, clock());
          } catch { assertOwnership(); store.deferWatch(w.task_id, clock(), 'handoff_unavailable'); }
        }
      }
      recoverArtifacts();
      if (write) for (const selected of store.listWriting().filter(j => j.status === 'queued')) {
        assertOwnership(); let p = revalidate(selected.project_id);
        const job = store.listWriting().find(j => j.id === selected.id);
        if (!canWrite(p, clock()) || job.status !== 'queued') {
          if (job.status === 'queued') store.updateWriting(job.id, 'cancelled', { code: 'project_not_ready' }, clock());
          continue;
        }
        store.transaction(() => { store.updateWriting(job.id, 'running', job.result, clock()); store.touchCard(p.id, clock()); });
        let result;
        try { result = await write({ ...job.payload, stage: job.stage }, { signal: controller.signal }); }
        catch { result = { status: 'failed', code: 'worker_failed' }; }
        assertOwnership(); p = revalidate(job.project_id);
        const current = store.listWriting().find(j => j.id === job.id);
        if (!canWrite(p, clock()) || current.status !== 'running') {
          store.updateWriting(job.id, 'cancelled', { code: 'project_changed' }, clock()); continue;
        }
        if (!result || typeof result.status !== 'string') result = { status: 'failed', code: 'worker_result_invalid' };
        store.transaction(() => {
          if (result.status === 'completed' && result.nextStage) store.updateWriting(job.id, 'queued', result, clock(), result.nextStage);
          else store.updateWriting(job.id, result.status, result, clock());
          store.touchCard(p.id, clock());
        });
        recoverArtifacts();
      }
      assertOwnership();
      const local = new Date(clock() + 8 * 3600000), day = local.toISOString().slice(0, 10);
      if (local.getUTCHours() >= config.summaryHour) store.enqueueSummary(day, buildSummary(day, store.listProjects(), store.countPendingWatches(config.companyId)));
      if (lark) {
        const args = { store, client: lark, mode: config.mode, chatId: config.chatId, allowedChats: config.allowedChats, clock, assertOwnership, revalidate };
        if (config.writingRoot) await deliverFiles({ ...args, root: config.writingRoot });
        await deliverOutbox(args);
      }
    } finally { running = false; }
  }
  async function close() {
    closing = true; controller.abort(new Error('runner_stopping'));
    while (running) await new Promise(r => setTimeout(r, 20));
    clearInterval(renewal); if (acquired) store.release('runner', owner); acquired = false;
  }
  return { tick, receiveRadar, acquire, assertOwnership, close, isRunning: () => running };
}
function canWrite(p, now) {
  return p?.current && p.humanDecision === 'follow' && p.assessment.decision === 'follow' && p.input.handoff.status === 'ready'
    && !p.input.handoff.superseded && !p.input.handoff.warnings.some(w => w.blocked) && Date.parse(p.input.deadline) > now;
}
module.exports = { createRunner, canWrite };
