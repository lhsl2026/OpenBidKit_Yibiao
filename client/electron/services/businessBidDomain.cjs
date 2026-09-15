const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { isPricingField, isSigningField, isReviewerField, resolveBusinessValues } = require('./businessBidForms.cjs');

const COMPANY = '隆创信息有限公司';
const GROUPS = ['directory', 'qualifications', 'disqualifications', 'fields', 'terms'];
const hash = (value) => createHash('sha256').update(value).digest('hex');
const clean = (value) => String(value ?? '').trim();
const compact = (value) => clean(value).replace(/\s+/g, '');
// PDF 转 Markdown 的表格以 <br> 表示换行；它与模型摘录中的换行等价。
const compactQuote = (value) => compact(clean(value).replace(/<br\s*\/?>/gi, '\n'));
const businessDate = (date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
const cell = (value) => clean(value).replace(/\|/g, '｜').replace(/[\r\n]+/g, ' ');
const table = (headers, rows) => `| ${headers.join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n${rows.map(row => `| ${row.map(cell).join(' | ')} |`).join('\n')}`;
const provenance = (item) => `${item.sourceName || '招标原文'}，第 ${item.segment || 1} 段：${item.quote || '待核实'}`;

function normalizeAnalysis(payload, source) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('商务分析结果格式无效，请重新提取');
  const result = {};
  const sourceQuoteText = compactQuote(source.text);
  const quoteIssues = [];
  for (const group of GROUPS) {
    if (!Array.isArray(payload[group])) throw new Error(`商务分析 ${group} 格式无效，请重新提取`);
    result[group] = (payload[group] || []).map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)
        || typeof item.title !== 'string' || typeof item.quote !== 'string'
        || (item.section != null && typeof item.section !== 'string')
        || (item.kind != null && typeof item.kind !== 'string')) {
        throw new Error(`商务分析第 ${source.segment || 1} 段 ${group} 第 ${index + 1} 项格式无效，标题和原文摘录必须为文本`);
      }
      const title = clean(item.title);
      const quote = clean(item.quote);
      if (!title || !quote || !compactQuote(quote)) throw new Error(`商务分析第 ${source.segment || 1} 段缺少标题或原文摘录，请检查解析原文`);
      if (!sourceQuoteText.includes(compactQuote(quote))) quoteIssues.push({ key: `${group}:${index}`, group, index, title, quote, section: clean(item.section) });
      const section = clean(item.section);
      const value = { id: hash(`${source.id}:${source.segment}:${group}:${section}:${title}:${quote}`).slice(0, 20), title, quote, section,
        sourceId: source.id, sourceName: source.name, segment: source.segment, kind: clean(item.kind) };
      if (group === 'fields' && isPricingField(value)) value.kind = 'pricing';
      return value;
    });
  }
  if (quoteIssues.length) {
    const error = new Error(`商务分析第 ${source.segment || 1} 段有 ${quoteIssues.length} 条原文摘录不匹配（${quoteIssues[0].title.slice(0, 80)}），请核对原文定位`);
    error.code = 'BUSINESS_QUOTE_MISMATCH';
    error.quoteIssues = quoteIssues;
    throw error;
  }
  return result;
}

function mergeAnalysis(parts) {
  return Object.fromEntries(GROUPS.map(group => [group, [...new Map(parts.flatMap(part => part[group] || []).map(item => [item.id, item])).values()]]));
}

function verifyAttachments(attachments, root) {
  if (!Array.isArray(attachments) || !attachments.length) return { files: [], valid: false };
  const files = attachments.map(item => {
    const sourcePath = path.resolve(root, clean(item.relative_path));
    let valid = false;
    try { valid = item.verified === true && /^[a-f0-9]{64}$/i.test(item.sha256 || '') && hash(fs.readFileSync(sourcePath)) === item.sha256.toLowerCase(); } catch { /* 缺失原件保留待核实 */ }
    return { name: path.basename(sourcePath), sourcePath, sha256: clean(item.sha256), valid };
  });
  return { files, valid: files.every(file => file.valid) };
}

