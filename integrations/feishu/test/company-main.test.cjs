'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../config.cjs');
const { createApplication } = require('../main.cjs');

const COMPANY = '隆创信息有限公司';
const configFor = root => ({ ...loadConfig({
  BID_DATA_ROOT: root, BID_COMPANY_PROFILE_SYNC_ENABLED: 'true', BID_COMPANY_ID: COMPANY,
  BID_VAULT_DATABASE: 'C:/vault/vault.sqlite3', BID_VAULT_FILES: 'C:/vault', BID_VAULT_MAPPINGS: 'C:/vault/mappings.json',
  PREREAD_BASE_URL: 'http://127.0.0.1:3000', PREREAD_RELAY_AUTHORIZATION: 'Bearer relay',
}), port: 0 });
const snapshot = { records: [{
  id: 'p1', kind: 'performance', name: '医院信息化项目', category: '信息化', tags: '', companyId: COMPANY,
  verified: true, attachments: [{ id: 'a1', relative_path: 'files/a1.pdf', verified: true }],
}], warnings: [] };

test('application imports the current evidence profile once and exposes readiness', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'company-main-')); let imports = 0;
  const preread = { importCompanyProfileSource: async body => { imports += 1; return { status: 'company_profile_source_imported', sourceType: body.sourceType, sourceVersion: body.sourceVersion, companyCount: body.collection.companies.length, sourceCompanyCount: body.collection.companies.length, defaultCompanyId: body.collection.defaultCompanyId }; } };
  const app = createApplication(configFor(root), { readEvidence: async () => ({ snapshot, rules: [] }), prereadFactory: () => preread });
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await app.start(); await app.refreshEvidence();
  assert.equal(imports, 1);
  assert.equal(app.companyEvidence.status().ready, true);
  assert.equal(app.readiness().missing.includes('company_profile'), false);
});

test('a rejected profile import conservatively degrades readiness', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'company-main-fail-'));
  const preread = { importCompanyProfileSource: async () => { throw Error('remote'); } };
  const app = createApplication(configFor(root), { readEvidence: async () => ({ snapshot, rules: [] }), prereadFactory: () => preread });
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await app.start();
  assert.equal(app.companyEvidence.status().ready, false);
  assert.equal(app.readiness().missing.includes('company_profile'), true);
});
