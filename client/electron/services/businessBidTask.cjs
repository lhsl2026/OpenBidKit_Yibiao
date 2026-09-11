const { splitUserTextByContextLimit } = require('../utils/userTextSplitter.cjs');
const { normalizeAnalysis, mergeAnalysis } = require('./businessBidDomain.cjs');
const { systemPrompt } = require('./businessBidPrompts.cjs');

async function runBusinessBidAnalysisTask({ workspaceStore, aiService, updateTask, checkpointTask, taskControl }) {
  const state = workspaceStore.loadBusinessBid();
  if (!state.files.length) throw new Error('请先上传招标文件');
  const config = aiService.getConfig?.() || {};
  // 商务提取需要逐项输出，输入过大会先耗尽输出长度；同时遵循所选模型更小的上下文限制。
  const splitOptions = { contextLengthLimit: Math.min(Number(config.context_length_limit) || 16000, 16000) };
  const segments = state.files.flatMap(file => splitUserTextByContextLimit(workspaceStore.readSource(file.id), config, splitOptions)
    .map((text, index) => ({ ...file, text, segment: index + 1 })));
  const parts = [];
  for (let index = 0; index < segments.length; index += 1) {
    taskControl.signal.throwIfAborted();
    const source = segments[index];
    updateTask({ progress: Math.round(index / segments.length * 95), logs: [`正在提取第 ${index + 1}/${segments.length} 段商务要求`] });
    const payload = await aiService.requestJson({ messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: `文件：${source.name}\n片段：${source.segment}\n\n${source.text}` }],
      progressLabel: '商务要求提取', logTitle: '商务标要求提取', failureMessage: '商务要求不是有效 JSON' });
    parts.push(normalizeAnalysis(payload, source));
    checkpointTask({ progress: Math.round((index + 1) / segments.length * 95) }, { analysis: mergeAnalysis(parts), analysisCoverage: { completed: index + 1, total: segments.length } });
  }
  checkpointTask({ status: 'success', progress: 100, logs: ['商务要求提取完成，请核对原文并确认。'] }, { analysis: mergeAnalysis(parts), analysisComplete: true });
}
module.exports = { runBusinessBidAnalysisTask };
