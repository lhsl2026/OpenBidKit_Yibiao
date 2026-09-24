'use strict';

const { createServer } = require('node:http');
const { createHash, timingSafeEqual } = require('node:crypto');

const CACHE_MS = 24 * 60 * 60 * 1000;
const AUTH_CACHE_MS = 60000;
const AUTH_CLOSE_WAIT_MS = 10000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const INTERNAL_ERROR = Symbol('bridge_error');
const SAFE_EXECUTOR_DIAGNOSTICS = new Set([
  'codex_aborted', 'codex_cleanup_failed', 'codex_cli_failed', 'codex_event_invalid',
  'codex_forbidden_item', 'codex_input_too_large', 'codex_json_object_invalid',
  'codex_output_invalid', 'codex_output_too_large', 'codex_request_invalid',
  'codex_spawn_failed', 'codex_stderr_too_large', 'codex_stdin_failed',
  'codex_stdout_failed', 'codex_stdout_too_large', 'codex_timeout', 'codex_workspace_failed',
]);
const PREFIX = 'codex-bridge-request:';
const hash = value => createHash('sha256').update(value).digest('hex');
const failure = (status, code) => Object.assign(new Error(code), { status, code, [INTERNAL_ERROR]: true });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, allowed) => Object.keys(value).every(key => allowed.includes(key));

function normalizeRetryAttempt(value) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw failure(400, 'invalid_request_attempt');
  }
  return value;
}

function contentIssue(content, responseFormat) {
  if (typeof content !== 'string' || !content.trim() || Buffer.byteLength(content, 'utf8') > MAX_RESPONSE_BYTES) return 'invalid_model_response';
  if (responseFormat?.type === 'json_object') {
    let parsed; try { parsed = JSON.parse(content); } catch { return 'invalid_model_json'; }
    if (!object(parsed)) return 'invalid_model_json';
  }
  return null;
}

function normalize(body, models) {
  if (!object(body) || !exactKeys(body, ['model', 'messages', 'response_format', 'max_tokens', 'temperature', 'stream'])
    || !models.includes(body.model) || !Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 256
    || (body.stream !== undefined && typeof body.stream !== 'boolean')) throw failure(400, 'invalid_request');
  const messages = body.messages.map(message => {
    if (!object(message) || !exactKeys(message, ['role', 'content'])
      || !['system', 'developer', 'user', 'assistant'].includes(message.role)
      || typeof message.content !== 'string' || !message.content.trim()) throw failure(400, 'invalid_messages');
    return { role: message.role, content: message.content };
  });
  let responseFormat = null;
  if (body.response_format !== undefined) {
    if (!object(body.response_format) || !exactKeys(body.response_format, ['type'])
      || !['text', 'json_object'].includes(body.response_format.type)) throw failure(400, 'invalid_response_format');
    if (body.response_format.type === 'json_object') responseFormat = { type: 'json_object' };
  }
  const maxTokens = body.max_tokens ?? 8192, temperature = body.temperature ?? 1;
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 32768
    || typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw failure(400, 'invalid_parameters');
  return { model: body.model, messages, responseFormat, maxTokens, temperature };
}

