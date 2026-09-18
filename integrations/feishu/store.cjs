const {DatabaseSync}=require('node:sqlite');
const {mkdirSync}=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const key=(...values)=>createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0,40);
function createStore(file) {
  if(file!==':memory:') mkdirSync(path.dirname(path.resolve(file)),{recursive:true});
  const db=new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,task TEXT NOT NULL,company TEXT NOT NULL,version TEXT NOT NULL,checksum TEXT NOT NULL,generated TEXT NOT NULL,current INTEGER NOT NULL,payload TEXT NOT NULL,assessment TEXT NOT NULL,human_decision TEXT,owner TEXT,message_id TEXT,revision INTEGER NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,UNIQUE(task,company,version));
    CREATE UNIQUE INDEX IF NOT EXISTS one_current ON projects(task,company) WHERE current=1;
    CREATE TABLE IF NOT EXISTS actions(event_id TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,result TEXT NOT NULL,created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,project_id TEXT,revision INTEGER NOT NULL,payload TEXT,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,first_attempt INTEGER,delivered INTEGER NOT NULL DEFAULT 0,last_error TEXT);
    CREATE TABLE IF NOT EXISTS writing_jobs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL UNIQUE,stage TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL,result TEXT,updated INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS watches(task_id TEXT PRIMARY KEY,payload TEXT NOT NULL,next_at INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,last_error TEXT);
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS inbox(id TEXT PRIMARY KEY,payload TEXT NOT NULL,delivered INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS file_outbox(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,path TEXT NOT NULL,sha256 TEXT NOT NULL,file_key TEXT,message_id TEXT,first_attempt INTEGER,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,delivered INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS leases(name TEXT PRIMARY KEY,owner TEXT NOT NULL,expires INTEGER NOT NULL);`);
  db.exec(`CREATE TABLE IF NOT EXISTS card_streams(id TEXT PRIMARY KEY,task TEXT NOT NULL,company TEXT NOT NULL,chat TEXT NOT NULL,create_id TEXT NOT NULL,message_id TEXT,first_attempt INTEGER);`);
  db.exec(`CREATE TABLE IF NOT EXISTS group_file_jobs(
    id TEXT PRIMARY KEY,company_id TEXT NOT NULL,chat_id TEXT NOT NULL,source_message_id TEXT NOT NULL,sender_id TEXT NOT NULL,create_time TEXT NOT NULL,
    file_name TEXT NOT NULL,file_key TEXT NOT NULL,reply_to TEXT,stage TEXT NOT NULL,file_size INTEGER,sha256 TEXT,source_path TEXT,remote_path TEXT,
    task_id TEXT,manual_action_id TEXT,match_mode TEXT,canonical_job_id TEXT,candidates TEXT,receipt TEXT,error_code TEXT,next_at INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,status_message_id TEXT,status_create_id TEXT NOT NULL,status_revision INTEGER NOT NULL DEFAULT 1,
    generation INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
    UNIQUE(chat_id,source_message_id),UNIQUE(company_id,sha256,generation));
    CREATE TABLE IF NOT EXISTS group_file_status_outbox(
    id TEXT PRIMARY KEY,job_id TEXT NOT NULL,revision INTEGER NOT NULL,card TEXT NOT NULL,first_attempt INTEGER,attempts INTEGER NOT NULL DEFAULT 0,
    next_at INTEGER NOT NULL DEFAULT 0,delivered INTEGER NOT NULL DEFAULT 0,last_error TEXT,UNIQUE(job_id,revision));`);
  const project=row=>row?{id:row.id,taskId:row.task,companyId:row.company,version:row.version,checksum:row.checksum,generatedAt:row.generated,current:Boolean(row.current),input:JSON.parse(row.payload),assessment:JSON.parse(row.assessment),humanDecision:row.human_decision,owner:row.owner,messageId:row.message_id,revision:row.revision,created:row.created,updated:row.updated}:null;
  const groupFile=row=>row?{id:row.id,companyId:row.company_id,chatId:row.chat_id,messageId:row.source_message_id,senderId:row.sender_id,createTime:row.create_time,fileName:row.file_name,fileKey:row.file_key,replyTo:row.reply_to,stage:row.stage,fileSize:row.file_size,sha256:row.sha256,sourcePath:row.source_path,remotePath:row.remote_path,taskId:row.task_id,manualActionId:row.manual_action_id,matchMode:row.match_mode,canonicalJobId:row.canonical_job_id,candidates:row.candidates?JSON.parse(row.candidates):null,receipt:row.receipt?JSON.parse(row.receipt):null,errorCode:row.error_code,nextAt:row.next_at,attempts:row.attempts,statusMessageId:row.status_message_id,statusCreateId:row.status_create_id,statusRevision:row.status_revision,generation:row.generation,createdAt:row.created_at,updatedAt:row.updated_at}:null;
  const getGroupFileJob=id=>groupFile(db.prepare('SELECT * FROM group_file_jobs WHERE id=?').get(id));
  const getProject=id=>project(db.prepare('SELECT * FROM projects WHERE id=?').get(id));
  const enqueue=p=>db.prepare('INSERT OR IGNORE INTO outbox(id,project_id,revision) VALUES(?,?,?)').run(key('card',p.id,p.revision),p.id,p.revision);
  return {db,key,close:()=>db.close(),getProject,getGroupFileJob,
    transaction(fn){db.exec('BEGIN IMMEDIATE');try{const out=fn();db.exec('COMMIT');return out;}catch(e){db.exec('ROLLBACK');throw e;}},
    current:(task,company)=>project(db.prepare('SELECT * FROM projects WHERE task=? AND company=? AND current=1').get(task,company)),
    listProjects:()=>db.prepare('SELECT * FROM projects WHERE current=1 ORDER BY updated DESC').all().map(project),
    saveProject(p){db.prepare(`INSERT INTO projects VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(p.id,p.taskId,p.companyId,p.version,p.checksum,p.generatedAt,1,JSON.stringify(p.input),JSON.stringify(p.assessment),null,null,p.messageId??null,1,p.created,p.created);enqueue(p);},
    supersede(id){db.prepare('UPDATE projects SET current=0 WHERE id=?').run(id);db.prepare('UPDATE outbox SET delivered=1 WHERE project_id=? AND delivered=0').run(id);db.prepare("UPDATE writing_jobs SET status='cancelled' WHERE project_id=? AND status IN ('queued','waiting_confirmation')").run(id);},
    decide(id,decision,owner,now){db.prepare('UPDATE projects SET human_decision=?,owner=?,revision=revision+1,updated=? WHERE id=?').run(decision,owner,now,id);const p=getProject(id);enqueue(p);return p;},
    reassess(id,assessment,now,input){db.prepare('UPDATE projects SET assessment=?,payload=COALESCE(?,payload),human_decision=NULL,revision=revision+1,updated=? WHERE id=?').run(JSON.stringify(assessment),input?JSON.stringify(input):null,now,id);db.prepare("UPDATE writing_jobs SET status='cancelled' WHERE project_id=? AND status!='cancelled'").run(id);db.prepare('UPDATE file_outbox SET delivered=-1 WHERE project_id=? AND delivered=0').run(id);const p=getProject(id);enqueue(p);return p;},
    bindMessage(id,messageId){db.prepare('UPDATE projects SET message_id=? WHERE id=?').run(messageId,id);},
    messageStream(p,chat){
      const id=key('card-stream',p.taskId,p.companyId,chat);
      // Preserve the UUID of a legacy attempted create when migrating an existing database.
      const old=db.prepare('SELECT o.id,o.first_attempt FROM outbox o JOIN projects p ON p.id=o.project_id WHERE p.task=? AND p.company=? AND o.first_attempt IS NOT NULL ORDER BY o.first_attempt LIMIT 1').get(p.taskId,p.companyId);
      db.prepare('INSERT OR IGNORE INTO card_streams VALUES(?,?,?,?,?,?,?)').run(id,p.taskId,p.companyId,chat,old?.id??key('card-create',p.taskId,p.companyId,chat),p.messageId??null,old?.first_attempt??null);
      return db.prepare('SELECT * FROM card_streams WHERE id=?').get(id);
    },
    attemptStream(id,now){db.prepare('UPDATE card_streams SET first_attempt=COALESCE(first_attempt,?) WHERE id=?').run(now,id);},
    bindStream(id,messageId){
      const stream=db.prepare('SELECT * FROM card_streams WHERE id=?').get(id);
      db.prepare('UPDATE card_streams SET message_id=? WHERE id=?').run(messageId,id);
      db.prepare('UPDATE projects SET message_id=? WHERE task=? AND company=?').run(messageId,stream.task,stream.company);
    },
    getAction(id){const row=db.prepare('SELECT * FROM actions WHERE event_id=?').get(id);return row?{hash:row.payload_hash,result:JSON.parse(row.result)}:null;},
    saveAction(id,hash,result,now){db.prepare('INSERT INTO actions VALUES(?,?,?,?)').run(id,hash,JSON.stringify(result),now);},
    enqueueWriting(p,now){const id=key('write',p.id);db.prepare("INSERT INTO writing_jobs VALUES(?,?,'prepare','queued',?,NULL,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,stage='prepare',status='queued',result=NULL,updated=excluded.updated WHERE writing_jobs.status='cancelled'").run(id,p.id,JSON.stringify({...p.input,id,projectId:p.id,confirmed:true,deliveryEpoch:key('generation',id,p.revision)}),now);return id;},
    resumeWriting(job,payload,now,stage){db.prepare("UPDATE writing_jobs SET payload=?,status='queued',stage=?,updated=? WHERE id=?").run(JSON.stringify(payload),stage??job.stage,now,job.id);},
    listWriting:()=>db.prepare('SELECT * FROM writing_jobs ORDER BY updated').all().map(r=>({...r,payload:JSON.parse(r.payload),result:r.result?JSON.parse(r.result):null})),
    updateWriting(id,status,result,now,stage){db.prepare('UPDATE writing_jobs SET status=?,result=?,updated=?,stage=COALESCE(?,stage) WHERE id=?').run(status,JSON.stringify(result),now,stage??null,id);},
    touchCard(id,now){db.prepare('UPDATE projects SET revision=revision+1,updated=? WHERE id=?').run(now,id);enqueue(getProject(id));},
    enqueueSummary(day,card){db.prepare('INSERT OR IGNORE INTO outbox(id,revision,payload) VALUES(?,0,?)').run(key('summary',day),JSON.stringify(card));},
    listOutbox(now){return db.prepare('SELECT * FROM outbox WHERE delivered=0 AND next_at<=? ORDER BY rowid LIMIT 30').all(now);},
    attempted(id,now){db.prepare('UPDATE outbox SET first_attempt=COALESCE(first_attempt,?) WHERE id=?').run(now,id);},
    sent(id){db.prepare('UPDATE outbox SET delivered=1 WHERE id=?').run(id);},
    retry(row,now,error='delivery_failed'){const delay=Math.min(3600000,5000*2**Math.min(row.attempts,10));db.prepare('UPDATE outbox SET attempts=attempts+1,next_at=?,last_error=? WHERE id=?').run(now+delay,error,row.id);},
    manualDelivery(id){db.prepare("UPDATE outbox SET delivered=-1,last_error='delivery_uncertain' WHERE id=?").run(id);},
    watch(taskId,input){db.prepare('INSERT INTO watches(task_id,payload) VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET payload=excluded.payload,next_at=0').run(taskId,JSON.stringify(input));},
    getWatch(taskId){const r=db.prepare('SELECT * FROM watches WHERE task_id=?').get(taskId);return r?{...r,payload:JSON.parse(r.payload)}:null;},
    listWatches(now){return db.prepare('SELECT * FROM watches WHERE next_at<=? ORDER BY next_at LIMIT 20').all(now).map(r=>({...r,payload:JSON.parse(r.payload)}));},
    listWatchesBySource(sourceInboxId){return db.prepare('SELECT * FROM watches ORDER BY task_id').all().map(r=>({...r,payload:JSON.parse(r.payload)})).filter(r=>r.payload.sourceInboxId===sourceInboxId);},
    countPendingWatches(companyId){return db.prepare('SELECT COUNT(*) AS count FROM watches w WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.task=w.task_id AND p.company=? AND p.current=1)').get(companyId??'').count;},
    unwatch(taskId){db.prepare('DELETE FROM watches WHERE task_id=?').run(taskId);},
    deferWatch(taskId,now,error){
      if(!error){db.prepare('UPDATE watches SET next_at=?,attempts=0,last_error=NULL WHERE task_id=?').run(now+60000,taskId);return;}
      const attempts=Math.min(db.prepare('SELECT attempts FROM watches WHERE task_id=?').get(taskId)?.attempts??0,15);
      const delay=Math.min(15*60000,60000*2**Math.min(attempts,4));
      db.prepare('UPDATE watches SET next_at=?,attempts=?,last_error=? WHERE task_id=?').run(now+delay,attempts+1,error,taskId);
    },
    set(key,value){db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));},
    get(key){const r=db.prepare('SELECT value FROM settings WHERE key=?').get(key);return r?JSON.parse(r.value):null;},
    receiveRadar(id,payload){const raw=JSON.stringify(payload);const r=db.prepare('SELECT payload FROM inbox WHERE id=?').get(id);if(r){const saved=JSON.parse(r.payload);if(['chatId','messageId','messageType'].some(k=>saved[k]!==payload[k]))throw Error('radar_conflict');return;}db.prepare('INSERT INTO inbox(id,payload) VALUES(?,?)').run(id,raw);},
    listInbox(now){return db.prepare('SELECT * FROM inbox WHERE delivered=0 AND next_at<=? LIMIT 20').all(now).map(r=>({...r,payload:JSON.parse(r.payload)}));},
    finishInbox(id){db.prepare('UPDATE inbox SET delivered=1 WHERE id=?').run(id);},
    retryInbox(id,now){db.prepare('UPDATE inbox SET next_at=? WHERE id=?').run(now+60000,id);},
    receiveGroupFile(input,now){
      const existing=db.prepare('SELECT * FROM group_file_jobs WHERE chat_id=? AND source_message_id=?').get(input.chatId,input.messageId);
      if(existing){const saved=groupFile(existing);if(['id','companyId','senderId','createTime','fileName','fileKey','replyTo'].some(name=>(saved[name]??null)!==(input[name]??null)))throw Error('group_file_conflict');return saved;}
      db.prepare(`INSERT INTO group_file_jobs(id,company_id,chat_id,source_message_id,sender_id,create_time,file_name,file_key,reply_to,stage,status_create_id,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,'discovered',?,?,?)`).run(input.id,input.companyId,input.chatId,input.messageId,input.senderId,input.createTime,input.fileName,input.fileKey,input.replyTo??null,key('group-file-status-create',input.id),now,now);
      return getGroupFileJob(input.id);
    },
    listGroupFileJobs(now){return db.prepare("SELECT * FROM group_file_jobs WHERE stage NOT IN ('completed','failed','manual_review') AND next_at<=? ORDER BY created_at LIMIT 20").all(now).map(groupFile);},
    findGroupFileByHash(companyId,sha256){return groupFile(db.prepare('SELECT * FROM group_file_jobs WHERE company_id=? AND sha256=? ORDER BY generation,created_at LIMIT 1').get(companyId,sha256));},
    updateGroupFileJob(id,expectedStage,patch,now){
      const columns={stage:'stage',fileSize:'file_size',sha256:'sha256',sourcePath:'source_path',remotePath:'remote_path',taskId:'task_id',manualActionId:'manual_action_id',matchMode:'match_mode',canonicalJobId:'canonical_job_id',candidates:'candidates',receipt:'receipt',errorCode:'error_code',nextAt:'next_at',attempts:'attempts',statusMessageId:'status_message_id',statusRevision:'status_revision',generation:'generation'};
      const entries=Object.entries(patch).filter(([name,value])=>columns[name]&&value!==undefined);if(!entries.length)throw Error('group_file_patch_empty');
      const values=entries.map(([name,value])=>['candidates','receipt'].includes(name)&&value!==null?JSON.stringify(value):value);
      const result=db.prepare(`UPDATE group_file_jobs SET ${entries.map(([name])=>columns[name]+'=?').join(',')},updated_at=? WHERE id=? AND stage=?`).run(...values,now,id,expectedStage);
      if(result.changes!==1)throw Error('group_file_stage_conflict');return getGroupFileJob(id);
    },
    enqueueGroupFileStatus(id,card,now){
      const job=getGroupFileJob(id);if(!job)throw Error('group_file_missing');const serialized=JSON.stringify(card);
      const latest=db.prepare('SELECT * FROM group_file_status_outbox WHERE job_id=? ORDER BY revision DESC LIMIT 1').get(id);
      if(latest?.card===serialized)return {...latest,card:JSON.parse(latest.card)};
      const revision=latest?job.statusRevision+1:job.statusRevision,rowId=key('group-file-status',id,revision);
      db.prepare('UPDATE group_file_jobs SET status_revision=?,updated_at=? WHERE id=?').run(revision,now,id);
      db.prepare('INSERT INTO group_file_status_outbox(id,job_id,revision,card) VALUES(?,?,?,?)').run(rowId,id,revision,serialized);
      return {...db.prepare('SELECT * FROM group_file_status_outbox WHERE id=?').get(rowId),card};
    },
    listGroupFileStatus(now){return db.prepare('SELECT * FROM group_file_status_outbox WHERE delivered=0 AND next_at<=? ORDER BY rowid LIMIT 20').all(now).map(row=>({...row,card:JSON.parse(row.card)}));},
    attemptGroupFileStatus(id,now){db.prepare('UPDATE group_file_status_outbox SET first_attempt=COALESCE(first_attempt,?) WHERE id=?').run(now,id);},
    bindGroupFileStatus(jobId,messageId){db.prepare('UPDATE group_file_jobs SET status_message_id=? WHERE id=?').run(messageId,jobId);},
    finishGroupFileStatus(id){db.prepare('UPDATE group_file_status_outbox SET delivered=1 WHERE id=?').run(id);},
    retryGroupFileStatus(id,now,error='group_file_status_delivery_failed'){db.prepare('UPDATE group_file_status_outbox SET attempts=attempts+1,next_at=?,last_error=? WHERE id=?').run(now+60000,error,id);},
    manualGroupFileStatus(id){db.prepare("UPDATE group_file_status_outbox SET delivered=-1,last_error='group_file_status_delivery_unknown' WHERE id=?").run(id);},
    enqueueFile(projectId,file,sha256,epoch){const id=epoch?key('file',projectId,file,sha256,epoch):key('file',projectId,file,sha256);db.prepare('INSERT OR IGNORE INTO file_outbox(id,project_id,path,sha256) VALUES(?,?,?,?)').run(id,projectId,file,sha256);return id;},
    listFiles(now){return db.prepare('SELECT * FROM file_outbox WHERE delivered=0 AND next_at<=? ORDER BY rowid LIMIT 20').all(now);},
    getFile(id){return db.prepare('SELECT * FROM file_outbox WHERE id=?').get(id);},
    uploadFileKey(id,fileKey){db.prepare('UPDATE file_outbox SET file_key=? WHERE id=?').run(fileKey,id);},
    attemptFile(id,now){db.prepare('UPDATE file_outbox SET first_attempt=COALESCE(first_attempt,?) WHERE id=?').run(now,id);},
    finishFile(id,messageId,state=1){db.prepare('UPDATE file_outbox SET message_id=?,delivered=? WHERE id=?').run(messageId??null,state,id);},
    retryFile(id,now){db.prepare('UPDATE file_outbox SET attempts=attempts+1,next_at=? WHERE id=?').run(now+60000,id);},
    lease(name,owner,now,ttl){db.prepare('INSERT INTO leases VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE leases.expires<=? OR leases.owner=?').run(name,owner,now+ttl,now,owner);return db.prepare('SELECT owner FROM leases WHERE name=?').get(name)?.owner===owner;},
    ownsLease(name,owner,now){const row=db.prepare('SELECT owner,expires FROM leases WHERE name=?').get(name);return row?.owner===owner&&row.expires>now;},
    renewLease(name,owner,now,ttl){return db.prepare('UPDATE leases SET expires=? WHERE name=? AND owner=? AND expires>?').run(now+ttl,name,owner,now).changes===1;},
    release(name,owner){db.prepare('DELETE FROM leases WHERE name=? AND owner=?').run(name,owner);}
  };
}
module.exports={createStore,key};
