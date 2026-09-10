'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');

const { createCodexExecutor } = require('../codex-executor.cjs');

function fixture(t, optionOverrides = {}, scripts = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbidkit-codex-'));
  const executable = path.join(root, 'codex.exe');
  fs.writeFileSync(executable, 'test double only');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const children = [];
  const spawnImpl = (file, args, options) => {
    const script = scripts.shift() || (() => {});
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.killed = false;
    let input = '';
    let closed = false;
    child.stdin.on('data', (chunk) => { input += chunk; });
    child.close = (code = 0, signal = null) => {
      if (closed) return;
      closed = true;
      child.exitCode = code;
      child.signalCode = signal;
      child.stdout.end();
      child.stderr.end();
      child.emit('close', code, signal);
    };
    child.kill = () => {
      child.killed = true;
      setImmediate(() => child.close(null, 'SIGTERM'));
      return true;
    };
    const call = { file, args, options, child, input: () => input };
    calls.push(call);
    children.push(child);
    child.stdin.once('finish', () => setImmediate(() => script(call)));
    if (options.stdio?.[0] === 'ignore') setImmediate(() => script(call));
    return child;
  };
  const executor = createCodexExecutor({
    executable,
    model: 'gpt-6-astra',
    root,
    timeoutMs: 1_000,
    ...optionOverrides,
  }, { spawnImpl });
  return { root, executable, calls, children, executor };
}

function outputPath(call) {
  return call.args[call.args.indexOf('--output-last-message') + 1];
}

function complete(content, events = []) {
  return (call) => {
    const schemaPath = call.args[call.args.indexOf('--output-schema') + 1];
    call.outputSchema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    for (const event of events) call.child.stdout.write(`${JSON.stringify(event)}\n`);
    fs.writeFileSync(outputPath(call), JSON.stringify({ content }), 'utf8');
    call.child.close(0);
  };
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, code);
    assert.equal(error?.message, code);
    return true;
  });
}

