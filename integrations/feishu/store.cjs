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
  const project=row=>row?{id:row.id,taskId:row.task,companyId:row.company,version:row.version,checksum:row.checksum,generatedAt:row.generated,current:Boolean(row.current),input:JSON.parse(row.payload),assessment:JSON.parse(row.assessment),humanDecision:row.human_decision,owner:row.owner,messageId:row.message_id,revision:row.revision,created:row.created,updated:row.updated}:null;
  const getProject=id=>project(db.prepare('SELECT * FROM projects WHERE id=?').get(id));
  const enqueue=p=>db.prepare('INSERT OR IGNORE INTO outbox(id,project_id,revision) VALUES(?,?,?)').run(key('card',p.id,p.revision),p.id,p.revision);
  return {db,key,close:()=>db.close(),getProject,
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
    listWatches(now){return db.prepare('SELECT * FROM watches WHERE next_at<=? ORDER BY next_at LIMIT 20').all(now).map(r=>({...r,payload:JSON.parse(r.payload)}));},
    countPendingWatches(companyId){return db.prepare('SELECT COUNT(*) AS count FROM watches w WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.task=w.task_id AND p.company=? AND p.current=1)').get(companyId??'').count;},
    deferWatch(taskId,now,error){db.prepare('UPDATE watches SET next_at=?,attempts=attempts+1,last_error=? WHERE task_id=?').run(now+60000,error??null,taskId);},
    set(key,value){db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));},
    get(key){const r=db.prepare('SELECT value FROM settings WHERE key=?').get(key);return r?JSON.parse(r.value):null;},
    receiveRadar(id,payload){const raw=JSON.stringify(payload);const r=db.prepare('SELECT payload FROM inbox WHERE id=?').get(id);if(r&&r.payload!==raw)throw Error('radar_conflict');db.prepare('INSERT OR IGNORE INTO inbox(id,payload) VALUES(?,?)').run(id,raw);},
    listInbox(now){return db.prepare('SELECT * FROM inbox WHERE delivered=0 AND next_at<=? LIMIT 20').all(now).map(r=>({...r,payload:JSON.parse(r.payload)}));},
    finishInbox(id){db.prepare('UPDATE inbox SET delivered=1 WHERE id=?').run(id);},
    retryInbox(id,now){db.prepare('UPDATE inbox SET next_at=? WHERE id=?').run(now+60000,id);},
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