function importEvidence(snapshot, root, asOf, companyName = COMPANY) {
  if (!Array.isArray(snapshot?.records)) throw new Error('请选择公司证据库 records 快照 JSON');
  const seen = new Set();
  let excluded = 0;
  const items = [];
  for (const row of snapshot.records) {
    if (row.companyId && row.companyId !== companyName) { excluded += 1; continue; }
    if (!['performance', 'qualification', 'company_certificate', 'certificate'].includes(row.kind)) continue;
    const id = clean(row.id);
    if (!id || seen.has(id)) throw new Error('证据台账存在缺失或重复的材料编号，请修正快照');
    seen.add(id);
    const reasons = [];
    if (row.companyId !== companyName || row.verified !== true) reasons.push('公司归属待核实');
    const checked = verifyAttachments(row.attachments, root);
    if (!checked.valid) reasons.push('原件或 SHA256 核验待核实');
    const certificate = row.kind !== 'performance';
    const validUntil = clean(row.expires_on);
    const permanent = row.permanent === true || row.permanent === 1;
    if (certificate && !permanent && (!/^\d{4}-\d{2}-\d{2}$/.test(validUntil) || validUntil < asOf)) reasons.push('证书有效期待核实');
    if (row.kind === 'certificate') {
      const employment = snapshot.employmentEvidence?.[row.name];
      const employmentCheck = verifyAttachments(employment?.attachments, root);
      if (employment?.companyId !== companyName || employment?.verified !== true || !employmentCheck.valid) reasons.push('人员任职归属证据待核实');
      checked.files.push(...employmentCheck.files);
    }
    items.push({ id, kind: row.kind, name: clean(row.name), certificateName: clean(row.cert_name),
      companyId: clean(row.companyId), tags: clean([row.category, row.tags, row.specialty].filter(Boolean).join(' ')),
      validUntil, permanent, eligible: !reasons.length, reason: reasons.join('；'),
      confirmed: false, requirementIds: [], files: checked.files,
      details: Object.fromEntries(['client', 'event_date', 'cert_number', 'level'].filter(key => clean(row[key])).map(key => [key, clean(row[key])])) });
  }
  return { items, excluded };
}

function candidateScore(item, requirement) {
  const query = compact(requirement.title);
  const text = `${item.name} ${item.certificateName} ${item.tags}`;
  const tokens = Array.from({ length: Math.max(0, query.length - 1) }, (_, index) => query.slice(index, index + 2));
  return [...new Set(tokens)].reduce((score, token) => score + (text.includes(token) ? 1 : 0), 0);
}

