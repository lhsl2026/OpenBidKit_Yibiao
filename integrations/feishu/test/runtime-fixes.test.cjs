const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createStore } = require('../store.cjs');
const { createWorkflow } = require('../workflow.cjs');
const { createRunner, canWrite } = require('../runner.cjs');
const { deliverOutbox } = require('../lark.cjs');
const { deliverFiles, enqueueArtifacts } = require('../files.cjs');
const { createApplication, readEvidenceInWorker } = require('../main.cjs');
const { loadConfig } = require('../config.cjs');

const good = { decision: 'follow', items: [], blockers: [], actions: [] };
test('writing gate allows evidence placeholders but blocks unsafe review states',()=>{
 const project={current:true,humanDecision:'follow',input:{deadline:'2099-01-01T00:00:00+08:00',handoff:{status:'ready',superseded:false,warnings:[]}},assessment:{decision:'review',items:[{requirementId:'q',status:'review',reasons:['verified_evidence_missing']}],blockers:['q:verified_evidence_missing']}};
 assert.equal(canWrite(project,Date.parse('2026-09-17T00:00:00Z')),true);
 const sourceReview={...project,assessment:{decision:'review',items:[{requirementId:'redline',status:'review',reasons:['requirement_confirmation_pending','requirement_confidence_low','structured_rule_missing']}],blockers:['redline:requirement_confirmation_pending','redline:requirement_confidence_low','redline:structured_rule_missing']}};
 assert.equal(canWrite(sourceReview,Date.parse('2026-09-17T00:00:00Z')),true);
 assert.equal(canWrite({...project,assessment:{decision:'review',items:[{requirementId:'q',status:'not_satisfied',reasons:['manual_result_not_satisfied']}],blockers:['q:manual_result_not_satisfied']}},Date.parse('2026-09-17T00:00:00Z')),false);
 assert.equal(canWrite({...project,assessment:{decision:'review',items:[{requirementId:'q',status:'review',reasons:['requirement_confidence_invalid']}],blockers:['q:requirement_confidence_invalid']}},Date.parse('2026-09-17T00:00:00Z')),false);
 assert.equal(canWrite({...project,assessment:{decision:'review',items:[],blockers:['vault_unavailable']}},Date.parse('2026-09-17T00:00:00Z')),false);
});
test('a fenced live process fails health so the supervisor can restart it',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bid-health-'));
  const config={...loadConfig({}),dataRoot:root,port:0,companyId:'c'};
  const app=createApplication(config,{readEvidence:async()=>({snapshot:{records:[],warnings:[]},rules:[]})});
  t.after(async()=>{await app.close();fs.rmSync(root,{recursive:true,force:true});});await app.start();
  const url='http://127.0.0.1:'+app.server.address().port+'/health';assert.equal((await fetch(url)).status,200);
  app.store.db.prepare("UPDATE leases SET owner='other-owner' WHERE name='runner'").run();
  assert.equal((await fetch(url)).status,503);app.store.db.prepare("DELETE FROM leases WHERE name='runner'").run();
  assert.equal((await fetch(url)).status,503);assert.equal(app.runner.acquire(),false);
});
const bad = { decision: 'review', items: [], blockers: ['vault_unavailable'], actions: [] };
function input(version = 'v1') {
  return { companyId: 'c', deadline: '2099-01-01T00:00:00+08:00', rules: [{ requirementId: 'q', kind: 'manual', verified: true, result: 'satisfied' }], handoff: {
    schemaVersion: '1.0', task: { taskId: 't', title: 'Synthetic tender' },
    snapshot: { documentVersion: version, reportId: 'r', reportVersion: 'r1', completeness: 1, confidence: 1, checksum: 'a'.repeat(64), generatedAt: version === 'v1' ? '2026-09-08T00:00:00Z' : '2026-09-09T00:00:00Z' },
    latestDocumentVersion: version, superseded: false, status: 'ready',
    requirements: [{ id: 'q', key: 'Synthetic qualification', category: 'qualification', value: 'Synthetic rule', coordinate: 'synthetic.pdf#page=1', confidence: 1, requiresConfirmation: false }], warnings: [], evidence: []
  } };
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bid-runtime-'));
  const store = createStore(path.join(root, 'state.db'));
  let assessment = good;
  const workflow = createWorkflow({ store, assess: () => assessment, chatId: 'chat', operatorIds: ['actor'] });
  const p = workflow.ingest(input()); store.bindMessage(p.id, 'm');
  const base = { projectId: p.id, version: p.version, chatId: 'chat', actorId: 'actor', messageId: 'm', get cardKey() { const current = store.getProject(p.id); return store.key(current.input, current.assessment); } };
  workflow.act({ ...base, action: 'follow', eventId: 'f' });
  const runners = [];
  const config = { mode: 'disabled', summaryHour: 23, writingRoot: root };
  const runner = extra => { const r = createRunner({ store, workflow, config, ...extra }); runners.push(r); return r; };
  t.after(async () => { for (const r of runners) await r.close?.(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, store, workflow, p, base, runner, revoke: () => { assessment = bad; }, restore: () => { assessment = good; }, enqueue: () => workflow.act({ ...base, action: 'write', eventId: 'w' }) };
}

test('evidence revoked after enqueue prevents worker execution and clears confirmation', async t => {
  const f = fixture(t); f.enqueue(); f.revoke();
  const r = f.runner({ write: async () => { assert.fail('revoked project reached worker'); } });
  await r.tick();
  assert.equal(f.store.listWriting()[0].status, 'cancelled');
  assert.equal(f.store.getProject(f.p.id).humanDecision, null);
});

test('a source-required writing job recovers the verified preread document and resumes without another employee decision', async t => {
  const f = fixture(t); f.enqueue(); const waiting = f.store.listWriting()[0];
  f.store.updateWriting(waiting.id, 'waiting_confirmation', { status: 'waiting_confirmation', code: 'source_required', confirmation: { type: 'source_file' } }, Date.now());
  const sourcePath = path.join(f.root, 'verified.pdf'); fs.writeFileSync(sourcePath, '%PDF-1.7\nverified\n%%EOF');
  let runs = 0;
  const r = f.runner({
    recoverSource: async ({ project, job }) => { assert.equal(project.humanDecision, 'follow'); assert.equal(job.id, waiting.id); return { sourcePath, sha256: 'a'.repeat(64) }; },
    write: async job => { runs++; assert.equal(job.sourcePath, sourcePath); return { status: 'waiting_confirmation', confirmation: { type: 'outline', challenge: 'outline-ready', sections: [] } }; }
  });
  await r.tick();
  const resumed = f.store.listWriting()[0];
  assert.equal(runs, 1); assert.equal(resumed.status, 'waiting_confirmation'); assert.equal(resumed.result.confirmation.type, 'outline');
  assert.equal(f.store.getProject(f.p.id).humanDecision, 'follow');
});

test('a draft affected by the empty outline-selection bug resumes once without another employee action', async t => {
  const f = fixture(t); f.enqueue(); const failed = f.store.listWriting()[0];
  failed.payload.confirmations = {
    outlineSelection: { challenge: 'legacy-outline', taskId: 'outline-task', selectedIds: [] },
  };
  f.store.resumeWriting(failed, failed.payload, Date.now(), 'outline');
  f.store.updateWriting(failed.id, 'failed', { status: 'failed', code: 'invalid_outline_selection', message: '目录选择无效' }, Date.now(), 'outline');
  let runs = 0;
  const r = f.runner({ write: async job => {
    runs++;
    assert.deepEqual(job.confirmations.outlineSelection.selectedIds, []);
    return { status: 'waiting_confirmation', confirmation: { type: 'outline', challenge: 'outline-ready', outlineData: { outline: [] } } };
  } });
  await r.tick();
  const resumed = f.store.listWriting()[0];
  assert.equal(runs, 1);
  assert.equal(resumed.status, 'waiting_confirmation');
  assert.deepEqual(f.store.get('legacyOutlineRecovery:' + failed.id), { completed: true });
  assert.equal(f.store.getProject(f.p.id).humanDecision, 'follow');
});

test('evidence revoked during worker execution discards its returned artifacts', async t => {
  const f = fixture(t); f.enqueue();
  const r = f.runner({ write: async () => { f.revoke(); return { status: 'completed', artifacts: [{ path: '/unused', sha256: 'b' }] }; } });
  await r.tick();
  assert.equal(f.store.listWriting()[0].status, 'cancelled');
  assert.equal(f.store.listFiles(Date.now()).length, 0);
});

test('first send racing a new document binds and refreshes the same remote card', async t => {
  const store = createStore(':memory:'); t.after(() => store.close());
  const workflow = createWorkflow({ store, assess: () => good });
  workflow.ingest(input()); let sends = 0; const updates = [];
  const client = { sendCard: async () => { sends++; workflow.ingest(input('v2')); return 'remote-card'; }, updateCard: async (id, card) => updates.push({ id, card }) };
  const args = { store, client, mode: 'test', chatId: 'chat', allowedChats: ['chat'] };
  await deliverOutbox(args); await deliverOutbox(args);
  assert.equal(sends, 1);
  assert.equal(store.current('t', 'c').messageId, 'remote-card');
  assert.ok(updates.some(v => v.id === 'remote-card' && JSON.stringify(v.card).includes('v2')));
});

test('ambiguous first send uses the same deduplication identity after version replacement', async t => {
  const store = createStore(':memory:'); t.after(() => store.close());
  const workflow = createWorkflow({ store, assess: () => good }); workflow.ingest(input());
  const ids = []; let now = 1000;
  const client = { sendCard: async (_chat, _card, id) => { ids.push(id); if (ids.length === 1) { workflow.ingest(input('v2')); throw Error('response lost after accepted'); } return 'm'; }, updateCard: async () => {} };
  const args = { store, client, mode: 'test', chatId: 'chat', allowedChats: ['chat'], clock: () => now };
  await deliverOutbox(args); now += 6000; await deliverOutbox(args);
  assert.equal(ids.length, 2); assert.equal(ids[0], ids[1]);
});

test('second service cannot recover a running task protected by the first service lease', async t => {
  const f = fixture(t); f.enqueue();
  const config = { ...loadConfig({ BID_DATA_ROOT: f.root, BID_COMPANY_ID: 'c' }), port: 0 };
  // Application stores use workflow.sqlite3; give both applications the same live store below.
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bid-owner-'));
  t.after(() => fs.rmSync(appRoot, { recursive: true, force: true }));
  const app = createApplication({ ...config, dataRoot: appRoot });
  const p = { ...f.store.getProject(f.p.id), created: Date.now() };
  app.store.saveProject(p); app.store.enqueueWriting(p, Date.now());
  const job = app.store.listWriting()[0]; app.store.updateWriting(job.id, 'running', null, Date.now());
  app.store.lease('runner', 'other-live-process', Date.now(), 60000);
  try {
    await assert.rejects(app.start(), /instance|lease|owner/);
    assert.equal(app.store.listWriting()[0].status, 'running');
  } finally { await app.close(); }
});

test('lease loss during worker await prevents result commits and further external effects', async t => {
  const f = fixture(t); f.enqueue();
  const r = f.runner({ write: async () => {
    f.store.db.prepare("UPDATE leases SET owner='replacement',expires=? WHERE name='runner'").run(Date.now() + 60000);
    return { status: 'completed', artifacts: [{ path: '/unused', sha256: 'b' }] };
  } });
  await r.tick().catch(e => assert.match(e.message, /lease|owner/));
  assert.equal(f.store.listWriting()[0].status, 'running');
  assert.equal(f.store.listFiles(Date.now()).length, 0);
});

test('saved worker results rebuild missing artifact outbox without rerunning the model', async t => {
  const f = fixture(t); f.enqueue(); const job = f.store.listWriting()[0];
  const artifact=path.join(f.root,'已生成初稿.docx');fs.writeFileSync(artifact,'Synthetic draft');
  f.store.updateWriting(job.id, 'completed', { status: 'completed', artifacts: [{path:artifact,sha256:createHash('sha256').update('Synthetic draft').digest('hex')}] }, Date.now());
  const r = f.runner({ write: async () => assert.fail('saved result reran model') });
  await r.tick();
  const rows = f.store.listFiles(Date.now()); assert.equal(rows.length, 1);
  assert.equal(path.basename(rows[0].path),'已生成初稿.docx');
  await r.tick(); assert.equal(f.store.listFiles(Date.now()).length, 1);
});

test('waiting confirmations bypass file delivery and remain gated for online document publication', async t => {
  const f = fixture(t); f.enqueue(); const job = f.store.listWriting()[0];
  const result = { status: 'waiting_confirmation', confirmation: { type: 'outline', challenge: 'atomic-preview', sections: [] } };
  f.store.updateWriting(job.id, 'waiting_confirmation', result, Date.now()); enqueueArtifacts(f.store, f.p.id, result, f.root);
  assert.equal(f.store.listFiles(Infinity).length,0);
  assert.equal(f.store.get('confirmationPublished:atomic-preview'),null);
});

test('configured rules can be revoked despite persisted handoff rules and stale cache fails closed', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bid-cache-')); let now = Date.now();
  let rules = [{ taskId: 't', documentVersion: 'v1', checksum: 'a'.repeat(64), rules: input().rules }];
  const readEvidence = async () => ({ snapshot: { records: [], warnings: [] }, rules });
  const config = { ...loadConfig({ BID_DATA_ROOT: root, BID_COMPANY_ID: 'c', BID_RULES_FILE: 'configured-rules', BID_CHAT_ID: 'chat', BID_OPERATOR_IDS: 'actor' }), port: 0 };
  const app = createApplication(config, { readEvidence, clock: () => now });
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await app.refreshEvidence(); const p = app.workflow.ingest(input());
  assert.equal(p.assessment.decision, 'follow'); app.store.bindMessage(p.id, 'm');
  const base = { projectId: p.id, version: p.version, chatId: 'chat', actorId: 'actor', messageId: 'm', cardKey: app.store.key(p.input, p.assessment) };
  app.workflow.act({ ...base, action: 'follow', eventId: 'f' });
  rules = []; await app.refreshEvidence();
  assert.throws(() => app.workflow.act({ ...base, action: 'write', eventId: 'w' }), /ready|follow|stale/);
  assert.equal(app.workflow.ingest(input()).assessment.decision, 'review');
  rules = [{ taskId: 't', documentVersion: 'v1', checksum: 'a'.repeat(64), rules: input().rules }];
  await app.refreshEvidence(); assert.equal(app.workflow.ingest(input()).assessment.decision, 'follow');
  now += 90001; assert.equal(app.workflow.revalidate(p.id).assessment.decision, 'review');
});

test('summary counts all pending watches without expanding the bounded work batch', async t => {
  const f = fixture(t); for (let i = 0; i < 35; i++) f.store.watch('pending-' + i, { companyId: 'c' });
  const r = f.runner({ config: { mode: 'disabled', companyId: 'c', summaryHour: 0 } }); await r.tick();
  const summary = f.store.listOutbox(Date.now()).find(row => !row.project_id);
  assert.ok(JSON.stringify(JSON.parse(summary.payload)).includes('35'));
  assert.equal(f.store.listWatches(Date.now()).length, 20);
});

test('initial asynchronous snapshot loading does not cancel persisted queued work', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bid-cold-cache-'));
  let release;
  const app = createApplication({ ...loadConfig({ BID_DATA_ROOT: root, BID_COMPANY_ID: 'c' }), port: 0 }, { readEvidence: () => new Promise(r => { release = r; }) });
  const p = { id: 'p', taskId: 't', companyId: 'c', version: 'v1', checksum: 'a'.repeat(64), generatedAt: input().handoff.snapshot.generatedAt, input: input(), assessment: good, created: Date.now(), revision: 1 };
  app.store.saveProject(p); app.store.decide('p', 'follow', 'actor', Date.now()); app.store.enqueueWriting(app.store.getProject('p'), Date.now());
  const starting = app.start();
  try {
    while (!release) await new Promise(r => setImmediate(r));
    const response = await fetch('http://127.0.0.1:' + app.server.address().port + '/health'); assert.equal(response.status, 200);
    assert.equal(app.store.listWriting()[0].status, 'queued');
  } finally {
    app.store.updateWriting(app.store.listWriting()[0].id, 'cancelled', null, Date.now());
    release({ snapshot: { records: [], warnings: [] }, rules: [] }); await starting;
    await app.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});

test('callbacks on a service that lost ownership cannot mutate project decisions', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bid-fenced-callback-'));
  const config = { ...loadConfig({ BID_DATA_ROOT: root, BID_COMPANY_ID: 'c', BID_CHAT_ID: 'chat', BID_OPERATOR_IDS: 'actor' }), port: 0 };
  const app = createApplication(config, { readEvidence: async () => ({ snapshot: { records: [], warnings: [] }, rules: [] }) });
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await app.start(); await app.refreshEvidence(); const p = app.workflow.ingest(input()); app.store.bindMessage(p.id, 'm');
  app.store.db.prepare("UPDATE leases SET owner='new-process' WHERE name='runner'").run();
  assert.throws(() => app.workflow.act({ projectId: p.id, version: 'v1', action: 'follow', chatId: 'chat', actorId: 'actor', messageId: 'm', eventId: 'late-action' }), /lease|owner/);
  assert.equal(app.store.getProject(p.id).humanDecision, null);
});

