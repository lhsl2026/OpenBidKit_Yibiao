'use strict';

const { createHash } = require('node:crypto');

const stable = value => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
};
const compact = values => [...new Set(values.flatMap(value => String(value ?? '').split(/[，,;；\s]+/u)).map(value => value.trim()).filter(Boolean))].sort();
const evidencePath = row => (row.attachments ?? []).find(item => item.verified === true)?.relative_path;
const isTargetRecord = (row, companyId) => row.companyId == null || row.companyId === companyId;
const isVerified = (row, companyId) => row.companyId === companyId && row.verified === true && Array.isArray(row.attachments) && row.attachments.length > 0 && row.attachments.every(item => item.verified === true);

function buildCompanyEvidenceProfile(snapshot, { companyId, employmentEvidence = {} } = {}) {
  if (!companyId || companyId !== '隆创信息有限公司') throw Error('company_evidence_subject_invalid');
  if (!Array.isArray(snapshot?.records)) throw Error('company_evidence_snapshot_invalid');
  const rows = snapshot.records;
  const excluded = rows.filter(row => row.companyId != null && row.companyId !== companyId).length;
  const included = rows.filter(row => isTargetRecord(row, companyId));

  const performances = included.filter(row => row.kind === 'performance').map(row => {
    const verified = isVerified(row, companyId);
    const path = evidencePath(row);
    return {
      id: row.id,
      name: row.name,
      tags: compact([row.category, row.client, row.tags]),
      verified,
      ...(path ? { evidencePath: path } : {}),
    };
  }).sort((left, right) => left.id.localeCompare(right.id));

  const qualifications = included.filter(row => ['qualification', 'company_certificate'].includes(row.kind)).map(row => {
    const verified = isVerified(row, companyId);
    const path = evidencePath(row);
    return {
      id: row.id,
      category: row.category || 'certificate',
      name: row.cert_name || row.name,
      aliases: compact([row.tags]),
      ...(row.level ? { level: row.level } : {}),
      ...(row.cert_number ? { certificateNo: row.cert_number } : {}),
      ...(row.expires_on ? { validUntil: row.expires_on } : {}),
      verified,
      ...(path ? { evidencePath: path } : {}),
    };
  }).sort((left, right) => left.id.localeCompare(right.id));

  const groupedPersonnel = new Map();
  for (const row of included.filter(item => item.kind === 'certificate')) {
    const name = String(row.name ?? '').trim();
    if (!name) continue;
    const current = groupedPersonnel.get(name) ?? { rows: [], roles: [], certificates: [], paths: [] };
    current.rows.push(row);
    current.roles.push(...compact([row.tags, row.specialty]));
    current.certificates.push(row.cert_name || row.name);
    const path = evidencePath(row); if (path) current.paths.push(path);
    groupedPersonnel.set(name, current);
  }
  const personnel = [...groupedPersonnel].map(([name, value]) => {
    const employment = employmentEvidence[name];
    const verified = employment?.verified === true && value.rows.length > 0 && value.rows.every(row => isVerified(row, companyId));
    const path = verified ? employment.evidencePath || value.paths[0] : value.paths[0];
    return {
      id: `person:${createHash('sha256').update(name).digest('hex').slice(0, 24)}`,
      name,
      roles: compact(value.roles),
      certificates: compact(value.certificates),
      verified,
      ...(path ? { evidencePath: path } : {}),
    };
  }).sort((left, right) => left.id.localeCompare(right.id));

  const content = { id: companyId, name: companyId, qualifications, performances, personnel };
  const profileVersion = createHash('sha256').update(JSON.stringify(stable(content))).digest('hex');
  const collection = { version: 1, defaultCompanyId: companyId, companies: [{ ...content, profileVersion }] };
  return {
    collection,
    coverage: {
      records: { total: rows.length, included: included.length },
      performances: { total: performances.length, verified: performances.filter(item => item.verified).length, review: performances.filter(item => !item.verified).length },
      qualifications: { total: qualifications.length, verified: qualifications.filter(item => item.verified).length, review: qualifications.filter(item => !item.verified).length },
      personnel: { total: personnel.length, verified: personnel.filter(item => item.verified).length, employmentVerified: Object.values(employmentEvidence).filter(item => item?.verified === true).length },
      excludedCompanyMismatch: excluded,
    },
  };
}

function createCompanyEvidenceSync({ store, client, companyId }) {
  if (!store || !client || !companyId) throw Error('company_profile_sync_not_configured');
  const stateKey = `company-profile-sync:${companyId}`;
  let current = store.get(stateKey);
  return {
    async replace(built) {
      const profileVersion = built?.collection?.companies?.[0]?.profileVersion;
      if (!profileVersion || built.collection.defaultCompanyId !== companyId) throw Error('company_profile_sync_invalid');
      if (current?.profileVersion === profileVersion && current?.ready === true) {
        current = { ...current, coverage: built.coverage };
        return current;
      }
      try {
        const result = await client.replaceCompanyProfiles(built.collection);
        if (result?.status !== 'company_profiles_imported' || result.companyCount !== 1 || result.defaultCompanyId !== companyId) throw Error('company_profile_sync_invalid_receipt');
        current = { ready: true, profileVersion, coverage: built.coverage };
        store.set(stateKey, current);
        return current;
      } catch {
        current = { ready: false, error: 'company_profile_sync_failed' };
        throw Error('company_profile_sync_failed');
      }
    },
    status() {
      return current ?? { ready: false, error: 'company_profile_sync_pending' };
    },
  };
}

module.exports = { buildCompanyEvidenceProfile, createCompanyEvidenceSync };
