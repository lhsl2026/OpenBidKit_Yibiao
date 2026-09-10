# OpenBidKit 飞书判标生产化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成公司证据结构化、关键商务字段、真实标书流程验收和正式群常开部署准备。

**Architecture:** 本地 BidVault 保持权威和只读，由飞书集成层生成保守公司画像并同步给预读服务；判标卡读取与报告版本绑定的结构化商务证据。真实写标使用独立验收任务，生产切流使用单独白名单和显式门禁。

**Tech Stack:** Node.js CommonJS、Node test、SQLite、NestJS/TypeScript、PostgreSQL、Docker Compose、Electron、Codex CLI、飞书 OpenAPI/lark-cli。

**Spec:** `docs/superpowers/specs/2026-09-10-production-readiness-design.md`

## Global Constraints

- 判标主体只能是“隆创信息有限公司”，不得混用异名主体。
- 未核验资料必须显示待核实，不能推断满足。
- 不自动报价、签章或提交投标。
- 真实流程验收不得写入公司投标决定。
- 飞书外部写入仅限已授权测试群，正式切流使用独立门禁。

---

### Task 1: 公司证据画像

**Files:**
- Create: `integrations/feishu/company-evidence.cjs`
- Create: `integrations/feishu/test/company-evidence.test.cjs`
- Modify: `integrations/feishu/preread.cjs`
- Modify: `integrations/feishu/main.cjs`
- Modify: `integrations/feishu/config.cjs`
- Modify: `integrations/feishu/.env.example`

- [x] 以已核验/未核验业绩、人员证书和异名主体编写失败测试。
- [x] 实现确定性公司画像、覆盖统计和哈希版本。
- [x] 实现带幂等状态的预读画像导入，失败时 readiness 保守降级。
- [x] 在本机配置启用同步，确认预读数据库只保留目标主体并回读统计。
- [x] 提交公司证据画像改动。

### Task 2: 商务字段提取和卡片绑定

**Files:**
- Create: `integrations/feishu/decision-facts.cjs`
- Create: `integrations/feishu/test/decision-facts.test.cjs`
- Modify: `integrations/feishu/report-archive.cjs`
- Modify: `integrations/feishu/decision-brief.cjs`
- Modify: `integrations/feishu/test/report-archive.test.cjs`
- Modify: `integrations/feishu/test/decision-brief.test.cjs`
- Modify: `server/modules/preread/preread-parser.service.ts` in the isolated preread checkout
- Modify: corresponding preread parser tests and exported compatibility patch

- [x] 编写预算带单位括号、付款、投标/履约保证金、评分未闭合的失败测试。
- [x] 从 `knowledgeContent` 生成带证据状态的决策字段，并绑定精确报告版本。
- [x] 让卡片和归档文档优先使用决策字段，缺失保持待核实。
- [x] 修复预读预算格式兼容，导出补丁、运行 Jest 与构建。
- [x] 重建预读镜像并回读两个真实项目的关键字段。
- [x] 提交商务字段改动。

### Task 3: 真实标书全流程验收

**Files:**
- Create: `integrations/feishu/real-writing-acceptance.cjs`
- Modify: `docs/feishu-acceptance.md`

- [ ] 用真实招标文件和当前 handoff 建立隔离验收任务。
- [ ] 逐阶段保存目录、事实和失败小节决策确认，未知事实保留占位。
- [ ] 生成并检查 DOCX 结构、标题、章节和验收标识。
- [ ] 投递测试群并回读文件消息；记录哈希与消息收据。
- [ ] 提交真实写标验收工具和记录。

### Task 4: 常开部署和正式群门禁

**Files:**
- Modify: `integrations/feishu/config.cjs`
- Modify: `integrations/feishu/supervisor.cjs`
- Modify: `integrations/feishu/deployment/README.md`
- Create: `integrations/feishu/deployment/production-check.cjs`
- Modify: `integrations/feishu/test/config.test.cjs`

- [ ] 编写生产群白名单、显式切流标志和测试/生产隔离的失败测试。
- [ ] 实现生产启动检查与只读诊断命令。
- [ ] 核对正式目标群和常开执行账户条件。
- [ ] 安装或更新监管任务并验证重启恢复。
- [ ] 在正式群发送单条上线验证卡并回读；失败则恢复测试配置。
- [ ] 运行完整验证、更新验收记录并提交。
