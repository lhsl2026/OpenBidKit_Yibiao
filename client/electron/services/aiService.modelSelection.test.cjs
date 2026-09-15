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
