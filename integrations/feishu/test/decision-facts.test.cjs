'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractDecisionFacts } = require('../decision-facts.cjs');

const evidence = (quote, page = 6, confidence = 1) => ({ page, quote, section: '项目基本信息', fileName: '招标文件.pdf', confidence, documentVersion: 1 });
const row = (requirement, quote = requirement, page = 6, confidence = 1) => ({ id: requirement, requirement, evidence: evidence(quote, page, confidence) });
const binding = { reportId: 'report-1', reportVersion: 'r2', documentVersion: 1, checksum: 'a'.repeat(64) };

test('extracts budget and ceiling when the currency unit is inside parentheses', () => {
  const facts = extractDecisionFacts({
    basicInformation: { budgetOrCeiling: { value: '未识别' } },
    contractRequirements: [row('预算金额和最高限价均为595000元。', '预算金额（元）：595000\n最高限价（元）：595000')],
  }, binding);
  assert.deepEqual(facts.fields.budget, {
    status: 'confirmed', value: '595,000元（预算/最高限价）',
    evidence: [evidence('预算金额（元）：595000\n最高限价（元）：595000')],
  });
});

test('extracts staged payment terms from exact clauses', () => {
  const clause = '验收及票据齐全后支付总货款的97%，正常运行12个月后支付剩余3%。';
  const facts = extractDecisionFacts({ contractRequirements: [row(clause, clause, 15)] }, binding);
  assert.equal(facts.fields.payment.status, 'confirmed');
  assert.equal(facts.fields.payment.value, clause);
  assert.equal(facts.fields.payment.evidence[0].page, 15);
});

test('prefers explicit payment milestones over quotation settlement boilerplate', () => {
  const boilerplate = '报价为完成项目全部内容的综合报价；结算不另付其他费用，估算错误损失由供应商承担。';
  const milestones = '合同签订完成、主设备进场并验收合格后支付合同金额50%；项目完工验收合格后支付剩余尾款。';
  const facts = extractDecisionFacts({
    contractRequirements: [row(boilerplate, boilerplate, 115)],
    deliveryServiceRequirements: [row(milestones, milestones, 14)],
  }, binding);
  assert.equal(facts.fields.payment.status, 'confirmed');
  assert.equal(facts.fields.payment.value, milestones);
  assert.equal(facts.fields.payment.evidence[0].page, 14);
});

test('does not confuse a performance bond with the bid bond', () => {
  const facts = extractDecisionFacts({ contractRequirements: [
    row('履约保证金为合同金额的10%。', '履约保证金：合同金额10%', 20),
    row('投标保证金为15000.00元。', '保证金金额（元）：15000.00元', 3),
  ] }, binding);
  assert.equal(facts.fields.bidBond.status, 'confirmed');
  assert.equal(facts.fields.bidBond.value, '15,000元');
  assert.equal(facts.fields.bidBond.evidence[0].page, 3);
});

test('marks incomplete score extraction for review instead of inventing a total', () => {
  const facts = extractDecisionFacts({
    scoreClosed: false,
    scoreMap: [{ category: 'price', identifiedScore: 30, weightPercent: 30 }],
    qualityIssues: ['评分总分或分类未闭合到100分'],
  }, binding);
  assert.deepEqual(facts.fields.scoreClosure, { status: 'review', value: '未闭合；已识别价格30分', evidence: [] });
  assert.equal(facts.fields.evaluationMethod.status, 'review');
  assert.match(facts.fields.evaluationMethod.value, /办法名称待核实/);
});

test('keeps low-confidence or unlocated clauses under review', () => {
  const facts = extractDecisionFacts({ deliveryServiceRequirements: [row('合同签订后30日历天内交货。', '工期：合同签订后30日历天', undefined, 0.79)] }, binding);
  assert.equal(facts.fields.duration.status, 'review');
});

test('binds all extracted facts to the exact report identity', () => {
  const facts = extractDecisionFacts({}, binding);
  assert.deepEqual(facts.binding, binding);
  assert.equal(facts.schemaVersion, 1);
  assert.equal(facts.fields.payment.status, 'missing');
});
