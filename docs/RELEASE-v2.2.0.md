# v2.2.0 — 并行视图（谁在干、会不会撞）

一个 DSH 跑一个项目、前后端并行开发时，原来的面板只能回答"项目到哪了"，回答不了"**谁在干、会不会撞**"。这一版把并行区加进「项目」页。

## 先做探针，再写代码

设计前先核了宿主的四个服务（结论均已验证，不是假设）：

| 需要的 | 数据源 | 结论 |
|---|---|---|
| 项目里有哪些会话 | `sessionQuery.listSessions()` / `filterSessions([{kind:'cwd'}])` | ✅ |
| 会话父子关系 | `traceSession(id)` → ancestors + descendants | ✅ |
| 会话在哪个目录 | `SessionHeader.cwd` / `parentSession` / `origin` / `delegationDepth` | ✅ |
| 标题 | `sessionQuery.readTitleSnapshots(ids)`（批量） | ✅ |
| 谁在跑 | `ctx.sessions.list()`（内存态） | ✅ |
| worktree 列表 | `ctx.worktrees` 只有 create/restore/cleanupOf，**没有 list** | ⚠️ 从 `cwd` 反推 |
| 任务认领/写作用域 | `agentTeams.listTasks(caller)` | ⚠️ 需要活着的 Lead Agent → 留到 P2 |

探针直接决定了设计：**不猜 worktree、不硬拿任务板**，先做纯只读的会话视图。

## 新增：并行区

面板新增一张卡，回答"这个项目现在有几个会话、各在哪个目录、谁还活着"：

```
并行 · 3 个在跑 / 共 4 个会话
⚠ 1 处同目录并行，可能互相覆盖：主工作区
会话            目录                      状态      创建于
后端 · 订单接口   主工作区                   运行中    13:40:55
前端 · 订单页面   claude-code-review-web    运行中    14:10:55
集成 · 合并与门禁  主工作区                   运行中    14:30:55
s4              主工作区                   已停止    14:38:55
```

- **范围**：只列本项目会话——`cwd` 在项目根下，或父会话在项目根下（worktree 会话属于后者）。
- **撞车预警**：两个"运行中"的会话落在同一目录 → 横幅点名，因为同目录并行改同一份文件必然互相覆盖。
- **状态以内存 store 为准**：`ctx.sessions.list()` 比持久化记录更能反映"现在活着"。
- **降级**：profile 没有 `sessionQuery` 时，该区显示原因，面板其余部分照常。

## 如实标注的边界

- **worktree 是从 `cwd` 反推的，不跑 git**，所以界面写"其他目录"而不是"worktree"——不假装能判定。
- **写作用域级别的冲突**（两个会话改同一文件但目录不同）要等任务板接入，属于 P2。
- 子代理树的 `running/inactive` 已经有 `subagents.listDescendants` 可用，本版先用"会话是否活着"，下版细化。

## 落地路线（已定）

| 阶段 | 内容 | 状态 |
|---|---|---|
| P1 | 会话树 + 目录 + 活否 + 标题 + 撞车预警 | **本版** |
| P2 | 接 Agent Teams 任务板：认领/写作用域/跨目录冲突 | 待做 |
| P3 | 动作：催一下 / 开始集成 + 集成后自动跑 gate | 待做 |

派活方式已定为 **Agent Teams 任务板**（`team_task_create` 带 `write_scopes` + `blocked_by`，teammate 认领），P2 才能靠 `owner` 名字把"会话 ↔ 任务"对上。

## 测试

`npm test` 全绿，共 **437** 个断言：

| 套件 | 断言 |
|---|---|
| tool-smoke / panel-smoke / client-smoke / acp-smoke | 76 / 105 / 18 / 13 |
| cockpit（含 sessions 9 条新断言） | 130 |
| engine: gate / cache / round-guard / acp | 55 / 8 / 22 / 10 |

新增覆盖：并行视图的归属判定（worktree 会话靠父会话归属）、排序、live 计数、截断、撞车检测，以及"缺 sessionQuery 时如实降级"。

## 升级

```powershell
plugin_manager(action: "install_bundle", target: "git+https://github.com/hunyed15/dsh-claude-code-review.git#v2.2.0")
```

重启 DSH 后刷新页面。

## License

MIT
