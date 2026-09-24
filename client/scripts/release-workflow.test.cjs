const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflowPath = path.resolve(__dirname, '../../.github/workflows/release.yml');
const workflow = fs.readFileSync(workflowPath, 'utf8');

function jobBlock(name, nextName) {
  const start = workflow.indexOf(`  ${name}:`);
  assert.notEqual(start, -1, `missing ${name} job`);
  const end = nextName ? workflow.indexOf(`  ${nextName}:`, start + name.length + 3) : workflow.length;
  assert.notEqual(end, -1, `missing ${nextName} job after ${name}`);
  return workflow.slice(start, end);
}

test('release validates signing before creating a draft and publishes only after all GitHub artifacts succeed', () => {
  const preflight = jobBlock('validate-release-config', 'create-release');
  assert.match(preflight, /YIBIAO_LICENSE_PRIVATE_KEY_JWK/);
  assert.match(preflight, /exit 1/);

  const createRelease = jobBlock('create-release', 'build-windows');
  assert.match(createRelease, /needs:\s*validate-release-config/);
  assert.match(createRelease, /--draft/);

  const publishRelease = jobBlock('publish-github-release', 'publish-atomgit-release');
  assert.match(publishRelease, /build-windows/);
  assert.match(publishRelease, /publish-macos/);
  assert.match(publishRelease, /--draft=false/);
});

test('non-GitHub release mirrors are opt-in', () => {
  const atomGit = jobBlock('publish-atomgit-release', 'publish-r2-release');
  assert.match(atomGit, /if:\s*\$\{\{\s*vars\.ENABLE_ATOMGIT_RELEASE\s*==\s*'true'\s*\}\}/);

  const r2AndGitee = jobBlock('publish-r2-release');
  assert.match(r2AndGitee, /if:\s*\$\{\{\s*vars\.ENABLE_R2_GITEE_RELEASE\s*==\s*'true'\s*\}\}/);
});
