# 商务标第一版实施计划

**Goal:** 完成独立商务标草稿编制和 DOCX 导出闭环。
**Architecture:** Main 解析与受管任务，SQLite 单工作区，确定性模板生成，Renderer 人工确认。
**Tech Stack:** Electron CommonJS、React TypeScript、better-sqlite3、现有 docx 导出。
**Spec:** ../specs/2026-09-11-business-bid-design.md

按用户授权在当前任务顺序执行；不新增业务范围、不操作生产飞书。

- [x] 编写 businessBid 业务聚焦测试：公司归属、原件 SHA256、人员归属、有效期、未确认阻断、报价留空、分析来源核验；运行观察缺失实现导致失败。
- [x] 实现 businessBidDomain.cjs 的 normalizeAnalysis / importEvidence / buildDraft 纯业务逻辑以及 businessBidPrompts.cjs 分段提取提示。
- [x] 实现 businessBidStore.cjs，增加 schema v25 与目标 SQL；测试失效、恢复及中文路径。
- [x] 将 business-bid-analysis 接入 taskService，增加 businessBidIpc/preload/type 并复用导出。
- [x] 替换 BusinessBidPage，完成模型选择、上传、分析确认、表单编辑、材料选择、预览和导出。
- [x] 运行 CJS 检查、聚焦测试、build、native smoke 和隔离 Electron 验收；记录结果及第一版限制。