test('authorized card pagination keeps the decision and rejects out-of-range pages', t => {
  const f = fixture(t); const changed = input();
  changed.handoff.requirements = Array.from({ length: 9 }, (_, i) => ({ id: 'q' + i, category: 'basic', key: 'Requirement ' + i }));
  f.workflow.ingest(changed); f.workflow.act({ ...f.base, action: 'follow', eventId: 'follow-again' });
  assert.throws(() => f.workflow.act({ ...f.base, action: 'page', page: 1, actorId: 'outsider', eventId: 'page-bad-actor' }), /not_allowed/);
  assert.equal(f.workflow.act({ ...f.base, action: 'page', page: 2, eventId: 'page-2' }).status, 'view_updated');
  assert.equal(f.store.get('cardPage:' + f.p.id), 2);
  assert.equal(f.store.getProject(f.p.id).humanDecision, 'follow');
  assert.throws(() => f.workflow.act({ ...f.base, action: 'page', page: 3, eventId: 'page-3' }), /page/);
});

test('content failure continuation only authorizes retry_failed for the delivered challenge', t => {
  const f = fixture(t); f.enqueue(); const job = f.store.listWriting()[0];
  f.store.updateWriting(job.id, 'waiting_confirmation', { confirmation: { type: 'content_decision', challenge: 'failed-section' } }, Date.now(), 'content');
  f.store.set('confirmationPublished:failed-section', {contentHash:'published'});
  f.workflow.act({ ...f.base, action: 'continue', challenge: 'failed-section', eventId: 'retry-section' });
  const updated = f.store.listWriting()[0];
  assert.equal(updated.stage, 'content');
  assert.deepEqual(updated.payload.confirmations.contentDecision, { challenge: 'failed-section', action: 'retry_failed' });
});

