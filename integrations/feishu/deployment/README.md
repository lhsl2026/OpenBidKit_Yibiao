# 飞书服务监管（Windows）

`supervisor.cjs` 只监管本目录的 `main.cjs`，不修改业务数据。需要 Node.js 22.13+、允许执行这些脚本的 Windows PowerShell 或 PowerShell 7，以及已配置的私有 `.env`。登录启动由独立的 `Install-FeishuTask.ps1` 注册。

## 启动与停止

在 `integrations/feishu` 下运行：

```powershell
& (Get-Command node.exe).Source --env-file-if-exists=.env (Resolve-Path ./supervisor.cjs).Path run
```

这条命令持续运行直到停止。使用绝对 Node/脚本路径，供停止脚本核对进程身份。等价的简单 PowerShell 入口：

```powershell
./deployment/Start-Feishu.ps1 -NodePath 'C:/path/to/node.exe'
```

可选 `-EnvironmentFile 'E:/private/feishu.env'` 和 `-DataRoot 'E:/private/feishu-data'`；停止时使用相同参数。路径可以作为参数，凭证内容不能作为参数。启动入口在当前终端前台运行；如果需要无人值守隐藏运行，由后续任务调度配置启动该入口或直接启动 Node。监管器创建的 main 子进程始终设置 `windowsHide: true`，不弹新窗口。

```powershell
./deployment/Stop-Feishu.ps1 -NodePath 'C:/path/to/node.exe'
```

停止脚本核对 PID 创建时间、Node 可执行路径、入口脚本、数据根及实例标识，然后通过控制管道请求停止。不会按进程名结束其他 Node。监管器意外退出后，停止脚本可在取得同一内核锁后清理确切匹配的遗留 main 进程。身份不符、权限不足或无法确认结束时会报错并保留记录，不能强行改 PID 文件来跳过检查。

只读状态（不含凭证）：

```powershell
node --env-file-if-exists=.env supervisor.cjs status
node --env-file-if-exists=.env supervisor.cjs describe
```

## 行为边界

- Windows 命名管道充当同数据根的内核级单实例锁；进程退出即释放。PID 文件只是身份和恢复记录，不用不可靠的“文件存在”判定进程存活。Linux 测试环境使用同等生命周期的 abstract Unix socket；部署脚本仅面向 Windows。
- 默认每 5 秒检查本机 `/health`，单次超时 3 秒。启动连接等待窗口为 90 秒，构造配置不允许小于 70 秒；启动期间健康接口可响应，不等待台账扫描完成才监听。
- `/health` 返回 503（服务失去所有权）会停止当前 main 进程树；其他连续三次健康失败在已健康或启动窗口结束后触发相同处理。确认旧主进程结束后至少间隔 3 秒才启动替代进程。
- 不把 `/ready` 的 503 当作进程故障。模型、资料、权限尚未配置不会导致监管器反复重启。
- 监管器不写 writing_jobs，也不调用重试动作。主进程意外结束时，既有 runner 把原 running 任务恢复为 interrupted，仍需人在卡片核对后明确重试；监管器不会自动重跑收费模型任务。
- Windows 没有与 POSIX 完全等价的优雅 SIGTERM；受控停止使用经过身份核验的 `taskkill /PID ... /T /F`，包含当前 main 的 Electron 子进程。业务进程或监管器自身异常终止后，历史运行中的任务依靠 interrupted 策略恢复。已经发出的模型请求不能由监管器撤回。

## 卡片长连接

设置 `BID_CARD_SOURCE_ENABLED=true`、绝对可执行文件路径 `BID_LARK_CLI_PATH`，以及本应用专用的 `BID_CARD_CLI_PROFILE`。卡片消费者固定使用 bot 身份，不能与另一个应用共用错误的 profile。`BID_CHAT_ID` 和 `BID_OPERATOR_IDS` 仍是必须的业务授权边界。

启用后，服务获得 runner 租约才启动 CLI，通过 stderr 的 `[event] ready event_key=card.action.trigger` 标记确认连接，关闭时先关闭消费者 stdin 并等当前动作结束。断线后重连沿用真实 event ID；不会自行重试动作或重跑已中断的收费编写任务。普通卡片继续使用工作流的消息绑定、版本与内容校验。CLI 输入仅保留需要的动作字段；不保存 callback token 或原卡片全文，也不开放免验签 HTTP 接口。

**ready 只确认本地 CLI 已连接，不能证明飞书控制台已开启回调或真实卡片点击已到达。** 必须在本应用控制台开启 `card.action.trigger` 回调，并用授权员工的一次真实点击验证完整链路。未启用长连接时，原 HTTP 回调仍要求 verification token、encrypt key 和操作人配置。长连接启用时不要求这两个 HTTP 验签配置；已有 HTTP 路由的验签规则保持有效。

