function createPrereadClient({baseUrl,apiKey,relayAuthorization,fetchImpl=fetch}){
  const base=new URL(baseUrl);
  const MAX_SOURCE_BYTES=30*1024*1024;
  if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.search||base.hash)throw Error('invalid_preread_url');
  async function request(endpoint,body,relay=false){
    if((body||relay)&&!relayAuthorization?.startsWith('Bearer '))throw Error('relay_auth_missing');
    const r=await fetchImpl(base.origin+endpoint,{method:body?'POST':'GET',headers:{authorization:body||relay?relayAuthorization:'Bearer '+apiKey,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(30000)});
    if(!r.ok)throw Error('preread_unavailable');return r.json();
  }
  async function getSourceDocument(taskId,documentVersion){
    const query=documentVersion===undefined?'':'?documentVersion='+encodeURIComponent(documentVersion);
    const r=await fetchImpl(base.origin+'/api/preread/tasks/'+encodeURIComponent(taskId)+'/source-document'+query,{method:'GET',headers:{authorization:'Bearer '+apiKey},redirect:'error',signal:AbortSignal.timeout(30000)});
    if(!r.ok)throw Error('preread_source_unavailable');
    const announced=Number(r.headers.get('content-length'));if(Number.isFinite(announced)&&announced>MAX_SOURCE_BYTES)throw Error('preread_source_too_large');
    if(!r.body)throw Error('preread_source_unavailable');const reader=r.body.getReader(),chunks=[];let total=0;
    while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>MAX_SOURCE_BYTES){try{await reader.cancel();}catch{}throw Error('preread_source_too_large');}chunks.push(value);}
    const sha256=String(r.headers.get('x-preread-document-sha256')||'').toLowerCase();if(!/^[a-f0-9]{64}$/.test(sha256))throw Error('preread_source_identity_invalid');
    return {bytes:Buffer.concat(chunks.map(value=>Buffer.from(value)),total),sha256};
  }
  return {getHandoff:taskId=>request('/api/preread/tasks/'+encodeURIComponent(taskId)+'/handoff'),getTenderRun:taskId=>request('/openapi/preread/tasks/'+encodeURIComponent(taskId)+'/tender-run',undefined,true),confirmTenderDeliveryCard:(runId,body)=>request('/openapi/preread/tender-runs/'+encodeURIComponent(runId)+'/delivery-card/confirm',body),getCompanyMatchCard:taskId=>request('/openapi/preread/tasks/'+encodeURIComponent(taskId)+'/company-match-card',undefined,true),getSourceDocument,getPublication:taskId=>request('/openapi/preread/tasks/'+encodeURIComponent(taskId)+'/knowledge-publication',undefined,true),getDeliveryStatus:body=>request('/openapi/preread/delivery-outbox/status',body),confirmUnifiedCardDelivered:body=>request('/openapi/preread/delivery-outbox/unified-card-delivered',body),replaceCompanyProfiles:body=>request('/openapi/preread/company-profiles/import',body),importCompanyProfileSource:body=>request('/openapi/preread/company-profile-sources/import',body),receiveRadar:body=>request('/openapi/preread/events/lark-message',{...body,content:normalizeRadarContent(body.messageType,body.content)}),receiveGroupFile:body=>request('/openapi/preread/events/lark-group-file',body),attachManualDocument:(taskId,body)=>request('/openapi/preread/tasks/'+encodeURIComponent(taskId)+'/manual-documents',body),reconcileManualDocument:(taskId,sha256)=>request('/openapi/preread/tasks/'+encodeURIComponent(taskId)+'/manual-documents/'+encodeURIComponent(sha256),undefined,true),select:body=>request('/openapi/preread/events/lark-card-action',body)};
}
function parsed(content){if(typeof content!=='string')return content;try{return JSON.parse(content);}catch{return null;}}
function postDocument(content){
 const value=parsed(content);if(!value||typeof value!=='object'||Array.isArray(value))throw Error('unsupported_preread_post');
 if(typeof value.title==='string'&&Array.isArray(value.content))return value;
 if(value.zh_cn!==undefined)return postDocument(value.zh_cn);
 const locales=Object.keys(value);if(locales.length===1)return postDocument(value[locales[0]]);
 throw Error('unsupported_preread_post');
}
function renderPost(content){
 const document=postDocument(content),lines=document.title?[document.title]:[];
 for(const paragraph of document.content){
  if(!Array.isArray(paragraph))throw Error('unsupported_preread_post');
  let line='';
  for(const node of paragraph){
   if(!node||typeof node!=='object'||typeof node.text!=='string'||/[\r\n]/.test(node.text))throw Error('unsupported_preread_post');
   if(node.tag==='text')line+=node.text;
   else if(node.tag==='a'&&typeof node.href==='string'&&node.href){const label=node.text||node.href;line+=label.includes(node.href)?label:label+' '+node.href;}
   else throw Error('unsupported_preread_post');
  }
  lines.push(line);
 }
 return lines.join('\n');
}
function normalizeRadarContent(messageType,content){
 if(messageType==='text'){
  if(typeof content!=='string')throw Error('unsupported_preread_text');
  const value=parsed(content);if(value===null)return content;
  if(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===1&&typeof value.text==='string')return value.text;
  throw Error('unsupported_preread_text');
 }
 if(messageType==='post')return renderPost(content);
 throw Error('unsupported_preread_message_type');
}
async function pollWatches({store,client,workflow,clock=Date.now}){
  for(const w of store.listWatches(clock())){
    try{const handoff=await client.getHandoff(w.task_id);workflow.ingest({...w.payload,handoff});store.deferWatch(w.task_id,clock());}
    catch{store.deferWatch(w.task_id,clock(),'handoff_unavailable');}
  }
}
module.exports={createPrereadClient,pollWatches,normalizeRadarContent};