test('real worker loads a read-only SQLite snapshot while the main event loop remains available', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bid-real-snapshot-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const databasePath = path.join(root, 'vault.db');
  const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(databasePath);
  const columns = ['id', 'kind', 'name', 'client', 'category', 'amount', 'event_date', 'cert_name', 'specialty', 'level', 'cert_number', 'issued_on', 'expires_on', 'permanent', 'tags', 'notes', 'updated_at'];
  db.exec('CREATE TABLE records (' + columns.map(k => k + ' TEXT').join(',') + '); CREATE TABLE attachments(id TEXT,record_id TEXT,name TEXT,relative_path TEXT,sha256 TEXT,position INTEGER)'); db.close();
  const before = createHash('sha256').update(fs.readFileSync(databasePath)).digest('hex');
  let mainResponded = false; setImmediate(() => { mainResponded = true; });
  const value = await readEvidenceInWorker({ databasePath, filesRoot: root, companyId: 'c' });
  assert.equal(mainResponded, true); assert.deepEqual(value.snapshot.records, []); assert.deepEqual(value.rules, []);
  assert.equal(createHash('sha256').update(fs.readFileSync(databasePath)).digest('hex'), before);
});

test('real snapshot worker leaves unmapped attachment bytes uninspected', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bid-mapped-snapshot-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const databasePath = path.join(root, 'vault.db');
  const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(databasePath);
  const columns = ['id', 'kind', 'name', 'client', 'category', 'amount', 'event_date', 'cert_name', 'specialty', 'level', 'cert_number', 'issued_on', 'expires_on', 'permanent', 'tags', 'notes', 'updated_at'];
  db.exec('CREATE TABLE records (' + columns.map(k => k + ' TEXT').join(',') + '); CREATE TABLE attachments(id TEXT,record_id TEXT,name TEXT,relative_path TEXT,sha256 TEXT,position INTEGER)');
  db.prepare('INSERT INTO records (' + columns.join(',') + ') VALUES (' + columns.map(() => '?').join(',') + ')').run('unmapped', 'certificate', 'Unmapped', '', '', '', '', '', '', '', '', '', '', '', '', '', '2026-09-10T00:00:00Z');
  db.prepare('INSERT INTO attachments VALUES (?, ?, ?, ?, ?, ?)').run('missing-att', 'unmapped', 'missing.pdf', 'missing.pdf', 'a'.repeat(64), 0);
  db.close();

  const value = await readEvidenceInWorker({ databasePath, filesRoot: root, companyId: 'c' });
  const attachment = value.snapshot.records[0].attachments[0];
  assert.equal(attachment.actualSha256, null);
  assert.ok(attachment.verificationIssues.includes('attachment_not_inspected'));
  assert.ok(!attachment.verificationIssues.includes('attachment_missing'));
});

