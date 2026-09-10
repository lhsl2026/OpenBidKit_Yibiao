'use strict';

const { ASSESSMENT_LABELS } = require('./assessment.cjs');
const { fieldLabel } = require('./handoff-fields.cjs');

const verdictLabels = Object.freeze({ follow: '建议投', review: '暂缓核实', reject: '不建议投' });
const criticalCategories = new Set(['qualification', 'redline']);

function short(value, max = 72) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function basicFact(requirements, label, pattern, categories = ['basic']) {
  const allowed = new Set(categories);
  const row = requirements.find((requirement) => allowed.has(requirement.category) && pattern.test(`${fieldLabel(requirement)} ${requirement.key ?? ''} ${requirement.value ?? ''}`));
  return { label, value: row ? short(row.value, 100) : '待核实' };
}

const digest = value => String(value ?? '').replace(/^sha256:/iu, '').toLowerCase();
function decisionFields(project, handoff) {
  const facts = project.input?.decisionFacts, binding = facts?.binding, snapshot = handoff?.snapshot;
  if (facts?.schemaVersion !== 1 || !binding || !snapshot || binding.reportId !== snapshot.reportId || binding.reportVersion !== snapshot.reportVersion || String(binding.documentVersion) !== String(snapshot.documentVersion) || digest(binding.checksum) !== digest(snapshot.checksum) || digest(binding.checksum) !== digest(project.checksum)) return null;
  return facts.fields && typeof facts.fields === 'object' ? facts.fields : null;
}
function preferredFact(fields, key, fallback) {
  const item = fields?.[key];
  if (!item || !['confirmed', 'review', 'missing'].includes(item.status) || typeof item.value !== 'string' || !item.value.trim()) return fallback;
  if (item.status === 'missing') return { ...fallback, value: '待核实' };
  return { ...fallback, value: `${item.status === 'review' ? '待复核：' : ''}${short(item.value, 120)}` };
}

function gateLabel(requirement) {
  const text = `${requirement?.key ?? ''} ${requirement?.value ?? ''}`;
  if (/人员|项目负责人|项目经理|工程师|建造师|注册证|职称/.test(text)) return '人员证书';
  if (/业绩|合同案例|类似项目/.test(text)) return '历史业绩';
  if (/财务|审计|资信|资产负债|现金流/.test(text)) return '财务能力';
  if (/营业执照|独立承担民事责任|法人登记/.test(text)) return '主体资格';
  if (/信用|失信|违法记录/.test(text)) return '信用记录';
  if (/纳税|税收|社保/.test(text)) return '纳税社保';
  if (/签章|盖章|签字|解密|保证金/.test(text)) return '响应红线';
  if (/资质|许可|认证|证书/.test(text)) return '企业资质';
  return requirement?.category === 'redline' ? '废标风险' : '其他资格';
}

function reasonLabel(code) {
  const value = String(code ?? '');
  const leaf = value.split(':').at(-1);
  return ASSESSMENT_LABELS.reasons?.[leaf]
    ?? ASSESSMENT_LABELS.blockers?.[leaf]
    ?? ASSESSMENT_LABELS.actions?.[leaf]
    ?? '需要人工核实';
}

function isNonBlockingDisclosure(requirement) {
  const text = `${requirement?.key ?? ''} ${requirement?.value ?? ''}`;
  return /非专门面向中小企业|(?:特定资格要求|特殊行业资质).{0,8}(?:为无|无要求)|无特殊行业资质/.test(text);
}

function deadlineSummary(value, now = Date.now()) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '待核实';
  const date = new Date(timestamp);
  const display = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .format(date).replaceAll('/', '-');
  const todayParts = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now)).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
  const deadlineParts = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
  const days = Math.round((Date.UTC(deadlineParts.year, deadlineParts.month - 1, deadlineParts.day) - Date.UTC(todayParts.year, todayParts.month - 1, todayParts.day)) / 86400000);
  return `${display}（${days < 0 ? '已截止' : days === 0 ? '生成时为截止当天' : `生成时距截止 ${days} 天`}）`;
}

