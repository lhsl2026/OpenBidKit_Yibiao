const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  listSelectableTextModels,
  discoverSelectableTextModels,
  resolveTextModelConfig,
} = require('./textModelSelection.cjs');

test('dropdown discovers bridge choices and selects the recommendation without changing global config', async t => {
  const { createServer } = require('node:http');
  const server = createServer((req, res) => {
    if (req.url !== '/v1/models' || req.headers.authorization !== 'Bearer local-bridge-token') { res.writeHead(401); res.end(); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [
      { id: 'gpt-6-astra' }, { id: 'gpt-5.6-luna' }, { id: 'gpt-5.6-terra', recommended: true }, { id: 'gpt-5.6-terra' },
    ] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const config = configFixture();
  config.text_model_profiles.custom.base_url = `http://127.0.0.1:${server.address().port}/v1`;
  const models = await discoverSelectableTextModels(config);
  assert.equal(models[0].modelName, 'gpt-5.6-terra');
  assert.deepEqual(models.filter(m => m.recommended).map(m => m.modelName), ['gpt-5.6-terra']);
  assert.deepEqual(models.filter(m => m.source === 'codex').map(m => m.modelName).sort(), ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-6-astra']);
  assert.ok(models.some(m => m.modelName === 'deepseek-v4-flash'));
  const resolved = resolveTextModelConfig(config, models[0]);
  assert.equal(resolved.model_name, 'gpt-5.6-terra');
  assert.equal(resolved.base_url, config.text_model_profiles.custom.base_url);
  assert.equal(config.model_name, 'deepseek-v4-flash');
  assert.equal(config.text_model_profiles.custom.model_name, 'gpt-6-astra');
});

test('unavailable bridge falls back to configured choices without hiding other providers', async () => {
  const config = configFixture();
  config.text_model_profiles.custom.base_url = 'http://127.0.0.1:1/v1';
  const models = await discoverSelectableTextModels(config);
  assert.deepEqual(models.map(m => m.modelName), ['gpt-6-astra', 'deepseek-v4-flash']);
});

function configFixture() {
  return {
    text_model_provider: 'deepseek',
    api_key: 'deepseek-key',
    base_url: 'https://api.deepseek.com',
    model_name: 'deepseek-v4-flash',
    reasoning_effort: '',
    context_length_limit: 400000,
    concurrency_limit: 10,
    temperature_enabled: false,
    temperature: 0.7,
    request_mode: 'stream',
    text_model_profiles: {
      deepseek: {
        api_key: 'deepseek-key',
        base_url: 'https://api.deepseek.com',
        model_name: 'deepseek-v4-flash',
        reasoning_effort: '',
        context_length_limit: 400000,
        concurrency_limit: 10,
        temperature_enabled: false,
        temperature: 0.7,
        request_mode: 'stream',
      },
      custom: {
        api_key: 'local-bridge-token',
        base_url: 'http://127.0.0.1:4383/v1',
        model_name: 'gpt-6-astra',
        reasoning_effort: '',
        context_length_limit: 400000,
        concurrency_limit: 1,
        temperature_enabled: false,
        temperature: 0.7,
        request_mode: 'stream',
      },
      volcengine: {
        api_key: '',
        base_url: 'https://ark.cn-beijing.volces.com/api/v3',
        model_name: '',
      },
    },
  };
}

test('lists configured task models with local Codex first', () => {
  const models = listSelectableTextModels(configFixture());

  assert.deepEqual(models.map(({ id, label, source }) => ({ id, label, source })), [
    { id: 'custom:gpt-6-astra', label: 'Codex · gpt-6-astra', source: 'codex' },
    { id: 'deepseek:deepseek-v4-flash', label: 'DeepSeek · deepseek-v4-flash', source: 'configured' },
  ]);
  assert.equal(models[0].recommended, true);
});

test('resolves a task model snapshot without changing the stored active model', () => {
  const config = configFixture();
  const resolved = resolveTextModelConfig(config, {
    provider: 'custom',
    modelName: 'gpt-6-astra',
  });

  assert.equal(resolved.base_url, 'http://127.0.0.1:4383/v1');
  assert.equal(resolved.model_name, 'gpt-6-astra');
  assert.equal(resolved.api_key, 'local-bridge-token');
  assert.equal(config.text_model_provider, 'deepseek');
  assert.equal(config.model_name, 'deepseek-v4-flash');
});

test('rejects a task model whose provider is no longer configured', () => {
  assert.throws(
    () => resolveTextModelConfig(configFixture(), { provider: 'volcengine', modelName: 'missing' }),
    /所选模型不可用/,
  );
});
