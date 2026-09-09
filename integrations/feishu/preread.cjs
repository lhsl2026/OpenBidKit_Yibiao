function createPrereadClient({baseUrl,apiKey,relayAuthorization,fetchImpl=fetch}){
  const base=new URL(baseUrl);
  if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.search||base.hash)throw Error('invalid_preread_url');
  async function request(endpoint,body){
    if(body&&!relayAuthorization?.startsWith('Bearer '))throw Error('relay_auth_missing');
    const r=await fetchImpl(base.origin+endpoint,{method:body?'POST':'GET',headers:{authorization:body?relayAuthorization:'Bearer '+apiKey,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(30000)});
    if(!r.ok)throw Error('preread_unavailable');return r.json();
  }
  return {getHandoff:taskId=>request('/api/preread/tasks/'+encodeURIComponent(taskId)+'/handoff'),receiveRadar:body=>request('/openapi/preread/events/lark-message',body)};
}
async function pollWatches({store,client,workflow,clock=Date.now}){
  for(const w of store.listWatches(clock())){
    try{const handoff=await client.getHandoff(w.task_id);workflow.ingest({...w.payload,handoff});store.deferWatch(w.task_id,clock());}
    catch{store.deferWatch(w.task_id,clock(),'handoff_unavailable');}
  }
}
module.exports={createPrereadClient,pollWatches};
