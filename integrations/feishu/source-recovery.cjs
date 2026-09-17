'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const MAX_SOURCE_BYTES=30*1024*1024;

function inspect(bytes,expected){
 if(!Buffer.isBuffer(bytes)||bytes.length<5||bytes.length>MAX_SOURCE_BYTES||bytes.subarray(0,5).toString('ascii')!=='%PDF-')throw Error('source_document_invalid');
 const actual=createHash('sha256').update(bytes).digest('hex');if(actual!==expected)throw Error('source_checksum_mismatch');return actual;
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
module.exports={recoverWritingSource};
