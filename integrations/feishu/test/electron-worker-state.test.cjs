'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { selectContentStartPayload } = require('../electron-worker-state.cjs');

test('resumes an interrupted paused content task without replacing completed sections', () => {
  const state = {
    contentGenerationTask: {
      status: 'paused',
      stats: { content: { phase: 'generating', awaiting_content_decision: false } },
    },
    contentGenerationSections: {
      completed: { status: 'success', content: '已完成且必须保留的正文' },
      failed: { status: 'error', error: '进程中断' },
      pending: { status: 'idle' },
    },
  };
  const before = structuredClone(state);
  const initialPayload = {
    regenerate: false,
    generationOptions: { enableConsistencyAudit: true },
  };

  assert.deepEqual(selectContentStartPayload(state, initialPayload), { resume: true });
  assert.deepEqual(state, before);
});

test('keeps the normal start payload when there is no interrupted pause to resume', () => {
  const initialPayload = {
    regenerate: false,
    generationOptions: { enableConsistencyAudit: true },
  };

  assert.equal(selectContentStartPayload({ contentGenerationTask: { status: 'error' } }, initialPayload), initialPayload);
  assert.equal(selectContentStartPayload({
    contentGenerationTask: {
      status: 'paused',
      stats: { content: { awaiting_content_decision: true } },
    },
  }, initialPayload), initialPayload);
});
