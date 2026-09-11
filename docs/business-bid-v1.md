# 商务标第一版使用与验收

本版面向隆创信息有限公司，输出供人工审核的商务标草稿。入口为易标工具箱的“商务标”。

## 使用流程

1. 上传或追加招标文件。解析方式沿用客户端设置，支持查看解析原文；同文件重传可以修复原文缓存。
2. 选择本商务标使用的模型（配置完整的 Codex/DeepSeek 等），提取商务要求。长文件分段处理，五类结果均保留文件、片段和逐字原文依据。失败时仅保留部分结果，不能确认；重新提取会清除旧结果和下游草稿。
3. 核对商务目录、资格要求、废标项、表单字段和商务条款，勾选人工确认。填写项目及商务字段后保存；报价字段禁用，生成时仍强制留空。
4. 导入公司证据库快照，查看候选材料及原件。只有主体归属、核验标记和原件完整性均通过的材料可选，员工逐条勾选并关联资格要求。关键词匹配只推荐候选，不认定满足投标条件。
5. 生成草稿，预览并分别导出整本 DOCX、待补清单 DOCX。任何影响草稿的输入变化都会使旧草稿失效，重新生成后导出。

## 公司证据库快照接口

沿用 `integrations/feishu/company-evidence.cjs` 使用的 `records` 台账结构。客户端不依赖集成目录，不访问飞书凭证或生产数据库；从“导入公司证据台账”选择本地 JSON。

- 顶层 `records` 为材料数组。记录保留 `id`、`kind`、`name`、`companyId`、`verified`、`attachments`。
- `kind` 支持 `performance`、`qualification`、`company_certificate`、`certificate`。每条材料编号唯一。
- `companyId` 必须准确等于 `隆创信息有限公司`，`verified` 必须是布尔 true。其他明确主体排除，无归属或未核验材料只显示待核实。
- 每个附件需要 `relative_path`、`sha256`、布尔 `verified: true`。`relative_path` 相对于所选 JSON 所在目录；从既有附件库导出快照时须一并整理附件路径。只修改名称或勾选客户端不能把待核实材料变成已核实。
- 证书使用 `expires_on: YYYY-MM-DD`，或 `permanent: true/1`。按上海当前日与人工填写的投标截止日较晚者核对有效期。
- 人员 `certificate` 额外要求顶层 `employmentEvidence[人员姓名]`，其中包含相同公司 `companyId`、`verified: true` 和可核验的 `attachments`。没有任职归属原件的人员不能选用。
- 已核验附件会复制到本地商务标工作区，生成和导出时再次检查原文及所选附件哈希；不把企业资料、私人台账、凭证或真实消息写入 Git。

## 本版输出边界

草稿含投标函、法定代表人身份证明、授权书、资格对照、资质/人员/业绩索引、商务偏离表、政策声明、招标表单字段、报价表结构、废标项复核表及待补清单。

公司事实以人工填写或经核验后人工选用的台账材料为来源。未确认的材料不会进入正文；缺失内容标为“待核实”。默认不声明无偏离，不认定政策身份、不自动承诺满足条件。模型只提取要求，正文由确定性模板组装。

本版 DOCX 的资质/人员/业绩章节包含材料索引与核验信息，**不会自动装订 PDF 扫描附件或精确复刻招标原始表单版式**。原件/扫描件装订、格式核对均进入待补清单。报价填写和核算、签字盖章、最终提交必须人工完成。

后台提取在 Main 中持续运行，离开页面后不会取消。处理期间禁止修改工作区；重启后的中断任务标为失败，重新提取。业务状态存 SQLite v25，原文和附件副本位于 `userData/workspace/business-bid`。开始新项目清除业务索引，保留已经导出的文件。

## 可重复验收

在 `client/` 下执行：

```powershell
node --test electron/services/businessBidDomain.test.cjs electron/services/businessBidTask.test.cjs electron/services/aiService.modelSelection.test.cjs
npm run build
npm run smoke:electron-native
.\node_modules\.bin\electron.cmd scripts/business-bid-smoke.cjs
```

页面验收在一个终端启动 Vite，另一个终端启动隔离 Electron：

```powershell
.\node_modules\.bin\vite.cmd --host 127.0.0.1 --port 5173 --strictPort
# 第二个终端，同样位于 client/
$env:BUSINESS_BID_SMOKE_OUTPUT = 'E:\WorkSpaces\OpenBidKit_Yibiao\testfiles\business-bid-v1'
$env:BUSINESS_BID_SMOKE_UI_URL = 'http://127.0.0.1:5173/scripts/fixtures/business-bid-smoke.html'
.\node_modules\.bin\electron.cmd scripts/business-bid-smoke.cjs
```

脚本使用独立临时 userData、真实 SQLite/文件解析/任务服务/preload/IPC/页面/DOCX，模型响应为合成 fixture，不调用真实模型、不发送飞书消息。实际产品全窗口的许可证、设置和侧边栏不是此脚本的验收范围。

## 2026-09-11 验收记录

- 15/15 聚焦测试通过：归属、附件哈希、人员任职、证书日期与长期证照、同名字段保留、模型结构与引用、长文分段、失败和取消、报价留空、模型选择。
- 隔离 Electron 页面验收 38 项通过，合成模型 fixture 调用 2 次。覆盖新建 v25、v24 升级保留数据、后台互斥、持久化恢复、页面确认及生成、报价禁用、DOCX 导出、内部滚动、重置确认、原文/附件变化阻断、同文件重传恢复。
- `npm run build` 与 native smoke 通过；改动 CJS 语法检查、`git diff --check` 通过。构建只有既有 chunk 体积警告。首次构建曾因系统提交内存不足失败；内存恢复后原命令通过。
- 两份合成 DOCX 已回读正文并通过本机 Office/WPS COM 转 PDF 检查；共 8 页。商务表格启用整行分页、续页重复表头及标题跟随正文。工具要求的 LibreOffice 本机不可用，因此采用本机 Word 兼容渲染接口。
- 独立代码审查的同名字段丢失、模型结构过宽、长期证照类型、日期时区及重复导入恢复问题均已修复并增加回归验证。
- 合成输出与截图保存在 Git 忽略的 `testfiles/business-bid-v1/`；它们仅用于功能验收，不代表真实公司投标文件已完成。未调用真实招标文件模型，真实招标格式和材料装订仍需员工实际项目复核。
