const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createAiService } = require('./aiService.cjs');

test('Luna stays Luna on the local bridge while Jinlong keeps its provider-specific compatibility rule', async t => {
  const { createServer } = require('node:http');
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-luna' }, { id: 'gpt-5.6-terra' }] })); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ receivedModel: body.model }) } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const profile = { api_key: 'synthetic-key', base_url: `http://127.0.0.1:${server.address().port}/v1`, model_name: 'gpt-6-astra', request_mode: 'normal' };
  const config = { text_model_provider: 'deepseek', text_model_profiles: { custom: profile, jinlong: profile } };
  const service = createAiService({ app: {}, configStore: { load: () => config } });
  const request = { messages: [{ role: 'user', content: 'synthetic input' }] };
  const custom = service.withTextModel({ provider: 'custom', modelName: 'gpt-5.6-luna' });
  const result = await custom.requestJson(request);
  assert.equal(result.receivedModel, 'gpt-5.6-luna');
  const legacy = await service.withTextModel({ provider: 'jinlong', modelName: 'gpt-5.6-luna' }).requestJson(request);
  assert.equal(legacy.receivedModel, 'gpt-5.6-terra');
  assert.deepEqual((await service.listModels({ ...profile, text_model_provider: 'custom' })).models, ['gpt-5.6-luna', 'gpt-5.6-terra']);
  assert.deepEqual((await service.listModels({ ...profile, text_model_provider: 'jinlong' })).models, ['gpt-5.6-terra']);
});

test('withTextModel exposes the selected task snapshot while global config stays unchanged', () => {
  const config = {
    text_model_provider: 'deepseek',
    api_key: 'deepseek-key',
    base_url: 'https://api.deepseek.com',
    model_name: 'deepseek-v4-flash',
    concurrency_limit: 2,
    image_model: { concurrency_limit: 1 },
    text_model_profiles: {
      deepseek: { api_key: 'deepseek-key', base_url: 'https://api.deepseek.com', model_name: 'deepseek-v4-flash' },
      custom: { api_key: 'codex-key', base_url: 'http://127.0.0.1:4383/v1', model_name: 'gpt-6-astra' },
    },
  };
  const service = createAiService({ app: {}, configStore: { load: () => config } });
  const selected = service.withTextModel({ provider: 'custom', modelName: 'gpt-6-astra' });

  assert.equal(selected.getConfig().text_model_provider, 'custom');
  assert.equal(selected.getConfig().model_name, 'gpt-6-astra');
  assert.equal(service.getConfig().text_model_provider, 'deepseek');
  assert.equal(service.getConfig().model_name, 'deepseek-v4-flash');
});

test('withRequestContext binds both the queue scope and task model', () => {
  const config = {
    text_model_provider: 'deepseek', api_key: 'd', base_url: 'https://api.deepseek.com', model_name: 'deepseek-v4-flash', concurrency_limit: 2,
    image_model: { concurrency_limit: 1 },
    text_model_profiles: { custom: { api_key: 'c', base_url: 'http://127.0.0.1:4383/v1', model_name: 'gpt-6-astra' } },
  };
  const service = createAiService({ app: {}, configStore: { load: () => config } });
  const scoped = service.withRequestContext({
    queueScopeId: 'bid-analysis:task-1',
    textModelSelection: { provider: 'custom', modelName: 'gpt-6-astra' },
  });

  assert.equal(scoped.getConfig().model_name, 'gpt-6-astra');
  assert.deepEqual(scoped.bindRequest({ messages: [] }), {
    messages: [],
    queueScopeId: 'bid-analysis:task-1',
    textModelSelection: { provider: 'custom', modelName: 'gpt-6-astra' },
  });
});

test('selected task model concurrency limits its real HTTP requests instead of using the global provider limit', async t => {
  const { createServer } = require('node:http');
  let active = 0;
  let maxActive = 0;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    JSON.parse(Buffer.concat(chunks).toString('utf8'));
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 40));
    active -= 1;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));

  const config = {
    text_model_provider: 'deepseek',
    api_key: 'deepseek-key',
    base_url: 'https://api.deepseek.com',
    model_name: 'deepseek-v4-flash',
    concurrency_limit: 10,
    image_model: { concurrency_limit: 1 },
    text_model_profiles: {
      custom: {
        api_key: 'codex-key',
        base_url: `http://127.0.0.1:${server.address().port}/v1`,
        model_name: 'gpt-6-astra',
        concurrency_limit: 1,
        request_mode: 'normal',
      },
    },
  };
  const service = createAiService({ app: {}, configStore: { load: () => config } });
  const selected = service.withRequestContext({
    queueScopeId: 'bid-analysis:task-1',
    textModelSelection: { provider: 'custom', modelName: 'gpt-5.6-terra' },
  });
  const request = { messages: [{ role: 'user', content: 'synthetic input' }] };

  await Promise.all([selected.chat(request), selected.chat(request), selected.chat(request)]);

  assert.equal(maxActive, 1);
});

