const { draftSystemPrompt, buildDraftPacketUserPrompt } = require('./businessBidPrompts.cjs');
const { buildBusinessDraftPackets, normalizeGeneratedPart, mergeGeneratedParts } = require('./businessBidGeneration.cjs');

async function runBusinessBidGenerationTask({ workspaceStore, aiService, updateTask, checkpointTask, taskControl }) {
  const state = workspaceStore.loadBusinessBid();
  workspaceStore.verifyGenerationInputs?.(state);
  const packets = buildBusinessDraftPackets(state);
  const parts = [];
  let logs = [`已按招标结构拆分为 ${packets.length} 个商务标生成包。`];
  updateTask({ progress: 2, logs });

  for (let index = 0; index < packets.length; index += 1) {
    taskControl.signal.throwIfAborted();
    const packet = packets[index];
    logs = [...logs, `正在编制 ${index + 1}/${packets.length}：${packet.title}`];
    updateTask({ progress: 5 + Math.round(index / packets.length * 85), logs });
    const payload = await aiService.requestJson({
      messages: [
        { role: 'system', content: draftSystemPrompt },
        { role: 'user', content: buildDraftPacketUserPrompt(packet) },
      ],
      progressLabel: `商务标正文 ${index + 1}/${packets.length}`,
      logTitle: `商务标正文-${packet.group}-${index + 1}`,
      failureMessage: `“${packet.title}”生成结果不是有效 JSON`,
    });
    taskControl.signal.throwIfAborted();
    parts.push(normalizeGeneratedPart(payload, packet));
    checkpointTask({ progress: 8 + Math.round((index + 1) / packets.length * 82), logs });
  }

  updateTask({ progress: 94, logs: [...logs, '正在执行要求覆盖、证据引用和人工确认项审校。'] });
  const draft = mergeGeneratedParts(state, parts);
  checkpointTask({ status: 'success', progress: 100, logs: [...logs, `商务标正文生成完成，共 ${draft.sections.length} 个章节，${draft.coverage.total} 条要求均已进入正文或审校表。`] }, {
    draft,
    generationComplete: true,
  });
}

module.exports = { runBusinessBidGenerationTask };
