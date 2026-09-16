'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {key}=require('./store.cjs');
const {createAppStorage}=require('./document-recovery.cjs');
const {recordReceipt}=require('./receipt.cjs');

const run=promisify(execFile);

function historyArguments({chatId,start,end,token,profile,pageSize=50}){
 const args=['im','+chat-messages-list','--chat-id',chatId,'--as','user','--profile',profile,'--start',new Date(start).toISOString(),'--end',new Date(end).toISOString(),'--order','asc','--page-size',String(pageSize),'--no-reactions','--format','json'];
 if(token)args.push('--page-token',token);return args;
}

function parseFileDescriptor(content){
 let value=content;if(typeof value==='string'){try{value=JSON.parse(value);}catch{value=null;}}
 if(value&&typeof value==='object'&&!Array.isArray(value)){
  const fileKey=value.file_key??value.fileKey,fileName=value.file_name??value.fileName;
  if(typeof fileKey==='string'&&typeof fileName==='string'&&fileKey.trim()&&fileName.trim())return {fileKey:fileKey.trim(),fileName:fileName.trim()};
 }
 if(typeof content!=='string')return null;
 const match=/\[File:\s*([^\]]+)\]\((file_[A-Za-z0-9_-]+)\)/u.exec(content);
 return match?{fileName:match[1].trim(),fileKey:match[2]}:null;
}

function messageTime(value){
 const stamp=String(value??'');
 if(/^\d{13}$/.test(stamp))return Number(stamp);
 if(/^\d{4}-\d\d-\d\d \d\d:\d\d(?::\d\d)?$/.test(stamp))return Date.parse(stamp.replace(' ','T')+'+08:00');
 return Date.parse(stamp);
}

function safeFileName(value){
 if(typeof value!=='string'){throw Error('group_file_name_invalid');}
 const name=value.trim();
 if(!name||name!==path.basename(name)||/[\\/\0-\x1f\x7f]/u.test(name))throw Error('group_file_name_invalid');
 return name;
}

function normalizeFileMessage(message,config,{ignoreStart=false}={}){
 const options=config.groupFileSource??{};
 if(message?.deleted||message?.chat_id!==config.chatId||message?.msg_type!=='file'||message?.sender?.sender_type!=='user')return null;
 const createTime=messageTime(message.create_time),start=Date.parse(options.startAt??'');
 if(!Number.isFinite(createTime)||(!ignoreStart&&Number.isFinite(start)&&createTime<start))return null;
 if(typeof message.message_id!=='string'||!/^om_[A-Za-z0-9_-]+$/.test(message.message_id))throw Error('group_file_message_invalid');
 const senderId=message.sender?.id;if(typeof senderId!=='string'||!senderId)throw Error('group_file_message_invalid');
 const file=parseFileDescriptor(message.content);if(!file||!/^file_[A-Za-z0-9_-]+$/.test(file.fileKey))throw Error('group_file_message_invalid');
 return {chatId:message.chat_id,messageId:message.message_id,senderId,createTime:String(createTime),fileName:safeFileName(file.fileName),fileKey:file.fileKey,replyTo:typeof message.parent_id==='string'&&message.parent_id?message.parent_id:null};
}

function inspectLocalFile({filePath,fileName,maxBytes,allowedExtensions,root}){
 const safeName=safeFileName(fileName),extension=path.extname(safeName).toLowerCase();
 if(!extension||!allowedExtensions.includes(extension.slice(1)))throw Error('group_file_type_unsupported');
 const base=fs.realpathSync.native(root),resolved=fs.realpathSync.native(filePath),relative=path.relative(base,resolved);
 if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('group_file_path_invalid');
 const stat=fs.statSync(resolved);if(!stat.isFile()||stat.size<1)throw Error('group_file_content_invalid');if(stat.size>maxBytes)throw Error('group_file_too_large');
 const bytes=fs.readFileSync(resolved);let valid=false;
 if(extension==='.pdf')valid=bytes.subarray(0,5).toString()==='%PDF-';
 else if(extension==='.doc')valid=bytes.length>=8&&bytes.subarray(0,8).equals(Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]));
 else if(extension==='.docx'){const head=bytes.subarray(0,4);const zip=head.equals(Buffer.from([0x50,0x4b,0x03,0x04]))||head.equals(Buffer.from([0x50,0x4b,0x05,0x06]))||head.equals(Buffer.from([0x50,0x4b,0x07,0x08]));valid=zip&&bytes.includes(Buffer.from('[Content_Types].xml'))&&bytes.includes(Buffer.from('word/'));}
 if(!valid)throw Error('group_file_content_invalid');
 return {sha256:createHash('sha256').update(bytes).digest('hex'),size:stat.size,extension};
}

