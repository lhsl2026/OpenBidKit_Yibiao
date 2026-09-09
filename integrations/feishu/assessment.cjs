'use strict';

const CRITICAL_CATEGORIES = new Set(['qualification', 'redline']);
const RULE_KINDS = new Set(['certificate', 'performance', 'manual']);
const SHA256_PATTERN = /^(?:sha256:)?[0-9a-f]{64}$/i;

const ASSESSMENT_LABELS = Object.freeze({
  actions: Object.freeze({
    confirm_follow: '确认跟进',
    defer: '暂缓',
    reject: '不投',
    generate_draft: '生成初稿',
    request_verification: '补充或核实资料',
    record_rejection: '记录不投原因',
  }),
  blockers: Object.freeze({
    handoff_missing: '缺少预读交接快照',
    handoff_schema_unsupported: '预读交接版本不受支持',
    handoff_task_id_missing: '预读交接缺少任务编号',
    handoff_snapshot_missing: '预读交接缺少版本快照',
    handoff_snapshot_reportId_missing: '预读交接缺少报告编号',
    handoff_snapshot_reportVersion_missing: '预读交接缺少报告版本',
    handoff_snapshot_documentVersion_missing: '预读交接缺少文件版本',
    handoff_snapshot_checksum_missing: '预读交接缺少文件校验值',
    handoff_snapshot_checksum_invalid: '预读交接文件校验值格式无效',
    handoff_snapshot_generatedAt_missing: '预读交接缺少生成时间',
    handoff_snapshot_completeness_invalid: '预读交接完整度无效',
    handoff_snapshot_incomplete: '预读交接关键资料不完整',
    handoff_snapshot_confidence_invalid: '预读交接置信度无效',
    handoff_snapshot_confidence_low: '预读交接置信度不足',
    handoff_status_invalid: '预读交接状态无效',
    handoff_needs_manual: '预读仍有事项需要人工处理',
    handoff_invalid: '预读交接无效',
    handoff_requirements_invalid: '预读条款列表无效',
    handoff_requirement_id_invalid: '预读条款编号缺失或重复',
    handoff_warnings_invalid: '预读交接警告列表无效',
    handoff_warning_blocked: '预读交接仍有人工阻塞事项',
    handoff_superseded_invalid: '预读交接的新旧版本标记无效',
    handoff_latest_document_version_missing: '预读交接缺少最新文件版本',
    handoff_superseded: '预读交接已被新文件版本替代',
    deadline_invalid: '投标截止时间无效',
    deadline_passed: '投标截止时间已过',
    now_invalid: '当前时间无效',
    company_id_missing: '缺少公司主体标识',
    snapshot_invalid: '公司资料快照无效',
    rules_invalid: '判标规则列表无效',
    structured_rule_invalid: '判标规则无效',
  }),
  reasons: Object.freeze({
    structured_rule_missing: '该资格或废标条款尚未配置结构化规则',
    structured_rule_invalid: '结构化规则无效',
    requirement_confirmation_pending: '该关键条款原文仍待人工确认',
    requirement_confidence_invalid: '该关键条款置信度无效',
    requirement_confidence_low: '该关键条款置信度不足',
    verified_evidence_missing: '尚未找到已核实的公司证据',
    manual_result_unverified: '人工结论尚未核实',
    manual_result_not_satisfied: '人工已确认不满足该条款',
    manual_result_unknown: '人工结论未知',
    certificate_issue_date_unknown: '证照签发日期未知',
    certificate_issue_date_invalid: '证照签发日期无效',
    certificate_not_issued_at_deadline: '证照在投标截止日尚未签发',
    certificate_expiry_unknown: '证照有效期未知',
    certificate_expiry_invalid: '证照有效期无效',
    certificate_expired_at_deadline: '证照在投标截止日前失效',
    certificate_holder_unknown: '证照持有人未知',
    certificate_holder_count_insufficient: '去重后的有效持证人数不足',
    performance_amount_invalid: '业绩金额无效',
    performance_amount_unknown: '业绩金额未知',
    performance_amount_insufficient: '业绩金额不足',
    performance_date_unknown: '业绩日期未知',
    performance_date_invalid: '业绩日期无效',
    performance_date_after_deadline: '业绩日期晚于投标截止日',
    performance_date_too_early: '业绩日期早于要求范围',
    performance_date_too_late: '业绩日期晚于要求范围',
    performance_duplicate_evidence: '重复台账记录不能作为多项独立业绩',
    performance_identity_ambiguous: '无法确认多条业绩记录对应独立合同',
    performance_count_insufficient: '符合条件的业绩数量不足',
    requirement_missing: '规则引用的预读条款不存在',
    duplicate_rule: '同一预读条款配置了重复规则',
    deadline_invalid: '投标截止时间无效',
  }),
});

