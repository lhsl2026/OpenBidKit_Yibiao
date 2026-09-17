const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../store.cjs');
const { createRunner } = require('../runner.cjs');

function setup() {
  const store = createStore(':memory:');
  const project = { id: 'p', taskId: 't', companyId: 'c', version: '1', checksum: 'a', generatedAt: 'now', current: true, created: 1, revision: 1, input: { deadline: '2099-01-01', handoff: { status: 'ready', superseded: false, warnings: [] } }, assessment: { decision: 'follow', items: [], blockers: [] } };
  store.saveProject(project); store.decide('p', 'follow', 'actor', 1); store.enqueueWriting(store.getProject('p'), 2);
  return store;
}

test('a pending writing model does not block later radar and group-file ticks', async t => {
  const store = setup(); t.after(() => store.close());
  let resolveWrite, writes = 0, polls = 0;
  const pending = new Promise(resolve => { resolveWrite = resolve; });
  const runner = createRunner({ store, config: { companyId: 'c', sourceChats: [], sourceSenders: [], mode: 'disabled', summaryHour: 18, radarPolling: { enabled: false } }, workflow: { ingest() {}, revalidate: id => store.getProject(id) }, groupFileSource: { poll: async () => { polls++; }, tick: async () => {} }, write: async () => { writes++; return pending; }, clock: Date.now });
  await runner.tick();
  assert.equal(writes, 1); assert.equal(runner.isWriting(), true);
  await runner.tick();
  assert.equal(polls, 2); assert.equal(writes, 1);
  resolveWrite({ status: 'waiting_confirmation', confirmation: { type: 'outline', challenge: 'one' } });
  while (runner.isWriting()) await new Promise(resolve => setImmediate(resolve));
  await runner.close();
});

test('a lost runner lease fences a late writing result from the database', async t => {
  const store = setup(); t.after(() => store.close());
  let resolveWrite;
  const runner = createRunner({ store, config: { companyId: 'c', sourceChats: [], sourceSenders: [], mode: 'disabled', summaryHour: 18, radarPolling: { enabled: false } }, workflow: { ingest() {}, revalidate: id => store.getProject(id) }, write: () => new Promise(resolve => { resolveWrite = resolve; }), clock: Date.now });
  await runner.tick();
  store.db.prepare("UPDATE leases SET owner='another-process'").run();
  resolveWrite({ status: 'completed', artifacts: [] });
  while (runner.isWriting()) await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.listWriting()[0].status, 'running');
  await runner.close();
});

test('runner close aborts and waits for the active writing lane before releasing ownership', async t => {
  const store = setup(); t.after(() => store.close());
  let observedSignal, finish;
  const runner = createRunner({ store, config: { companyId: 'c', sourceChats: [], sourceSenders: [], mode: 'disabled', summaryHour: 18, radarPolling: { enabled: false } }, workflow: { ingest() {}, revalidate: id => store.getProject(id) }, write: (_job, { signal }) => { observedSignal = signal; return new Promise(resolve => { finish = resolve; }); }, clock: Date.now });
  await runner.tick();
  let closed = false; const closing = runner.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(observedSignal.aborted, true); assert.equal(closed, false);
  finish({ status: 'completed', artifacts: [] }); await closing;
  assert.equal(runner.isWriting(), false);
});
