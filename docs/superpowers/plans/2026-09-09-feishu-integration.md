# 飞书判标与易标编写 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 接入既有预读 handoff 与只读台账，持久化判标、群卡决策、每日摘要和按项目隔离的易标编写任务。

**Architecture:** 新增 integrations/feishu 独立 Node 服务，通过 HTTP 读取现有预读 handoff，以 node:sqlite 保存本服务的状态和投递 outbox。台账读取采用 SQLite readOnly，业务匹配与卡片投递隔离。编写 Worker 调用 Electron 现有服务，独立 userData，先单并发，不改旧平台的未提交工作区。

**Tech Stack:** Node.js >=22.13（本机24），CommonJS，node:test，node:sqlite，原生 fetch，Electron 41，现有易标服务。

**Spec:** ../specs/2026-09-09-feishu-integration-design.md

## Global Constraints

- 公司资料只能通过只读快照读取，不写原台账；不猜测主体或证据归属。
- 未找到证据不是已满足，也不是明确不满足；需按投标截止日验证。
- handoff 必须保留版本与校验和，旧版本不得触发写作。
- 不在源码或日志保存凭证、真实群 ID 或私人材料。模型未配置时明确未就绪。
- 不新增正式群事件消费者与旧消费者抢占，不擅自切流；真实投递先限定测试群。
- 不为每条标讯自动写整本标书，写作需要员工在飞书确认。
- 公司联动 `globalFactsMode` 固定 `placeholder`。

## Task 1: 只读台账与证据匹配

**Files:** integrations/feishu/vault.cjs, assessment.cjs, test/vault.test.cjs, test/assessment.test.cjs

**Interfaces:** `readVaultSnapshot({databasePath,filesRoot,mappings,companyId})` 返回 `{records, warnings}`；`assessTender({handoff,rules,snapshot,companyId,deadline,now})` 返回 `{decision,items,blockers,actions}`。rules 每项用 requirementId 引用 handoff 中的真实条款，结构化 kind 为 certificate/performance/manual；没有结构化规则的资格条款自动变为待核实。映射必须校验记录更新时间和附件 SHA 后才能作为已核实证据。

- [ ] 写测试：无归属不能满足；证照在截止日前失效；缺件或哈希变化；重复证照不能凑人数；未映射条款待核实；原库字节不变。
```js
assert.equal(assessTender(inputWithoutMapping).decision, 'review');
assert.equal(assessTender(inputWithExpiredOnly).decision, 'review');
```
- [ ] 运行 `node --test integrations/feishu/test/vault.test.cjs integrations/feishu/test/assessment.test.cjs`，先确认失败。
- [ ] 实现只读事务快照、受限附件路径、证据有效性、保守匹配；同条件无有效证据保持 review，明确人工否定才 reject。
- [ ] 重跑测试并自审，记录实际结果。

## Task 2: 持久化判标与飞书操作

**Files:** integrations/feishu/store.cjs, workflow.cjs, card.cjs, lark.cjs, config.cjs, server.cjs, test/workflow.test.cjs, test/lark.test.cjs

**Interfaces:** `createStore(path)` 持久化 projects/actions/outbox/writing_jobs；`createWorkflow({store,assess,card,clock})` 暴露 ingest 和 act；项目输入 `{handoff,companyId,deadline,rules,reportUrl,sourceUrl}`。`createLarkClient({appId,appSecret,fetchImpl})` 提供 sendCard/updateCard/uploadFile/sendFile。服务由内部 Bearer 鉴权接收 handoff，卡片回调必须验证飞书签名与群、操作者白名单。

- [ ] 写重复 handoff、同版本冲突、旧卡点击、未授权操作者、同卡重复写作请求、重启恢复 outbox 和截止后禁写测试。
```js
assert.equal(workflow.ingest(input).id, workflow.ingest(input).id);
assert.throws(() => workflow.act(staleAction), /stale/);
```
- [ ] 运行测试观察缺实现失败。
- [ ] 事务保存项目和 outbox；相同版本校验和不同返回冲突；新版本替代旧版本；只有跟进决定可排写作。投递用稳定 uuid，更新原卡；失败指数退避，日志只输出固定错误码。
- [ ] Card 2.0：结论色标题、项目概况、阻塞与动作、原文链接、跟进/暂缓/不投/生成初稿按钮；敏感台账值不进入群卡。
- [ ] 验证完整服务 HTTP 边界，包括未配置只读 health、未鉴权拒绝和测试群范围。

## Task 3: 按项目隔离的易标编写适配

**Files:** integrations/feishu/writing.cjs, electron-worker.cjs, test/writing.test.cjs

**Interfaces:** `prepareWritingJob({job,root})` 校验 handoff 并生成独立路径；`runWritingJob({job,root,electronPath,clientRoot,modelConfig})` 启动 Electron 子进程。命令阶段为 prepare/outline/content/export，返回状态及产物路径；所有外部输入经过白名单，路径不能逃逸项目目录。

- [ ] 写测试：两个项目不同 userData；无 ready 或 superseded 快照拒绝；输入中的 fabricate 被拒绝/覆盖；不带授权确认的写作不能执行；模型缺配置明确失败。
```js
assert.notEqual(prepareWritingJob(a).userData, prepareWritingJob(b).userData);
assert.equal(prepareWritingJob(a).globalFactsMode, 'placeholder');
```
- [ ] 运行失败测试。
- [ ] 阅读现有 createTaskService/createTechnicalPlanStore/createAiService/exportService 的真实接口，复用服务装配；如某阶段必须人工确认，返回 waiting_confirmation，不自动代答。
- [ ] 运行针对性测试与 Electron 隔离工作区 smoke，验证不会触碰用户桌面工作区。

## Task 4: 接入、轮询补偿、运行与验收

**Files:** integrations/feishu/runner.cjs, preread.cjs, package.json, .env.example, README.md, test/integration.test.cjs, examples/sample.json

**Interfaces:** 受控轮询只读取既有预读 API，持久保存 cursor；不直接扫描群历史。每日摘要按 Asia/Shanghai 日期生成稳定 outbox 项目。runner 单实例租约，服务退出释放资源，周期执行 ingest/outbox/writing 与摘要。

- [ ] 写 HTTP 假预读服务与假飞书端的流程测试，真实 SQLite 和临时文件，无外部消息。
```js
assert.equal(fakeLark.sent.length, 1); // 同消息重复执行后仍一条
assert.equal(reopenedStore.getProject(id).decision, 'follow');
```
- [ ] 根据既有预读 controller 核对查询路径，配置只允许内部主机。未知 API 合同不猜测，提供显式 handoff 推入作为兼容入口。
- [ ] 运行 `node --test integrations/feishu/test/*.test.cjs`；client build/native smoke；说明实际联调条件。
- [ ] 用只读真实台账运行统计探针，不记录正文；缺公司主体、模型或 Wiki 权限时保持待核实与不投递，不伪造真实验收。
- [ ] 完成独立代码审查、修复实际发现，提交实现；记录测试群与正式启用剩余条件。

## 当前外部探针

2026-09-09：Docker 引擎当前未运行；旧部署文件中模型 API Key/model 仍为空，飞书凭证和测试群变量存在但不代表可用。旧平台有未提交改动，本任务不直接覆盖。公司完整名称待用户回复。