const CARD_ASSESSMENT_LABELS = Object.freeze({
  ...ASSESSMENT_LABELS.actions,
  ...ASSESSMENT_LABELS.blockers,
  ...ASSESSMENT_LABELS.reasons,
  ...ASSESSMENT_LABELS,
});

function unique(values) {
  return [...new Set(values)];
}

function normalized(value) {
  return String(value ?? '').trim().toLocaleLowerCase('zh-CN');
}

function validConfidence(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function parseTimestamp(value) {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const [year, month, day] = value.split('-').map(Number);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return value;
}

function deadlineDate(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) && parseTimestamp(value) !== null) {
    return parseDate(value.slice(0, 10));
  }
  const timestamp = parseTimestamp(value);
  return timestamp === null ? null : new Date(timestamp).toISOString().slice(0, 10);
}

function selectedByRule(record, rule) {
  return rule.recordIds === undefined || rule.recordIds.includes(record.id);
}

function recordSelectorIsValid(rule) {
  if (rule.recordIds === undefined) {
    return true;
  }
  return Array.isArray(rule.recordIds)
    && rule.recordIds.every((id) => typeof id === 'string' && id.length > 0)
    && new Set(rule.recordIds).size === rule.recordIds.length;
}

function recordIsVerified(record, companyId) {
  return record?.verified === true
    && record.companyId === companyId
    && Array.isArray(record.attachments)
    && record.attachments.length > 0
    && record.attachments.every((attachment) => attachment.verified === true);
}

function performanceIdentity(record) {
  const attachmentHashes = unique(
    record.attachments
      .map((attachment) => attachment.actualSha256 ?? attachment.sha256)
      .filter((value) => typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value))
      .map((value) => value.toLowerCase()),
  );
  const amount = Number(record.amount);
  const fields = [record.name, record.client, record.category, record.event_date]
    .map((value) => normalized(value).replace(/\s+/gu, ' '));
  const composite = fields.every(Boolean) && Number.isFinite(amount)
    ? [...fields, String(amount)].join('\u0000')
    : null;
  return { attachmentHashes, composite };
}

function distinctPerformanceEvidence(records) {
  if (records.length === 0) {
    return { count: 0, duplicate: false, ambiguous: false };
  }
  const identities = records.map(performanceIdentity);
  const parent = records.map((_, index) => index);
  const find = (index) => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const join = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) {
      parent[rightRoot] = leftRoot;
    }
  };

  for (let left = 0; left < identities.length; left += 1) {
    for (let right = left + 1; right < identities.length; right += 1) {
      const sharedAttachment = identities[left].attachmentHashes.some((digest) =>
        identities[right].attachmentHashes.includes(digest));
      const sameComposite = identities[left].composite !== null
        && identities[left].composite === identities[right].composite;
      if (sharedAttachment || sameComposite) {
        join(left, right);
      }
    }
  }

  const groups = new Map();
  for (let index = 0; index < records.length; index += 1) {
    const root = find(index);
    const group = groups.get(root) ?? [];
    group.push(index);
    groups.set(root, group);
  }
  const reliableGroups = [...groups.values()].filter((group) =>
    group.some((index) => identities[index].attachmentHashes.length > 0 || identities[index].composite !== null));
  const ambiguousRecords = identities.filter((identity) =>
    identity.attachmentHashes.length === 0 && identity.composite === null).length;
  return {
    count: reliableGroups.length > 0 ? reliableGroups.length : ambiguousRecords > 0 ? 1 : 0,
    duplicate: [...groups.values()].some((group) => group.length > 1),
    ambiguous: ambiguousRecords > 0 && records.length > 1,
  };
}

function itemFor(requirement, rule) {
  return {
    requirementId: requirement?.id ?? rule?.requirementId ?? null,
    key: requirement?.key ?? '',
    category: requirement?.category ?? '',
    status: 'review',
    evidenceRecordIds: [],
    reasons: [],
  };
}

function assessManual(requirement, rule) {
  const item = itemFor(requirement, rule);
  if (rule.verified !== true) {
    item.reasons.push('manual_result_unverified');
  } else if (rule.result === 'satisfied') {
    item.status = 'satisfied';
  } else if (rule.result === 'not_satisfied') {
    item.status = 'not_satisfied';
    item.reasons.push('manual_result_not_satisfied');
  } else {
    item.reasons.push('manual_result_unknown');
  }
  return item;
}