function buildDraft(state) {
  if (!state.analysisConfirmed || !state.analysis) throw new Error('请先人工确认商务要求与候选材料');
  state = { ...state, fieldValues: resolveBusinessValues(state) };
  const companyName = state.companyName || COMPANY;
  const a = { ...mergeAnalysis([]), ...state.analysis };
  const selected = (state.evidence || []).filter(item => item.eligible && item.confirmed && item.companyId === companyName);
  const pending = [];
  const addPending = (label, reason, source = '') => pending.push({ label, reason, source });
  const value = (id, label) => {
    const result = clean(state.fieldValues?.[id]);
    if (!result) addPending(label, '待核实并填写');
    return result || `【待核实：${label}】`;
  };
  const project = clean(state.projectName) || '【待核实：项目名称】';
  if (!clean(state.projectName)) addPending('项目名称', '待核实并填写');
  const purchaser = value('purchaser', '采购人');
  const projectNo = value('projectNo', '项目编号');
  const representative = value('representative', '法定代表人姓名');
  const delegate = value('delegate', '授权代理人姓名');
  const date = value('date', '落款日期');
  const sections = [];
  const add = (title, content) => sections.push({ id: `business-${sections.length + 1}`, title, content });
  add('编制说明与商务目录', `本文件为 ${companyName} 的商务标草稿，需逐项核对招标文件原始格式。未填写及未核实内容不得作为已满足条件的依据。\n\n项目：${project}\n\n招标目录提取：\n\n${a.directory.length ? table(['目录项', '原文依据'], a.directory.map(item => [item.title, provenance(item)])) : '【待核实：未提取到商务目录，请核对原文】'}\n\n报价、签章和最终投标提交由人工完成。`);
  add('投标函', `致：${purchaser}\n\n项目名称：${project}\n\n项目编号：${projectNo}\n\n投标人：${companyName}\n\n我方拟参与本项目投标。招标要求的承诺、投标有效期、服务期限及具体响应内容：【待核实：由授权人员核对招标文件后填写并确认】。\n\n投标报价：【待人工填写】\n\n法定代表人或授权代理人签字：【待人工签署】\n\n投标人盖章：【待人工盖章】\n\n日期：${date}`);
  add('法定代表人身份证明', `单位名称：${companyName}\n\n法定代表人姓名：${representative}\n\n职务、身份证件号码：【待核实】\n\n证明正文：【待核实：按招标格式填写，审核身份及任职证明后确认】\n\n身份证件复印件：【待补资料】\n\n单位盖章：【待人工盖章】\n\n日期：${date}`);
  add('授权委托书', `委托人：${companyName}\n\n法定代表人：${representative}\n\n受托人：${delegate}\n\n授权项目：${project}（${projectNo}）\n\n授权事项、权限、期限及是否允许转委托：【待核实：由公司授权人审定】\n\n双方身份证明及任职材料：【待补资料】\n\n委托人、受托人签字及单位盖章：【待人工完成】\n\n日期：${date}`);
  add('资格资料及要求对照', table(['资格要求', '候选材料（已人工选用）', '复核状态', '招标依据'], a.qualifications.map(req => {
    const matches = selected.filter(item => item.requirementIds.includes(req.id));
    if (!matches.length) addPending(req.title, '未确认对应公司材料', provenance(req));
    return [req.title, matches.map(item => `${item.name}（${item.id}）`).join('；') || '【待核实】', '待人工核实是否满足本项目条件', provenance(req)];
  })) || '【待核实】');
  for (const [title, kinds] of [['企业资质资料', ['qualification', 'company_certificate']], ['人员资料', ['certificate']], ['项目业绩资料', ['performance']]]) {
    const materials = selected.filter(item => kinds.includes(item.kind));
    if (!materials.length) addPending(title, '暂无归属核验通过且人工选用的材料');
    add(title, materials.length ? materials.map(item => `### ${item.name}\n\n主体：${companyName}\n\n${item.certificateName ? `证书：${item.certificateName}\n\n` : ''}材料编号：${item.id}\n\n${Object.entries(item.details || {}).map(([key, val]) => `${({ client: '客户', event_date: '日期', cert_number: '证书编号', level: '等级' })[key]}：${val}`).join('\n\n')}\n\n原件索引：\n\n${table(['文件', 'SHA256'], item.files.map(file => [file.name, file.sha256]))}\n\n【待补资料：按招标格式装订上述原件/扫描件，本索引不能替代证明文件】`).join('\n\n') : '【待核实：暂无可使用的公司材料】');
    for (const item of materials) addPending(`${item.name}原件/扫描件`, '需人工按招标格式装订，当前 DOCX 仅含材料索引', item.id);
  }
  add('商务偏离表', table(['序号', '招标商务条款', '投标响应', '偏离情况', '依据'], a.terms.map((item, index) => [index + 1, item.title, '【待核实：人工填写】', '【待核实：不得默认无偏离】', provenance(item)])));
  for (const item of a.terms) addPending(item.title, '商务响应及偏离情况待人工确认', provenance(item));
  add('政策声明', `投标人：${companyName}\n\n中小企业、监狱企业、残疾人福利性单位、信用及其他政策身份：【待核实】\n\n声明正文及适用的政策条款：【待核实：按招标原始表单填写，核验身份依据后由授权人确认】\n\n不因材料缺失自动声明符合政策条件。\n\n签字及盖章：【待人工完成】`);
  add('招标表单字段', table(['所属表单', '字段', '填写内容', '原文依据'], a.fields.map(item => [item.section || '待核实', item.title, isReviewerField(item) ? '【由采购人或评审人员填写】' : isPricingField(item) ? '【待人工填写：报价】' : isSigningField(item) ? '【待人工签字盖章】' : value(item.id, item.title), provenance(item)])));
  const pricing = a.fields.filter(isPricingField);
  add('报价表（仅结构）', `${table(['序号', '项目/字段', '单位', '数量', '单价', '合价'], (pricing.length ? pricing : [{ title: '分项报价' }]).map((item, i) => [i + 1, item.title, '待填写', '待填写', '待填写', '待填写']))}\n\n投标总价（大写）：【待人工填写】\n\n投标总价（小写）：【待人工填写】\n\n本版不填入或计算任何报价。`);
  add('废标项复核表', table(['废标项', '核对状态', '原文依据'], a.disqualifications.map(item => [item.title, '【待核实：须逐项人工核对】', provenance(item)])));
  for (const item of a.disqualifications) addPending(item.title, '废标项待逐项人工复核', provenance(item));
  for (const group of GROUPS) if (!a[group].length) addPending(({ directory: '商务目录', qualifications: '资格要求', disqualifications: '废标项', fields: '表单字段', terms: '商务条款' })[group], '未提取到条目，须核对是否漏提');
  for (const label of ['投标函承诺及有效期', '身份证明及授权原件', '政策身份与声明依据', '报价表人工填写及复核', '招标原始格式与附件装订', '最终签字盖章及人工投标提交']) addPending(label, '待人工完成');
  const pendingMarkdown = table(['待补/待核实项目', '原因及处理', '来源'], pending.map(item => [item.label, item.reason, item.source]));
  return { sections, pending, pendingTitle: '待补资料清单', pendingMarkdown, generatedAt: new Date().toISOString() };
}

module.exports = { COMPANY, GROUPS, hash, businessDate, isPricingField, normalizeAnalysis, mergeAnalysis, importEvidence, candidateScore, buildDraft };
