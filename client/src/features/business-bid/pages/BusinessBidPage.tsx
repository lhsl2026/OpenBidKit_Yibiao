import { useEffect, useRef, useState } from 'react';
import { AppDialog, MarkdownRenderer, MarkdownFullscreenViewer, useToast } from '../../../shared/ui';
import type { SelectableTextModel } from '../../../shared/types/config';
import type { BusinessAnalysis, BusinessBidReview, BusinessBidState, BusinessEvidence } from '../types';

const groupLabels: Record<keyof BusinessAnalysis, string> = { directory: '商务目录', qualifications: '资格要求', disqualifications: '废标项', fields: '表单字段', terms: '商务条款' };
const basics = { purchaser: '采购人', projectNo: '项目编号', representative: '法定代表人姓名', delegate: '授权代理人姓名', date: '落款日期' };

function BusinessBidPage() {
  const { showToast } = useToast();
  const [state, setState] = useState<BusinessBidState | null>(null);
  const [models, setModels] = useState<SelectableTextModel[]>([]);
  const [operation, setOperation] = useState('');
  const [loadError, setLoadError] = useState('');
  const [projectName, setProjectName] = useState('');
  const [deadline, setDeadline] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [query, setQuery] = useState('');
  const [onlyEligible, setOnlyEligible] = useState(true);
  const [resetOpen, setResetOpen] = useState(false);
  const [source, setSource] = useState<{ name: string; content: string } | null>(null);
  const [exportMessage, setExportMessage] = useState('');
  const exportId = useRef('');
  const [exportPath, setExportPath] = useState('');
  const busy = Boolean(operation) || state?.analysisTask?.status === 'running';
  const bridge = window.yibiao?.businessBid;
  const resetForm = (next: BusinessBidState) => { setProjectName(next.projectName); setDeadline(next.deadline); setFields(next.fieldValues); setDirty(false); };

  useEffect(() => {
    if (!bridge) { setLoadError('商务标桌面服务未就绪，请在易标桌面客户端打开。'); return; }
    let mounted = true;
    let unsubscribe = () => {};
    const load = async () => {
      try {
        const next = await bridge.load();
        if (!mounted) return;
        setState(next); resetForm(next);
        unsubscribe = window.yibiao.tasks.onTaskEvent(event => {
          if (event.businessBidPatch && mounted) setState(current => current ? { ...current, ...event.businessBidPatch } : current);
          if (event.task.type === 'business-bid-analysis' && event.task.status === 'success') void bridge.load().then(result => { if (mounted) setState(result); });
        });
        await window.yibiao.tasks.getActiveTasks();
        const available = await window.yibiao.config.listSelectableTextModels();
        if (!mounted) return;
        setModels(available);
        if (!next.textModelSelection && available.length && next.analysisTask?.status !== 'running') {
          const preferred = available.find(model => model.recommended) || available[0];
          const saved = await bridge.saveReview({ textModelSelection: preferred });
          if (mounted) setState(saved);
        }
      } catch (error) { if (mounted) setLoadError(String(error)); }
    };
    void load();
    const offExport = window.yibiao.export.onWordExportProgress(event => { if (event.requestId === exportId.current) setExportMessage(`${event.progress}% · ${event.message}`); });
    return () => { mounted = false; unsubscribe(); offExport(); };
  }, [bridge]);

  const run = async (label: string, action: () => Promise<void>) => {
    setOperation(label);
    try { await action(); } catch (error) { showToast(error instanceof Error ? error.message : String(error), 'error'); }
    finally { setOperation(''); }
  };
  const review = async (payload: BusinessBidReview) => { if (bridge) { setState(await bridge.saveReview(payload)); setExportPath(''); } };
  const saveFields = () => run('保存表单', async () => { await review({ projectName, deadline, fieldValues: fields }); setDirty(false); showToast('表单已保存，生成草稿将使用本次人工填写内容', 'success'); });
  const selectEvidence = (item: BusinessEvidence, checked: boolean, requirementIds = item.requirementIds) => run('保存材料选择', () => review({ evidence: [{ id: item.id, confirmed: checked, requirementIds }] }));
  const importDocuments = (paths?: string[]) => run('解析招标文件', async () => {
    if (!bridge) return;
    const result = await bridge.importDocuments(paths);
    setState(result.state); resetForm(result.state); setExportPath('');
    showToast(result.message, result.success ? 'success' : 'info');
  });
  const exportDraft = (kind: 'full' | 'pending') => run('导出 DOCX', async () => {
    if (!bridge) return;
    exportId.current = crypto.randomUUID(); setExportMessage('准备导出');
    const result = await bridge.export({ kind, requestId: exportId.current });
    if (result.success && result.path) { setExportPath(result.path); showToast(result.message || 'DOCX 已导出', 'success'); }
  });
  const updateField = (id: string, value: string) => { setFields(current => ({ ...current, [id]: value })); setDirty(true); };
  const evidence = (state?.evidence || []).filter(item => (!onlyEligible || item.eligible) && `${item.name} ${item.certificateName} ${item.tags}`.includes(query));

  if (!state) return <div className="business-bid-page"><section className="panel"><h2>商务标</h2><p>{loadError || '正在读取商务标工作区…'}</p></section></div>;
  return <div className="business-bid-page">
    <header className="business-bid-header">
      <div><span className="section-kicker">商务标 · 第一版</span><h2>隆创商务标编制工作台</h2><p>核对要求，确认材料，再生成可复核的商务标草稿。</p></div>
      <button className="text-button" disabled={busy} onClick={() => setResetOpen(true)}>开始新项目</button>
    </header>
    <p className="business-bid-notice">公司主体：<strong>{state.companyName}</strong>。缺项保留“待核实”；报价、签章及投标提交由人工完成。</p>
    {loadError && <p role="alert">{loadError}</p>}
    <section className="panel business-bid-section" aria-label="上传招标文件">
      <div className="business-bid-section-head"><h3>1. 上传招标文件</h3><span>{state.files.length} 份文件</span></div>
      <div className="business-bid-drop" onDragOver={event => event.preventDefault()} onDrop={event => {
        event.preventDefault();
        if (!busy) void importDocuments(Array.from(event.dataTransfer.files).map(file => window.yibiao.file.getPathForFile(file)));
      }}>
        <button className="secondary-action" disabled={busy} onClick={() => void importDocuments()}>上传 / 追加招标文件</button>
        <span>支持拖入文件，沿用设置中的解析方式；上传会清除已有要求和草稿。</span>
      </div>
      <div className="business-bid-file-list">{state.files.map(file => <article key={file.id}><span>{file.name}<small>{file.parserLabel} · {file.chars.toLocaleString()} 字符</small></span><button className="text-button" onClick={() => void run('读取原文', async () => setSource({ name: file.name, content: await bridge!.readSource(file.id) }))}>查看原文</button></article>)}</div>
      <label className="business-bid-model">本商务标使用模型<select aria-label="本商务标使用模型" disabled={busy || !models.length} value={state.textModelSelection ? `${state.textModelSelection.provider}:${state.textModelSelection.modelName}` : ''} onChange={event => {
        const selected = models.find(model => model.id === event.target.value);
        if (selected) void run('保存模型', () => review({ textModelSelection: selected }));
      }}><option value="" disabled>请选择模型</option>{models.map(model => <option key={model.id} value={model.id}>{model.label}{model.recommended ? '（推荐）' : ''}</option>)}</select></label>
      <div className="business-bid-actions"><button className="primary-action" disabled={busy || dirty || !state.files.length || !state.textModelSelection} onClick={() => void run('启动要求提取', async () => {
        await bridge!.analyze(); setState(await bridge!.load()); setFields({}); setExportPath('');
      })}>{state.analysis ? '重新提取商务要求' : '提取商务要求'}</button><span role="status">{operation || (busy ? '后台正在提取，离开页面后会继续' : '')}</span></div>
      {state.analysisTask && <div className="business-bid-task" role="status"><progress max="100" value={state.analysisTask.progress} /><span>{state.analysisTask.progress}% · {state.analysisTask.error || state.analysisTask.logs?.at(-1)}</span>{state.analysisCoverage && <small>已分析 {state.analysisCoverage.completed}/{state.analysisCoverage.total} 段</small>}</div>}
    </section>
    <section className="panel business-bid-section">
      <h3>2. 核对商务要求与原文</h3>
      {!state.analysis && <p className="business-bid-muted">提取后在此查看目录、资格要求、废标项、表单字段和商务条款。</p>}
      {state.analysis && (Object.keys(groupLabels) as (keyof BusinessAnalysis)[]).map(group => <details key={group} className="business-bid-requirements"><summary>{groupLabels[group]} <span>{state.analysis![group].length} 项</span></summary>
        {!state.analysis![group].length && <p>待核实：没有提取到条目，请核对是否漏提。</p>}
        {state.analysis![group].map(item => <article key={item.id}><strong>{item.title}</strong><small>{item.section} · {item.sourceName} · 第 {item.segment} 段</small><blockquote>{item.quote}</blockquote></article>)}
      </details>)}
      <label className="business-bid-check"><input type="checkbox" disabled={busy || !state.analysisComplete} checked={state.analysisConfirmed} onChange={event => void run('保存要求确认', () => review({ analysisConfirmed: event.target.checked }))} />我已核对提取结果与原文，接受保留缺项为“待核实”</label>
      {state.analysis && !state.analysisComplete && <p role="alert">提取尚未完成，部分结果不能作为完整商务要求。</p>}
    </section>
    <section className="panel business-bid-section">
      <h3>3. 填写项目与商务表单</h3><p className="business-bid-muted">只填写已有依据的信息；报价字段统一留空。修改后先保存，再生成草稿。</p>
      <div className="business-bid-form"><label>项目名称<input disabled={busy} value={projectName} placeholder="待核实" onChange={event => { setProjectName(event.target.value); setDirty(true); }} /></label><label>投标截止日（用于证书有效期核对）<input type="date" disabled={busy} value={deadline} onChange={event => { setDeadline(event.target.value); setDirty(true); }} /></label>
        {Object.entries(basics).map(([id, title]) => <label key={id}>{title}<input disabled={busy} value={fields[id] || ''} placeholder="待核实" onChange={event => updateField(id, event.target.value)} /></label>)}
        {state.analysis?.fields.map(item => <label key={item.id}>{item.section ? `${item.section} · ` : ''}{item.title}<input disabled={busy || item.kind === 'pricing'} value={item.kind === 'pricing' ? '' : fields[item.id] || ''} placeholder={item.kind === 'pricing' ? '报价由人工在导出文档中填写' : '待核实'} onChange={event => updateField(item.id, event.target.value)} /></label>)}
      </div><button className="secondary-action" disabled={busy || !dirty} onClick={() => void saveFields()}>保存表单</button>{dirty && <span className="business-bid-muted"> 有未保存内容</span>}
    </section>
    <section className="panel business-bid-section">
      <div className="business-bid-section-head"><h3>4. 匹配并人工确认公司材料</h3><button className="secondary-action" disabled={busy} onClick={() => void run('导入公司证据', async () => { setState(await bridge!.importEvidence()); setExportPath(''); })}>导入公司证据台账</button></div>
      <p className="business-bid-muted">导入公司证据库快照及其原件。归属不符的材料排除；未核实材料不能选用。人员还需任职归属证据。勾选表示选作草稿材料，资格符合性仍需人工核对。</p>
      <p>{state.evidence.filter(item => item.eligible).length} 项可选 · {state.evidence.filter(item => item.confirmed).length} 项已确认 · {state.excludedEvidence} 项异名公司材料已排除</p>
      <div className="business-bid-filters"><input aria-label="搜索公司材料" placeholder="搜索资质、人员或业绩" value={query} onChange={event => setQuery(event.target.value)} /><label className="business-bid-check"><input type="checkbox" checked={onlyEligible} onChange={event => setOnlyEligible(event.target.checked)} />仅显示可选材料</label></div>
      {!evidence.length && <p>暂无匹配材料。可导入证据台账或保留待补资料。</p>}
      <div className="business-bid-evidence-list">{evidence.map(item => <details key={item.id} className={`business-bid-evidence ${item.confirmed ? 'is-selected' : ''}`}><summary>{item.name} {item.certificateName} <span>{item.eligible ? item.confirmed ? '已人工选用' : '可选' : '待核实'}</span></summary>
        <p>{item.reason || '公司归属与原件哈希已核验'}{item.validUntil ? ` · 有效期至 ${item.validUntil}` : ''}</p>
        <div className="business-bid-actions">{item.files.map((file, index) => <button key={`${file.sha256}-${index}`} className="text-button" disabled={busy} onClick={() => void run('打开证据原件', async () => { await window.yibiao.export.openFile(file.sourcePath); })}>{file.name} · 查看原件</button>)}</div>
        {!!item.suggestedRequirementIds?.length && <p>关键词候选：{state.analysis?.qualifications.filter(req => item.suggestedRequirementIds.includes(req.id)).map(req => req.title).join('；')}（需人工确认）</p>}
        <label className="business-bid-check"><input type="checkbox" disabled={busy || !item.eligible} checked={item.confirmed} onChange={event => void selectEvidence(item, event.target.checked)} />已复核并选用此材料</label>
        {item.confirmed && <div className="business-bid-requirement-links"><strong>对应资格要求</strong>{state.analysis?.qualifications.map(req => <label key={req.id} className="business-bid-check"><input type="checkbox" disabled={busy} checked={item.requirementIds.includes(req.id)} onChange={event => void selectEvidence(item, true, event.target.checked ? [...item.requirementIds, req.id] : item.requirementIds.filter(id => id !== req.id))} />{req.title}</label>)}</div>}
      </details>)}</div>
    </section>
    <section className="panel business-bid-section">
      <div className="business-bid-section-head"><h3>5. 商务标草稿与待补清单</h3><button className="primary-action" disabled={busy || dirty || !state.analysisConfirmed} onClick={() => void run('生成商务标草稿', async () => { setState(await bridge!.generate()); setExportPath(''); showToast('草稿已生成，请核对待补资料和招标格式', 'success'); })}>生成商务标草稿</button></div>
      <p className="business-bid-muted">包含投标函、身份证明、授权书、资格资料、资质人员业绩索引、偏离表、政策声明和报价表结构。证明原件/扫描件须人工装订，表单版式须与招标原件核对。</p>
      {state.draft && <><p>{state.draft.sections.length} 个章节 · {state.draft.pending.length} 项待补 / 待核实</p>
        <div className="business-bid-actions"><button className="secondary-action" disabled={busy || dirty} onClick={() => void exportDraft('full')}>导出整本 DOCX</button><button className="secondary-action" disabled={busy || dirty} onClick={() => void exportDraft('pending')}>导出待补清单 DOCX</button>{exportPath && <button className="text-button" onClick={() => void run('打开导出文件', async () => { await window.yibiao.export.openFile(exportPath); })}>打开导出文件</button>}</div>
        {exportMessage && <p role="status">{exportMessage}</p>}
        <MarkdownFullscreenViewer title="商务标草稿预览"><MarkdownRenderer allowRawHtml={false}>{state.draft.sections.map(section => `## ${section.title}\n\n${section.content}`).join('\n\n') + '\n\n## 待补资料清单\n\n' + state.draft.pendingMarkdown}</MarkdownRenderer></MarkdownFullscreenViewer>
      </>}
    </section>
    <AppDialog open={resetOpen} onOpenChange={setResetOpen} title="开始新的商务标项目" description="将清空当前商务标工作区中的文件索引、要求、材料选择与草稿。已导出的 DOCX 保留。" actions={<><button className="secondary-action" onClick={() => setResetOpen(false)}>取消</button><button className="danger-action" onClick={() => void run('重置商务标', async () => { const next = await bridge!.clear(); setState(next); resetForm(next); setExportPath(''); setExportMessage(''); setResetOpen(false); })}>清空并开始</button></>} />
    <AppDialog open={Boolean(source)} onOpenChange={open => { if (!open) setSource(null); }} title={source?.name || '招标原文'} description="核对解析原文中的条款与表单，段号为分析片段编号，不代表原始页码。" cardClassName="business-bid-source-dialog" actions={<button className="secondary-action" onClick={() => setSource(null)}>关闭</button>}><pre className="business-bid-source">{source?.content}</pre></AppDialog>
  </div>;
}
export default BusinessBidPage;
