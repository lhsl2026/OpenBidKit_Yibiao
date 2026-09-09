'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { ASSESSMENT_LABELS, assessTender } = require('../assessment.cjs');

const companyId = 'company-lc';
const deadline = '2026-10-01T09:00:00+08:00';
const now = '2026-09-09T12:00:00+08:00';

function handoff(overrides = {}) {
  return {
    schemaVersion: '1.0',
    task: { taskId: 'task-1', title: '脱敏测试项目' },
    snapshot: {
      reportId: 'report-1',
      reportVersion: 'report-v1',
      documentVersion: 'document-v1',
      completeness: 1,
      confidence: 1,
      checksum: `sha256:${'a'.repeat(64)}`,
      generatedAt: '2026-09-09T10:00:00+08:00',
    },
    status: 'ready',
    requirements: [],
    evidence: [],
    warnings: [],
    capabilities: {
      responseMatrix: { url: 'https://example.invalid/response-matrix', version: '1' },
      healthCheck: { url: 'https://example.invalid/health', version: '1' },
    },
    missingFields: [],
    affectedChapters: [],
    manualActions: [],
    superseded: false,
    latestDocumentVersion: 'document-v1',
    ...overrides,
  };
}

function requirement(overrides = {}) {
  return {
    id: 'req-cert',
    key: '人员证书',
    value: '至少 1 人持有注册证书',
    category: 'qualification',
    sourceType: 'tender_document',
    coordinate: 'synthetic.pdf#page=12',
    confidence: 1,
    requiresConfirmation: false,
    ...overrides,
  };
}

function verifiedCertificate(overrides = {}) {
  return {
    id: 'cert-1',
    kind: 'certificate',
    name: '测试人员甲',
    cert_name: '注册证书',
    specialty: '机电',
    level: '一级',
    issued_on: '2025-01-01',
    expires_on: '2027-12-31',
    permanent: 0,
    companyId,
    verified: true,
    verificationIssues: [],
    attachments: [{ id: 'att-1', verified: true }],
    ...overrides,
  };
}

function verifiedPerformance(overrides = {}) {
  return {
    id: 'perf-1',
    kind: 'performance',
    name: '测试项目',
    category: '信息化',
    amount: '1200.50',
    event_date: '2025-06-01',
    companyId,
    verified: true,
    verificationIssues: [],
    attachments: [{ id: 'att-p1', verified: true }],
    ...overrides,
  };
}

function assess({ tender = handoff(), rules = [], records = [], at = now, bidDeadline = deadline } = {}) {
  return assessTender({
    handoff: tender,
    rules,
    snapshot: { records, warnings: [] },
    companyId,
    deadline: bidDeadline,
    now: at,
  });
}

test('returns review when a matching record has no verified company ownership', () => {
  const req = requirement();
  const result = assess({
    tender: handoff({ requirements: [req] }),
    rules: [{ requirementId: req.id, kind: 'certificate', certName: '注册证书', minCount: 1 }],
    records: [verifiedCertificate({ companyId: null, verified: false, verificationIssues: ['mapping_missing'] })],
  });

  assert.equal(result.decision, 'review');
  assert.equal(result.items[0].status, 'review');
  assert.ok(result.items[0].reasons.includes('verified_evidence_missing'));
});

test('returns review when the only matching certificate expires before the bid deadline', () => {
  const req = requirement();
  const result = assess({
    tender: handoff({ requirements: [req] }),
    rules: [{ requirementId: req.id, kind: 'certificate', certName: '注册证书', minCount: 1 }],
    records: [verifiedCertificate({ expires_on: '2026-09-30' })],
  });

  assert.equal(result.decision, 'review');
  assert.ok(result.items[0].reasons.includes('certificate_expired_at_deadline'));
});