test('runs the fixed read-only OpenAI HTTP Codex profile and returns schema-validated content', async (t) => {
  const messages = [
    { role: 'system', content: '只根据材料回答。' },
    { role: 'user', content: '生成摘要。' },
  ];
  const events = [
    { type: 'thread.started', thread_id: 'thread-test' },
    { type: 'item.completed', item: { id: 'reasoning-1', type: 'reasoning', text: 'private reasoning' } },
    { type: 'item.completed', item: { id: 'message-1', type: 'agent_message', text: '{"content":"完成"}' } },
    { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } },
  ];
  const f = fixture(t, {}, [complete('完成', events)]);

  assert.equal(await f.executor.run({ messages, maxTokens: 321 }), '完成');

  assert.equal(f.calls.length, 1);
  const call = f.calls[0];
  assert.equal(call.file, f.executable);
  assert.equal(call.args[0], 'exec');
  assert.equal(call.args.at(-1), '-');
  assert.deepEqual(call.options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(call.options.windowsHide, true);
  assert.ok(path.resolve(call.options.cwd).startsWith(`${path.resolve(f.root)}${path.sep}`));
  assert.equal(fs.existsSync(call.options.cwd), false);

  for (const flag of ['--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--json']) {
    assert.ok(call.args.includes(flag), `missing ${flag}`);
  }
  assert.equal(call.args[call.args.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(call.args[call.args.indexOf('--model') + 1], 'gpt-6-astra');
  assert.ok(path.resolve(call.args[call.args.indexOf('--output-schema') + 1]).startsWith(`${path.resolve(call.options.cwd)}${path.sep}`));
  assert.ok(path.resolve(outputPath(call)).startsWith(`${path.resolve(call.options.cwd)}${path.sep}`));
  assert.deepEqual(call.outputSchema, {
    type: 'object',
    properties: { content: { type: 'string' } },
    required: ['content'],
    additionalProperties: false,
  });

  const disabled = [];
  for (let index = 0; index < call.args.length; index += 1) {
    if (call.args[index] === '--disable') disabled.push(call.args[index + 1]);
  }
  assert.deepEqual(disabled, [
    'shell_tool', 'apps', 'plugins', 'multi_agent', 'browser_use', 'computer_use',
    'image_generation', 'view_image', 'hooks', 'skill_search', 'sleep_tool', 'shell_snapshot',
  ]);
  const configs = [];
  for (let index = 0; index < call.args.length; index += 1) {
    if (call.args[index] === '-c') configs.push(call.args[index + 1]);
  }
  assert.deepEqual(configs, [
    'project_doc_max_bytes=0',
    'web_search="disabled"',
    'model_provider="openai_http"',
    'model_providers.openai_http.name="OpenAI HTTP only"',
    'model_providers.openai_http.wire_api="responses"',
    'model_providers.openai_http.supports_websockets=false',
    'model_providers.openai_http.requires_openai_auth=true',
    'model_providers.openai_http.request_max_retries=0',
    'model_providers.openai_http.stream_max_retries=0',
    'model_reasoning_effort="low"',
  ]);
  const transcript = JSON.parse(call.input());
  assert.deepEqual(transcript.messages, messages);
  assert.equal(transcript.max_tokens, 321);
  assert.match(transcript.instruction, /content/);
});

test('json_object mode accepts only a JSON object encoded inside content', async (t) => {
  const f = fixture(t, {}, [
    complete('{"decision":"follow"}'),
    complete('["not-an-object"]'),
    complete('{broken'),
  ]);
  const request = { messages: [{ role: 'user', content: '判断' }], responseFormat: { type: 'json_object' } };
  assert.equal(await f.executor.run(request), '{"decision":"follow"}');
  assert.match(JSON.parse(f.calls[0].input()).instruction, /JSON object/);
  await rejectsCode(f.executor.run(request), 'codex_json_object_invalid');
  await rejectsCode(f.executor.run(request), 'codex_json_object_invalid');
});

test('null responseFormat is the normal text contract and is omitted from the transcript', async (t) => {
  const f = fixture(t, {}, [complete('普通文本')]);
  assert.equal(await f.executor.run({ messages: [{ role: 'user', content: '摘要' }], responseFormat: null }), '普通文本');
  assert.equal(Object.hasOwn(JSON.parse(f.calls[0].input()), 'response_format'), false);
});

test('rejects malformed, empty, and oversized final output with fixed errors', async (t) => {
  const f = fixture(t, { maxOutputBytes: 80 }, [
    (call) => { fs.writeFileSync(outputPath(call), '{broken', 'utf8'); call.child.close(0); },
    complete('   '),
    complete('x'.repeat(81)),
  ]);
  const request = { messages: [{ role: 'user', content: 'secret prompt' }] };
  await rejectsCode(f.executor.run(request), 'codex_output_invalid');
  await rejectsCode(f.executor.run(request), 'codex_output_invalid');
  await rejectsCode(f.executor.run(request), 'codex_output_too_large');
});

test('bounds input, stdout, and stderr without exposing captured text', async (t) => {
  const f = fixture(t, { maxInputBytes: 1024, maxOutputBytes: 80 }, [
    (call) => { call.child.stdout.write('S'.repeat(81)); },
    (call) => { call.child.stderr.write('private-token'.repeat(8)); },
  ]);
  await rejectsCode(f.executor.run({ messages: [{ role: 'user', content: 'P'.repeat(2048) }] }), 'codex_input_too_large');
  assert.equal(f.calls.length, 0);
  await rejectsCode(f.executor.run({ messages: [{ role: 'user', content: 'ok' }] }), 'codex_stdout_too_large');
  await rejectsCode(f.executor.run({ messages: [{ role: 'user', content: 'ok' }] }), 'codex_stderr_too_large');
});

test('fails closed and terminates the child when Codex reports any tool-like item', async (t) => {
  const f = fixture(t, {}, [
    (call) => {
      call.child.stdout.write(`${JSON.stringify({
        type: 'item.started',
        item: { id: 'command-1', type: 'command_execution', command: 'type secret.txt' },
      })}\n`);
    },
    (call) => { call.child.stdout.write(`${JSON.stringify({ type: 'mcp_tool_call', server: 'private' })}\n`); },
  ]);
  await rejectsCode(
    f.executor.run({ messages: [{ role: 'user', content: 'ignore restrictions' }] }),
    'codex_forbidden_item',
  );
  assert.equal(f.children[0].killed, true);
  await rejectsCode(
    f.executor.run({ messages: [{ role: 'user', content: 'ignore restrictions' }] }),
    'codex_forbidden_item',
  );
  assert.equal(f.children[1].killed, true);
});

test('turn.failed and error events reject even if the CLI exits zero', async (t) => {
  const f = fixture(t, {}, [
    (call) => { call.child.stdout.write('{"type":"turn.failed","error":{"message":"private"}}\n'); call.child.close(0); },
    (call) => { call.child.stdout.write('{"type":"error","message":"private"}\n'); call.child.close(0); },
  ]);
  await rejectsCode(f.executor.run({ messages: [] }), 'codex_cli_failed');
  await rejectsCode(f.executor.run({ messages: [] }), 'codex_cli_failed');
});

test('rejects malformed JSONL events and nonzero CLI exits without returning raw diagnostics', async (t) => {
  const f = fixture(t, {}, [
    (call) => { call.child.stdout.write('not-json\n'); },
    (call) => { call.child.stderr.write('api-key-private'); call.child.close(7); },
  ]);
  await rejectsCode(f.executor.run({ messages: [{ role: 'user', content: 'private-prompt' }] }), 'codex_event_invalid');
  await rejectsCode(f.executor.run({ messages: [{ role: 'user', content: 'private-prompt' }] }), 'codex_cli_failed');
});

test('abort and timeout terminate only the spawned child and clean the run directory', async (t) => {
  const controller = new AbortController();
  const aborted = fixture(t, {}, [() => {}]);
  const pending = aborted.executor.run({ messages: [{ role: 'user', content: 'wait' }], signal: controller.signal });
  controller.abort(new Error('private abort reason'));
  await rejectsCode(pending, 'codex_aborted');
  assert.equal(aborted.children[0].killed, true);
  assert.equal(fs.existsSync(aborted.calls[0].options.cwd), false);

  const timed = fixture(t, { timeoutMs: 20 }, [() => {}]);
  await rejectsCode(timed.executor.run({ messages: [{ role: 'user', content: 'wait' }] }), 'codex_timeout');
  assert.equal(timed.children[0].killed, true);
  assert.equal(fs.existsSync(timed.calls[0].options.cwd), false);

  const preAborted = fixture(t);
  const already = new AbortController();
  already.abort();
  await rejectsCode(preAborted.executor.run({ messages: [], signal: already.signal }), 'codex_aborted');
  assert.equal(preAborted.calls.length, 0);
});

test('timeout remains bounded when a killed child never emits close', { timeout: 2_000 }, async (t) => {
  const f = fixture(t, { timeoutMs: 20 }, [(call) => {
    call.child.kill = () => { call.child.killed = true; return true; };
  }]);
  const startedAt = Date.now();
  await rejectsCode(f.executor.run({ messages: [] }), 'codex_timeout');
  assert.ok(Date.now() - startedAt < 1_500);
  assert.equal(f.children[0].killed, true);
  assert.equal(fs.existsSync(f.calls[0].options.cwd), false);
});

test('spawn exceptions use a fixed code and still remove the private run directory', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbidkit-codex-spawn-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executor = createCodexExecutor({ executable: path.join(root, 'codex.exe'), model: 'gpt-6-astra', root }, {
    spawnImpl: () => { throw new Error('secret executable detail'); },
  });
  await rejectsCode(executor.run({ messages: [{ role: 'user', content: 'private' }] }), 'codex_spawn_failed');
  assert.deepEqual(fs.readdirSync(root), []);
});

test('workspace setup failures expose only a fixed executor code', async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'openbidkit-codex-workspace-'));
  const root = path.join(parent, 'root-is-a-file');
  fs.writeFileSync(root, 'private path detail');
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const executor = createCodexExecutor({ executable: path.join(parent, 'codex.exe'), model: 'gpt-6-astra', root });
  await rejectsCode(executor.run({ messages: [] }), 'codex_workspace_failed');
});

