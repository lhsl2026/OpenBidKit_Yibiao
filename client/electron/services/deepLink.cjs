function parseYibiaoDeepLink(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'yibiao:' || url.hostname !== 'new-bid' || (url.pathname && url.pathname !== '/')) return null;
    return { action: 'new-bid', url: url.toString().replace(/\/$/, '') };
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
