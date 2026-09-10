'use strict';

function selectContentStartPayload(state, initialPayload) {
  const task = state?.contentGenerationTask;
  const awaitingDecision = task?.stats?.content?.awaiting_content_decision === true;
  if (task?.status === 'paused' && !awaitingDecision) return { resume: true };
  return initialPayload;
}

function isContentDecisionPending(task) {
  return ['paused', 'error'].includes(task?.status)
    && task?.stats?.content?.awaiting_content_decision === true;
}

module.exports = { selectContentStartPayload, isContentDecisionPending };
