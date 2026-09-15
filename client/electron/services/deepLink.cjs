function parseYibiaoDeepLink(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'yibiao:' || url.hostname !== 'new-bid' || (url.pathname && url.pathname !== '/')
      || url.username || url.password || url.port || url.hash) return null;
    const parameters = [...url.searchParams.entries()];
    if (parameters.length > 1 || (parameters.length === 1 && parameters[0][0] !== 'type')) return null;
    const bidType = url.searchParams.get('type') || '';
    const sections = { technical: 'technical-plan', business: 'business-bid' };
    if (bidType && !sections[bidType]) return null;
    return {
      action: 'new-bid',
      section: bidType ? sections[bidType] : 'bid-generation',
      url: bidType ? `yibiao://new-bid?type=${bidType}` : 'yibiao://new-bid',
    };
  } catch {
    return null;
  }
}

function findYibiaoDeepLink(args) {
  for (const arg of Array.isArray(args) ? args : []) {
    const intent = parseYibiaoDeepLink(arg);
    if (intent) return intent;
  }
  return null;
}

module.exports = { findYibiaoDeepLink, parseYibiaoDeepLink };
