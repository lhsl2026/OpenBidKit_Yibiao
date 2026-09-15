const clean = value => String(value ?? '').trim();
const normalize = value => clean(value).replace(/[\s：:]+/g, '');
const specs = {
  companyName: ['公司名称', 'fixed', ['投标人名称', '投标人全称', '投标单位名称', '供应商名称', '响应供应商名称', '公司名称', '单位名称']],
  representative: ['法定代表人姓名', 'company', ['法定代表人', '法定代表人姓名', '法人代表姓名']],
  address: ['公司地址', 'company', ['投标人地址', '供应商地址', '公司地址', '注册地址', '注册住所']],
  creditCode: ['统一社会信用代码', 'company', ['统一社会信用代码', '投标人统一社会信用代码']],
  contact: ['公司联系人', 'company', ['投标联系人', '公司联系人', '投标人联系人', '供应商联系人']],
  telephone: ['公司联系电话', 'company', ['投标人联系电话', '供应商联系电话', '公司联系电话']],
  purchaser: ['采购人', 'project', ['采购人', '采购人名称', '招标人', '招标人名称']],
  projectNo: ['项目编号', 'project', ['项目编号', '采购项目编号', '招标编号', '招标项目编号']],
  projectName: ['项目名称', 'fixed', ['项目名称', '采购项目名称', '招标项目名称']],
  delegate: ['本项目授权代理人姓名', 'project', ['授权代理人姓名', '委托代理人姓名', '被授权人姓名', '授权代表姓名']],
  date: ['本项目落款日期', 'project', ['投标日期', '落款日期']],
};
const baseKeys = ['purchaser', 'projectNo', 'representative', 'delegate', 'date'];
const COMPANY_KEYS = Object.keys(specs).filter(key => specs[key][1] === 'company');
const isPricingField = item => {
  if (commonKey(item)) return false;
  const title = clean(item.title);
  const pricingContext = item.kind === 'pricing' || /报价|价格|单价|总价|金额|税额|税率|合价|折扣|下浮|费率|费用|付款|支付|\b(price|amount|cost|fee|tax|discount|payment)\b/i.test(item.section);
  return /报价|价格|单价|总价|金额|税额|税率|合价|折扣|下浮|费率|费用|付款|支付|\b(price|amount|cost|fee|tax|discount|payment)\b/i.test(title)
    || (pricingContext && /^(大写|小写|金额大写|金额小写)$/.test(title));
};
const isSigningField = item => /签字|签名|签章|盖章|印章|公章|\b(signature|seal|stamp)\b/i.test(item.title);
const isReviewerField = item => /^(资格审查表?|符合性审查表?|价格分值计算表|评分汇总表)$/.test(clean(item.section));

function commonKey(item) {
  // 同名制造商、历史业绩与多人员表格没有可靠的一对一对应关系，保持独立填写。
  if (/制造商|生产商|生产厂家|分包|联合体|业绩|案例|人员名单|团队名单/.test(item.section || '')) return null;
  const title = normalize(item.title);
  return Object.keys(specs).find(key => specs[key][2].includes(title)) || null;
}

function companyProfileValues(values = {}) {
  return Object.fromEntries(COMPANY_KEYS.filter(key => Object.hasOwn(values, key)).map(key => [key, clean(values[key])]));
}

