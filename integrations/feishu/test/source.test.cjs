const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {createHash,createCipheriv}=require('node:crypto');
const {createHttpServer,openCallback}=require('../server.cjs');const {createStore}=require('../store.cjs');const {createWorkflow}=require('../workflow.cjs');
test('encrypted challenge permits only a matching token; business events still need signature',()=>{
 function encrypt(body){const iv=Buffer.alloc(16,1);const c=createCipheriv('aes-256-cbc',createHash('sha256').update('k').digest(),iv);return Buffer.from(JSON.stringify({encrypt:Buffer.concat([iv,c.update(JSON.stringify(body)),c.final()]).toString('base64')}));}
 assert.equal(openCallback(encrypt({type:'url_verification',token:'t',challenge:'abc'}),{},{verificationToken:'t',encryptKey:'k'}).challenge,'abc');
 assert.throws(()=>openCallback(encrypt({type:'url_verification',token:'wrong',challenge:'abc'}),{},{verificationToken:'t',encryptKey:'k'}),/token/);
 assert.throws(()=>openCallback(encrypt({header:{token:'t',event_type:'card.action.trigger'}}),{},{verificationToken:'t',encryptKey:'k'}),/signature/);
});
test('source upload must match exact current handoff and revokes prior follow decision',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bid-source-'));const store=createStore(':memory:');let server;
 t.after(async()=>{await new Promise(r=>server.close(r));store.close();fs.rmSync(root,{recursive:true,force:true});});
 const bytes=Buffer.from('招标原文测试');const hash=createHash('sha256').update(bytes).digest('hex');const input={companyId:'c',deadline:'2099-01-01',handoff:{schemaVersion:'1.0',task:{taskId:'t',title:'测试'},snapshot:{documentVersion:'v1',reportId:'r',checksum:'sha256:'+hash,generatedAt:'2026-09-09T00:00:00Z'},latestDocumentVersion:'v1',status:'ready',superseded:false,requirements:[],warnings:[],evidence:[]}};
 const workflow=createWorkflow({store,assess:()=>({decision:'follow',items:[],actions:[],blockers:[]})});const p=workflow.ingest(input);store.decide(p.id,'follow','actor',0);
 const config={apiKey:'secret',companyId:'c',writingRoot:root};server=createHttpServer({config,workflow,store,readiness:()=>({ready:true})});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const url='http://127.0.0.1:'+server.address().port+'/sources?projectId='+p.id+'&name=tender.txt';const headers={authorization:'Bearer secret'};
 assert.equal((await fetch(url,{method:'POST',headers,body:'wrong'})).status,409);assert.equal(store.getProject(p.id).humanDecision,'follow');
 assert.equal((await fetch(url,{method:'POST',headers,body:bytes})).status,200);assert.equal(store.getProject(p.id).humanDecision,null);assert.deepEqual(fs.readFileSync(store.getProject(p.id).input.sourcePath),bytes);
});
