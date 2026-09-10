const { createHash } = require('node:crypto');
function writingModelConfig({ config, store, job }) {
  if (!config.codexBridge?.enabled) return config.modelConfig;
  const scope = createHash('sha256').update(JSON.stringify(['codex-writing-attempt', job.id, job.modelAttempt || 'initial'])).digest('hex');
  store.set('codex-attempt:' + scope, { jobId: job.id, attempt: job.modelAttempt || 'initial' });
  return { ...config.modelConfig, base_url: config.modelConfig.base_url + '/attempts/' + scope };
}
module.exports = { writingModelConfig };
