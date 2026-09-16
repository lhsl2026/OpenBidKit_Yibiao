# Business Bid Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fixed commercial-bid skeleton with a model-generated, source-grounded, coverage-audited editable draft.

**Architecture:** Keep the existing extraction and evidence pipeline. Add a managed generation task that builds bounded source packets, invokes dedicated professional prompts, validates model JSON, merges generated chapters, and appends deterministic coverage and pending-item tables before persisting the draft.

**Tech Stack:** Electron CommonJS services, React/TypeScript renderer, Node test runner, existing `aiService`, existing DOCX export service.

**Spec:** `docs/superpowers/specs/2026-09-16-business-bid-rewrite-design.md`

## Global Constraints

- Preserve company isolation, evidence hashes, expiry checks, source quotations, template export, and current workspace data.
- Never generate prices, signatures, seals, or unverified qualification claims.
- Use the business bid's selected local ChatGPT text model.
- No new runtime dependency.

---

### Task 1: Prompt and packet contract

**Files:**
- Modify: `client/electron/services/businessBidPrompts.cjs`
- Create: `client/electron/services/businessBidGeneration.cjs`
- Create: `client/electron/services/businessBidGeneration.test.cjs`

**Interfaces:**
- Produces: `buildBusinessDraftPackets(state)`, `normalizeGeneratedPart(payload, packet)`, `mergeGeneratedParts(state, parts)`.

- [ ] Write failing tests for bounded packets, exact coverage IDs, forbidden price/signature text, and local placeholders.
- [ ] Run `node --test electron/services/businessBidGeneration.test.cjs` and confirm the expected failures.
- [ ] Implement the prompt builders and deterministic packet/validation helpers.
- [ ] Run the focused test and confirm it passes.

### Task 2: Managed AI generation task

**Files:**
- Create: `client/electron/services/businessBidGenerationTask.cjs`
- Create: `client/electron/services/businessBidGenerationTask.test.cjs`
- Modify: `client/electron/services/taskService.cjs`

**Interfaces:**
- Produces: `runBusinessBidGenerationTask(context)` and `taskService.startBusinessBidGeneration()`.

- [ ] Write a failing task test using a deterministic fake AI service and real merge helpers.
- [ ] Run the focused test and confirm missing runner behavior fails.
- [ ] Implement sequential packet generation, progress checkpoints, and final draft persistence.
- [ ] Register the task, recovery behavior, and start validation.
- [ ] Run both business generation tests.

### Task 3: Store, IPC, and renderer workflow

**Files:**
- Modify: `client/electron/services/businessBidStore.cjs`
- Modify: `client/electron/ipc/businessBidIpc.cjs`
- Modify: `client/electron/preload.cjs`
- Modify: `client/src/features/business-bid/types.ts`
- Modify: `client/src/features/business-bid/pages/BusinessBidPage.tsx`

**Interfaces:**
- Changes `businessBid.generate()` to return a managed task and exposes `generationTask` in workspace state.

- [ ] Extend store tests so mutations clear generated drafts and interrupted generation is recoverable.
- [ ] Route Generate through `taskService.startBusinessBidGeneration()`.
- [ ] Show generation progress and update copy to describe professional draft generation.
- [ ] Run service tests and `npm run build`.

### Task 4: Full verification and sample review

**Files:**
- Modify: `docs/superpowers/specs/2026-09-16-business-bid-rewrite-design.md` only if verified behavior differs.

- [ ] Run all business bid tests with `node --test electron/services/businessBid*.test.cjs`.
- [ ] Run `npm run build`.
- [ ] Generate a deterministic sample draft through the task test fixture and inspect every chapter, coverage row, pending item, and forbidden field.
- [ ] Review `git diff --check` and `git status --short` before integration.