function assessCertificate(requirement, rule, records, companyId, bidDate) {
  const item = itemFor(requirement, rule);
  const expectedCount = rule.minCount === undefined ? 1 : Number(rule.minCount);
  if (!recordSelectorIsValid(rule) || !Number.isInteger(expectedCount) || expectedCount < 1) {
    item.reasons.push('structured_rule_invalid');
    return item;
  }

  const candidates = records.filter((record) => {
    if (record.kind !== 'certificate' || !selectedByRule(record, rule)) {
      return false;
    }
    if (rule.certName !== undefined && normalized(record.cert_name) !== normalized(rule.certName)) {
      return false;
    }
    if (rule.specialty !== undefined && normalized(record.specialty) !== normalized(rule.specialty)) {
      return false;
    }
    if (rule.level !== undefined && normalized(record.level) !== normalized(rule.level)) {
      return false;
    }
    return true;
  });
  item.evidenceRecordIds = candidates.map((record) => record.id);

  const valid = [];
  for (const record of candidates) {
    if (!recordIsVerified(record, companyId)) {
      item.reasons.push('verified_evidence_missing');
      continue;
    }
    const issuedOn = parseDate(record.issued_on);
    if (!record.issued_on) {
      item.reasons.push('certificate_issue_date_unknown');
      continue;
    }
    if (!issuedOn) {
      item.reasons.push('certificate_issue_date_invalid');
      continue;
    }
    if (issuedOn > bidDate) {
      item.reasons.push('certificate_not_issued_at_deadline');
      continue;
    }
    if (!record.permanent) {
      const expiresOn = parseDate(record.expires_on);
      if (!record.expires_on) {
        item.reasons.push('certificate_expiry_unknown');
        continue;
      }
      if (!expiresOn) {
        item.reasons.push('certificate_expiry_invalid');
        continue;
      }
      if (expiresOn < bidDate) {
        item.reasons.push('certificate_expired_at_deadline');
        continue;
      }
    }
    if (!normalized(record.name)) {
      item.reasons.push('certificate_holder_unknown');
      continue;
    }
    valid.push(record);
  }

  const uniqueHolders = new Set(valid.map((record) => normalized(record.name)));
  if (uniqueHolders.size >= expectedCount) {
    item.status = 'satisfied';
    item.reasons = [];
  } else {
    if (candidates.length === 0) {
      item.reasons.push('verified_evidence_missing');
    }
    if (expectedCount > 1 || valid.length > 0) {
      item.reasons.push('certificate_holder_count_insufficient');
    }
  }
  item.reasons = unique(item.reasons);
  return item;
}

function assessPerformance(requirement, rule, records, companyId, bidDate) {
  const item = itemFor(requirement, rule);
  const expectedCount = rule.minCount === undefined ? 1 : Number(rule.minCount);
  const minimumAmount = rule.minAmount === undefined ? null : Number(rule.minAmount);
  const fromDate = rule.fromDate === undefined ? null : parseDate(rule.fromDate);
  const toDate = rule.toDate === undefined ? null : parseDate(rule.toDate);
  if (
    !recordSelectorIsValid(rule)
    || !Number.isInteger(expectedCount)
    || expectedCount < 1
    || (rule.minAmount !== undefined && (!Number.isFinite(minimumAmount) || minimumAmount < 0))
    || (rule.fromDate !== undefined && fromDate === null)
    || (rule.toDate !== undefined && toDate === null)
    || (fromDate && toDate && fromDate > toDate)
  ) {
    item.reasons.push('structured_rule_invalid');
    return item;
  }

  const candidates = records.filter((record) => {
    if (record.kind !== 'performance' || !selectedByRule(record, rule)) {
      return false;
    }
    return rule.category === undefined || normalized(record.category) === normalized(rule.category);
  });
  item.evidenceRecordIds = candidates.map((record) => record.id);

  const validRecords = [];
  for (const record of candidates) {
    if (!recordIsVerified(record, companyId)) {
      item.reasons.push('verified_evidence_missing');
      continue;
    }

    let recordIsValid = true;
    const amount = record.amount === '' || record.amount === null || record.amount === undefined
      ? null
      : Number(record.amount);
    if (amount !== null && (!Number.isFinite(amount) || amount < 0)) {
      item.reasons.push('performance_amount_invalid');
      recordIsValid = false;
    }
    if (minimumAmount !== null && amount === null) {
      item.reasons.push('performance_amount_unknown');
      recordIsValid = false;
    }
    if (minimumAmount !== null && Number.isFinite(amount) && amount < minimumAmount) {
      item.reasons.push('performance_amount_insufficient');
      recordIsValid = false;
    }

    const eventDate = parseDate(record.event_date);
    if (!record.event_date) {
      item.reasons.push('performance_date_unknown');
      recordIsValid = false;
    } else if (!eventDate) {
      item.reasons.push('performance_date_invalid');
      recordIsValid = false;
    } else if (eventDate > bidDate) {
      item.reasons.push('performance_date_after_deadline');
      recordIsValid = false;
    } else if (fromDate && eventDate < fromDate) {
      item.reasons.push('performance_date_too_early');
      recordIsValid = false;
    } else if (toDate && eventDate > toDate) {
      item.reasons.push('performance_date_too_late');
      recordIsValid = false;
    }
    if (recordIsValid) {
      validRecords.push(record);
    }
  }

  const distinct = distinctPerformanceEvidence(validRecords);
  if (distinct.count >= expectedCount) {
    item.status = 'satisfied';
    item.reasons = [];
  } else {
    if (distinct.duplicate) {
      item.reasons.push('performance_duplicate_evidence');
    }
    if (distinct.ambiguous) {
      item.reasons.push('performance_identity_ambiguous');
    }
    if (candidates.length === 0) {
      item.reasons.push('verified_evidence_missing');
    }
    if (distinct.count > 0 || expectedCount > 1) {
      item.reasons.push('performance_count_insufficient');
    }
  }
  item.reasons = unique(item.reasons);
  return item;
}

