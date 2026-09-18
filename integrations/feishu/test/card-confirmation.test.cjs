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
  assert.doesNotMatch(labels({ status: 'interrupted', result: { code: 'worker_timeout' } }), /修复配置后重试/);
});
