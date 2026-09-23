const http=require('node:http');
const fs=require('node:fs');const path=require('node:path');
const {createHash,createDecipheriv,timingSafeEqual}=require('node:crypto');
const {normalizeCardCallback,toWorkflowAction}=require('./card-source.cjs');
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
function openCallback(raw,headers,{verificationToken,encryptKey}){
  let body=JSON.parse(raw.toString('utf8'));
  const ts=headers['x-lark-request-timestamp'],nonce=headers['x-lark-request-nonce'],sig=headers['x-lark-signature'];
  const hasHeaders=Boolean(ts||nonce||sig);
  const verify=()=>{
    if(!ts||!nonce||!sig||!encryptKey)throw Error('signature_required');
    if(!/^\d+$/.test(ts)||Math.abs(Date.now()/1000-Number(ts))>300)throw Error('signature_expired');
    const expected=createHash('sha256').update(ts+nonce+encryptKey).update(raw).digest('hex');
    if(!equal(sig,expected))throw Error('signature_invalid');
  };
  if(hasHeaders)verify();
  if(body?.encrypt){
    if(!encryptKey)throw Error('signature_required');
    const bytes=Buffer.from(body.encrypt,'base64');if(bytes.length<=16)throw Error('envelope_invalid');
    const decipher=createDecipheriv('aes-256-cbc',createHash('sha256').update(encryptKey).digest(),bytes.subarray(0,16));
    body=JSON.parse(Buffer.concat([decipher.update(bytes.subarray(16)),decipher.final()]).toString('utf8'));
  }
  if(body?.type!=='url_verification'&&!hasHeaders)verify();
  if(!verificationToken||!equal(body?.header?.token??body?.token,verificationToken))throw Error('token_invalid');
  if(body.type==='url_verification'&&(typeof body.challenge!=='string'||!body.challenge))throw Error('challenge_invalid');
  return body;
}
async function readBody(req,limit=1024*1024){
  const parts=[];let size=0;
  for await(const part of req){size+=part.length;if(size>limit){const e=Error('body_too_large');e.status=413;throw e;}parts.push(part);}
  return Buffer.concat(parts);
}
function createHttpServer({config,workflow,store,readiness,radar,onCardAction,assertOwnership=()=>{}}){
  return http.createServer(async(req,res)=>{
    const send=(status,data)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data));};
    try{
      if(req.method==='GET'&&req.url==='/health'){
        try{assertOwnership();}catch{return send(503,{ok:false,error:'service_ownership_lost'});}
        return send(200,{ok:true});
      }
      if(req.method==='GET'&&req.url==='/ready'){const r=readiness();return send(r.ready?200:503,r);}
      if(req.method==='POST'&&req.url==='/lark/events'){
        const body=openCallback(await readBody(req),req.headers,config);
        if(body.type==='url_verification')return send(200,{challenge:body.challenge});
        if(body.header?.event_type!=='card.action.trigger')return send(400,{error:'unsupported_event'});
        const e=body.event??{},action=e.action??{},serialize=value=>typeof value==='string'?value:value===undefined?'':JSON.stringify(value);
        const normalized=normalizeCardCallback({type:'card.action.trigger',event_id:body.header.event_id,operator_id:e.operator?.open_id,chat_id:e.context?.open_chat_id,message_id:e.context?.open_message_id,host:'im_message',action_tag:action.tag??'button',action_name:action.name,action_value:serialize(action.value),form_value:action.form_value===undefined?undefined:serialize(action.form_value)},config);
        if(!normalized)return send(400,{error:'unsupported_action'});
        if(onCardAction)await onCardAction(normalized.value,normalized.event,normalized.route);
        else workflow.act(toWorkflowAction(normalized.value,normalized.event));
        return send(200,{toast:{type:'success',content:'已记录，请稍候查看项目卡片'}});
      }
      if(!config.apiKey||!equal(req.headers.authorization,'Bearer '+config.apiKey))return send(401,{error:'unauthorized'});
      if(req.method==='POST')assertOwnership();
      if(req.method==='POST'&&req.url.startsWith('/sources?')){
        const u=new URL(req.url,'http://localhost');const p=store.getProject(u.searchParams.get('projectId'));
        const ext=path.extname(u.searchParams.get('name')||'').toLowerCase();
        if(!p?.current||!config.writingRoot||!['.pdf','.docx','.doc','.txt','.md'].includes(ext))return send(400,{error:'source_invalid'});
        const bytes=await readBody(req,30*1024*1024);const digest=createHash('sha256').update(bytes).digest('hex');
        if(digest!==p.checksum.replace(/^sha256:/,''))return send(409,{error:'source_checksum_mismatch'});
        const dir=path.join(config.writingRoot,'sources');fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,digest+ext);fs.writeFileSync(file,bytes,{flag:'w'});
        const input={...p.input,sourcePath:file};workflow.ingest(input);store.watch(p.taskId,input);
        return send(200,{status:'source_attached',projectId:p.id});
      }
      if(req.method==='GET'&&req.url==='/projects')return send(200,{projects:store.listProjects().map(p=>({id:p.id,taskId:p.taskId,version:p.version,decision:p.assessment.decision,humanDecision:p.humanDecision}))});
      if(req.method!=='POST')return send(404,{error:'not_found'});
      const input=JSON.parse((await readBody(req)).toString('utf8'));
      if(!input||typeof input!=='object'||Array.isArray(input))return send(400,{error:'invalid_input'});
      if(input.companyId&&input.companyId!==config.companyId)return send(400,{error:'company_mismatch'});
      input.companyId=config.companyId;
      if(req.url==='/handoffs'){const p=workflow.ingest(input);return send(200,{id:p.id,decision:p.assessment.decision});}
      if(req.url==='/watch'){if(typeof input.taskId!=='string'||!input.taskId||input.taskId.length>200)return send(400,{error:'invalid_task'});store.watch(input.taskId,input);return send(202,{status:'watching'});}
      if(req.url==='/radar'&&radar)return send(202,await radar(input));
      return send(404,{error:'not_found'});
    }catch(e){return send(e.status??400,{error:e.status===413?'body_too_large':'request_rejected'});}
  });
}
module.exports={createHttpServer,openCallback};
