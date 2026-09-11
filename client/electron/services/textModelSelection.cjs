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

function listSelectableTextModels(config = {}) {
  const profiles = config.text_model_profiles && typeof config.text_model_profiles === 'object'
    ? config.text_model_profiles
    : {};
  const models = Object.entries(profiles).flatMap(([provider, profile]) => {
    if (!isConfigured(profile)) return [];
    const source = isLocalCodexProfile(profile) ? 'codex' : 'configured';
    const modelName = clean(profile.model_name);
    return [{
      id: `${provider}:${modelName}`,
      provider,
      modelName,
      label: `${source === 'codex' ? 'Codex' : PROVIDER_LABELS[provider] || provider} · ${modelName}`,
      source,
      recommended: source === 'codex',
    }];
  });
  return models.sort((left, right) => {
    if (left.recommended !== right.recommended) return left.recommended ? -1 : 1;
    if (left.provider === config.text_model_provider) return -1;
    if (right.provider === config.text_model_provider) return 1;
    return left.label.localeCompare(right.label, 'zh-CN');
  });
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
  resolveTextModelConfig,
};
