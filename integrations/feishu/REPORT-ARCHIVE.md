# 飞书预读报告持续归档

启用后，每次后台 tick 从现有项目读取预读服务的 `GET /openapi/preread/tasks/:taskId/knowledge-publication`。沿用 relay Bearer 身份；不调用模型，也不重跑预读。接口提供正式 Markdown、内容哈希和来源摘要。只有内容哈希、文档版本、来源 SHA-256 和随后读取的 handoff 报告 ID、`snapshot.reportVersion` 一致时才发布。同一个报告 ID 的 r2/r3 也视为不同快照，旧卡片链接会立即撤销。

## 配置

先在飞书创建或选定已获授权的归档文件夹，核实其没有公开分享，再配置：

```dotenv
BID_REPORT_ARCHIVE_ENABLED=true
BID_REPORT_FOLDER_TOKEN=<已授权文件夹token>
BID_REPORT_ALLOWED_FOLDER_TOKENS=<同一token>
BID_REPORT_CLI_PROFILE=<已授权的CLI profile>
BID_REPORT_CLI_IDENTITY=bot
```

`BID_LARK_CLI_PATH` 必须是 CLI 可执行文件绝对路径。身份可以显式选择 `bot` 或 `user`，不会在遇到权限错误后切换身份。沿用服务的 `BID_CHAT_ID` 和 `BID_TEST_CHAT_IDS`，仅在 `BID_DELIVERY_MODE=test` 且目标群和目标文件夹都通过白名单时运行。文件夹由运维预先创建，本模块不自动选择根目录或创建文件夹。

## 发布和恢复

- `drive +import --type docx` 将 Markdown 串行导入指定文件夹；标题包含文档版本和内容哈希前八位。报告内容变化生成新的版本文档，旧版本保留。
- 导入完成后，仅添加指定群的 `openchat/view` 协作者权限，并用 `drive +member-list` 读回验证；不修改公开分享档位。CLI 在 bot 导入时可能按其既有行为给当前登录用户附加管理权限。
- 群权限验证完成才将 `reportUrl` 和 `reportArchive` 绑定到当前项目，并更新已有卡片。报告内容变化或来源验证失败先移除原链接。纯归档链接变化不会清除已有跟进决策或触发标书模型。
- 原始 Markdown 保存在 `BID_DATA_ROOT/reports`；每个版本的状态、内容、目的地和导入结果保存在同一 `workflow.sqlite3` 的 `report-archive-job:*`。该数据库是幂等记录，部署迁移时必须保留，不能清空后重新启用。
- 已知 ticket 持续查询原任务。未知导入结果或进程在导入阶段中断会转为 `manual/report_import_unknown`，禁止自动再次创建，并阻止向同一目的地开始后续导入。错误文本仅存固定错误码，不存 CLI 错误原文。
- 升级前缺少 `reportVersion` 的同源任务会阻止新的导入，检查状态显示 `report_version_unverified`。运维必须根据独立核实的旧报告版本为原 SQLite job 补记 `reportVersion`（例如已核实的 `r2`）；模块不猜测该值。补记后完整身份相符的任务保留原 job ID、文档 token、文件和阶段，继续授权/验证，不会因新幂等 key 重复导入。
- 权限写入失败也保留已有文档，通过读回确认是否已成功。无法核验则停在 `manual/report_permission_unverified`，不展示卡片链接。

仅供持有 runner 租约的本地运维恢复（不暴露 HTTP 写接口）：

```js
// app.runner.acquire() 成功后；先在同一身份下核实目标位于授权文件夹，属于该内容版本。
app.reportArchive.reconcileImport(jobId, { ready: false, ticket: verifiedTicket });
// 或使用已经核实的最终 docx 结果，随后仍会完成群授权与验证。
app.reportArchive.reconcileImport(jobId, { ready: true, token: verifiedToken, url: verifiedUrl });
// 运维修复原文档 ACL 后，只读重新核验，绝不新建文档。
app.reportArchive.recheckPermission(jobId);
await app.reportArchive.tick();
```

`app.reportArchive.list()` 返回本地完整记录（包含报告正文），用于本地审核。日志和状态汇报只选取 `id/stage/error/token/url/contentHash` 等必要字段。旧服务的发布确认要求 Wiki `spaceId/nodeToken`，本归档是 Drive docx，因此不向旧 Wiki 发布记录伪填 token；卡片链接以本服务经过核验的持久记录为准。

验证：`node --test --test-concurrency=1 integrations/feishu/test/report-archive.test.cjs`，所有远端调用均为替身，不创建真实文档、不调用模型。