test('deduplicates certificate holders when checking the required headcount', () => {
  const req = requirement({ value: '至少 2 人持有注册证书' });
  const result = assess({
    tender: handoff({ requirements: [req] }),
    rules: [{ requirementId: req.id, kind: 'certificate', certName: '注册证书', minCount: 2 }],
    records: [
      verifiedCertificate({ id: 'cert-1' }),
      verifiedCertificate({ id: 'cert-2', attachments: [{ id: 'att-2', verified: true }] }),
    ],
  });

  assert.equal(result.decision, 'review');
  assert.ok(result.items[0].reasons.includes('certificate_holder_count_insufficient'));
  assert.deepEqual(result.items[0].evidenceRecordIds, ['cert-1', 'cert-2']);
});

test('leaves uncovered qualification and redline requirements for manual review', () => {
  const qualification = requirement();
  const redline = requirement({ id: 'req-redline', key: '废标条款', category: 'redline' });
  const result = assess({ tender: handoff({ requirements: [qualification, redline] }) });

  assert.equal(result.decision, 'review');
  assert.deepEqual(result.items.map((item) => item.status), ['review', 'review']);
  assert.equal(result.items.every((item) => item.reasons.includes('structured_rule_missing')), true);
});

test('rejects only an explicit verified manual negative or a passed deadline', () => {
  const req = requirement({ id: 'req-manual' });
  const manualNegative = assess({
    tender: handoff({ requirements: [req] }),
    rules: [{ requirementId: req.id, kind: 'manual', result: 'not_satisfied', verified: true }],
  });
  const expiredDeadline = assess({
    at: '2026-10-01T09:00:01+08:00',
  });

  assert.equal(manualNegative.decision, 'reject');
  assert.equal(manualNegative.items[0].status, 'not_satisfied');
  assert.equal(expiredDeadline.decision, 'reject');
  assert.ok(expiredDeadline.blockers.includes('deadline_passed'));
});

test('follows when verified certificate and performance evidence meet structured rules', () => {
  const certReq = requirement();
  const perfReq = requirement({ id: 'req-perf', key: '类似业绩', value: '2024 年后至少一项 1000 万元业绩' });
  const result = assess({
    tender: handoff({ requirements: [certReq, perfReq] }),
    rules: [
      {
        requirementId: certReq.id,
        kind: 'certificate',
        certName: '注册证书',
        specialty: '机电',
        level: '一级',
        minCount: 1,
      },
      {
        requirementId: perfReq.id,
        kind: 'performance',
        category: '信息化',
        minAmount: 1000,
        fromDate: '2024-01-01',
        toDate: '2026-09-30',
        minCount: 1,
      },
    ],
    records: [verifiedCertificate(), verifiedPerformance()],
  });

  assert.equal(result.decision, 'follow');
  assert.deepEqual(result.items.map((item) => item.status), ['satisfied', 'satisfied']);
  assert.deepEqual(result.blockers, []);
  assert.ok(result.actions.includes('confirm_follow'));
});

test('keeps a critical requirement in review while its source text still requires confirmation', () => {
  const req = requirement({ confidence: 0.95, requiresConfirmation: true });
  const result = assess({
    tender: handoff({ requirements: [req] }),
    rules: [{ requirementId: req.id, kind: 'certificate', certName: '注册证书', minCount: 1 }],
    records: [verifiedCertificate()],
  });

  assert.equal(result.decision, 'review');
  assert.equal(result.items[0].status, 'review');
  assert.ok(result.items[0].reasons.includes('requirement_confirmation_pending'));
});

test('keeps a low-confidence critical requirement in review despite matching company evidence', () => {
  const req = requirement({ confidence: 0.79, requiresConfirmation: false });
  const result = assess({
    tender: handoff({ requirements: [req] }),
    rules: [{ requirementId: req.id, kind: 'certificate', certName: '注册证书', minCount: 1 }],
    records: [verifiedCertificate()],
  });

  assert.equal(result.decision, 'review');
  assert.equal(result.items[0].status, 'review');
  assert.ok(result.items[0].reasons.includes('requirement_confidence_low'));
});

