'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runProductionCheck } = require('../deployment/production-check.cjs');

function config() {
  return {
    mode: 'test', host: '127.0.0.1', port: 4381, companyId: '隆创信息有限公司', apiKey: 'x'.repeat(32),
    production: { cutover: false, chatId: 'oc_production', allowedChats: ['oc_production'] },
    testDelivery: { chatId: 'oc_test', allowedChats: ['oc_test'] },
    operatorIds: ['ou_operator'], sourceChats: ['oc_radar'], sourceSenders: ['ou_radar_bot'],
    radarPolling: { enabled: true, cliPath: 'C:/tools/lark-cli.exe', profile: 'radar-user' },
    cardSource: { enabled: true, cliPath: 'C:/tools/lark-cli.exe', profile: 'bid-bot' },
    reportArchive: { enabled: true, cliPath: 'C:/tools/lark-cli.exe', profile: 'report-user', identity: 'user', folderToken: 'fld_archive', allowedFolderTokens: ['fld_archive'] },
    companyEvidence: { enabled: true }, prereadUrl: 'http://127.0.0.1:4382', prereadKey: 'handoff', relayAuthorization: 'Bearer relay',
    appId: 'cli_app', appSecret: 'secret', modelConfig: { api_key: 'model', base_url: 'http://127.0.0.1:4383/v1', model_name: 'gpt-6-astra' },
  };
}
function dependencies(overrides = {}) {
  const calls = [];
  return { calls, deps: {
    cli: async ({ args, profile, identity }) => {
      calls.push({ args, profile, identity });
      if (args[0] === 'im' && args[1] === '+chat-members-list') return { users: [{ member_id: 'ou_operator' }], bots: [], truncations: [], has_more: false };
      if (args[0] === 'im') return { chat_id: args[3], chat_status: 'normal' };
      return { files: [] };
    },
    readiness: async () => ({ ready: true, mode: 'test', missing: [] }),
    scheduledTask: async () => ({ exists: true, state: 'Running', enabled: true, logonType: 'Password', triggers: ['MSFT_TaskBootTrigger'], lastTaskResult: 267009 }),
    ...overrides,
  }};
}

test('read-only production preflight verifies the formal chat, members, radar source, archive, runtime and unattended task', async () => {
  const { calls, deps } = dependencies();
  const result = await runProductionCheck(config(), deps);
  assert.equal(result.ready, true);
  assert.deepEqual(result.checks.map(item => [item.name, item.status]), [
    ['production_config', 'pass'], ['formal_chat', 'pass'], ['operators', 'pass'], ['radar_sources', 'pass'],
    ['archive_folder', 'pass'], ['runtime', 'pass'], ['scheduled_task', 'pass'],
  ]);
  assert.ok(calls.some(call => call.args.join(' ').includes('im chats get --chat-id oc_production') && call.profile === 'bid-bot' && call.identity === 'bot'));
  assert.ok(calls.some(call => call.args.join(' ').includes('im +chat-members-list --chat-id oc_production') && call.args.includes('--page-all')));
  assert.ok(calls.some(call => call.args.join(' ').includes('im chats get --chat-id oc_radar') && call.profile === 'radar-user' && call.identity === 'user'));
  assert.ok(calls.some(call => call.args.join(' ').includes('drive files list --folder-token fld_archive') && call.profile === 'report-user' && call.identity === 'user'));
});

test('interactive logon task is reported as the remaining always-on blocker', async () => {
  const { deps } = dependencies({ scheduledTask: async () => ({ exists: true, state: 'Running', enabled: true, logonType: 'Interactive', triggers: ['MSFT_TaskLogonTrigger'], lastTaskResult: 0 }) });
  const result = await runProductionCheck(config(), deps);
  assert.equal(result.ready, false);
  assert.deepEqual(result.checks.filter(item => item.status === 'fail').map(item => item.name), ['scheduled_task']);
  assert.equal(result.checks.at(-1).code, 'interactive_logon_only');
});

test('incomplete member enumeration and missing runtime components fail closed without exposing identifiers', async () => {
  const { deps } = dependencies({
    cli: async ({ args }) => args[1] === '+chat-members-list'
      ? { users: [{ member_id: 'ou_operator' }], truncations: [{ member_type: 'user', limit: 1 }], has_more: false }
      : args[0] === 'drive' ? { files: [] } : { chat_status: 'normal' },
    readiness: async () => ({ ready: false, mode: 'test', missing: ['company_profile', 'card_callback'] }),
  });
  const result = await runProductionCheck(config(), deps);
  assert.equal(result.ready, false);
  assert.equal(result.checks.find(item => item.name === 'operators').code, 'member_list_incomplete');
  assert.equal(result.checks.find(item => item.name === 'runtime').code, 'runtime_not_ready');
  assert.equal(JSON.stringify(result).includes('ou_operator'), false);
  assert.equal(JSON.stringify(result).includes('oc_production'), false);
});

test('an external formal group is rejected before production cutover', async () => {
  const { deps } = dependencies({
    cli: async ({ args }) => args[1] === '+chat-members-list'
      ? { users: [{ member_id: 'ou_operator' }], truncations: [], has_more: false }
      : args[0] === 'drive' ? { files: [] } : { chat_status: 'normal', external: args.includes('oc_production') },
  });
  const result = await runProductionCheck(config(), deps);
  assert.equal(result.ready, false);
  assert.equal(result.checks.find(item => item.name === 'formal_chat').code, 'external_chat_not_supported');
});

test('test and production targets must be staged separately before any external lookup', async () => {
  const c = config(); c.production.chatId = 'oc_test'; c.production.allowedChats = ['oc_test'];
  const { calls, deps } = dependencies();
  const result = await runProductionCheck(c, deps);
  assert.equal(result.ready, false);
  assert.equal(result.checks[0].code, 'production_config_invalid');
  assert.equal(calls.length, 0);
});
