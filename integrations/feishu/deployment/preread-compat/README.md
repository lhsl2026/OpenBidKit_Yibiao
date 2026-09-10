# Preread consumer compatibility repair

Consumer base: `073580fb496ee5a796329174687afe3912c0f2ff`.
Isolated source: `E:/WorkSpaces/preread-codex-compat-20260910`.
The original runtime checkout and dirty platform checkout were only read. No provider calls, live retries, environment changes or live database writes were performed by this patch workflow.

## Apply and build

Create a clean checkout/worktree at the base commit, then run from that checkout:

```powershell
git apply --check E:/WorkSpaces/OpenBidKit_Yibiao/.worktrees/feishu/integrations/feishu/deployment/preread-compat/consumer.patch
git apply E:/WorkSpaces/OpenBidKit_Yibiao/.worktrees/feishu/integrations/feishu/deployment/preread-compat/consumer.patch
npm ci --ignore-scripts
npm run build:standalone:server
docker build -f Dockerfile.standalone -t local/preread-agent:codex-compat-20260910 .
```

Build and deploy only `consumer.patch`. `provider-prompt.future.patch` is separately reviewable producer guidance, **not included in this deployment**: changing producer prompts changes bridge request hashes and prevents replaying already-paid outputs. Its normalized source SHA-256 and patch SHA-256 are recorded in `manifest.json`.

## Behavior

On this 16 GB Windows host the full dependency-install build interrupted Docker Desktop. Since this patch changes no dependencies, the live image is instead built with `Build-CompatImage.ps1 -ConsumerRoot <compiled-consumer-checkout>`, inheriting the existing Linux runtime/dependencies and copying the separately compiled `dist`. The script records both base and result image IDs. Original images and data are retained. An additional regression check rejects inherited JavaScript object keys as category aliases; the six compatibility tests and a fresh Nest build passed after that review fix.

- Numeric page strings normalize to numbers. Ranges and lists retain their literal locator in `section`, omit a single `page`, and cap confidence at `0.79`. Missing sections are explicitly marked `章节待核实`; malformed records without statement/quote/confidence still fail. Invalid numeric fractional coordinates remain rejected.
- Old statement/quote records receive minimal qualification/commercial/redline structures without invented booleans or thresholds. Unknown mandatory/supplementability stays absent; reports show `待核实`, and recommendations stay cautious.
- Only exact category aliases `价格→price`, `技术→technical`, `商务→commercial` are supported. `主观分` and `客观分` never imply technical/commercial. Batch merge moves unknown-category, unknown-score, and excluded score-table rows into `待确认事项`; original statement/quote and raw scoring metadata remain available. These rows appear in manual review items, and never produce an invented total of 100.
- Existing ordinary retry/job behavior is unchanged.

## Operational cache replay endpoint

`POST /openapi/preread/tasks/:taskId/replay-compatible-extraction`

Body: `{ "documentId": "<existing document UUID>" }`. It uses the existing relay authorization guard and validated DTO; extra properties are rejected. It calls the original `PrereadParserService.retryFactExtraction(taskId, documentId)` inline path, including its persisted-text loading, retry state guards, report preparation and atomic finalization. Before responding, it passes the committed report to `captureFinalizedReport` so the handoff reflects the restored findings. It returns `{ extraction, report? }`. It does not create a deferred extraction job, upload a file, or send messages.

The handoff capture does not prepare, save, or replace the report again. A corrected report may retain its database report ID and document version; the existing handoff store appends a new immutable `reportVersion` (`r1` → `r2`). The OpenBid confirmation gate checks that version and rejects an old visible card. Follow-up validation covered the actual ReportService → HandoffService → HandoffDatabaseStore chain: changed contents under the same report/document IDs produced a newer version and new requirements, with the earlier snapshot unchanged. Report/controller/store tests and the OpenBid stale-card regression passed. No database schema change is required.

This route is for operational compatibility repair. Before replaying paid outputs, route the model provider to the bridge's **cache-only** completions endpoint. A cache miss must fail without starting a model execution. Retain the original producer prompts/model parameters. The inline path uses the original business/technical/score chunks; the ordinary deferred job additionally generates requirements chunks and is therefore unsuitable for a guaranteed zero-new-request replay.

## Verification

