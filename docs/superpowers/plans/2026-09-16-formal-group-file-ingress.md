# Formal Group File Ingress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically receive PDF, DOC, and DOCX tender files posted by members of the active Feishu decision group, deduplicate and route them into the existing preread pipeline, then surface progress, decision cards, and archived reports in Feishu.

**Architecture:** Add one persistent `group-file-source` component under the existing OpenBidKit runner lease. It polls only the active delivery group, downloads and verifies message resources, performs message/hash deduplication and waiting-task matching, uploads to existing application storage, and calls the existing preread file APIs. Existing watch, decision-card, and report-archive flows remain authoritative downstream consumers.

**Tech Stack:** Node.js 22 CommonJS, `node:test`, `better-sqlite3`, Feishu `lark-cli`, Feishu OpenAPI card delivery, existing preread Relay API, existing Miaoda application storage.

**Spec:** `docs/superpowers/specs/2026-09-16-formal-group-file-ingress-design.md`

## Global Constraints

- The Feishu preread company remains exactly `隆创信息有限公司`; evidence from other companies must never be mixed in.
- Supported first-release file extensions are exactly `pdf,doc,docx`; default maximum size is `31457280` bytes.
- Do not start or modify the retired legacy Feishu listener; keep the existing preread compute backend running.
- Do not automatically quote, sign, seal, submit a bid, or claim that the company qualifies when evidence is missing.
- State cards and logs must not expose local paths, `file_key`, signed URLs, full hashes, credentials, raw API bodies, private IDs, or stack traces.
- External create operations must use persistent idempotency keys. An unknown upload or attachment result enters `manual_review` instead of being retried blindly.
- Use test-first development for every code task and commit only the files named by that task.

---

## File Structure

- Create `integrations/feishu/group-file-source.cjs`: normalize history messages, poll fixed windows, download and verify files, match waiting tasks, drive upload/submit stages, render status cards, and expose explicit replay.
- Create `integrations/feishu/group-file-replay.cjs`: command-line wrapper that accepts one chat ID and one message ID and feeds the same persistent source state machine.
- Create `integrations/feishu/test/group-file-source.test.cjs`: focused unit tests for discovery, security, deduplication, matching, state recovery, and cards.
- Modify `integrations/feishu/store.cjs`: add `group_file_jobs` and `group_file_status_outbox` tables plus focused store methods.
- Modify `integrations/feishu/preread.cjs`: expose `receiveGroupFile()` and `attachManualDocument()`.
- Modify `integrations/feishu/lark.cjs`: deliver one stable status-card stream per file job.
- Modify `integrations/feishu/card-source.cjs`: route `openbidkit-group-file` selection actions after normal authorization checks.
- Modify `integrations/feishu/runner.cjs`: construct, poll, advance, and reconcile the source inside the runner lease.
- Modify `integrations/feishu/main.cjs`: inject storage/source dependencies, route selection callbacks, and report readiness.
- Modify `integrations/feishu/config.cjs`: parse and validate group-file settings.
- Modify `integrations/feishu/deployment/production-check.cjs`: add read-only target-group history access verification.
- Modify `integrations/feishu/.env.example`, `integrations/feishu/README.md`, and `integrations/feishu/deployment/README.md`: document configuration, recovery, and replay.
- Modify the corresponding existing tests: `config.test.cjs`, `preread.test.cjs`, `runner.test.cjs`, `lark.test.cjs`, `card-main.test.cjs`, `production-check.test.cjs`, and `integration.test.cjs`.

---

### Task 1: Preread File API and Configuration Contract

**Files:**
- Modify: `integrations/feishu/preread.cjs`
- Modify: `integrations/feishu/config.cjs`
- Modify: `integrations/feishu/test/preread.test.cjs`
- Modify: `integrations/feishu/test/config.test.cjs`

**Interfaces:**
- Produces: `client.receiveGroupFile(body): Promise<object>`.
- Produces: `client.attachManualDocument(taskId, body): Promise<object>`.
- Produces: `config.groupFileSource = { enabled, cliPath, profile, startAt, maxBytes, allowedExtensions, root }`.

- [ ] **Step 1: Write failing preread-client tests**