## 本地文件

正式群文件接入由 `BID_GROUP_FILE_SOURCE_ENABLED` 显式开启，要求独立的已授权用户身份 `BID_GROUP_FILE_CLI_PROFILE`、有效启用时间、当前唯一目标群、内部预读 Relay 和 `BID_MIAODA_APP_ID=app_17agc8m97f2`。默认只接收 PDF、DOC、DOCX，单文件不超过 30 MiB。文件保存到 `BID_DATA_ROOT/group-files` 的内容寻址目录，临时下载目录在成功或确定失败后清理。

启用或恢复时按以下顺序操作：

1. 备份 `workflow.sqlite3` 和私有 `.env`。
2. 保持旧飞书监听计划任务禁用，保持预读计算容器运行。
3. 配置 `BID_GROUP_FILE_*`，重启 `OpenBidKitFeishu`。
4. 检查 `/ready` 不含 `group_file_source`，再运行只读 `production-check.cjs`。
5. 对启用前的指定文件使用 `npm.cmd run replay:group-file -- --chat-id <群ID> --message-id <消息ID>`；不要用扩大时间窗的方式批量重放未知历史文件。

需要回退时只将 `BID_GROUP_FILE_SOURCE_ENABLED=false` 并重启 OpenBidKit。已有文件任务、预读任务、判标卡和归档文档保留，不删除数据库，也不重新启用旧监听器。

正文恢复由 `BID_DOCUMENT_RECOVERY_ENABLED` 显式开启，要求 `BID_MIAODA_APP_ID=app_17agc8m97f2` 和已授权的用户身份 `BID_DOCUMENT_CLI_PROFILE`。只接收预读服务真实返回的 `waiting_upload`、`complete_tender_document_missing` 与 task/action ID，并仅下载已明确给出的贵州官方公告正文。成功下载的 PDF 按 SHA-256 存在 `writing/sources`，每轮只推进一个任务的一个阶段。

上传前持久化 `uploading`，附加正文前持久化 `attaching`。这两个阶段如遇进程中断或结果不明，会转为 `manual`，不会自动重传或重复提交补件。签名 URL 仅用于当次受鉴权请求，不写数据库或日志。源消息编辑会阻止后续步骤；本地正文校验和必须与 handoff 一致，否则编写仍被阻止。

已经实际附加过正文的任务，应在启用自动恢复前，根据可验证的私有收据调用 `seedAttached` 登记原 task/action、document ID、本地正文路径与 SHA-256。本地文件必须在配置的 `writing/sources` 内；未知响应不能作为已附加证据。任务阶段保存在 `document-recovery-job:*`，本地原件绑定保存在 `document-source:<taskId>`，只记录固定诊断码。

所有运行文件在 `BID_DATA_ROOT`（默认 `integrations/feishu/data`）内：

| 路径 | 内容 |
| --- | --- |
| `supervisor.pid.json` | 原子更新的 PID、创建时间、入口和实例标识；正常退出删除 |
| `logs/supervisor.jsonl` | 固定事件码，不记录环境变量或凭证 |
| `logs/main.stdout.log` | main 标准输出，追加保存 |
| `logs/main.stderr.log` | main 标准错误，追加保存 |

当前不自动删除日志；运维应按公司保留策略归档，限制数据目录访问权限。不要把私有 `.env`、数据库和日志提交 Git。

## 登录任务安装

在正式安装目录执行：

```powershell
./deployment/Install-FeishuTask.ps1 -NodePath 'C:/Program Files/nodejs/node.exe' -StartDocker
Start-ScheduledTask -TaskName OpenBidKitFeishu -TaskPath '\'
Get-ScheduledTask -TaskName OpenBidKitFeishu -TaskPath '\'
```

这会注册当前用户登录时运行的 `\OpenBidKitFeishu`，使用有限权限、交互登录身份，不保存密码。安装器默认记录本次运行它的 PowerShell 可执行文件绝对路径；也可传入 `-PowerShellPath 'C:/Program Files/PowerShell/7/pwsh.exe'` 明确指定已有可用的 shell，只接受 `powershell.exe` 或 `pwsh.exe`。它不修改执行策略，也不添加策略绕过参数；选定的 shell 应已能执行这些脚本。

