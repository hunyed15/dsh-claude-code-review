# @local/claude-code-review

DSH Host 插件：把「本地 Claude Code CLI 做独立只读审核」注册成原生工具 **`claude_review`**。

> 本仓库是**独立插件仓库**，可以安装到任意 DSH profile；`<cwd>/tools/claude-review/**` 属于被审项目的可选引擎，不是本仓库的一部分。XinHuo 等只是被它审核过的项目。

主代理（DSH）负责实现，Claude Code 负责判：独立进程、独立上下文、只读权限、拿不到主代理的推理过程。

## 它是什么 / 不是什么

- **是**：一个 Cordis Host 插件（bundle），安装后当前 profile 的所有会话都会多两个工具（`claude_review` / `claude_review_disposition`），并可选增加一个会话内只读的「协同」tab。
- **不是**：独立页面，也不替换任何现有 UI；客户端只有 `client.js` 里的一个 `conversation.view` 视图。
- 审核引擎仍是 `Invoke-ClaudeReview.ps1`（快照增量、diff 范围、提示词、报告、门禁、退出码全在里面）。插件只做路径解析、进程调度与结果归一化，**避免两套逻辑漂移**。

## 安装

```powershell
# 由 DSH 调用（需要权限）
plugin_manager(action: "install_bundle", target: "D:\\Coding\\dsh-plugins\\claude-code-review")
```

> 同名包已安装时 `install_bundle` 会报 `already-installed`：先 `remove_bundle("@local/claude-code-review")`，再按新路径安装。插件目录搬家后不重链，profile 的 `node_modules` 链接会悬空，重启 DSH 后插件不再加载。

安装后当前 profile 立即生效（bundle 通过 HMR 激活），可用 `cordis_inspect_query(platform:"host", provider:"Tool", method:"listTools")` 确认 `claude_review` 出现。

## 用法（模型侧）

| 参数 | 说明 |
| --- | --- |
| `mode` | `incremental`（默认，自上次审核快照以来的改动）/ `full`（相对 HEAD 的全部未提交改动）/ `gate`（本地门禁判定，不调模型） |
| `description` | 这轮做了什么，直接影响审核质量 |
| `checks` | 已执行的客观检查，例如 `["cargo test 12/12 通过"]` |
| `paths` | 可选的 git pathspec，收窄范围（`gate` 会忽略它） |
| `focus` | 额外侧重，例如「重点看前后端契约一致性」 |
| `taskDir` | 报告目录（Trellis 任务目录），留空由引擎自行解析 |
| `cwd` | 要审的仓库，默认当前会话工作目录 |
| `dryRun` | 只组装输入、不调模型 |

返回：`ok / mode / storage / verdict / critical / important / minor / summary / reportPath / markdownPath / costUsd / exitCode / escalated / note`。
`verdict` 为 `fix` 或 `gate-blocked` 时 `ok=false`，`note` 会写明「必须先修，再重跑同一模式」。

## 引擎解析顺序

1. 插件配置 `enginePath`（`cordis.patch.yml` 里的 `config.enginePath`）
2. `<cwd>/tools/claude-review/Invoke-ClaudeReview.ps1`（**被审仓库自己的引擎，优先**）
3. `<cwd>/.dsh/claude-review/Invoke-ClaudeReview.ps1`
4. 插件自带的 `scripts/Invoke-ClaudeReview.ps1`（跨仓库兜底，可用 `allowBundledFallback: false` 关掉）

自带副本是发布时的快照；被审仓库有第 2/3 条引擎时始终以它为准，所以升级被审仓库的引擎不用重装插件。**本插件仓库没有 `tools/claude-review/`，默认就走第 4 条自带副本。**

## 审核账本（Trellis / 本地）

| `storage` | 报告位置 | 行为 |
| --- | --- | --- |
| `auto`（默认） | 有 `.trellis` → Trellis；否则本地 | 优先 Trellis；**绝不在非 Trellis 仓库创建 `.trellis`** |
| `trellis` | `.trellis/tasks/<task>/review/` | 没有 `.trellis` 直接报错，不静默降级 |
| `local` | `.dsh/claude-review/ledger/` | 一个仓库一个本地账本；同样有 history/state/report/gate/disposition |

**配置源只有一处**：插件调用以 `cordis.patch.yml` 的 `storage` 为准；直接 CLI 用 `-Storage`（默认 `auto`）。`scripts/config.json` 不再提供 `storage` 键，避免两套配置静默路由到不同账本。