Append tests that capture the exact endpoint, Relay authorization, URL escaping, and unchanged JSON body:

```js
test('group file uses the protected preread ingress', async () => {
  let call;
  const client=createPrereadClient({baseUrl:'http://127.0.0.1:3101',apiKey:'handoff',relayAuthorization:'Bearer relay',fetchImpl:async(url,options)=>{call={url,options};return Response.json({status:'processed',results:[]},{status:201});}});
  const body={eventId:'openbidkit-group-file-job',chatId:'chat',messageId:'message',createTime:'1785190080000',senderId:'sender',candidate:{url:'https://files.example/tender.pdf',fileName:'招标文件.pdf'}};
  assert.deepEqual(await client.receiveGroupFile(body),{status:'processed',results:[]});
  assert.ok(call.url.endsWith('/openapi/preread/events/lark-group-file'));
  assert.equal(call.options.headers.authorization,'Bearer relay');
  assert.deepEqual(JSON.parse(call.options.body),body);
});

test('manual document attachment escapes task id and preserves the candidate', async () => {
  let call;
  const client=createPrereadClient({baseUrl:'http://127.0.0.1:3101',apiKey:'handoff',relayAuthorization:'Bearer relay',fetchImpl:async(url,options)=>{call={url,options};return Response.json({acquisition:{status:'acquired',documentId:'document',documentVersion:1}});}});
  const body={chatId:'chat',manualActionId:'action',actorId:'sender',candidate:{url:'https://files.example/tender.docx',fileName:'招标文件.docx',officialCategory:'tender_document'}};
  await client.attachManualDocument('task/id',body);
  assert.ok(call.url.endsWith('/openapi/preread/tasks/task%2Fid/manual-documents'));
  assert.deepEqual(JSON.parse(call.options.body),body);
});
```

- [ ] **Step 2: Run the focused preread tests and verify failure**

Run: `node --test test/preread.test.cjs`

Expected: FAIL because `receiveGroupFile` and `attachManualDocument` are undefined.

- [ ] **Step 3: Implement the two preread methods**

Extend the object returned by `createPrereadClient`:

```js
receiveGroupFile: body => request('/openapi/preread/events/lark-group-file', body),
attachManualDocument: (taskId, body) => request('/openapi/preread/tasks/'+encodeURIComponent(taskId)+'/manual-documents', body),
```

- [ ] **Step 4: Write failing configuration tests**

Add assertions for defaults and enabled validation:

```js
assert.deepEqual(loadConfig(baseEnv).groupFileSource.allowedExtensions,['pdf','doc','docx']);
assert.equal(loadConfig(baseEnv).groupFileSource.maxBytes,31457280);
assert.throws(()=>loadConfig({...baseEnv,BID_GROUP_FILE_SOURCE_ENABLED:'true',BID_GROUP_FILE_CLI_PROFILE:''}),/group_file_source_not_configured/);
const enabled=loadConfig({...baseEnv,BID_GROUP_FILE_SOURCE_ENABLED:'true',BID_GROUP_FILE_CLI_PROFILE:'decision-user',BID_GROUP_FILE_START_AT:'2026-09-16T00:00:00+08:00'});
assert.equal(enabled.groupFileSource.root,path.join(enabled.dataRoot,'group-files'));
```

- [ ] **Step 5: Implement strict configuration parsing**

Parse `BID_GROUP_FILE_ALLOWED_EXTENSIONS`, normalize lower-case values, reject any value outside `pdf/doc/docx`, require an integer `maxBytes` from 1 through 30 MiB, validate `startAt` with `Date.parse`, and require absolute CLI path/profile/target chat/preread Relay/document-recovery storage when enabled. In production, add `group_file_source` to the missing list.

- [ ] **Step 6: Run focused tests and commit**

Run: `node --test test/preread.test.cjs test/config.test.cjs`

Expected: PASS.

```powershell
git add integrations/feishu/preread.cjs integrations/feishu/config.cjs integrations/feishu/test/preread.test.cjs integrations/feishu/test/config.test.cjs
git commit -m "feat: define formal group file ingress contract"
```

---

