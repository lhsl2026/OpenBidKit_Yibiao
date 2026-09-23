const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {PassThrough}=require('node:stream');
const {createStore}=require('../store.cjs');
const {createWorkflow}=require('../workflow.cjs');
const {createCardSource,normalizeCardEvent,normalizeCardCallback,cliArguments}=require('../card-source.cjs');
const config={chatId:'oc_test',operatorIds:['ou_actor'],cardSource:{enabled:true,cliPath:'C:/tools/lark-cli.exe',profile:'openbidkit-feishu'}};
const value={agent:'openbidkit',projectId:'project',version:'v1',cardKey:'key',action:'follow'};
const event=(v=value,extra={})=>({type:'card.action.trigger',event_id:'event-1',operator_id:'ou_actor',chat_id:'oc_test',message_id:'om_card',host:'im_message',action_tag:'button',action_value:JSON.stringify(v),...extra});
const waitFor=async(check,timeoutMs=2000)=>{const until=Date.now()+timeoutMs;while(!check()){if(Date.now()>until)assert.fail('condition timed out');await new Promise(r=>setTimeout(r,5));}};
function child(){const c=new EventEmitter();c.stdin=new PassThrough();c.stdout=new PassThrough();c.stderr=new PassThrough();c.exitCode=null;c.signalCode=null;c.kill=()=>{c.killed=true;c.finish();};c.finish=()=>{if(c.exitCode!==null)return;c.exitCode=0;c.stdout.end();c.stderr.end();c.emit('close',0);};c.stdin.on('finish',c.finish);return c;}
function source(t,workflow,options={}){const children=[],calls=[];const s=createCardSource({config,workflow,spawnImpl:(exe,args,opts)=>{calls.push({exe,args,opts});const c=child();children.push(c);return c;},reconnectMs:20,startupTimeoutMs:1000,stopTimeoutMs:50,...options});t.after(()=>s.close());s.start();return{s,children,calls};}
const ready=c=>c.stderr.write('[event] ready event_key=card.action.trigger\n');
const emit=(c,e)=>c.stdout.write(JSON.stringify(e)+'\n');

