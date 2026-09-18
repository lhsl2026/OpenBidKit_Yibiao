'use strict';

const path = require('node:path');
const { createHash } = require('node:crypto');
const AdmZip = require(require.resolve('adm-zip', {
  paths: [path.resolve(__dirname, '../../client')],
}));

const ORIGIN = 'https://ggzy.guizhou.gov.cn';
const ANNOUNCEMENT_PATH = '/tradeInfo/detailHtml';
const DETAIL_PATH = '/tradeInfo/detailHtmlData';
const PACKAGE_PATH = '/hallweb/hall/attach/nosession/download';
const ANNOUNCEMENT_PDF_HOST = 'gz-gov-open-doc.oss-cn-gz-ysgzlt-d01-a.ltops.gzdata.com.cn';
const SHA256 = bytes => createHash('sha256').update(bytes).digest('hex');

const DEFAULT_LIMITS = Object.freeze({
  timeoutMs: 15000,
  maxPageBytes: 2 * 1024 * 1024,
  maxDetailBytes: 4 * 1024 * 1024,
  maxPackageBytes: 20 * 1024 * 1024,
  maxEntries: 64,
  maxCompressedBytes: 20 * 1024 * 1024,
  maxUncompressedBytes: 20 * 1024 * 1024,
  maxPdfBytes: 20 * 1024 * 1024,
});

const SAFETY_LIMITS = Object.freeze({
  timeoutMs: 60000,
  maxPageBytes: 2 * 1024 * 1024,
  maxDetailBytes: 4 * 1024 * 1024,
  maxPackageBytes: 20 * 1024 * 1024,
  maxEntries: 64,
  maxCompressedBytes: 20 * 1024 * 1024,
  maxUncompressedBytes: 20 * 1024 * 1024,
  maxPdfBytes: 20 * 1024 * 1024,
});

class SourceFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function manual(reason, sourceUrl) {
  return { status: 'manual', reason, ...(sourceUrl ? { sourceUrl } : {}) };
}

function resolveLimits(overrides = {}) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`invalid_${name}`);
    if (!(name in SAFETY_LIMITS) || value > SAFETY_LIMITS[name]) throw new TypeError(`invalid_${name}`);
  }
  return limits;
}

function parseAnnouncementUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.origin !== ORIGIN || url.pathname !== ANNOUNCEMENT_PATH || url.username || url.password || url.port || url.hash) return null;
  if (url.searchParams.size !== 1 || !/^\d{16,24}$/.test(url.searchParams.get('metaId') ?? '')) return null;
  return url;
}

function parsePackageUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.origin !== ORIGIN || url.pathname !== PACKAGE_PATH || url.username || url.password || url.port || url.hash) return null;
  if (url.searchParams.size !== 1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(url.searchParams.get('attachId') ?? '')) return null;
  return url;
}

function decodeUtf8(bytes, code) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  } catch {
    throw new SourceFailure(code);
  }
}