function matchName(value){return safeFileName(value).replace(/\.[^.]+$/u,'').toLowerCase().replace(/招标文件|采购文件|投标文件|正文/gu,'').replace(/[^\p{L}\p{N}]/gu,'');}
function matchWaitingTask({job,candidates}){
 const reply=(candidates??[]).filter(candidate=>job.replyTo&&candidate.statusCardMessageId===job.replyTo);
 if(reply.length===1)return {status:'unique',candidate:reply[0],mode:'reply'};
 if(reply.length>1)return {status:'ambiguous',candidates:reply};
 const file=matchName(job.fileName),matches=(candidates??[]).filter(candidate=>{
  if(typeof candidate.title!=='string'||!candidate.title.trim())return false;const title=matchName(candidate.title);return title.length>=6&&(file===title||file.includes(title)||title.includes(file));
 });
 if(matches.length===1)return {status:'unique',candidate:matches[0],mode:'title'};
 if(matches.length>1)return {status:'ambiguous',candidates:matches};
 return {status:'none'};
}

function createFileDownloader(options,{runImpl=run}={}){
 const root=path.resolve(options.root);
 async function download(job,{signal}={}){
  if(typeof job?.id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(job.id)||typeof job.messageId!=='string'||typeof job.fileKey!=='string')throw Error('group_file_download_invalid');
  const fileName=safeFileName(job.fileName),extension=path.extname(fileName).toLowerCase();
  fs.mkdirSync(path.join(root,'tmp'),{recursive:true});fs.mkdirSync(path.join(root,'objects'),{recursive:true});
  const temporaryDirectory=path.join(root,'tmp',job.id),temporaryFile=path.join(temporaryDirectory,'download'+extension);fs.mkdirSync(temporaryDirectory,{recursive:true});
  const output='./'+path.relative(root,temporaryFile).split(path.sep).join('/');
  try{
   await runImpl(options.cliPath,['im','+messages-resources-download','--message-id',job.messageId,'--file-key',job.fileKey,'--type','file','--output',output,'--as','user','--profile',options.profile,'--format','json'],{cwd:root,signal,windowsHide:true,timeout:120000,maxBuffer:1024*1024,env:{...process.env,LARKSUITE_CLI_NO_UPDATE_NOTIFIER:'1',LARKSUITE_CLI_NO_SKILLS_NOTIFIER:'1'}});
   const inspected=inspectLocalFile({filePath:temporaryFile,fileName,maxBytes:options.maxBytes,allowedExtensions:options.allowedExtensions,root});
   const sourcePath=path.join(root,'objects',inspected.sha256+inspected.extension);
   if(fs.existsSync(sourcePath)){
    const existing=inspectLocalFile({filePath:sourcePath,fileName:path.basename(sourcePath),maxBytes:options.maxBytes,allowedExtensions:options.allowedExtensions,root});
    if(existing.sha256!==inspected.sha256)throw Error('group_file_object_conflict');
   }else fs.renameSync(temporaryFile,sourcePath);
   return {...inspected,sourcePath};
  }finally{fs.rmSync(temporaryDirectory,{recursive:true,force:true});}
 }
 return {download};
}