登记的 shell 使用 `-WindowStyle Hidden` 隐藏窗口；同数据根禁止并行实例，失败每分钟重试、最多三次，业务进程由监管器负责恢复。同名任务的动作（包括 shell 路径）、身份、触发器或关键设置不匹配时拒绝覆盖，不会自动迁移已有任务。已有错误动作需经核验后单独修正。

`-StartDocker` 适用于本机预读依赖 Docker Desktop 的部署：先隐藏启动已安装的官方 Docker Desktop，再启动服务；既有容器按照其 restart policy 恢复，预读连接暂不可用时收件箱保留重试。本选项不修改 Docker 的全局自动启动设置，远程预读部署可省略。注销、主机关机或休眠期间不能保证运行；全天无人值守需要迁移到常开主机。

## 生产切流检查

先在 `.env` 中填写 `BID_PRODUCTION_CHAT_ID` 与 `BID_PRODUCTION_CHAT_IDS`，保持 `BID_DELIVERY_MODE=test` 和 `BID_PRODUCTION_CUTOVER=false`。正式群必须是当前企业自建应用可加入的内部群，并与测试群完全分离。执行只读预检：

```powershell
node --env-file-if-exists=.env ./deployment/production-check.cjs
```

预检依次确认生产配置、机器人可见正式群、操作人员成员关系、雷达来源群、正式群用户身份只读历史权限、报告归档目录、当前 `/ready` 运行组件以及 Windows 常开任务，共 8 项。历史权限探针只读取一分钟窗口的一条消息上限，不下载文件、不发消息、不创建任务、不调用模型。输出只包含固定检查名和诊断码，不打印群 ID、人员 ID、目录 token 或凭证。全部通过后，才同时设置 `BID_DELIVERY_MODE=production` 与 `BID_PRODUCTION_CUTOVER=true` 并重启服务。

默认安装器使用 `Interactive + AtLogOn`，适合当前用户保持登录且机器不休眠的场景。它不满足注销后的常开要求。需要在同一 Windows 账户下随系统启动时，由账户持有人在本机凭证窗口中运行：

```powershell
$credential = Get-Credential
./deployment/Install-FeishuUnattendedTask.ps1 -Credential $credential -NodePath 'C:/Program Files/nodejs/node.exe'
```

脚本只接受当前 Windows 用户，确保 Codex 与飞书授权仍从同一用户目录读取；任务使用 `Password + AtStartup`，密码只交给 Windows 任务计划程序，不写入参数、`.env` 或日志。若预读依赖本机 Docker Desktop，可加 `-StartDocker`，但仍须在重启后用 `production-check.cjs` 实测预读服务已恢复。休眠和关机期间无法接收；需要真正不间断运行时，应迁移到不会休眠的常开 Windows 主机或服务器。

停止当前服务用 `Stop-Feishu.ps1`；暂停下次登录启动用 `Disable-ScheduledTask -TaskName OpenBidKitFeishu -TaskPath '\'`。恢复使用 `Enable-ScheduledTask`。凭证内容不放入命令行参数。

当任务已经升级为 `Password + AtStartup` 时，监管器位于批处理登录会话；部分 Windows 环境不会向当前交互会话公开该进程的命令行或命名管道。此时 `Stop-Feishu.ps1` 会按安全设计报告“PID 属于另一进程”并保持服务不动。需要重启时，应先核对计划任务动作仍指向本目录的 `Start-Feishu.ps1`，再用任务计划程序停止精确任务实例：

```powershell
Stop-ScheduledTask -TaskName OpenBidKitFeishu -TaskPath '\'
# 确认任务不再 Running、记录的监管器/子进程均退出且服务端口不再监听后：
Start-ScheduledTask -TaskName OpenBidKitFeishu -TaskPath '\'
```

不要删除 PID 文件、按 `node.exe` 进程名批量结束或绕过进程身份核验。启动后必须重新检查 `/ready` 和 `deployment/production-check.cjs`。

## 本次验证及环境现象

`node --test integrations/feishu/test/supervisor.test.cjs` 使用临时 HTTP 辅助子进程验证：健康失效后先结束旧 PID 再重启、`/ready` 503 不重启、同数据根互斥、PID 创建时间与入口身份、监管器退出后的孤儿清理，以及跨数据根复制 PID 文件不会结束另一个实例。未使用真实模型、群或实际服务数据。

初版含隐藏二次启动及轮询的 PowerShell 包装在语法读取时出现拒绝访问，随后文件消失；Defender Operational 与 Get-MpThreatDetection 的只读查询均未取得本次检测记录，因此不能确认原因。未修改安全配置、添加排除项或换名规避。最终采用同名的简单前台 Node 入口，后台隐藏启动留给任务调度配置；简化后的三份 PowerShell 文件语法检查通过。
