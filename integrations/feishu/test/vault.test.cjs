'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { afterEach, test } = require('node:test');

const { readVaultSnapshot } = require('../vault.cjs');

const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function createVault(records) {
  const root = mkdtempSync(path.join(tmpdir(), 'feishu-vault-'));
  temporaryRoots.push(root);
  const filesRoot = root;
  mkdirSync(path.join(root, 'files'));
  const databasePath = path.join(root, 'vault.sqlite3');
  const db = new DatabaseSync(databasePath);
  db.exec(`
    CREATE TABLE records (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
      client TEXT DEFAULT '', category TEXT DEFAULT '', amount TEXT DEFAULT '',
      event_date TEXT DEFAULT '', cert_name TEXT DEFAULT '', specialty TEXT DEFAULT '',
      level TEXT DEFAULT '', cert_number TEXT DEFAULT '', issued_on TEXT DEFAULT '',
      expires_on TEXT DEFAULT '', permanent INTEGER DEFAULT 0, tags TEXT DEFAULT '',
      notes TEXT DEFAULT '', updated_at TEXT NOT NULL
    );
    CREATE TABLE attachments (
      id TEXT PRIMARY KEY,
      record_id TEXT REFERENCES records(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      position INTEGER NOT NULL,
      UNIQUE(record_id, sha256)
    );
  `);

  const insertRecord = db.prepare(`
    INSERT INTO records (
      id, kind, name, client, category, amount, event_date, cert_name,
      specialty, level, cert_number, issued_on, expires_on, permanent,
      tags, notes, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAttachment = db.prepare(`
    INSERT INTO attachments (id, record_id, name, relative_path, sha256, position)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const record of records) {
    insertRecord.run(
      record.id,
      record.kind,
      record.name,
      record.client ?? '',
      record.category ?? '',
      record.amount ?? '',
      record.eventDate ?? '',
      record.certName ?? '',
      record.specialty ?? '',
      record.level ?? '',
      record.certNumber ?? '',
      record.issuedOn ?? '',
      record.expiresOn ?? '',
      record.permanent ? 1 : 0,
      record.tags ?? '',
      record.notes ?? '',
      record.updatedAt,
    );
    for (const [position, attachment] of (record.attachments ?? []).entries()) {
      const relativePath = attachment.relativePath ?? `files/${attachment.id}.pdf`;
      if (!attachment.skipWrite) {
        const fullPath = path.resolve(root, relativePath);
        mkdirSync(path.dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, attachment.bytes);
      }
      insertAttachment.run(
        attachment.id,
        record.id,
        attachment.name ?? `${attachment.id}.pdf`,
        relativePath,
        attachment.storedSha256 ?? sha256(attachment.bytes ?? Buffer.alloc(0)),
        position,
      );
    }
  }
  db.close();
  return { databasePath, filesRoot, root };
}

function certificate(overrides = {}) {
  const bytes = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
  return {
    id: 'cert-1',
    kind: 'certificate',
    name: '测试人员甲',
    certName: '注册证书',
    certNumber: 'SYNTHETIC-001',
    issuedOn: '2025-01-01',
    expiresOn: '2027-12-31',
    updatedAt: '2026-09-08T12:00:00',
    attachments: [{ id: 'att-1', bytes }],
    ...overrides,
  };
}

function verifiedMapping(record, overrides = {}) {
  return {
    recordId: record.id,
    companyId: 'company-lc',
    verified: true,
    updatedAt: record.updatedAt,
    attachments: (record.attachments ?? []).map((attachment) => ({
      id: attachment.id,
      sha256: attachment.storedSha256 ?? sha256(attachment.bytes),
      verified: true,
    })),
    ...overrides,
  };
}

function loadVaultWithWholeAttachmentReadsBlocked(attachmentPaths) {
  const fs = require('node:fs');
  const originalReadFileSync = fs.readFileSync;
  const blocked = new Set(attachmentPaths.map((file) => path.resolve(file)));
  fs.readFileSync = (file, ...args) => {
    if (blocked.has(path.resolve(String(file)))) {
      throw new Error('whole_attachment_read_forbidden');
    }
    return originalReadFileSync(file, ...args);
  };
  try {
    delete require.cache[require.resolve('../vault.cjs')];
    return require('../vault.cjs');
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
}

function loadVaultWithAttachmentOpensTracked(blockedPaths = []) {
  const fs = require('node:fs');
  const originalOpenSync = fs.openSync;
  const blocked = new Set(blockedPaths.map(file => path.resolve(file)));
  const opened = [];
  fs.openSync = (file, ...args) => {
    const resolved = path.resolve(String(file));
    opened.push(resolved);
    if (blocked.has(resolved)) throw new Error('attachment_open_forbidden');
    return originalOpenSync(file, ...args);
  };
  try {
    delete require.cache[require.resolve('../vault.cjs')];
    return { vaultModule: require('../vault.cjs'), opened };
  } finally {
    fs.openSync = originalOpenSync;
  }
}

test('reads a manually verified company record without changing the source database', () => {
  const record = certificate();
  const vault = createVault([record]);
  const before = sha256(readFileSync(vault.databasePath));

  const snapshot = readVaultSnapshot({
    databasePath: vault.databasePath,
    filesRoot: vault.filesRoot,
    mappings: [verifiedMapping(record)],
    companyId: 'company-lc',
  });

  assert.equal(sha256(readFileSync(vault.databasePath)), before);
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.records[0].companyId, 'company-lc');
  assert.equal(snapshot.records[0].verified, true);
  assert.deepEqual(snapshot.records[0].verificationIssues, []);
  assert.equal(snapshot.records[0].attachments[0].verified, true);
  assert.deepEqual(snapshot.warnings, []);
});

