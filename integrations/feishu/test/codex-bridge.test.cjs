'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../store.cjs');
const { createCodexBridge } = require('../codex-bridge.cjs');

const apiKey = 'bridge-test-key-'.repeat(3);
const payload = (text = 'Hello', extra = {}) => ({ model: 'gpt-6-astra', messages: [{ role: 'user', content: text }], ...extra });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const until = async predicate => { for (let i = 0; i < 100 && !predicate(); i++) await new Promise(r => setTimeout(r, 5)); assert.ok(predicate()); };
async function fixture(t, options = {}) {
  const store = options.store ?? createStore(':memory:');
  let calls = 0;
  const executor = { authStatus: () => true, run: async args => { calls++; return options.run ? options.run(args) : 'answer'; }, ...options.executor };
  const config = { codexBridge: { enabled: true, host: '127.0.0.1', port: 0, apiKey, model: 'gpt-6-astra', timeoutMs: 1000, maxRequestBytes: 1024 * 1024, ...options.config } };
  const bridge = createCodexBridge({ config, store, executor, assertOwnership: options.assertOwnership, clock: options.clock });
  await bridge.start();
  t.after(async () => { await bridge.close(); if (!options.store) store.close(); });
  const url = 'http://127.0.0.1:' + bridge.server.address().port;
  const post = (body, options = {}) => fetch(url + '/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' }, body: JSON.stringify(body), ...options });
  return { bridge, store, url, post, calls: () => calls };
}

test('auth protects models and ready; readiness does not execute a model', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.url + '/health')).status, 200);
  for (const route of ['/ready', '/v1/models']) assert.equal((await fetch(f.url + route)).status, 401);
  assert.equal((await f.post(payload(), { headers: { authorization: 'Bearer wrong' } })).status, 401);
  const headers = { authorization: 'Bearer ' + apiKey };
  const ready = await fetch(f.url + '/ready', { headers });
  assert.equal(ready.status, 200); assert.equal((await ready.json()).authReady, true);
  const models = await (await fetch(f.url + '/v1/models', { headers })).json();
  assert.deepEqual(models.data.map(x => x.id), ['gpt-6-astra']); assert.equal(f.calls(), 0);
});

test('strict schema rejects tools, images, unknown model and malformed requests before execution', async t => {
  const f = await fixture(t);
  for (const body of [payload('x', { model: 'other' }), payload('x', { tools: [] }), payload('x', { messages: [{ role: 'tool', content: 'x' }] }), payload('x', { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }] }), payload('x', { messages: [] }), payload('x', { max_tokens: 0 }), payload('x', { response_format: { type: 'json_schema' } }), payload('x', { stream: 'yes' }), payload('x', { temperature: -1 })]) {
    assert.equal((await f.post(body)).status, 400);
  }
  assert.equal(f.calls(), 0);
  const valid = await f.post(payload('x', { messages: ['system', 'developer', 'user', 'assistant'].map(role => ({ role, content: 'text' })) }));
  assert.equal(valid.status, 200);
});

