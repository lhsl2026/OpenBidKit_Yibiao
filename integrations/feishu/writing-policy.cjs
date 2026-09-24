'use strict';

const PLACEHOLDER_REASONS = new Set([
  'structured_rule_missing',
  'requirement_confirmation_pending',
  'requirement_confidence_low',
  'verified_evidence_missing',
  'manual_result_unverified',
  'manual_result_unknown',
  'certificate_issue_date_unknown',
  'certificate_issue_date_invalid',
  'certificate_not_issued_at_deadline',
  'certificate_expiry_unknown',
  'certificate_expiry_invalid',
  'certificate_expired_at_deadline',
  'certificate_holder_unknown',
  'certificate_holder_count_insufficient',
  'performance_amount_invalid',
  'performance_amount_unknown',
  'performance_amount_insufficient',
  'performance_date_unknown',
  'performance_date_invalid',
  'performance_date_after_deadline',
  'performance_date_too_early',
  'performance_date_too_late',
  'performance_duplicate_evidence',
  'performance_identity_ambiguous',
  'performance_count_insufficient',
]);
const REVIEWABLE_WARNING_CODES = new Set([
  'report_requires_review',
  'five_module_run_incomplete',
]);

function placeholderBlockers(assessment) {
  if (assessment?.decision !== 'review' || !Array.isArray(assessment.items) || !Array.isArray(assessment.blockers)) return false;
  const reviewItems = assessment.items.filter(item => item?.status === 'review');
  if (reviewItems.length === 0 || assessment.items.some(item => item?.status === 'not_satisfied')) return false;
  const allowedBlockers = new Set();
  for (const item of reviewItems) {
    if (!item?.requirementId || !Array.isArray(item.reasons) || item.reasons.length === 0) return false;
    for (const reason of item.reasons) {
      if (!PLACEHOLDER_REASONS.has(reason)) return false;
      allowedBlockers.add(`${item.requirementId}:${reason}`);
    }
  }
  return allowedBlockers;
}

function assessmentAllowsPlaceholderDraft(assessment) {
  if (assessment?.decision === 'follow') return true;
  const allowedBlockers = placeholderBlockers(assessment);
  if (!allowedBlockers) return false;
  return assessment.blockers.every(blocker => allowedBlockers.has(blocker));
}

function assessmentAllowsReviewedDraft(project) {
  const assessment = project?.assessment;
  let allowedBlockers = placeholderBlockers(assessment);
  // A sparse-page report can legitimately contain no extracted requirements.
  // In that case the handoff-level review warnings remain the complete gate.
  if (!allowedBlockers) {
    if (assessment?.decision !== 'review' || !Array.isArray(assessment.items) || assessment.items.length !== 0 || !Array.isArray(assessment.blockers)) return false;
    allowedBlockers = new Set();
  }
  const handoff = project.input.handoff;
  allowedBlockers.add('handoff_invalid');
  if (handoff.warnings.some(warning => warning?.blocked === true)) allowedBlockers.add('handoff_warning_blocked');
  if (Number(handoff.snapshot.completeness) < 1) allowedBlockers.add('handoff_snapshot_incomplete');
  const deadline = project.input.deadline;
  if (deadline == null || (typeof deadline === 'string' && deadline.trim() === '')) allowedBlockers.add('deadline_invalid');
  return assessment.blockers.every(blocker => allowedBlockers.has(blocker));
}

function normalizeChecksum(value) {
  const checksum = String(value ?? '').replace(/^sha256:/i, '').toLowerCase();
  return /^[a-f0-9]{64}$/.test(checksum) ? checksum : null;
}

function reviewableSnapshot(project) {
  const handoff = project?.input?.handoff;
  const snapshot = handoff?.snapshot;
  const warnings = handoff?.warnings;
  const projectChecksum = normalizeChecksum(project?.checksum);
  const snapshotChecksum = normalizeChecksum(snapshot?.checksum);
  const completeness = Number(snapshot?.completeness);
  const confidence = Number(snapshot?.confidence);
  return Boolean(
    handoff?.status === 'invalid'
    && handoff.superseded !== true
    && Array.isArray(warnings)
    && warnings.length > 0
    && warnings.some(warning => warning?.code === 'report_requires_review')
    && warnings.every(warning => REVIEWABLE_WARNING_CODES.has(warning?.code))
    && typeof handoff?.task?.taskId === 'string'
    && handoff.task.taskId === project?.taskId
    && String(snapshot?.documentVersion ?? '') === String(project?.version ?? '')
    && String(handoff?.latestDocumentVersion ?? '') === String(snapshot?.documentVersion ?? '')
    && typeof snapshot?.reportId === 'string'
    && snapshot.reportId.length > 0
    && typeof snapshot?.reportVersion === 'string'
    && snapshot.reportVersion.length > 0
    && Number.isFinite(Date.parse(snapshot?.generatedAt))
    && Number.isFinite(completeness)
    && completeness > 0
    && completeness <= 1
    && Number.isFinite(confidence)
    && confidence >= 0
    && confidence <= 1
    && projectChecksum !== null
    && projectChecksum === snapshotChecksum
  );
}

function reviewDeadlineAllowsDraft(value, now) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return true;
  const deadline = Date.parse(value);
  return Number.isFinite(deadline) && deadline > now;
}

function canGenerateReviewedDraft(project, now = Date.now()) {
  return Boolean(
    project?.current
    && project.humanDecision === 'follow'
    && reviewableSnapshot(project)
    && reviewDeadlineAllowsDraft(project?.input?.deadline, now)
    && assessmentAllowsReviewedDraft(project)
  );
}

function canGenerateDraft(project, now = Date.now()) {
  const handoff = project?.input?.handoff;
  const deadline = Date.parse(project?.input?.deadline);
  const ready = Boolean(
    project?.current
    && project.humanDecision === 'follow'
    && handoff?.status === 'ready'
    && handoff.superseded !== true
    && Array.isArray(handoff.warnings)
    && !handoff.warnings.some(warning => warning?.blocked === true)
    && Number.isFinite(deadline)
    && deadline > now
    && assessmentAllowsPlaceholderDraft(project.assessment)
  );
  return ready || canGenerateReviewedDraft(project, now);
}

module.exports = { PLACEHOLDER_REASONS, REVIEWABLE_WARNING_CODES, assessmentAllowsPlaceholderDraft, canGenerateReviewedDraft, canGenerateDraft };