- 本地账本写入 `task.json`（title = 仓库名）、`review/history.jsonl`、`review-N.json/.md`、`state.json`、`dispositions.jsonl`、`run.json`。
- 本地账本默认被**引擎的 diff/快照**排除，所以不会把审核产物混进下一轮审核；本仓库的 `.gitignore` 也忽略了它。目标仓库如果不想提交账本，请把 `.dsh/claude-review/ledger/` 加进它自己的 `.gitignore`。
- `claude_review` / `claude_review_disposition` / 协同面板使用同一套 storage 解析，所以非 Trellis 仓库也有完整轮次、门禁和处置链路。

## 平台与依赖

- Windows + PowerShell 7（`pwsh`），通过 `ctx.subprocess` 调度，遵守 Host 的进程与沙箱约束。
- 需要本地 `claude` CLI 已安装并可用（引擎自己解析可执行文件；可在本插件的 `scripts/config.json`，或被审仓库的 `tools/claude-review/config.json` 里固定 `claudeExe`）。
- 本机沙箱下审核进程通常只有 `Read` 可用（`Grep`/`Glob`/`Bash` 被拒），引擎会把 diff 与改动文件清单内联进简报。
- 审核进程只开放 `Read` / `Grep` / `Glob`；**不开放 Bash**，`Write/Edit/NotebookEdit` 也禁用。只读由工具层强制，不依赖提示词。
- 引擎自带通用 reviewer role（`scripts/reviewer-role.md`）；项目自己的 `.trellis/agents/review.md` 存在时会合并进去。Trellis 模式还会把 `.trellis/spec/**/index.md` 路径列进简报，让审核员按需读取。

## 协同面板（会话内第三个 tab）

在会话顶部「对话｜轨迹」旁边多一个 **协同**（`conversation.view`，`id=collab`，order 20，不替换任何现有 UI）。

显示内容（全部只读）：

- **审核轮次时间线**：本项目**所有会话**的轮次（#round / 模式 / verdict / 分级计数 / 会话 id 短号 / 时间 / 成本），点开看每条问题的 `why`、`fix`、`key`、生命周期与处置徽章；
- **下一步**：由最近一轮和门禁推导唯一动作（跑第一次审核 / 修 N 条必修 / 补 full / 跑 gate / 处理阻断）；
- **项目任务切换**：右侧列出项目里的任务及其门禁/待修/最近轮次，点击切换当前任务详情；
- **问题 → 修复结果**：生命周期（新发现 / 仍存在 / 已修复 / 复发 / 未复检）+ 显式处置（已修 / 已反证 / 暂缓）；
- **门禁与账本**：门禁状态/原因；Trellis 模式显示 prd/design/implement 与 manifest 计数，本地模式显示账本路径、轮次和累计成本；
- **运行中状态**：长审核期间显示「审核进行中 + 已用时」；心跳超时显示「上次审核中断」，失败显示错误。

### 数据从哪来

```
Client (React view)  --fetch-->  GET /claude-review/api/panel?sessionId=<id>&[task=<name>]
                                      │
Host 路由（本插件注册的 webServer resource）
   ├─ 按 sessionId 解析项目目录（agents + workingDirectory；不要求 .trellis）
   ├─ Trellis 模式：只读 <项目>/.trellis/tasks/*/review/{history.jsonl,review-N.json,dispositions.jsonl,run.json}
   └─ 本地模式：  只读 <项目>/.dsh/claude-review/ledger/review/...
```

- 客户端**不读盘**，也不接触任意路径；Host 只读会话所属项目里的账本。
- 没有 `.trellis` 的项目**不再报错**：用本地账本返回一个空看板，提示跑第一次审核；只有显式 `storage=trellis` 且没有 `.trellis` 才报 `trellis-not-initialized`。
- 客户端每 8 秒刷新一次，也可点「刷新」；切换任务会带上 `task=<name>`。

### 处置状态（方案 A）

| 徽章 | 来源 | 含义 |
| --- | --- | --- |
| 已修 / 已反证 / 暂缓 | `dispositions.jsonl`（`claude_review_disposition` 写入） | 主会话的**结论** |
| 视为已修（推断） | 下一轮同类问题未再出现 | 推断，不是声明 |
| 复检仍存在 | 下一轮同类问题仍出现（key 相同，或同 file+severity 且文本相似度 ≥0.4） | 推断 |
| 同文件另有问题 | 下一轮同 file+severity 出现，但文本相似度 <0.4 | 推断（不是「没修」） |
| 未复检 | 后面没有可对照轮次 | — |

### 问题生命周期

按稳定 `key` 跨轮推导，独立于显式处置（两者都展示）：

| 徽章 | 判定 |
| --- | --- |
| 新发现 | 该 key 首次出现的轮次 |
| 仍存在 | 该 key 在后续轮次继续出现 |
| 已修复 | 最后一次出现之后，有一轮「真正跑过模型」的审核不再包含它 |
| 复发 | 中间有审核轮次不含它，之后又出现 |
| 未复检 | 只出现过一次，后面没有可对照的审核轮次 |
| — | 没有 key 的旧数据，退回 disposition 推断 |

