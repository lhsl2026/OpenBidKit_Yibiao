'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const AdmZip = require('../../../client/node_modules/adm-zip');

const SOURCE_URL = 'https://ggzy.guizhou.gov.cn/tradeInfo/detailHtml?metaId=1257545352035307520';
const DETAIL_URL = 'https://ggzy.guizhou.gov.cn/tradeInfo/detailHtmlData?code=P5203292026000BNN&type=%E9%87%87%E8%B4%AD%E5%85%AC%E5%91%8A';
const PACKAGE_URL = 'https://ggzy.guizhou.gov.cn/hallweb/hall/attach/nosession/download?attachId=ecdbc846-8353-4e59-a921-eb8cc599b1f1';
const ANNOUNCEMENT_PDF_URL = new URL('https://gz-gov-open-doc.oss-cn-gz-ysgzlt-d01-a.ltops.gzdata.com.cn/public/采购需求9.15.pdf').href;
const PDF = Buffer.from('%PDF-1.7\nsynthetic tender document\n%%EOF', 'ascii');

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function makeArchive(entries = [['tender.pdf', PDF], ['PBZB.xml', Buffer.from('<root/>')]]) {
  const zip = new AdmZip();
  for (const [name, bytes] of entries) zip.addFile(name, bytes);
  return zip.toBuffer();
}