### Task 2: Persistent File Jobs and Status Outbox

**Files:**
- Modify: `integrations/feishu/store.cjs`
- Create: `integrations/feishu/test/group-file-source.test.cjs`

**Interfaces:**
- Produces: `store.receiveGroupFile(message, now): GroupFileJob`.
- Produces: `store.getGroupFileJob(id)`, `store.listGroupFileJobs(now)`, `store.findGroupFileByHash(companyId, sha256)`.
- Produces: `store.updateGroupFileJob(id, expectedStage, patch, now)` with compare-and-set semantics.
- Produces: `store.enqueueGroupFileStatus(id, card, now)`, `store.listGroupFileStatus(now)`, `store.bindGroupFileStatus(id, messageId)`, `store.finishGroupFileStatus(rowId)`, and retry/manual methods.

- [ ] **Step 1: Write the failing persistence tests**

Create the test file and assert message idempotency, conflict rejection, compare-and-set updates, hash lookup, and one pending status revision:

```js
test('file jobs deduplicate messages and reject conflicting identity', t=>{
  const store=createStore(':memory:');t.after(()=>store.close());
  const input={id:'job',companyId:'隆创信息有限公司',chatId:'chat',messageId:'message',senderId:'sender',createTime:'1785190080000',fileName:'招标文件.pdf',fileKey:'file_key',replyTo:null};
  assert.equal(store.receiveGroupFile(input,1000).stage,'discovered');
  assert.equal(store.receiveGroupFile(input,2000).id,'job');
  assert.throws(()=>store.receiveGroupFile({...input,fileKey:'different'},2000),/group_file_conflict/);
  assert.equal(store.db.prepare('SELECT COUNT(*) count FROM group_file_jobs').get().count,1);
});

test('stage changes use compare and set and hash lookup is company scoped', t=>{
  const store=createStore(':memory:');t.after(()=>store.close());
  store.receiveGroupFile({id:'job',companyId:'隆创信息有限公司',chatId:'chat',messageId:'message',senderId:'sender',createTime:'1',fileName:'a.pdf',fileKey:'file',replyTo:null},1);
  assert.equal(store.updateGroupFileJob('job','discovered',{stage:'downloaded',sha256:'a'.repeat(64),sourcePath:'C:/safe/a.pdf'},2).stage,'downloaded');
  assert.throws(()=>store.updateGroupFileJob('job','discovered',{stage:'uploaded'},3),/group_file_stage_conflict/);
  assert.equal(store.findGroupFileByHash('隆创信息有限公司','a'.repeat(64)).id,'job');
  assert.equal(store.findGroupFileByHash('另一家公司','a'.repeat(64)),null);
});
```

- [ ] **Step 2: Run the new tests and verify failure**

Run: `node --test test/group-file-source.test.cjs`

Expected: FAIL because the tables and methods do not exist.

- [ ] **Step 3: Add the schema**

Add explicit tables rather than storing large job records in generic settings:

```sql
CREATE TABLE IF NOT EXISTS group_file_jobs(
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  create_time TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_key TEXT NOT NULL,
  reply_to TEXT,
  stage TEXT NOT NULL,
  sha256 TEXT,
  source_path TEXT,
  remote_path TEXT,
  task_id TEXT,
  manual_action_id TEXT,
  match_mode TEXT,
  canonical_job_id TEXT,
  receipt TEXT,
  error_code TEXT,
  next_at INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  status_message_id TEXT,
  status_create_id TEXT NOT NULL,
  status_revision INTEGER NOT NULL DEFAULT 1,
  generation INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(chat_id,source_message_id),
  UNIQUE(company_id,sha256,generation)
);
CREATE TABLE IF NOT EXISTS group_file_status_outbox(
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  card TEXT NOT NULL,
  first_attempt INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL DEFAULT 0,
  delivered INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  UNIQUE(job_id,revision)
);
```

- [ ] **Step 4: Implement row mapping and store methods**

Use JSON only for `receipt` and `card`. `updateGroupFileJob` must issue `UPDATE ... WHERE id=? AND stage=?` and throw `group_file_stage_conflict` unless exactly one row changed. `enqueueGroupFileStatus` increments `status_revision` only when the serialized card differs from the newest queued/delivered card.

