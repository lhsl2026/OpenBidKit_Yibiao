const { test } = require('node:test');
const assert = require('node:assert/strict');

const { findYibiaoDeepLink, parseYibiaoDeepLink } = require('./deepLink.cjs');

test('recognizes the new bid entry deep link', () => {
  assert.deepEqual(parseYibiaoDeepLink('yibiao://new-bid'), {
    action: 'new-bid',
    url: 'yibiao://new-bid',
  });
});

test('ignores web URLs and unknown yibiao actions', () => {
  assert.equal(parseYibiaoDeepLink('https://yibiao.pro'), null);
  assert.equal(parseYibiaoDeepLink('yibiao://settings'), null);
});

test('finds a supported deep link in Electron command line arguments', () => {
  assert.deepEqual(findYibiaoDeepLink([
    'C:\\Program Files\\Yibiao\\Yibiao.exe',
    '--some-electron-flag',
    'yibiao://new-bid/',
  ]), {
    action: 'new-bid',
    url: 'yibiao://new-bid',
  });
  assert.equal(findYibiaoDeepLink(['electron.exe', 'https://yibiao.pro']), null);
});
