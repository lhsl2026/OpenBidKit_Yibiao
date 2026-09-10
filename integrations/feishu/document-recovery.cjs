'use strict';
const fs=require('node:fs');const path=require('node:path');const {createHash}=require('node:crypto');
const {execFile}=require('node:child_process');const {promisify}=require('node:util');const run=promisify(execFile);
const {key}=require('./store.cjs');
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const PREFIX='document-recovery-job:';
const MAX_PDF_BYTES=20*1024*1024;
function officialUrl(value){try{const u=new URL(value);return u.protocol==='https:'&&u.hostname==='ggzy.guizhou.gov.cn'&&!u.port&&!u.username&&!u.password&&!u.hash&&u.pathname==='/tradeInfo/detailHtml'&&[...u.searchParams.keys()].length===1&&/^\d+$/.test(u.searchParams.get('metaId')??'')?u.href:null;}catch{return null;}}
function createAppStorage(options,{runImpl=run}={}){
 async function cli(args,{cwd,signal}={}){
  const {stdout}=await runImpl(options.cliPath,['apps',...args,'--app-id',options.appId,'--as','user','--profile',options.profile,'--format','json'],{cwd,signal,windowsHide:true,timeout:120000,maxBuffer:1024*1024,env:{...process.env,LARKSUITE_CLI_NO_UPDATE_NOTIFIER:'1',LARKSUITE_CLI_NO_SKILLS_NOTIFIER:'1'}});
  const result=JSON.parse(stdout);if(result?.ok!==true||!result.data)throw Error('app_storage_failed');return result.data;
 }
 return {
  async upload({sourcePath,signal}){const data=await cli(['+file-upload','--file','./'+path.basename(sourcePath)],{cwd:path.dirname(sourcePath),signal});if(typeof data.path!=='string'||!data.path.startsWith('/'))throw Error('upload_receipt_invalid');return {remotePath:data.path};},
  async sign({remotePath,signal}){const data=await cli(['+file-sign','--path',remotePath,'--expires-in','600'],{signal});return {url:data.signed_url};}
 };
}
function createDocumentRecovery({store,config,provider,storage,attach,assertOwnership=()=>{},isSourceActive=()=>true,clock=Date.now}){
 const options=config.documentRecovery??{enabled:false};let running=false;
 if(options.enabled&&(!path.isAbsolute(options.cliPath??'')||!options.profile||options.appId!=='app_17agc8m97f2'||!config.chatId||!config.operatorIds?.length))throw Error('document_recovery_not_configured');
 const root=path.resolve(options.root??path.join(config.writingRoot??path.join(config.dataRoot,'writing'),'sources'));
 const save=job=>store.set(PREFIX+job.id,job);
 const list=()=>store.db.prepare("SELECT value FROM settings WHERE key LIKE 'document-recovery-job:%' ORDER BY key").all().map(row=>JSON.parse(row.value));
 function queueReceipt(receipt,meta={}){
  if(!options.enabled)return [];
  assertOwnership();
  let projects,results;
  if(receipt?.status==='processed'){projects=receipt.projects;results=receipt.results;}
  else if(receipt?.status==='selection_processed'&&receipt.selection?.status==='processed'){projects=receipt.selection.selectedProjects;results=receipt.selection.results;}
  if(!Array.isArray(projects)||!Array.isArray(results)||projects.length!==results.length)return [];
  const ids=[];
  for(let i=0;i<results.length;i++){
   const result=results[i],project=projects[i],url=officialUrl(project?.officialUrl),acquisition=result?.acquisition;
   if(result?.status!=='triggered'||!uuid(result.taskId)||acquisition?.status!=='waiting_upload'||acquisition.errorCode!=='complete_tender_document_missing'||!uuid(acquisition.actionId)||!url)continue;
   const id=key('document-recovery',result.taskId,acquisition.actionId),existing=store.get(PREFIX+id);
   if(existing){if(existing.sourceUrl!==url)continue;if(!existing.sourceInboxId&&typeof meta.inboxId==='string')save({...existing,sourceInboxId:meta.inboxId});ids.push(id);continue;}
   const job={id,stage:'download',taskId:result.taskId,actionId:acquisition.actionId,sourceUrl:url,...(typeof meta.inboxId==='string'?{sourceInboxId:meta.inboxId}:{}),...(typeof project.sourceMessageId==='string'?{sourceMessageId:project.sourceMessageId}:{}),createdAt:clock(),updatedAt:clock(),error:null};
   save(job);ids.push(id);
  }
  return ids;
 }
 function bind(job){
  assertOwnership();if(!isSourceActive(job))return false;
  const source={sourcePath:job.sourcePath,sha256:job.sha256,sourceUrl:job.sourceUrl,actionId:job.actionId,...(job.sourceInboxId?{sourceInboxId:job.sourceInboxId}:{})};
  store.set('document-source:'+job.taskId,source);
  const row=store.db.prepare('SELECT payload FROM watches WHERE task_id=?').get(job.taskId);
  store.watch(job.taskId,{...(row?JSON.parse(row.payload):{}),companyId:config.companyId,sourcePath:job.sourcePath,sourceChecksum:job.sha256,...(job.sourceInboxId?{sourceInboxId:job.sourceInboxId}:{})});return true;
 }
 function localFile(job){
  if(typeof job.sourcePath!=='string'||!/^([a-f0-9]{64})$/.test(job.sha256??''))throw Error('document_local_invalid');
  const file=fs.realpathSync.native(job.sourcePath),base=fs.realpathSync.native(root),relative=path.relative(base,file);
  if(relative.startsWith('..')||path.isAbsolute(relative)||!relative)throw Error('document_local_invalid');
  const stat=fs.statSync(file);if(!stat.isFile()||stat.size>MAX_PDF_BYTES||stat.size<5)throw Error('document_local_invalid');
  const fd=fs.openSync(file,'r');
  try{
   const opened=fs.fstatSync(fd);if(!opened.isFile()||opened.size>MAX_PDF_BYTES||opened.size<5)throw Error('document_local_invalid');
   const digest=createHash('sha256'),buffer=Buffer.alloc(64*1024);let total=0,count;
   while((count=fs.readSync(fd,buffer,0,buffer.length,null))>0){if(total===0&&buffer.subarray(0,5).toString()!=='%PDF-')throw Error('document_local_invalid');total+=count;if(total>MAX_PDF_BYTES)throw Error('document_local_invalid');digest.update(buffer.subarray(0,count));}
   if(total!==opened.size||digest.digest('hex')!==job.sha256)throw Error('document_local_invalid');
  }finally{fs.closeSync(fd);}
  return file;
 }
 function seedAttached(value){
  assertOwnership();if(!uuid(value?.taskId)||!uuid(value?.actionId)||!officialUrl(value.sourceUrl)||typeof value.documentId!=='string'||!value.documentId)throw Error('document_seed_invalid');
  if(value.sourceInboxId!==undefined&&(typeof value.sourceInboxId!=='string'||!value.sourceInboxId))throw Error('document_seed_invalid');
  const job={id:key('document-recovery',value.taskId,value.actionId),taskId:value.taskId,actionId:value.actionId,sourceUrl:officialUrl(value.sourceUrl),sourcePath:value.sourcePath,sha256:value.sha256,documentId:value.documentId,documentVersion:value.documentVersion,...(value.sourceInboxId?{sourceInboxId:value.sourceInboxId}:{}),stage:'attached',error:null,createdAt:clock(),updatedAt:clock()};
  job.sourcePath=localFile(job);store.transaction(()=>{save(job);bind(job);});return job;
 }
 async function post({taskId,body,signal}){
  if(!config.relayAuthorization?.startsWith('Bearer '))throw Error('manual_auth_missing');
  const base=new URL(config.prereadUrl);
  const r=await fetch(base.origin+'/openapi/preread/tasks/'+encodeURIComponent(taskId)+'/manual-documents',{method:'POST',headers:{authorization:config.relayAuthorization,'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(60000)]):AbortSignal.timeout(60000)});
  if(!r.ok)throw Error('manual_response_unknown');return r.json();
 }
 async function tick({signal}={}){
  if(!options.enabled||running||signal?.aborted)return;running=true;
  const own=()=>{assertOwnership();if(signal?.aborted)throw Error('document_recovery_stopped');};
  const manual=(job,code)=>{own();save({...job,stage:'manual',error:code,updatedAt:clock()});};
  const active=job=>{own();if(!isSourceActive(job)){manual(job,'document_source_edited');return false;}return true;};
  try{
   own();const job=list().find(j=>!['attached','manual'].includes(j.stage)&&(!j.nextAt||j.nextAt<=clock()));if(!job)return;
   if(!active(job))return;
   if(['uploading','attaching'].includes(job.stage)){manual(job,job.stage==='uploading'?'document_upload_unknown':'document_attach_unknown');return;}
   if(['download','downloading'].includes(job.stage)){
    save({...job,stage:'downloading'});let result;
    try{result=await (provider??require('./guizhou-source.cjs').createGuizhouSource({})).recover({sourceUrl:job.sourceUrl,signal});}catch{own();manual(job,'document_download_failed');return;}
    if(!active(job))return;
    if(result?.status!=='obtained'){manual(job,'document_provider_manual');return;}
    if(!Buffer.isBuffer(result.bytes)||result.bytes.length>MAX_PDF_BYTES||result.bytes.subarray(0,5).toString()!=='%PDF-'||hash(result.bytes)!==result.sha256){manual(job,'document_download_invalid');return;}
    fs.mkdirSync(root,{recursive:true});const sourcePath=path.join(root,result.sha256+'-招标文件正文.pdf');
    if(fs.existsSync(sourcePath)){try{localFile({sourcePath,sha256:result.sha256});}catch{manual(job,'document_local_invalid');return;}}
    else fs.writeFileSync(sourcePath,result.bytes,{flag:'wx'});
    const next={...job,stage:'downloaded',sourcePath,sha256:result.sha256,updatedAt:clock(),error:null};
    store.transaction(()=>{save(next);bind(next);});return;
   }
   let sourcePath;try{sourcePath=localFile(job);}catch{manual(job,'document_local_invalid');return;}
   const client=storage??createAppStorage(options);
   if(job.stage==='downloaded'){
    save({...job,stage:'uploading',updatedAt:clock()});let result;
    try{result=await client.upload({sourcePath,signal});}catch{own();manual(job,'document_upload_unknown');return;}
    if(!active(job))return;
    if(typeof result?.remotePath!=='string'||!result.remotePath.startsWith('/')||/[\r\n?#]/.test(result.remotePath)){manual(job,'document_upload_unknown');return;}
    save({...job,stage:'uploaded',remotePath:result.remotePath,updatedAt:clock(),error:null});return;
   }
   if(job.stage==='uploaded'){
    let signed;try{signed=await client.sign({remotePath:job.remotePath,signal});}catch{own();save({...job,nextAt:clock()+60000,error:'document_sign_failed'});return;}
    if(!active(job))return;let url;try{url=new URL(signed.url);if(url.protocol!=='https:'||url.username||url.password)throw Error();}catch{manual(job,'document_sign_invalid');return;}
    save({...job,stage:'attaching',updatedAt:clock()});let response;
    try{response=await (attach??post)({taskId:job.taskId,body:{chatId:config.chatId,manualActionId:job.actionId,actorId:config.operatorIds[0],candidate:{url:url.href,fileName:path.basename(sourcePath),officialCategory:'tender_document'}},signal});}catch{own();manual(job,'document_attach_unknown');return;}
    if(!active(job))return;
    const acquired=response?.acquisition;if(!['acquired','duplicate'].includes(acquired?.status)||typeof acquired.documentId!=='string'||!acquired.documentId){manual(job,'document_attach_unknown');return;}
    const next={...job,stage:'attached',documentId:acquired.documentId,documentVersion:acquired.documentVersion,updatedAt:clock(),error:null};store.transaction(()=>{save(next);bind(next);});return;
   }
   manual(job,'document_stage_invalid');
  }finally{running=false;}
 }
 return {queueReceipt,tick,seedAttached,list};
}
module.exports={createDocumentRecovery,createAppStorage,officialUrl};