function validateHandoff(handoff) {
  const blockers = [];
  if (!handoff || typeof handoff !== 'object') {
    return ['handoff_missing'];
  }
  if (handoff.schemaVersion !== '1.0') {
    blockers.push('handoff_schema_unsupported');
  }
  if (!handoff.task || typeof handoff.task.taskId !== 'string' || handoff.task.taskId.length === 0) {
    blockers.push('handoff_task_id_missing');
  }
  if (!handoff.snapshot || typeof handoff.snapshot !== 'object') {
    blockers.push('handoff_snapshot_missing');
  } else {
    for (const field of ['reportId', 'reportVersion', 'documentVersion', 'checksum', 'generatedAt']) {
      if (typeof handoff.snapshot[field] !== 'string' || handoff.snapshot[field].length === 0) {
        blockers.push(`handoff_snapshot_${field}_missing`);
      }
    }
    if (
      typeof handoff.snapshot.checksum === 'string'
      && handoff.snapshot.checksum.length > 0
      && !SHA256_PATTERN.test(handoff.snapshot.checksum)
    ) {
      blockers.push('handoff_snapshot_checksum_invalid');
    }
    if (!validConfidence(handoff.snapshot.completeness)) {
      blockers.push('handoff_snapshot_completeness_invalid');
    } else if (handoff.snapshot.completeness < 1) {
      blockers.push('handoff_snapshot_incomplete');
    }
    if (!validConfidence(handoff.snapshot.confidence)) {
      blockers.push('handoff_snapshot_confidence_invalid');
    } else if (handoff.snapshot.confidence < 0.8) {
      blockers.push('handoff_snapshot_confidence_low');
    }
  }
  if (!['ready', 'needs_manual', 'invalid'].includes(handoff.status)) {
    blockers.push('handoff_status_invalid');
  } else if (handoff.status !== 'ready') {
    blockers.push(`handoff_${handoff.status}`);
  }
  if (!Array.isArray(handoff.requirements)) {
    blockers.push('handoff_requirements_invalid');
  }
  if (!Array.isArray(handoff.warnings)
    || handoff.warnings.some((warning) => !warning || typeof warning !== 'object' || typeof warning.blocked !== 'boolean')) {
    blockers.push('handoff_warnings_invalid');
  } else if (handoff.warnings.some((warning) => warning.blocked)) {
    blockers.push('handoff_warning_blocked');
  }
  if (typeof handoff.superseded !== 'boolean') {
    blockers.push('handoff_superseded_invalid');
  } else if (handoff.superseded) {
    blockers.push('handoff_superseded');
  }
  if (typeof handoff.latestDocumentVersion !== 'string' || handoff.latestDocumentVersion.length === 0) {
    blockers.push('handoff_latest_document_version_missing');
  } else if (handoff.snapshot && handoff.latestDocumentVersion !== handoff.snapshot.documentVersion) {
    blockers.push('handoff_superseded');
  }
  return blockers;
}

