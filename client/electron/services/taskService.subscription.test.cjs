const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createTaskService } = require('./taskService.cjs');

test('repeated subscriptions bind one webContents destroyed listener', () => {
  const taskService = createTaskService({
    technicalPlanStore: { loadTechnicalPlan: () => ({}) },
    rejectionCheckStore: { loadRejectionCheck: () => ({}) },
    duplicateCheckStore: { loadDuplicateCheck: () => ({}) },
    feasibilityReportStore: { loadFeasibilityReport: () => ({}) },
  });
  const webContents = new EventEmitter();
  webContents.isDestroyed = () => false;
  webContents.send = () => {};

  for (let index = 0; index < 12; index += 1) {
    taskService.subscribe(webContents);
  }

  assert.equal(webContents.listenerCount('destroyed'), 1);
});
