const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {loadConfig,resolveCodexExecutable}=require('../config.cjs');const {createApplication}=require('../main.cjs');
const env={BID_MODEL_BACKEND:'codex',BID_CODEX_EXECUTABLE:process.execPath,BID_CODEX_TOKEN:'b'.repeat(48),BID_CODEX_MODEL:'gpt-6-astra'};
test('Codex 自动路径跟随桌面客户端最新可执行版本',t=>{
 const local=fs.mkdtempSync(path.join(os.tmpdir(),'bid-codex-install-'));t.after(()=>fs.rmSync(local,{recursive:true,force:true}));
 const old=path.join(local,'OpenAI','Codex','bin','old-build','codex.exe'),current=path.join(local,'OpenAI','Codex','bin','current-build','codex.exe');
 fs.mkdirSync(path.dirname(old),{recursive:true});fs.mkdirSync(path.dirname(current),{recursive:true});fs.writeFileSync(old,'old');fs.writeFileSync(current,'current');
 fs.utimesSync(old,new Date('2026-01-01'),new Date('2026-01-01'));fs.utimesSync(current,new Date('2026-02-01'),new Date('2026-02-01'));
 assert.equal(resolveCodexExecutable('auto',{LOCALAPPDATA:local}),current);
 assert.equal(loadConfig({...env,BID_CODEX_EXECUTABLE:'auto',LOCALAPPDATA:local}).codexBridge.executable,current);
});
test('model choices and recommendation are configured separately from the legacy default', () => {
 const c=loadConfig({...env,BID_CODEX_MODELS:'gpt-5.6-terra, gpt-5.6-luna,gpt-5.6-terra',BID_CODEX_RECOMMENDED_MODEL:'gpt-5.6-terra'});
 assert.deepEqual(c.codexBridge.models,['gpt-5.6-terra','gpt-5.6-luna','gpt-6-astra']);
 assert.equal(c.codexBridge.recommendedModel,'gpt-5.6-terra');
 assert.equal(c.modelConfig.model_name,'gpt-6-astra');
 assert.throws(()=>loadConfig({...env,BID_CODEX_RECOMMENDED_MODEL:'not-enabled'}),/codex/);
});
test('Codex backend derives local model settings without a vendor API key',()=>{
 const c=loadConfig(env);assert.equal(c.codexBridge.enabled,true);assert.equal(c.codexBridge.host,'127.0.0.1');assert.equal(c.modelConfig.backend,'codex');assert.equal(c.modelConfig.provider,'custom');
 assert.equal(c.modelConfig.base_url,'http://127.0.0.1:4383/v1');assert.equal(c.modelConfig.api_key,env.BID_CODEX_TOKEN);assert.equal(c.modelConfig.model_name,'gpt-6-astra');
 assert.equal(c.codexBridge.timeoutMs,480000);assert.equal(c.codexBridge.requestTimeoutMs,495000);
 assert.equal(loadConfig({...env,BID_CODEX_TIMEOUT_MS:'480000'}).codexBridge.timeoutMs,480000);
 assert.equal(loadConfig({}).codexBridge.enabled,false);
 for(const bad of [{BID_MODEL_BACKEND:'unknown'},{BID_CODEX_EXECUTABLE:'codex'},{BID_CODEX_TOKEN:'short'},{BID_CODEX_PORT:'4381'},{BID_CODEX_PORT:'0'},{BID_CODEX_TIMEOUT_MS:'600001'}])assert.throws(()=>loadConfig({...env,...bad}),/codex|backend/);
});
test('Codex lifecycle is fenced by runner ownership and readiness follows the bridge',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bid-codex-main-'));let ready=false;const order=[];
 const app=createApplication({...loadConfig({...env,BID_DATA_ROOT:root}),port:0},{readEvidence:async()=>({snapshot:{records:[],warnings:[]},rules:[]}),codexBridgeFactory:({assertOwnership})=>({
  async start(){assertOwnership();order.push('start');ready=true;},async close(){assertOwnership();order.push('close');ready=false;},status:()=>({ready})
 })});
 t.after(async()=>{await app.close();fs.rmSync(root,{recursive:true,force:true});});
 assert.ok(app.readiness().missing.includes('model'));await app.start();assert.deepEqual(order,['start']);assert.equal(app.readiness().missing.includes('model'),false);
 ready=false;assert.ok(app.readiness().missing.includes('model'));ready=true;await app.close();assert.deepEqual(order,['start','close']);
});