test('selectable models reach the executor, remain separate in cache and identify SSE responses', async t => {
  const selected = [];
  const f = await fixture(t, {
    config: { models: ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6-astra'], recommendedModel: 'gpt-5.6-terra' },
    run: async ({ model }) => { selected.push(model); return `answer from ${model}`; },
  });
  const models = await (await fetch(f.url + '/v1/models', { headers: { authorization: 'Bearer ' + apiKey } })).json();
  assert.deepEqual(models.data.map(m => m.id), ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6-astra']);
  assert.deepEqual(models.data.filter(m => m.recommended).map(m => m.id), ['gpt-5.6-terra']);
  for (const model of ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6-astra']) {
    const response = await f.post(payload('same input', { model }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.model, model);
    assert.equal(body.choices[0].message.content, `answer from ${model}`);
  }
  const stream = await f.post(payload('same input', { model: 'gpt-5.6-terra', stream: true }));
  const chunks = (await stream.text()).split('\n\n').filter(s => s.startsWith('data: {')).map(s => JSON.parse(s.slice(6)));
  assert.ok(chunks.length);
  assert.ok(chunks.every(chunk => chunk.model === 'gpt-5.6-terra'));
  assert.deepEqual(selected, ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6-astra']);
  assert.equal((await f.post(payload('same input', { model: 'not-enabled' }))).status, 400);
  assert.equal(f.calls(), 3);
});

test('JSON and SSE share one cached completion and one request id', async t => {
  const f = await fixture(t);
  const normal = await (await f.post(payload())).json();
  assert.equal(normal.choices[0].message.content, 'answer');
  const stream = await f.post(payload('Hello', { stream: true }));
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  const frames = (await stream.text()).split('\n\n').filter(x => x.startsWith('data: ')).map(x => x.slice(6));
  assert.equal(frames.at(-1), '[DONE]');
  const chunks = frames.slice(0, -1).map(JSON.parse);
  assert.equal(chunks[0].id, normal.id);
  assert.equal(chunks[0].choices[0].delta.content, 'answer');
  assert.equal(chunks[1].choices[0].finish_reason, 'stop');
  assert.equal(f.calls(), 1);
});

test('json_object rejects nonobjects and keeps failure durable without another execution', async t => {
  const f = await fixture(t, { run: async () => '[1,2]' });
  const body = payload('json', { response_format: { type: 'json_object' } });
  assert.equal((await f.post(body)).status, 502);
  const again = await f.post(body); assert.equal(again.status, 409);
  assert.equal((await again.json()).error.code, 'execution_failed'); assert.equal(f.calls(), 1);
});

test('same in-flight payload reuses one promise and distinct requests run serially with four waiting slots', async t => {
  const gate = deferred(); let running = 0, maxRunning = 0;
  const f = await fixture(t, { run: async ({ messages }) => { running++; maxRunning = Math.max(maxRunning, running); if (messages[0].content === 'first') await gate.promise; running--; return messages[0].content; } });
  const first = f.post(payload('first')); await until(() => f.calls() === 1);
  const duplicate = f.post(payload('first', { stream: false }));
  const waiting = ['two', 'three', 'four', 'five'].map(x => f.post(payload(x)));
  await until(() => f.bridge.status().queued === 4);
  const overflow = await f.post(payload('six')); assert.equal(overflow.status, 429);
  gate.resolve();
  for (const response of await Promise.all([first, duplicate, ...waiting])) assert.equal(response.status, 200);
  assert.equal(f.calls(), 5); assert.equal(maxRunning, 1);
});

test('persistent running marker after restart blocks uncertain repeat; completed cache expires after 24 hours', async t => {
  let now = 1000;
  const store = createStore(':memory:');
  const f = await fixture(t, { store, clock: () => now });
  await (await f.post(payload())).text();
  const row = f.store.db.prepare("SELECT key,value FROM settings WHERE key LIKE 'codex-bridge-request:%'").get();
  const record = JSON.parse(row.value);
  f.store.set(row.key, { ...record, state: 'running' });
  await f.bridge.close();
  const restarted = await fixture(t, { store, clock: () => now });
  t.after(() => store.close());
  const uncertain = await restarted.post(payload()); assert.equal(uncertain.status, 409);
  assert.equal((await uncertain.json()).error.code, 'execution_uncertain'); assert.equal(restarted.calls(), 0);
  f.store.set(row.key, record); now += 24 * 60 * 60 * 1000 + 1;
  assert.equal((await restarted.post(payload())).status, 200); assert.equal(restarted.calls(), 1);
});

test('timeout and server close abort execution; timeout never automatically repeats', async t => {
  let aborted = 0;
  const f = await fixture(t, { config: { timeoutMs: 35 }, run: ({ signal }) => new Promise((resolve, reject) => { signal.addEventListener('abort', () => { aborted++; reject(Error('private detail')); }, { once: true }); }) });
  const timed = await f.post(payload('timeout')); assert.equal(timed.status, 504);
  assert.equal((await f.post(payload('timeout'))).status, 409); assert.equal(aborted, 1);
  const pending = f.post(payload('close')).catch(() => null); await until(() => f.calls() === 2);
  await f.bridge.close(); await pending; assert.equal(aborted, 2);
});

test('last disconnected client cancels executor but one duplicate disconnect does not cancel another', async t => {
  const gate = deferred(); let aborted = 0;
  const f = await fixture(t, { run: ({ signal, messages }) => new Promise((resolve, reject) => { if (messages[0].content === 'shared') gate.promise.then(() => resolve('ok')); signal.addEventListener('abort', () => { aborted++; reject(Error('aborted')); }, { once: true }); }) });
  const controller = new AbortController();
  const one = f.post(payload('shared'), { signal: controller.signal }).catch(() => null); await until(() => f.calls() === 1);
  const two = f.post(payload('shared')); await until(() => f.bridge.status().clients === 2);
  controller.abort(); await one; await until(() => f.bridge.status().clients === 1); assert.equal(aborted, 0);
  gate.resolve(); assert.equal((await two).status, 200);
  const other = new AbortController(); const three = f.post(payload('cancel'), { signal: other.signal }).catch(() => null);
  await until(() => f.calls() === 2); other.abort(); await three; await until(() => aborted === 1);
  assert.equal((await f.post(payload('cancel'))).status, 409);
});

test('executor exceptions never expose error properties supplied by another module', async t => {
  const f = await fixture(t, { run: async () => { throw Object.assign(Error('private diagnostic'), { status: 418, code: 'private_token_detail' }); } });
  const response = await f.post(payload());
  assert.equal(response.status, 502);
  const text = await response.text(); assert.ok(!text.includes('private_')); assert.ok(text.includes('execution_failed'));
});

test('persists an allowlisted executor diagnostic while keeping the HTTP error generic', async t => {
  const f = await fixture(t, { run: async () => { throw Object.assign(Error('private diagnostic'), { code: 'codex_json_object_invalid' }); } });
  const response = await f.post(payload('diagnostic'));
  assert.equal(response.status, 502);
  const text = await response.text(); assert.ok(!text.includes('codex_json_object_invalid')); assert.ok(text.includes('execution_failed'));
  const record = JSON.parse(f.store.db.prepare("SELECT value FROM settings WHERE key LIKE 'codex-bridge-request:%'").get().value);
  assert.equal(record.errorCode, 'codex_json_object_invalid');
});

test('body size and unavailable local auth fail before execution', async t => {
  const f = await fixture(t, { config: { maxRequestBytes: 128 } });
  assert.equal((await f.post(payload('x'.repeat(200)))).status, 413); assert.equal(f.calls(), 0);
  const unavailable = await fixture(t, { executor: { authStatus: () => false } });
  assert.equal(unavailable.bridge.status().ready, false);
  const ready = await fetch(unavailable.url + '/ready', { headers: { authorization: 'Bearer ' + apiKey } });
  assert.equal(ready.status, 503); assert.equal((await ready.json()).authReady, false);
  assert.equal((await unavailable.post(payload())).status, 503); assert.equal(unavailable.calls(), 0);
});

test('closing the bridge closes incomplete HTTP requests promptly', async t => {
  const net = require('node:net');
  const f = await fixture(t);
  const socket = net.connect(f.bridge.server.address().port, '127.0.0.1');
  t.after(() => socket.destroy());
  await new Promise(resolve => socket.once('connect', resolve));
  socket.write('POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ' + apiKey + '\r\nContent-Length: 100\r\n\r\n{');
  const started = Date.now();
  await Promise.race([f.bridge.close(), new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('close_stalled')), 500); timer.unref(); })]);
  assert.ok(Date.now() - started < 500);
});

