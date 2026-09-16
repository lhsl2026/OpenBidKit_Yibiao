'use strict';
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {loadConfig}=require('./config.cjs');
const {createStore}=require('./store.cjs');
const {createGroupFileSource}=require('./group-file-source.cjs');

const run=promisify(execFile);

function parseReplayArgs(argv){
 const result={};
 for(let index=0;index<argv.length;index+=2){const flag=argv[index],value=argv[index+1];if(!value||!['--chat-id','--message-id'].includes(flag))throw Error('group_file_replay_arguments_invalid');const name=flag==='--chat-id'?'chatId':'messageId';if(result[name])throw Error('group_file_replay_arguments_invalid');result[name]=value;}
 if(!result.chatId||!result.messageId||argv.length!==4)throw Error('group_file_replay_arguments_invalid');return result;
}

async function defaultFetchMessage(config,{chatId,messageId}){
 const {stdout}=await run(config.groupFileSource.cliPath,['im','+messages-mget','--message-ids',messageId,'--no-reactions','--as','user','--profile',config.groupFileSource.profile,'--format','json'],{windowsHide:true,timeout:30000,maxBuffer:2*1024*1024,env:{...process.env,LARKSUITE_CLI_NO_UPDATE_NOTIFIER:'1',LARKSUITE_CLI_NO_SKILLS_NOTIFIER:'1'}});
 const result=JSON.parse(stdout),messages=result?.data?.messages??result?.messages;if(result?.ok!==true||!Array.isArray(messages))throw Error('group_file_replay_history_unavailable');
 const message=messages.find(item=>item?.message_id===messageId&&item?.chat_id===chatId);if(!message)throw Error('group_file_replay_message_missing');return message;
}

async function replayGroupFile({config,chatId,messageId,fetchMessage=input=>defaultFetchMessage(config,input),source}){
 if(!config.groupFileSource?.enabled||chatId!==config.chatId)throw Error('group_file_replay_target_invalid');const message=await fetchMessage({chatId,messageId});
 if(message?.chat_id!==chatId||message?.message_id!==messageId)throw Error('group_file_replay_message_invalid');const job=source.accept(message,{ignoreStart:true});if(!job)throw Error('group_file_replay_message_invalid');return {status:'accepted',jobId:job.id,stage:job.stage};
}

async function main(){
 const args=parseReplayArgs(process.argv.slice(2)),config=loadConfig(),store=createStore(path.join(config.dataRoot,'workflow.sqlite3')),owner=randomUUID(),now=Date.now();
 try{
  if(!store.lease('group-file-replay',owner,now,60000))throw Error('group_file_replay_active');
  const source=createGroupFileSource({store,config,clock:Date.now,assertOwnership:()=>{if(!store.ownsLease('group-file-replay',owner,Date.now()))throw Error('group_file_replay_lease_lost');}});
  console.log(JSON.stringify(await replayGroupFile({config,...args,source})));
 }finally{store.release('group-file-replay',owner);store.close();}
}

if(require.main===module)main().catch(error=>{console.error(JSON.stringify({status:'failed',code:/^group_file_[a-z_]+$/.test(error?.message)?error.message:'group_file_replay_failed'}));process.exitCode=1;});

module.exports={defaultFetchMessage,parseReplayArgs,replayGroupFile};
