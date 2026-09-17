'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { key } = require('./store.cjs');
const { canGenerateDraft } = require('./writing-policy.cjs');

const run = promisify(execFile);
const PREFIX = 'writing-confirmation-doc:';
const TYPES = new Set(['outline_selection', 'outline', 'global_facts', 'content_decision']);
const stageNames = { outline_selection: '建议章节范围', outline: '完整目录', global_facts: '待补事实确认', content_decision: '正文失败重试清单' };
const hash = value => createHash('sha256').update(value).digest('hex');
const validToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
const escapeXml = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(name => [name, stable(value[name])]));
  return value;
}
function validDocument(value) {
  if (!validToken(value?.token) || typeof value.url !== 'string') throw Error('confirmation_create_unknown');
  const url = new URL(value.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || !/(^|\.)(feishu\.cn|larksuite\.com)$/.test(url.hostname) || url.pathname !== '/docx/' + value.token) throw Error('confirmation_create_unknown');
  return { token: value.token, url: url.href };
}
function listItems(items) {
  return `<ul>${items.map(item => `<li>${escapeXml(item)}</li>`).join('')}</ul>`;
}
function outlineItems(items, depth = 0) {
  if (!Array.isArray(items) || !items.length) return '';
  return `<ul>${items.map(item => `<li><b>${escapeXml(item.title ?? item.name ?? '未命名章节')}</b>${item.description ? `<br/>${escapeXml(item.description)}` : ''}${depth < 12 ? outlineItems(item.children, depth + 1) : ''}</li>`).join('')}</ul>`;
}
function bodyFor(confirmation) {
  if (confirmation.type === 'outline_selection') {
    const selected = new Set(confirmation.selectedIds ?? []);
    return listItems((confirmation.items ?? []).map(item => `${item.title ?? '未命名章节'}（${selected.has(item.id) ? '拟采用' : '暂不采用'}）${item.description ? `：${item.description}` : ''}`));
  }
  if (confirmation.type === 'outline') return outlineItems(confirmation.outlineData?.outline);
  if (confirmation.type === 'global_facts') {
    return (confirmation.groups ?? []).map(group => {
      const title = group.title ?? group.name ?? '待核对事项';
      const details = group.content ? `<p>${escapeXml(group.content).replace(/\r?\n/g, '<br/>')}</p>` : listItems((group.items ?? []).map(item => `${item.key ?? item.name ?? '事项'}：${item.value ?? item.content ?? '【待补充】'}`));
      return `<h2>${escapeXml(title)}</h2>${details}`;
    }).join('');
  }
  if (confirmation.type === 'content_decision') {
    return `${listItems((confirmation.failedSections ?? []).map(section => `${section.title ?? '待重试章节'}：该小节尚未成功生成`))}<p>确认后只重试失败小节；未完成小节不会作为成功初稿交付。</p>`;
  }
  return '<p>当前步骤需要人工处理。</p>';
}
function confirmationDocument(project, confirmation) {
  const contentHash = hash(JSON.stringify(stable(confirmation)));
  const title = `${project.input.handoff.task.title}－标书生成确认单`;
  const xml = `<title>${escapeXml(title)}</title><callout emoji="⚠️" background-color="light-orange" border-color="orange"><p>缺失事实保持待补，不代表已核实。请核对本页后再回到项目卡继续。</p></callout><h1>${escapeXml(stageNames[confirmation.type] ?? '生成确认')}</h1><p>招标文件版本：${escapeXml(project.version)}</p>${bodyFor(confirmation)}<hr/><p>确认文档校验：${contentHash}</p>`;
  return { contentHash, title, xml };
}
function createConfirmationDocClient(options, { runImpl = run } = {}) {
  async function cli(service, args, { cwd, signal } = {}) {
    const { stdout } = await runImpl(options.cliPath, [service, ...args, '--as', options.identity, '--profile', options.profile, '--format', 'json'], { cwd, signal, windowsHide: true, timeout: 180000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' } });
    const result = JSON.parse(stdout);
    if (result?.ok !== true || !result.data) throw Error('confirmation_cli_failed');
    return result.data;
  }
  return {
    async create({ sourcePath, folderToken, signal }) {
      const data = await cli('docs', ['+create', '--doc-format', 'xml', '--content', '@./' + path.basename(sourcePath), '--parent-token', folderToken], { cwd: path.dirname(sourcePath), signal });
      return validDocument({ token: data.document?.document_id, url: data.document?.url });
    },
    async update({ token, sourcePath, signal }) {
      const data = await cli('docs', ['+update', '--doc', token, '--command', 'overwrite', '--doc-format', 'xml', '--content', '@./' + path.basename(sourcePath)], { cwd: path.dirname(sourcePath), signal });
      if (data.result !== 'success') throw Error('confirmation_update_unknown');
      return { updated: true };
    },
    async fetch({ token, signal }) {
      const data = await cli('docs', ['+fetch', '--doc', token, '--doc-format', 'xml', '--detail', 'simple'], { signal });
      if (typeof data.document?.content !== 'string') throw Error('confirmation_fetch_failed');
      return { content: data.document.content };
    },
    async grantGroup({ token, chatId, signal }) { await cli('drive', ['+member-add', '--token', token, '--type', 'docx', '--member-id', chatId, '--member-type', 'openchat', '--perm', 'view', '--yes'], { signal }); },
    async hasGroup({ token, chatId, signal }) {
      const data = await cli('drive', ['+member-list', '--token', token, '--type', 'docx'], { signal });
      return Array.isArray(data.items) && data.items.some(member => member.member_type === 'openchat' && member.member_id === chatId && ['view', 'edit', 'full_access'].includes(member.perm));
    },
  };
}
function createWritingConfirmationDoc({ store, config, client, assertOwnership = () => {}, clock = Date.now }) {
  const options = config.reportArchive ?? { enabled: false };
  const root = path.resolve(options.root ?? path.join(config.dataRoot, 'reports'), 'writing-confirmations');
  let running = false;
  const target = () => key(options.profile, options.identity, options.folderToken, config.chatId);
  const allowed = () => options.enabled && ['test', 'production'].includes(config.mode) && config.chatId && config.allowedChats?.includes(config.chatId) && validToken(options.folderToken) && options.allowedFolderTokens?.includes(options.folderToken);
  if (options.enabled && (!path.isAbsolute(options.cliPath ?? '') || !options.profile || !['bot', 'user'].includes(options.identity) || !allowed())) throw Error('writing_confirmation_not_configured');
  const list = () => store.db.prepare("SELECT value FROM settings WHERE key LIKE 'writing-confirmation-doc:%' ORDER BY key").all().map(row => JSON.parse(row.value));
  const save = job => store.set(PREFIX + job.id, { ...job, updatedAt: clock() });
  const currentCandidate = () => {
    for (const writing of store.listWriting()) {
      const confirmation = writing.result?.confirmation;
      if (writing.status !== 'waiting_confirmation' || !confirmation?.challenge || !TYPES.has(confirmation.type)) continue;
      const project = store.getProject(writing.project_id);
      if (project?.current && canGenerateDraft(project, clock())) return { writing, project, confirmation, ...confirmationDocument(project, confirmation) };
    }
    return null;
  };
  function sourcePath(job, xml) {
    fs.mkdirSync(root, { recursive: true });
    const file = path.join(root, job.id + '.xml');
    fs.writeFileSync(file, xml, 'utf8');
    return file;
  }
  function bind(candidate, job) {
    const project = store.getProject(candidate.project.id);
    const writing = store.listWriting().find(item => item.id === candidate.writing.id);
    if (!project?.current || writing?.status !== 'waiting_confirmation' || writing.result?.confirmation?.challenge !== candidate.confirmation.challenge || job.contentHash !== candidate.contentHash || job.challenge !== candidate.confirmation.challenge) return;
    const input = { ...project.input, writingConfirmationUrl: job.url, writingConfirmation: { token: job.token, challenge: job.challenge, contentHash: job.contentHash, documentVersion: project.version } };
    store.transaction(() => {
      store.db.prepare('UPDATE projects SET payload=? WHERE id=?').run(JSON.stringify(input), project.id);
      store.set('confirmationPublished:' + job.challenge, { contentHash: job.contentHash, url: job.url });
      store.touchCard(project.id, clock());
    });
  }
  async function tick({ signal } = {}) {
    if (!allowed() || running || signal?.aborted) return;
    running = true;
    const own = () => { assertOwnership(); if (signal?.aborted) throw Error('writing_confirmation_stopped'); };
    try {
      own();
      for (const stale of list().filter(job => job.stage === 'creating')) save({ ...stale, stage: 'manual', error: 'confirmation_create_unknown' });
      for (const stale of list().filter(job => job.stage === 'updating')) save({ ...stale, stage: 'verifying_update', error: 'confirmation_update_unknown', nextAt: 0 });
      const candidate = currentCandidate();
      if (!candidate) return;
      const id = key('writing-confirmation-doc', candidate.project.taskId, candidate.project.companyId);
      let job = store.get(PREFIX + id);
      if (!job) {
        job = { id, taskId: candidate.project.taskId, companyId: candidate.project.companyId, projectId: candidate.project.id, target: target(), folderToken: options.folderToken, chatId: config.chatId, title: candidate.title, challenge: candidate.confirmation.challenge, contentHash: candidate.contentHash, stage: 'queued_create', createdAt: clock() };
        save(job);
      }
      if (job.target !== target() || job.stage === 'manual') return;
      if (job.token && (job.contentHash !== candidate.contentHash || job.challenge !== candidate.confirmation.challenge || job.projectId !== candidate.project.id)) {
        job = { ...job, projectId: candidate.project.id, title: candidate.title, challenge: candidate.confirmation.challenge, contentHash: candidate.contentHash, stage: 'queued_update', error: null, nextAt: 0 };
        save(job);
      }
      if ((job.nextAt ?? 0) > clock()) return;
      const drive = client ?? createConfirmationDocClient(options);
      if (job.stage === 'published') { bind(candidate, job); return; }
      if (job.stage === 'queued_create') {
        const file = sourcePath(job, candidate.xml); own(); save({ ...job, stage: 'creating' });
        let document;
        try { document = validDocument(await drive.create({ sourcePath: file, folderToken: job.folderToken, signal })); }
        catch { own(); save({ ...job, stage: 'manual', error: 'confirmation_create_unknown' }); return; }
        own(); save({ ...job, ...document, stage: 'verifying_content', error: null }); return;
      }
      if (job.stage === 'queued_update') {
        const file = sourcePath(job, candidate.xml); own(); save({ ...job, stage: 'updating' });
        try { await drive.update({ token: job.token, sourcePath: file, signal }); } catch {}
        own(); save({ ...job, stage: 'verifying_update', error: null, nextAt: 0 }); return;
      }
      if (['verifying_content', 'verifying_update'].includes(job.stage)) {
        let fetched;
        try { fetched = await drive.fetch({ token: job.token, signal }); }
        catch { own(); save({ ...job, nextAt: clock() + 60000, error: 'confirmation_fetch_failed' }); return; }
        own();
        if (!String(fetched?.content ?? '').includes('确认文档校验：' + job.contentHash)) {
          save({ ...job, stage: 'queued_update', nextAt: clock() + 60000, error: 'confirmation_content_unverified' }); return;
        }
        save({ ...job, stage: 'granting', error: null }); return;
      }
      if (job.stage === 'granting') {
        try { await drive.grantGroup({ token: job.token, chatId: job.chatId, signal }); } catch {}
        own(); save({ ...job, stage: 'verifying_permission' }); return;
      }
      if (job.stage === 'verifying_permission') {
        let verified = false;
        try { verified = await drive.hasGroup({ token: job.token, chatId: job.chatId, signal }); } catch {}
        own();
        if (!verified) { save({ ...job, stage: 'manual', error: 'confirmation_permission_unverified' }); return; }
        const published = { ...job, stage: 'published', error: null, publishedAt: clock() };
        save(published); bind(candidate, published);
      }
    } finally { running = false; }
  }
  return { tick, list };
}

module.exports = { createWritingConfirmationDoc, createConfirmationDocClient, confirmationDocument };