- [ ] **Step 5: Run store and full existing persistence tests**

Run: `node --test test/group-file-source.test.cjs test/runner.test.cjs test/integration.test.cjs`

Expected: PASS with existing tables and project behavior unchanged.

- [ ] **Step 6: Commit**

```powershell
git add integrations/feishu/store.cjs integrations/feishu/test/group-file-source.test.cjs
git commit -m "feat: persist formal group file jobs"
```

---

### Task 3: History Polling, Message Normalization, and Secure Download

**Files:**
- Create: `integrations/feishu/group-file-source.cjs`
- Modify: `integrations/feishu/test/group-file-source.test.cjs`

**Interfaces:**
- Produces: `historyArguments({chatId,start,end,token,profile}): string[]`.
- Produces: `normalizeFileMessage(message, config): NormalizedFileMessage|null`.
- Produces: `inspectLocalFile({filePath,fileName,maxBytes,allowedExtensions,root}): {sha256,size,extension}`.
- Produces: `createGroupFileSource(dependencies)` with `poll()`, `tick()`, `replay({chatId,messageId})`, `select(input)`, and `status()`.

- [ ] **Step 1: Add failing normalization and CLI argument tests**

Use a realistic history record and assert target-chat and human-sender gating:

```js
const historyMessage={chat_id:'decision',message_id:'om_file',msg_type:'file',create_time:'2026-09-16 09:30',content:'[File: 招标文件.pdf](file_key)',sender:{sender_type:'user',id:'ou_member'},parent_id:'om_parent'};
const config={chatId:'decision',companyId:'隆创信息有限公司',groupFileSource:{enabled:true,profile:'decision-user',allowedExtensions:['pdf','doc','docx'],startAt:'2026-09-16T00:00:00+08:00',maxBytes:31457280}};
const event=normalizeFileMessage(historyMessage,config);
assert.equal(event.fileName,'招标文件.pdf');
assert.equal(event.fileKey,'file_key');
assert.equal(event.replyTo,'om_parent');
assert.equal(normalizeFileMessage({...historyMessage,chat_id:'other'},config),null);
assert.equal(normalizeFileMessage({...historyMessage,sender:{sender_type:'bot',id:'bot'}},config),null);
assert.equal(normalizeFileMessage({...historyMessage,msg_type:'text'},config),null);
const args=historyArguments({chatId:'decision',start:0,end:1000,profile:'decision-user'});
assert.equal(args[args.indexOf('--as')+1],'user');
assert.equal(args[args.indexOf('--profile')+1],'decision-user');
```

- [ ] **Step 2: Run tests and verify failure**

Run: `node --test test/group-file-source.test.cjs`

Expected: FAIL because `group-file-source.cjs` is absent.

- [ ] **Step 3: Implement normalization and fixed-window polling**

Parse both JSON file content and `[File: name](file_key)` form. Persist `group-file-source:<chatId>` with `{window:{start,end,token},cursor,nextAt,lastSuccessAt,error}` before I/O. On a page failure retain the exact window and set only `error:'group_file_history_unavailable'`; on final page replace the window with `cursor:end`.

- [ ] **Step 4: Add failing secure-download tests**

Create temporary PDF, OLE DOC, OOXML DOCX, mismatch, oversize, and traversal fixtures. Assertions must include:

```js
assert.equal(inspectLocalFile({filePath:pdf,fileName:'招标文件.pdf',maxBytes:1024,allowedExtensions:['pdf','doc','docx'],root:temporaryRoot}).sha256,createHash('sha256').update(pdfBytes).digest('hex'));
assert.throws(()=>inspectLocalFile({filePath:pdf,fileName:'../escape.pdf',maxBytes:1024,allowedExtensions:['pdf'],root:temporaryRoot}),/group_file_name_invalid/);
assert.throws(()=>inspectLocalFile({filePath:pdf,fileName:'fake.docx',maxBytes:1024,allowedExtensions:['docx'],root:temporaryRoot}),/group_file_content_invalid/);
```

- [ ] **Step 5: Implement resource download and content inspection**