function actionsFor(decision) {
  if (decision === 'follow') {
    return ['confirm_follow', 'defer', 'reject', 'generate_draft'];
  }
  if (decision === 'review') {
    return ['request_verification', 'defer', 'reject'];
  }
  return ['record_rejection'];
}

function assessTender({ handoff, rules = [], snapshot, companyId, deadline, now = new Date() }) {
  const blockers = validateHandoff(handoff);
  const items = [];
  const deadlineTimestamp = parseTimestamp(deadline);
  const nowTimestamp = parseTimestamp(now);
  const bidDate = deadlineDate(deadline);
  if (deadlineTimestamp === null || bidDate === null) {
    blockers.push('deadline_invalid');
  }
  if (nowTimestamp === null) {
    blockers.push('now_invalid');
  }
  if (typeof companyId !== 'string' || companyId.length === 0) {
    blockers.push('company_id_missing');
  }
  if (!snapshot || !Array.isArray(snapshot.records)) {
    blockers.push('snapshot_invalid');
  }
  if (!Array.isArray(rules)) {
    blockers.push('rules_invalid');
    rules = [];
  }

  if (deadlineTimestamp !== null && nowTimestamp !== null && nowTimestamp > deadlineTimestamp) {
    blockers.push('deadline_passed');
    return {
      decision: 'reject',
      items,
      blockers: unique(blockers),
      actions: actionsFor('reject'),
    };
  }

  const requirements = Array.isArray(handoff?.requirements) ? handoff.requirements : [];
  const requirementById = new Map();
  for (const requirement of requirements) {
    if (!requirement || typeof requirement.id !== 'string' || requirement.id.length === 0 || requirementById.has(requirement.id)) {
      blockers.push('handoff_requirement_id_invalid');
      continue;
    }
    requirementById.set(requirement.id, requirement);
  }

  const rulesByRequirementId = new Map();
  for (const rule of rules) {
    if (!rule || typeof rule.requirementId !== 'string' || !RULE_KINDS.has(rule.kind)) {
      blockers.push('structured_rule_invalid');
      continue;
    }
    if (!requirementById.has(rule.requirementId)) {
      blockers.push(`${rule.requirementId}:requirement_missing`);
      continue;
    }
    if (rulesByRequirementId.has(rule.requirementId)) {
      blockers.push(`${rule.requirementId}:duplicate_rule`);
      continue;
    }
    rulesByRequirementId.set(rule.requirementId, rule);
  }

  const records = Array.isArray(snapshot?.records) ? snapshot.records : [];
  for (const requirement of requirements) {
    const rule = rulesByRequirementId.get(requirement.id);
    const critical = CRITICAL_CATEGORIES.has(normalized(requirement.category));
    const confirmationReasons = [];
    if (critical) {
      if (requirement.requiresConfirmation !== false) {
        confirmationReasons.push('requirement_confirmation_pending');
      }
      if (!validConfidence(requirement.confidence)) {
        confirmationReasons.push('requirement_confidence_invalid');
      } else if (requirement.confidence < 0.8) {
        confirmationReasons.push('requirement_confidence_low');
      }
    }
    if (!rule) {
      if (critical) {
        const item = itemFor(requirement, null);
        item.reasons.push(...confirmationReasons, 'structured_rule_missing');
        items.push(item);
      }
      continue;
    }
    if (confirmationReasons.length > 0) {
      const item = itemFor(requirement, rule);
      item.reasons.push(...confirmationReasons);
      items.push(item);
      continue;
    }
    if (!bidDate) {
      const item = itemFor(requirement, rule);
      item.reasons.push('deadline_invalid');
      items.push(item);
      continue;
    }
    if (rule.kind === 'manual') {
      items.push(assessManual(requirement, rule));
    } else if (rule.kind === 'certificate') {
      items.push(assessCertificate(requirement, rule, records, companyId, bidDate));
    } else {
      items.push(assessPerformance(requirement, rule, records, companyId, bidDate));
    }
  }

  for (const item of items) {
    if (item.status !== 'satisfied') {
      for (const reason of item.reasons) {
        blockers.push(`${item.requirementId}:${reason}`);
      }
    }
  }

  const explicitNegative = items.some((item) => item.status === 'not_satisfied');
  const decision = explicitNegative
    ? 'reject'
    : blockers.length === 0 && items.every((item) => item.status === 'satisfied')
      ? 'follow'
      : 'review';
  return {
    decision,
    items,
    blockers: unique(blockers),
    actions: actionsFor(decision),
  };
}

module.exports = { ASSESSMENT_LABELS: CARD_ASSESSMENT_LABELS, assessTender };