test('CLI card contract retains only allowed action fields and rejects spoofed context',()=>{
 const a=normalizeCardEvent(event({...value,actorId:'ou_intruder',chatId:'oc_wrong',eventId:'forged'},{token:'secret',card_content:'private'}),config);
 assert.deepEqual(a,{projectId:'project',version:'v1',cardKey:'key',action:'follow',actorId:'ou_actor',chatId:'oc_test',messageId:'om_card',eventId:'event-1'});
 for(const e of [event(value,{operator_id:'ou_other'}),event(value,{chat_id:'oc_other'}),event(value,{message_id:''}),event(value,{event_id:''}),event(value,{host:'im_top_notice'}),event(value,{action_tag:'input'}),event({...value,agent:'other'}),event({...value,action:'arbitrary'}),event({...value,cardKey:''}),event(value,{action_value:'broken'})])assert.equal(normalizeCardEvent(e,config),null);
 const args=cliArguments(config.cardSource);assert.equal(args[args.indexOf('--as')+1],'bot');assert.equal(args[args.indexOf('--profile')+1],'openbidkit-feishu');assert.ok(!args.includes('--quiet'));assert.ok(!args[args.indexOf('--jq')+1].includes('token'));
});
test('namespaced card actions normalize to the existing business contracts while legacy cards remain valid',()=>{
 const common={projectId:'project',version:'v1',cardKey:'key'};
 const cases=[
  [{action:'company_match.follow',...common},'company_match',{agent:'openbidkit',action:'follow',...common}],
  [{action:'writing.start',...common},'writing',{agent:'openbidkit',action:'write',...common}],
  [{action:'selection.decline',batchKey:'a'.repeat(40),challenge:'b'.repeat(32)},'selection',{agent:'openbidkit-selection',action:'decline',batchKey:'a'.repeat(40),challenge:'b'.repeat(32)}],
  [{action:'preread.select_task',jobId:'a'.repeat(40),taskId:'task-1',revision:2},'preread',{agent:'openbidkit-group-file',action:'select_task',jobId:'a'.repeat(40),taskId:'task-1',revision:2}],
 ];
 for(const [input,route,want] of cases){const normalized=normalizeCardCallback(event(input),config);assert.equal(normalized.route,route);assert.deepEqual(normalized.value,want);}
 const legacy=normalizeCardCallback(event(value),config);assert.equal(legacy.route,'company_match');assert.deepEqual(legacy.value,value);
});
test('ready marker gates stdout, arbitrary chunks assemble once, stderr/status never retain secrets',async t=>{
 const actions=[];const {s,children,calls}=source(t,{act:a=>actions.push(a)});const c=children[0];
 assert.equal(calls[0].exe,config.cardSource.cliPath);assert.equal(calls[0].opts.windowsHide,true);assert.deepEqual(calls[0].opts.stdio,['pipe','pipe','pipe']);
 const line=JSON.stringify(event())+'\n';c.stdout.write(line.slice(0,30));c.stdout.write(line.slice(30));await new Promise(r=>setTimeout(r,15));assert.equal(actions.length,0);
 c.stderr.write('[event] ready event_key=card.');c.stderr.write('action.trigger\n');await waitFor(()=>actions.length===1);assert.equal(s.status().ready,true);
 c.stderr.write(JSON.stringify({ok:false,error:{type:'authorization',message:'secret-token'}})+'\n');await waitFor(()=>s.status().ready===false);assert.ok(!JSON.stringify(s.status()).includes('secret-token'));
});
test('reconnect waits for old child closure and closing prevents new actions or consumers',async t=>{
 const actions=[];const {s,children}=source(t,{act:a=>actions.push(a)});ready(children[0]);await waitFor(()=>s.status().ready);children[0].finish();await waitFor(()=>children.length===2);
 ready(children[1]);emit(children[1],event());await waitFor(()=>actions.length===1);await s.close();emit(children[1],event(value,{event_id:'late'}));await new Promise(r=>setTimeout(r,40));assert.equal(children.length,2);assert.equal(actions.length,1);assert.equal(s.status().ready,false);
});
test('workflow rejects wrong message/version and replayed write events never restart paid jobs',async t=>{
 const store=createStore(':memory:');t.after(()=>store.close());
 const workflow=createWorkflow({store,chatId:config.chatId,operatorIds:config.operatorIds,clock:()=>Date.parse('2026-09-10T00:00:00Z'),assess:()=>({decision:'follow',items:[],blockers:[],actions:[]})});
 const p=workflow.ingest({companyId:'test',deadline:'2026-12-01T00:00:00Z',handoff:{schemaVersion:'1.0',task:{taskId:'task',title:'test'},snapshot:{documentVersion:'v1',reportId:'report',checksum:'a',generatedAt:'2026-09-09T00:00:00Z'},latestDocumentVersion:'v1',status:'ready',requirements:[],warnings:[],evidence:[]}});store.bindMessage(p.id,'om_card');
 const v={...value,projectId:p.id,cardKey:store.key(p.input,p.assessment)};
 // Same event first arriving via the signed HTTP mapping must remain idempotent on the CLI path.
 workflow.act({projectId:p.id,version:p.version,action:'follow',cardKey:v.cardKey,challenge:undefined,page:undefined,actorId:'ou_actor',chatId:'oc_test',messageId:'om_card',eventId:'follow'});
 const {s,children}=source(t,workflow);ready(children[0]);emit(children[0],event(v,{message_id:'om_wrong'}));emit(children[0],event({...v,version:'old'}));emit(children[0],event(v,{event_id:'follow'}));emit(children[0],event({...v,action:'write'},{event_id:'write'}));await waitFor(()=>store.listWriting().length===1);
 const job=store.listWriting()[0];store.updateWriting(job.id,'interrupted',{code:'process_interrupted'},0);children[0].finish();await waitFor(()=>children.length===2);ready(children[1]);emit(children[1],event({...v,action:'write'},{event_id:'write'}));await waitFor(()=>s.status().accepted===3);assert.equal(store.listWriting().length,1);assert.equal(store.listWriting()[0].status,'interrupted');await s.close();
});
test('lease loss stops processing and reconnect; startup missing marker remains unready',async t=>{
 let owned=true;const actions=[];const {s,children}=source(t,{act:a=>actions.push(a)},{assertOwnership:()=>{if(!owned)throw Error('lost');},startupTimeoutMs:30});
 await waitFor(()=>children.length===2);assert.equal(s.status().ready,false);ready(children[1]);owned=false;emit(children[1],event());await waitFor(()=>s.status().error==='card_source_ownership_lost');await new Promise(r=>setTimeout(r,50));assert.equal(actions.length,0);assert.equal(children.length,2);
});
test('selection routing admits only the fixed agent contract and sanitized UUID form choices',async t=>{
 const received=[];const {children}=source(t,{act:()=>assert.fail('selection must use handler')},{onAction:(v,e)=>received.push({v,e})});ready(children[0]);
 const v={agent:'openbidkit-selection',batchKey:'a'.repeat(40),challenge:'b'.repeat(32),action:'select'},id='123e4567-e89b-12d3-a456-426614174000';
 emit(children[0],event(v,{form_value:JSON.stringify({events:[id]}),token:'private',card_content:'private'}));
 for(const e of [event({...v,agent:'unapproved'}),event({...v,challenge:''}),event(v,{form_value:JSON.stringify({events:[id],other:'private'})}),event(v,{form_value:JSON.stringify({events:['not-uuid']})}),event(v,{operator_id:'ou_other'}),event(v,{form_value:JSON.stringify({events:[id]}),message_id:'bad'})])emit(children[0],e);
 await waitFor(()=>received.length===1);await new Promise(r=>setTimeout(r,20));assert.deepEqual(received,[{v,e:{eventId:'event-1',actorId:'ou_actor',chatId:'oc_test',messageId:'om_card',formValue:{events:[id]}}}]);
});
test('group file selection reaches its handler for the source member while preserving callback context',async t=>{
 const received=[];const {children}=source(t,{}, {onAction:(v,e)=>received.push({v,e})});ready(children[0]);
 const v={agent:'openbidkit-group-file',action:'select_task',jobId:'a'.repeat(40),taskId:'11111111-1111-4111-8111-111111111111',revision:2};emit(children[0],event(v,{operator_id:'ou_source_member'}));
 for(const bad of [{...v,action:'other'},{...v,jobId:'bad'},{...v,taskId:''},{...v,revision:0}])emit(children[0],event(bad,{operator_id:'ou_source_member',event_id:'bad-'+Math.random()}));
 await waitFor(()=>received.length===1);await new Promise(r=>setTimeout(r,15));assert.deepEqual(received,[{v,e:{eventId:'event-1',actorId:'ou_source_member',chatId:'oc_test',messageId:'om_card'}}]);
});
test('Card2 form submit reconstructs selection only from the exact scoped action name',async t=>{
 const received=[];const {children}=source(t,{}, {onAction:(v,e)=>received.push({v,e})});ready(children[0]);
 const v={agent:'openbidkit-selection',batchKey:'a'.repeat(40),challenge:'b'.repeat(32),action:'select'},id='123e4567-e89b-12d3-a456-426614174000';
 const e=event(undefined,{action_value:'',action_name:'selection_select_'+v.batchKey+'_'+v.challenge,form_value:JSON.stringify({events:[id]})});
 emit(children[0],e);emit(children[0],{...e,event_id:'forged',action_name:'submit_selection'});emit(children[0],{...e,event_id:'bad',action_name:e.action_name+'x'});emit(children[0],{...e,event_id:'other',operator_id:'ou_other'});
 await waitFor(()=>received.length===1);await new Promise(r=>setTimeout(r,15));assert.deepEqual(received,[{v,e:{eventId:'event-1',actorId:'ou_actor',chatId:'oc_test',messageId:'om_card',formValue:{events:[id]}}}]);
 const legacy=normalizeCardCallback({...e,event_id:'legacy',action_name:'openbidkit_selection_'+v.batchKey+'_'+v.challenge},config);assert.equal(legacy.route,'selection');assert.deepEqual(legacy.value,v);
 assert.match(cliArguments(config.cardSource)[cliArguments(config.cardSource).indexOf('--jq')+1],/action_name/);
});
test('asynchronous handlers run in order and shutdown waits for only the action already underway',async t=>{
 let release;const done=new Promise(r=>{release=r;}),seen=[];
 const {s,children}=source(t,{}, {onAction:async(v,e)=>{seen.push(e.eventId);await done;}});ready(children[0]);emit(children[0],event());emit(children[0],event(value,{event_id:'queued'}));await waitFor(()=>seen.length===1);
 let closed=false;const closing=s.close().then(()=>{closed=true;});await new Promise(r=>setTimeout(r,15));assert.equal(closed,false);release();await closing;assert.deepEqual(seen,['event-1']);
});
test('oversized streams fail closed and an invalid action does not stall later callbacks',async t=>{
 const seen=[];const {s,children}=source(t,{}, {onAction:async(v,e)=>{if(e.eventId==='reject')throw Error('private');seen.push(e.eventId);}});ready(children[0]);
 children[0].stdout.write('not-json\n');emit(children[0],event(value,{event_id:'reject'}));emit(children[0],event());await waitFor(()=>seen.length===1);assert.equal(s.status().rejected,2);
 children[0].stdout.write('x'.repeat(65537));await waitFor(()=>s.status().error==='card_source_line_too_large');assert.equal(s.status().ready,false);assert.equal(JSON.stringify(s.status()).includes('private'),false);
});
test('non-string and inherited action names are rejected without interrupting later callbacks',async t=>{
 const seen=[];const {s,children}=source(t,{}, {onAction:async(v,e)=>seen.push(e.eventId)});ready(children[0]);
 emit(children[0],event({...value,action:{toString:null}},{event_id:'malformed'}));
 emit(children[0],event({...value,action:'toString'},{event_id:'inherited'}));
 emit(children[0],event(value,{event_id:'valid'}));
 await waitFor(()=>seen.length===1);assert.deepEqual(seen,['valid']);assert.equal(s.status().rejected,2);
});
test('real temporary Node consumer exits through stdin EOF and UTF-8 chunks stay intact',async t=>{
 const actions=[];let proc;
 const e=event({...value,version:'版本一'});const script=`const b=Buffer.from(${JSON.stringify(JSON.stringify(e)+'\n')});process.stderr.write('[event] ready event_key=card.action.trigger\\n');for(let i=0;i<b.length;i++)process.stdout.write(b.subarray(i,i+1));process.stdin.resume();process.stdin.on('end',()=>process.exit(0));`;
 const s=createCardSource({config,workflow:{act:a=>actions.push(a)},spawnImpl:(exe,args,opts)=>(proc=require('node:child_process').spawn(process.execPath,['-e',script],opts)),startupTimeoutMs:5000,stopTimeoutMs:1000});t.after(()=>s.close());s.start();await waitFor(()=>actions.length===1,7000);assert.equal(actions[0].version,'版本一');await s.close();assert.equal(proc.exitCode,0);assert.equal(proc.killed,false);
});
