const { createHash } = require('node:crypto');
const { isPricingField, isSigningField, isReviewerField, resolveBusinessValues } = require('./businessBidForms.cjs');

const GROUP_ORDER = ['directory', 'qualifications', 'fields', 'terms', 'disqualifications'];
const GROUP_META = {
  directory: ['投标文件目录与固定格式', '依据招标文件的组成、顺序和表单名称编制封面、目录、投标函及相关固定格式'],
  qualifications: ['资格审查响应与证明材料', '逐条对应资格要求，引用已核验证据，形成资格符合性对照和附件编排'],
  fields: ['商务表单与待填字段', '按原表单字段生成可编辑正文，仅在具体缺失位置保留精确占位'],
  terms: ['商务条款响应与偏离表', '逐条起草商务响应，保留实质承诺和偏离结论的提交前人工确认'],
  disqualifications: ['符合性与无效投标风险复核', '把无效投标条件转换为交付前逐项检查，不写成投标承诺正文'],
};
const clean = value => String(value ?? '').trim();
const safeCell = value => clean(value).replace(/\|/g, '｜').replace(/[\r\n]+/g, ' ');
const table = (headers, rows) => `| ${headers.join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n${rows.map(row => `| ${row.map(safeCell).join(' | ')} |`).join('\n')}`;
const sourceLabel = item => `${item.sourceName || '招标原文'} · 第${item.segment || 1}段 · ${item.section || '未标注章节'}`;
const stableId = value => createHash('sha256').update(value).digest('hex').slice(0, 16);

function selectedEvidence(state) {
  return (state.evidence || []).filter(item => item.eligible && item.confirmed && item.companyId === state.companyName).map(item => ({
    id: item.id,
    kind: item.kind,
    name: item.name,
    certificateName: item.certificateName,
    requirementIds: item.requirementIds || [],
    details: item.details || {},
    files: (item.files || []).map(file => ({ name: file.name, sha256: file.sha256 })),
  }));
}

function safeFieldValues(state) {
  const values = resolveBusinessValues(state);
  const fieldById = new Map((state.analysis?.fields || []).map(item => [item.id, item]));
  return Object.fromEntries(Object.entries(values || {}).filter(([key, value]) => {
    if (!clean(value)) return false;
    const field = fieldById.get(key);
    return !field || (!isPricingField(field) && !isSigningField(field) && !isReviewerField(field));
  }));
}

function buildBusinessDraftPackets(state, options = {}) {
  if (!state?.analysisConfirmed || !state.analysis) throw new Error('请先人工确认商务要求与候选材料');
  const maxItems = Math.max(1, Number(options.maxItems) || 24);
  const maxChars = Math.max(1000, Number(options.maxChars) || 12000);
  const context = {
    companyName: clean(state.companyName),
    projectName: clean(state.projectName),
    deadline: clean(state.deadline),
    fieldValues: safeFieldValues(state),
    evidence: selectedEvidence(state),
  };
  const packets = [];
  for (const group of GROUP_ORDER) {
    const items = (state.analysis[group] || []).map(item => ({
      id: item.id,
      group,
      title: item.title,
      quote: item.quote,
      section: item.section,
      kind: item.kind || 'text',
      source: sourceLabel(item),
    }));
    if (!items.length) continue;
    let current = [];
    let chars = 0;
    const flush = () => {
      if (!current.length) return;
      const index = packets.filter(packet => packet.group === group).length + 1;
      packets.push({ id: `${group}-${index}`, group, title: GROUP_META[group][0], purpose: GROUP_META[group][1], context, requirements: current });
      current = [];
      chars = 0;
    };
    for (const item of items) {
      const size = JSON.stringify(item).length;
      if (current.length && (current.length >= maxItems || chars + size > maxChars)) flush();
      current.push(item);
      chars += size;
    }
    flush();
  }
  if (!packets.length) throw new Error('没有可生成的商务要求');
  return packets;
}