The standalone Nest build (including TypeScript checking) passed. Focused suites: parser/metadata/merge/report **164 passed**, relay controller **60 passed**, bid-manager/renderer **19 passed**. The controller suite includes authenticated inline replay, returned finalized report, guard rejection, invalid document IDs and extra DTO fields. Earlier persistence/report service suites also passed. Because the host ran out of memory with whole-program ts-jest, the repeatable low-memory test configuration is provided; type checking remains a separate build step.

From the isolated checkout:

```powershell
node node_modules/jest/bin/jest.js --config E:/WorkSpaces/OpenBidKit_Yibiao/.worktrees/feishu/integrations/feishu/deployment/preread-compat/jest-compat.config.cjs --runInBand server/modules/preread/preread-codex-compat.spec.ts server/modules/preread/preread-parser.service.spec.ts server/modules/preread/preread-structured-metadata.spec.ts server/modules/preread/preread-knowledge-report.spec.ts server/modules/preread/preread-relay.controller.spec.ts
node E:/WorkSpaces/OpenBidKit_Yibiao/.worktrees/feishu/integrations/feishu/deployment/preread-compat/replay-cache.cjs E:/WorkSpaces/preread-codex-compat-20260910 E:/WorkSpaces/OpenBidKit_Yibiao/integrations/feishu/data/workflow.sqlite3
```

`replay-cache.cjs` opens SQLite read-only and executes actual compiled normalizers, **actual batch merge**, finding conversion, report building and Markdown rendering. It hashes stored cache rows before/after and prints only counts and non-sensitive metadata. `replay-summary.json`: 12 chunks passed; 193 normalized and 193 merged records retained; 21 score records preserved for review; exact price category restored as one 30-point item; report has 12 qualifications, 18 redlines, 31 contract, 3 compliance and 14 delivery/service requirements. Quality remains `待复核`, recommendation `暂缓`. Provider calls: **0**. Raw cache unchanged.

`export-patches.cjs` reproduces the patch/manifest from the isolated dirty consumer checkout and read-only original provider prompt source. It writes only to this compatibility artifact directory.

## LED score-output follow-up

The 19 cache entries created from `2026-09-10T06:19:00Z` had four rejected score chunks: 11 records used qualitative confidence text, 14 score-method records omitted confidence, and two records used page arrays. All statement/quote fields were present; the nine fact chunks already passed.

The compatibility fallback is limited to score output. Missing/null/textual nonnumeric confidence is preserved literally with a `待核实` marker and assigned the conservative numeric lower bound `0`. This does not interpret “高” as a probability. Numeric out-of-range confidence, invalid numeric coordinates, missing statement/quote, and malformed container types still fail. Page arrays remain literal JSON in the source locator, omit a single page, and cap confidence at `0.79`. Supplemental `rule`, `procedure`, and `evidenceRequirement` values remain verbatim in the source section. Unconfirmed score methods move to the manual-review channel. Existing handoff capture and exact-category aliases remain intact.

`led-replay-summary.json` was produced through the real compiled normalizers, batch merge, finding conversion and report builder: **19/19 chunks, 263/263 normalized records**, then **262 merged records plus one exact duplicate** (all fields identical). Eighteen score records remain pending, with no inferred score category or total. Qualifications 14, redlines 15, contract requirements 35, compliance 4, delivery/service 6; recommendation remains `暂缓` and quality `待复核`. Original bridge cache values are unchanged and provider calls remain zero. Parser/compat tests: **95 passed**; standalone build passed.

To reproduce that specific offline assertion, append the cutoff to the existing replay command:

```powershell
node E:/WorkSpaces/OpenBidKit_Yibiao/.worktrees/feishu/integrations/feishu/deployment/preread-compat/replay-cache.cjs E:/WorkSpaces/preread-codex-compat-20260910 E:/WorkSpaces/OpenBidKit_Yibiao/integrations/feishu/data/workflow.sqlite3 E:/WorkSpaces/OpenBidKit_Yibiao/.worktrees/feishu/integrations/feishu/deployment/preread-compat/led-replay-summary.json 2026-09-10T06:19:00Z
```

`diagnose-cache.cjs` provides read-only per-chunk schema diagnostics for the same cutoff, printing field types/counts and locator/confidence values rather than private source text.
