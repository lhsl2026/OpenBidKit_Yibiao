'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {parseReplayArgs,replayGroupFile}=require('../group-file-replay.cjs');

test('replay arguments require exactly one chat and message identifier',()=>{
 assert.deepEqual(parseReplayArgs(['--chat-id','oc_chat','--message-id','om_message']),{chatId:'oc_chat',messageId:'om_message'});
 for(const args of [[],['--chat-id','oc_chat'],['--message-id','om_message'],['--chat-id','oc_chat','--message-id','om_message','--other','x'],['--chat-id','a','--chat-id','b','--message-id','m']])assert.throws(()=>parseReplayArgs(args),/group_file_replay_arguments_invalid/);
});

test('replay fetches the exact active-group message and feeds the normal accept path',async()=>{
 let fetched,accepted;const config={chatId:'oc_chat',groupFileSource:{enabled:true}};
 const result=await replayGroupFile({config,chatId:'oc_chat',messageId:'om_message',fetchMessage:async input=>{fetched=input;return {chat_id:'oc_chat',message_id:'om_message'};},source:{accept:(message,flags)=>{accepted={message,flags};return {id:'job',stage:'discovered'};}}});
 assert.deepEqual(fetched,{chatId:'oc_chat',messageId:'om_message'});assert.deepEqual(accepted.flags,{ignoreStart:true});assert.deepEqual(result,{status:'accepted',jobId:'job',stage:'discovered'});
 await assert.rejects(replayGroupFile({config,chatId:'oc_other',messageId:'om_message',fetchMessage:async()=>assert.fail(),source:{}}),/group_file_replay_target_invalid/);
});