function createCodexBridge({ config, executor, store, assertOwnership = () => {}, clock = Date.now }) {
  const options = { host: '127.0.0.1', port: 4383, timeoutMs: 300000, maxRequestBytes: 1024 * 1024, ...config.codexBridge };
  options.requestTimeoutMs ??= options.timeoutMs;
  const models = [...new Set([...(options.models || []), options.model])];
  const recommendedModel = options.recommendedModel || options.model;
  if (options.enabled && (options.host !== '127.0.0.1' || typeof options.apiKey !== 'string' || options.apiKey.length < 32
    || typeof options.model !== 'string' || !options.model.trim() || !Number.isInteger(options.port) || options.port < 0 || options.port > 65535
    || !Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0 || !Number.isInteger(options.requestTimeoutMs) || options.requestTimeoutMs < options.timeoutMs
    || !Number.isInteger(options.maxRequestBytes) || options.maxRequestBytes <= 0)) throw failure(500, 'bridge_config_invalid');
  if (options.enabled && (!models.includes(recommendedModel) || models.some(model => typeof model !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(model)))) throw failure(500, 'bridge_config_invalid');
  const expectedAuth = hash('Bearer ' + options.apiKey);
  const jobs = new Map(), queue = [], executions = new Set();
  let active = null, started = false, closed = false, closing = null, leaseTimer = null, authTimer = null;
  let authValue = false, authCheckedAt = null, authRefresh = null;

  function owned() {
    try { assertOwnership(); } catch { throw failure(503, 'ownership_lost'); }
  }
  function authReady() {
    return authValue && authCheckedAt !== null && clock() - authCheckedAt < AUTH_CACHE_MS;
  }
  async function refreshAuth(force = false) {
    if (closed) return false;
    if (!force && authCheckedAt !== null && clock() - authCheckedAt < AUTH_CACHE_MS) return authValue;
    if (authRefresh) return authRefresh;
    authRefresh = (async () => {
      let ready = false;
      try { owned(); ready = (await executor.authStatus()) === true; owned(); } catch { ready = false; }
      if (!closed) { authValue = ready; authCheckedAt = clock(); }
      return !closed && ready;
    })();
    try { return await authRefresh; } finally { authRefresh = null; }
  }
  function status() {
    let leaseValid = true;
    try { owned(); } catch { leaseValid = false; }
    return { enabled: options.enabled === true, started, ready: options.enabled === true && started && !closed && leaseValid && authReady(), active: active ? 1 : 0, queued: queue.length, clients: [...jobs.values()].reduce((n, job) => n + job.clients, 0) };
  }
  function authorized(request) {
    const authorization = request.headers.authorization;
    return typeof authorization === 'string' && timingSafeEqual(Buffer.from(hash(authorization), 'hex'), Buffer.from(expectedAuth, 'hex'));
  }
  function json(response, statusCode, body) {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify(body));
  }
  function respondError(response, error) {
    const internal = error?.[INTERNAL_ERROR] === true;
    const code = internal ? error.code : 'bridge_failed';
    json(response, internal ? error.status : 500, { error: { message: code, type: 'bridge_error', code } });
  }
  async function readBody(request) {
    if (Number(request.headers['content-length']) > options.maxRequestBytes) throw failure(413, 'request_too_large');
    const chunks = []; let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > options.maxRequestBytes) throw failure(413, 'request_too_large');
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure(400, 'invalid_json'); }
  }
  function persist(job, record) {
    owned(); store.set(PREFIX + job.hash, { schema: 1, requestHash: job.hash, ...record });
  }
  function finish(job, error, content) {
    if (job.settled) return;
    job.settled = true; clearTimeout(job.timer);
    const index = queue.indexOf(job); if (index >= 0) queue.splice(index, 1);
    jobs.delete(job.hash);
    try {
      if (error) persist(job, { state: 'failed', errorCode: error.diagnosticCode ?? error.code ?? 'execution_failed', updatedAt: clock() });
      else persist(job, { state: 'completed', content, createdAt: job.createdAt, completedAt: clock(), expiresAt: clock() + CACHE_MS });
    } catch { error = failure(503, 'ownership_or_storage_lost'); }
    if (error) job.reject(error);
    else job.resolve({ content, id: 'chatcmpl-' + job.hash, created: Math.floor(job.createdAt / 1000) });
  }
  function cancel(job, reason) {
    if (job.settled) return;
    job.controller.abort(reason); finish(job, reason);
  }
  function pump() {
    if (active || closed) return;
    const job = queue.shift(); if (!job) return;
    if (job.settled) { pump(); return; }
    active = job;
    job.timer = setTimeout(() => cancel(job, failure(504, 'execution_timeout')), options.requestTimeoutMs);
    const execution = (async () => {
      try {
        owned();
        if (!(await refreshAuth())) throw failure(503, 'codex_auth_unavailable');
        owned();
        if (job.controller.signal.aborted) throw failure(499, 'request_cancelled');
        const content = await executor.run({ model: job.payload.model, messages: job.payload.messages, responseFormat: job.payload.responseFormat, maxTokens: job.payload.maxTokens, signal: job.controller.signal });
        owned();
        const issue = contentIssue(content, job.payload.responseFormat);
        if (issue) throw failure(502, issue);
        finish(job, null, content);
      } catch (error) {
        if (error?.[INTERNAL_ERROR]) finish(job, error);
        else {
          const wrapped = failure(502, 'execution_failed');
          wrapped.diagnosticCode = SAFE_EXECUTOR_DIAGNOSTICS.has(error?.code) ? error.code : 'execution_failed';
          finish(job, wrapped);
        }
      }
      finally { active = null; queueMicrotask(pump); }
    })();
    executions.add(execution); execution.finally(() => executions.delete(execution));
  }
  function getJob(payload, cacheOnly = false) {
    owned();
    const requestHash = hash(JSON.stringify(payload));
    const existing = jobs.get(requestHash);
    if (existing) {
      if (cacheOnly) throw failure(409, 'execution_pending');
      return existing;
    }
    const saved = store.get(PREFIX + requestHash);
    if (saved) {
      if (saved.state === 'running') throw failure(409, 'execution_uncertain');
      if (saved.state === 'failed') throw failure(409, 'execution_failed');
      if (saved.state !== 'completed' || typeof saved.content !== 'string') throw failure(409, 'execution_uncertain');
      if (contentIssue(saved.content, payload.responseFormat)) throw failure(409, 'cache_invalid');
      if (saved.expiresAt > clock()) return { clients: 0, settled: true, promise: Promise.resolve({ content: saved.content, id: 'chatcmpl-' + requestHash, created: Math.floor(saved.createdAt / 1000) }) };
    }
    if (cacheOnly) throw failure(409, 'cache_miss');
    if ((active ? 1 : 0) + queue.length >= 5) throw failure(429, 'queue_full');
    let resolve, reject;
    const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
    // A disconnected last client can abort before the HTTP handler awaits the promise.
    promise.catch(() => {});
    const job = { hash: requestHash, payload, promise, resolve, reject, controller: new AbortController(), createdAt: clock(), clients: 0, settled: false };
    persist(job, { state: 'running', createdAt: job.createdAt, updatedAt: clock() });
    jobs.set(requestHash, job); queue.push(job);
    queueMicrotask(pump);
    return job;
  }
  function completion(response, result, stream, model) {
    owned();
    if (closed) throw failure(503, 'bridge_closed');
    const base = { id: result.id, created: result.created, model };
    if (!stream) { json(response, 200, { ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: result.content }, finish_reason: 'stop' }] }); return; }
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
    // This is one final content event after execution, not simulated token streaming.
    response.write('data: ' + JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: result.content }, finish_reason: null }] }) + '\n\n');
    response.write('data: ' + JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
    response.end('data: [DONE]\n\n');
  }
  const server = createServer(async (request, response) => {
    let job, released = false;
    const release = () => {
      if (!job || released) return; released = true; job.clients--;
      if (!job.settled && job.clients === 0) cancel(job, failure(499, 'request_cancelled'));
    };
    response.once('close', release);
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (request.method === 'GET' && pathname === '/health') { json(response, 200, { status: 'ok' }); return; }
      if (!authorized(request)) throw failure(401, 'unauthorized');
      owned(); if (closed || !started) throw failure(503, 'bridge_closed');
      if (request.method === 'GET' && pathname === '/ready') {
        const ready = status().ready; json(response, ready ? 200 : 503, { status: ready ? 'ready' : 'not_ready', authReady: authReady() }); return;
      }
      if (request.method === 'GET' && pathname === '/v1/models') { json(response, 200, { object: 'list', data: models.map(id => ({ id, object: 'model', owned_by: 'local-codex', recommended: id === recommendedModel })) }); return; }
      const scoped = pathname.match(/^\/v1\/attempts\/([a-f0-9]{64})\/chat\/completions$/);
      const cacheOnly = pathname === '/v1/cache-only/chat/completions';
      if (request.method !== 'POST' || (pathname !== '/v1/chat/completions' && !scoped && !cacheOnly)) throw failure(404, 'not_found');
      if (scoped && !store.get('codex-attempt:' + scoped[1])) throw failure(403, 'attempt_not_authorized');
      if (!(await refreshAuth())) throw failure(503, 'codex_auth_unavailable');
      const body = await readBody(request);
      owned(); if (closed) throw failure(503, 'bridge_closed');
      if (response.destroyed || request.aborted) return;
      const payload = normalize(body, models);
      const retryAttempt = normalizeRetryAttempt(request.headers['x-yibiao-request-attempt']);
      const requestPayload = scoped
        ? { ...payload, attemptScope: scoped[1] }
        : retryAttempt
          ? { ...payload, retryAttempt }
          : payload;
      job = getJob(requestPayload, cacheOnly); job.clients++;
      const result = await job.promise;
      completion(response, result, body.stream === true, payload.model);
    } catch (error) { respondError(response, error); }
    finally { release(); }
  });
  server.requestTimeout = Math.max(options.requestTimeoutMs, 30000);

  async function start() {
    if (!options.enabled || started) return;
    if (closed) throw failure(503, 'bridge_closed');
    owned();
    await refreshAuth();
    owned(); if (closed) throw failure(503, 'bridge_closed');
    await new Promise((resolve, reject) => {
      const onError = error => { server.off('listening', onListen); reject(error); };
      const onListen = () => { server.off('error', onError); resolve(); };
      server.once('error', onError); server.once('listening', onListen); server.listen(options.port, options.host);
    });
    started = true;
    leaseTimer = setInterval(() => {
      try { owned(); } catch { for (const job of jobs.values()) cancel(job, failure(503, 'ownership_lost')); }
    }, 1000); leaseTimer.unref();
    authTimer = setInterval(() => { void refreshAuth(true); }, AUTH_CACHE_MS - 15000); authTimer.unref();
  }
  function close() {
    if (closing) return closing;
    closed = true; clearInterval(leaseTimer); clearInterval(authTimer);
    for (const job of jobs.values()) cancel(job, failure(503, 'bridge_closed'));
    closing = (async () => {
      const stopped = new Promise(resolve => { if (!server.listening) resolve(); else { server.close(resolve); server.closeAllConnections(); } });
      const pendingAuth = authRefresh;
      if (pendingAuth) {
        let authWaitTimer;
        try {
          await Promise.race([
            pendingAuth.catch(() => false),
            new Promise(resolve => { authWaitTimer = setTimeout(resolve, AUTH_CLOSE_WAIT_MS); }),
          ]);
        } finally { clearTimeout(authWaitTimer); }
      }
      await Promise.allSettled([...executions]);
      await stopped; started = false;
    })();
    return closing;
  }
  return { server, start, close, status };
}

module.exports = { createCodexBridge };
