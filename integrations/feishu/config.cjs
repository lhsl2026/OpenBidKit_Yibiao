const fs=require('node:fs');const path=require('node:path');const net=require('node:net');
const configured=v=>{const s=String(v??'').trim();return /^(?:PENDING_|replace[-_ ]before|your[-_ ](?:api|model)|<.*>)/i.test(s)?'':s;};
const list=v=>String(v??'').split(',').map(s=>s.trim()).filter(Boolean);
function resolveCodexExecutable(value,env=process.env){
 const requested=String(value??'').trim();if(requested!=='auto')return requested;
 const local=String(env.LOCALAPPDATA??'').trim();if(!local)return '';
 const root=path.join(local,'OpenAI','Codex','bin');let entries;try{entries=fs.readdirSync(root,{withFileTypes:true});}catch{return '';}
 const candidates=[];for(const entry of entries){if(!entry.isDirectory())continue;const executable=path.join(root,entry.name,'codex.exe');try{const stat=fs.statSync(executable);if(stat.isFile())candidates.push({executable,mtime:stat.mtimeMs});}catch{}}
 candidates.sort((a,b)=>b.mtime-a.mtime||b.executable.localeCompare(a.executable));return candidates[0]?.executable||'';
}
function internalHost(name){const h=name.replace(/^\[|\]$/g,'').toLowerCase();const ip=net.isIP(h);return ['localhost','::1'].includes(h)||(ip===4&&(/^127\./.test(h)||/^10\./.test(h)||/^192\.168\./.test(h)||/^172\.(1[6-9]|2\d|3[01])\./.test(h)))||(!ip&&!h.includes('.')&&/^[a-z0-9-]+$/.test(h));}
function loadConfig(env=process.env){
 const mode=env.BID_DELIVERY_MODE||'disabled';if(!['disabled','test','production'].includes(mode))throw Error('delivery_mode_invalid');
 const host=env.BID_HOST||'127.0.0.1',apiKey=env.BID_API_KEY||'';
 if((host!=='127.0.0.1'&&host!=='::1')&&apiKey.length<32)throw Error('api_key_required');
 if(apiKey&&apiKey.length<32)throw Error('api_key_too_short');
 const prereadUrl=env.PREREAD_BASE_URL||'';
 if(prereadUrl&&!internalHost(new URL(prereadUrl).hostname))throw Error('preread_must_be_internal');
 const dataRoot=path.resolve(env.BID_DATA_ROOT||path.join(__dirname,'data'));
 const testDelivery={chatId:env.BID_CHAT_ID||'',allowedChats:list(env.BID_TEST_CHAT_IDS)};
 const production={cutover:env.BID_PRODUCTION_CUTOVER==='true',chatId:env.BID_PRODUCTION_CHAT_ID||'',allowedChats:list(env.BID_PRODUCTION_CHAT_IDS)};
 const activeDelivery=mode==='production'?production:testDelivery;
 const config={mode,host,apiKey,dataRoot,port:Number(env.BID_PORT||4381),companyId:env.BID_COMPANY_ID||'',chatId:activeDelivery.chatId,allowedChats:activeDelivery.allowedChats,testDelivery,production,operatorIds:list(env.BID_OPERATOR_IDS),sourceChats:list(env.BID_SOURCE_CHAT_IDS),sourceSenders:list(env.BID_SOURCE_SENDER_IDS),appId:env.LARK_APP_ID||'',appSecret:env.LARK_APP_SECRET||'',verificationToken:env.LARK_VERIFICATION_TOKEN||'',encryptKey:env.LARK_ENCRYPT_KEY||'',prereadUrl,prereadKey:env.PREREAD_HANDOFF_API_KEY||'',relayAuthorization:env.PREREAD_RELAY_AUTHORIZATION||'',databasePath:env.BID_VAULT_DATABASE||'',filesRoot:env.BID_VAULT_FILES||'',mappingsPath:env.BID_VAULT_MAPPINGS||'',rulesPath:env.BID_RULES_FILE||'',writingRoot:path.join(dataRoot,'writing'),electronPath:env.BID_ELECTRON_PATH||path.resolve(__dirname,'../../client/node_modules/electron/dist/electron.exe'),clientRoot:path.resolve(__dirname,'../../client'),modelConfig:{provider:env.MODEL_PROVIDER||'openai',base_url:configured(env.MODEL_PROVIDER_BASE_URL),api_key:configured(env.MODEL_PROVIDER_API_KEY),model_name:configured(env.MODEL_PROVIDER_MODEL)},summaryHour:Number(env.BID_SUMMARY_HOUR||18)};
 if(!Number.isInteger(config.port)||config.port<1||config.port>65535||!Number.isInteger(config.summaryHour)||config.summaryHour<0||config.summaryHour>23)throw Error('config_number_invalid');
 if(mode==='test'&&(!config.chatId||!config.allowedChats.includes(config.chatId)||!config.appId||!config.appSecret||!config.companyId))throw Error('test_delivery_not_configured');
 config.radarPolling={enabled:env.BID_RADAR_POLL_ENABLED==='true',cliPath:env.BID_LARK_CLI_PATH||'',profile:env.BID_LARK_CLI_PROFILE||'',startAt:env.BID_RADAR_START_AT||''};
 if(config.radarPolling.enabled&&(!path.isAbsolute(config.radarPolling.cliPath)||!config.radarPolling.profile))throw Error('radar_cli_not_configured');
 if(config.radarPolling.startAt&&!Number.isFinite(Date.parse(config.radarPolling.startAt)))throw Error('radar_start_invalid');
 config.cardSource={enabled:env.BID_CARD_SOURCE_ENABLED==='true',cliPath:env.BID_LARK_CLI_PATH||'',profile:env.BID_CARD_CLI_PROFILE||''};
 if(config.cardSource.enabled&&(!path.isAbsolute(config.cardSource.cliPath)||!config.cardSource.profile.trim()||!config.chatId||!config.operatorIds.length))throw Error('card_source_not_configured');
 config.documentRecovery={enabled:env.BID_DOCUMENT_RECOVERY_ENABLED==='true',appId:env.BID_MIAODA_APP_ID||'',cliPath:env.BID_LARK_CLI_PATH||'',profile:env.BID_DOCUMENT_CLI_PROFILE||'',root:path.join(config.writingRoot,'sources')};
 const groupFileExtensions=list(env.BID_GROUP_FILE_ALLOWED_EXTENSIONS||'pdf,doc,docx').map(value=>value.toLowerCase());
 config.groupFileSource={enabled:env.BID_GROUP_FILE_SOURCE_ENABLED==='true',appId:env.BID_MIAODA_APP_ID||'',cliPath:env.BID_LARK_CLI_PATH||'',profile:env.BID_GROUP_FILE_CLI_PROFILE||'',startAt:env.BID_GROUP_FILE_START_AT||'',maxBytes:Number(env.BID_GROUP_FILE_MAX_BYTES||30*1024*1024),allowedExtensions:groupFileExtensions,root:path.join(dataRoot,'group-files')};
 if(config.groupFileSource.enabled){const g=config.groupFileSource;if(!path.isAbsolute(g.cliPath)||!g.profile.trim()||!g.startAt||!Number.isFinite(Date.parse(g.startAt))||!Number.isInteger(g.maxBytes)||g.maxBytes<1||g.maxBytes>30*1024*1024||!g.allowedExtensions.length||g.allowedExtensions.some(value=>!['pdf','doc','docx'].includes(value))||new Set(g.allowedExtensions).size!==g.allowedExtensions.length||!config.chatId||config.companyId!=='隆创信息有限公司'||g.appId!=='app_17agc8m97f2'||!config.prereadUrl||!config.relayAuthorization.startsWith('Bearer '))throw Error('group_file_source_not_configured');}
 config.reportArchive={enabled:env.BID_REPORT_ARCHIVE_ENABLED==='true',cliPath:env.BID_LARK_CLI_PATH||'',profile:env.BID_REPORT_CLI_PROFILE||'',identity:env.BID_REPORT_CLI_IDENTITY||'',folderToken:env.BID_REPORT_FOLDER_TOKEN||'',allowedFolderTokens:list(env.BID_REPORT_ALLOWED_FOLDER_TOKENS),root:path.join(dataRoot,'reports')};
 config.companyEvidence={enabled:env.BID_COMPANY_PROFILE_SYNC_ENABLED==='true'};
 if(config.companyEvidence.enabled&&(config.companyId!=='隆创信息有限公司'||!path.isAbsolute(config.databasePath)||!path.isAbsolute(config.filesRoot)||!path.isAbsolute(config.mappingsPath)||!config.prereadUrl||!config.relayAuthorization.startsWith('Bearer ')))throw Error('company_profile_sync_not_configured');
 if(config.reportArchive.enabled){const r=config.reportArchive;if(!['test','production'].includes(mode)||!path.isAbsolute(r.cliPath)||!r.profile.trim()||!['bot','user'].includes(r.identity)||!r.folderToken||!r.allowedFolderTokens.includes(r.folderToken)||!config.prereadUrl||!config.relayAuthorization.startsWith('Bearer '))throw Error('report_archive_not_configured');}
 if(config.documentRecovery.enabled&&(config.documentRecovery.appId!=='app_17agc8m97f2'||!path.isAbsolute(config.documentRecovery.cliPath)||!config.documentRecovery.profile.trim()||!config.chatId||!config.operatorIds.length||!config.prereadUrl||!config.relayAuthorization.startsWith('Bearer ')))throw Error('document_recovery_not_configured');
 const backend=env.BID_MODEL_BACKEND||'api';if(!['api','codex'].includes(backend))throw Error('model_backend_invalid');
 config.codexBridge={enabled:backend==='codex',host:'127.0.0.1',port:Number(env.BID_CODEX_PORT||4383),apiKey:env.BID_CODEX_TOKEN||'',executable:resolveCodexExecutable(env.BID_CODEX_EXECUTABLE,env),model:env.BID_CODEX_MODEL||'gpt-6-astra',reasoningEffort:'low',root:path.join(dataRoot,'codex'),timeoutMs:Number(env.BID_CODEX_TIMEOUT_MS||240000),maxRequestBytes:1024*1024};
 if(config.codexBridge.enabled){
  const c=config.codexBridge;
  c.models=[...new Set([...list(env.BID_CODEX_MODELS),c.model])];
  c.recommendedModel=env.BID_CODEX_RECOMMENDED_MODEL||c.model;
  if(c.models.some(model=>!/^[A-Za-z0-9._-]{1,128}$/.test(model))||!c.models.includes(c.recommendedModel))throw Error('codex_models_not_configured');
  if(!path.isAbsolute(c.executable)||c.apiKey.length<32||!Number.isInteger(c.port)||c.port<1||c.port>65535||c.port===config.port||!Number.isInteger(c.timeoutMs)||c.timeoutMs<1000||c.timeoutMs>300000||!/^[A-Za-z0-9._-]{1,128}$/.test(c.model))throw Error('codex_bridge_not_configured');
  config.modelConfig={provider:'custom',backend:'codex',base_url:'http://127.0.0.1:'+c.port+'/v1',api_key:c.apiKey,model_name:c.model};
 }
 const overlap=production.chatId&&(
  production.chatId===testDelivery.chatId||testDelivery.allowedChats.includes(production.chatId)||production.allowedChats.some(chat=>testDelivery.allowedChats.includes(chat))
 );
 if(overlap)throw Error('production_test_target_overlap');
 if(production.cutover&&mode!=='production')throw Error('production_cutover_mode_invalid');
 if(mode==='production'){
  const missing=[];
  if(!production.cutover)missing.push('cutover');
  if(!production.chatId||!production.allowedChats.includes(production.chatId))missing.push('target');
  if(config.companyId!=='隆创信息有限公司')missing.push('company');
  if(!config.appId||!config.appSecret)missing.push('app');
  if(!config.operatorIds.length)missing.push('operators');
  if(!config.sourceChats.length||!config.sourceSenders.length||!config.radarPolling.enabled)missing.push('radar');
  if(!config.groupFileSource.enabled)missing.push('group_file_source');
  if(!config.cardSource.enabled)missing.push('card_callback');
  if(!config.reportArchive.enabled)missing.push('report_archive');
  if(!config.companyEvidence.enabled)missing.push('company_evidence');
  if(!config.prereadUrl||!config.relayAuthorization.startsWith('Bearer '))missing.push('preread');
  if(!config.modelConfig.api_key||!config.modelConfig.base_url||!config.modelConfig.model_name)missing.push('model');
  if(missing.length)throw Error('production_delivery_not_configured:'+missing.join(','));
 }
 return config;
}
module.exports={loadConfig,internalHost,resolveCodexExecutable};