Call `lark-cli im +messages-resources-download --message-id <id> --file-key <key> --type file --output <relative-safe-path> --as user --profile <profile> --format json` using `execFile`. Verify the real path is inside `groupFileSource.root/tmp/<job-id>`, stream the hash, recognize `%PDF-`, OLE `D0 CF 11 E0 A1 B1 1A E1`, and ZIP `PK` only for `.docx`, then move to `objects/<sha256><ext>` with exclusive creation or verified reuse.

- [ ] **Step 6: Run focused tests and commit**

Run: `node --test test/group-file-source.test.cjs`

Expected: PASS.

```powershell
git add integrations/feishu/group-file-source.cjs integrations/feishu/test/group-file-source.test.cjs
git commit -m "feat: discover and verify decision group files"
```

---

### Task 4: Deduplication, Waiting-Task Matching, Upload, and Submission

**Files:**
- Modify: `integrations/feishu/group-file-source.cjs`
- Modify: `integrations/feishu/test/group-file-source.test.cjs`
- Modify: `integrations/feishu/document-recovery.cjs`
- Modify: `integrations/feishu/test/document-recovery.test.cjs`

**Interfaces:**
- Consumes: `createAppStorage(options)` from `document-recovery.cjs`.
- Produces: `matchWaitingTask({job, candidates}): {status:'none'}|{status:'unique',candidate}|{status:'ambiguous',candidates}`.
- Produces: `source.tick()` stage transitions through `downloaded`, `matching`, `waiting_selection`, `uploading`, `uploaded`, `submitting|attaching`, and `watching`.

- [ ] **Step 1: Write failing hash-dedup and matching tests**

Cover an in-progress canonical job, a completed canonical job, direct-reply match, unique normalized-title match, ambiguous title match, and no match:

```js
assert.deepEqual(matchWaitingTask({job:{replyTo:'card-1',fileName:'A项目招标文件.pdf'},candidates:[{taskId:'t1',statusCardMessageId:'card-1',title:'A项目',manualActionId:'a1'}]}),{status:'unique',candidate:{taskId:'t1',statusCardMessageId:'card-1',title:'A项目',manualActionId:'a1'},mode:'reply'});
assert.equal(matchWaitingTask({job:{replyTo:null,fileName:'A项目招标文件.pdf'},candidates:[{taskId:'t1',title:'A项目'},{taskId:'t2',title:'A项目二标段'}]}).status,'ambiguous');
assert.equal(matchWaitingTask({job:{replyTo:null,fileName:'完全不同.pdf'},candidates:[{taskId:'t1',title:'A项目'}]}).status,'none');
```

- [ ] **Step 2: Expose deterministic waiting candidates from document recovery**

Add `waitingCandidates()` that returns only jobs still tied to an active source and whose task remains in `waiting_upload`, projected as `{taskId,manualActionId,title,statusCardMessageId,sourceInboxId}`. Do not expose remote URLs or local paths.

- [ ] **Step 3: Implement strict matching**

Reply-message equality wins. Name matching removes extension, whitespace, punctuation, `招标文件`, `采购文件`, and `正文`, then requires one candidate title to equal or be a complete normalized substring at least six Chinese/alphanumeric characters long. More than one match returns `ambiguous`; zero returns `none`.

- [ ] **Step 4: Write failing state-machine tests**

Inject fake downloader, storage, preread, candidate provider, and clock. Assert:

- identical hash links `canonicalJobId` and performs zero uploads/submit calls;
- no candidate performs one upload, one sign, and one `receiveGroupFile` call with stable `eventId`;
- a unique candidate performs one `attachManualDocument` call with `officialCategory:'tender_document'`;
- ambiguous candidates stop at `waiting_selection` before upload;
- `uploading` or `attaching` after process restart becomes `manual_review`;
- a `processed` or duplicate response calls `recordReceipt()` once and changes to `watching`.

- [ ] **Step 5: Implement one-stage-per-tick transitions**

Every `tick()` advances at most one external-I/O stage. Persist `uploading`, `submitting`, or `attaching` before the call. Upload success persists `remotePath`; sign failures remain `uploaded` with a retry time because signing is read-only. Submission uses:

