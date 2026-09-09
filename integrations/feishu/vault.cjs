'use strict';

const { createHash } = require('node:crypto');
const { readFileSync, realpathSync } = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const RECORD_COLUMNS = [
  'id',
  'kind',
  'name',
  'client',
  'category',
  'amount',
  'event_date',
  'cert_name',
  'specialty',
  'level',
  'cert_number',
  'issued_on',
  'expires_on',
  'permanent',
  'tags',
  'notes',
  'updated_at',
];

const ATTACHMENT_COLUMNS = [
  'id',
  'record_id',
  'name',
  'relative_path',
  'sha256',
  'position',
];

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function hasSupportedSignature(filename, bytes) {
  const extension = path.extname(filename).toLowerCase();
  if (extension === '.pdf') {
    return bytes.length >= 10 && bytes.subarray(0, 5).toString('ascii') === '%PDF-' && bytes.includes(Buffer.from('%%EOF'));
  }
  if (extension === '.png') {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (extension === '.jpg' || extension === '.jpeg') {
    return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
  }
  if (extension === '.tif' || extension === '.tiff') {
    const littleEndian = bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00]));
    const bigEndian = bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]));
    return littleEndian || bigEndian;
  }
  if (extension === '.bmp') {
    return bytes.length >= 2 && bytes.subarray(0, 2).toString('ascii') === 'BM';
  }
  return false;
}

function indexMappings(mappings) {
  if (!Array.isArray(mappings)) {
    throw new TypeError('mappings must be an array');
  }
  const indexed = new Map();
  const duplicates = new Set();
  for (const mapping of mappings) {
    if (!mapping || typeof mapping.recordId !== 'string') {
      continue;
    }
    if (indexed.has(mapping.recordId)) {
      duplicates.add(mapping.recordId);
    } else {
      indexed.set(mapping.recordId, mapping);
    }
  }
  return { indexed, duplicates };
}

function inspectAttachment({ attachment, filesRoot, mappedAttachment }) {
  const issues = [];
  const candidate = path.resolve(filesRoot, attachment.relative_path);
  let bytes;
  let actualSha256 = null;

  if (!isInside(filesRoot, candidate)) {
    issues.push('attachment_path_outside_root');
  } else {
    try {
      const actualPath = realpathSync.native(candidate);
      if (!isInside(filesRoot, actualPath)) {
        issues.push('attachment_path_outside_root');
      } else {
        bytes = readFileSync(actualPath);
      }
    } catch {
      issues.push('attachment_missing');
    }
  }

  if (bytes) {
    actualSha256 = hash(bytes);
    if (actualSha256 !== attachment.sha256) {
      issues.push('attachment_hash_mismatch');
    }
    if (!hasSupportedSignature(attachment.relative_path || attachment.name, bytes)) {
      issues.push('attachment_invalid');
    }
  }

  if (!mappedAttachment) {
    issues.push('attachment_mapping_missing');
  } else {
    if (mappedAttachment.verified !== true) {
      issues.push('attachment_mapping_unverified');
    }
    if (mappedAttachment.sha256 !== attachment.sha256) {
      issues.push('attachment_mapping_hash_mismatch');
    }
  }

  return {
    ...attachment,
    actualSha256,
    verified: issues.length === 0,
    verificationIssues: [...new Set(issues)],
  };
}

function readVaultSnapshot({ databasePath, filesRoot, mappings = [], companyId }) {
  if (typeof databasePath !== 'string' || databasePath.length === 0) {
    throw new TypeError('databasePath is required');
  }
  if (typeof filesRoot !== 'string' || filesRoot.length === 0) {
    throw new TypeError('filesRoot is required');
  }
  if (typeof companyId !== 'string' || companyId.length === 0) {
    throw new TypeError('companyId is required');
  }

  const root = realpathSync.native(path.resolve(filesRoot));
  const { indexed: mappingByRecordId, duplicates } = indexMappings(mappings);
  const db = new DatabaseSync(databasePath, { readOnly: true });
  let rows;
  let attachmentRows;
  try {
    db.exec('PRAGMA query_only = ON; BEGIN');
    rows = db.prepare(`SELECT ${RECORD_COLUMNS.join(', ')} FROM records ORDER BY updated_at DESC, rowid DESC`).all();
    attachmentRows = db.prepare(`SELECT ${ATTACHMENT_COLUMNS.join(', ')} FROM attachments ORDER BY record_id, position, rowid`).all();
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The read transaction may not have started.
    }
    throw error;
  } finally {
    db.close();
  }

  const attachmentsByRecordId = new Map();
  for (const attachment of attachmentRows) {
    const list = attachmentsByRecordId.get(attachment.record_id) ?? [];
    list.push(attachment);
    attachmentsByRecordId.set(attachment.record_id, list);
  }

  const warnings = [];
  const records = rows.map((row) => {
    const mapping = mappingByRecordId.get(row.id);
    const issues = [];
    if (duplicates.has(row.id)) {
      issues.push('mapping_conflict');
    }
    if (!mapping) {
      issues.push('mapping_missing');
    } else {
      if (mapping.verified !== true) {
        issues.push('mapping_unverified');
      }
      if (mapping.companyId !== companyId) {
        issues.push('company_mismatch');
      }
      if (mapping.updatedAt !== row.updated_at) {
        issues.push('record_updated_at_mismatch');
      }
    }

    const mappedAttachments = new Map();
    if (Array.isArray(mapping?.attachments)) {
      for (const attachment of mapping.attachments) {
        if (attachment && typeof attachment.id === 'string' && !mappedAttachments.has(attachment.id)) {
          mappedAttachments.set(attachment.id, attachment);
        }
      }
    }
    const attachments = (attachmentsByRecordId.get(row.id) ?? []).map((attachment) =>
      inspectAttachment({
        attachment,
        filesRoot: root,
        mappedAttachment: mappedAttachments.get(attachment.id),
      }),
    );
    if (attachments.length === 0) {
      issues.push('attachment_missing');
    }
    for (const attachment of attachments) {
      issues.push(...attachment.verificationIssues);
    }

    const verificationIssues = [...new Set(issues)];
    if (verificationIssues.length > 0) {
      warnings.push(`${row.id}:${verificationIssues.join(',')}`);
    }
    return {
      ...row,
      companyId: mapping?.companyId ?? null,
      verified: verificationIssues.length === 0,
      verificationIssues,
      attachments,
    };
  });

  return { records, warnings };
}

module.exports = { readVaultSnapshot };