function makeZyzf(archive = makeArchive()) {
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n<ZBFile><ZBFileContent>${archive.toString('base64')}</ZBFileContent></ZBFile>`, 'utf8');
}

function pageHtml({ code = 'P5203292026000BNN', type = '采购公告' } = {}) {
  return `<!doctype html><script>detailList("${type}"); function detailList(type) { $.ajax({ url: "/tradeInfo/detailHtmlData", data: { code: "${code}", type: type } }); }</script>`;
}

function detailJson(anchors) {
  return JSON.stringify({ code: 1, message: '成功', data: [{ docHtmlCon: anchors }] });
}

function response(body, { type, disposition } = {}) {
  const headers = {};
  if (type) headers['content-type'] = type;
  if (disposition) headers['content-disposition'] = disposition;
  return new Response(body, { status: 200, headers });
}

function fakeFetch(queue, calls) {
  return async (url, options) => {
    calls.push({ url: String(url), options });
    const next = queue.shift();
    assert.ok(next, `unexpected request: ${url}`);
    assert.equal(String(url), next.url);
    return next.response;
  };
}

test('recovers the only public ZYZF tender PDF in exactly three credential-free requests', async () => {
  const packageBytes = makeZyzf();
  const calls = [];
  const fetchImpl = fakeFetch([
    { url: SOURCE_URL, response: response(pageHtml(), { type: 'text/html;charset=UTF-8' }) },
    {
      url: DETAIL_URL,
      response: response(detailJson(
        `<a href="https://ggzy.guizhou.gov.cn/not-a-package.pdf">交易公告.pdf</a>`
        + `<a href="${PACKAGE_URL}">[P5203292026000BNN001]Example.ZYZF</a>`,
      ), { type: 'application/json' }),
    },
    {
      url: PACKAGE_URL,
      response: response(packageBytes, {
        type: 'application/octet-stream;charset=UTF-8',
        disposition: 'attachment; filename="[P5203292026000BNN001]Example.ZYZF"',
      }),
    },
  ], calls);

  const result = await createGuizhouSource({ fetchImpl }).recover({ sourceUrl: SOURCE_URL });

  assert.equal(result.status, 'obtained');
  assert.deepEqual(result.bytes, PDF);
  assert.equal(result.fileName, 'P5203292026000BNN001-Example-招标文件正文.pdf');
  assert.equal(result.sha256, sha256(PDF));
  assert.equal(result.sourceUrl, SOURCE_URL);
  assert.deepEqual(result.provenance, {
    announcementUrl: SOURCE_URL,
    detailUrl: DETAIL_URL,
    packageUrl: PACKAGE_URL,
    packageFileName: '[P5203292026000BNN001]Example.ZYZF',
    packageSha256: sha256(packageBytes),
    pdfSha256: sha256(PDF),
    tenderProjectCode: 'P5203292026000BNN',
    announcementType: '采购公告',
  });
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.options.method, 'GET');
    assert.equal(call.options.redirect, 'error');
    assert.equal(call.options.credentials, 'omit');
    assert.equal(call.options.headers.authorization, undefined);
    assert.equal(call.options.headers.cookie, undefined);
    assert.ok(call.options.signal instanceof AbortSignal);
  }
});

test('recovers the only trusted announcement PDF as an explicitly incomplete attachment', async () => {
  const calls = [];
  const fetchImpl = fakeFetch([
    { url: SOURCE_URL, response: response(pageHtml(), { type: 'text/html' }) },
    {
      url: DETAIL_URL,
      response: response(detailJson(
        `<a href="${ANNOUNCEMENT_PDF_URL}">采购需求9.15.pdf</a>`,
      ), { type: 'application/json' }),
    },
    {
      url: ANNOUNCEMENT_PDF_URL,
      response: response(PDF, {
        type: 'application/pdf',
        disposition:
          'attachment; filename=%E9%87%87%E8%B4%AD%E9%9C%80%E6%B1%829.15.pdf',
      }),
    },
  ], calls);

  const result = await createGuizhouSource({ fetchImpl }).recover({ sourceUrl: SOURCE_URL });

  assert.equal(result.status, 'partial_obtained');
  assert.deepEqual(result.bytes, PDF);
  assert.equal(result.fileName, '采购需求9.15-公告附件-非完整招标文件.pdf');
  assert.equal(result.sha256, sha256(PDF));
  assert.equal(result.officialCategory, 'announcement_attachment');
  assert.equal(result.sourceUrl, SOURCE_URL);
  assert.equal(result.provenance.attachmentUrl, ANNOUNCEMENT_PDF_URL);
  assert.equal(result.provenance.attachmentSha256, sha256(PDF));
  assert.equal(calls.length, 3);
});

test('selects a clearly labelled sale-version tender PDF when the same announcement also has a transaction notice PDF', async () => {
  const tenderUrl = 'https://ggzy.guizhou.gov.cn/hallweb/hall/attach/nosession/download?attachId=20aa3f5a-eb4d-4f37-89de-cca0c503f726';
  const noticeUrl = 'https://ggzy.guizhou.gov.cn/hallweb/hall/attach/nosession/download?attachId=c8fc3fdf-8f73-4464-a830-9613c63925c3';
  const calls = [];
  const fetchImpl = fakeFetch([
    { url: SOURCE_URL, response: response(pageHtml(), { type: 'text/html' }) },
    {
      url: DETAIL_URL,
      response: response(detailJson(
        `<a href="${tenderUrl}">公开招标货物-印江十三幼（发售版9-21）.pdf</a>`
        + `<a href="${noticeUrl}">交易公告.pdf</a>`,
      ), { type: 'application/json' }),
    },
    {
      url: tenderUrl,
      response: response(PDF, {
        type: 'application/octet-stream',
        disposition: 'attachment; filename*=UTF-8\'\'%E5%85%AC%E5%BC%80%E6%8B%9B%E6%A0%87%E8%B4%A7%E7%89%A9-%E5%8D%B0%E6%B1%9F%E5%8D%81%E4%B8%89%E5%B9%BC%EF%BC%88%E5%8F%91%E5%94%AE%E7%89%889-21%EF%BC%89.pdf',
      }),
    },
  ], calls);

  const result = await createGuizhouSource({ fetchImpl }).recover({ sourceUrl: SOURCE_URL });

  assert.equal(result.status, 'obtained');
  assert.deepEqual(result.bytes, PDF);
  assert.equal(result.fileName, '公开招标货物-印江十三幼（发售版9-21）-招标文件正文.pdf');
  assert.equal(result.sha256, sha256(PDF));
  assert.equal(result.provenance.tenderPdfUrl, tenderUrl);
  assert.equal(result.provenance.tenderPdfSha256, sha256(PDF));
  assert.deepEqual(calls.map(call => call.url), [SOURCE_URL, DETAIL_URL, tenderUrl]);
});

test('fails closed for ambiguous or untrusted announcement PDF candidates', async () => {
  const fixtures = [
    {
      anchors: `<a href="${ANNOUNCEMENT_PDF_URL}">需求一.pdf</a><a href="${ANNOUNCEMENT_PDF_URL.replace('9.15', '9.16')}">需求二.pdf</a>`,
      reason: 'announcement_pdf_ambiguous',
    },
    {
      anchors: '<a href="https://evil.example/采购需求.pdf">采购需求.pdf</a>',
      reason: 'announcement_pdf_invalid',
    },
    {
      anchors: '<a href="http://gz-gov-open-doc.oss-cn-gz-ysgzlt-d01-a.ltops.gzdata.com.cn/采购需求.pdf">采购需求.pdf</a>',
      reason: 'announcement_pdf_invalid',
    },
  ];
  for (const fixture of fixtures) {
    const calls = [];
    const fetchImpl = fakeFetch([
      { url: SOURCE_URL, response: response(pageHtml(), { type: 'text/html' }) },
      { url: DETAIL_URL, response: response(detailJson(fixture.anchors), { type: 'application/json' }) },
    ], calls);
    const result = await createGuizhouSource({ fetchImpl }).recover({ sourceUrl: SOURCE_URL });
    assert.equal(result.status, 'manual');
    assert.equal(result.reason, fixture.reason);
    assert.equal(calls.length, 2);
  }
});

test('rejects invalid, redirected, and oversized announcement PDFs', async () => {
  const invalidPdf = Buffer.from('%PDF-1.7\nmissing eof', 'ascii');
  for (const fixture of [
    { response: response(invalidPdf, { type: 'application/pdf' }), reason: 'announcement_pdf_invalid' },
    { response: response(PDF, { type: 'text/html' }), reason: 'announcement_pdf_response_invalid' },
    { response: new Response(null, { status: 302, headers: { location: 'https://evil.example/file.pdf' } }), reason: 'source_response_invalid' },
    { response: response(Buffer.concat([PDF, Buffer.alloc(1024)]), { type: 'application/pdf' }), reason: 'announcement_pdf_too_large', maxPdfBytes: 512 },
  ]) {
    const calls = [];
    const fetchImpl = fakeFetch([
      { url: SOURCE_URL, response: response(pageHtml(), { type: 'text/html' }) },
      { url: DETAIL_URL, response: response(detailJson(`<a href="${ANNOUNCEMENT_PDF_URL}">采购需求9.15.pdf</a>`), { type: 'application/json' }) },
      { url: ANNOUNCEMENT_PDF_URL, response: fixture.response },
    ], calls);
    const result = await createGuizhouSource({ fetchImpl, ...(fixture.maxPdfBytes ? { maxPdfBytes: fixture.maxPdfBytes } : {}) }).recover({ sourceUrl: SOURCE_URL });
    assert.equal(result.status, 'manual');
    assert.equal(result.reason, fixture.reason);
  }
});

test('rejects non-official inputs and unsafe or ambiguous package candidates before download', async () => {
  const rejected = [
    'http://ggzy.guizhou.gov.cn/tradeInfo/detailHtml?metaId=1257545352035307520',
    'https://evil.example/tradeInfo/detailHtml?metaId=1257545352035307520',
    'https://ggzy.guizhou.gov.cn@evil.example/tradeInfo/detailHtml?metaId=1257545352035307520',
    'https://ggzy.guizhou.gov.cn/tradeInfo/detailHtml?metaId=1257545352035307520&next=http://127.0.0.1',
    'https://ggzy.guizhou.gov.cn/admin?metaId=1257545352035307520',
  ];
  for (const sourceUrl of rejected) {
    let requests = 0;
    const result = await createGuizhouSource({ fetchImpl: async () => { requests++; } }).recover({ sourceUrl });
    assert.equal(result.reason, 'unsupported_source_url');
    assert.equal(requests, 0);
  }

  for (const [anchors, reason] of [
    [`<a href="http://127.0.0.1/private.ZYZF">private.ZYZF</a>`, 'package_candidate_invalid'],
    [
      `<a href="${PACKAGE_URL}">one.ZYZF</a>`
      + `<a href="https://ggzy.guizhou.gov.cn/hallweb/hall/attach/nosession/download?attachId=0ea43783-6fec-4485-a51b-cbfaa8a1a417">two.ZYZF</a>`,
      'package_candidate_ambiguous',
    ],
  ]) {
    const calls = [];
    const fetchImpl = fakeFetch([
      { url: SOURCE_URL, response: response(pageHtml(), { type: 'text/html' }) },
      { url: DETAIL_URL, response: response(detailJson(anchors), { type: 'application/json' }) },
    ], calls);
    const result = await createGuizhouSource({ fetchImpl }).recover({ sourceUrl: SOURCE_URL });
    assert.equal(result.reason, reason);
    assert.equal(calls.length, 2);
  }
});

test('rejects unsafe XML and non-unique or malformed ZBFileContent', () => {
  const archive = makeArchive();
  const base64 = archive.toString('base64');
  const cases = [
    [`<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><ZBFile><ZBFileContent>${base64}</ZBFileContent></ZBFile>`, 'zyzf_xml_unsafe'],
    [`<ZBFile><ZBFileContent>${base64}</ZBFileContent><ZBFileContent>${base64}</ZBFileContent></ZBFile>`, 'zyzf_content_ambiguous'],
    ['<ZBFile><ZBFileContent>not@@base64</ZBFileContent></ZBFile>', 'zyzf_base64_invalid'],
    ['<ZBFile></ZBFile>', 'zyzf_content_missing'],
  ];
  for (const [xml, reason] of cases) {
    const result = extractZyzfTender({ packageBytes: Buffer.from(xml), packageFileName: 'sample.ZYZF' });
    assert.equal(result.status, 'manual');
    assert.equal(result.reason, reason);
  }
});

test('fails closed for multiple PDFs, encrypted entries, unknown entries, and archive limits', () => {
  const cases = [
    {
      bytes: makeZyzf(makeArchive([['one.pdf', PDF], ['two.pdf', PDF]])),
      reason: 'tender_pdf_ambiguous',
    },
    {
      bytes: makeZyzf(makeArchive([['tender.pdf', PDF], ['extra.txt', Buffer.from('unknown')]])),
      reason: 'zyzf_unknown_entry',
    },
    {
      bytes: makeZyzf(markFirstEntryEncrypted(makeArchive([['tender.pdf', PDF]]))),
      reason: 'zyzf_encrypted_entry',
    },
    {
      bytes: makeZyzf(makeArchive([['tender.pdf', Buffer.concat([PDF, Buffer.alloc(1024)])]])),
      limits: { maxUncompressedBytes: 512 },
      reason: 'zyzf_archive_limits_exceeded',
    },
  ];
  for (const fixture of cases) {
    const result = extractZyzfTender({
      packageBytes: fixture.bytes,
      packageFileName: 'sample.ZYZF',
      limits: fixture.limits,
    });
    assert.equal(result.status, 'manual');
    assert.equal(result.reason, fixture.reason);
  }
});

test('rejects traversal, absolute, nested, and directory ZIP entry names', () => {
  const archives = [
    makeArchiveWithRawPdfName('aa_tender.pdf', '../tender.pdf'),
    makeArchiveWithRawPdfName('_tender.pdf', '/tender.pdf'),
    makeArchiveWithRawPdfName('CC_tender.pdf', 'C:\\tender.pdf'),
    makeArchive([['folder/tender.pdf', PDF]]),
  ];
  for (const archive of archives) {
    const result = extractZyzfTender({
      packageBytes: makeZyzf(archive),
      packageFileName: 'sample.ZYZF',
    });
    assert.equal(result.reason, 'zyzf_entry_path_invalid');
  }
  const withDirectory = makeArchive([['folder/', Buffer.alloc(0)], ['tender.pdf', PDF]]);
  assert.equal(extractZyzfTender({
    packageBytes: makeZyzf(withDirectory),
    packageFileName: 'sample.ZYZF',
  }).reason, 'zyzf_entry_path_invalid');
});

function makeArchiveWithRawPdfName(safeName, rawName) {
  const bytes = makeArchive([[safeName, PDF]]);
  const safe = Buffer.from(safeName, 'ascii');
  const raw = Buffer.from(rawName, 'ascii');
  assert.equal(raw.length, safe.length);
  let replacements = 0;
  for (let offset = bytes.indexOf(safe); offset >= 0; offset = bytes.indexOf(safe, offset + raw.length)) {
    raw.copy(bytes, offset);
    replacements++;
  }
  assert.equal(replacements, 2);
  return bytes;
}

test('rejects an oversized PDF from ZIP metadata before getData and caps all caller limits', () => {
  const archive = makeArchive([['tender.pdf', Buffer.concat([PDF, Buffer.alloc(1024)])]]);
  const originalGetEntries = AdmZip.prototype.getEntries;
  let dataReads = 0;
  AdmZip.prototype.getEntries = function guardedGetEntries(...args) {
    const entries = originalGetEntries.apply(this, args);
    for (const entry of entries) {
      const getData = entry.getData.bind(entry);
      entry.getData = () => {
        dataReads++;
        return getData();
      };
    }
    return entries;
  };
  try {
    const result = extractZyzfTender({
      packageBytes: makeZyzf(archive),
      packageFileName: 'sample.ZYZF',
      limits: { maxPdfBytes: 512 },
    });
    assert.equal(result.reason, 'zyzf_archive_limits_exceeded');
    assert.equal(dataReads, 0);
  } finally {
    AdmZip.prototype.getEntries = originalGetEntries;
  }

  const over20MiB = 20 * 1024 * 1024 + 1;
  for (const name of ['maxPackageBytes', 'maxCompressedBytes', 'maxUncompressedBytes', 'maxPdfBytes']) {
    assert.throws(
      () => createGuizhouSource({ [name]: over20MiB }),
      new RegExp(`invalid_${name}`),
    );
  }
  assert.throws(() => createGuizhouSource({ maxEntries: 65 }), /invalid_maxEntries/);
  assert.throws(() => createGuizhouSource({ maxPageBytes: 2 * 1024 * 1024 + 1 }), /invalid_maxPageBytes/);
  assert.throws(() => createGuizhouSource({ maxDetailBytes: 4 * 1024 * 1024 + 1 }), /invalid_maxDetailBytes/);
  assert.throws(() => createGuizhouSource({ timeoutMs: 60001 }), /invalid_timeoutMs/);
});

test('matches the two locally retained 2026-09-10 public packages', {
  skip: !process.env.GUIZHOU_PRIVATE_FIXTURE_MANIFEST,
}, () => {
  const manifestPath = path.resolve(process.env.GUIZHOU_PRIVATE_FIXTURE_MANIFEST);
  const root = path.dirname(manifestPath);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.projects.length, 2);
  for (const project of manifest.projects) {
    const packageBytes = fs.readFileSync(path.join(root, project.package.fileName));
    const result = extractZyzfTender({
      packageBytes,
      packageFileName: project.package.fileName,
      sourceUrl: project.announcementUrl,
      provenance: {
        announcementUrl: project.announcementUrl,
        detailUrl: project.publicDetailUrl,
        packageUrl: project.publicPackageUrl,
      },
    });
    assert.equal(result.status, 'obtained');
    assert.equal(result.provenance.packageSha256, project.package.sha256);
    assert.equal(result.sha256, project.tenderDocument.sha256);
    assert.equal(result.bytes.length, project.tenderDocument.size);
  }
});

function markFirstEntryEncrypted(input) {
  const bytes = Buffer.from(input);
  let localMarked = false;
  let centralMarked = false;
  for (let offset = 0; offset <= bytes.length - 10; offset++) {
    const signature = bytes.readUInt32LE(offset);
    if (!localMarked && signature === 0x04034b50) {
      bytes.writeUInt16LE(bytes.readUInt16LE(offset + 6) | 1, offset + 6);
      localMarked = true;
    }
    if (!centralMarked && signature === 0x02014b50) {
      bytes.writeUInt16LE(bytes.readUInt16LE(offset + 8) | 1, offset + 8);
      centralMarked = true;
    }
    if (localMarked && centralMarked) break;
  }
  assert.equal(localMarked && centralMarked, true);
  return bytes;
}

const { createGuizhouSource, extractZyzfTender } = require('../guizhou-source.cjs');
