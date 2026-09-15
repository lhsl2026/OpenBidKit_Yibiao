const PROVIDER_LABELS = {
  jinlong: '金龙中转站',
  volcengine: '火山方舟',
  deepseek: 'DeepSeek',
  agnes: 'Agnes AI',
  custom: '自定义模型',
  longcat: 'LongCat',
};

function clean(value) {
  return String(value || '').trim();
}

function isLocalCodexProfile(profile) {
  try {
    const url = new URL(clean(profile?.base_url));
    return ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
      && clean(profile?.model_name).startsWith('gpt-');
  } catch {
    return false;
  }
}

function isConfigured(profile) {
  return Boolean(clean(profile?.api_key) && clean(profile?.base_url) && clean(profile?.model_name));
}

function listSelectableTextModels(config = {}, discovered = {}) {
  const profiles = config.text_model_profiles && typeof config.text_model_profiles === 'object'
    ? config.text_model_profiles
    : {};
  const models = Object.entries(profiles).flatMap(([provider, profile]) => {
    if (!isConfigured(profile)) return [];
    const source = isLocalCodexProfile(profile) ? 'codex' : 'configured';
    const available = discovered[provider] || [{ id: clean(profile.model_name), recommended: source === 'codex' }];
    return available.map(model => ({
      modelName: model.id,
      id: `${provider}:${model.id}`,
      provider,
      label: `${source === 'codex' ? 'Codex' : PROVIDER_LABELS[provider] || provider} · ${model.id}`,
      source,
      recommended: model.recommended === true,
    }));
  });
  return models.sort((left, right) => {
    if (left.recommended !== right.recommended) return left.recommended ? -1 : 1;
    if (left.source !== right.source) return left.source === 'codex' ? -1 : 1;
    if (left.provider !== right.provider) {
      if (left.provider === config.text_model_provider) return -1;
      if (right.provider === config.text_model_provider) return 1;
    }
    return left.label.localeCompare(right.label, 'zh-CN');
  });
}

async function discoverSelectableTextModels(config = {}) {
  const discovered = {};
  await Promise.all(Object.entries(config.text_model_profiles || {}).map(async ([provider, profile]) => {
    if (!isConfigured(profile) || !isLocalCodexProfile(profile)) return;
    try {
      const response = await fetch(`${clean(profile.base_url).replace(/\/+$/, '')}/models`, {
        headers: { Authorization: `Bearer ${profile.api_key}` },
        redirect: 'error', signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) return;
      const body = await response.json();
      if (!Array.isArray(body.data)) return;
      const models = [...new Map(body.data.filter(model => typeof model?.id === 'string' && model.id.startsWith('gpt-'))
        .map(model => [model.id, model])).values()];
      if (!models.length) return;
      const preferred = body.data.find(model => model?.recommended === true && models.some(item => item.id === model.id))?.id
        || models.find(model => model.id === profile.model_name)?.id || models[0].id;
      discovered[provider] = models.map(model => ({ id: model.id, recommended: model.id === preferred }));
    } catch {
      // A temporarily unavailable bridge must not hide other configured providers.
    }
  }));
  return listSelectableTextModels(config, discovered);
}

function resolveTextModelConfig(config = {}, selection) {
  if (!selection?.provider || !selection?.modelName) return { ...config };
  const profile = config.text_model_profiles?.[selection.provider];
  if (!isConfigured(profile)) throw new Error('所选模型不可用，请返回新建标书页面重新选择');
  return {
    ...config,
    ...profile,
    text_model_provider: selection.provider,
    model_name: clean(selection.modelName),
  };
}

module.exports = {
  listSelectableTextModels,
  discoverSelectableTextModels,
  resolveTextModelConfig,
};
