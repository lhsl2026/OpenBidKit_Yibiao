const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildFullBidPayload,
  buildFullBidStatus,
  createFullBidMergeService,
} = require('./fullBidMergeService.cjs');

function technicalState(overrides = {}) {
  return {
    outlineData: {
      project_name: '测试项目',
      outline: [{
        id: '1',
        title: '实施方案',
        content: '技术正文',
        children: [{ id: '1.1', title: '进度安排', content: '进度正文' }],
      }],
    },
    contentGenerationTask: { status: 'success' },
    contentGenerationSections: {
      '1.1': { id: '1.1', title: '进度安排', status: 'success', content: '进度正文' },
    },
    ...overrides,
  };
}

function businessState(overrides = {}) {
  return {
    projectName: '测试项目',
    companyName: '隆创信息有限公司',
    generationComplete: true,
    generationTask: { status: 'success' },
    draft: {
      sections: [{ id: 'business-original', title: '投标函', content: '商务正文' }],
      pendingMarkdown: '- 【待补充：法定代表人签字】',
    },
    ...overrides,
  };
}

function businessPayload() {
  return {
    project_name: '测试项目_商务标草稿',
    table_pagination: 'keep-rows',
    outline: [
      { id: 'business-original', title: '投标函', content: '商务正文' },
      { id: 'business-pending', title: '待补资料清单', content: '- 【待补充：法定代表人签字】' },
    ],
  };
}

test('builds one immutable full-bid payload in business, technical, delivery order', () => {
  const technical = technicalState();
  const business = businessState();
  const beforeTechnical = structuredClone(technical);
  const beforeBusiness = structuredClone(business);

  const payload = buildFullBidPayload({
    technicalState: technical,
    businessState: business,
    businessPayload: businessPayload(),
    exportFormat: { page: { paper_size: 'a4' } },
  });

  assert.equal(payload.project_name, '测试项目_完整投标文件');
  assert.equal(payload.document_title, '测试项目');
  assert.equal(payload.document_subtitle, '投标文件');
  assert.deepEqual(payload.cover_lines, ['投标人：隆创信息有限公司', '商务标与技术标合并稿']);
  assert.equal(payload.include_toc, true);
  assert.equal(payload.table_pagination, 'keep-rows');
  assert.deepEqual(payload.outline.map((item) => item.title), [
    '第一部分 商务标',
    '第二部分 技术标',
    '待补资料与交付前检查',
  ]);
  assert.equal(payload.outline[0].children[0].title, '投标函');
  assert.equal(payload.outline[1].children[0].title, '实施方案');
  assert.equal(payload.outline[1].page_break_before, true);
  assert.equal(payload.outline[2].page_break_before, true);
  assert.match(payload.outline[2].content, /法定代表人签字/);
  assert.deepEqual(technical, beforeTechnical);
  assert.deepEqual(business, beforeBusiness);
});

test('recursively assigns stable unique ids without changing content or image references', () => {
  const technical = technicalState();
  technical.outlineData.outline[0].children[0].content = '![进度图](yibiao-asset://generated-images/example.png)';
  const payload = buildFullBidPayload({
    technicalState: technical,
    businessState: businessState(),
    businessPayload: businessPayload(),
  });

  const ids = [];
  const collect = (items) => items.forEach((item) => {
    ids.push(item.id);
    collect(item.children || []);
  });
  collect(payload.outline);

  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, [
    'full-business', 'business-1',
    'full-technical', 'technical-1', 'technical-1-1',
    'full-delivery',
  ]);
  assert.equal(payload.outline[1].children[0].children[0].content, '![进度图](yibiao-asset://generated-images/example.png)');
});

test('blocks mismatched non-empty project names and reports both names', () => {
  assert.throws(() => buildFullBidPayload({
    technicalState: technicalState({ outlineData: { project_name: '技术项目', outline: [{ id: '1', title: '技术', content: '正文' }] } }),
    businessState: businessState({ projectName: '商务项目' }),
    businessPayload: businessPayload(),
  }), /技术标“技术项目”.*商务标“商务项目”/);
});

test('uses the non-empty project name when one side has not named the project', () => {
  const payload = buildFullBidPayload({
    technicalState: technicalState({ outlineData: { project_name: '', outline: [{ id: '1', title: '技术', content: '正文' }] } }),
    businessState: businessState(),
    businessPayload: businessPayload(),
  });
  assert.equal(payload.project_name, '测试项目_完整投标文件');
});

test('blocks missing or in-progress volumes before export', () => {
  assert.throws(() => buildFullBidPayload({
    technicalState: technicalState({ outlineData: null }),
    businessState: businessState(),
    businessPayload: businessPayload(),
  }), /技术标尚未生成/);

  assert.throws(() => buildFullBidPayload({
    technicalState: technicalState({ contentGenerationTask: { status: 'running' } }),
    businessState: businessState(),
    businessPayload: businessPayload(),
  }), /技术标正在生成/);

  assert.throws(() => buildFullBidPayload({
    technicalState: technicalState(),
    businessState: businessState({ generationComplete: false, draft: null }),
    businessPayload: { outline: [] },
  }), /商务标尚未生成/);

  assert.throws(() => buildFullBidPayload({
    technicalState: technicalState(),
    businessState: businessState({ generationTask: { status: 'pausing' } }),
    businessPayload: businessPayload(),
  }), /商务标正在生成/);
});

test('status exposes actionable readiness without throwing', () => {
  const ready = buildFullBidStatus({ technicalState: technicalState(), businessState: businessState() });
  assert.equal(ready.canExport, true);
  assert.equal(ready.projectName, '测试项目');
  assert.equal(ready.companyName, '隆创信息有限公司');
  assert.equal(ready.technical.status, 'ready');
  assert.equal(ready.business.status, 'ready');

  const mismatch = buildFullBidStatus({
    technicalState: technicalState({ outlineData: { project_name: '技术项目', outline: [{ id: '1', title: '技术', content: '正文' }] } }),
    businessState: businessState({ projectName: '商务项目' }),
  });
  assert.equal(mismatch.canExport, false);
  assert.match(mismatch.blockingMessage, /项目名称不一致/);
});

test('service verifies through the business store and exports one combined payload', async () => {
  let exportedPayload;
  const service = createFullBidMergeService({
    technicalPlanStore: { loadTechnicalPlan: () => technicalState() },
    businessBidStore: {
      loadBusinessBid: () => businessState(),
      getExportPayload: (kind) => {
        assert.equal(kind, 'full');
        return businessPayload();
      },
    },
    exportService: {
      exportWord: async (payload) => {
        exportedPayload = payload;
        return { success: true, path: 'C:\\投标文件.docx', warnings: [] };
      },
    },
  });

  const status = service.load();
  assert.equal(status.canExport, true);
  const result = await service.exportWord({ export_format: { page: { paper_size: 'a4' } } });
  assert.equal(result.success, true);
  assert.equal(exportedPayload.include_toc, true);
  assert.deepEqual(exportedPayload.outline.map((item) => item.id), ['full-business', 'full-technical', 'full-delivery']);
});