test('async login probes are cached and singleflight; status never spawns a probe', async t => {
  let now = 1000, probes = 0;
  const gate = deferred();
  const f = await fixture(t, { clock: () => now, executor: { authStatus: async () => { probes++; if (probes > 1) await gate.promise; return true; } } });
  assert.equal(probes, 1); assert.equal(f.bridge.status().ready, true);
  for (let i = 0; i < 20; i++) f.bridge.status();
  assert.equal(probes, 1); now += 60001;
  assert.equal(f.bridge.status().ready, false); assert.equal(probes, 1);
  const requests = [f.post(payload('one')), f.post(payload('two'))];
  await until(() => probes === 2); gate.resolve();
  for (const response of await Promise.all(requests)) assert.equal(response.status, 200);
  assert.equal(probes, 2); assert.equal(f.bridge.status().ready, true);
  await f.bridge.close(); assert.equal(f.bridge.status().ready, false); assert.equal(probes, 2);
});

test('close waits for an auth refresh already in flight', async t => {
  let now = 1000, probes = 0;
  const gate = deferred();
  const f = await fixture(t, { clock: () => now, executor: { authStatus: async () => { probes++; return probes === 1 ? true : gate.promise; } } });
  now += 60001;
  const request = f.post(payload('auth-close')).catch(() => null);
  await until(() => probes === 2);
  let closed = false;
  const closing = f.bridge.close().then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(closed, false);
  gate.resolve(false);
  await closing;
  await request;
  assert.equal(closed, true);
});

