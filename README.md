# @hunyed15/claude-code-review

DSH Host 插件：把「本地 Claude Code 做独立只读审核」注册成原生工具 **`claude_review`**。

> 本仓库是**独立插件仓库**，可以安装到任意 DSH profile；`<cwd>/tools/claude-review/**` 属于被审项目的可选引擎，不是本仓库的一部分。XinHuo 等只是被它审核过的项目。

主代理（DSH）负责实现，Claude Code 负责判：独立进程、独立上下文、只读权限、拿不到主代理的推理过程。审核传输默认 `auto`：优先使用插件**内置的 ACP**，不可用时回退现有 Claude Code CLI；用户不需要配置 ACP。

## 它是什么 / 不是什么

- **是**：一个 Cordis Host 插件（bundle），安装后当前 profile 的所有会话都会多两个工具（`claude_review` / `claude_review_disposition`），并可选增加一个会话内只读的「协同」tab。
- **不是**：独立页面，也不替换任何现有 UI；客户端只有 `client.js` 里的一个 `conversation.view` 视图。
- 审核引擎仍是 `Invoke-ClaudeReview.ps1`（快照增量、diff 范围、提示词、报告、门禁、退出码全在里面）。插件只做路径解析、进程调度与结果归一化，**避免两套逻辑漂移**。

## 安装

### 从 npm / DSH 市场安装（用户）

发布后（包名 `@hunyed15/claude-code-review`）：

- 在 DSH 的 **Plugins → Discover** 搜索 `@hunyed15/claude-code-review`（市场索引收录后）；
- 或 **Plugins → Add plugin** 选本地目录（内测）；
- 或直接：

```powershell
plugin_manager(action: "install_bundle", target: "@hunyed15/claude-code-review")
```

需要本机 **Claude Code CLI + 鉴权**，以及 **PowerShell 7（`pwsh`）**；Windows 已验证。首次安装会拉 ACP adapter 依赖；**不需要**单独安装/配置 ACP。

### 本地开发安装

```powershell
plugin_manager(action: "install_bundle", target: "D:\\Coding\\dsh-plugins\\claude-code-review")
```

> 同名包已安装时 `install_bundle` 会报 `already-installed`：先 `remove_bundle("@hunyed15/claude-code-review")`，再安装。插件目录搬家后不重链，profile 的 `node_modules` 链接会悬空，重启 DSH 后插件不再加载。

安装后当前 profile 立即生效（bundle 通过 HMR 激活），可用 `cordis_inspect_query(platform:"host", provider:"Tool", method:"listTools")` 确认 `claude_review` 出现。

插件依赖会自动安装，包括 ACP 的 `@agentclientprotocol/sdk` 与 `@agentclientprotocol/claude-agent-acp`；**不需要**再装 ACP server/profile、配 ACP agent 或单独 `npm install`。首次安装会拉 adapter（claude-agent-acp 及其 Claude Agent SDK 依赖，约 108 个包，Windows 已验证）。包名 `@hunyed15/claude-code-review`，`publishConfig.access=public`；依赖会随插件安装进入 profile。

## 发布（维护者）

```powershell
npm login          # hunyed15
npm pack --dry-run # 确认 scripts/engine、acp、schema、role、locale、icon 都在
npm publish --access public
npm view @hunyed15/claude-code-review version
```

- `engines.dsh` 限定在已测试的 DSH 版本（当前 `>=0.2.2-rc.3 <0.3.0`）。
- 发布后在 DSH Plugins 的 Discover（`@deepseek-ai/dsh-plugin-market` 配置索引）或社区 `dshmarket` 中出现；用户也可以直接 `install_bundle` npm 包名。
- 不提交 `node_modules`；`files` 白名单已包含运行所需脚本与资源。

## 用法（模型侧）

