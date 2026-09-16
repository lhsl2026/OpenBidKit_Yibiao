const {test}=require('node:test');const assert=require('node:assert/strict');const {internalHost,loadConfig}=require('../config.cjs');
function productionEnv(overrides={}){
 return {
  BID_DELIVERY_MODE:'production',BID_PRODUCTION_CUTOVER:'true',BID_CHAT_ID:'oc_test',BID_TEST_CHAT_IDS:'oc_test',
  BID_PRODUCTION_CHAT_ID:'oc_production',BID_PRODUCTION_CHAT_IDS:'oc_production',BID_COMPANY_ID:'隆创信息有限公司',
  LARK_APP_ID:'cli_app',LARK_APP_SECRET:'test-secret',BID_OPERATOR_IDS:'ou_operator',BID_SOURCE_CHAT_IDS:'oc_radar',BID_SOURCE_SENDER_IDS:'ou_radar_bot',
  BID_RADAR_POLL_ENABLED:'true',BID_CARD_SOURCE_ENABLED:'true',BID_LARK_CLI_PATH:process.execPath,BID_LARK_CLI_PROFILE:'radar-user',BID_CARD_CLI_PROFILE:'bid-bot',
  BID_GROUP_FILE_SOURCE_ENABLED:'true',BID_GROUP_FILE_CLI_PROFILE:'decision-user',BID_GROUP_FILE_START_AT:'2026-09-16T00:00:00+08:00',BID_MIAODA_APP_ID:'app_17agc8m97f2',
  BID_REPORT_ARCHIVE_ENABLED:'true',BID_REPORT_FOLDER_TOKEN:'folder-production',BID_REPORT_ALLOWED_FOLDER_TOKENS:'folder-production',BID_REPORT_CLI_PROFILE:'report-user',BID_REPORT_CLI_IDENTITY:'user',
  BID_COMPANY_PROFILE_SYNC_ENABLED:'true',BID_VAULT_DATABASE:'C:/vault/vault.sqlite3',BID_VAULT_FILES:'C:/vault',BID_VAULT_MAPPINGS:'C:/vault/mappings.json',
  PREREAD_BASE_URL:'http://127.0.0.1:3000',PREREAD_RELAY_AUTHORIZATION:'Bearer relay',
  MODEL_PROVIDER:'custom',MODEL_PROVIDER_API_KEY:'test-model-key',MODEL_PROVIDER_BASE_URL:'https://model.example/v1',MODEL_PROVIDER_MODEL:'test-model',
  ...overrides,
 };
}
test('private-looking public names are not internal IP addresses',()=>{
 for(const h of ['10.evil.example','127.0.0.1.example','192.168.example','172.16.example']){assert.equal(internalHost(h),false);assert.throws(()=>loadConfig({PREREAD_BASE_URL:'https://'+h}),/internal/);}
 for(const h of ['10.1.2.3','127.0.0.1','192.168.1.2','172.16.0.1','localhost','preread','[::1]'])assert.equal(internalHost(h),true);
});