test('fails closed when a critical requirement omits confirmation metadata', () => {
  const req = requirement({ confidence: undefined, requiresConfirmation: undefined });
  const result = assess({
    tender: handoff({ requirements: [req] }),
    rules: [{ requirementId: req.id, kind: 'certificate', certName: '注册证书', minCount: 1 }],
    records: [verifiedCertificate()],
  });

  assert.equal(result.decision, 'review');
  assert.ok(result.items[0].reasons.includes('requirement_confirmation_pending'));
  assert.ok(result.items[0].reasons.includes('requirement_confidence_invalid'));
});

test('keeps incomplete or low-confidence snapshots in review', () => {
  const incomplete = assess({
    tender: handoff({ snapshot: { ...handoff().snapshot, completeness: 0.8 } }),
  });
  const lowConfidence = assess({
    tender: handoff({ snapshot: { ...handoff().snapshot, confidence: 0.79 } }),
  });

  assert.equal(incomplete.decision, 'review');
  assert.ok(incomplete.blockers.includes('handoff_snapshot_incomplete'));
  assert.equal(lowConfidence.decision, 'review');
  assert.ok(lowConfidence.blockers.includes('handoff_snapshot_confidence_low'));
});

test('fails closed when required snapshot quality fields are absent', () => {
  const snapshot = { ...handoff().snapshot };
  delete snapshot.completeness;
  delete snapshot.confidence;
  const result = assess({ tender: handoff({ snapshot }) });

  assert.equal(result.decision, 'review');
  assert.ok(result.blockers.includes('handoff_snapshot_completeness_invalid'));
  assert.ok(result.blockers.includes('handoff_snapshot_confidence_invalid'));
});

test('keeps blocked or superseded handoffs in review even when status says ready', () => {
  const blocked = assess({
    tender: handoff({ warnings: [{ code: 'manual', message: '待确认', affectedChapterKeys: ['all'], blocked: true }] }),
  });
  const superseded = assess({
    tender: handoff({ superseded: true, latestDocumentVersion: 'document-v2' }),
  });
  const staleVersion = assess({
    tender: handoff({ latestDocumentVersion: 'document-v2' }),
  });

  assert.equal(blocked.decision, 'review');
  assert.ok(blocked.blockers.includes('handoff_warning_blocked'));
  assert.equal(superseded.decision, 'review');
  assert.ok(superseded.blockers.includes('handoff_superseded'));
  assert.equal(staleVersion.decision, 'review');
  assert.ok(staleVersion.blockers.includes('handoff_superseded'));
});

test('keeps unknown dates, malformed amounts, and unavailable attachments in review', () => {
  const certReq = requirement();
  const perfReq = requirement({ id: 'req-perf', key: '类似业绩' });
  const result = assess({
    tender: handoff({ requirements: [certReq, perfReq] }),
    rules: [
      { requirementId: certReq.id, kind: 'certificate', certName: '注册证书' },
      { requirementId: perfReq.id, kind: 'performance', minAmount: 1000, fromDate: '2024-01-01' },
    ],
    records: [
      verifiedCertificate({ expires_on: '', verified: false, verificationIssues: ['attachment_hash_mismatch'] }),
      verifiedPerformance({ amount: 'not-a-number', event_date: '' }),
    ],
  });

  assert.equal(result.decision, 'review');
  assert.ok(result.items[0].reasons.includes('verified_evidence_missing'));
  assert.ok(result.items[1].reasons.includes('performance_amount_invalid'));
  assert.ok(result.items[1].reasons.includes('performance_date_unknown'));
  assert.ok(result.actions.includes('request_verification'));
});