async function readBounded(response, limit, code) {
  const declared = response.headers?.get?.('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new SourceFailure(code);
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > limit) throw new SourceFailure(code);
    return bytes;
  }
  const chunks = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new SourceFailure(code);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function contentType(response) {
  return String(response.headers?.get?.('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
}

function uniqueMatches(text, expression) {
  return [...new Set([...text.matchAll(expression)].map(match => match[1]))];
}

function extractPageMetadata(html) {
  const codes = uniqueMatches(html, /\bdata\s*:\s*\{[\s\S]{0,400}?\bcode\s*:\s*["']([A-Z0-9]{8,40})["']/gi);
  // The selected announcement type is emitted as the only double-quoted call;
  // navigation links use single-quoted onclick handlers for every available type.
  const types = uniqueMatches(html, /\bdetailList\("([^"\r\n]{1,40})"\);/g);
  if (codes.length !== 1 || types.length !== 1 || /[\u0000-\u001f\u007f]/.test(types[0])) throw new SourceFailure('source_metadata_missing');
  return { code: codes[0], type: types[0] };
}

function decodeHtml(value) {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .trim();
}

function sourceCandidate(detail) {
  if (detail?.code !== 1 || !Array.isArray(detail.data) || detail.data.length === 0 || detail.data.length > 100) {
    throw new SourceFailure('detail_response_invalid');
  }
  const candidates = [];
  for (const item of detail.data) {
    if (!item || typeof item.docHtmlCon !== 'string') continue;
    const anchors = item.docHtmlCon.matchAll(/<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi);
    for (const match of anchors) {
      const label = decodeHtml(match[3]);
      candidates.push({ href: decodeHtml(match[2]), label });
    }
  }
  const packages = candidates.filter(candidate => /\.ZYZF\s*$/i.test(candidate.label));
  if (packages.length > 1) throw new SourceFailure('package_candidate_ambiguous');
  if (packages.length === 1) {
    const url = parsePackageUrl(packages[0].href);
    if (!url) throw new SourceFailure('package_candidate_invalid');
    return { kind: 'package', url, label: packages[0].label };
  }
  const pdfs = candidates.filter(candidate => {
    if (/\.pdf\s*$/i.test(candidate.label)) return true;
    try {
      return /\.pdf$/i.test(new URL(candidate.href, ORIGIN).pathname);
    } catch {
      return false;
    }
  });
  if (pdfs.length === 0) throw new SourceFailure('package_candidate_missing');
  if (pdfs.length !== 1) throw new SourceFailure('announcement_pdf_ambiguous');
  const url = parseAnnouncementPdfUrl(pdfs[0].href);
  if (!url) throw new SourceFailure('announcement_pdf_invalid');
  return { kind: 'announcement_pdf', url, label: pdfs[0].label };
}

function parseAnnouncementPdfUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== ANNOUNCEMENT_PDF_HOST ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    url.search ||
    !/\.pdf$/i.test(url.pathname)
  ) return null;
  return url;
}

function decodeHeaderFilename(value) {
  if (!value) return null;
  const extended = /(?:^|;)\s*filename\*\s*=\s*UTF-8''([^;]+)/i.exec(value);
  if (extended) {
    try {
      return decodeURIComponent(extended[1].trim().replace(/^"|"$/g, ''));
    } catch {
      return null;
    }
  }
  const plain = /(?:^|;)\s*filename\s*=\s*(?:"([^"]+)"|([^;]+))/i.exec(value);
  if (!plain) return null;
  const filename = (plain[1] ?? plain[2]).trim();
  if (/%[0-9a-f]{2}/i.test(filename)) {
    try {
      const decoded = decodeURIComponent(filename);
      if (!decoded.includes('\uFFFD')) return decoded;
    } catch {
      return null;
    }
  }
  if ([...filename].every(character => character.charCodeAt(0) <= 0xff)) {
    const decoded = Buffer.from(filename, 'latin1').toString('utf8');
    if (!decoded.includes('\uFFFD')) return decoded;
  }
  return filename;
}

function safePackageFileName(value) {
  if (typeof value !== 'string') return null;
  const filename = value.trim();
  if (!/\.ZYZF$/i.test(filename) || filename.length > 240 || /[\\/\u0000-\u001f\u007f]/.test(filename)) return null;
  return filename;
}

function tenderFileName(packageFileName) {
  let stem = packageFileName.replace(/\.ZYZF$/i, '');
  const bracketed = /^\[([A-Z0-9_-]{4,64})\](.+)$/i.exec(stem);
  if (bracketed) stem = `${bracketed[1]}-${bracketed[2]}`;
  stem = stem.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').replace(/[. ]+$/g, '');
  if (stem.length > 200) stem = stem.slice(0, 200).replace(/[. ]+$/g, '');
  return `${stem || 'tender'}-招标文件正文.pdf`;
}

function announcementFileName(value) {
  if (typeof value !== 'string') return null;
  let filename = value.trim();
  if (!/\.pdf$/i.test(filename) || filename.length > 220 || /[\\/\u0000-\u001f\u007f]/.test(filename)) return null;
  filename = filename.replace(/\.pdf$/i, '').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').replace(/[. ]+$/g, '');
  return `${filename || '采购需求'}-公告附件-非完整招标文件.pdf`;
}

function validPdf(bytes) {
  return bytes.length >= 10
    && bytes.subarray(0, 5).toString('ascii') === '%PDF-'
    && bytes.subarray(Math.max(0, bytes.length - 1024)).includes(Buffer.from('%%EOF'));
}

function extractZyzfTender({ packageBytes, packageFileName, sourceUrl, provenance = {}, limits: limitOverrides = {} }) {
  const limits = resolveLimits(limitOverrides);
  const safeName = safePackageFileName(packageFileName);
  if (!Buffer.isBuffer(packageBytes) || packageBytes.length === 0 || packageBytes.length > limits.maxPackageBytes) return manual('zyzf_package_invalid', sourceUrl);
  if (!safeName) return manual('zyzf_package_name_invalid', sourceUrl);
  const packageSha256 = SHA256(packageBytes);
  let xml;
  try {
    xml = decodeUtf8(packageBytes, 'zyzf_xml_invalid');
  } catch (error) {
    return manual(error.code, sourceUrl);
  }
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) return manual('zyzf_xml_unsafe', sourceUrl);
  const openings = xml.match(/<ZBFileContent\b/gi) ?? [];
  if (openings.length === 0) return manual('zyzf_content_missing', sourceUrl);
  const matches = [...xml.matchAll(/<ZBFileContent\s*>([\s\S]*?)<\/ZBFileContent\s*>/gi)];
  if (openings.length !== 1 || matches.length !== 1) return manual('zyzf_content_ambiguous', sourceUrl);
  const encoded = matches[0][1].replace(/[\t\n\r ]/g, '');
  if (!encoded || encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    return manual('zyzf_base64_invalid', sourceUrl);
  }
  const estimatedBytes = Math.floor(encoded.length / 4) * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
  if (estimatedBytes > limits.maxCompressedBytes) return manual('zyzf_archive_limits_exceeded', sourceUrl);
  const archiveBytes = Buffer.from(encoded, 'base64');
  if (archiveBytes.length !== estimatedBytes || archiveBytes.length > limits.maxCompressedBytes) return manual('zyzf_base64_invalid', sourceUrl);
  let entries;
  try {
    entries = new AdmZip(archiveBytes).getEntries();
  } catch {
    return manual('zyzf_archive_invalid', sourceUrl);
  }
  if (entries.length === 0) return manual('tender_pdf_missing', sourceUrl);
  if (entries.length > limits.maxEntries) return manual('zyzf_archive_limits_exceeded', sourceUrl);
  let compressedTotal = 0;
  let uncompressedTotal = 0;
  const pdfs = [];
  for (const entry of entries) {
    const compressed = entry.header?.compressedSize;
    const uncompressed = entry.header?.size;
    const flags = entry.header?.flags;
    const method = entry.header?.method;
    if (![compressed, uncompressed, flags, method].every(Number.isSafeInteger) || compressed < 0 || uncompressed < 0) return manual('zyzf_archive_invalid', sourceUrl);
    compressedTotal += compressed;
    uncompressedTotal += uncompressed;
    if (compressedTotal > limits.maxCompressedBytes || uncompressedTotal > limits.maxUncompressedBytes) return manual('zyzf_archive_limits_exceeded', sourceUrl);
    if ((flags & 1) !== 0) return manual('zyzf_encrypted_entry', sourceUrl);
    if (![0, 8].includes(method)) return manual('zyzf_unknown_entry', sourceUrl);
    const rawName = entry.rawEntryName;
    if (!Buffer.isBuffer(rawName) || entry.isDirectory || rawName.length === 0 || rawName.length > 240
      || rawName.includes(0x2f) || rawName.includes(0x5c)
      || [...rawName].some(byte => byte < 0x20 || byte === 0x7f)) {
      return manual('zyzf_entry_path_invalid', sourceUrl);
    }
    const lowerName = rawName.toString('latin1').toLowerCase();
    if (lowerName.endsWith('.pdf')) {
      if (uncompressed > limits.maxPdfBytes) return manual('zyzf_archive_limits_exceeded', sourceUrl);
      pdfs.push(entry);
    } else if (lowerName === 'pbzb.xml') {
      // The package metadata is intentionally ignored; only the tender PDF is delivered.
    } else {
      return manual('zyzf_unknown_entry', sourceUrl);
    }
  }
  if (pdfs.length === 0) return manual('tender_pdf_missing', sourceUrl);
  if (pdfs.length !== 1) return manual('tender_pdf_ambiguous', sourceUrl);
  let pdfBytes;
  try {
    pdfBytes = pdfs[0].getData();
  } catch {
    return manual('tender_pdf_invalid', sourceUrl);
  }
  if (pdfBytes.length !== pdfs[0].header.size || pdfBytes.length > limits.maxUncompressedBytes || !validPdf(pdfBytes)) {
    return manual('tender_pdf_invalid', sourceUrl);
  }
  const pdfSha256 = SHA256(pdfBytes);
  return {
    status: 'obtained',
    bytes: pdfBytes,
    fileName: tenderFileName(safeName),
    sha256: pdfSha256,
    ...(sourceUrl ? { sourceUrl } : {}),
    provenance: {
      ...provenance,
      packageFileName: safeName,
      packageSha256,
      pdfSha256,
    },
  };
}

function createGuizhouSource(options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    timeoutMs,
    maxPageBytes,
    maxDetailBytes,
    maxPackageBytes,
    maxEntries,
    maxCompressedBytes,
    maxUncompressedBytes,
    maxPdfBytes,
  } = options;
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl_required');
  const limits = resolveLimits(Object.fromEntries(Object.entries({
    timeoutMs,
    maxPageBytes,
    maxDetailBytes,
    maxPackageBytes,
    maxEntries,
    maxCompressedBytes,
    maxUncompressedBytes,
    maxPdfBytes,
  }).filter(([, value]) => value !== undefined)));

  async function get(url, accept, limit, tooLargeCode, signal) {
    const timeout = AbortSignal.timeout(limits.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { accept },
        redirect: 'error',
        credentials: 'omit',
        signal: combined,
      });
    } catch {
      if (signal?.aborted) throw new SourceFailure('source_aborted');
      if (timeout.aborted) throw new SourceFailure('source_request_timeout');
      throw new SourceFailure('source_request_failed');
    }
    if (!response?.ok) throw new SourceFailure('source_response_invalid');
    return { response, bytes: await readBounded(response, limit, tooLargeCode) };
  }

  async function recover({ sourceUrl, signal } = {}) {
    const announcement = parseAnnouncementUrl(sourceUrl);
    if (!announcement) return manual('unsupported_source_url');
    const normalizedSourceUrl = announcement.href;
    if (signal?.aborted) return manual('source_aborted', normalizedSourceUrl);
    try {
      const page = await get(announcement, 'text/html,application/xhtml+xml', limits.maxPageBytes, 'announcement_too_large', signal);
      const pageType = contentType(page.response);
      if (pageType && pageType !== 'text/html' && pageType !== 'application/xhtml+xml') throw new SourceFailure('announcement_response_invalid');
      const { code, type } = extractPageMetadata(decodeUtf8(page.bytes, 'announcement_response_invalid'));
      const detailUrl = new URL(DETAIL_PATH, ORIGIN);
      detailUrl.searchParams.set('code', code);
      detailUrl.searchParams.set('type', type);
      const detailResponse = await get(detailUrl, 'application/json', limits.maxDetailBytes, 'detail_too_large', signal);
      const detailType = contentType(detailResponse.response);
      if (detailType && detailType !== 'application/json') throw new SourceFailure('detail_response_invalid');
      let detail;
      try {
        detail = JSON.parse(decodeUtf8(detailResponse.bytes, 'detail_response_invalid'));
      } catch (error) {
        if (error instanceof SourceFailure) throw error;
        throw new SourceFailure('detail_response_invalid');
      }
      const candidate = sourceCandidate(detail);
      if (candidate.kind === 'announcement_pdf') {
        const attachmentResponse = await get(candidate.url, 'application/pdf,application/octet-stream', limits.maxPdfBytes, 'announcement_pdf_too_large', signal);
        const attachmentType = contentType(attachmentResponse.response);
        if (attachmentType && !['application/pdf', 'application/octet-stream'].includes(attachmentType)) throw new SourceFailure('announcement_pdf_response_invalid');
        if (!validPdf(attachmentResponse.bytes)) throw new SourceFailure('announcement_pdf_invalid');
        const headerName = decodeHeaderFilename(attachmentResponse.response.headers?.get?.('content-disposition'));
        const fileName = announcementFileName(headerName) ?? announcementFileName(candidate.label);
        if (!fileName) throw new SourceFailure('announcement_pdf_invalid');
        const attachmentSha256 = SHA256(attachmentResponse.bytes);
        return {
          status: 'partial_obtained',
          bytes: attachmentResponse.bytes,
          fileName,
          sha256: attachmentSha256,
          officialCategory: 'announcement_attachment',
          sourceUrl: normalizedSourceUrl,
          provenance: {
            announcementUrl: normalizedSourceUrl,
            detailUrl: detailUrl.href,
            attachmentUrl: candidate.url.href,
            attachmentSha256,
            tenderProjectCode: code,
            announcementType: type,
          },
        };
      }
      const packageResponse = await get(candidate.url, 'application/octet-stream,application/xml,text/xml', limits.maxPackageBytes, 'package_too_large', signal);
      const packageType = contentType(packageResponse.response);
      if (packageType && !['application/octet-stream', 'application/xml', 'text/xml'].includes(packageType)) throw new SourceFailure('package_response_invalid');
      const headerName = decodeHeaderFilename(packageResponse.response.headers?.get?.('content-disposition'));
      const packageFileName = safePackageFileName(headerName) ?? safePackageFileName(candidate.label);
      if (!packageFileName) throw new SourceFailure('zyzf_package_name_invalid');
      return extractZyzfTender({
        packageBytes: packageResponse.bytes,
        packageFileName,
        sourceUrl: normalizedSourceUrl,
        limits,
        provenance: {
          announcementUrl: normalizedSourceUrl,
          detailUrl: detailUrl.href,
          packageUrl: candidate.url.href,
          tenderProjectCode: code,
          announcementType: type,
        },
      });
    } catch (error) {
      return manual(error instanceof SourceFailure ? error.code : 'source_recovery_failed', normalizedSourceUrl);
    }
  }

  return { recover };
}

module.exports = {
  createGuizhouSource,
  extractZyzfTender,
};
