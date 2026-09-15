const { test } = require('node:test');
const assert = require('node:assert/strict');

const { findYibiaoDeepLink, parseYibiaoDeepLink } = require('./deepLink.cjs');

test('recognizes the new bid entry deep link', () => {
  assert.deepEqual(parseYibiaoDeepLink('yibiao://new-bid'), {
    action: 'new-bid',
    section: 'bid-generation',
    url: 'yibiao://new-bid',
  });
  assert.deepEqual(parseYibiaoDeepLink('yibiao://new-bid?type=technical'), {
    action: 'new-bid',
    section: 'technical-plan',
    url: 'yibiao://new-bid?type=technical',
  });
  assert.deepEqual(parseYibiaoDeepLink('yibiao://new-bid?type=business'), {
    action: 'new-bid',
    section: 'business-bid',
    url: 'yibiao://new-bid?type=business',
  });
});

test('ignores web URLs and unknown yibiao actions', () => {
  assert.equal(parseYibiaoDeepLink('https://yibiao.pro'), null);
  assert.equal(parseYibiaoDeepLink('yibiao://settings'), null);
  assert.equal(parseYibiaoDeepLink('yibiao://new-bid?type=unknown'), null);
  assert.equal(parseYibiaoDeepLink('yibiao://new-bid?type=business&extra=1'), null);
});

test('finds a supported deep link in Electron command line arguments', () => {
  assert.deepEqual(findYibiaoDeepLink([
    'C:\\Program Files\\Yibiao\\Yibiao.exe',
    '--some-electron-flag',
    'yibiao://new-bid/',
  ]), {
    action: 'new-bid',
    section: 'bid-generation',
    url: 'yibiao://new-bid',
  });
  assert.equal(findYibiaoDeepLink(['electron.exe', 'https://yibiao.pro']), null);
});
