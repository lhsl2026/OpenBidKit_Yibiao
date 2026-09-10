'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildCompanyEvidenceProfile, createCompanyEvidenceSync } = require('../company-evidence.cjs');

const COMPANY = '隆创信息有限公司';
const attachment = (verified = true) => ({
  id: 'file-1',
  relative_path: 'files/file-1.pdf',
  sha256: 'a'.repeat(64),
  verified,
});
const performance = (overrides = {}) => ({
  id: 'performance-1',
  kind: 'performance',
  name: '医院信息化建设项目',
  client: '某医院',
  category: '信息化',
  amount: '120.5',
  event_date: '2025-06-01',
  tags: '医院 信息化',
  updated_at: '2026-09-08T10:00:00',
  companyId: COMPANY,
  verified: true,
  verificationIssues: [],
  attachments: [attachment()],
  ...overrides,
});

test('a fully verified target-company performance becomes verified evidence', () => {
  const result = buildCompanyEvidenceProfile({ records: [performance()] }, { companyId: COMPANY });
  const company = result.collection.companies[0];
  assert.equal(result.collection.defaultCompanyId, COMPANY);
  assert.equal(company.id, COMPANY);
  assert.equal(company.name, COMPANY);
  assert.equal(company.performances[0].verified, true);
  assert.equal(company.performances[0].evidencePath, 'files/file-1.pdf');
  assert.equal(result.coverage.performances.verified, 1);
});

test('an unmapped performance remains in the target profile as unverified', () => {
  const row = performance({ companyId: null, verified: false, verificationIssues: ['mapping_missing'] });
  const result = buildCompanyEvidenceProfile({ records: [row] }, { companyId: COMPANY });
  assert.equal(result.collection.companies[0].performances.length, 1);
  assert.equal(result.collection.companies[0].performances[0].verified, false);
  assert.equal(result.coverage.performances.review, 1);
});

test('records mapped to a different legal entity never enter the target profile', () => {
  const result = buildCompanyEvidenceProfile({ records: [
    performance({ companyId: '江苏隆创信息技术有限公司' }),
  ] }, { companyId: COMPANY });
  assert.deepEqual(result.collection.companies[0].performances, []);
  assert.equal(result.coverage.excludedCompanyMismatch, 1);
});

test('personnel certificates stay unverified without employment evidence', () => {
  const certificate = {
    id: 'certificate-1', kind: 'certificate', name: '张三', cert_name: '一级建造师',
    specialty: '机电工程', level: '一级', cert_number: 'CERT-001', expires_on: '2028-01-01',
    tags: '项目经理', updated_at: '2026-09-08T11:00:00', companyId: null,
    verified: false, verificationIssues: ['mapping_missing'], attachments: [attachment(false)],
  };
  const result = buildCompanyEvidenceProfile({ records: [certificate] }, { companyId: COMPANY });
  const person = result.collection.companies[0].personnel[0];
  assert.equal(person.name, '张三');
  assert.deepEqual(person.certificates, ['一级建造师']);
  assert.equal(person.verified, false);
  assert.equal(result.coverage.personnel.employmentVerified, 0);
});

test('equivalent snapshots produce the same profileVersion regardless of input order', () => {
  const other = performance({ id: 'performance-2', name: '校园网络升级项目' });
  const left = buildCompanyEvidenceProfile({ records: [performance(), other] }, { companyId: COMPANY });
  const right = buildCompanyEvidenceProfile({ records: [other, performance()] }, { companyId: COMPANY });
  assert.match(left.collection.companies[0].profileVersion, /^[a-f0-9]{64}$/);
  assert.equal(left.collection.companies[0].profileVersion, right.collection.companies[0].profileVersion);
});

test('profile synchronization is idempotent and failed imports make it unready', async () => {
  let calls = 0;
  const state = new Map();
  const store = { get: key => state.get(key), set: (key, value) => state.set(key, value) };
  const client = { replaceCompanyProfiles: async () => { calls += 1; return { status: 'company_profiles_imported', companyCount: 1, defaultCompanyId: COMPANY }; } };
  const sync = createCompanyEvidenceSync({ store, client, companyId: COMPANY });
  const built = buildCompanyEvidenceProfile({ records: [performance()] }, { companyId: COMPANY });
  await sync.replace(built);
  await sync.replace(built);
  assert.equal(calls, 1);
  assert.deepEqual(sync.status(), { ready: true, profileVersion: built.collection.companies[0].profileVersion, coverage: built.coverage });

  const failed = createCompanyEvidenceSync({ store: { get: () => undefined, set: () => {} }, client: { replaceCompanyProfiles: async () => { throw Error('remote detail'); } }, companyId: COMPANY });
  await assert.rejects(() => failed.replace(built), /company_profile_sync_failed/);
  assert.deepEqual(failed.status(), { ready: false, error: 'company_profile_sync_failed' });
});
