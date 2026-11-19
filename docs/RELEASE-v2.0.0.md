# v2.0.0 — 审核与项目驾驶舱合并为一个插件

**破坏性变更**：原先独立的 `@hunyed15/project-cockpit` 已并入本包，不再单独维护。**不要同时安装两个**——它们都注册同一个面板 id `project-cockpit`，会互相顶掉。

## 升级步骤

```powershell
# 1) 先移除旧的驾驶舱插件（只装本包的可以跳过）
plugin_manager(action: "remove_bundle", target: "@hunyed15/project-cockpit")

# 2) 重新安装本包
plugin_manager(action: "install_bundle", target: "git+https://github.com/hunyed15/dsh-claude-code-review.git#v2.0.0")

# 3) 重启 DSH（Host 侧路由变了），然后刷新页面
```

## 这个版本带来什么

一个插件、两个只读界面、三个工具：

| 入口 | 内容 |
|---|---|
| 工具 `claude_review` / `claude_review_disposition` / `claude_review_install_hook` | 独立只读审核、处置记录、安装 pre-commit hook |
| 会话内「协同」tab（`conversation.view`，id=`collab`） | 审核轮次与缺陷生命周期看板 |
| 左侧栏「项目」整页（`main` + `sidebar.panellist`，id=`project-cockpit`） | 到哪了 / 卡在哪 / 下一步做什么 |
| 输入框上方通栏（`conversation.input.dock`） | 把「下一步」交给当前会话，两步：先看见、再发送 |

驾驶舱的行为与原 `project-cockpit@0.1.0` 一致：

- **下一步**是状态机唯一输出，含动作名、可直接执行的指令原文、理由；
- **卡在哪**列出最多 3 条未处置问题：严重度 + 标题 + `文件:行`；
- **数据不可信时整屏一起降级**：chip「状态待确认」→ 下一步「先确认数据」且主按钮禁用 → 阶段门「待确认」→ 表格 `待修` 显示 `—`（不是绿色 0）；
- 七道阶段门为推断，每道带依据；「验效果/发出去」第一版恒未完成，进度条用虚线表示"第二版才接入"。

## 兼容性

- 审核引擎未变：仍是 `# claude-review-api: 3`，被审仓库里的 `tools/claude-review/` 副本与 pre-commit hook 不受影响。
- 账本格式未变：`.trellis/tasks/<task>/review/` 与 `.dsh/claude-review/ledger/review/`。
- 新增路由：`/project-cockpit/api/{workspaces,panel}`，只接受 `workspaceRegistry` 里登记过的路径（其余 403），只读、只监听 `127.0.0.1`。
- 依赖变化：合并后安装了本包的人会同时获得 ACP 两个包（原本驾驶舱是零依赖）。这是"一个插件"的代价，已在此说明。

## 测试

按 `npm test` 顺序执行，全部通过：

| 套件 | 断言 |
|---|---|
| tool-smoke / panel-smoke / client-smoke / acp-smoke | 60 / 105 / 18 / 13 |
| cockpit: count / reader / gates / next-action / panel / route / client | 14 / 7 / 8 / 6 / 13 / 11 / 57 |
| engine: gate / cache / round-guard / acp | 55 / 8 / 22 / 10 |
| **合计** | **407** |

> 注意：不要用 `node --test`（它会并发跑那些会 spawn 子进程的 smoke 套件并卡住），用 `npm test`。

## 仍未验证

- 颜色对比度：预览用的是近似主题变量，需真机实测。
- `blocking > 0` 的真实账本显示：本机历史审核全部 pass，该路径仅由真实形状的 fixture 与预览截图覆盖。

## License

MIT