test('reconfirming a project after evidence revocation can explicitly regenerate its cancelled delivery', async t => {
  const f = fixture(t); f.enqueue(); const job = f.store.listWriting()[0];
  f.store.updateWriting(job.id, 'completed', { status: 'completed', artifacts: [] }, Date.now());
  f.revoke(); f.workflow.revalidate(f.p.id);
  assert.equal(f.store.listWriting()[0].status, 'cancelled');
  f.restore(); f.workflow.revalidate(f.p.id);
  f.workflow.act({ ...f.base, action: 'follow', eventId: 'follow-new-evidence' });
  f.workflow.act({ ...f.base, action: 'write', eventId: 'regenerate' });
  assert.equal(f.store.listWriting()[0].status, 'queued');
  assert.notEqual(f.store.listWriting()[0].payload.deliveryEpoch, job.payload.deliveryEpoch);
});

test('a corrected report for the same source cancels old draft delivery before a new confirmed run', async t => {
  const f = fixture(t); f.enqueue(); const job = f.store.listWriting()[0];
  const file = path.join(f.root, 'old-draft.md'); fs.writeFileSync(file, 'Old draft');
  const result = { status: 'completed', artifacts: [{ path: file, sha256: createHash('sha256').update('Old draft').digest('hex') }] };
  f.store.updateWriting(job.id, 'completed', result, Date.now()); enqueueArtifacts(f.store, f.p.id, result, f.root);
  const corrected = input(); corrected.handoff.snapshot.reportVersion = 'r2'; corrected.handoff.requirements[0].value = 'Corrected requirement';
  const current = f.workflow.ingest(corrected); assert.equal(current.id, f.p.id);
  assert.equal(f.store.listWriting()[0].status, 'cancelled'); assert.equal(f.store.listFiles(Date.now()).length, 0);
  f.workflow.act({ ...f.base, action: 'follow', eventId: 'follow-correction' });
  await deliverFiles({ store: f.store, root: f.root, mode: 'test', chatId: 'chat', allowedChats: ['chat'], client: { uploadFile: async () => assert.fail('obsolete artifact uploaded'), sendFile: async () => assert.fail('obsolete artifact sent') } });
  f.workflow.act({ ...f.base, action: 'write', eventId: 'write-correction' });
  const replacement = f.store.listWriting()[0]; assert.equal(replacement.status, 'queued'); assert.equal(replacement.stage, 'prepare');
  assert.equal(replacement.payload.handoff.snapshot.reportVersion, 'r2'); assert.notEqual(replacement.payload.deliveryEpoch, job.payload.deliveryEpoch);
});