```js
{
  eventId:'openbidkit-group-file-'+job.id,
  chatId:job.chatId,
  messageId:job.messageId,
  createTime:job.createTime,
  senderId:job.senderId,
  candidate:{url:signed.url,fileName:job.fileName}
}
```

Attachment uses:

```js
{
  chatId:job.chatId,
  manualActionId:job.manualActionId,
  actorId:job.senderId,
  candidate:{url:signed.url,fileName:job.fileName,officialCategory:'tender_document'}
}
```

- [ ] **Step 6: Run focused tests and commit**

Run: `node --test test/group-file-source.test.cjs test/document-recovery.test.cjs test/preread.test.cjs`

Expected: PASS.

```powershell
git add integrations/feishu/group-file-source.cjs integrations/feishu/document-recovery.cjs integrations/feishu/test/group-file-source.test.cjs integrations/feishu/test/document-recovery.test.cjs
git commit -m "feat: route group files into preread tasks"
```

---

### Task 5: Status Cards and Ambiguous-Match Actions

**Files:**
- Modify: `integrations/feishu/group-file-source.cjs`
- Modify: `integrations/feishu/lark.cjs`
- Modify: `integrations/feishu/card-source.cjs`
- Modify: `integrations/feishu/test/group-file-source.test.cjs`
- Modify: `integrations/feishu/test/lark.test.cjs`
- Modify: `integrations/feishu/test/card-main.test.cjs`

**Interfaces:**
- Produces: `buildGroupFileStatusCard(job, candidates=[]): Card2Json`.
- Produces: `deliverGroupFileStatus({store,client,mode,chatId,allowedChats,clock,assertOwnership})`.
- Consumes callback value `{agent:'openbidkit-group-file',action:'select_task',jobId,taskId,revision}`.
- Produces: `source.select({jobId,taskId,revision,actorId,chatId,messageId,eventId})`.

- [ ] **Step 1: Write failing card-content tests**

Assert exact safe copy and absence of sensitive fields:

```js
const card=buildGroupFileStatusCard({id:'job',fileName:'项目.pdf',stage:'discovered',errorCode:null,statusRevision:1});
assert.match(JSON.stringify(card),/已收到招标文件，正在下载并校验/);
for(const secret of ['C:\\','file_key','https://signed','a'.repeat(64)]) assert.equal(JSON.stringify(card).includes(secret),false);
```

For failure stages, assert the card maps fixed codes to user actions and never prints arbitrary `Error.message`.

- [ ] **Step 2: Implement Card 2.0 rendering**

Use fixed stage labels: `已收到`, `文件校验完成`, `请选择所属项目`, `正在预读`, `已完成`, `处理失败`. Ambiguous cards contain at most five task buttons and a non-interactive overflow instruction. Button values include only agent/action/job/task/revision.

- [ ] **Step 3: Write failing delivery-idempotency tests**

Assert the first delivery uses `job.statusCreateId`, persists one message ID, and a later revision calls only `updateCard`. An unknown create older than 45 minutes becomes manual without a second `sendCard` call.

- [ ] **Step 4: Implement the dedicated status outbox delivery**

Mirror `deliverOutbox` fencing and uncertainty rules, but always target the job's active group and never accept a caller-supplied chat. Mark an outbox row delivered only if its revision is still current after the API call.

- [ ] **Step 5: Write failing callback tests and implement selection**

Route `agent === 'openbidkit-group-file'` before `toWorkflowAction`. `source.select` must verify target group, original sender or configured operator, current job revision, `waiting_selection` stage, and candidate membership. Save `taskId`, `manualActionId`, `matchMode:'manual'`, change to `uploading`, and enqueue a new status-card revision transactionally. Repeated identical `eventId` returns the saved result.

- [ ] **Step 6: Run focused tests and commit**

Run: `node --test test/group-file-source.test.cjs test/lark.test.cjs test/card-main.test.cjs`

Expected: PASS.

```powershell
git add integrations/feishu/group-file-source.cjs integrations/feishu/lark.cjs integrations/feishu/card-source.cjs integrations/feishu/test/group-file-source.test.cjs integrations/feishu/test/lark.test.cjs integrations/feishu/test/card-main.test.cjs
git commit -m "feat: report group file progress in Feishu"
```

