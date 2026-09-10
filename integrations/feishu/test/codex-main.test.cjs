const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {loadConfig}=require('../config.cjs');const {createApplication}=require('../main.cjs');
const env={BID_MODEL_BACKEND:'codex',BID_CODEX_EXECUTABLE:process.execPath,BID_CODEX_TOKEN:'b'.repeat(48),BID_CODEX_MODEL:'gpt-6-astra'};
test('Codex backend derives local model settings without a vendor API key',()=>{
 const c=loadConfig(env);assert.equal(c.codexBridge.enabled,true);assert.equal(c.codexBridge.host,'127.0.0.1');
 assert.equal(c.modelConfig.base_url,'http://127.0.0.1:4383/v1');assert.equal(c.modelConfig.api_key,env.BID_CODEX_TOKEN);assert.equal(c.modelConfig.model_name,'gpt-6-astra');
 assert.equal(loadConfig({}).codexBridge.enabled,false);
 for(const bad of [{BID_MODEL_BACKEND:'unknown'},{BID_CODEX_EXECUTABLE:'codex'},{BID_CODEX_TOKEN:'short'},{BID_CODEX_PORT:'4381'},{BID_CODEX_PORT:'0'},{BID_CODEX_TIMEOUT_MS:'300001'}])assert.throws(()=>loadConfig({...env,...bad}),/codex|backend/);
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
