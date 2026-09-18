# 公告附件部分预读与完整文件自动升级 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 自动利用唯一可信采购需求 PDF 生成安全的部分预读，并在完整招标包公开后自动升级。

**Architecture:** 贵州来源适配器区分完整包与部分附件，OpenBidKit 恢复作业持久化附件类别并进入轮询状态；预读底座允许 `announcement_attachment` 解析为 `partial`，同时保留人工补传动作并阻止写标交接。完整文件沿既有 `tender_document` 流程覆盖升级。

**Tech Stack:** Node.js 22、`node:test`、NestJS、Jest、SQLite/PostgreSQL、飞书开放平台长连接与云文档归档。

**Spec:** `docs/superpowers/specs/2026-09-18-partial-document-recovery-design.md`

## Global Constraints

- 公告附件永远不能声明为完整招标文件或解锁标书初稿。
- 仅接受唯一、HTTPS、可信主机、20 MiB 以内、PDF 头尾有效的公告附件。
- 不明远程写结果不得自动重试。
- 公司证据主体限定为隆创信息有限公司。

---

### Task 1: 贵州来源适配器

**Files:**
- Modify: `integrations/feishu/guizhou-source.cjs`
- Test: `integrations/feishu/test/guizhou-source.test.cjs`

**Interfaces:**
- Produces: `recover()` 返回 `obtained | partial_obtained | manual`。

- [ ] 写唯一可信 PDF 返回 `partial_obtained` 的失败测试。
- [ ] 写多附件、非 PDF、未知域名、重定向、超限和 PDF 签名失败测试并确认失败。
- [ ] 实现附件解析、下载、校验、中文用途文件名和 SHA-256。
- [ ] 运行来源适配器测试并确认通过。

### Task 2: 持久化监控与完整文件升级

**Files:**
- Modify: `integrations/feishu/document-recovery.cjs`
- Test: `integrations/feishu/test/document-recovery.test.cjs`

**Interfaces:**
- Consumes: `partial_obtained` 和 `obtained`。
- Produces: `monitoring` 作业；接入候选的 `officialCategory` 精确对应附件类别。

- [ ] 写部分附件上传、禁止绑定写标原文、重复附件幂等和完整包升级的失败测试。
- [ ] 实现类别持久化、监控退避和升级状态流。
- [ ] 运行恢复器测试并确认通过。

### Task 3: 预读部分附件执行路径

**Files:**
- Modify: `server/modules/preread/preread-workflow.service.ts`
- Modify: `server/modules/preread/preread-document-acquisition.service.ts`
- Modify: `server/modules/preread/preread-manual-document.service.ts`
- Modify: `server/modules/preread/preread-relay.controller.ts`
- Test: corresponding `*.spec.ts` files

**Interfaces:**
- Produces: acquisition result exposes `completeTenderDocument`; incomplete attachment parses to `partial` while manual action remains open。

- [ ] 写公告附件解析、部分报告、人工动作保留、禁止五模块交接和完整文件升级的失败测试。
- [ ] 实现 parseable/complete 两个独立判断及 action 生命周期。
- [ ] 运行聚焦 Jest、类型检查并确认通过。

### Task 4: 部署与真实验收

**Files:**
- Update: deployment receipt and project documentation as appropriate.

**Interfaces:**
- Consumes: OpenBidKit recovery worker and preread API/worker images.
- Produces: 飞书部分报告、云文档归档、持续监控作业和完整升级能力。

- [ ] 备份 OpenBid SQLite 和目标预读记录。
- [ ] 构建并部署预读镜像，安全重启 OpenBid 常开任务。
- [ ] 恢复当前 `document_provider_manual` 作业并运行至 `monitoring`。
- [ ] 回读飞书卡片与文档，验证部分标识、待核实项和监控状态。
- [ ] 运行完整回归、生产预检并推送相关仓库。