test('does not count cloned ledger rows with the same contract evidence as separate performances', () => {
  const req = requirement({ id: 'req-perf', key: '类似业绩', value: '至少两项类似业绩' });
  const sharedHash = 'c'.repeat(64);
  const first = verifiedPerformance({
    id: 'perf-clone-1',
    client: '测试客户甲',
    attachments: [{ id: 'att-clone-1', sha256: sharedHash, verified: true }],
  });
  const second = verifiedPerformance({
    id: 'perf-clone-2',
    client: '测试客户甲',
    attachments: [{ id: 'att-clone-2', sha256: sharedHash, verified: true }],
  });

  const result = assess({
    tender: handoff({ requirements: [req] }),
    rules: [{ requirementId: req.id, kind: 'performance', category: '信息化', minCount: 2 }],
    records: [first, second],
  });

  assert.equal(result.decision, 'review');
  assert.equal(result.items[0].status, 'review');
  assert.ok(result.items[0].reasons.includes('performance_duplicate_evidence'));
  assert.ok(result.items[0].reasons.includes('performance_count_insufficient'));
  assert.deepEqual(result.items[0].evidenceRecordIds, ['perf-clone-1', 'perf-clone-2']);
});

test('counts genuinely distinct contracts as separate performances', () => {
  const req = requirement({ id: 'req-perf', key: '类似业绩', value: '至少两项类似业绩' });
  const result = assess({
    tender: handoff({ requirements: [req] }),
    rules: [{ requirementId: req.id, kind: 'performance', category: '信息化', minCount: 2 }],
    records: [
      verifiedPerformance({
        id: 'perf-distinct-1',
        name: '测试项目甲',
        client: '测试客户甲',
        attachments: [{ id: 'att-distinct-1', sha256: 'd'.repeat(64), verified: true }],
      }),
      verifiedPerformance({
        id: 'perf-distinct-2',
        name: '测试项目乙',
        client: '测试客户乙',
        amount: '1350',
        event_date: '2025-07-15',
        attachments: [{ id: 'att-distinct-2', sha256: 'e'.repeat(64), verified: true }],
      }),
    ],
  });

  assert.equal(result.decision, 'follow');
  assert.equal(result.items[0].status, 'satisfied');
  assert.deepEqual(result.items[0].evidenceRecordIds, ['perf-distinct-1', 'perf-distinct-2']);
});

test('keeps non-ready or malformed handoffs in review rather than inferring rejection', () => {
  const needsManual = assess({ tender: handoff({ status: 'needs_manual' }) });
  const invalid = assess({ tender: handoff({ status: 'invalid' }) });
  const wrongSchema = assess({ tender: handoff({ schemaVersion: '2.0' }) });

  assert.equal(needsManual.decision, 'review');
  assert.equal(invalid.decision, 'review');
  assert.equal(wrongSchema.decision, 'review');
  assert.ok(wrongSchema.blockers.includes('handoff_schema_unsupported'));
});

test('validates the official checksum format while accepting a bare SHA-256 digest', () => {
  const malformed = assess({
    tender: handoff({
      snapshot: { ...handoff().snapshot, checksum: 'sha256:not-a-digest' },
    }),
  });
  const bareDigest = assess({
    tender: handoff({
      snapshot: { ...handoff().snapshot, checksum: 'b'.repeat(64) },
    }),
  });

  assert.equal(malformed.decision, 'review');
  assert.ok(malformed.blockers.includes('handoff_snapshot_checksum_invalid'));
  assert.equal(bareDigest.decision, 'follow');
});

test('does not broaden matching when a structured record selector is malformed', () => {
  const req = requirement();
  const result = assess({
    tender: handoff({ requirements: [req] }),
    rules: [{
      requirementId: req.id,
      kind: 'certificate',
      certName: '注册证书',
      recordIds: 'cert-1',
    }],
    records: [verifiedCertificate()],
  });

  assert.equal(result.decision, 'review');
  assert.ok(result.items[0].reasons.includes('structured_rule_invalid'));
});

test('exports Chinese labels for action and assessment codes used by cards', () => {
  assert.equal(ASSESSMENT_LABELS.actions.confirm_follow, '确认跟进');
  assert.equal(ASSESSMENT_LABELS.blockers.deadline_passed, '投标截止时间已过');
  assert.equal(ASSESSMENT_LABELS.reasons.verified_evidence_missing, '尚未找到已核实的公司证据');
  assert.equal(ASSESSMENT_LABELS.confirm_follow, '确认跟进');
  assert.equal(ASSESSMENT_LABELS.verified_evidence_missing, '尚未找到已核实的公司证据');
});