---

### Task 6: Runner, Application, Readiness, and Replay Integration

**Files:**
- Modify: `integrations/feishu/runner.cjs`
- Modify: `integrations/feishu/main.cjs`
- Create: `integrations/feishu/group-file-replay.cjs`
- Modify: `integrations/feishu/test/runner.test.cjs`
- Modify: `integrations/feishu/test/integration.test.cjs`
- Modify: `integrations/feishu/package.json`

**Interfaces:**
- `createRunner` accepts `groupFileSource` and calls `poll()` then `tick()` under its existing lease.
- `createApplication` exposes `groupFileSource` for test/readiness inspection.
- Replay command: `node --env-file-if-exists=.env group-file-replay.cjs --chat-id <id> --message-id <id>`.

- [ ] **Step 1: Write failing runner-order and fencing tests**

Inject a fake source and assert `poll` and `tick` run after lease acquisition, ownership is checked after each await, and aborted/lease-lost ticks do not submit or deliver status. Assert `deliverGroupFileStatus` runs before the normal project outbox so the receipt appears promptly.

- [ ] **Step 2: Integrate the source with the runner**

Construct the source in `main.cjs` with store/config/preread/storage/documentRecovery/lark/clock and `assertOwnership`. Keep runner generic by accepting the constructed source. In `runner.tick()` call:

```js
await groupFileSource.poll();
assertOwnership();
await groupFileSource.tick({signal:controller.signal});
assertOwnership();
```

Call `deliverGroupFileStatus` inside the existing `if (lark)` block before `deliverOutbox`.

- [ ] **Step 3: Add application callback routing and readiness**

Route group-file actions to `groupFileSource.select`. When enabled, readiness adds `group_file_source` if `status().lastSuccessAt` is absent, older than 300000 ms, or `status().error` is non-null. Return only `{enabled,ready,lastSuccessAt,error}`; do not include chat/message IDs.

- [ ] **Step 4: Write failing replay tests**

Factor argument parsing as `parseReplayArgs(argv)` and assert missing/duplicate/unknown options fail. Inject `fetchMessage` and assert replay verifies `chatId === config.chatId`, fetches exactly the named message, invokes the same `accept()` path as polling, and exits without starting the HTTP server.

- [ ] **Step 5: Implement the replay command**

Add package script `replay:group-file`. The command loads normal configuration and SQLite, acquires a distinct short replay lease, normalizes the exact history message, inserts or returns its existing job, prints only JSON `{status,jobId,stage}` and exits nonzero on a fixed safe error code.

- [ ] **Step 6: Run integration tests and commit**

Run: `node --test test/group-file-source.test.cjs test/runner.test.cjs test/integration.test.cjs`

Expected: PASS.

```powershell
git add integrations/feishu/runner.cjs integrations/feishu/main.cjs integrations/feishu/group-file-replay.cjs integrations/feishu/package.json integrations/feishu/test/runner.test.cjs integrations/feishu/test/integration.test.cjs integrations/feishu/test/group-file-source.test.cjs
git commit -m "feat: run formal group file ingress"
```

---

### Task 7: Production Gate and Operator Documentation

**Files:**
- Modify: `integrations/feishu/deployment/production-check.cjs`
- Modify: `integrations/feishu/test/production-check.test.cjs`
- Modify: `integrations/feishu/.env.example`
- Modify: `integrations/feishu/README.md`
- Modify: `integrations/feishu/deployment/README.md`

**Interfaces:**
- `productionConfigReady(config)` requires enabled valid group-file source in production.
- `runProductionCheck()` adds `group_file_source` read-only history access check.

- [ ] **Step 1: Write failing production-check tests**

Extend the fixture with enabled group-file config and expect an eighth check:

```js
['group_file_source','pass']
```

Assert the CLI call uses `im +chat-messages-list`, the production chat, `--page-size 1`, `--as user`, and `groupFileSource.profile`. Add failure cases for missing profile, external formal group, and unavailable user history without exposing identifiers.

- [ ] **Step 2: Implement the read-only check**