function normalizePending(item) {
  if (!item || typeof item !== 'object') return null;
  const label = clean(item.label);
  const reason = clean(item.reason);
  if (!label || !reason) return null;
  return { label, reason, source: clean(item.source) };
}

function normalizeGeneratedPart(payload, packet) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.sections) || !payload.sections.length) throw new Error(`“${packet.title}”没有生成有效章节`);
  const allowed = new Set(packet.requirements.map(item => item.id));
  const sections = payload.sections.map((section, index) => {
    const title = clean(section?.title);
    const content = clean(section?.content);
    const requirementIds = [...new Set(Array.isArray(section?.requirementIds) ? section.requirementIds.map(clean).filter(Boolean) : [])];
    if (!title || !content) throw new Error(`“${packet.title}”第${index + 1}个章节为空`);
    const unknown = requirementIds.find(id => !allowed.has(id));
    if (unknown) throw new Error(`“${packet.title}”返回未知要求编号：${unknown}`);
    if (/(?:已经|已完成|均已).{0,8}(?:签字|签署|盖章)|(?:签字|盖章).{0,8}(?:完毕|完成)/.test(content)) throw new Error(`“${title}”声称已完成签字或盖章，已拒绝生成结果`);
    return { id: `generated-${packet.id}-${index + 1}`, title, content, requirementIds, packetId: packet.id };
  });
  return { packetId: packet.id, sections, pending: (Array.isArray(payload.pending) ? payload.pending : []).map(normalizePending).filter(Boolean) };
}

function qualificationMatrix(state) {
  const evidence = selectedEvidence(state);
  const rows = (state.analysis.qualifications || []).map((item, index) => {
    const matches = evidence.filter(entry => entry.requirementIds.includes(item.id));
    return [index + 1, item.id, item.title, matches.map(entry => entry.name).join('；') || '【待补：对应证明材料】', matches.flatMap(entry => entry.files.map(file => file.name)).join('；') || '【待补：附件】', '提交前人工确认', sourceLabel(item)];
  });
  return rows.length ? table(['序号', '要求ID', '资格要求', '我方材料', '附件', '结论', '原文来源'], rows) : '招标文件未提取到资格要求，请人工复核是否缺失。';
}

function termMatrix(state) {
  const rows = (state.analysis.terms || []).map((item, index) => [index + 1, item.id, item.title, `【提交前人工确认】拟按“${item.title}”响应，最终措辞以招标原文和授权人意见为准。`, '提交前人工确认', sourceLabel(item)]);
  return rows.length ? table(['序号', '要求ID', '招标商务条款', '拟响应', '偏离结论', '原文来源'], rows) : '招标文件未提取到商务条款，请人工复核是否缺失。';
}

function rejectionMatrix(state) {
  const rows = (state.analysis.disqualifications || []).map((item, index) => [index + 1, item.id, item.title, '提交前人工确认', sourceLabel(item)]);
  return rows.length ? table(['序号', '要求ID', '无效投标/废标条件', '复核结果', '原文来源'], rows) : '招标文件未提取到无效投标或废标条件，请人工复核是否缺失。';
}

function evidenceAppendix(state) {
  const evidence = selectedEvidence(state);
  if (!evidence.length) return '【待补：已核验的公司证明材料与附件】';
  return evidence.map((item, index) => {
    const details = Object.entries(item.details || {}).map(([key, value]) => `${key}：${value}`).join('；');
    const files = item.files.map(file => `${file.name}（SHA256：${file.sha256}）`).join('\n');
    return `### ${index + 1}. ${item.name}${item.certificateName ? `（${item.certificateName}）` : ''}\n\n材料编号：${item.id}\n\n${details ? `材料信息：${details}\n\n` : ''}对应资格要求：${item.requirementIds.join('、') || '提交前人工确认'}\n\n附件索引：\n\n${files || '【待补：附件文件】'}`;
  }).join('\n\n');
}

