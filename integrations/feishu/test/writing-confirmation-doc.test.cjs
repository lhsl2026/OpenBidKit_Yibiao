const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../store.cjs');
const { createWritingConfirmationDoc, createConfirmationDocClient } = require('../writing-confirmation-doc.cjs');

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'writing-confirmation-'));
  const store = createStore(path.join(root, 'state.sqlite3'));
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const project = {
    id: 'project-v1', taskId: 'task-1', companyId: 'company', version: '1', checksum: 'a'.repeat(64),
    generatedAt: '2026-09-17T00:00:00Z', created: 1, revision: 1, current: true,
    input: { deadline: '2099-01-01', handoff: { status: 'ready', superseded: false, warnings: [], task: { taskId: 'task-1', title: '智慧教室改造项目' }, snapshot: { documentVersion: 1 } } },
    assessment: { decision: 'follow', items: [], blockers: [] },
  };
  store.saveProject(project); store.decide(project.id, 'follow', 'actor', 1); store.enqueueWriting(store.getProject(project.id), 2);
  const writing = store.listWriting()[0];
  const confirmation = { type: 'outline', challenge: 'outline-1', outlineData: { outline: [{ title: '项目理解' }, { title: '实施方案', children: [{ title: '进度计划' }] }] } };
  store.updateWriting(writing.id, 'waiting_confirmation', { status: 'waiting_confirmation', confirmation }, 3, 'outline');
  let now = 1000;
  const calls = { create: 0, update: 0, fetch: 0, grant: 0, verify: 0 };
  let content = '';
  const client = {
    create: async ({ sourcePath }) => { calls.create++; content = fs.readFileSync(sourcePath, 'utf8'); return { token: 'doc123', url: 'https://tenant.feishu.cn/docx/doc123' }; },
    update: async ({ sourcePath }) => { calls.update++; content = fs.readFileSync(sourcePath, 'utf8'); return { updated: true }; },
    fetch: async () => { calls.fetch++; return { content }; },
    grantGroup: async () => { calls.grant++; },
    hasGroup: async () => { calls.verify++; return true; },
    ...overrides,
  };
  const config = { mode: 'test', dataRoot: root, chatId: 'chat', allowedChats: ['chat'], reportArchive: { enabled: true, root, cliPath: process.execPath, profile: 'profile', identity: 'bot', folderToken: 'folder', allowedFolderTokens: ['folder'] } };
  const docs = createWritingConfirmationDoc({ store, config, client, clock: () => now });
  const tick = async (count = 1) => { for (let i = 0; i < count; i++) { now += 61000; await docs.tick(); } };
  return { store, project, writing, confirmation, client, calls, docs, tick, setNow: value => { now = value; }, getContent: () => content };
}

test('creates one readable online confirmation document and enables confirmation only after readback and group permission verification', async t => {
  const x = fixture(t);
  await x.tick(5);
  const current = x.store.getProject(x.project.id);
  assert.equal(x.calls.create, 1);
  assert.equal(x.calls.grant, 1);
  assert.ok(x.calls.fetch >= 1);
  assert.ok(x.calls.verify >= 1);
  assert.match(x.getContent(), /智慧教室改造项目－标书生成确认单/);
  assert.match(x.getContent(), /完整目录/);
  assert.match(x.getContent(), /确认文档校验：[a-f0-9]{64}/);
  assert.equal(current.input.writingConfirmationUrl, 'https://tenant.feishu.cn/docx/doc123');
  assert.equal(current.input.writingConfirmation.challenge, 'outline-1');
  assert.ok(x.store.get('confirmationPublished:outline-1'));
});

test('updates the same document token for a later confirmation instead of creating a second document', async t => {
  const x = fixture(t); await x.tick(5);
  const next = { type: 'global_facts', challenge: 'facts-2', groups: [{ title: '公司人员', content: '项目经理：待补' }] };
  x.store.updateWriting(x.writing.id, 'waiting_confirmation', { status: 'waiting_confirmation', confirmation: next }, 10, 'content');
  await x.tick(4);
  assert.equal(x.calls.create, 1);
  assert.equal(x.calls.update, 1);
  assert.match(x.getContent(), /待补事实确认/);
  assert.equal(x.store.getProject(x.project.id).input.writingConfirmation.token, 'doc123');
  assert.equal(x.store.getProject(x.project.id).input.writingConfirmation.challenge, 'facts-2');
});

test('unknown create outcome is held for reconciliation and is never recreated', async t => {
  const x = fixture(t, { create: async () => { x.calls.create++; throw Error('unknown'); } });
  await x.tick(6);
  assert.equal(x.calls.create, 1);
  assert.equal(x.docs.list()[0].stage, 'manual');
  assert.equal(x.docs.list()[0].error, 'confirmation_create_unknown');
  assert.equal(x.store.getProject(x.project.id).input.writingConfirmationUrl, undefined);
});

test('unknown update reads back the marker before retrying and does not write twice when the update took effect', async t => {
  const x = fixture(t); await x.tick(5);
  const originalUpdate = x.client.update;
  x.client.update = async args => { await originalUpdate(args); throw Error('unknown'); };
  const next = { type: 'content_decision', challenge: 'retry-2', failedSections: [{ title: '实施方案' }] };
  x.store.updateWriting(x.writing.id, 'waiting_confirmation', { status: 'waiting_confirmation', confirmation: next }, 10, 'content');
  await x.tick(4);
  assert.equal(x.calls.update, 1);
  assert.equal(x.store.getProject(x.project.id).input.writingConfirmation.challenge, 'retry-2');
  assert.ok(x.store.get('confirmationPublished:retry-2'));
});

test('CLI client uses fixed docs identity, relative content paths and explicit readback', async () => {
  const calls = [];
  const client = createConfirmationDocClient({ cliPath: process.execPath, profile: 'profile', identity: 'bot' }, { runImpl: async (exe, args, options) => {
    calls.push({ exe, args, options });
    const command = args[1];
    if (command === '+create') return { stdout: JSON.stringify({ ok: true, data: { document: { document_id: 'doc123', url: 'https://tenant.feishu.cn/docx/doc123' } } }) };
    if (command === '+fetch') return { stdout: JSON.stringify({ ok: true, data: { document: { content: '<p>确认文档校验：abc</p>' } } }) };
    return { stdout: JSON.stringify({ ok: true, data: { result: 'success', document: { revision_id: 2 } } }) };
  } });
  const sourcePath = path.resolve('confirmation.xml');
  assert.equal((await client.create({ sourcePath, folderToken: 'folder' })).token, 'doc123');
  await client.update({ token: 'doc123', sourcePath });
  assert.match((await client.fetch({ token: 'doc123' })).content, /确认文档校验/);
  assert.ok(calls.every(call => call.args.includes('--as') && call.args.includes('bot') && call.args.includes('--profile') && call.options.windowsHide));
  assert.ok(calls[0].args.includes('@./confirmation.xml'));
  assert.ok(calls.some(call => call.args.includes('overwrite')));
});
