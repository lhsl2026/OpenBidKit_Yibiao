const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const deployment = path.resolve(__dirname, '../deployment');

test('scheduled task installers keep retrying after repeated supervisor failures', () => {
  for (const name of ['Install-FeishuTask.ps1', 'Install-FeishuUnattendedTask.ps1']) {
    const script = fs.readFileSync(path.join(deployment, name), 'utf8');
    assert.match(script, /-RestartCount 999\b/);
  }
  const installer = fs.readFileSync(path.join(deployment, 'Install-FeishuTask.ps1'), 'utf8');
  assert.match(installer, /RestartCount -eq 999\b/);
});
