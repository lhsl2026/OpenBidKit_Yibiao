const RESULT_STATUSES=new Set(['triggered','waiting_confirmation','ignored','declined','selection_in_progress','processing']);
const PENDING_STATUSES=new Set(['selection_in_progress','processing']);

function inspectResults(results){
 if(!Array.isArray(results))throw Error('receipt_results_invalid');
 const taskIds=[];
 for(const result of results){
  if(!result||typeof result!=='object'||!RESULT_STATUSES.has(result.status))throw Error('receipt_result_status_invalid');
  if(result.status==='triggered'){
   if(typeof result.taskId!=='string'||!result.taskId)throw Error('receipt_task_id_invalid');
   taskIds.push(result.taskId);
  }else if(result.taskId!==undefined)throw Error('receipt_task_status_invalid');
 }
 return {taskIds:[...new Set(taskIds)],pending:results.some(result=>PENDING_STATUSES.has(result.status))};
}

function inspectReceipt(response){
 if(!response||typeof response!=='object'||Array.isArray(response)||typeof response.status!=='string')throw Error('receipt_invalid');
 if(response.status==='processing')return {taskIds:[],pending:true};
 if(response.status==='ignored')return {taskIds:[],pending:false};
 if(response.status==='processed')return inspectResults(response.results);
 if(response.status==='selection_processed'){
  if(!response.selection||response.selection.status!=='processed')throw Error('receipt_selection_invalid');
  return inspectResults(response.selection.results);
 }
 if(response.status==='selection_rejected'){
  if(!response.selection||response.selection.status!=='rejected')throw Error('receipt_selection_invalid');
  return {taskIds:[],pending:false};
 }
 throw Error('receipt_status_invalid');
}
function isSourceInboxActive(store,inboxId){
 const stateKey=store.get('radar-inbox:'+inboxId);if(!stateKey)return true;
 const state=store.get(stateKey);return !!state&&state.status==='active'&&state.original?.inboxId===inboxId;
}

function recordReceipt({store,inboxId,response,companyId,sourceInboxId=inboxId,now=Date.now(),onReceipt}){
 if(typeof inboxId!=='string'||!inboxId||typeof companyId!=='string'||!companyId)throw Error('receipt_identity_invalid');
 const inspected=inspectReceipt(response);
 return store.transaction(()=>{
  store.set('radar-receipt:'+inboxId,response);
  for(const taskId of inspected.taskIds)store.watch(taskId,{companyId,sourceInboxId});
  const sourceStateKey=store.get('radar-inbox:'+sourceInboxId),sourceState=sourceStateKey&&store.get(sourceStateKey);
  if(sourceState&&inspected.taskIds.length)store.set(sourceStateKey,{...sourceState,linkedTaskIds:[...new Set([...(sourceState.linkedTaskIds??[]),...inspected.taskIds])]});
  if(inspected.pending)store.retryInbox(inboxId,now);else store.finishInbox(inboxId);
  if(onReceipt)onReceipt(response,{inboxId:sourceInboxId,receiptId:inboxId,sourceInboxId,inspected});
  return inspected;
 });
}

module.exports={inspectReceipt,recordReceipt,isSourceInboxActive};
