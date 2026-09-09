const path=require('node:path');const net=require('node:net');
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
 const config={mode,host,apiKey,dataRoot,port:Number(env.BID_PORT||4381),companyId:env.BID_COMPANY_ID||'',chatId:env.BID_CHAT_ID||'',allowedChats:list(env.BID_TEST_CHAT_IDS),operatorIds:list(env.BID_OPERATOR_IDS),sourceChats:list(env.BID_SOURCE_CHAT_IDS),sourceSenders:list(env.BID_SOURCE_SENDER_IDS),appId:env.LARK_APP_ID||'',appSecret:env.LARK_APP_SECRET||'',verificationToken:env.LARK_VERIFICATION_TOKEN||'',encryptKey:env.LARK_ENCRYPT_KEY||'',prereadUrl,prereadKey:env.PREREAD_HANDOFF_API_KEY||'',relayAuthorization:env.PREREAD_RELAY_AUTHORIZATION||'',databasePath:env.BID_VAULT_DATABASE||'',filesRoot:env.BID_VAULT_FILES||'',mappingsPath:env.BID_VAULT_MAPPINGS||'',rulesPath:env.BID_RULES_FILE||'',writingRoot:path.join(dataRoot,'writing'),electronPath:env.BID_ELECTRON_PATH||path.resolve(__dirname,'../../client/node_modules/electron/dist/electron.exe'),clientRoot:path.resolve(__dirname,'../../client'),modelConfig:{provider:env.MODEL_PROVIDER||'openai',base_url:env.MODEL_PROVIDER_BASE_URL||'',api_key:env.MODEL_PROVIDER_API_KEY||'',model_name:env.MODEL_PROVIDER_MODEL||''},summaryHour:Number(env.BID_SUMMARY_HOUR||18)};
 if(!Number.isInteger(config.port)||config.port<1||config.port>65535||!Number.isInteger(config.summaryHour)||config.summaryHour<0||config.summaryHour>23)throw Error('config_number_invalid');
 if(mode==='test'&&(!config.chatId||!config.allowedChats.includes(config.chatId)||!config.appId||!config.appSecret||!config.companyId))throw Error('test_delivery_not_configured');
 return config;
}
module.exports={loadConfig,internalHost};
