'use strict';

const MISSING = Object.freeze({ status: 'missing', value: '待核实', evidence: [] });
const sections = ['contractRequirements', 'deliveryServiceRequirements', 'complianceRequirements', 'specialMatters', 'redlines'];
const textOf = row => [row?.requirement, row?.matter, row?.parameter, row?.criterion, row?.triggerCondition, row?.evidence?.quote].filter(Boolean).join('\n');
const valueOf = row => String(row?.requirement ?? row?.matter ?? row?.parameter ?? row?.criterion ?? row?.triggerCondition ?? row?.evidence?.quote ?? '').trim();
const copiedEvidence = evidence => evidence && typeof evidence === 'object' ? Object.fromEntries(['page', 'quote', 'section', 'fileName', 'confidence', 'documentVersion'].filter(key => evidence[key] !== undefined).map(key => [key, evidence[key]])) : null;
const evidenceConfirmed = evidence => Boolean(evidence && Number.isInteger(evidence.documentVersion) && evidence.documentVersion >= 0 && Number.isInteger(evidence.page) && evidence.page > 0 && typeof evidence.quote === 'string' && evidence.quote.trim() && Number(evidence.confidence) >= 0.8);
const fact = (value, evidence, forceReview = false) => ({ status: !forceReview && evidenceConfirmed(evidence) ? 'confirmed' : 'review', value: String(value).trim(), evidence: evidence ? [copiedEvidence(evidence)] : [] });
const allRows = knowledge => sections.flatMap(section => Array.isArray(knowledge?.[section]) ? knowledge[section] : []);
const best = rows => [...rows].sort((left, right) => Number(evidenceConfirmed(right.evidence)) - Number(evidenceConfirmed(left.evidence)) || Number(right.evidence?.confidence ?? 0) - Number(left.evidence?.confidence ?? 0) || Number(Boolean(right.evidence?.page)) - Number(Boolean(left.evidence?.page)))[0];
const usableBasic = value => value && typeof value.value === 'string' && value.value.trim() && !/^(?:未识别|待核实|未知)$/u.test(value.value.trim());

function amountMatches(text, labels) {
  const pattern = new RegExp(`(${labels.join('|')})\\s*[（(]?\\s*(万元|元)?\\s*[)）]?\\s*[：:]?\\s*(?:人民币)?\\s*([0-9][0-9,]*(?:\\.[0-9]+)?)\\s*(万元|元)?`, 'gu');
  return [...String(text ?? '').normalize('NFKC').matchAll(pattern)].map(match => ({ label: match[1], unit: match[2] || match[4] || '元', number: Number(match[3].replace(/,/g, '')) })).filter(item => Number.isFinite(item.number));
}
const displayAmount = item => `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(item.number)}${item.unit}`;

function budgetFact(knowledge, rows) {
  const basic = knowledge?.basicInformation?.budgetOrCeiling;
  if (usableBasic(basic)) return fact(basic.value, basic.evidence);
  for (const row of rows) {
    const matches = amountMatches(textOf(row), ['预算金额', '采购预算', '最高限价', '招标控制价']);
    if (!matches.length) continue;
    const budget = matches.find(item => /预算/u.test(item.label));
    const ceiling = matches.find(item => /限价|控制价/u.test(item.label));
    if (budget && ceiling && budget.number === ceiling.number && budget.unit === ceiling.unit) return fact(`${displayAmount(budget)}（预算/最高限价）`, row.evidence);
    return fact([...new Map(matches.map(item => [item.label, `${item.label}${displayAmount(item)}`])).values()].join('；'), row.evidence);
  }
  return { ...MISSING };
}

function clauseFact(knowledge, rows, basicField, include, exclude) {
  const basic = knowledge?.basicInformation?.[basicField];
  if (usableBasic(basic)) return fact(basic.value, basic.evidence);
  const row = best(rows.filter(item => include.test(textOf(item)) && !(exclude?.test(textOf(item)))));
  return row ? fact(valueOf(row), row.evidence) : { ...MISSING };
}

function bidBondFact(rows) {
  const row = best(rows.filter(item => /投标保证金|保证金金额/u.test(textOf(item)) && !/履约保证金/u.test(textOf(item))));
  if (!row) return { ...MISSING };
  const matches = amountMatches(textOf(row), ['投标保证金', '保证金金额']);
  return fact(matches[0] ? displayAmount(matches[0]) : valueOf(row), row.evidence);
}

function paymentFact(rows) {
  const rank = row => {
    const text = textOf(row);
    return Number(evidenceConfirmed(row.evidence)) * 100
      + Number(row.evidence?.confidence ?? 0) * 10
      + (/付款方式|付款条件/u.test(text) ? 50 : 0)
      + (/支付|预付|尾款|进度款/u.test(text) ? 30 : 0)
      + (/(?:%|％|百分之|合同金额|总货款)/u.test(text) ? 20 : 0)
      + (/验收|签订|交货|进场|运行/u.test(text) ? 10 : 0)
      - (/综合报价|估算错误|不另付/u.test(text) ? 40 : 0);
  };
  const candidates = rows.filter(item => /付款方式|付款条件|支付|预付|尾款|进度款|结算/u.test(textOf(item)));
  const row = [...candidates].sort((left, right) => rank(right) - rank(left))[0];
  return row ? fact(valueOf(row), row.evidence) : { ...MISSING };
}

function evaluationFacts(knowledge) {
  const basic = knowledge?.basicInformation?.evaluationMethod;
  const scores = Array.isArray(knowledge?.scoreMap) ? knowledge.scoreMap : [];
  const labels = { technical: '技术', commercial: '商务', price: '价格' };
  const identified = scores.filter(item => typeof item.identifiedScore === 'number').map(item => `${labels[item.category] ?? item.category}${item.identifiedScore}分`);
  let evaluationMethod;
  if (usableBasic(basic)) evaluationMethod = fact(basic.value, basic.evidence);
  else if (scores.length) evaluationMethod = { status: 'review', value: `评审办法名称待核实${identified.length ? `；已识别${identified.join('、')}` : ''}`, evidence: [] };
  else evaluationMethod = { ...MISSING };
  const scoreClosure = knowledge?.scoreClosed === true
    ? { status: 'confirmed', value: `已闭合${identified.length ? `；${identified.join('、')}` : ''}`, evidence: [] }
    : knowledge?.scoreClosed === false
      ? { status: 'review', value: `未闭合${identified.length ? `；已识别${identified.join('、')}` : ''}`, evidence: [] }
      : { ...MISSING };
  return { evaluationMethod, scoreClosure };
}

function extractDecisionFacts(knowledge, binding) {
  if (!knowledge || typeof knowledge !== 'object' || !binding || typeof binding !== 'object') throw Error('decision_facts_invalid');
  const rows = allRows(knowledge);
  const evaluation = evaluationFacts(knowledge);
  return {
    schemaVersion: 1,
    binding: { ...binding },
    fields: {
      budget: budgetFact(knowledge, rows),
      duration: clauseFact(knowledge, rows, 'duration', /合同履行期限|合同履约期限|履约期限|工期|服务期|交付期|交货期|供货期/u, /投标有效期|质保期|保修期/u),
      payment: paymentFact(rows),
      bidBond: bidBondFact(rows),
      evaluationMethod: evaluation.evaluationMethod,
      scoreClosure: evaluation.scoreClosure,
    },
  };
}

module.exports = { extractDecisionFacts };
