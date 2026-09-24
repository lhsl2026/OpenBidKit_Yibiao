const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { imageSize } = require('image-size');

const clientDir = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(clientDir, relativePath), 'utf8');

test('desktop brand surfaces consistently use 联智标', () => {
  const packageJson = JSON.parse(read('package.json'));
  const surfaces = [
    read('index.html'),
    read('electron/main.cjs'),
    read('electron/preload.cjs'),
    read('src/components/Sidebar.tsx'),
  ];

  assert.equal(packageJson.build.productName, '联智标');
  assert.equal(packageJson.description, '联智标桌面客户端');
  assert.match(surfaces[0], /<title>联智标<\/title>/);
  assert.match(surfaces[1], /title: '联智标'/);
  assert.match(surfaces[2], /appName: '联智标'/);
  assert.match(surfaces[3], /<span>联智标<\/span>/);
  assert.match(surfaces[3], /<strong>投标工具箱<\/strong>/);

  for (const surface of surfaces) {
    assert.doesNotMatch(surface, /易标投标工具箱/);
  }
});

test('desktop brand icon assets cover renderer and Windows packaging', () => {
  for (const [relativePath, expectedType] of [
    ['assets/icon_256.png', 'png'],
    ['assets/icon.ico', 'ico'],
  ]) {
    const absolutePath = path.join(clientDir, relativePath);
    assert.ok(fs.existsSync(absolutePath), `${relativePath} should exist`);
    const dimensions = imageSize(fs.readFileSync(absolutePath));
    assert.equal(dimensions.width, 256);
    assert.equal(dimensions.height, 256);
    assert.equal(dimensions.type, expectedType);
  }
});