test('deployment placeholder model values cannot make the service look configured',()=>{
 const c=loadConfig({MODEL_PROVIDER_API_KEY:'PENDING_MODEL_PROVIDER_API_KEY',MODEL_PROVIDER_MODEL:'PENDING_MODEL_PROVIDER_MODEL',MODEL_PROVIDER_BASE_URL:'https://api.openai.com/v1'});
 assert.equal(c.modelConfig.api_key,'');assert.equal(c.modelConfig.model_name,'');
 const real=loadConfig({MODEL_PROVIDER_API_KEY:'test-credential',MODEL_PROVIDER_MODEL:'test-model',MODEL_PROVIDER_BASE_URL:'https://model.example/v1'});
 assert.equal(real.modelConfig.model_name,'test-model');
});
test('card stream uses its dedicated profile and requires absolute CLI and operator context only when enabled',()=>{
 const env={BID_CARD_SOURCE_ENABLED:'true',BID_LARK_CLI_PATH:'C:/tools/lark-cli.exe',BID_CARD_CLI_PROFILE:'openbidkit-feishu',BID_CHAT_ID:'oc_test',BID_OPERATOR_IDS:'ou_actor'};
 const c=loadConfig(env);assert.deepEqual(c.cardSource,{enabled:true,cliPath:env.BID_LARK_CLI_PATH,profile:'openbidkit-feishu'});assert.equal(c.verificationToken,'');assert.equal(c.encryptKey,'');
 for(const changed of [{BID_LARK_CLI_PATH:'lark-cli'},{BID_CARD_CLI_PROFILE:''},{BID_CHAT_ID:''},{BID_OPERATOR_IDS:''}])assert.throws(()=>loadConfig({...env,...changed}),/card_source_not_configured/);
 assert.equal(loadConfig({}).cardSource.enabled,false);
});
test('official document recovery is opt-in and pinned to the authorized Miaoda app',()=>{
 const env={BID_DOCUMENT_RECOVERY_ENABLED:'true',BID_MIAODA_APP_ID:'app_17agc8m97f2',BID_DOCUMENT_CLI_PROFILE:'authorized-user',BID_LARK_CLI_PATH:process.execPath,BID_CHAT_ID:'oc_target',BID_OPERATOR_IDS:'ou_actor',PREREAD_BASE_URL:'http://127.0.0.1:3000',PREREAD_RELAY_AUTHORIZATION:'Bearer test'};
 const config=loadConfig(env);assert.equal(config.documentRecovery.enabled,true);assert.equal(config.documentRecovery.root,require('node:path').join(config.writingRoot,'sources'));
 for(const changed of [{BID_MIAODA_APP_ID:'app_other'},{BID_DOCUMENT_CLI_PROFILE:''},{PREREAD_RELAY_AUTHORIZATION:''}])assert.throws(()=>loadConfig({...env,...changed}),/document_recovery_not_configured/);
 assert.equal(loadConfig({}).documentRecovery.enabled,false);
});
test('formal group file source is opt-in with a bounded file contract',()=>{
 const disabled=loadConfig({});assert.equal(disabled.groupFileSource.enabled,false);assert.equal(disabled.groupFileSource.maxBytes,31457280);assert.deepEqual(disabled.groupFileSource.allowedExtensions,['pdf','doc','docx']);
 const env={BID_GROUP_FILE_SOURCE_ENABLED:'true',BID_GROUP_FILE_CLI_PROFILE:'decision-user',BID_GROUP_FILE_START_AT:'2026-09-16T00:00:00+08:00',BID_LARK_CLI_PATH:process.execPath,BID_CHAT_ID:'oc_target',BID_COMPANY_ID:'隆创信息有限公司',BID_MIAODA_APP_ID:'app_17agc8m97f2',PREREAD_BASE_URL:'http://127.0.0.1:3000',PREREAD_RELAY_AUTHORIZATION:'Bearer relay'};
 const config=loadConfig(env);assert.equal(config.groupFileSource.profile,'decision-user');assert.equal(config.groupFileSource.startAt,env.BID_GROUP_FILE_START_AT);assert.equal(config.groupFileSource.root,require('node:path').join(config.dataRoot,'group-files'));
 for(const changed of [{BID_GROUP_FILE_CLI_PROFILE:''},{BID_GROUP_FILE_START_AT:'invalid'},{BID_LARK_CLI_PATH:'lark-cli'},{BID_CHAT_ID:''},{BID_COMPANY_ID:'其他公司'},{BID_MIAODA_APP_ID:'app_other'},{PREREAD_RELAY_AUTHORIZATION:''},{BID_GROUP_FILE_MAX_BYTES:'31457281'},{BID_GROUP_FILE_ALLOWED_EXTENSIONS:'pdf,zip'}])assert.throws(()=>loadConfig({...env,...changed}),/group_file_source_not_configured/);
});
test('company profile synchronization is opt-in and pinned to the exact legal entity',()=>{
 const env={BID_COMPANY_PROFILE_SYNC_ENABLED:'true',BID_COMPANY_ID:'隆创信息有限公司',BID_VAULT_DATABASE:'C:/vault/vault.sqlite3',BID_VAULT_FILES:'C:/vault',BID_VAULT_MAPPINGS:'C:/vault/mappings.json',PREREAD_BASE_URL:'http://127.0.0.1:3000',PREREAD_RELAY_AUTHORIZATION:'Bearer relay'};
 const config=loadConfig(env);assert.equal(config.companyEvidence.enabled,true);
 for(const changed of [{BID_COMPANY_ID:'江苏隆创信息技术有限公司'},{BID_VAULT_DATABASE:''},{BID_VAULT_FILES:''},{BID_VAULT_MAPPINGS:''},{PREREAD_BASE_URL:''},{PREREAD_RELAY_AUTHORIZATION:''}])assert.throws(()=>loadConfig({...env,...changed}),/company_profile_sync_not_configured/);
 assert.equal(loadConfig({}).companyEvidence.enabled,false);
});
test('production delivery selects only its explicit allowlist after every readiness gate is configured',()=>{
 const config=loadConfig(productionEnv());
 assert.equal(config.mode,'production');
 assert.equal(config.chatId,'oc_production');
 assert.deepEqual(config.allowedChats,['oc_production']);
 assert.deepEqual(config.testDelivery,{chatId:'oc_test',allowedChats:['oc_test']});
 assert.deepEqual(config.production,{cutover:true,chatId:'oc_production',allowedChats:['oc_production']});
});
test('production and test targets cannot overlap or activate without an explicit cutover',()=>{
 for(const changed of [
  {BID_PRODUCTION_CUTOVER:'false'},
  {BID_PRODUCTION_CHAT_IDS:'oc_other'},
  {BID_PRODUCTION_CHAT_ID:'oc_test'},
  {BID_PRODUCTION_CHAT_IDS:'oc_production,oc_test'},
  {BID_CARD_SOURCE_ENABLED:'false'},
  {BID_RADAR_POLL_ENABLED:'false'},
  {BID_GROUP_FILE_SOURCE_ENABLED:'false'},
  {BID_REPORT_ARCHIVE_ENABLED:'false'},
  {BID_COMPANY_PROFILE_SYNC_ENABLED:'false'},
 ]) assert.throws(()=>loadConfig(productionEnv(changed)),/production/);
 assert.throws(()=>loadConfig(productionEnv({BID_DELIVERY_MODE:'test'})),/production/);
 const staged=loadConfig(productionEnv({BID_DELIVERY_MODE:'test',BID_PRODUCTION_CUTOVER:'false'}));
 assert.equal(staged.chatId,'oc_test');assert.deepEqual(staged.allowedChats,['oc_test']);
});