test('oversized executor output is rejected and is not saved as a successful completion', async t => {
  const f = await fixture(t, { run: async () => 'x'.repeat(2 * 1024 * 1024 + 1) });
  const response = await f.post(payload()); assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'invalid_model_response');
  const records = f.store.db.prepare("SELECT value FROM settings WHERE key LIKE 'codex-bridge-request:%'").all().map(x => JSON.parse(x.value));
  assert.equal(records[0].state, 'failed'); assert.equal(records[0].content, undefined);
});

test('damaged completed cache is rejected without returning content or executing again, even after expiry', async t => {
  let now = 1000;
  const f = await fixture(t, { clock: () => now, run: async () => '{"ok":true}' });
  const body = payload('cached JSON', { response_format: { type: 'json_object' } });
  assert.equal((await f.post(body)).status, 200);
  const row = f.store.db.prepare("SELECT key,value FROM settings WHERE key LIKE 'codex-bridge-request:%'").get();
  const record = JSON.parse(row.value);
  for (const content of ['', '  ', 'x'.repeat(2 * 1024 * 1024 + 1), '[]', 'null', '"text"', '{broken']) {
    f.store.set(row.key, { ...record, content });
    const response = await f.post({ ...body, stream: true });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'cache_invalid');
  }
  now += 24 * 60 * 60 * 1000 + 1;
  assert.equal((await f.post(body)).status, 409);
  assert.equal(f.calls(), 1);
});

test('EasyBid ordinary text request builder and its actual SSE reader interoperate with the bridge', async t => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../../../client/electron/services/aiService.cjs'), 'utf8');
  const builder = source.slice(source.indexOf('function createChatRequestBody('), source.indexOf('// 保留 Pi 工具调用协议字段'));
  const streamReader = source.slice(source.indexOf('function appendStreamChoiceContent('), source.indexOf('async function requestTextAiNormal('));
  const client = vm.runInNewContext(builder + '\n' + streamReader + '\n({createChatRequestBody,readOpenAIChatStream})', { JINLONG_DEPRECATED_MODEL_MAP: {}, TextDecoder, markAiRequestError: error => error });
  const f = await fixture(t);
  const config = { model_name: 'gpt-6-astra', temperature_enabled: false, reasoning_effort: '' };
  const request = { messages: [{ role: 'system', content: 'Write prose.' }, { role: 'user', content: 'Write a paragraph.' }] };
  const normal = await f.post(client.createChatRequestBody(config, request));
  assert.equal(normal.status, 200); assert.equal((await normal.json()).choices[0].message.content, 'answer');
  const streamed = await f.post(client.createChatRequestBody(config, request, { stream: true }));
  assert.equal(streamed.status, 200);
  const parsed = await client.readOpenAIChatStream(streamed);
  assert.equal(parsed.content, 'answer'); assert.equal(f.calls(), 1);
});

test('lease ownership gates start and suppresses successful output after execution', async t => {
  let owned = true; const gate = deferred();
  const f = await fixture(t, { assertOwnership: () => { if (!owned) throw Error('private lease detail'); }, run: async () => { await gate.promise; return 'secret result'; } });
  const pending = f.post(payload()); await until(() => f.calls() === 1); owned = false; gate.resolve();
  const response = await pending; assert.equal(response.status, 503); assert.ok(!(await response.text()).includes('secret result'));
  const other = createCodexBridge({ config: { codexBridge: { enabled: true, host: '127.0.0.1', port: 0, apiKey, model: 'gpt-6-astra' } }, executor: { run: async () => '', authStatus: () => true }, store: f.store, assertOwnership: () => { throw Error('lease'); } });
  await assert.rejects(other.start()); await other.close();
});