function deterministicPending(state) {
  const pending = [];
  const values = resolveBusinessValues(state);
  for (const field of state.analysis.fields || []) {
    if (isReviewerField(field)) continue;
    if (isPricingField(field)) pending.push({ label: field.title, reason: '报价、金额、折扣或税率须由人工填写并复核', source: field.id });
    else if (isSigningField(field)) pending.push({ label: field.title, reason: '须由授权人员完成签字或盖章', source: field.id });
    else if (!clean(values[field.id])) pending.push({ label: field.title, reason: '招标表单要求该字段，但当前公司档案和项目表单未提供', source: field.id });
  }
  const evidence = selectedEvidence(state);
  for (const item of state.analysis.qualifications || []) if (!evidence.some(entry => entry.requirementIds.includes(item.id))) pending.push({ label: item.title, reason: '尚无已核验且人工选用的对应证明材料', source: item.id });
  pending.push({ label: '商务条款响应与偏离结论', reason: '逐条拟响应已生成，提交前须由授权人员确认', source: '商务条款响应表' });
  pending.push({ label: '最终报价、签字、盖章和装订', reason: '导出后按招标文件原格式完成并复核', source: '交付前检查' });
  return pending;
}

function mergeGeneratedParts(state, parts) {
  const generatedSections = parts.flatMap(part => part.sections || []);
  if (!generatedSections.length) throw new Error('商务标正文生成结果为空');
  const covered = new Set(generatedSections.flatMap(section => section.requirementIds || []));
  const all = GROUP_ORDER.flatMap(group => (state.analysis[group] || []).map(item => ({ ...item, group })));
  const uncovered = all.filter(item => !covered.has(item.id));
  const mergedByTitle = new Map();
  for (const section of generatedSections) {
    const key = clean(section.title);
    const existing = mergedByTitle.get(key);
    if (existing) {
      existing.content = `${existing.content}\n\n${section.content}`;
      existing.requirementIds.push(...(section.requirementIds || []));
    } else {
      mergedByTitle.set(key, { id: section.id, title: key, content: section.content, requirementIds: [...(section.requirementIds || [])] });
    }
  }
  const sections = [...mergedByTitle.values()].map(section => ({ id: section.id, title: section.title, content: section.content }));
  sections.push(
    { id: 'business-qualification-matrix', title: '资格审查符合性对照表', content: qualificationMatrix(state) },
    { id: 'business-terms-matrix', title: '商务条款逐条响应与偏离确认表', content: termMatrix(state) },
    { id: 'business-evidence-appendix', title: '证明材料与附件索引', content: evidenceAppendix(state) },
    { id: 'business-rejection-check', title: '无效投标与废标条件复核表', content: rejectionMatrix(state) },
  );
  if (uncovered.length) sections.push({
    id: 'business-coverage-audit',
    title: '生成覆盖审校表',
    content: table(['要求ID', '类别', '要求', '处理位置', '原文来源'], uncovered.map(item => [item.id, item.group, item.title, '已纳入确定性对照表，提交前人工确认', sourceLabel(item)])),
  });
  const pending = [...parts.flatMap(part => part.pending || []), ...deterministicPending(state)];
  const uniquePending = [...new Map(pending.map(item => [`${item.label}\u0000${item.reason}\u0000${item.source}`, item])).values()];
  const pendingMarkdown = table(['待补/待确认项目', '原因及处理', '来源'], uniquePending.map(item => [item.label, item.reason, item.source]));
  return { sections, pending: uniquePending, pendingTitle: '待补资料与提交前确认清单', pendingMarkdown, generatedAt: new Date().toISOString(), generatorVersion: 2, coverage: { total: all.length, modelCovered: covered.size, deterministicCovered: uncovered.length } };
}

module.exports = { buildBusinessDraftPackets, normalizeGeneratedPart, mergeGeneratedParts, stableId };
