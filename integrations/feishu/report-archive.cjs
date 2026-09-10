'use strict';
const fs=require('node:fs');const path=require('node:path');const {createHash}=require('node:crypto');
const {execFile}=require('node:child_process');const {promisify}=require('node:util');const {key}=require('./store.cjs');
const run=promisify(execFile),PREFIX='report-archive-job:';
const hash=value=>createHash('sha256').update(value).digest('hex');
const validToken=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,256}$/.test(value);
const checksum=value=>String(value??'').replace(/^sha256:/i,'').toLowerCase();
function documentResult(value){
 if(value?.ready!==true||!validToken(value.token)||typeof value.url!=='string')throw Error('report_import_unknown');
 const u=new URL(value.url);
 if(u.protocol!=='https:'||u.username||u.password||u.port||u.search||u.hash||!/(^|\.)(feishu\.cn|larksuite\.com)$/.test(u.hostname)||u.pathname!=='/docx/'+value.token)throw Error('report_import_unknown');
 return{token:value.token,url:u.href};
}
function createDriveArchiveClient(options,{runImpl=run}={}){
 async function cli(args,{cwd,signal}={}){
  const {stdout}=await runImpl(options.cliPath,['drive',...args,'--as',options.identity,'--profile',options.profile,'--format','json'],{cwd,signal,windowsHide:true,timeout:180000,maxBuffer:1024*1024,env:{...process.env,LARKSUITE_CLI_NO_UPDATE_NOTIFIER:'1',LARKSUITE_CLI_NO_SKILLS_NOTIFIER:'1'}});
  const result=JSON.parse(stdout);if(result?.ok!==true||!result.data)throw Error('report_drive_failed');return result.data;
 }
 return{
  importMarkdown:({sourcePath,folderToken,title,signal})=>cli(['+import','--file','./'+path.basename(sourcePath),'--type','docx','--folder-token',folderToken,'--name',title],{cwd:path.dirname(sourcePath),signal}),
  pollImport:({ticket,signal})=>cli(['+task_result','--scenario','import','--ticket',ticket],{signal}),
  grantGroup:({token,chatId,signal})=>cli(['+member-add','--token',token,'--type','docx','--member-id',chatId,'--member-type','openchat','--perm','view','--yes'],{signal}),
  async hasGroup({token,chatId,signal}){const data=await cli(['+member-list','--token',token,'--type','docx'],{signal});return Array.isArray(data.items)&&data.items.some(m=>m.member_type==='openchat'&&m.member_id===chatId&&['view','edit','full_access'].includes(m.perm));}
 };
}
function createReportArchive({store,config,preread,client,assertOwnership=()=>{},clock=Date.now}){
 const options=config.reportArchive??{enabled:false};let running=false;
 const root=path.resolve(options.root??path.join(config.dataRoot,'reports'));
 const list=()=>store.db.prepare("SELECT value FROM settings WHERE key LIKE 'report-archive-job:%' ORDER BY key").all().map(row=>JSON.parse(row.value));
 const allowed=()=>options.enabled&&config.mode==='test'&&config.chatId&&config.allowedChats?.includes(config.chatId)&&validToken(options.folderToken)&&options.allowedFolderTokens?.includes(options.folderToken);
 if(options.enabled&&(!path.isAbsolute(options.cliPath??'')||!options.profile||!['bot','user'].includes(options.identity)||!allowed()||!preread))throw Error('report_archive_not_configured');
 const target=()=>key(options.profile,options.identity,options.folderToken,config.chatId);
 const save=job=>store.set(PREFIX+job.id,{...job,updatedAt:clock()});
 const active=p=>p?.current&&!p.input.handoff?.superseded&&p.input.sourceMessage?.status!=='edited_requires_review';
 const identity=p=>key(p.id,p.version,p.checksum,p.input.handoff.snapshot.reportId);
 function bind(project,job){
  const p=store.getProject(project.id);if(!active(p)||identity(p)!==identity(project))return;
  const input={...p.input};if(job){input.reportUrl=job.url;input.reportArchive={id:job.id,contentHash:job.contentHash,reportId:job.reportId,documentVersion:job.documentVersion,checksum:job.checksum};}
  else{delete input.reportUrl;delete input.reportArchive;}
  if(JSON.stringify(input)===JSON.stringify(p.input))return;
  store.transaction(()=>{store.db.prepare('UPDATE projects SET payload=? WHERE id=?').run(JSON.stringify(input),p.id);store.touchCard(p.id,clock());});
 }
 async function publicationFor(p){
  const pub=await preread.getPublication(p.taskId),trace=pub?.knowledgeContent?.sourceTrace;
  if(!pub||!['publication_required','unchanged'].includes(pub.status)||typeof pub.projectKey!=='string'||!pub.projectKey||typeof pub.title!=='string'||!pub.title.trim()||!Number.isInteger(pub.documentVersion)||String(pub.documentVersion)!==p.version||typeof pub.markdownContent!=='string'||!pub.markdownContent.trim()||Buffer.byteLength(pub.markdownContent)>20*1024*1024||/[\uFFFD\u0000]/u.test(pub.markdownContent)||/\?{4,}/.test(pub.markdownContent))throw Error('report_publication_invalid');
  if(!/^[a-f0-9]{64}$/.test(pub.contentHash??'')||hash(`${pub.projectKey}\n${pub.documentVersion}\n${pub.markdownContent}`)!==pub.contentHash||checksum(trace?.sha256)!==checksum(p.checksum)||String(trace?.documentVersion)!==p.version)throw Error('report_publication_mismatch');
  // Publication uses latest report: fence it against a fresh handoff before any external write.
  const latest=await preread.getHandoff(p.taskId),snapshot=latest?.snapshot;
  if(latest?.superseded||snapshot?.reportId!==p.input.handoff.snapshot.reportId||String(snapshot?.documentVersion)!==p.version||checksum(snapshot?.checksum)!==checksum(p.checksum))throw Error('report_publication_stale');
  return pub;
 }
 function localMarkdown(job){
  const sourcePath=path.join(root,job.id+'.md'),bytes=Buffer.from(job.markdownContent);
  if(hash(`${job.projectKey}\n${job.documentVersion}\n${job.markdownContent}`)!==job.contentHash)throw Error('report_local_invalid');
  fs.mkdirSync(root,{recursive:true});
  if(fs.existsSync(sourcePath)){const stat=fs.lstatSync(sourcePath);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==bytes.length||!fs.readFileSync(sourcePath).equals(bytes))throw Error('report_local_invalid');}
  else fs.writeFileSync(sourcePath,bytes,{flag:'wx'});
  return sourcePath;
 }
 async function tick({signal}={}){
  if(!allowed()||running||signal?.aborted)return;running=true;
  const own=()=>{assertOwnership();if(signal?.aborted)throw Error('report_archive_stopped');};
  const manual=(job,error)=>{own();save({...job,stage:'manual',error});};
  try{
   own();
   // A process interruption after dispatch may already have created the document.
   for(const j of list().filter(j=>j.stage==='importing'))manual(j,'report_import_unknown');
   // A known ticket remains safe to poll even when its source project has a newer version.
   const pending=list().find(j=>j.target===target()&&j.stage==='polling'&&(j.nextAt??0)<=clock());
   if(pending){
    let result;try{result=await (client??createDriveArchiveClient(options)).pollImport({ticket:pending.ticket,signal});}catch{own();save({...pending,error:'report_poll_failed',nextAt:clock()+60000});return;}
    own();if(result?.ready===false&&!result.failed){save({...pending,nextAt:clock()+60000});return;}
    try{save({...pending,...documentResult(result),stage:'imported',error:null});}catch{manual(pending,'report_import_unknown');}return;
   }
   const candidates=store.listProjects().filter(active);
   const p=candidates.find(p=>(store.get('report-archive-check:'+p.id)?.nextAt??0)<=clock());if(!p)return;
   store.set('report-archive-check:'+p.id,{nextAt:clock()+60000});
   let pub;try{pub=await publicationFor(p);}catch{own();bind(p,null);store.set('report-archive-check:'+p.id,{nextAt:clock()+60000,error:'report_publication_unavailable'});return;}
   own();const current=store.getProject(p.id);if(!active(current)||identity(current)!==identity(p))return;
   const id=key('report-archive',target(),identity(p),pub.contentHash);let job=store.get(PREFIX+id);
   if(p.input.reportArchive?.id!==id)bind(p,null);
   if(!job){job={id,projectId:p.id,taskId:p.taskId,reportId:p.input.handoff.snapshot.reportId,checksum:p.checksum,documentVersion:pub.documentVersion,projectKey:pub.projectKey,contentHash:pub.contentHash,markdownContent:pub.markdownContent,title:pub.title.slice(0,60)+' — 预读报告 v'+pub.documentVersion+' '+pub.contentHash.slice(0,8),target:target(),folderToken:options.folderToken,chatId:config.chatId,stage:'queued',createdAt:clock()};save(job);}
   if(job.target!==target())return;
   const drive=client??createDriveArchiveClient(options);
   if(job.stage==='published'){bind(p,job);return;}
   if(job.stage==='manual')return;
   if(job.stage==='queued'){
    // One import at a time per authorized destination; unresolved creates also block later versions.
    if(list().some(j=>j.id!==id&&j.target===job.target&&(j.stage==='polling'||j.stage==='importing'||(j.stage==='manual'&&j.error==='report_import_unknown'))))return;
    let sourcePath;try{sourcePath=localMarkdown(job);}catch{manual(job,'report_local_invalid');return;}
    own();save({...job,stage:'importing'});let result;
    try{result=await drive.importMarkdown({sourcePath,folderToken:job.folderToken,title:job.title,signal});}catch{manual(job,'report_import_unknown');return;}
    own();
    if(result?.ready===false&&validToken(result.ticket)){save({...job,stage:'polling',ticket:result.ticket});return;}
    try{const document=documentResult(result);save({...job,...document,stage:'imported'});}catch{manual(job,'report_import_unknown');}return;
   }
   if(job.stage==='polling')return;
   if(job.stage==='imported'){
    own();save({...job,stage:'granting'});
    try{await drive.grantGroup({token:job.token,chatId:job.chatId,signal});}catch{/* Recover an uncertain ACL write by reading the same document on the next tick. */}
    own();save({...job,stage:'verifying'});return;
   }
   if(['granting','verifying'].includes(job.stage)){
    let verified;try{verified=await drive.hasGroup({token:job.token,chatId:job.chatId,signal});}catch{own();save({...job,stage:'verifying',error:'report_permission_check_failed'});return;}
    own();if(!verified){manual(job,'report_permission_unverified');return;}
    const published={...job,stage:'published',error:null,publishedAt:clock()};save(published);bind(p,published);return;
   }
  }finally{running=false;}
 }
 // Operator-only local recovery: pass the verified ticket or final docx receipt, never rerun create.
 function reconcileImport(id,result){
  assertOwnership();const job=store.get(PREFIX+id);if(!allowed()||job?.target!==target()||job.stage!=='manual'||job.error!=='report_import_unknown')throw Error('report_reconcile_invalid');
  if(result?.ready===false&&validToken(result.ticket))save({...job,stage:'polling',ticket:result.ticket,error:null});
  else save({...job,...documentResult(result),stage:'imported',error:null});
 }
 function recheckPermission(id){assertOwnership();const job=store.get(PREFIX+id);if(!allowed()||job?.target!==target()||job.stage!=='manual'||job.error!=='report_permission_unverified')throw Error('report_reconcile_invalid');save({...job,stage:'verifying',error:null});}
 return{tick,list,reconcileImport,recheckPermission};
}
module.exports={createReportArchive,createDriveArchiveClient};