| 参数 | 说明 |
| --- | --- |
| `mode` | `incremental`（默认，自上次审核快照以来的改动）/ `full`（相对 HEAD 的全部未提交改动，可配 `base`）/ `gate`（本地门禁判定，不调模型）/ `range`（已提交区间 `base..head`，不再需要 soft reset） |
| `base` | 可选 git revision；`range` 必填，`full/incremental` 可选（例如 `HEAD~1`）；`gate` 忽略它 |
| `head` | 可选 git revision；**只用于 `range`**（默认 `HEAD`）；`full/incremental/gate` 传了会明确报错 |
| `description` | 这轮做了什么，直接影响审核质量；提到的文件必须至少有一个出现在 diff 里（`strictScope` 默认开） |
| `checks` | 已执行的客观检查，例如 `["cargo test 12/12 通过"]` |
| `paths` | 可选的 git pathspec，收窄范围（`gate` 会忽略它） |
| `focus` | 额外侧重，例如「重点看前后端契约一致性」 |
| `taskDir` | 报告目录（Trellis 任务目录）；Trellis 下没有当前任务时**必须显式传**，引擎不再按 history 猜 |
| `profile` | `quick`（low effort + 40k diff 上限）/ `deep`（high effort + 200k diff 上限）；显式 `effort/maxDiffChars` 优先 |
| `cwd` | 要审的仓库，默认当前会话工作目录 |
| `dryRun` | 只组装输入、不调模型 |

返回：`ok / mode / storage / base / head / profile / transport / verdict / critical / important / minor / summary / reportPath / markdownPath / costUsd / costKnown / truncated / scopeWarning / cached / exitCode / escalated / note / enginePath / engineSource / engineWarning`。
`verdict` 为 `fix` 或 `gate-blocked` 时 `ok=false`，`note` 会写明「必须先修，再重跑同一模式」；`cached=true` 表示命中了完全相同输入的缓存，没有调用模型。`transport` 是实际使用的 `acp` 或 `cli`；ACP 目前不返回逐轮成本，`costKnown=false`、`costUsd=0`（面板显示 `—`，不伪造）。

## 引擎解析顺序与版本握手

1. 插件配置 `enginePath`（`cordis.patch.yml` 里的 `config.enginePath`）
2. `<cwd>/tools/claude-review/Invoke-ClaudeReview.ps1`
3. `<cwd>/.dsh/claude-review/Invoke-ClaudeReview.ps1`
4. 插件自带的 `scripts/Invoke-ClaudeReview.ps1`（跨仓库兜底，可用 `allowBundledFallback: false` 关掉）

每个候选引擎先读文件头的 `# claude-review-api: 3`：

- 有标记且版本 >= 3 → 使用该引擎；v2 旧引擎会被跳过并回退自带引擎（新参数 `-Transport/-NodeExe` 不会被错误地当成模型问题）；
- 标记缺失/版本过低 → 跳过，并回退到自带引擎；结果里带 `engineWarning`，工具 `note` 会显示；
- `enginePath` 显式配置且 `allowBundledFallback: false` 时，版本不符直接报错，不会静默换引擎。

引擎也支持 `pwsh -File scripts/Invoke-ClaudeReview.ps1 -Capabilities`，直接输出 `{api:3, storage, base, range, truncatedGate, profiles, transport}`。旧版目标引擎没有这些参数时，插件会给出明确的「接口版本不符」而不是把参数绑定错误伪装成「模型输出不可解析」。

## 审核账本（Trellis / 本地）

| `storage` | 报告位置 | 行为 |
| --- | --- | --- |
| `auto`（默认） | 有 `.trellis` → Trellis；否则本地 | 优先 Trellis；**绝不在非 Trellis 仓库创建 `.trellis`** |
| `trellis` | `.trellis/tasks/<task>/review/` | 没有 `.trellis` 直接报错，不静默降级 |
| `local` | `.dsh/claude-review/ledger/` | 一个仓库一个本地账本；同样有 history/state/report/gate/disposition |

**配置源只有一处**：插件调用以 `cordis.patch.yml` 的 `storage` 为准；直接 CLI 用 `-Storage`（默认 `auto`）。`scripts/config.json` 不再提供 `storage` 键，避免两套配置静默路由到不同账本。

**Trellis 任务解析（不猜）**：

- 显式 `taskDir` 最优先；
- 插件把 DSH session id 传给引擎，引擎用 `DSH_SESSION_ID` 调 `task.py current`，只接受真正的当前任务；
- 没有当前任务就 **exit 2**，提示传 `taskDir`；**不会**再按 `review/history.jsonl` 最新修改或 `in_progress` 状态猜任务（猜错会连带用错 diff 基线和账本）；
- 本地 storage 不需要任务。

