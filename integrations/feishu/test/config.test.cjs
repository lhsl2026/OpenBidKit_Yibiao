const {test}=require('node:test');const assert=require('node:assert/strict');const {internalHost,loadConfig}=require('../config.cjs');
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
