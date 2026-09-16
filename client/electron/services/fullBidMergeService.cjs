const ACTIVE_TASK_STATUSES = new Set(['running', 'pausing', 'paused']);

function clean(value) {
  return String(value || '').trim();
}

function outlineItems(state) {
  return Array.isArray(state?.outlineData?.outline) ? state.outlineData.outline : [];
}

function countOutlineItems(items) {
  return (Array.isArray(items) ? items : []).reduce(
    (total, item) => total + 1 + countOutlineItems(item?.children),
    0,
  );
}

function hasOutlineContent(items) {
  return (Array.isArray(items) ? items : []).some((item) => (
    clean(item?.content) || hasOutlineContent(item?.children)
  ));
}

function taskIsActive(task) {
  return ACTIVE_TASK_STATUSES.has(clean(task?.status));
}

function resolveProjectNames(technicalState, businessState) {
  const technicalName = clean(technicalState?.outlineData?.project_name);
  const businessName = clean(businessState?.projectName);
  return {
    technicalName,
    businessName,
    projectName: technicalName || businessName,
    mismatch: Boolean(technicalName && businessName && technicalName !== businessName),
  };
}

function technicalReadiness(state) {
  const items = outlineItems(state);
  if (taskIsActive(state?.contentGenerationTask)) {
    return { status: 'running', label: '正在生成', sectionCount: countOutlineItems(items) };
  }
  const generated = items.length > 0 && (
    clean(state?.contentGenerationTask?.status) === 'success'
    || hasOutlineContent(items)
  );
  return {
    status: generated ? 'ready' : 'missing',
    label: generated ? '已生成' : '尚未生成',
    sectionCount: countOutlineItems(items),
  };
}

function businessReadiness(state) {
  const sections = Array.isArray(state?.draft?.sections) ? state.draft.sections : [];
  if (taskIsActive(state?.generationTask)) {
    return { status: 'running', label: '正在生成', sectionCount: sections.length };
  }
  const generated = state?.generationComplete === true && sections.length > 0;
  return {
    status: generated ? 'ready' : 'missing',
    label: generated ? '已生成' : '尚未生成',
    sectionCount: sections.length,
  };
}

function buildFullBidStatus({ technicalState, businessState }) {
  const technical = technicalReadiness(technicalState);
  const business = businessReadiness(businessState);
  const names = resolveProjectNames(technicalState, businessState);
  const companyName = clean(businessState?.companyName);
  let blockingMessage = '';

  if (technical.status === 'running') blockingMessage = '技术标正在生成，请完成后再合并';
  else if (technical.status !== 'ready') blockingMessage = '技术标尚未生成，请先完成技术标正文';
  else if (business.status === 'running') blockingMessage = '商务标正在生成，请完成后再合并';
  else if (business.status !== 'ready') blockingMessage = '商务标尚未生成，请先完成商务标正文';
  else if (names.mismatch) blockingMessage = `项目名称不一致：技术标“${names.technicalName}”，商务标“${names.businessName}”，请统一后再合并`;
  else if (!companyName) blockingMessage = '商务标尚未选择公司主体';

  return {
    canExport: !blockingMessage,
    blockingMessage,
    projectName: names.projectName,
    technicalProjectName: names.technicalName,
    businessProjectName: names.businessName,
    companyName,
    technical,
    business,
    mergeOrder: ['商务标', '技术标', '待补资料与交付前检查'],
  };
}

function assertReady(technicalState, businessState) {
  const status = buildFullBidStatus({ technicalState, businessState });
  if (!status.canExport) throw new Error(status.blockingMessage);
  return status;
}

function cloneOutline(items, prefix, parentPath = []) {
  return (Array.isArray(items) ? items : []).map((item, index) => {
    const path = [...parentPath, index + 1];
    const children = cloneOutline(item?.children, prefix, path);
    return {
      ...item,
      id: `${prefix}-${path.join('-')}`,
      ...(children.length ? { children } : { children: undefined }),
    };
  });
}

function splitPendingOutline(businessPayload, businessState) {
  const items = Array.isArray(businessPayload?.outline) ? businessPayload.outline : [];
  const pendingIndex = items.findIndex((item) => item?.id === 'business-pending');
  const pending = pendingIndex >= 0 ? items[pendingIndex] : null;
  const sections = pendingIndex >= 0 ? items.filter((_item, index) => index !== pendingIndex) : items;
  const pendingContent = clean(pending?.content) || clean(businessState?.draft?.pendingMarkdown)
    || '当前未列出待补资料。交付前仍须人工复核报价、签字、盖章、附件顺序及招标文件全部实质性要求。';
  return { sections, pendingContent };
}

function buildFullBidPayload({ technicalState, businessState, businessPayload, exportFormat }) {
  const status = assertReady(technicalState, businessState);
  const technical = outlineItems(technicalState);
  const { sections: business, pendingContent } = splitPendingOutline(businessPayload, businessState);
  if (!business.length) throw new Error('商务标尚未生成，请先完成商务标正文');

  return {
    project_name: `${status.projectName || status.companyName}_完整投标文件`,
    document_title: status.projectName || '完整投标文件',
    document_subtitle: '投标文件',
    cover_lines: [`投标人：${status.companyName}`, '商务标与技术标合并稿'],
    include_toc: true,
    table_pagination: businessPayload?.table_pagination || 'keep-rows',
    ...(exportFormat ? { export_format: exportFormat } : {}),
    outline: [
      {
        id: 'full-business',
        title: '第一部分 商务标',
        description: '商务响应、资格证明与合同条款文件',
        children: cloneOutline(business, 'business'),
      },
      {
        id: 'full-technical',
        title: '第二部分 技术标',
        description: '技术方案与实施响应文件',
        page_break_before: true,
        children: cloneOutline(technical, 'technical'),
      },
      {
        id: 'full-delivery',
        title: '待补资料与交付前检查',
        description: '正式提交前必须逐项人工复核',
        page_break_before: true,
        content: pendingContent,
      },
    ],
  };
}

function createFullBidMergeService({ technicalPlanStore, businessBidStore, exportService }) {
  return {
    load() {
      return buildFullBidStatus({
        technicalState: technicalPlanStore.loadTechnicalPlan(),
        businessState: businessBidStore.loadBusinessBid(),
      });
    },
    async exportWord({ export_format: exportFormat } = {}, onProgress) {
      const technicalState = technicalPlanStore.loadTechnicalPlan();
      const businessState = businessBidStore.loadBusinessBid();
      assertReady(technicalState, businessState);
      const businessPayload = businessBidStore.getExportPayload('full');
      const payload = buildFullBidPayload({ technicalState, businessState, businessPayload, exportFormat });
      return exportService.exportWord(payload, onProgress);
    },
  };
}

module.exports = {
  buildFullBidPayload,
  buildFullBidStatus,
  createFullBidMergeService,
};