test('does not infer company ownership and rejects a stale record mapping', () => {
  const unmapped = certificate({ id: 'cert-unmapped', attachments: [] });
  const stale = certificate({ id: 'cert-stale', attachments: [] });
  const vault = createVault([unmapped, stale]);

  const snapshot = readVaultSnapshot({
    databasePath: vault.databasePath,
    filesRoot: vault.filesRoot,
    mappings: [verifiedMapping(stale, { updatedAt: '2026-09-07T12:00:00' })],
    companyId: 'company-lc',
  });

  const byId = Object.fromEntries(snapshot.records.map((record) => [record.id, record]));
  assert.equal(byId['cert-unmapped'].companyId, null);
  assert.equal(byId['cert-unmapped'].verified, false);
  assert.ok(byId['cert-unmapped'].verificationIssues.includes('mapping_missing'));
  assert.equal(byId['cert-stale'].companyId, 'company-lc');
  assert.equal(byId['cert-stale'].verified, false);
  assert.ok(byId['cert-stale'].verificationIssues.includes('record_updated_at_mismatch'));
});

test('keeps missing, changed, escaped, and malformed attachments unverified', () => {
  const changed = certificate({ id: 'changed', attachments: [{ id: 'att-changed', bytes: Buffer.from('%PDF-1.4\n%%EOF\n') }] });
  const missing = certificate({ id: 'missing', attachments: [{ id: 'att-missing', bytes: Buffer.from('%PDF-1.4\n%%EOF\n'), skipWrite: true }] });
  const escaped = certificate({ id: 'escaped', attachments: [{ id: 'att-escaped', relativePath: '../outside.pdf', bytes: Buffer.from('%PDF-1.4\n%%EOF\n'), skipWrite: true }] });
  const malformed = certificate({ id: 'malformed', attachments: [{ id: 'att-malformed', bytes: Buffer.from('not a readable document') }] });
  const vault = createVault([changed, missing, escaped, malformed]);
  writeFileSync(path.join(vault.root, 'files', 'att-changed.pdf'), Buffer.from('changed after mapping'));
  const snapshot = readVaultSnapshot({
    databasePath: vault.databasePath,
    filesRoot: vault.filesRoot,
    mappings: [changed, missing, escaped, malformed].map((record) => verifiedMapping(record)),
    companyId: 'company-lc',
  });

  const byId = Object.fromEntries(snapshot.records.map((record) => [record.id, record]));
  assert.ok(byId.changed.verificationIssues.includes('attachment_hash_mismatch'));
  assert.ok(byId.missing.verificationIssues.includes('attachment_missing'));
  assert.ok(byId.escaped.verificationIssues.includes('attachment_path_outside_root'));
  assert.ok(byId.malformed.verificationIssues.includes('attachment_invalid'));
  assert.equal(snapshot.records.every((record) => record.verified === false), true);
  assert.equal(snapshot.warnings.length, 4);
});

test('verifies a multi-block PDF without whole-file reads when %%EOF crosses the chunk boundary', () => {
  const chunkSize = 1024 * 1024;
  const bytes = Buffer.alloc(chunkSize * 2 + 64, 0x20);
  bytes.write('%PDF-1.7\n', 0, 'ascii');
  bytes.write('%%EOF', chunkSize - 2, 'ascii');
  const record = certificate({
    id: 'large-pdf',
    attachments: [{ id: 'att-large-pdf', bytes }],
  });
  const vault = createVault([record]);
  const attachmentPath = path.join(vault.filesRoot, 'files', 'att-large-pdf.pdf');
  const streamingVault = loadVaultWithWholeAttachmentReadsBlocked([attachmentPath]);

  const snapshot = streamingVault.readVaultSnapshot({
    databasePath: vault.databasePath,
    filesRoot: vault.filesRoot,
    mappings: [verifiedMapping(record)],
    companyId: 'company-lc',
  });

  assert.equal(snapshot.records[0].verified, true);
  assert.equal(snapshot.records[0].attachments[0].actualSha256, sha256(bytes));
});