- 本地账本写入 `task.json`（title = 仓库名）、`review/history.jsonl`、`review-N.json/.md`、`state.json`、`dispositions.jsonl`、`run.json`；引擎会在账本目录写 `.gitignore`（`*`）自忽略，避免 `git add`/快照把审核产物带进来。
- 本地账本默认被**引擎的 diff**排除，且账本自忽略；本仓库的 `.gitignore` 也忽略了它。目标仓库不需要额外配置，`git status` 不会显示账本。
- `claude_review` / `claude_review_disposition` / 协同面板使用同一套 storage 解析；`claude_review_disposition` 在 Trellis 下必须显式传 `taskDir`（面板不持有 DSH 会话身份，不会猜）。

## 平台与依赖

- Windows + PowerShell 7（`pwsh`），通过 `ctx.subprocess` 调度，遵守 Host 的进程与沙箱约束。
- 需要本地 `claude` CLI 已安装并可用（引擎自己解析可执行文件；可在本插件的 `scripts/config.json`，或被审仓库的 `tools/claude-review/config.json` 里固定 `claudeExe`）。ACP 也复用它作为 agent 的底层 CLI。
- ACP 依赖随插件安装；`scripts/acp-review.mjs` 使用 DSH Host 的 Node/Electron 运行，不要求用户 PATH 有 node。Windows 已验证；首次安装会拉 `claude-agent-acp` 及其 Claude Agent SDK 依赖（约 108 个包）。
- 本机沙箱下审核进程通常只有 `Read` 可用（`Grep`/`Glob` 也可能被拒；`Bash` 不开放），引擎会把 diff 与改动文件清单内联进简报。
- 审核进程只开放 `Read` / `Grep` / `Glob`；**不开放 Bash**，`Write/Edit/NotebookEdit` 也禁用。只读由工具层强制，不依赖提示词。
- **权限边界**：插件会启动 `pwsh` 与 Claude Code CLI，读取被审项目代码；审核进程只读，但插件本身是 Host 插件，需要在 DSH 里被信任安装。`pre-commit` hook 是仓库级守卫，`git commit --no-verify` 可绕过；它不是服务端强制。
- 引擎自带通用 reviewer role（`scripts/reviewer-role.md`）；项目自己的 `.trellis/agents/review.md` 存在时会合并进去。Trellis 模式还会把 `.trellis/spec/**/index.md` 路径列进简报，让审核员按需读取。
- **截断 fail-closed**：`maxDiffChars` 默认 200000；超出时报告/history/面板都带 `truncated`，**截断的 full pass 不能过 gate**（`allowTruncatedGate: true` 可显式放行）。调大上限或缩窄 `paths` 后重跑。
- **scope preflight**：`strictScope` 默认 `true`；`description`/`focus` 里提到的、仓库中真实存在的文件，必须至少有一个出现在 diff 里，否则 exit 2。确认是有意为之可设 `strictScope: false` 或加 `-NoStrictScope`。
- **profile / 缓存**：`quick` 低 effort + 40k，`deep` high effort + 200k；完全相同 diff + 相同输入 + 相同上下文文件（本地 REVIEW.md/AGENTS/CLAUDE/CONTRIBUTING、Trellis 任务产物/spec、role/schema/引擎/config/Claude settings、range 工作区树）会命中缓存，0 次模型调用；命中时仍按**当前快照**追加一条零成本 history（面板/门禁能看到当前 full pass），空 diff 轮次会清掉旧 hash，避免拿 `nothing-to-review` 冒充缓存结果。**不做**“未变文件沿用上轮结论”的跨文件缓存。
- **range 的 Read 语义**：diff 是 base..head 提交区间，但审核员用 `Read` 看到的是**当前工作区**。工作区 dirty 或 `-Head != HEAD` 时，简报会明确警告“以 diff 为准”，且缓存键包含工作区树；需要严格按提交内容审时，先确保工作区干净。
- **自定义 Base 不是收尾门禁**：`full -Base HEAD~1` 适合评已提交区间；门禁只认不带 `-Base` 的普通 `full`，否则可以绕开完整范围。`range` 本身也不满足收尾门禁。

## 审核传输：内置 ACP（默认 auto）/ CLI

`transport` 在 `cordis.patch.yml` 配置，默认 `auto`；直接 CLI 用 `-Transport auto|acp|cli`。