> “真正跑过模型”指有 `review-N.json` 且不是 `nothing-to-review`；代码没变、没人复检的轮次不会把问题判成已修复。

写入工具：`claude_review_disposition({ entries:[{round, key|index, status, note, evidence}] })`，追加到 `<task>/review/dispositions.jsonl`，不改历史。`index` 是 **0-based**，与 `review-N.json` 的 `issues` 下标一致；更稳的做法是用 `key`（`review-N.md` 里每条问题都打印了 key 与 index）。storage 由 `cordis.patch.yml` 决定，与审核时一致。

> 复检推断只认「有 `review-N.json` 且不是 `nothing-to-review`」的下一轮：下一轮干净 `pass`（issues 为空）也算已复检，判为「视为已修（推断）」，备注会带上轮次与模式；如果后面只有 `nothing-to-review`，说明代码没变、没人复检，保持「未复检」。

> 门禁状态是**面板口径**：只看最近一轮历史（mode/verdict/degraded），不校验「审核后工作区是否又变了」。提交前必须跑 `claude_review(mode:"gate")` 复核。

### 注意

- 面板是**项目级数据 + 会话级入口**：数据按项目聚合（所以换会话继续干同一任务历史不断），入口跟着会话走，因此每条轮次都标了产出它的会话 id。
- `index.js` / `panel.js` / `client.js` 改动需要**重启 DSH（或刷新页面加载新客户端 bundle）**才生效；只改引擎不需要。

## 自测

在本包目录运行（不调用模型）：

```powershell
pwsh -NoProfile -File test/engine-gate.ps1   # 17 个断言：gate 快照/历史/本地/ Trellis
node test/tool-smoke.mjs                     # 52 个断言，约 10 秒
node test/panel-smoke.mjs                    # 48 个断言（真实仓库断言可选，见下）
node test/client-smoke.mjs                   # 11 个断言
```

- `engine-gate`：在临时 git 仓库里直接跑引擎 gate，覆盖本地无历史/full pass/快照不一致/incremental/fix/history 损坏/无历史有改动、Trellis pass、显式 trellis 缺 `.trellis`，并断言本地模式不创建 `.trellis`。
- `tool-smoke`：命令行构造（含 `-Storage`）、`fix`/`gate-blocked` 必须 `ok=false`、`exit 2` 必须抛错、`dryRun` 透传、引擎缺失可诊断、Trellis/本地处置写入，以及面板路由的授权/冷启动重试/大小写比较/本地模式。
- `panel-smoke`：问题匹配、轮次聚合、处置叠加、生命周期（new/still/fixed/reopened）、下一步动作、任务切换、Trellis 与本地账本、`nothing-to-review` 语义。真实仓库断言用 `CLAUDE_REVIEW_REPO=<Trellis 仓库>` 指定；未指定且包不在 Trellis 仓库内时记 SKIP。
- `client-smoke`：静态检查客户端注入、`conversation.view` 注册、原生 style 注入与路由访问边界。

「真实 spawn 引擎跑一次 gate」在受限沙箱内可能被拒（Node 管道 spawn `EPERM`，已知边界），此时该用例记 SKIP；在沙箱外/危险全权限下会真正执行。

## 改动插件代码后

bundle 是**链接安装**（profile 的 `node_modules` 指向本目录），文件改动立刻在磁盘上生效，但已加载的 JavaScript 模块不会热替换：**改 `index.js` / `panel.js` 需要重启 DSH（或重新启用该插件）才生效**；`client.js` 改完刷新页面即可。只改引擎（本插件仓库的 `scripts/Invoke-ClaudeReview.ps1`，或被审仓库自己的 `tools/claude-review/`）不需要重启——每次调用都重新拉起进程。

## 与 CLI / Trellis 的关系

| 入口 | 用途 |
| --- | --- |
| `claude_review` 工具（本插件） | 会话内直接调，主代理的首选路径 |
| 本插件 `scripts/Invoke-ClaudeReview.ps1` | 独立插件仓库里默认使用的引擎，也可用 `enginePath` 指向别处 |
| 被审仓库的 `tools/claude-review/Invoke-ClaudeReview.ps1` | 该仓库自己的引擎；存在时优先于插件自带副本 |
| 被审仓库的 `.trellis/spec/guides/claude-review-gate.md` | 门禁契约（如果该项目有）；本插件仓库没有它也能工作 |
| 本地账本 `.dsh/claude-review/ledger/` | 没有 `.trellis` 时的完整替代存储（history/state/report/gate/disposition） |

三者共用同一套引擎契约；报告目录随 `storage` 落在 `.trellis/tasks/<task>/review/` 或 `.dsh/claude-review/ledger/review/`。
