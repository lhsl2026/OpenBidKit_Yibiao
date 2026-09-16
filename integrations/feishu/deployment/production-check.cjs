'use strict';
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { loadConfig } = require('../config.cjs');
const run = promisify(execFile);

const pass = name => ({ name, status: 'pass' });
const fail = (name, code) => ({ name, status: 'fail', code });

function productionConfigReady(config) {
  const p = config.production ?? {}, t = config.testDelivery ?? {};
  const overlap = p.chatId && (p.chatId === t.chatId || t.allowedChats?.includes(p.chatId) || p.allowedChats?.some(id => t.allowedChats?.includes(id)));
  return Boolean(
    p.chatId && p.allowedChats?.includes(p.chatId) && !overlap && config.companyId === '隆创信息有限公司' &&
    config.appId && config.appSecret && config.operatorIds?.length && config.sourceChats?.length && config.sourceSenders?.length &&
    config.radarPolling?.enabled && config.radarPolling.cliPath && config.radarPolling.profile &&
    config.groupFileSource?.enabled && config.groupFileSource.cliPath && config.groupFileSource.profile &&
    config.cardSource?.enabled && config.cardSource.cliPath && config.cardSource.profile &&
    config.reportArchive?.enabled && config.reportArchive.folderToken && config.reportArchive.allowedFolderTokens?.includes(config.reportArchive.folderToken) &&
    config.reportArchive.profile && ['bot', 'user'].includes(config.reportArchive.identity) && config.companyEvidence?.enabled &&
    config.prereadUrl && config.relayAuthorization?.startsWith('Bearer ') &&
    config.modelConfig?.api_key && config.modelConfig?.base_url && config.modelConfig?.model_name
  );
}

async function defaultCli(config, { args, profile, identity }) {
  const executable = config.cardSource?.cliPath || config.radarPolling?.cliPath || config.groupFileSource?.cliPath || config.reportArchive?.cliPath;
  const { stdout } = await run(executable, [...args, '--as', identity, '--profile', profile, '--format', 'json'], {
    windowsHide: true, timeout: 60000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' },
  });
  const result = JSON.parse(stdout);
  if (result?.ok !== true || !result.data) throw Error('lark_read_failed');
  return result.data;
}

async function defaultReadiness(config) {
  const host = ['0.0.0.0', '::'].includes(config.host) ? '127.0.0.1' : config.host;
  const url = 'http://' + (host.includes(':') ? '[' + host + ']' : host) + ':' + config.port + '/ready';
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  const body = await response.json();
  if (!body || typeof body !== 'object') throw Error('runtime_response_invalid');
  return body;
}

async function defaultScheduledTask() {
  if (process.platform !== 'win32') return { exists: false };
  const script = [
    "$task=Get-ScheduledTask -TaskName 'OpenBidKitFeishu' -TaskPath '\\' -ErrorAction SilentlyContinue",
    "if(-not $task){@{exists=$false}|ConvertTo-Json -Compress;exit}",
    "$info=Get-ScheduledTaskInfo -TaskName 'OpenBidKitFeishu' -TaskPath '\\' -ErrorAction Stop",
    "@{exists=$true;state=[string]$task.State;enabled=[bool]$task.Settings.Enabled;logonType=[string]$task.Principal.LogonType;triggers=@($task.Triggers|ForEach-Object{$_.CimClass.CimClassName});lastTaskResult=[int]$info.LastTaskResult}|ConvertTo-Json -Compress",
  ].join(';');
  const { stdout } = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10000, maxBuffer: 128 * 1024 });
  return JSON.parse(stdout);
}

