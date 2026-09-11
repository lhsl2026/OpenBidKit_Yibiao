const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createAiService } = require('./aiService.cjs');

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