test('a fenced local bridge failure retries with a distinct bounded attempt header', async t => {
  const { createServer } = require('node:http');
  const attempts = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    JSON.parse(Buffer.concat(chunks).toString('utf8'));
    attempts.push(req.headers['x-yibiao-request-attempt'] || '');
    res.setHeader('content-type', 'application/json');
    if (attempts.length === 1) {
      res.statusCode = 409;
      res.end(JSON.stringify({ error: { message: 'execution_failed', type: 'bridge_error', code: 'execution_failed' } }));
      return;
    }
    res.end(JSON.stringify({ choices: [{ message: { content: 'retried' } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));

  const config = {
    text_model_provider: 'custom',
    api_key: 'codex-key',
    base_url: `http://127.0.0.1:${server.address().port}/v1`,
    model_name: 'gpt-5.6-terra',
    concurrency_limit: 1,
    request_mode: 'normal',
    image_model: { concurrency_limit: 1 },
    text_model_profiles: {},
  };
  const service = createAiService({ app: {}, configStore: { load: () => config } });

  assert.equal(await service.chat({ messages: [{ role: 'user', content: 'retry me' }] }), 'retried');
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0], '');
  assert.match(attempts[1], /^[A-Za-z0-9._:-]{1,128}$/);
});

test('local Codex agent requests preserve Pi tools through the bridge-safe tool protocol', async t => {
  const { createServer } = require('node:http');
  const receivedBodies = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    receivedBodies.push(receivedBody);
    res.setHeader('content-type', 'application/json');
    if (Object.hasOwn(receivedBody, 'tools') || Object.hasOwn(receivedBody, 'tool_choice')) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: { message: 'invalid_request', type: 'bridge_error', code: 'invalid_request' } }));
      return;
    }
    const agentEnvelope = receivedBodies.length === 1
      ? {
          action: 'tool_calls',
          tool_calls: [{ name: 'write', arguments: { path: 'outline.json', content: '{"outline":[]}' } }],
        }
      : { action: 'final', content: 'outline.json 已写入并校验。' };
    res.end(JSON.stringify({
      id: 'chatcmpl-bridge-tool',
      object: 'chat.completion',
      model: 'gpt-5.6-terra',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: JSON.stringify(agentEnvelope),
        },
        finish_reason: 'stop',
      }],
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));

  const config = {
    text_model_provider: 'custom',
    api_key: 'codex-key',
    base_url: `http://127.0.0.1:${server.address().port}/v1`,
    model_name: 'gpt-5.6-terra',
    concurrency_limit: 1,
    request_mode: 'stream',
    image_model: { concurrency_limit: 1 },
    text_model_profiles: {},
  };
  const service = createAiService({ app: {}, configStore: { load: () => config } });
  const result = await service.runAgentChatCompletion({
    body: {
      model: 'default',
      stream: true,
      messages: [{ role: 'user', content: 'Create outline.json.' }],
      tools: [{
        type: 'function',
        function: {
          name: 'write',
          description: 'Write a workspace file.',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' }, content: { type: 'string' } },
            required: ['path', 'content'],
            additionalProperties: false,
          },
        },
      }],
      tool_choice: 'auto',
    },
    async consumeResponse(response) {
      return { responseData: await response.json() };
    },
  });

  const receivedBody = receivedBodies[0];
  assert.deepEqual(Object.keys(receivedBody).sort(), ['messages', 'model', 'response_format', 'stream']);
  assert.equal(receivedBody.stream, false);
  assert.deepEqual(receivedBody.response_format, { type: 'json_object' });
  assert.match(receivedBody.messages.map(message => message.content).join('\n'), /Write a workspace file/);
  const choice = result.responseData.choices[0];
  assert.equal(choice.finish_reason, 'tool_calls');
  assert.equal(choice.message.content, null);
  assert.equal(choice.message.tool_calls[0].function.name, 'write');
  assert.equal(choice.message.tool_calls[0].function.arguments, '{"path":"outline.json","content":"{\\"outline\\":[]}"}');

  const finalResult = await service.runAgentChatCompletion({
    body: {
      model: 'default',
      stream: true,
      messages: [
        { role: 'user', content: 'Create outline.json.' },
        { role: 'assistant', content: null, tool_calls: choice.message.tool_calls },
        { role: 'tool', tool_call_id: choice.message.tool_calls[0].id, content: 'outline.json written' },
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'write',
          description: 'Write a workspace file.',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' }, content: { type: 'string' } },
            required: ['path', 'content'],
            additionalProperties: false,
          },
        },
      }],
    },
    async consumeResponse(response) {
      return { responseData: await response.json() };
    },
  });
  assert.match(receivedBodies[1].messages[1].content, /"role":"tool"/);
  assert.equal(finalResult.responseData.choices[0].finish_reason, 'stop');
  assert.equal(finalResult.responseData.choices[0].message.content, 'outline.json 已写入并校验。');
});