- **ACP 是插件内部实现，不是用户要配的 ACP 环境**。`@agentclientprotocol/sdk` 和 `@agentclientprotocol/claude-agent-acp` 是 `package.json` 的普通依赖，安装插件时自动进入插件的 `node_modules`；**不需要** ACP server/profile、ACP agent、编辑器配置或单独 `npm install`。
- `auto` 在 bridge、adapter、DSH Host Node 可用时走 ACP；不可用则自动回退现有 Claude CLI（bridge 以 exit 3 报告“传输不可用”，不会把 ACP 启动失败伪装成审核结论）。
- bridge 是 `scripts/acp-review.mjs`，用官方 SDK 的 `client()` / `buildSession().start()` / `readText()`，不手写 JSON-RPC。插件把 `process.execPath` 传给引擎；Host 是 Electron 时加 `ELECTRON_RUN_AS_NODE=1`，所以**不要求用户 PATH 里有 node**。
- 只读边界：ACP 会话先显式 `session/set_mode` 到 `default`（失败即中止），并在 adapter 的 `_meta` 里 `disallowedTools` 禁用 `Write/Edit/NotebookEdit/Bash/PowerShell/WebFetch/WebSearch`；`session/request_permission` 只批准 `read/search`，拒绝 edit/execute/terminal，`fs/read_text_file` 实现、`fs/write_text_file` 拒绝。不把 `allowedTools` 裸名写进 options，避免 adapter 自动放行、绕过 `canUseTool` 权限回调。prompt/role/报告/gate 复用现有契约。
- **role 层级**：adapter 声明 `sessionCapabilities.systemPrompt` 时，reviewer role 通过 `session/new` 的 `systemPrompt: {mode:'append'}` 进入 system 层（`roleMode=system`），不再和不可信 diff 同级；adapter 不支持时才回退为 prompt 前置（`roleMode=prompt`）。报告 meta 记录 `roleMode`。
- **auto 回退可见**：bridge 在发出 prompt 前失败（exit 3）时回退 CLI，并写 `transportWarning`（首条错误）到工具 `note`、报告 meta、history 和面板轮次；ACP 的失败 envelope/err 保留在 `raw-<round>-acp.json` / `acp-err-<round>.txt`。启动期超时（initialize/session/setMode 卡住）同样归类为 exit 3，不会让 auto 白等整轮。
- **成本未知不伪造**：ACP 轮次 `cost_usd=null`、工具 `costKnown=false`、面板显示「成本 —」；混有未知成本轮次时总成本显示为「累计 ≥ $X（含未知）」，全未知且为 0 时显示「成本 —」而不是 `$0.00`。`nothing-to-review` 未调用模型，成本固定为已知 0。
- **roleMode 审计**：ACP 报告 `roleMode=system`（systemPrompt）或 `prompt`（回退）；CLI 因 `--append-system-prompt-file` 记录为 `system`，无 role 为 `none`。
- **启动预算**：ACP 初始化/会话/setMode 有独立短预算（`TimeoutSec/10`，夹在 5–30s）；卡死时 exit 3 回退 CLI，且回退后重新计时，不会吃掉整轮审核预算。
- **预算/模型透传**：`maxBudgetUsd`、`model`、`effort` 通过 `session/new` 的 `_meta.claudeCode.options.extraArgs` 传给 adapter（fake 测试断言 `max-budget-usd`/`model`/`effort`），不再是 ACP 静默忽略。
- ACP adapter 仍复用现有 Claude Code（`CLAUDE_CODE_EXECUTABLE` 指向引擎解析到的 `claude`），因此 **Claude Code 及其鉴权/模型/relay 仍是插件前置**；这不是 ACP 配置。
- **成本**：当前 ACP adapter 不提供逐轮 `total_cost_usd`，报告里 `cost_usd=null`、工具 `costKnown=false`，面板不显示假的 `$0`。需要精确成本时用 `transport: cli`。
- ACP 通过 `session/new` 的 `_meta.claudeCode.options.extraArgs` 透传 `maxBudgetUsd`/`model`/`effort`；未配置时用 Claude settings。需要强制 CLI 用 `transport: cli`。
- **发布**：包名已改为 `@hunyed15/claude-code-review`、已去掉 `private`、`publishConfig.access=public`；维护者发布步骤见「发布（维护者）」。依赖会随插件安装自动带上，最终用户仍然只装插件，不需要额外 ACP 安装/配置。

## 提交前门禁与 pre-commit

`-Mode gate` 只验证「最近一次 full/range 已 pass 且快照一致」，不调用模型。**干净工作区本身不是 pass**：从未审核过、只跑过 incremental、上次 fix、快照降级/截断/自定义 Base 都会被拒绝；`nothing-to-review` 只有在完整 full 且记录存在时才视为终态。

