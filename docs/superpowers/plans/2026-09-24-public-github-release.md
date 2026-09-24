# 联智标公开 GitHub 发布 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 安全公开当前联智标源码，并在既有签名密钥可用时发布首个可下载安装的 `v0.1.0` GitHub Release。

**Architecture:** 发布不改变业务架构，只增加本地构建产物忽略规则并修正下载文档。现有 GitHub Actions 继续作为 Windows/macOS 产物的唯一正式构建入口；推送和打标签前先以本地测试、构建、凭证扫描及 Git 差异审查为门禁。

**Tech Stack:** Git、GitHub CLI、GitHub Actions、Node.js 22、Electron、PowerShell

**Spec:** `docs/superpowers/specs/2026-09-24-public-github-release.md`

## Global Constraints

- 不重置、不覆盖或删除当前工作区中的用户改动。
- 不提交凭证、本地业务数据、公司私有材料或本地产物。
- 不生成或轮换许可证/构建证明私钥。
- 只在完整验证通过后推送；只在现有签名私钥可用后创建 `v0.1.0` 标签。
- 正式发布仍使用 `.github/workflows/release.yml`，不绕过构建证明门禁。
- GitHub Release 必须先通过签名预检并保持草稿，全部 GitHub 产物成功后才公开；AtomGit、R2/Gitee 镜像由仓库变量显式启用。

## Review Focus

- `client/release-*` 本地验收目录不得进入 Git 索引；使用 `git check-ignore` 验证。
- README 中英文下载地址必须同时指向 `lhsl2026/OpenBidKit_Yibiao/releases`；使用精确文本搜索验证。
- `.env.example` 和新增源码不得出现真实凭证；使用模式扫描并人工检查命中项。
- 当前大量既有改动必须完整通过对应测试和客户端构建；以命令退出码和测试计数为准。
- 缺少构建证明私钥时不得打正式标签；以 GitHub Secret 列表和本地现有密钥存在性判断。

---

### Task 1: 发布入口与本地产物边界

**Files:**
- Modify: `.gitignore`
- Modify: `README.md`
- Modify: `README.en.md`

**Interfaces:**
- Consumes: 当前仓库路径和公开仓库地址 `lhsl2026/OpenBidKit_Yibiao`
- Produces: 不会误暂存的本地 release 目录，以及正确的中英文用户下载入口

- [ ] **Step 1: 验证当前边界检查会失败**

Run:

```powershell
git check-ignore client/release-complete
rg -n "github.com/lhsl2026/OpenBidKit_Yibiao/releases" README.md README.en.md
```

Expected: `git check-ignore` 非 0，README 精确搜索无结果。

- [ ] **Step 2: 写入最小文档与忽略规则变更**

在 `.gitignore` 的 `client/release/` 附近增加 `client/release-*/`。把两份 README 的旧下载链接替换为 `https://github.com/lhsl2026/OpenBidKit_Yibiao/releases`，其余文案不变。

- [ ] **Step 3: 验证边界检查通过**

Run:

```powershell
git check-ignore client/release-complete client/release-button-fix client/release-button-fix-2 client/release-agent-fix
rg -n "github.com/lhsl2026/OpenBidKit_Yibiao/releases" README.md README.en.md
```

Expected: 所有 release 目录均被忽略，中英文 README 各命中一次正确地址。

### Task 2: 公开内容审查与本地验证

**Files:**
- Inspect: all tracked and untracked release candidates
- Test: `client/**/*.test.cjs`
- Test: `integrations/feishu/test/*.test.cjs`

**Interfaces:**
- Consumes: Task 1 的发布边界，以及当前全部待提交源码
- Produces: 经凭证审查和完整验证的发布候选提交集合

- [ ] **Step 1: 枚举准备提交的路径并排除本地产物**

Run:

```powershell
git status --short
git ls-files --others --exclude-standard
```

Expected: `client/release-*` 不再出现在未跟踪清单；剩余路径逐项可解释为源码、测试或文档。

- [ ] **Step 2: 扫描凭证模式并人工复核所有命中**

Run a repository scan over tracked changes and untracked candidates for private-key headers, GitHub tokens, Lark credentials, bearer tokens, API-key assignments and non-placeholder secrets. Expected: 无真实凭证；示例变量只为空或占位值。

- [ ] **Step 3: 运行 Git 差异检查**

Run:

```powershell
git diff --check
```

Expected: exit 0，无空白错误。

- [ ] **Step 4: 运行客户端定向测试、原生依赖烟测和生产构建**

Run from `client/` using the repository's existing test files, followed by:

```powershell
npm run smoke:electron-native
npm run build
```

Expected: tests 0 failures，smoke exit 0，build exit 0。

- [ ] **Step 5: 运行飞书集成全量测试**

Run:

```powershell
node --test integrations/feishu/test/*.test.cjs
```

Expected: 0 failures；允许仓库既有环境性 skip，但必须记录数量。

### Task 3: 提交、推送与 GitHub Release

**Files:**
- Commit: all reviewed public release candidates
- External: `lhsl2026/OpenBidKit_Yibiao` main branch and Releases

**Interfaces:**
- Consumes: Task 2 验证通过的发布候选
- Produces: GitHub 上与本地一致的 `main`；密钥可用时产生 `v0.1.0` Release 和安装包

- [ ] **Step 1: 只暂存审查通过的路径并复核索引**

Run:

```powershell
git diff --cached --name-status
git diff --cached --check
```

Expected: 索引只包含已审查源码、测试、文档和忽略规则，无 release 产物、凭证或本地数据。

- [ ] **Step 2: 创建发布准备提交**

Run:

```powershell
git commit -m "release: prepare 联智标 v0.1.0"
```

Expected: commit 成功，工作区只剩明确不发布的忽略内容或为干净状态。

- [ ] **Step 3: 推送 main 并核对远端提交**

Run:

```powershell
git push origin main
git rev-parse HEAD
git ls-remote origin refs/heads/main
```

Expected: 本地 HEAD 与远端 main SHA 相同。

- [ ] **Step 4: 验证现有签名私钥与 GitHub-only 发布条件**

检查 GitHub Secret `YIBIAO_LICENSE_PRIVATE_KEY_JWK` 是否存在，或本机是否存在与 `client/electron/resources/license-public-key.json` 匹配的既有私钥；确认 Release 工作流会在缺钥时于创建 Release 前失败，GitHub Release 先创建草稿并在 Windows/macOS 产物完成后公开，AtomGit 与 R2/Gitee 镜像默认关闭。Expected: 只记录存在性与公钥匹配结果，不输出私钥内容。

- [ ] **Step 5: 条件满足时创建并推送正式标签**

Run:

```powershell
git tag -a v0.1.0 -m "联智标 v0.1.0"
git push origin v0.1.0
```

Expected: 仅在 Step 4 通过时执行，GitHub `Release Client` 工作流被触发。

- [ ] **Step 6: 等待并验证 Release 产物**

Run:

```powershell
gh run list --repo lhsl2026/OpenBidKit_Yibiao --workflow "Release Client" --limit 1
gh release view v0.1.0 --repo lhsl2026/OpenBidKit_Yibiao
```

Expected: 工作流成功；Release 至少包含 Windows EXE/MSI/ZIP，并包含 macOS x64/arm64 产物或明确记录 GitHub runner 限制。
