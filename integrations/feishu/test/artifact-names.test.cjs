const { test } = require('node:test');
const assert = require('node:assert/strict');
const { draftArtifactFileName } = require('../artifact-names.cjs');

test('final Word draft uses a Chinese purpose name and normalized version', () => {
  assert.equal(draftArtifactFileName('智慧教室改造项目', 'v1'), '智慧教室改造项目－技术标初稿－v1.docx');
  assert.equal(draftArtifactFileName('测试:项目', 2), '测试_项目－技术标初稿－v2.docx');
});
