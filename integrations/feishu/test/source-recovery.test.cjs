const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {recoverWritingSource,stageVerifiedWritingSource}=require('../source-recovery.cjs');

test('recovers only the exact PDF bound to the current handoff checksum',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bid-source-recovery-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const bytes=Buffer.from('%PDF-1.7\nverified tender\n%%EOF'),sha256=createHash('sha256').update(bytes).digest('hex');
 const project={taskId:'task/id',checksum:'sha256:'+sha256,version:'1'};
 const result=await recoverWritingSource({project,root,client:{getSourceDocument:async(taskId,version)=>{assert.equal(taskId,'task/id');assert.equal(version,'1');return{bytes,sha256};}}});
 assert.equal(result.sha256,sha256);assert.equal(fs.readFileSync(result.sourcePath).equals(bytes),true);assert.equal(path.dirname(result.sourcePath),path.join(root,'sources'));
});

test('rejects a recovered document whose bytes do not match the handoff',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bid-source-recovery-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const bytes=Buffer.from('%PDF-1.7\nwrong tender\n%%EOF');
 await assert.rejects(recoverWritingSource({project:{taskId:'task',checksum:'sha256:'+'a'.repeat(64),version:'1'},root,client:{getSourceDocument:async()=>({bytes,sha256:'a'.repeat(64)})}}),/checksum/);
 assert.deepEqual(fs.readdirSync(root),[]);
});

test('stages a verified group PDF inside the protected writing source root',t=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'bid-source-stage-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 const writingRoot=path.join(base,'writing'),groupRoot=path.join(base,'group-files','objects');fs.mkdirSync(groupRoot,{recursive:true});
 const bytes=Buffer.from('%PDF-1.7\nverified group tender\n%%EOF'),sha256=createHash('sha256').update(bytes).digest('hex');
 const groupPath=path.join(groupRoot,sha256+'.pdf');fs.writeFileSync(groupPath,bytes);
 const result=stageVerifiedWritingSource({sourcePath:groupPath,sha256,root:writingRoot,allowedRoots:[groupRoot]});
 assert.equal(result.sha256,sha256);assert.equal(path.dirname(result.sourcePath),path.join(writingRoot,'sources'));
 assert.equal(fs.readFileSync(result.sourcePath).equals(bytes),true);
});

test('staging rejects untrusted paths and checksum changes without copying them',t=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'bid-source-stage-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 const writingRoot=path.join(base,'writing'),allowedRoot=path.join(base,'group-files','objects'),outsideRoot=path.join(base,'outside');
 fs.mkdirSync(allowedRoot,{recursive:true});fs.mkdirSync(outsideRoot,{recursive:true});
 const bytes=Buffer.from('%PDF-1.7\nuntrusted tender\n%%EOF'),sha256=createHash('sha256').update(bytes).digest('hex');
 const outsidePath=path.join(outsideRoot,'tender.pdf');fs.writeFileSync(outsidePath,bytes);
 assert.throws(()=>stageVerifiedWritingSource({sourcePath:outsidePath,sha256,root:writingRoot,allowedRoots:[allowedRoot]}),/source_path_untrusted/);
 const allowedPath=path.join(allowedRoot,'tender.pdf');fs.writeFileSync(allowedPath,bytes);
 assert.throws(()=>stageVerifiedWritingSource({sourcePath:allowedPath,sha256:'a'.repeat(64),root:writingRoot,allowedRoots:[allowedRoot]}),/source_checksum_mismatch/);
 assert.equal(fs.existsSync(path.join(writingRoot,'sources',sha256+'.pdf')),false);
});
