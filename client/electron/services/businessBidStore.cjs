const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { getBusinessBidDir } = require('../utils/paths.cjs');
const { COMPANY, hash, businessDate, importEvidence, buildDraft, isPricingField, candidateScore } = require('./businessBidDomain.cjs');
const { buildBusinessForm, applyBusinessFormValues, companyProfileValues, resolveBusinessValues } = require('./businessBidForms.cjs');
const { inspectBusinessTemplate } = require('./businessBidTemplate.cjs');

function emptyState() {
  return { companyName: COMPANY, companyNames: [COMPANY, '贵州云界科创信息技术有限公司'], projectName: '', deadline: '', files: [], evidence: [], excludedEvidence: 0,
    analysis: null, analysisComplete: false, analysisConfirmed: false, analysisTask: null, analysisCoverage: null,
    fieldValues: {}, companyProfiles: {}, wordTemplate: null, textModelSelection: null, draft: null };
}

function createBusinessBidStore({ app, db, fileService }) {
  const root = getBusinessBidDir(app);
  let importing = false;
  const loadBusinessBid = () => {
    const state = { ...emptyState(), ...JSON.parse(db.prepare('SELECT state_json FROM business_bid_workspace WHERE id = 1').get()?.state_json || '{}') };
    state.evidence = state.evidence.map(item => ({ ...item, suggestedRequirementIds: (state.analysis?.qualifications || [])
      .map(requirement => ({ id: requirement.id, score: candidateScore(item, requirement) })).filter(match => match.score > 0)
      .sort((a, b) => b.score - a.score).slice(0, 5).map(match => match.id) }));
    state.formPlan = buildBusinessForm(state);
    return state;
  };
  const updateBusinessBidWithoutReload = db.transaction((patch) => {
    const next = { ...loadBusinessBid(), ...patch };
    delete next.formPlan;
    db.prepare('INSERT INTO business_bid_workspace(id, state_json, updated_at) VALUES(1, ?, ?) ON CONFLICT(id) DO UPDATE SET state_json=excluded.state_json, updated_at=excluded.updated_at')
      .run(JSON.stringify(next), new Date().toISOString());
  });
  const save = (patch) => { updateBusinessBidWithoutReload(patch); return loadBusinessBid(); };
  function assertIdle() {
    if (importing || ['running', 'pausing'].includes(loadBusinessBid().analysisTask?.status)) throw new Error('商务标正在处理文件或提取要求，请完成后再修改');
  }
  function asOf(state) {
    return [businessDate(), state.deadline || ''].sort().at(-1);
  }
  function verifySelected(state) {
    for (const file of state.files) {
      if (!fs.existsSync(file.markdownPath) || hash(fs.readFileSync(file.markdownPath, 'utf8')) !== file.sha256) throw new Error('招标原文发生变化或缺失，请重新上传并提取');
    }
    for (const item of state.evidence.filter(value => value.confirmed)) {
      if (item.companyId !== state.companyName) throw new Error('所选材料不属于当前公司主体，请重新导入核实');
      if (!item.eligible) throw new Error('所选材料归属或原件待核实，请重新导入证据台账');
      if (item.kind !== 'performance' && !item.permanent && item.validUntil < asOf(state)) throw new Error('所选证书在投标截止日前已过期，请重新核实材料');
      for (const file of item.files) {
        if (!fs.existsSync(file.sourcePath) || hash(fs.readFileSync(file.sourcePath)) !== file.sha256) throw new Error('所选证据原件发生变化或缺失，请重新导入核实');
      }
    }
  }
  return {
    loadBusinessBid, updateBusinessBidWithoutReload, assertIdle,
    readSource(id) {
      const file = loadBusinessBid().files.find(item => item.id === id);
      if (!file) throw new Error('未找到招标原文');
      const text = fs.readFileSync(file.markdownPath, 'utf8');
      if (hash(text) !== file.sha256) throw new Error('招标原文发生变化，请重新上传');
      if (!text.trim()) throw new Error(`文件“${file.name}”解析原文为空，请检查解析方式或重新上传可读取的文件`);
      return text;
    },
    async importDocuments(filePaths) {
      assertIdle(); importing = true;
      try {
        const result = await fileService.importTechnicalPlanDocument('商务标招标文件', { multiple: true, filePaths, assetScopePrefix: 'business-bid' });
        if (!result.success) return { state: loadBusinessBid(), message: result.message, success: false };
        fs.mkdirSync(root, { recursive: true });
        const files = [...loadBusinessBid().files];
        for (const document of result.documents) {
          const sha256 = hash(document.file_content);
          const existing = files.find(file => file.sha256 === sha256);
          if (existing) {
            // 重传相同原件也应能修复被移动或改坏的解析缓存。
            fs.writeFileSync(existing.markdownPath, document.file_content, 'utf8');
            continue;
          }
          const id = randomUUID();
          const markdownPath = path.join(root, `${id}.md`);
          fs.writeFileSync(markdownPath, document.file_content, 'utf8');
          files.push({ id, name: document.file_name, markdownPath, sha256, chars: document.file_content.length, parserLabel: document.parser_label });
        }
        const state = save({ files, analysis: null, analysisComplete: false, analysisConfirmed: false, analysisTask: null,
          analysisCoverage: null, draft: null, fieldValues: {}, evidence: loadBusinessBid().evidence.map(item => ({ ...item, confirmed: false, requirementIds: [] })) });
        return { state, success: true, message: [result.message, ...(result.errors || [])].join('\n') };
      } finally { importing = false; }
    },
    importEvidenceFile(filePath) {
      assertIdle();
      const snapshot = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const current = loadBusinessBid();
      const result = importEvidence(snapshot, path.dirname(filePath), asOf(current), current.companyName);
      const dir = path.join(root, 'evidence', randomUUID());
      fs.mkdirSync(dir, { recursive: true });
      // 复制已核验原件，使用户移动台账目录后仍可复核；不保存整份私人台账快照。
      for (const item of result.items) {
        item.files = item.files.filter(file => file.valid).map((file) => {
          const destination = path.join(dir, `${file.sha256}${path.extname(file.name)}`);
          fs.copyFileSync(file.sourcePath, destination);
          return { name: file.name, sha256: file.sha256, sourcePath: destination, valid: true };
        });
      }
      return save({ evidence: result.items, excludedEvidence: result.excluded, draft: null });
    },
    saveReview(payload) {
      assertIdle();
      const state = loadBusinessBid();
      if (Object.hasOwn(payload, 'companyName')) {
        if (typeof payload.companyName !== 'string' || payload.companyName.trim().length < 2 || payload.companyName.trim().length > 120 || /[\r\n\t]/.test(payload.companyName)) throw new Error('请填写 2–120 字的完整公司名称，不包含换行');
        const companyName = payload.companyName.trim();
        if (companyName === state.companyName) return state;
        return save({ companyName, companyNames: [...new Set([...state.companyNames, companyName])],
          evidence: [], excludedEvidence: 0, fieldValues: { ...state.companyProfiles[companyName] }, draft: null, analysisConfirmed: false });
      }
      const patch = {};
      for (const key of ['projectName', 'deadline', 'textModelSelection']) if (Object.hasOwn(payload, key)) patch[key] = payload[key];
      if (payload.fieldValues) {
        patch.fieldValues = applyBusinessFormValues({ ...state, ...patch }, payload.fieldValues);
        patch.companyProfiles = { ...state.companyProfiles, [state.companyName]: {
          ...state.companyProfiles[state.companyName], ...companyProfileValues(patch.fieldValues) } };
      }
      if (payload.evidence) {
        const validIds = new Set((state.analysis?.qualifications || []).map(item => item.id));
        patch.evidence = state.evidence.map(item => {
          const selection = payload.evidence.find(value => value.id === item.id);
          return selection ? { ...item, confirmed: item.eligible && selection.confirmed === true, requirementIds: selection.requirementIds.filter(id => validIds.has(id)) } : item;
        });
      }
      if (Object.hasOwn(payload, 'analysisConfirmed')) {
        if (payload.analysisConfirmed && !state.analysisComplete) throw new Error('商务要求尚未完整提取，不能确认');
        patch.analysisConfirmed = payload.analysisConfirmed;
      }
      if (Object.hasOwn(payload, 'deadline') && payload.deadline !== state.deadline) {
        patch.evidence = (patch.evidence || state.evidence).map(item => ({ ...item, confirmed: false }));
      }
      return save({ ...patch, draft: null });
    },
    generateDraft() {
      assertIdle();
      const state = loadBusinessBid();
      verifySelected(state);
      const draft = buildDraft(state);
      return save({ draft });
    },
    importTemplate(filePath) {
      assertIdle();
      if (path.extname(filePath).toLowerCase() !== '.docx') throw new Error('请选择 .docx Word 模板');
      const buffer = fs.readFileSync(filePath);
      const { fields } = inspectBusinessTemplate(buffer);
      fs.mkdirSync(root, { recursive: true });
      const templatePath = path.join(root, `${randomUUID()}.docx`);
      fs.writeFileSync(templatePath, buffer);
      const state = loadBusinessBid();
      const fieldValues = Object.fromEntries(Object.entries(state.fieldValues).filter(([key]) => !key.startsWith('template:')));
      return save({ wordTemplate: { name: path.basename(filePath), path: templatePath, sha256: hash(buffer), fields }, fieldValues, draft: null });
    },
    clearTemplate() {
      assertIdle();
      const fieldValues = Object.fromEntries(Object.entries(loadBusinessBid().fieldValues).filter(([key]) => !key.startsWith('template:')));
      return save({ wordTemplate: null, fieldValues, draft: null });
    },
    getExportPayload(kind) {
      assertIdle();
      const state = loadBusinessBid();
      if (!state.draft) throw new Error('请先生成商务标草稿');
      verifySelected(state);
      const checklist = { id: 'business-pending', title: '待补资料清单', content: state.draft.pendingMarkdown };
      const payload = { project_name: `${state.projectName || state.companyName}_${kind === 'pending' ? '待补资料清单' : '商务标草稿'}`, table_pagination: 'keep-rows', outline: kind === 'pending' ? [checklist] : [...state.draft.sections, checklist] };
      if (kind === 'template') {
        const template = state.wordTemplate;
        if (!template || !fs.existsSync(template.path)) throw new Error('请先导入 Word 模板');
        const buffer = fs.readFileSync(template.path);
        if (hash(buffer) !== template.sha256) throw new Error('Word 模板已变化，请重新导入');
        const values = resolveBusinessValues(state);
        payload.business_template = { buffer, values: Object.fromEntries(template.fields.map(field => [field, values[`template:${field}`] || ''])) };
      }
      return payload;
    },
    clear() { assertIdle(); const state = loadBusinessBid(); return save({ ...emptyState(), companyName: state.companyName, companyNames: state.companyNames, companyProfiles: state.companyProfiles, fieldValues: { ...state.companyProfiles[state.companyName] }, textModelSelection: state.textModelSelection }); },
  };
}
module.exports = { createBusinessBidStore };