推荐在每个仓库安装 Git hook（可选，不自动安装）：

```powershell
pwsh -NoProfile -File scripts/install-git-hook.ps1 -Cwd <repo> [-EnginePath <engine>] [-Force]
```

- hook 调 `-Mode gate -Storage auto`；Trellis 可用 `CLAUDE_REVIEW_TASKDIR` 指定任务目录。
- 也可以直接在 DSH 会话里调 `claude_review_install_hook`（`cwd`/`force`/`enginePath`/`taskDir`），一键安装；等价于上面的脚本。
- 引擎路径可用 `CLAUDE_REVIEW_ENGINE` 覆盖；默认写入安装时的引擎绝对路径。
- hook 要求没有 unstaged 改动（`git diff --quiet`），避免「审的是工作区、提交的是另一份」。
- 紧急可 `git commit --no-verify`；hook 是本地守卫，不是服务端强制。
- 新插件已带引擎版本握手（`# claude-review-api: 3`）：目标仓库旧引擎会被跳过并回退自带引擎，`engineWarning` 会显示；如果 `allowBundledFallback: false` 则直接报错。
- 被审仓库有 `tools/claude-review/` 副本时，**不要改副本**；副本可以镜像上游，但补丁要回上游，config 差异放被审仓库自己的 `config.json`。否则就是两份事实源，插件升级后会再次出现「旧副本不认新参数」。

## 协同面板（会话内第三个 tab）

在会话顶部「对话｜轨迹」旁边多一个 **协同**（`conversation.view`，`id=collab`，order 20，不替换任何现有 UI）。

显示内容（全部只读）：

- **审核轮次 + 缺陷看板**：本项目**所有会话**的轮次（#round / 模式（含范围 range） / 传输（ACP/CLI） / verdict / 分级计数 / 会话 id 短号 / 时间 / 成本），点开看每条问题的 `why`、`fix`、`key`、问题状态（待处理 / 待复检 / 已验证 / 复现 / 暂缓 / 反证）和看板列；被截断的轮次显示「截断」；ACP 轮次成本未知时显示 `—`；
- **下一步**：按轮次状态推导唯一动作（跑第一次审核 / 修复并处置 / 复检本轮修复 / 用 range 复检 / 跑 gate / 处理阻断）；
- **项目任务切换**：右侧列出项目里的任务及其门禁/待处置/最近轮次与轮次状态，点击切换当前任务详情；
- **问题 → 修复结果**：问题状态（待处理 / 待复检 / 已验证 / 复现 / 暂缓 / 反证）+ 显式处置（已修 / 已反证 / 暂缓）与生命周期；
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

按 `key` + 语义相似度跨轮推导，独立于显式处置（两者都展示）：

| 徽章 | 判定 |
| --- | --- |
| 新发现 | 该问题簇首次出现的轮次 |
| 仍存在 | 该问题簇在后续轮次继续出现 |
| 已修复 | 最后一次出现之后，有一轮「真正跑过模型」的审核不再包含它 |
| 复发 | 中间有审核轮次不含它，之后又出现 |
| 未复检 | 只出现过一次，后面没有可对照的审核轮次 |
| — | 极端旧数据（没有 file/severity/key）才退回 disposition 推断 |

> 归并规则：先按 `key` 精确匹配；key 对不上时，按 `file + severity + issue 文本相似度 ≥0.4` 归并。审核员换措辞导致 key 变化时仍算同一问题；同文件但文本差异大的问题不会被误并。keyless 旧数据也参与模糊聚类。

> “真正跑过模型”指有 `review-N.json` 且不是 `nothing-to-review`；代码没变、没人复检的轮次不会把问题判成已修复。

### 缺陷全流程看板（V1）

面板把「审核轮次」和「缺陷生命周期」分开，不再把红色轮次直接当成任务失败：

| 层 | 状态 |
| --- | --- |
| 问题 issue | `待处理（open）→ 待复检（fixed）→ 已验证（verified）`；另有 `复现（reopened）`、`已暂缓（deferred）`、`已反证（counter-evidence）` |
| 轮次 round | `待处置（open）→ 处置中（fixing）→ 待复检（ready-for-verification）→ 已关闭（verified）/ 带风险关闭（closed-with-risk）/ 复现（reopened）` |