function buildBusinessForm(state) {
  const values = state.fieldValues || {};
  const profile = state.companyProfiles?.[state.companyName] || {};
  const occurrences = [
    ...baseKeys.map(key => ({ id: key, title: specs[key][0], section: '', common: key })),
    ...(state.analysis?.fields || []).map(item => ({ ...item, common: isReviewerField(item) ? null : commonKey(item) })),
    ...(state.wordTemplate?.fields || []).map(title => ({ id: `template:${title}`, title, section: 'Word 模板', common: commonKey({ title }) })),
  ];
  const groups = new Map();
  for (const item of occurrences) {
    const readOnly = isPricingField(item) || isSigningField(item) || isReviewerField(item);
    // “报价表”的公司名称仍是普通文本，不能因为整个表单含报价二字禁填。
    const fixed = item.common && specs[item.common][1] === 'fixed';
    const key = !readOnly || fixed ? item.common || item.id : item.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const fields = [];
  for (const [key, items] of groups) {
    const spec = specs[key];
    const fixed = spec?.[1] === 'fixed';
    const stored = [...new Set(items.map(item => clean(values[item.id])).filter(Boolean))];
    if (clean(values[key])) stored.push(clean(values[key]));
    const explicitCanonicalClear = !fixed && Object.hasOwn(values, key) && !clean(values[key])
      && items.some(item => item.id !== key && clean(values[item.id]));
    const conflict = !fixed && (new Set(stored).size > 1 || explicitCanonicalClear);
    const append = (rowKey, entries, rowSpec, hasConflict) => {
      const pricing = !fixed && entries.some(item => isPricingField(item));
      const signing = entries.some(item => isSigningField(item));
      const reviewer = entries.some(item => isReviewerField(item));
      const readOnly = fixed || pricing || signing || reviewer;
      const canonical = clean(values[rowKey]);
      const existing = entries.map(item => clean(values[item.id])).find(Boolean) || '';
      const saved = rowSpec?.[1] === 'company' ? clean(profile[rowKey]) : '';
      const value = fixed ? clean(state[key]) : pricing || signing || reviewer ? '' : Object.hasOwn(values, rowKey) ? canonical : existing || saved;
      fields.push({ key: rowKey, label: rowSpec?.[0] || entries[0].title, scope: hasConflict ? 'other' : pricing || signing || reviewer ? 'manual' : rowSpec?.[1] || 'other',
        manualReason: reviewer ? '由采购人或评审人员填写' : pricing || signing ? '报价与签章由人工填写' : '',
        value, readOnly: Boolean(readOnly), conflict: hasConflict, occurrences: entries.length,
        source: fixed ? '当前项目' : saved && !canonical && !existing ? '已保存公司资料' : value ? '人工填写' : '',
        targets: entries.map(item => item.id), sections: [...new Set(entries.map(item => item.section).filter(Boolean))] });
    };
    if (conflict) for (const item of items) append(item.id, [item], item.id === key ? spec : null, true);
    else append(key, items, spec, false);
  }
  return { fields, totalOccurrences: occurrences.length, editableCount: fields.filter(field => !field.readOnly).length,
    reusedCount: fields.reduce((n, field) => n + Math.max(0, field.occurrences - 1), 0) };
}

function resolveBusinessValues(state) {
  const result = { ...(state.fieldValues || {}) };
  for (const field of buildBusinessForm(state).fields) {
    result[field.key] = field.value;
    for (const target of field.targets) result[target] = field.value;
  }
  return result;
}

function formTargetCommons(state) {
  return new Map([
    ...baseKeys.map(key => [key, key]),
    ...(state.analysis?.fields || []).map(item => [item.id, isReviewerField(item) ? null : commonKey(item)]),
    ...(state.wordTemplate?.fields || []).map(title => [`template:${title}`, commonKey({ title })]),
  ]);
}

function applyBusinessFormValues(state, input) {
  const previousFields = buildBusinessForm(state).fields;
  const targetCommons = formTargetCommons(state);
  const normalizedInput = { ...input };
  for (const canonical of Object.keys(specs)) {
    const canonicalField = previousFields.find(field => field.key === canonical && field.conflict);
    if (!Object.hasOwn(input, canonical) || clean(input[canonical]) || !canonicalField || clean(canonicalField.value)) continue;
    const conflictFields = previousFields.filter(field => field.conflict && field.key !== canonical
      && field.targets.some(target => targetCommons.get(target) === canonical));
    const verified = conflictFields.map(field => clean(input[field.key]));
    if (conflictFields.length && verified.every(Boolean) && new Set(verified).size === 1) normalizedInput[canonical] = verified[0];
  }
  const values = { ...(state.fieldValues || {}), ...normalizedInput };
  for (const field of previousFields) {
    if (!Object.hasOwn(normalizedInput, field.key)) continue;
    for (const target of field.targets) values[target] = field.readOnly ? '' : clean(normalizedInput[field.key]);
  }
  return resolveBusinessValues({ ...state, fieldValues: values });
}

module.exports = { buildBusinessForm, resolveBusinessValues, applyBusinessFormValues, companyProfileValues, COMPANY_KEYS, isPricingField, isSigningField, isReviewerField };
