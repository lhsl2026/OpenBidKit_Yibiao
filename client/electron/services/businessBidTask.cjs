const { splitUserTextByContextLimit } = require('../utils/userTextSplitter.cjs');
const { normalizeAnalysis, mergeAnalysis } = require('./businessBidDomain.cjs');
const { systemPrompt, citationRepairPrompt } = require('./businessBidPrompts.cjs');

async function normalizeWithSourceRepair(payload, source, { aiService, taskControl, updateTask }) {
  let issues;
  try { return normalizeAnalysis(payload, source); }
  catch (error) {
    if (error.code !== 'BUSINESS_QUOTE_MISMATCH') throw error;
    issues = error.quoteIssues;
  }
  taskControl.signal.throwIfAborted();
  updateTask({ logs: [`第 ${source.segment} 段有 ${issues.length} 条引用需按原文行号定位，正在核对跨页或改写摘录`] });
  const lines = source.text.split('\n');
  const result = await aiService.requestJson({ messages: [
    { role: 'system', content: citationRepairPrompt },
    { role: 'user', content: `待定位条目：${JSON.stringify(issues)}\n\n带行号原文（共${lines.length}行）：\n${lines.map((line, i) => `${i + 1}|${line}`).join('\n')}` },
  ], max_retries: 0, progressLabel: '商务引用定位', logTitle: '商务标引用原文定位', failureMessage: '商务引用定位不是有效 JSON' });
  taskControl.signal.throwIfAborted();
  const fail = () => new Error(`商务分析第 ${source.segment} 段原文定位未通过（${issues[0].title.slice(0, 80)}），请查看原文；已完成片段保留，不会自动重复调用`);
  if (!Array.isArray(result?.citations) || result.citations.length !== issues.length) throw fail();
  const locations = new Map();
  for (const citation of result.citations) {
    if (!citation || !issues.some(issue => issue.key === citation.key) || locations.has(citation.key)
      || !Number.isInteger(citation.startLine) || !Number.isInteger(citation.endLine)
      || citation.startLine < 1 || citation.endLine < citation.startLine || citation.endLine > lines.length) throw fail();
    locations.set(citation.key, citation);
  }
  const repaired = Object.fromEntries(Object.entries(payload).map(([group, items]) => [group, Array.isArray(items) ? items.map(item => ({ ...item })) : items]));
  for (const issue of issues) {
    const { startLine, endLine } = locations.get(issue.key);
    repaired[issue.group][issue.index].quote = lines.slice(startLine - 1, endLine).join('\n');
  }
  // 摘录由原文切片构造，仍通过同一引用校验；失败不进入无限修复循环。
  try { return normalizeAnalysis(repaired, source); } catch { throw fail(); }
}

async function runBusinessBidAnalysisTask({ workspaceStore, aiService, updateTask, checkpointTask, taskControl }) {
  const state = workspaceStore.loadBusinessBid();
  if (!state.files.length) throw new Error('请先上传招标文件');
  const config = aiService.getConfig?.() || {};
  // 商务提取需要逐项输出，输入过大会先耗尽输出长度；同时遵循所选模型更小的上下文限制。
  const splitOptions = { contextLengthLimit: Math.min(Number(config.context_length_limit) || 16000, 16000) };
  const segments = state.files.flatMap(file => {
    const text = workspaceStore.readSource(file.id);
    if (!text.trim()) throw new Error(`文件“${file.name}”解析原文为空，请检查解析方式或重新上传可读取的文件`);
    return splitUserTextByContextLimit(text, config, splitOptions)
      .map((text, index) => ({ ...file, text, segment: index + 1 }));
  });
  const parts = [];
  for (let index = 0; index < segments.length; index += 1) {
    taskControl.signal.throwIfAborted();
    const source = segments[index];
    updateTask({ progress: Math.round(index / segments.length * 95), logs: [`正在提取第 ${index + 1}/${segments.length} 段商务要求`] });
    try {
      const payload = await aiService.requestJson({ messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: `文件：${source.name}\n片段：${source.segment}\n\n${source.text}` }],
        progressLabel: '商务要求提取', logTitle: '商务标要求提取', failureMessage: '商务要求不是有效 JSON' });
      parts.push(await normalizeWithSourceRepair(payload, source, { aiService, taskControl, updateTask }));
    } catch (error) {
      taskControl.signal.throwIfAborted();
      throw new Error(`文件“${source.name}”第 ${source.segment} 段提取失败：${error.message || String(error)}。已完成片段保留，请检查后重试`, { cause: error });
    }
    checkpointTask({ progress: Math.round((index + 1) / segments.length * 95) }, { analysis: mergeAnalysis(parts), analysisCoverage: { completed: index + 1, total: segments.length } });
  }
  const analysis = mergeAnalysis(parts);
  if (!Object.values(analysis).some(items => items.length)) throw new Error('未提取到任何商务要求，请查看解析原文是否含有招标正文，核对文件或模型后重试');
  checkpointTask({ status: 'success', progress: 100, logs: ['商务要求提取完成，请核对原文并确认。'] }, { analysis, analysisComplete: true });
}
module.exports = { runBusinessBidAnalysisTask };
