const fs=require('node:fs');const path=require('node:path');const {createHash}=require('node:crypto');
const {confirmationText}=require('./preview.cjs');
const {canGenerateDraft}=require('./writing-policy.cjs');
function inside(root,file){const relative=path.relative(fs.realpathSync(root),fs.realpathSync(file));return relative&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);}
function enqueueArtifacts(store,projectId,result,root){
 const epoch=store.listWriting().find(j=>j.project_id===projectId)?.payload.deliveryEpoch;
 if(result.status==='waiting_confirmation'&&result.confirmation?.challenge){
  const c=result.confirmation;const dir=path.join(root,'previews');fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,store.key(projectId,c.challenge)+'.txt');
  const text=confirmationText(c);
  fs.writeFileSync(file,text,{encoding:'utf8'});const sha=createHash('sha256').update(text).digest('hex');
  const id=store.enqueueFile(projectId,file,sha,epoch);store.set('previewFile:'+c.challenge,id);
 }
 for(const a of result.artifacts??[])if(a.path&&a.sha256)store.enqueueFile(projectId,a.path,a.sha256,epoch);
}
async function deliverFiles({store,client,root,mode,chatId,allowedChats=[],clock=Date.now,assertOwnership=()=>{},revalidate=id=>store.getProject(id)}){
 if(!['test','production'].includes(mode)||!allowedChats.includes(chatId))return;
 for(const row of store.listFiles(clock())){
  assertOwnership();let p=revalidate(row.project_id);
  const valid=()=>{
   const job=store.listWriting().find(j=>j.project_id===row.project_id),epoch=job?.payload.deliveryEpoch;
   return store.getFile(row.id)?.delivered===0&&(!epoch||row.id===store.key('file',row.project_id,row.path,row.sha256,epoch))
    &&canGenerateDraft(p,clock());
  };
  if(!valid()){store.finishFile(row.id,null,-1);continue;}
  if(row.first_attempt!==null&&clock()-row.first_attempt>45*60000){store.finishFile(row.id,null,-1);continue;}
  try{
   if(!inside(root,row.path)||fs.statSync(row.path).size>30*1024*1024||createHash('sha256').update(fs.readFileSync(row.path)).digest('hex')!==row.sha256){store.finishFile(row.id,null,-1);continue;}
   let fileKey=row.file_key;if(!fileKey){assertOwnership();fileKey=await client.uploadFile(row.path);assertOwnership();store.uploadFileKey(row.id,fileKey);}
   p=revalidate(row.project_id);if(!valid()){store.finishFile(row.id,null,-1);continue;}
   assertOwnership();store.attemptFile(row.id,clock());const messageId=await client.sendFile(chatId,fileKey,row.id);assertOwnership();
   p=revalidate(row.project_id);const stillCurrent=valid();
   store.transaction(()=>{
    store.finishFile(row.id,messageId,stillCurrent?1:-1);
    const c=store.listWriting().find(j=>j.project_id===p.id)?.result?.confirmation;
    if(stillCurrent&&c?.challenge&&store.get('previewFile:'+c.challenge)===row.id){store.set('previewDelivered:'+c.challenge,messageId);store.touchCard(p.id,clock());}
   });
  }catch{assertOwnership();store.retryFile(row.id,clock());}
 }
}
module.exports={inside,enqueueArtifacts,deliverFiles};
