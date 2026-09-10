const path=require('node:path');const net=require('node:net');
const configured=v=>{const s=String(v??'').trim();return /^(?:PENDING_|replace[-_ ]before|your[-_ ](?:api|model)|<.*>)/i.test(s)?'':s;};
const list=v=>String(v??'').split(',').map(s=>s.trim()).filter(Boolean);
function internalHost(name){const h=name.replace(/^\[|\]$/g,'').toLowerCase();const ip=net.isIP(h);return ['localhost','::1'].includes(h)||(ip===4&&(/^127\./.test(h)||/^10\./.test(h)||/^192\.168\./.test(h)||/^172\.(1[6-9]|2\d|3[01])\./.test(h)))||(!ip&&!h.includes('.')&&/^[a-z0-9-]+$/.test(h));}
function loadConfig(env=process.env){
 const mode=env.BID_DELIVERY_MODE||'disabled';if(!['disabled','test'].includes(mode))throw Error('delivery_mode_invalid');
 const host=env.BID_HOST||'127.0.0.1',apiKey=env.BID_API_KEY||'';
 if((host!=='127.0.0.1'&&host!=='::1')&&apiKey.length<32)throw Error('api_key_required');
 if(apiKey&&apiKey.length<32)throw Error('api_key_too_short');
 const prereadUrl=env.PREREAD_BASE_URL||'';
 if(prereadUrl&&!internalHost(new URL(prereadUrl).hostname))throw Error('preread_must_be_internal');
 const dataRoot=path.resolve(env.BID_DATA_ROOT||path.join(__dirname,'data'));
 const config={mode,host,apiKey,dataRoot,port:Number(env.BID_PORT||4381),companyId:env.BID_COMPANY_ID||'',chatId:env.BID_CHAT_ID||'',allowedChats:list(env.BID_TEST_CHAT_IDS),operatorIds:list(env.BID_OPERATOR_IDS),sourceChats:list(env.BID_SOURCE_CHAT_IDS),sourceSenders:list(env.BID_SOURCE_SENDER_IDS),appId:env.LARK_APP_ID||'',appSecret:env.LARK_APP_SECRET||'',verificationToken:env.LARK_VERIFICATION_TOKEN||'',encryptKey:env.LARK_ENCRYPT_KEY||'',prereadUrl,prereadKey:env.PREREAD_HANDOFF_API_KEY||'',relayAuthorization:env.PREREAD_RELAY_AUTHORIZATION||'',databasePath:env.BID_VAULT_DATABASE||'',filesRoot:env.BID_VAULT_FILES||'',mappingsPath:env.BID_VAULT_MAPPINGS||'',rulesPath:env.BID_RULES_FILE||'',writingRoot:path.join(dataRoot,'writing'),electronPath:env.BID_ELECTRON_PATH||path.resolve(__dirname,'../../client/node_modules/electron/dist/electron.exe'),clientRoot:path.resolve(__dirname,'../../client'),modelConfig:{provider:env.MODEL_PROVIDER||'openai',base_url:configured(env.MODEL_PROVIDER_BASE_URL),api_key:configured(env.MODEL_PROVIDER_API_KEY),model_name:configured(env.MODEL_PROVIDER_MODEL)},summaryHour:Number(env.BID_SUMMARY_HOUR||18)};
 if(!Number.isInteger(config.port)||config.port<1||config.port>65535||!Number.isInteger(config.summaryHour)||config.summaryHour<0||config.summaryHour>23)throw Error('config_number_invalid');
 if(mode==='test'&&(!config.chatId||!config.allowedChats.includes(config.chatId)||!config.appId||!config.appSecret||!config.companyId))throw Error('test_delivery_not_configured');
 config.radarPolling={enabled:env.BID_RADAR_POLL_ENABLED==='true',cliPath:env.BID_LARK_CLI_PATH||'',profile:env.BID_LARK_CLI_PROFILE||'',startAt:env.BID_RADAR_START_AT||''};
 if(config.radarPolling.enabled&&(!path.isAbsolute(config.radarPolling.cliPath)||!config.radarPolling.profile))throw Error('radar_cli_not_configured');
 if(config.radarPolling.startAt&&!Number.isFinite(Date.parse(config.radarPolling.startAt)))throw Error('radar_start_invalid');
 config.cardSource={enabled:env.BID_CARD_SOURCE_ENABLED==='true',cliPath:env.BID_LARK_CLI_PATH||'',profile:env.BID_CARD_CLI_PROFILE||''};
 if(config.cardSource.enabled&&(!path.isAbsolute(config.cardSource.cliPath)||!config.cardSource.profile.trim()||!config.chatId||!config.operatorIds.length))throw Error('card_source_not_configured');
 config.documentRecovery={enabled:env.BID_DOCUMENT_RECOVERY_ENABLED==='true',appId:env.BID_MIAODA_APP_ID||'',cliPath:env.BID_LARK_CLI_PATH||'',profile:env.BID_DOCUMENT_CLI_PROFILE||'',root:path.join(config.writingRoot,'sources')};
 if(config.documentRecovery.enabled&&(config.documentRecovery.appId!=='app_17agc8m97f2'||!path.isAbsolute(config.documentRecovery.cliPath)||!config.documentRecovery.profile.trim()||!config.chatId||!config.operatorIds.length||!config.prereadUrl||!config.relayAuthorization.startsWith('Bearer ')))throw Error('document_recovery_not_configured');
 const backend=env.BID_MODEL_BACKEND||'api';if(!['api','codex'].includes(backend))throw Error('model_backend_invalid');
 config.codexBridge={enabled:backend==='codex',host:'127.0.0.1',port:Number(env.BID_CODEX_PORT||4383),apiKey:env.BID_CODEX_TOKEN||'',executable:env.BID_CODEX_EXECUTABLE||'',model:env.BID_CODEX_MODEL||'gpt-6-astra',reasoningEffort:'low',root:path.join(dataRoot,'codex'),timeoutMs:Number(env.BID_CODEX_TIMEOUT_MS||240000),maxRequestBytes:1024*1024};
 if(config.codexBridge.enabled){
  const c=config.codexBridge;
  if(!path.isAbsolute(c.executable)||c.apiKey.length<32||!Number.isInteger(c.port)||c.port<1||c.port>65535||c.port===config.port||!Number.isInteger(c.timeoutMs)||c.timeoutMs<1000||c.timeoutMs>300000||!/^[A-Za-z0-9._-]{1,128}$/.test(c.model))throw Error('codex_bridge_not_configured');
  config.modelConfig={provider:'openai',base_url:'http://127.0.0.1:'+c.port+'/v1',api_key:c.apiKey,model_name:c.model};
 }
 return config;
}
module.exports={loadConfig,internalHost};