async function runProductionCheck(config, dependencies = {}) {
  const cli = dependencies.cli ?? (request => defaultCli(config, request));
  const readiness = dependencies.readiness ?? (() => defaultReadiness(config));
  const scheduledTask = dependencies.scheduledTask ?? defaultScheduledTask;
  const checks = [];
  if (!productionConfigReady(config)) return { ready: false, checks: [fail('production_config', 'production_config_invalid')] };
  checks.push(pass('production_config'));

  try {
    const chat = await cli({ args: ['im', 'chats', 'get', '--chat-id', config.production.chatId], profile: config.cardSource.profile, identity: 'bot' });
    checks.push(chat?.external === true ? fail('formal_chat', 'external_chat_not_supported') : chat?.chat_status === 'normal' ? pass('formal_chat') : fail('formal_chat', 'formal_chat_unavailable'));
  } catch { checks.push(fail('formal_chat', 'formal_chat_unavailable')); }

  try {
    const members = await cli({ args: ['im', '+chat-members-list', '--chat-id', config.production.chatId, '--member-types', 'user', '--page-all', '--page-limit', '0'], profile: config.cardSource.profile, identity: 'bot' });
    if (members?.has_more || members?.truncations?.length) checks.push(fail('operators', 'member_list_incomplete'));
    else {
      const ids = new Set((members?.users ?? []).map(item => item.member_id));
      checks.push(config.operatorIds.every(id => ids.has(id)) ? pass('operators') : fail('operators', 'operator_not_in_formal_chat'));
    }
  } catch { checks.push(fail('operators', 'operator_membership_unavailable')); }

  try {
    const sources = await Promise.all(config.sourceChats.map(chatId => cli({ args: ['im', 'chats', 'get', '--chat-id', chatId], profile: config.radarPolling.profile, identity: 'user' })));
    checks.push(sources.every(chat => chat?.chat_status === 'normal') ? pass('radar_sources') : fail('radar_sources', 'radar_source_unavailable'));
  } catch { checks.push(fail('radar_sources', 'radar_source_unavailable')); }

  try {
    const end=Date.now(),start=end-60000;
    await cli({args:['im','+chat-messages-list','--chat-id',config.production.chatId,'--start',new Date(start).toISOString(),'--end',new Date(end).toISOString(),'--order','desc','--page-size','1','--no-reactions'],profile:config.groupFileSource.profile,identity:'user'});
    checks.push(pass('group_file_source'));
  } catch { checks.push(fail('group_file_source','group_file_history_unavailable')); }

  try {
    await cli({ args: ['drive', 'files', 'list', '--folder-token', config.reportArchive.folderToken, '--page-size', '1'], profile: config.reportArchive.profile, identity: config.reportArchive.identity });
    checks.push(pass('archive_folder'));
  } catch { checks.push(fail('archive_folder', 'archive_folder_unavailable')); }

  try {
    const state = await readiness();
    const required = new Set(['company_profile', 'model', 'preread', 'radar_allowlist', 'radar_source', 'group_file_source', 'card_callback', 'service_ownership']);
    const blocked = !state?.ready || !Array.isArray(state.missing) || state.missing.some(item => required.has(item));
    checks.push(blocked ? fail('runtime', 'runtime_not_ready') : pass('runtime'));
  } catch { checks.push(fail('runtime', 'runtime_unavailable')); }

  try {
    const task = await scheduledTask();
    const running = task?.exists && task.enabled && ['Running', 'Ready'].includes(task.state) && [0, 267009].includes(Number(task.lastTaskResult));
    const unattended = task?.logonType === 'Password' && task.triggers?.includes('MSFT_TaskBootTrigger');
    checks.push(running && unattended ? pass('scheduled_task') : fail('scheduled_task', task?.logonType === 'Interactive' ? 'interactive_logon_only' : 'unattended_task_not_ready'));
  } catch { checks.push(fail('scheduled_task', 'scheduled_task_unavailable')); }
  return { ready: checks.every(item => item.status === 'pass'), checks };
}

if (require.main === module) {
  runProductionCheck(loadConfig()).then(result => {
    console.log(JSON.stringify(result));
    if (!result.ready) process.exitCode = 1;
  }).catch(() => { console.log(JSON.stringify({ ready: false, checks: [fail('production_check', 'production_check_failed')] })); process.exitCode = 1; });
}

module.exports = { runProductionCheck, productionConfigReady };