function createGroupFileSource({store,config,clock=Date.now,assertOwnership=()=>{},signal,fetchPage,downloader,storage,preread,waitingCandidates=()=>[],onReceipt}){
 const options=config.groupFileSource??{enabled:false};let running=false,advancing=false,fileDownloader=downloader,fileStorage=storage;
 const fetchMessages=fetchPage??(async window=>{
  const {stdout}=await run(options.cliPath,historyArguments({...window,profile:options.profile}),{windowsHide:true,timeout:30000,maxBuffer:8*1024*1024,signal,env:{...process.env,LARKSUITE_CLI_NO_UPDATE_NOTIFIER:'1',LARKSUITE_CLI_NO_SKILLS_NOTIFIER:'1'}});
  return JSON.parse(stdout);
 });
 function accept(message,flags){
  const normalized=normalizeFileMessage(message,config,flags);if(!normalized)return null;assertOwnership();
  return store.receiveGroupFile({...normalized,id:key('group-file',normalized.chatId,normalized.messageId),companyId:config.companyId},clock());
 }
 async function poll(){
  if(!options.enabled||running||signal?.aborted)return;running=true;
  try{
   assertOwnership();let state=store.get('group-file-source:'+config.chatId)??{};const now=clock();if(state.nextAt>now)return;
   const window=state.window??{start:state.cursor?Math.max(0,state.cursor-120000):Date.parse(options.startAt),end:now};state={...state,window};store.set('group-file-source:'+config.chatId,state);
   try{
    const result=await fetchMessages({...window,chatId:config.chatId});assertOwnership();
    if(!result?.ok||!Array.isArray(result.data?.messages))throw Error('group_file_history_unavailable');
    const data=result.data;if(data.has_more&&(!data.page_token||data.page_token===window.token))throw Error('group_file_pagination_invalid');
    for(const message of data.messages)accept(message);
    const next=data.has_more?{...state,window:{...window,token:data.page_token}}:{cursor:window.end};store.set('group-file-source:'+config.chatId,{...next,nextAt:now+(data.has_more?5000:60000),lastSuccessAt:now,error:null});
   }catch{assertOwnership();store.set('group-file-source:'+config.chatId,{...state,nextAt:now+60000,error:'group_file_history_unavailable'});}
  }finally{running=false;}
 }
 async function tick({signal:tickSignal}={}){
  if(!options.enabled||advancing||signal?.aborted||tickSignal?.aborted)return;advancing=true;
  const own=()=>{assertOwnership();if(signal?.aborted||tickSignal?.aborted)throw Error('group_file_source_stopped');};
  const update=(job,patch)=>store.updateGroupFileJob(job.id,job.stage,patch,clock());
  try{
   own();const job=store.listGroupFileJobs(clock())[0];if(!job)return;
   if(['uploading','attaching'].includes(job.stage)){update(job,{stage:'manual_review',errorCode:job.stage==='uploading'?'group_file_upload_unknown':'group_file_attach_unknown'});return;}
   if(job.stage==='submitting'){update(job,{stage:'uploaded',errorCode:'group_file_submit_unknown',nextAt:clock()+60000});return;}
   if(job.stage==='discovered'||job.stage==='downloading'){
    const active=job.stage==='discovered'?update(job,{stage:'downloading',errorCode:null}):job;let result;
    try{fileDownloader??=createFileDownloader(options);result=await fileDownloader.download(active,{signal:tickSignal??signal});own();}
    catch(error){own();const code=String(error?.message??'');const terminal=['group_file_name_invalid','group_file_type_unsupported','group_file_too_large','group_file_content_invalid','group_file_path_invalid','group_file_download_invalid'].includes(code);update(active,{stage:terminal?'failed':'discovered',errorCode:terminal?code:'group_file_download_failed',nextAt:terminal?0:clock()+60000,attempts:active.attempts+1});return;}
    const canonical=store.findGroupFileByHash(config.companyId,result.sha256);
    if(canonical&&canonical.id!==active.id){const stage=canonical.stage==='completed'?'completed':canonical.stage==='failed'?'failed':canonical.stage==='manual_review'?'manual_review':'watching';update(active,{stage,canonicalJobId:canonical.id,taskId:canonical.taskId,sourcePath:result.sourcePath,fileSize:result.size,errorCode:canonical.errorCode});return;}
    update(active,{stage:'downloaded',sha256:result.sha256,sourcePath:result.sourcePath,fileSize:result.size,errorCode:null});return;
   }
   if(job.stage==='downloaded'){
    const match=matchWaitingTask({job,candidates:waitingCandidates()});
    if(match.status==='ambiguous'){update(job,{stage:'waiting_selection',candidates:match.candidates.map(candidate=>({taskId:candidate.taskId,manualActionId:candidate.manualActionId,title:candidate.title})),errorCode:'group_file_selection_required'});return;}
    if(match.status==='unique'){update(job,{stage:'ready_upload',taskId:match.candidate.taskId,manualActionId:match.candidate.manualActionId,matchMode:match.mode,candidates:null,errorCode:null});return;}
    update(job,{stage:'ready_upload',matchMode:'new',candidates:null,errorCode:null});return;
   }
   if(job.stage==='waiting_selection')return;
   if(job.stage==='ready_upload'){
    const active=update(job,{stage:'uploading',errorCode:null});let uploaded;
    try{fileStorage??=createAppStorage(options);uploaded=await fileStorage.upload({sourcePath:active.sourcePath,signal:tickSignal??signal});own();}
    catch{own();update(active,{stage:'manual_review',errorCode:'group_file_upload_unknown'});return;}
    if(typeof uploaded?.remotePath!=='string'||!uploaded.remotePath.startsWith('/')||/[\r\n?#]/.test(uploaded.remotePath)){update(active,{stage:'manual_review',errorCode:'group_file_upload_unknown'});return;}
    update(active,{stage:'uploaded',remotePath:uploaded.remotePath,errorCode:null});return;
   }
   if(job.stage==='uploaded'){
    let signed;
    try{fileStorage??=createAppStorage(options);signed=await fileStorage.sign({remotePath:job.remotePath,signal:tickSignal??signal});own();}
    catch{own();update(job,{stage:'uploaded',errorCode:'group_file_sign_failed',nextAt:clock()+60000,attempts:job.attempts+1});return;}
    let signedUrl;try{const url=new URL(signed.url);if(url.protocol!=='https:'||url.username||url.password)throw Error();signedUrl=url.href;}catch{update(job,{stage:'manual_review',errorCode:'group_file_sign_invalid'});return;}
    if(job.taskId&&job.manualActionId){
     const active=update(job,{stage:'attaching',errorCode:null});let response;
     try{response=await preread.attachManualDocument(job.taskId,{chatId:job.chatId,manualActionId:job.manualActionId,actorId:job.senderId,candidate:{url:signedUrl,fileName:job.fileName,officialCategory:'tender_document'}});own();}
     catch{own();update(active,{stage:'manual_review',errorCode:'group_file_attach_unknown'});return;}
     if(!['acquired','duplicate'].includes(response?.acquisition?.status)){update(active,{stage:'manual_review',receipt:response,errorCode:'group_file_attach_unknown'});return;}
     store.watch(job.taskId,{companyId:config.companyId,sourceGroupFileId:job.id});update(active,{stage:'watching',receipt:response,errorCode:null,nextAt:clock()+60000});return;
    }
    const active=update(job,{stage:'submitting',errorCode:null});let response;
    try{response=await preread.receiveGroupFile({eventId:'openbidkit-group-file-'+job.id,chatId:job.chatId,messageId:job.messageId,createTime:job.createTime,senderId:job.senderId,candidate:{url:signedUrl,fileName:job.fileName}});own();}
    catch{own();update(active,{stage:'uploaded',errorCode:'group_file_submit_unknown',nextAt:clock()+60000,attempts:job.attempts+1});return;}
    let inspected;try{inspected=recordReceipt({store,inboxId:'group-file:'+job.id,sourceInboxId:'group-file:'+job.id,response,companyId:config.companyId,now:clock(),onReceipt});}
    catch{update(active,{stage:'manual_review',receipt:response,errorCode:'group_file_receipt_invalid'});return;}
    if(inspected.pending){update(active,{stage:'uploaded',receipt:response,errorCode:null,nextAt:clock()+60000});return;}
    const taskId=inspected.taskIds[0];if(!taskId){update(active,{stage:'failed',receipt:response,errorCode:'group_file_no_task'});return;}
    const watch=store.getWatch(taskId);store.watch(taskId,{...(watch?.payload??{}),companyId:config.companyId,sourceGroupFileId:job.id});update(active,{stage:'watching',taskId,receipt:response,errorCode:null,nextAt:clock()+60000});return;
   }
   if(job.stage==='watching'){
    if(job.canonicalJobId){const canonical=store.getGroupFileJob(job.canonicalJobId);if(!canonical){update(job,{stage:'manual_review',errorCode:'group_file_canonical_missing'});return;}if(['completed','failed','manual_review'].includes(canonical.stage)){update(job,{stage:canonical.stage,taskId:canonical.taskId,errorCode:canonical.errorCode});return;}update(job,{stage:'watching',taskId:canonical.taskId,nextAt:clock()+60000});return;}
    if(job.taskId&&store.current(job.taskId,config.companyId)){update(job,{stage:'completed',errorCode:null});return;}
    update(job,{stage:'watching',nextAt:clock()+60000});return;
   }
   update(job,{stage:'manual_review',errorCode:'group_file_stage_invalid'});
  }finally{advancing=false;}
 }
 function status(){const state=store.get('group-file-source:'+config.chatId)??{};return {enabled:Boolean(options.enabled),lastSuccessAt:state.lastSuccessAt??null,error:state.error??null};}
 return {accept,poll,status,tick};
}

module.exports={createFileDownloader,createGroupFileSource,historyArguments,inspectLocalFile,matchWaitingTask,normalizeFileMessage,parseFileDescriptor,safeFileName};
