# 本机搭建记录

日期：2026-09-09

## 代码与启动

- 目录：`E:\WorkSpaces\OpenBidKit_Yibiao`
- 上游：`https://github.com/lhsl2026/OpenBidKit_Yibiao`
- 基线提交：`33eedc920d61725361d3668ef4fd4e02ba77be8e`
- 本机 Node.js：24.14.0；仓库 CI 推荐 Node.js 22。

在 PowerShell 中启动：

```powershell
Set-Location E:\WorkSpaces\OpenBidKit_Yibiao\client
npm.cmd start
```

开发调试使用 `npm.cmd run dev`。本次没有设置登录自启，没有向飞书群发送消息，没有修改旧预读服务。

## 验证结果

- `npm.cmd ls --depth=0`：通过。
- `npm.cmd run build`：通过，TypeScript 检查与 Vite 生产构建成功；有已有的大 chunk 提示。
- `npm.cmd run smoke:electron-native`：通过，Electron 41.10.2、Node 24.18.0、ABI 145，成功加载 SQLite 并执行内存查询。
- 在独立测试 userData 目录启动实际 Electron 主程序：首页渲染、preload 桥可用。
- `git fsck --connectivity-only`：通过；上游基线工作区无源码差异。

模型尚未配置，本次没有执行收费模型调用、真实招标文件生成、Open XML 打包或飞书业务联调。环境中暂未发现 .NET SDK；如需 Open XML 助手构建和完整安装包，应安装仓库要求的 .NET 10 SDK。

## 网络异常与恢复

Git clone/fetch 在当前网络出现连接重置或持续无响应。通过 GitHub API 下载源代码归档，逐个核验全部 498 个文件对象、树对象和原始提交 SHA，恢复同一上游提交的浅仓库。未伪造本地上游提交，未修改全局 Git 代理。

`npm ci` 下载 JavaScript 依赖后，Electron 二进制下载等待过长；中断后使用本机缓存的同版官方 Electron 包，核对 npm 包内 `checksums.json` 的 SHA-256 后安装。随后 native rebuild 下载发生连接重置，改为通过 GitHub API 获取上游 `WiseLibs/better-sqlite3` 的精确版本原生模块，并核对 Release 的 SHA-256 后安装。

恢复使用的二进制：

- `electron-v41.10.2-win32-x64.zip`：`7665990f65b7d2f61671eb342b08c4b6f2e7ce302a269d56c2f3554fc8c8ce72`。
- `better-sqlite3-v12.10.0-electron-v145-win32-x64.tar.gz`：`2bb45d10de99125d50a615f34284c3768ceb973b76ca7d7924dbc1e63966f26e`。

原始 `npm ci` 和首次 native rebuild 没有成功完成，不能把它们记录为通过；最终以依赖树、生产构建、实际 Electron 原生查询和启动验证为依据。没有改动 package.json 或 lockfile，也没有跳过哈希校验。

飞书集成方案见 [实施方案](superpowers/specs/2026-09-09-feishu-integration-design.md)。
