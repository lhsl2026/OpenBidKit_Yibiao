'use strict';

const { createHash } = require('node:crypto');
const {
  closeSync,
  openSync,
  readSync,
  realpathSync,
} = require('node:fs');
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

const ATTACHMENT_CHUNK_BYTES = 1024 * 1024;
const SIGNATURE_HEADER_BYTES = 8;
const PDF_EOF = Buffer.from('%%EOF');

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function rollingWindow(previous, bytes, limit) {
  if (bytes.length >= limit) {
    return Buffer.from(bytes.subarray(bytes.length - limit));
  }
  const previousLength = Math.min(previous.length, limit - bytes.length);
  const window = Buffer.allocUnsafe(previousLength + bytes.length);
  previous.copy(window, 0, previous.length - previousLength);
  bytes.copy(window, previousLength);
  return window;
}

function hasSupportedSignature(filename, inspection) {
  const extension = path.extname(filename).toLowerCase();
  const { bytesRead, header, tail, hasPdfEof } = inspection;
  if (extension === '.pdf') {
    return bytesRead >= 10 && header.subarray(0, 5).toString('ascii') === '%PDF-' && hasPdfEof;
  }
  if (extension === '.png') {
    return bytesRead >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (extension === '.jpg' || extension === '.jpeg') {
    return bytesRead >= 4 && header[0] === 0xff && header[1] === 0xd8 && tail[0] === 0xff && tail[1] === 0xd9;
  }
  if (extension === '.tif' || extension === '.tiff') {
    const littleEndian = bytesRead >= 4 && header.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00]));
    const bigEndian = bytesRead >= 4 && header.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]));
    return littleEndian || bigEndian;
  }
  if (extension === '.bmp') {
    return bytesRead >= 2 && header.subarray(0, 2).toString('ascii') === 'BM';
  }
  return false;
}

function inspectAttachmentFile(filename, filePath) {
  const descriptor = openSync(filePath, 'r');
  const digest = createHash('sha256');
  const buffer = Buffer.allocUnsafe(ATTACHMENT_CHUNK_BYTES);
  const header = Buffer.alloc(SIGNATURE_HEADER_BYTES);
  let headerLength = 0;
  let tail = Buffer.alloc(0);
  let pdfBoundary = Buffer.alloc(0);
  let hasPdfEof = false;
  let bytesRead = 0;
  try {
    while (true) {
      const length = readSync(descriptor, buffer, 0, buffer.length, null);
      if (length === 0) break;
      const bytes = buffer.subarray(0, length);
      digest.update(bytes);
      bytesRead += length;
      if (headerLength < SIGNATURE_HEADER_BYTES) {
        const copyLength = Math.min(SIGNATURE_HEADER_BYTES - headerLength, length);
        bytes.copy(header, headerLength, 0, copyLength);
        headerLength += copyLength;
      }
      if (!hasPdfEof) {
        hasPdfEof = bytes.includes(PDF_EOF);
        if (!hasPdfEof && pdfBoundary.length > 0) {
          const prefixLength = Math.min(PDF_EOF.length - 1, length);
          const boundary = Buffer.allocUnsafe(pdfBoundary.length + prefixLength);
          pdfBoundary.copy(boundary);
          bytes.copy(boundary, pdfBoundary.length, 0, prefixLength);
          hasPdfEof = boundary.includes(PDF_EOF);
        }
      }
      pdfBoundary = rollingWindow(pdfBoundary, bytes, PDF_EOF.length - 1);
      tail = rollingWindow(tail, bytes, 2);
    }
  } finally {
    closeSync(descriptor);
  }
  const inspection = { bytesRead, header, tail, hasPdfEof };
  return {
    actualSha256: digest.digest('hex'),
    supportedSignature: hasSupportedSignature(filename, inspection),
  };
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

function inspectAttachment({ attachment, filesRoot, mappedAttachment, inspectFile = true }) {
  const issues = [];
  let actualSha256 = null;
  let supportedSignature = false;

  if (!inspectFile) {
    issues.push('attachment_not_inspected');
  } else {
    const candidate = path.resolve(filesRoot, attachment.relative_path);
    if (!isInside(filesRoot, candidate)) {
      issues.push('attachment_path_outside_root');
    } else {
      try {
        const actualPath = realpathSync.native(candidate);
        if (!isInside(filesRoot, actualPath)) {
          issues.push('attachment_path_outside_root');
        } else {
          const inspection = inspectAttachmentFile(
            attachment.relative_path || attachment.name,
            actualPath,
          );
          actualSha256 = inspection.actualSha256;
          supportedSignature = inspection.supportedSignature;
        }
      } catch {
        issues.push('attachment_missing');
      }
    }
  }

  if (actualSha256) {
    if (actualSha256 !== attachment.sha256) {
      issues.push('attachment_hash_mismatch');
    }
    if (!supportedSignature) {
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

function readVaultSnapshot({ databasePath, filesRoot, mappings = [], companyId, onlyMapped = false }) {
  if (typeof databasePath !== 'string' || databasePath.length === 0) {
    throw new TypeError('databasePath is required');
  }
  if (typeof filesRoot !== 'string' || filesRoot.length === 0) {
    throw new TypeError('filesRoot is required');
  }
  if (typeof companyId !== 'string' || companyId.length === 0) {
    throw new TypeError('companyId is required');
  }
  if (typeof onlyMapped !== 'boolean') {
    throw new TypeError('onlyMapped must be a boolean');
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
    const recordCanBeVerified = !duplicates.has(row.id)
      && mapping?.verified === true
      && mapping.companyId === companyId
      && mapping.updatedAt === row.updated_at;
    const attachments = (attachmentsByRecordId.get(row.id) ?? []).map((attachment) =>
      inspectAttachment({
        attachment,
        filesRoot: root,
        mappedAttachment: mappedAttachments.get(attachment.id),
        inspectFile: !onlyMapped || (recordCanBeVerified && mappedAttachments.has(attachment.id)),
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