function buildDecisionBrief(project, { now = Date.now() } = {}) {
  const handoff = project.input?.handoff ?? {};
  const requirements = Array.isArray(handoff.requirements) ? handoff.requirements : [];
  const fields = decisionFields(project, handoff);
  const assessment = project.assessment ?? {};
  const assessmentItems = Array.isArray(assessment.items) ? assessment.items : [];
  const itemByRequirement = new Map(assessmentItems.filter((item) => item.requirementId).map((item) => [item.requirementId, item]));
  let gates = requirements.filter((requirement) => criticalCategories.has(requirement.category)).map((requirement) => ({ requirement, item: itemByRequirement.get(requirement.id) ?? { status: 'review', reasons: ['manual_result_unverified'] } }));
  if (gates.length === 0) gates = assessmentItems.filter((item) => criticalCategories.has(item.category)).map((item) => ({ requirement: item, item }));
  const gateCounts = { notSatisfied: 0, review: 0, satisfied: 0 };
  for (const { item } of gates) {
    if (item.status === 'not_satisfied') gateCounts.notSatisfied += 1;
    else if (item.status === 'satisfied') gateCounts.satisfied += 1;
    else gateCounts.review += 1;
  }
  const gatePriority = { '人员证书': 0, '企业资质': 1, '历史业绩': 2, '财务能力': 3, '纳税社保': 4, '主体资格': 5, '信用记录': 6, '响应红线': 7, '废标风险': 8, '其他资格': 9 };
  const ordered = [...gates].sort((left, right) => {
    const state = ({ not_satisfied: 0, review: 1, satisfied: 2 }[left.item.status] ?? 1) - ({ not_satisfied: 0, review: 1, satisfied: 2 }[right.item.status] ?? 1);
    return state || (gatePriority[gateLabel(left.requirement)] ?? 99) - (gatePriority[gateLabel(right.requirement)] ?? 99);
  });
  const seenRisk = new Set();
  const risks = [];
  for (const { requirement, item } of ordered) {
    if (item.status === 'satisfied' || isNonBlockingDisclosure(requirement)) continue;
    const label = gateLabel(requirement);
    if (seenRisk.has(label)) continue;
    seenRisk.add(label);
    const state = item.status === 'not_satisfied' ? '明确不满足' : '待核验';
    risks.push(`${state}：${label}—${short(requirement.value || reasonLabel(item.reasons?.[0]))}`);
    if (risks.length === 3) break;
  }
  for (const blocker of Array.isArray(assessment.blockers) ? assessment.blockers : []) {
    const value = reasonLabel(blocker);
    if (!risks.some((risk) => risk.includes(value))) risks.push(value);
    if (risks.length === 3) break;
  }
  if (risks.length === 0) risks.push('未发现已核验的硬门槛缺口，仍需员工确认投标策略');
  const actions = [];
  for (const { requirement, item } of ordered) {
    if (item.status === 'satisfied' || isNonBlockingDisclosure(requirement)) continue;
    const label = gateLabel(requirement);
    const role = ['人员证书', '历史业绩', '财务能力', '纳税社保', '主体资格', '企业资质'].includes(label) ? '资质专员' : '投标负责人';
    const action = item.status === 'not_satisfied' ? `${role}：确认${label}缺口能否补齐；不可补则不投` : `${role}：核验${label}并关联原件`;
    if (!actions.includes(action)) actions.push(action);
    if (actions.length === 2) break;
  }
  actions.push('商务负责人：核算成本、报价、付款占用和预期得分');
  return {
    title: handoff.task?.title ?? '未命名项目',
    company: project.companyId ?? project.input?.companyId ?? '待核实',
    eligibility: verdictLabels[assessment.decision] ?? verdictLabels.review,
    commercial: '待测算（缺少完整成本、报价或竞争依据）',
    deadline: deadlineSummary(project.input?.deadline, now),
    facts: (() => {
      const owner = basicFact(requirements, '招标人', /招标人|采购人/);
      const budget = preferredFact(fields, 'budget', basicFact(requirements, '预算/最高限价', /预算|最高限价|控制价/));
      const duration = preferredFact(fields, 'duration', basicFact(requirements, '工期/服务期', /工期|服务期|交货期|交付期/, ['basic', 'contract', 'commercial']));
      const payment = preferredFact(fields, 'payment', basicFact(requirements, '付款条件', /付款|支付|结算/, ['basic', 'contract', 'commercial']));
      const evaluation = preferredFact(fields, 'evaluationMethod', basicFact(requirements, '评审办法', /评标|评审办法|综合评分|最低价/));
      const bond = preferredFact(fields, 'bidBond', basicFact(requirements, '投标保证金', /投标保证金|保证金金额/));
      const closure = preferredFact(fields, 'scoreClosure', { label: '评分闭合', value: '待核实' });
      return [owner, budget, duration, payment, evaluation, bond, closure];
    })(),
    gateCounts,
    risks: risks.slice(0, 3),
    actions: [...new Set(actions)].slice(0, 3),
  };
}

function markdownEscape(value) {
  return String(value ?? '').replace(/[\\`*_[\]<>#]/g, '\\$&');
}

function buildDecisionBriefMarkdown(project, options) {
  const brief = buildDecisionBrief(project, options);
  const list = (values) => values.map((value) => `- ${markdownEscape(value)}`).join('\n');
  return `# 投标决策摘要

> **资格结论：${markdownEscape(brief.eligibility)}**  
> **商务判断：${markdownEscape(brief.commercial)}**

## 一眼判断

- 项目：${markdownEscape(brief.title)}
- 判标主体：${markdownEscape(brief.company)}
- 投标截止：${markdownEscape(brief.deadline)}

## 一票否决检查

- 明确不满足：${brief.gateCounts.notSatisfied} 项
- 待核验：${brief.gateCounts.review} 项
- 已核验满足：${brief.gateCounts.satisfied} 项

## 核心商务信息

${list(brief.facts.map((fact) => `${fact.label}：${fact.value}`))}

## 主要风险（最多3项）

${list(brief.risks)}

## 下一步（最多3项）

${list(brief.actions)}`;
}

function composeDecisionReport(project, sourceMarkdown, options) {
  return `${buildDecisionBriefMarkdown(project, options)}

---

## 详细证据附录

以下内容用于核对原始条款和出处，日常判标优先阅读上方摘要。

${sourceMarkdown}`;
}

module.exports = { buildDecisionBrief, buildDecisionBriefMarkdown, composeDecisionReport };