- **看板列**：待处理 / 待复检 / 已验证 / 复现 / 暂缓·反证；轮次头显示本轮状态。
- **下一步**：未处置 → 修复并处置；全部 fixed → 复检本轮修复；deferred/反证 → 门禁风险提示；`nothing-to-review` 但上一轮待复检 → 用 `-Mode range` 复检上次修复；全绿 → gate。
- **minor 不阻断**：只有 minor 的轮次可以关闭；仍显示在「待处理」列，由人决定修/暂缓。
- **failOn 口径**：引擎把生效的 `failOn` 写进 `review-N.json` 的 `meta`；面板和轮次守卫都用报告里的 `failOn` 判断 blocking。旧报告没有 `meta.failOn` 时，两边都回退到默认 `critical/important`，当前配置只影响新报告，不会改写旧报告。
- **fixed 只是声明**：下一轮负责复检；复检仍在会变 `reopened`，不会把「已修」直接当「已关闭」。

### 轮次门禁（V2）

引擎在 **full / range / incremental** 开始前检查上一轮的 `review-N.json`：如果还有**未处置的 blocking findings**（`failOn`，默认 critical/important），直接 `exit 2`，提示先修复并用 `claude_review_disposition` 标记 `fixed` / `deferred` / `counter-evidence`，**不调用模型**。

- `-Mode gate` 不受这条守卫影响（它不调模型，只读 history）。
- `fixed` / `deferred` / `counter-evidence` 都算已处置；`fixed` 后的下一轮就是复检。
- 跨轮处置不算：`round` 不匹配的 disposition 不能给上一轮洗白。
- 守卫从 `<task>/review/dispositions.jsonl` 读处置，与 `claude_review_disposition` 的写入位置一致；`-OutDir` 只影响报告，不影响处置。
- `nothing-to-review` 保留上一份 `lastReport`（只清缓存键），不能用一次空轮绕过守卫；守卫按报告自身的 `meta.round` 匹配 disposition，`state.round` 递增不会错配。
- 这是审核轮次门禁，不是提交门禁；提交门禁仍是 `-Mode gate` + pre-commit hook。

写入工具：`claude_review_disposition({ entries:[{round, key|index, status, note, evidence}] })`，追加到 `<task>/review/dispositions.jsonl`，不改历史。`index` 是 **0-based**，与 `review-N.json` 的 `issues` 下标一致；更稳的做法是用 `key`（`review-N.md` 里每条问题都打印了 key 与 index）。storage 由 `cordis.patch.yml` 决定，与审核时一致。

> 复检推断只认「有 `review-N.json` 且不是 `nothing-to-review`」的下一轮：下一轮干净 `pass`（issues 为空）也算已复检，判为「视为已修（推断）」，备注会带上轮次与模式；如果后面只有 `nothing-to-review`，说明代码没变、没人复检，保持「未复检」。

> 门禁状态是**面板口径**：看最近一轮历史（mode/verdict/degraded/truncated），不校验“审核后工作区是否又变了”。截断的 full pass 在面板显示 blocked；`range` 也不满足收尾门禁（需要 full）。提交前必须跑 `claude_review(mode:"gate")` 复核。

### 注意

- 面板是**项目级数据 + 会话级入口**：数据按项目聚合（所以换会话继续干同一任务历史不断），入口跟着会话走，因此每条轮次都标了产出它的会话 id。
- `index.js` / `panel.js` / `client.js` 改动需要**重启 DSH（或刷新页面加载新客户端 bundle）**才生效；只改引擎不需要。

## 自测

在本包目录运行（不调用模型）：

```powershell
pwsh -NoProfile -File test/engine-gate.ps1   # 55 个断言：gate 快照/历史/本地/Trellis、range、截断、scope、任务解析
pwsh -NoProfile -File test/engine-cache.ps1  # 8 个断言：fake Claude 验证缓存、空 diff 清 hash、gate 可解锁
pwsh -NoProfile -File test/engine-round-guard.ps1 # 22 个断言：V2 未处置 blocking 拒绝新 review、fixed/deferred/反证放行、跨轮/原始下标/gate/range、报告 failOn、nothing 保留 lastReport、旧报告回退默认 failOn
pwsh -NoProfile -File test/engine-acp.ps1    # 10 个断言：fake ACP full/gate、空格路径、auto→CLI、超时/启动超时回退
node test/tool-smoke.mjs                     # 59 个断言，约 10 秒
node test/panel-smoke.mjs                    # 105 个断言（真实仓库断言可选，见下）
node test/client-smoke.mjs                   # 18 个断言
node test/acp-smoke.mjs                      # 13 个断言：role/budget extraArgs、只读权限、fs、真实 adapter 启动失败
```

