'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {inspectLocalFile}=require('./group-file-source.cjs');
const MAX_SOURCE_BYTES=30*1024*1024;

function inspect(bytes,expected){
 if(!Buffer.isBuffer(bytes)||bytes.length<5||bytes.length>MAX_SOURCE_BYTES||bytes.subarray(0,5).toString('ascii')!=='%PDF-')throw Error('source_document_invalid');
 const actual=createHash('sha256').update(bytes).digest('hex');if(actual!==expected)throw Error('source_checksum_mismatch');return actual;
}
function stageVerifiedWritingSource({sourcePath,sha256,root,allowedRoots=[]}){
 const expected=String(sha256??'').replace(/^sha256:/i,'').toLowerCase();
 if(typeof sourcePath!=='string'||!path.isAbsolute(sourcePath)||!path.isAbsolute(root??'')||!/^[a-f0-9]{64}$/.test(expected))throw Error('source_staging_invalid');
 let resolved;try{resolved=fs.realpathSync.native(sourcePath);}catch{throw Error('source_not_found');}
 const roots=[path.join(root,'sources'),...(Array.isArray(allowedRoots)?allowedRoots:[])].map(value=>path.resolve(value));
 fs.mkdirSync(roots[0],{recursive:true});
 const trustedRoot=roots.find(candidate=>{
  let realRoot;try{realRoot=fs.realpathSync.native(candidate);}catch{return false;}
  const relative=path.relative(realRoot,resolved);return Boolean(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);
 });
 if(!trustedRoot)throw Error('source_path_untrusted');
 const inspected=inspectLocalFile({filePath:resolved,fileName:path.basename(resolved),maxBytes:MAX_SOURCE_BYTES,allowedExtensions:['pdf','doc','docx'],root:trustedRoot});
 if(inspected.sha256!==expected)throw Error('source_checksum_mismatch');
 const destinationRoot=roots[0],destination=path.join(destinationRoot,expected+inspected.extension);
 if(path.resolve(resolved)===path.resolve(destination))return{sourcePath:destination,sha256:expected};
 if(fs.existsSync(destination)){
  const existing=inspectLocalFile({filePath:destination,fileName:path.basename(destination),maxBytes:MAX_SOURCE_BYTES,allowedExtensions:['pdf','doc','docx'],root:destinationRoot});
  if(existing.sha256!==expected)throw Error('source_checksum_mismatch');return{sourcePath:destination,sha256:expected};
 }
 const temporary=destination+'.'+process.pid+'.'+Date.now()+'.tmp'+inspected.extension;
 try{fs.copyFileSync(resolved,temporary,fs.constants.COPYFILE_EXCL);fs.renameSync(temporary,destination);}
 catch(error){try{fs.rmSync(temporary,{force:true});}catch{}if(!fs.existsSync(destination))throw error;}
 const copied=inspectLocalFile({filePath:destination,fileName:path.basename(destination),maxBytes:MAX_SOURCE_BYTES,allowedExtensions:['pdf','doc','docx'],root:destinationRoot});
 if(copied.sha256!==expected)throw Error('source_checksum_mismatch');return{sourcePath:destination,sha256:expected};
}
async function recoverWritingSource({project,root,client}){
 const taskId=project?.taskId,version=String(project?.version??''),expected=String(project?.checksum??'').replace(/^sha256:/i,'').toLowerCase();
 if(typeof taskId!=='string'||!taskId||!version||!/^[a-f0-9]{64}$/.test(expected)||!path.isAbsolute(root??'')||typeof client?.getSourceDocument!=='function')throw Error('source_recovery_invalid');
 const response=await client.getSourceDocument(taskId,version);if(response?.sha256!==expected)throw Error('source_checksum_mismatch');inspect(response.bytes,expected);
 const dir=path.join(root,'sources');fs.mkdirSync(dir,{recursive:true});const sourcePath=path.join(dir,expected+'.pdf');
 if(fs.existsSync(sourcePath)){inspect(fs.readFileSync(sourcePath),expected);return{sourcePath,sha256:expected};}
 const temporary=sourcePath+'.'+process.pid+'.tmp';try{fs.writeFileSync(temporary,response.bytes,{flag:'wx'});fs.renameSync(temporary,sourcePath);}catch(error){try{fs.rmSync(temporary,{force:true});}catch{}if(!fs.existsSync(sourcePath))throw error;inspect(fs.readFileSync(sourcePath),expected);}
 return{sourcePath,sha256:expected};
}
module.exports={recoverWritingSource,stageVerifiedWritingSource};
