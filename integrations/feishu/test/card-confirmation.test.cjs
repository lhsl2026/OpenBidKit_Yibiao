const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildCard } = require('../card.cjs');

test('waiting confirmation card links the online document and describes it in Chinese', () => {
  const p = { id: 'p', version: '1', checksum: 'a', humanDecision: 'follow', input: { deadline: '2099-01-01', writingConfirmationUrl: 'https://tenant.feishu.cn/docx/doc123', writingConfirmation: { challenge: 'outline-1', contentHash: 'a'.repeat(64), documentVersion: 1 }, handoff: { task: { title: '智慧教室改造项目' }, status: 'ready', superseded: false, warnings: [], requirements: [] } }, assessment: { decision: 'follow', items: [], blockers: [] } };
  const writing = { status: 'waiting_confirmation', confirmationPublished: true, result: { confirmation: { type: 'outline', challenge: 'outline-1' } } };
  const card = buildCard(p, writing, 0, { now: 1 });
  const serialized = JSON.stringify(card);
  assert.match(serialized, /完整清单请查看飞书确认文档/);
  assert.match(serialized, /查看确认文档/);
  assert.match(serialized, /https:\/\/tenant\.feishu\.cn\/docx\/doc123/);
  assert.doesNotMatch(serialized, /群内附件为准/);
});

test('a legacy TXT delivery marker cannot enable online document confirmation', () => {
  const p = { id: 'p', version: '1', checksum: 'a', humanDecision: 'follow', input: { deadline: '2099-01-01', handoff: { task: { title: '项目' }, status: 'ready', superseded: false, warnings: [], requirements: [] } }, assessment: { decision: 'follow', items: [], blockers: [] } };
  const card = buildCard(p, { status: 'waiting_confirmation', previewDelivered: true, confirmationPublished: false, result: { confirmation: { type: 'outline', challenge: 'old-txt' } } }, 0, { now: 1 });
  const buttons = card.body.elements.flatMap(group => group.columns?.flatMap(column => column.elements ?? []) ?? []).filter(element => element.tag === 'button');
  assert.equal(buttons.find(button => button.text?.content === '确认以上内容并继续')?.disabled, true);
});

test('recoverable writing failures show a precise Chinese retry action', () => {
  const p = { id: 'p', version: '1', checksum: 'a', humanDecision: 'follow', input: { deadline: '2099-01-01', handoff: { task: { title: '项目' }, status: 'ready', superseded: false, warnings: [], requirements: [] } }, assessment: { decision: 'follow', items: [], blockers: [] } };
  const labels = writing => JSON.stringify(buildCard(p, writing, 0, { now: 1 }));
  assert.match(labels({ status: 'interrupted', result: { code: 'worker_timeout' } }), /继续生成未完成内容/);
  assert.match(labels({ status: 'not_ready', result: { code: 'model_not_configured' } }), /配置模型后重试/);
  assert.match(labels({ status: 'failed', result: { code: 'worker_process_failed' } }), /重新尝试生成/);
  const factTimeout = labels({ status: 'failed', result: { code: 'codex_fact_generation_timeout' } });
  assert.match(factTimeout, /全局事实合并/);
  assert.match(factTimeout, /模型生成超时/);
  assert.doesNotMatch(labels({ status: 'interrupted', result: { code: 'worker_timeout' } }), /修复配置后重试/);
});

test('new project cards emit only company_match and writing action namespaces', () => {
  const p = { id: 'p', version: '1', checksum: 'a', humanDecision: 'follow', input: { deadline: '2099-01-01', writingConfirmationUrl: 'https://tenant.feishu.cn/docx/doc123', writingConfirmation: { challenge: 'outline-1' }, handoff: { task: { title: '项目' }, status: 'ready', superseded: false, warnings: [], requirements: [] } }, assessment: { decision: 'follow', items: [], blockers: [], actions: [] } };
  const values = [];
  const collect = value => { if (Array.isArray(value)) value.forEach(collect); else if (value && typeof value === 'object') { if (value.type === 'callback' && value.value) values.push(value.value); Object.values(value).forEach(collect); } };
  collect(buildCard(p, { status: 'waiting_confirmation', confirmationPublished: true, result: { confirmation: { type: 'outline', challenge: 'outline-1' } } }, 0, { now: 1 }));
  collect(buildCard(p, { status: 'failed', result: { code: 'worker_process_failed' } }, 0, { now: 1 }));
  assert.deepEqual([...new Set(values.map(value => value.action))].sort(), ['company_match.decline', 'company_match.defer', 'company_match.follow', 'writing.continue', 'writing.retry', 'writing.start']);
  assert.ok(values.every(value => !('agent' in value)));
});

function companyProject(companies, selectedCompanyId) {
  return {
    id: 'project-1', version: '7', checksum: 'a', messageId: 'om_project_card', humanDecision: null,
    input: {
      deadline: '2099-01-01',
      handoff: {
        task: { taskId: 'task-1', title: '多公司匹配项目' }, status: 'ready', superseded: false, warnings: [], requirements: [],
        companyMatch: {
          companyId: selectedCompanyId, companyName: companies.find(company => company.companyId === selectedCompanyId)?.companyName,
          profileVersion: companies.find(company => company.companyId === selectedCompanyId)?.profileVersion,
          syncStatus: 'synced', syncedAt: '2026-09-23T03:00:00.000Z', completeness: 0.75, qualificationCount: 4,
          counts: { profileEvidenceSatisfied: 2, humanConfirmedCurrent: 0, humanConfirmedReused: 1, pendingReview: 1, gaps: 0, notApplicable: 0 },
        },
      },
      companyMatchCard: {
        taskId: 'task-1', runId: '11111111-1111-4111-8111-111111111111', documentVersion: 3,
        scopeType: 'group', scopeId: 'oc_test', sourceCardMessageId: 'om_project_card', selectedCompanyId,
        companies,
      },
    },
    assessment: { decision: 'review', items: [], blockers: [], actions: [] },
  };
}

test('one enabled company is fixed text with an auditable review action and no selector', () => {
  const p = companyProject([{ companyId: 'company-a', companyName: '贵州甲公司', profileVersion: 'profile-a', enabled: true }], 'company-a');
  const card = buildCard(p, null, 0, { now: 1 });
  const serialized = JSON.stringify(card);
  assert.match(serialized, /匹配公司/);
  assert.match(serialized, /贵州甲公司/);
  assert.doesNotMatch(serialized, /select_static/);
  assert.match(serialized, /company_match\.review/);
  assert.match(serialized, /om_project_card/);
});

test('multiple enabled companies render one select_static bound to the current project card', () => {
  const companies = [
    { companyId: 'company-a', companyName: '贵州甲公司', profileVersion: 'profile-a', enabled: true },
    { companyId: 'company-b', companyName: '贵州乙公司', profileVersion: 'profile-b', enabled: true },
  ];
  const card = buildCard(companyProject(companies, 'company-b'), null, 0, { now: 1 });
  const serialized = JSON.stringify(card);
  assert.equal((serialized.match(/select_static/g) ?? []).length, 1);
  assert.match(serialized, /company_match\.select/);
  for (const identity of ['task-1', '11111111-1111-4111-8111-111111111111', 'om_project_card', 'oc_test', 'profile-b']) assert.match(serialized, new RegExp(identity));
  assert.equal((serialized.match(/company_match\.review/g) ?? []).length, 1);
});