Call history list with a one-minute window and page size one. Do not download a file, send a message, create a task, or call the model. Treat `{messages:[]}` as pass; the permission/read operation itself is the probe.

- [ ] **Step 3: Document exact environment keys and recovery behavior**

Add the five keys from the spec to `.env.example`. In README documents state flow, supported types, 30 MiB default, same-file deduplication, waiting-task choice, fixed error codes, and the exact replay command. In deployment README add backup, enable, restart, `/ready`, production-check, replay, and rollback steps; rollback only disables `BID_GROUP_FILE_SOURCE_ENABLED` and restarts OpenBidKit.

- [ ] **Step 4: Run tests and commit**

Run: `node --test test/config.test.cjs test/production-check.test.cjs`

Expected: PASS with eight production checks.

```powershell
git add integrations/feishu/deployment/production-check.cjs integrations/feishu/test/production-check.test.cjs integrations/feishu/.env.example integrations/feishu/README.md integrations/feishu/deployment/README.md
git commit -m "docs: operate formal group file ingress"
```

---

### Task 8: Regression, Deployment, Replay, and Live Acceptance

**Files:**
- Modify: `docs/feishu-acceptance.md`
- Modify: `E:\Obsidian仓库\Codex跨项目永久记忆\02-项目\OpenBidKit飞书联动.md`
- Modify: `E:\Obsidian仓库\Codex跨项目永久记忆\04-每日记录\2026-09-16.md`
- Runtime only: ignored `.env`, SQLite backup, live receipts under ignored testfiles.

**Interfaces:**
- Consumes all prior tasks.
- Produces deployed service, replayed latest file, and redacted acceptance evidence.

- [ ] **Step 1: Run focused and complete automated validation**

Run from `integrations/feishu`:

```powershell
node --test test/group-file-source.test.cjs test/config.test.cjs test/preread.test.cjs test/document-recovery.test.cjs test/lark.test.cjs test/card-main.test.cjs test/runner.test.cjs test/integration.test.cjs test/production-check.test.cjs
npm test
```

Expected: all tests pass; environment-dependent skips remain explicitly reported and no test fails.

- [ ] **Step 2: Run syntax and diff checks**

```powershell
node --check group-file-source.cjs
node --check group-file-replay.cjs
node --check main.cjs
node --check runner.cjs
git diff --check
```

Expected: all exit 0.

- [ ] **Step 3: Back up runtime state and configure production**

Copy the current SQLite database and `.env` to timestamped ignored backup paths. Set the enabled flag, authorized user profile, start time immediately before the known message, exact allowed extensions, and 30 MiB limit. Do not store private values in Git or console output.

- [ ] **Step 4: Restart only the OpenBidKit service and verify gates**

Use the existing controlled deployment scripts to restart `OpenBidKitFeishu`. Confirm the legacy listener task remains disabled, the preread compute containers remain healthy, `/ready` reports production with no missing item, and production check reports all checks passed.

- [ ] **Step 5: Replay the known latest PDF once**

Resolve the latest previously observed member PDF from the formal group history without printing its identifiers. Run the replay command with those exact values. Verify a single receipt status card appears within 30 seconds and advances through download, recognition, preread, and completion or a concrete safe failure stage.

- [ ] **Step 6: Verify downstream artifacts and deduplication**

Read back the status card, final one-eye decision card, archived Feishu document body, and formal-group view permission. Record task count, document count, status-card count, and model-request count; restart the service and replay the same message again; confirm all four counts remain unchanged.

- [ ] **Step 7: Record redacted acceptance and commit**

Update `docs/feishu-acceptance.md` with behavior, tests, production-check count, and live result while excluding IDs, tokens,正文, and private receipts. Update the project memory and daily timeline with the same traceable, non-sensitive result.

```powershell
git add docs/feishu-acceptance.md
git commit -m "docs: accept formal group file ingress"
```

- [ ] **Step 8: Final verification before completion**

Run `git status --short`, `git log -10 --oneline`, the full Feishu test suite, production check, and `/ready` once more. Completion requires a clean repository, passing tests, production ready state, one live file result, and no duplicate after replay/restart.
