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

function assessmentAllowsPlaceholderDraft(assessment) {
  if (assessment?.decision === 'follow') return true;
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
  return assessment.blockers.every(blocker => allowedBlockers.has(blocker));
}

function canGenerateDraft(project, now = Date.now()) {
  const handoff = project?.input?.handoff;
  const deadline = Date.parse(project?.input?.deadline);
  return Boolean(
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
}

module.exports = { PLACEHOLDER_REASONS, assessmentAllowsPlaceholderDraft, canGenerateDraft };