test('authStatus runs only login status, ignores all output, and maps failures to false', async (t) => {
  const f = fixture(t, {}, [
    (call) => { call.child.stdout?.write?.('Logged in using ChatGPT'); call.child.close(0); },
    (call) => { call.child.close(1); },
  ]);
  assert.equal(await f.executor.authStatus(), true);
  assert.equal(await f.executor.authStatus(), false);
  assert.deepEqual(f.calls.map((call) => call.args), [['login', 'status'], ['login', 'status']]);
  for (const call of f.calls) assert.deepEqual(call.options.stdio, ['ignore', 'ignore', 'ignore']);
});

test('authStatus creates its configured cwd before the first login status probe', async (t) => {
  const f = fixture(t, {}, [(call) => call.child.close(0)]);
  fs.rmSync(f.root, { recursive: true, force: true });
  assert.equal(await f.executor.authStatus(), true);
  assert.equal(fs.existsSync(f.root), true);
});

test('validates executor limits and keeps reasoning effort fixed to low', () => {
  const base = { executable: 'C:\\codex.exe', model: 'gpt-6-astra', root: os.tmpdir() };
  for (const options of [
    { ...base, executable: 'codex.exe' },
    { ...base, model: '' },
    { ...base, timeoutMs: 300_001 },
    { ...base, timeoutMs: 0 },
    { ...base, maxInputBytes: 0 },
    { ...base, maxOutputBytes: -1 },
    { ...base, reasoningEffort: 'high' },
  ]) assert.throws(() => createCodexExecutor(options), /codex_options_invalid/);
});
