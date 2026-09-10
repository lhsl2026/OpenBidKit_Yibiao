'use strict';
// Offline only: reads completed bridge records, imports consumer functions, never calls a provider.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const assert = require('node:assert/strict');
const [sourceRoot, databasePath, summaryPath, since] = process.argv.slice(2);
if (!sourceRoot || !databasePath) throw new Error('Usage: node replay-cache.cjs <built-consumer-root> <bridge.sqlite3> [summary.json]');
const localRequire = createRequire(path.join(path.resolve(sourceRoot), 'package.json'));
const parser = localRequire('./dist/server/modules/preread/preread-parser.service.js');
const { buildPrereadKnowledgeReport } = localRequire('./dist/server/modules/preread/preread-knowledge-report.js');
const { renderPrereadKnowledgeMarkdown } = localRequire('./dist/server/modules/preread/preread-knowledge-renderer.js');
const db = new DatabaseSync(databasePath, { readOnly: true });
const rows = db.prepare("select key, value from settings where key like 'codex-bridge-request:%' order by key").all();
const auditHash = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
const chunks = [], findings = [], batches = [];
for (const row of rows) {
  let cached, raw;
  try { cached = JSON.parse(row.value); raw = JSON.parse(cached.content); } catch { continue; }
  if (since && cached.createdAt < Date.parse(since)) continue;
  if (cached.state !== 'completed' || !raw || !Array.isArray(raw.评分项)) continue;
  const isScore = Object.hasOwn(raw, '评分办法');
  if (!isScore && !Array.isArray(raw.项目事实)) continue;
  const original = JSON.stringify(raw);
  const normalized = (isScore ? parser.normalizeScoreFacts : parser.normalizeExtractedFacts)(raw);
  if (isScore) {
    for (const original of [...(raw.评分项 ?? []), ...(raw.评分办法 ?? [])]) {
      const item = Object.values(normalized).flat().find(candidate => candidate.statement === original.statement && candidate.quote === original.quote);
      assert.ok(item, 'score source record lost during normalization');
      if (original.confidence == null || (typeof original.confidence === 'string' && !Number.isFinite(Number(original.confidence)))) {
        assert.equal(item.confidence, 0, 'unknown/qualitative confidence must not imply assessed confidence');
        assert.ok(String(item.section).includes('待核实'));
      }
      if (Array.isArray(original.page)) {
        assert.equal(item.page, undefined);
        assert.ok(String(item.section).includes(JSON.stringify(original.page)));
      }
      for (const key of ['rule', 'procedure', 'evidenceRequirement']) {
        if (Object.hasOwn(original, key)) assert.ok(String(item.section).includes(JSON.stringify(original[key])), 'supplemental scoring source text was lost');
      }
    }
  }
  batches.push(normalized);
  const inputCount = Object.values(raw).filter(Array.isArray).reduce((n, arr) => n + arr.length, 0);
  let outputCount = 0, unknownPage = 0;
  for (const [findingType, records] of Object.entries(normalized)) {
    for (const item of records) {
      outputCount++;
      const finding = parser.toFinding(findingType, item, { taskId: 'offline-cache-replay', documentId: 'offline-document', documentVersion: 1, fileName: '离线回放来源.pdf', fileUrl: '' });
      if (!Number.isInteger(item.page) && !(item.sheet && Number.isInteger(item.row))) {
        unknownPage++;
        assert.equal(finding.status, 'unconfirmed');
        assert.ok(finding.evidence.confidence < 0.8);
      }
      findings.push({ id: `replay-${findings.length}`, findingType, ...finding, ...finding.evidence });
    }
  }
  assert.equal(JSON.stringify(raw), original, 'normalization must not mutate raw audit data');
  assert.equal(outputCount, inputCount, 'replay must retain every input finding');
  chunks.push({ cacheSuffix: row.key.slice(-10), kind: isScore ? 'score' : 'fact', inputCount, outputCount, unknownPage });
}
assert.ok(chunks.length > 0, 'no preread cache records found');
const normalizedFindingCount = findings.length;
const merged = parser.mergeExtractedFacts(batches);
const sourceKeys = new Map();
const canonical = value => typeof value === 'string' ? value.trim().replace(/\s+/gu, ' ') : '';
for (const batch of batches) for (const [kind, records] of Object.entries(batch)) for (const item of records) {
  if (kind === '评分项') continue;
  const key = JSON.stringify([kind, canonical(item.statement), canonical(item.section), item.page ?? null, canonical(item.sheet), item.row ?? null, canonical(item.quote)]);
  const group = sourceKeys.get(key) ?? [];
  group.push(item); sourceKeys.set(key, group);
}
const duplicateSourceRecords = [...sourceKeys.values()].filter(group => group.length > 1).map(group => ({ count: group.length, differingFields: [...new Set(group.flatMap(item => Object.keys(item)))].filter(key => new Set(group.map(item => JSON.stringify(item[key]))).size > 1) }));
findings.length = 0;
for (const [findingType, records] of Object.entries(merged)) {
  for (const item of records) {
    const finding = parser.toFinding(findingType, item, { taskId: 'offline-cache-replay', documentId: 'offline-document', documentVersion: 1, fileName: '离线回放来源.pdf', fileUrl: '' });
    findings.push({ id: `replay-${findings.length}`, findingType, ...finding, ...finding.evidence });
  }
}
if (since === '2026-09-10T06:19:00Z') {
  assert.equal(chunks.length, 19, 'LED replay must include all 19 saved chunks');
  assert.equal(normalizedFindingCount, 263, 'LED raw record count changed');
  assert.ok(duplicateSourceRecords.every(group => group.differingFields.length === 0), 'only exact duplicate sources may be coalesced');
  const duplicateCount = duplicateSourceRecords.reduce((count, group) => count + group.count - 1, 0);
  assert.equal(findings.length + duplicateCount, normalizedFindingCount, 'LED merge lost a nonduplicate original record');
  assert.equal(merged.评分项.length, 0, 'LED categories must remain unclassified instead of guessed');
}
for (const batch of batches) {
  for (const item of batch.评分项) {
    const category = item.evaluation?.category;
    if (category && !['technical', 'commercial', 'price', '技术', '商务', '价格'].includes(category)) {
      assert.ok(merged.待确认事项.some(pending => pending.statement === item.statement && pending.quote === item.quote && String(pending.section).includes(category)), 'unknown-category score was lost during merge');
    }
  }
}
const report = buildPrereadKnowledgeReport({ task: { id: 'offline-cache-replay', title: '缓存兼容回放', priorityLevel: '普通' }, document: { id: 'offline-document', version: 1, fileName: '离线回放来源.pdf', completeTenderDocument: true, parseStatus: 'parsed' }, extractionComplete: true, findings, previousFindings: [], manualActions: [] });
const markdown = renderPrereadKnowledgeMarkdown(report);
const legacyRecords = findings.filter(f => ['资格条件', '商务条款', '废标风险'].includes(f.findingType));
assert.ok(legacyRecords.length > 0);
for (const f of legacyRecords) {
  const metadata = f.qualification ?? f.commercial ?? f.redline;
  assert.ok(metadata, 'legacy requirement must appear in structured metadata');
  if (metadata.supplementableBeforeDeadline === undefined) assert.equal(f.status, 'unconfirmed');
}
assert.ok(report.qualifications.length > 0);
assert.ok(report.redlines.length > 0);
assert.notEqual(report.qualityStatus, '可编标');
assert.notEqual(report.recommendation, '建议参与');
const after = db.prepare("select key, value from settings where key like 'codex-bridge-request:%' order by key").all();
assert.equal(createHash('sha256').update(JSON.stringify(after)).digest('hex'), auditHash, 'bridge cache changed during offline replay');
db.close();
const summary = { offline: true, providerCalls: 0, rawCacheUnchanged: true, realMergeExecuted: true, chunks, normalizedFindingCount, totalFindings: findings.length, duplicateSourceRecords, unconfirmedFindings: findings.filter(f => f.status === 'unconfirmed').length, pendingScoreRecords: merged.待确认事项.filter(f => String(f.section).includes('原始评分元数据')).length, report: { qualifications: report.qualifications.length, redlines: report.redlines.length, contractRequirements: report.contractRequirements?.length ?? 0, complianceRequirements: report.complianceRequirements?.length ?? 0, deliveryServiceRequirements: report.deliveryServiceRequirements?.length ?? 0, technicalScores: report.technicalScores.length, commercialScores: report.commercialScores.length, priceScores: report.priceScores.length, priceScoreValues: report.priceScores.map(item => item.maximumScore), qualityStatus: report.qualityStatus, recommendation: report.recommendation, unknownSupplementabilityRendered: markdown.includes('待核实') } };
if (summaryPath) fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n');
process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