- `engine-gate`：在临时 git 仓库里直接跑引擎 gate，覆盖本地无历史/干净 → blocked（不能把没跑过当 pass）、full pass、快照不一致、incremental/fix/history 损坏/无历史有改动、Trellis pass、显式 trellis 缺 `.trellis`、range 提交区间与 dirty/head mismatch 标记、`full -Base`、截断 full pass 不过 gate、自定义 Base 的 full 不冒充收尾门禁、scope 不一致（含 dotfile / Windows 绝对路径 / 跨盘符 / 带空格 / 无扩展名 / 汉字紧贴路径 / 中文文件名正反向）、`-Head` 仅 range、gate 忽略 Base、忽略或已跟踪的本地账本都不导致快照漂移、跟踪的 review 文件不把 range 误判为 dirty、`SessionId → task.py current` 与「无活动任务不猜」。
- `engine-cache`：用编译的 fake Claude 统计真实调用次数；相同 diff/输入第二次直接 cached（0 次新调用）但会按当前快照落一条零成本 history；中间插入空 diff 轮次会清掉旧 hash，随后相同 full 重新审核，gate 能正常通过。
- `engine-round-guard`：V2 轮次门禁；未处置的 critical/important 直接拒绝新 full/range，fixed/deferred/counter-evidence 放行；跨轮 disposition、index 处置（含 null 前置时仍按 review-N.json 原始下标、报告自身 failOn）、只有 minor、上一轮 pass、没有 lastReport、gate 豁免、range 拒绝、nothing-to-review 保留 lastReport、nothing 后 fixed 放行、旧报告无 failOn 时回退默认值都覆盖；不调用模型。
- `engine-acp`：用 fake ACP agent（官方 SDK 的 agent 侧）驱动引擎 `-Transport acp` 的 full/gate，断言 `transport=acp`、报告 meta、gate 可通过；另覆盖含空格 cwd、auto→CLI、ACP 超时 fail-closed、adapter 启动即崩、bridge 启动超时仍回退 CLI 并带 `transportWarning`；不调用真实模型。
- `acp-smoke`：真实 `scripts/acp-review.mjs` + 官方 SDK + fake ACP agent，断言初始化/会话/消息/结果 envelope，reviewer role 走 `session/new` 的 systemPrompt、read 允许、edit 拒绝、fs 读 line/limit、fs 写拒绝、启动失败 exit 3；并用**真实 adapter 入口**（缺 `CLAUDE_CODE_EXECUTABLE`）断言启动失败被归类为 exit 3。
- `panel-smoke`：新增 `transportWarning` 透传与 ACP 未知成本时总成本标记为部分和；`client-smoke` 新增 `transportWarning`/部分成本渲染断言。
- `tool-smoke`：命令行构造（含 `-Storage`/`-Base`/`-Head`/`-Profile`）、`fix`/`gate-blocked` 必须 `ok=false`、`exit 2` 必须抛错、`dryRun` 透传、旧引擎回退、缓存结果、引擎缺失可诊断、Trellis/本地处置写入，以及面板路由的授权/冷启动重试/大小写比较/本地模式。
- `panel-smoke`：问题匹配、轮次聚合、处置叠加、生命周期（new/still/fixed/reopened/unreviewed + 换措辞聚类 + 空 file 无 key 保持 unknown / 有 key 仍跟踪）、缺陷全流程（issue 状态机、round 状态机、open/fixed/verified/reopened/deferred、待处置/待复检/带风险关闭、`nextAction` 的 fix/review/range、自定义 failOn、旧报告 failOn 回退、null issue 不生成幻影条目）、下一步动作（含 range、截断/自定义 Base/快照降级在 pass 与 nothing-to-review 两种状态下都重跑 full）、截断门禁、任务切换、Trellis 与本地账本、`nothing-to-review` 语义。真实仓库断言用 `CLAUDE_REVIEW_REPO=<Trellis 仓库>` 指定；未指定且包不在 Trellis 仓库内时记 SKIP。
- `client-smoke`：静态检查客户端注入、`conversation.view` 注册、原生 style 注入与路由访问边界、transport/未知成本、缺陷看板（问题/轮次状态、看板列、处置/复检提示）。

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