test('the old visible card cannot approve a corrected report with the same file version', t => {
  const f = fixture(t); const oldCard = { ...f.base };
  const corrected = input(); corrected.handoff.snapshot.reportVersion = 'corrected-report'; f.workflow.ingest(corrected);
  assert.throws(() => f.workflow.act({ ...oldCard, action: 'follow', eventId: 'old-visible-card' }), /stale/);
  assert.equal(f.store.getProject(f.p.id).humanDecision, null);
});

test('a correction during upload cannot send the old file after the new report is followed', async t => {
  const f = fixture(t); f.enqueue(); const file = path.join(f.root, 'pending.md'); fs.writeFileSync(file, 'Old content');
  const job = f.store.listWriting()[0], result = { status: 'completed', artifacts: [{ path: file, sha256: createHash('sha256').update('Old content').digest('hex') }] };
  f.store.updateWriting(job.id, 'completed', result, Date.now()); enqueueArtifacts(f.store, f.p.id, result, f.root);
  let sent = 0;
  const client = { uploadFile: async () => {
    const changed = input(); changed.handoff.snapshot.reportVersion = 'r2'; f.workflow.ingest(changed);
    f.workflow.act({ ...f.base, action: 'follow', eventId: 'follow-during-upload' });
    f.workflow.act({ ...f.base, action: 'write', eventId: 'new-run-during-upload' });
    return 'uploaded-old-file';
  }, sendFile: async () => { sent++; return 'old-message'; } };
  await deliverFiles({ store: f.store, root: f.root, mode: 'test', chatId: 'chat', allowedChats: ['chat'], client });
  assert.equal(sent, 0); assert.equal(f.store.db.prepare('SELECT delivered FROM file_outbox').get().delivered, -1);
});