test('verifies a multi-block JPEG from its header and final bytes without whole-file reads', () => {
  const bytes = Buffer.alloc(1024 * 1024 + 17, 0x20);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[bytes.length - 2] = 0xff;
  bytes[bytes.length - 1] = 0xd9;
  const record = certificate({
    id: 'large-jpeg',
    attachments: [{ id: 'att-large-jpeg', name: 'evidence.jpg', relativePath: 'files/evidence.jpg', bytes }],
  });
  const vault = createVault([record]);
  const attachmentPath = path.join(vault.filesRoot, 'files', 'evidence.jpg');
  const streamingVault = loadVaultWithWholeAttachmentReadsBlocked([attachmentPath]);

  const snapshot = streamingVault.readVaultSnapshot({
    databasePath: vault.databasePath,
    filesRoot: vault.filesRoot,
    mappings: [verifiedMapping(record)],
    companyId: 'company-lc',
  });

  assert.equal(snapshot.records[0].verified, true);
  assert.equal(snapshot.records[0].attachments[0].actualSha256, sha256(bytes));
});

test('onlyMapped inspects only eligible mapped attachments while retaining every record and attachment', () => {
  const eligible = certificate({
    id: 'eligible',
    attachments: [
      { id: 'eligible-mapped', bytes: Buffer.from('%PDF-1.4\nMapped\n%%EOF') },
      { id: 'eligible-unmapped', bytes: Buffer.from('%PDF-1.4\nUnmapped\n%%EOF') },
    ],
  });
  const unmapped = certificate({ id: 'unmapped', attachments: [{ id: 'unmapped-att', bytes: Buffer.from('%PDF-1.4\nUnmapped record\n%%EOF') }] });
  const otherCompany = certificate({ id: 'other-company', attachments: [{ id: 'other-att', bytes: Buffer.from('%PDF-1.4\nOther company\n%%EOF') }] });
  const stale = certificate({ id: 'stale', attachments: [{ id: 'stale-att', bytes: Buffer.from('%PDF-1.4\nStale\n%%EOF') }] });
  const vault = createVault([eligible, unmapped, otherCompany, stale]);
  const file = id => path.join(vault.filesRoot, 'files', `${id}.pdf`);
  const blocked = [file('eligible-unmapped'), file('unmapped-att'), file('other-att'), file('stale-att')];
  const tracked = loadVaultWithAttachmentOpensTracked(blocked);
  const eligibleMapping = verifiedMapping(eligible, {
    attachments: [{
      id: 'eligible-mapped',
      sha256: sha256(eligible.attachments[0].bytes),
      verified: true,
    }],
  });

  const snapshot = tracked.vaultModule.readVaultSnapshot({
    databasePath: vault.databasePath,
    filesRoot: vault.filesRoot,
    mappings: [
      eligibleMapping,
      verifiedMapping(otherCompany, { companyId: 'another-company' }),
      verifiedMapping(stale, { updatedAt: '2026-09-01T00:00:00' }),
    ],
    companyId: 'company-lc',
    onlyMapped: true,
  });

  assert.equal(snapshot.records.length, 4);
  assert.deepEqual(tracked.opened, [file('eligible-mapped')]);
  const byId = Object.fromEntries(snapshot.records.map(record => [record.id, record]));
  assert.equal(byId.eligible.attachments[0].verified, true);
  assert.equal(byId.eligible.attachments[1].verified, false);
  assert.equal(byId.eligible.attachments[1].actualSha256, null);
  assert.ok(byId.eligible.attachments[1].verificationIssues.includes('attachment_not_inspected'));
  assert.ok(byId.eligible.attachments[1].verificationIssues.includes('attachment_mapping_missing'));
  for (const id of ['unmapped', 'other-company', 'stale']) {
    assert.equal(byId[id].verified, false);
    assert.equal(byId[id].attachments[0].verified, false);
    assert.equal(byId[id].attachments[0].actualSha256, null);
    assert.ok(byId[id].attachments[0].verificationIssues.includes('attachment_not_inspected'));
  }
  assert.equal(snapshot.warnings.length, 4);
});

test('onlyMapped still hashes an eligible mapped attachment and rejects changed bytes', () => {
  const record = certificate({ id: 'mapped-changed' });
  const vault = createVault([record]);
  writeFileSync(path.join(vault.filesRoot, 'files', 'att-1.pdf'), Buffer.from('%PDF-1.4\nChanged\n%%EOF'));

  const snapshot = readVaultSnapshot({
    databasePath: vault.databasePath,
    filesRoot: vault.filesRoot,
    mappings: [verifiedMapping(record)],
    companyId: 'company-lc',
    onlyMapped: true,
  });

  const attachment = snapshot.records[0].attachments[0];
  assert.equal(attachment.verified, false);
  assert.notEqual(attachment.actualSha256, attachment.sha256);
  assert.ok(attachment.verificationIssues.includes('attachment_hash_mismatch'));
  assert.ok(!attachment.verificationIssues.includes('attachment_not_inspected'));
});

test('default audit mode continues to inspect attachments without mappings', () => {
  const record = certificate({ id: 'audit-unmapped' });
  const vault = createVault([record]);
  const snapshot = readVaultSnapshot({
    databasePath: vault.databasePath,
    filesRoot: vault.filesRoot,
    mappings: [],
    companyId: 'company-lc',
  });
  const attachment = snapshot.records[0].attachments[0];
  assert.equal(attachment.actualSha256, attachment.sha256);
  assert.ok(attachment.verificationIssues.includes('attachment_mapping_missing'));
  assert.ok(!attachment.verificationIssues.includes('attachment_not_inspected'));
});
