// 隔离的合成验收：真实 Electron / SQLite / 文件解析 / 任务管理 / DOCX，无真实模型请求。
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');
const { createSqliteDatabase } = require('../electron/services/sqliteDatabase.cjs');
const { createBusinessBidStore } = require('../electron/services/businessBidStore.cjs');
const { createFileService } = require('../electron/services/fileService.cjs');
const { createTaskService } = require('../electron/services/taskService.cjs');
const { createExportService, buildDocxBuffer } = require('../electron/services/exportService.cjs');
const { registerBusinessBidIpc } = require('../electron/ipc/businessBidIpc.cjs');
const { registerTaskIpc } = require('../electron/ipc/taskIpc.cjs');
const { hash } = require('../electron/services/businessBidDomain.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), '易标商务标验收-'));
app.setPath('userData', root);
app.disableHardwareAcceleration();
const output = process.env.BUSINESS_BID_SMOKE_OUTPUT ? path.resolve(process.env.BUSINESS_BID_SMOKE_OUTPUT) : root;
let db;
let window;
let checks = 0;
function check(condition, message) { assert.ok(condition, message); checks += 1; }
const source = '# 商务文件\n1. 投标函\n2. 授权书\n资格要求：提供医院信息化业绩。\n废标条款：未签字盖章投标无效。\n表单：联系人；投标总价。\n付款条件：验收后30日付款。';
const requirement = (title, quote = title) => ({ title, quote, section: '商务文件', kind: 'text' });
let modelContext;
let modelCalls = 0;
let delayModel;
let modelDiscoveryAvailable = true;
const configStore = { load: () => ({ components: { file_parser: { provider: 'local' } } }) };
const aiService = { withRequestContext(context) {
  modelContext = context;
  return { getConfig: () => ({ context_length_limit: 32000 }), async requestJson() {
    modelCalls += 1;
    if (delayModel) await delayModel;
    return { directory: [requirement('投标函')], qualifications: [requirement('医院信息化业绩')],
      disqualifications: [requirement('未签字盖章投标无效')], fields: [requirement('联系人'), requirement('投标总价')], terms: [requirement('验收后30日付款')] };
  } };
} };
const fileService = createFileService({ app, configStore });
function makeTasks(store) {
  return createTaskService({ businessBidStore: store, aiService, agentService: { bindTaskContext: () => ({}) },
    autoConfirmationService: { unregister() {} }, technicalPlanStore: { loadTechnicalPlan: () => ({}) },
    rejectionCheckStore: { loadRejectionCheck: () => ({}) }, duplicateCheckStore: { loadDuplicateCheck: () => ({}) } });
}
async function until(predicate) {
  const end = Date.now() + 15000;
  while (!await predicate()) { if (Date.now() > end) throw Error('等待验收状态超时'); await new Promise(resolve => setTimeout(resolve, 30)); }
}

app.whenReady().then(async () => {
  fs.mkdirSync(output, { recursive: true });
  db = createSqliteDatabase(app);
  check(db.db.pragma('user_version', { simple: true }) === 25, 'migration v25');
  db.db.exec("DROP TABLE business_bid_workspace; CREATE TABLE business_smoke_legacy(value TEXT); INSERT INTO business_smoke_legacy VALUES ('preserved'); PRAGMA user_version=24;");
  db.close(); db = createSqliteDatabase(app);
  check(db.db.pragma('user_version', { simple: true }) === 25 && db.db.prepare('SELECT value FROM business_smoke_legacy').get().value === 'preserved', '已有 v24 工作区迁移且保留数据');
  const store = createBusinessBidStore({ app, db: db.db, fileService });
  const input = path.join(root, '合成招标文件.md');
  fs.writeFileSync(input, source, 'utf8');
  const imported = await store.importDocuments([input]);
  check(imported.success && store.readSource(imported.state.files[0].id).includes('医院信息化业绩'), '实际解析与中文路径');
  assert.throws(() => store.generateDraft(), /确认/); checks += 1;
  const selection = { provider: 'custom', modelName: 'synthetic', label: '合成验收模型' };
  store.saveReview({ textModelSelection: selection });
  const tasks = makeTasks(store);
  let release;
  delayModel = new Promise(resolve => { release = resolve; });
  tasks.startBusinessBidAnalysis();
  check(store.loadBusinessBid().analysisTask.status === 'running', '持久化 running');
  assert.throws(() => store.clear(), /正在/); checks += 1;
  assert.throws(() => store.saveReview({ projectName: '不能写入' }), /正在/); checks += 1;
  assert.throws(() => store.saveReview({ companyName: '贵州云界科创信息技术有限公司' }), /正在/); checks += 1;
  release(); delayModel = null;
  await until(() => store.loadBusinessBid().analysisTask.status === 'success');
  check(modelContext.textModelSelection.modelName === 'synthetic', '任务模型传递');
  check(store.loadBusinessBid().analysisComplete, '完成分析');
  const reload = createBusinessBidStore({ app, db: db.db, fileService });
  check(reload.loadBusinessBid().analysis.qualifications.length === 1, '重新打开 Store 恢复要求');
  const analysis = reload.loadBusinessBid().analysis;
  const priceId = analysis.fields.find(item => item.kind === 'pricing').id;
  store.saveReview({ projectName: '合成验收 非真实投标', analysisConfirmed: true,
    fieldValues: { purchaser: '合成采购方', [priceId]: '99999999元' } });
  check(!store.loadBusinessBid().fieldValues[priceId], '报价字段保存强制留空');
  const original = path.join(root, '合成业绩原件.txt');
  fs.writeFileSync(original, '合成医院信息化业绩原件，非真实公司材料', 'utf8');
  const evidenceFile = path.join(root, '合成台账.json');
  fs.writeFileSync(evidenceFile, JSON.stringify({ records: [{ id: 'synthetic-1', name: '合成医院信息化业绩', kind: 'performance',
    companyId: '隆创信息有限公司', verified: true, attachments: [{ relative_path: path.basename(original), sha256: hash(fs.readFileSync(original)), verified: true }] }] }), 'utf8');
  store.importEvidenceFile(evidenceFile);
  check(store.loadBusinessBid().evidence[0].suggestedRequirementIds.includes(analysis.qualifications[0].id), '候选材料匹配');
  check(store.loadBusinessBid().evidence[0].confirmed === false, '不自动确认公司材料');
  store.saveReview({ evidence: [{ id: 'synthetic-1', confirmed: true, requirementIds: [analysis.qualifications[0].id] }] });
  store.generateDraft();
  const storedSource = store.loadBusinessBid().files[0].markdownPath;
  const savedSource = fs.readFileSync(storedSource, 'utf8');
  fs.writeFileSync(storedSource, '已修改的招标原文', 'utf8');
  assert.throws(() => store.getExportPayload('full'), /原文/); checks += 1;
  const beforeInvalidStart = store.loadBusinessBid();
  assert.throws(() => tasks.startBusinessBidAnalysis(), /原文/); checks += 1;
  check(JSON.stringify(store.loadBusinessBid()) === JSON.stringify(beforeInvalidStart), '原文预检失败不清空已提取要求、表单和草稿');
  fs.writeFileSync(storedSource, savedSource, 'utf8');
  const fullPayload = store.getExportPayload('full');
  const full = await buildDocxBuffer(fullPayload);
  const pending = await buildDocxBuffer(store.getExportPayload('pending'));
  const text = new AdmZip(full).readAsText('word/document.xml');
  check(text.includes('w:cantSplit') && text.includes('w:tblHeader'), '商务表格行不跨页拆分且续页重复表头');
  check(text.includes('w:keepNext'), '商务章节标题与表格表头跟随下文');
  for (const expected of ['投标函', '法定代表人身份证明', '授权委托书', '资格资料', '人员资料', '项目业绩资料', '商务偏离表', '政策声明', '报价表', '待补资料清单', '合成医院信息化业绩']) check(text.includes(expected), `DOCX 章节 ${expected}`);
  check(!text.includes('99999999'), '导出不含报价值');
  fs.writeFileSync(path.join(output, '商务标合成验收.docx'), full);
  fs.writeFileSync(path.join(output, '待补清单合成验收.docx'), pending);
  const copy = store.loadBusinessBid().evidence[0].files[0].sourcePath;
  fs.writeFileSync(copy, '原件发生变化', 'utf8');
  assert.throws(() => store.getExportPayload('full'), /原件/); checks += 1;
  fs.copyFileSync(original, copy);
  store.saveReview({ projectName: '修订后的合成项目' });
  check(store.loadBusinessBid().draft === null, '人工修改使草稿失效');
  store.generateDraft();
  const persistedTask = store.loadBusinessBid().analysisTask;
  store.updateBusinessBidWithoutReload({ analysisTask: { ...persistedTask, status: 'running' } });
  makeTasks(store);
  check(store.loadBusinessBid().analysisTask.status === 'error' && !store.loadBusinessBid().analysisConfirmed && !store.loadBusinessBid().draft, '进程重启中断任务失效');
  store.updateBusinessBidWithoutReload({ analysisTask: persistedTask, analysisComplete: true, analysisConfirmed: true });
  store.generateDraft();

  if (process.env.BUSINESS_BID_SMOKE_UI_URL) {
    registerBusinessBidIpc({ businessBidStore: store, taskService: tasks, exportService: createExportService({ configStore }) });
    registerTaskIpc({ taskService: tasks });
    ipcMain.handle('config:list-selectable-text-models', () => [
      { ...selection, id: 'custom:synthetic', source: 'configured', recommended: false },
      ...(modelDiscoveryAvailable ? ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6-astra'] : []).map(modelName => ({ provider: 'custom', modelName, id: `custom:${modelName}`, label: `Codex · ${modelName}`, source: 'codex', recommended: modelName === 'gpt-5.6-terra' })),
    ]);
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path.join(output, '商务标界面导出.docx') });
    window = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { preload: path.resolve(__dirname, '../electron/preload.cjs'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
    await window.loadURL(process.env.BUSINESS_BID_SMOKE_UI_URL);
    const js = async script => {
      try { return await window.webContents.executeJavaScript(script); }
      catch (error) { throw new Error(`页面验收脚本失败：${script}`, { cause: error }); }
    };
    await until(() => js("Boolean(document.querySelector('.secondary-menu-row'))"));
    await js("[...document.querySelectorAll('.secondary-menu-row')].find(b => b.querySelector('strong').textContent === '商务标').click()");
    await until(() => js("Boolean(document.querySelector('.business-bid-header')) || document.body.innerText.includes('正在开发中')"));
    check(await js("Boolean(document.querySelector('.business-bid-header')) && !document.body.innerText.includes('正在开发中')"), '从标书生成首页点击商务标进入工作台，不显示开发中提示');
    await until(() => js("Boolean(document.querySelector('.business-bid-page .business-bid-header'))"));
    await until(() => js("document.querySelector('select[aria-label=本商务标使用模型]').selectedOptions[0]?.textContent.includes('合成验收模型')"));
    check(await js("['custom:gpt-5.6-terra', 'custom:gpt-5.6-luna', 'custom:gpt-6-astra'].every(value => [...document.querySelector('select[aria-label=本商务标使用模型]').options].some(option => option.value === value))"), 'GPT-5 与 GPT-6 可选');
    await js("document.querySelector('select[aria-label=本商务标使用模型]').value = 'custom:gpt-5.6-terra'; document.querySelector('select[aria-label=本商务标使用模型]').dispatchEvent(new Event('change', { bubbles: true }))");
    await until(() => store.loadBusinessBid().textModelSelection.modelName === 'gpt-5.6-terra');
    modelDiscoveryAvailable = false;
    await window.loadURL(process.env.BUSINESS_BID_SMOKE_UI_URL);
    await until(() => js("Boolean(document.querySelector('.secondary-menu-row'))"));
    await js("[...document.querySelectorAll('.secondary-menu-row')].find(b => b.querySelector('strong').textContent === '商务标').click()");
    await until(() => js("Boolean(document.querySelector('select option[value=\"custom:synthetic\"]'))"));
    check(await js("document.querySelector('select[aria-label=本商务标使用模型]')?.selectedOptions[0]?.value === 'custom:gpt-5.6-terra'"), '桥接模型发现暂不可用时重进页面仍显示已保存的模型');
    modelDiscoveryAvailable = true;
    check(store.loadBusinessBid().draft === null, '切换模型后旧草稿失效');
    await js("[...document.querySelectorAll('button')].find(b => b.textContent === '生成商务标草稿').click()");
    await until(() => js("Boolean([...document.querySelectorAll('button')].find(b => b.textContent === '导出整本 DOCX'))"));
    check(await js("document.body.innerText.includes('商务标编制工作台')"), '真实页面已加载');
    check(await js("document.querySelector('.business-bid-page').scrollHeight > document.querySelector('.business-bid-page').clientHeight"), '页面内部滚动');
    check(await js("[...document.querySelectorAll('input')].some(i => i.placeholder.includes('报价与签章由人工') && i.disabled && !i.value)"), '报价输入禁用');
    await js("[...document.querySelectorAll('button')].find(b => b.textContent === '导出整本 DOCX').click()");
    await until(() => fs.existsSync(path.join(output, '商务标界面导出.docx')));
    check(true, '真实 preload/IPC/DOCX 导出');
    await js("const el=[...document.querySelectorAll('.business-bid-form label')].find(l=>l.textContent.startsWith('法定代表人姓名')).querySelector('input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'界面合成法人'); el.dispatchEvent(new Event('input',{bubbles:true}));");
    await until(()=>js("![...document.querySelectorAll('button')].find(b=>b.textContent==='保存表单').disabled"));
    await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='保存表单').click()");
    await until(()=>store.loadBusinessBid().companyProfiles[store.loadBusinessBid().companyName]?.representative==='界面合成法人');
    check(true,'界面一次填写保存公司档案');
    const uiTemplate = path.join(root,'界面合成模板.docx');
    fs.writeFileSync(uiTemplate,await buildDocxBuffer({project_name:'合成模板',outline:[{id:'template',title:'模板验收',content:'公司：{公司名称}\n\n法人：{法定代表人姓名}\n\n金额：{投标总价}'}]}));
    dialog.showOpenDialog = async()=>({canceled:false,filePaths:[uiTemplate]});
    await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='导入 Word 模板').click()");
    await until(()=>store.loadBusinessBid().wordTemplate?.fields.length===3);
    check(store.loadBusinessBid().formPlan.fields.find(f=>f.key==='representative').occurrences===2,'模板标签复用已填法人');
    await until(()=>js("![...document.querySelectorAll('button')].find(b=>b.textContent==='生成商务标草稿').disabled"));
    await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='生成商务标草稿').click()");
    await until(()=>js("Boolean([...document.querySelectorAll('button')].find(b=>b.textContent==='按 Word 模板导出'))"));
    const templateExport = path.join(output,'商务模板界面导出.docx');
    dialog.showSaveDialog=async()=>({canceled:false,filePath:templateExport});
    await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='按 Word 模板导出').click()");
    await until(()=>fs.existsSync(templateExport));
    const renderedTemplate = new AdmZip(templateExport).readAsText('word/document.xml');
    check(renderedTemplate.includes('界面合成法人') && renderedTemplate.includes('隆创信息有限公司') && renderedTemplate.includes('待人工填写'),'真实界面导入模板与导出填充');
    await js("document.querySelectorAll('button[aria-label=\"关闭提示\"]').forEach(button=>button.click())");
    await new Promise(resolve=>setTimeout(resolve,400));
    fs.writeFileSync(path.join(output, '商务标页面.png'), (await window.webContents.capturePage()).toPNG());
    await js("const formHead=[...document.querySelectorAll('.business-bid-section h3')].find(h=>h.textContent.includes('常用信息一次填写')); const page=document.querySelector('.business-bid-page'); page.scrollTop += formHead.getBoundingClientRect().top - page.getBoundingClientRect().top - 30;");
    await until(()=>js("[...document.querySelectorAll('.business-bid-section h3')].find(h=>h.textContent.includes('常用信息一次填写')).getBoundingClientRect().top < 150"));
    await new Promise(resolve=>setTimeout(resolve,600));
    fs.writeFileSync(path.join(output, '商务标少填表.png'), (await window.webContents.capturePage()).toPNG());
    await js("document.querySelector('.business-bid-page').scrollTop = document.querySelector('.business-bid-page').scrollHeight");
    await until(() => js("document.querySelector('.business-bid-page').scrollTop > 200"));
    await new Promise(resolve => setTimeout(resolve, 150));
    fs.writeFileSync(path.join(output, '商务标预览.png'), (await window.webContents.capturePage()).toPNG());
    await js("[...document.querySelectorAll('button')].find(b => b.textContent === '开始新项目').click()");
    await until(() => js("Boolean(document.querySelector('[role=dialog]'))"));
    check(await js("document.querySelector('[role=dialog]').innerText.includes('已导出的 DOCX 保留')"), '新项目确认弹窗');
    await js("[...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent === '取消').click()");
    await js("[...document.querySelectorAll('button')].find(b => b.textContent === '重新提取商务要求').click()");
    await until(() => js("document.body.innerText.includes('商务要求提取完成') && [...document.querySelectorAll('button')].find(b => b.textContent === '生成商务标草稿').disabled"));
    await js("[...document.querySelectorAll('label')].find(l => l.textContent.includes('我已核对提取结果')).querySelector('input').click()");
    await until(() => js("![...document.querySelectorAll('button')].find(b => b.textContent === '生成商务标草稿').disabled"));
    await js("[...document.querySelectorAll('button')].find(b => b.textContent === '生成商务标草稿').click()");
    await until(() => js("Boolean([...document.querySelectorAll('button')].find(b => b.textContent === '导出整本 DOCX'))"));
    check(true, '真实页面提取、人工确认和草稿生成');
    check(modelContext.textModelSelection.modelName === 'gpt-5.6-terra', '下拉框选中的 GPT-5 模型传入后台提取任务');
    check(await js("[...document.querySelector('select[aria-label=\"公司主体\"]').options].some(option => option.value === '贵州云界科创信息技术有限公司')"), '公司下拉框包含用户指定主体');
    const chooseCompany = "document.querySelector('select[aria-label=\"公司主体\"]').value = '贵州云界科创信息技术有限公司'; document.querySelector('select[aria-label=\"公司主体\"]').dispatchEvent(new Event('change', { bubbles: true }))";
    await js(chooseCompany);
    await until(() => js("Boolean(document.querySelector('[role=dialog]'))"));
    await js("[...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent === '取消').click()");
    check(store.loadBusinessBid().companyName === '隆创信息有限公司' && store.loadBusinessBid().draft, '取消切换保留原主体与草稿');
    await js(chooseCompany);
    await until(() => js("Boolean(document.querySelector('[role=dialog]'))"));
    await js("[...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent === '确认切换').click()");
    await until(() => store.loadBusinessBid().companyName === '贵州云界科创信息技术有限公司');
    check(!store.loadBusinessBid().draft && store.loadBusinessBid().analysisComplete, '实际页面切换主体保留提取结果并清除旧草稿');
  }
  const companyBefore = store.loadBusinessBid();
  check(JSON.stringify(store.saveReview({ companyName: companyBefore.companyName })) === JSON.stringify(companyBefore), '重复选择当前主体不清空数据');
  const companyChanged = store.saveReview({ companyName: '合成乙公司（验收）' });
  check(companyChanged.companyName === '合成乙公司（验收）', '公司主体可以切换');
  check(companyChanged.companyNames.includes('隆创信息有限公司') && companyChanged.companyNames.includes('合成乙公司（验收）'), '公司主体列表持久化');
  check(JSON.stringify(companyChanged.files) === JSON.stringify(companyBefore.files) && JSON.stringify(companyChanged.analysis) === JSON.stringify(companyBefore.analysis) && companyChanged.analysisComplete, '切换主体保留招标文件与完整提取结果');
  check(!companyChanged.draft && !companyChanged.analysisConfirmed && !companyChanged.evidence.length && !Object.keys(companyChanged.fieldValues).length, '切换主体清除旧材料、字段、确认和草稿');
  assert.throws(() => store.saveReview({ companyName: '  ' }), /公司/); checks += 1;
  store.importEvidenceFile(evidenceFile);
  check(store.loadBusinessBid().evidence.length === 0 && store.loadBusinessBid().excludedEvidence === 1, '新主体导入旧公司材料会排除');
  store.saveReview({ analysisConfirmed: true });
  store.generateDraft();
  const otherDoc = await buildDocxBuffer(store.getExportPayload('full'));
  const otherText = new AdmZip(otherDoc).readAsText('word/document.xml');
  check(otherText.includes('合成乙公司（验收）') && !otherText.includes('隆创信息有限公司'), '真实 DOCX 使用当前主体且不混入旧主体');
  fs.writeFileSync(path.join(output, '其他主体合成验收.docx'), otherDoc);
  const currentEvidence = store.loadBusinessBid().evidence;
  store.updateBusinessBidWithoutReload({ evidence: [{ id: 'foreign', companyId: '隆创信息有限公司', confirmed: true, eligible: true }] });
  assert.throws(() => store.generateDraft(), /当前公司主体/); checks += 1;
  assert.throws(() => store.getExportPayload('full'), /当前公司主体/); checks += 1;
  store.updateBusinessBidWithoutReload({ evidence: currentEvidence });
  check(createBusinessBidStore({ app, db: db.db, fileService }).loadBusinessBid().companyName === '合成乙公司（验收）', '重开工作区保留公司选择');
  store.clear();
  check(store.loadBusinessBid().companyName === '合成乙公司（验收）' && store.loadBusinessBid().companyNames.length === 3, '新项目保留公司列表和当前选择');
  await store.importDocuments([input]);
  const sourceToRepair = store.loadBusinessBid().files[0].markdownPath;
  fs.writeFileSync(sourceToRepair, '损坏的缓存', 'utf8');
  await store.importDocuments([input]);
  check(store.readSource(store.loadBusinessBid().files[0].id).includes('医院信息化业绩'), '重新上传相同文件恢复原文缓存');
  fs.writeFileSync(path.join(output, '验收结果.json'), JSON.stringify({ checks, modelCalls, synthetic: true, schemaVersion: 25 }, null, 2), 'utf8');
  console.log(JSON.stringify({ success: true, checks, modelCalls, output }));
  db.close(); window?.destroy(); app.exit(0);
}).catch(error => { console.error(error.stack); window?.destroy(); db?.close(); app.exit(1); });
