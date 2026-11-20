# v3.0.0 — 改名 @hunyed15/project-cockpit：定位从"审核插件"改为"集成层"

**破坏性变更：包名与仓库名都变了。**

| 项 | 旧 | 新 |
|---|---|---|
| 包名 | `@hunyed15/claude-code-review` | **`@hunyed15/project-cockpit`** |
| 仓库 | `dsh-claude-code-review` | **`dsh-project-cockpit`**（GitHub 自动重定向旧 URL） |
| 插件行 id | `claude-code-review`（**不变**，避免 profile 里旧行悬空） | 同左 |
| 版本 | 2.2.0 | 3.0.0 |

## 为什么改名

它已经不是"审核插件"了。现在装一个包换来的是：审核引擎 + 审核工具 + 协同看板 + 项目整页 + 并行视图 + 全局提醒。名字再叫 `claude-code-review`，只会让后来的人以为它只会审核。

新的自我定义是一句话：**把已有工具产出的状态，收拢成一处可读、可行动的现场。**

## 重新梳理后的架构（设计 v2）

完整文档：[docs/specs/2026-11-20-cockpit-design-v2.md](docs/specs/2026-11-20-cockpit-design-v2.md)

```
适配器层   trellis · 审核账本 · sessions ·（将来）任务板/验收结果/外部插件
   ↓ 只读、可选、互不依赖；一个源坏了只影响它自己
归一化层   四类事实：feature / defect / gate / session（纯函数、可单测）
   ↓
视图层     下一步 + 生命周期 + 三本账 + 并行 + 数据可信度
   ↓
行动层     唯一动作 + 两步发送
```

硬约束：**视图层永远不知道数据来自哪个插件**。新增数据源 = 新增一个适配器，不动视图层。

## 这一版没有新增功能

只有改名与文档。功能与 2.2.0 一致，测试 437 条全绿。

下一步（按设计 v2 的里程碑）：

| 步 | 内容 | 状态 |
|---|---|---|
| N1 | 功能清单 + 缺陷按 `relatedFiles` 归属 + 未归属单列 | 待做 |
| N2 | 任务板接入：认领 + 写作用域 + 跨目录冲突 | 待做 |
| N3 | 行动：催一下 / 开始集成 + 集成后自动 gate | 待做 |
| N4 | 外部源（按需） | 未开始 |

## 迁移（老用户）

```powershell
# 1) 移除旧包
plugin_manager(action: "remove_bundle", target: "@hunyed15/claude-code-review")

# 2) 安装新包
plugin_manager(action: "install_bundle", target: "git+https://github.com/hunyed15/dsh-project-cockpit.git")
```

重启 DSH 后刷新页面。插件行 id 没变，所以 `cordis.patch.yml` 里的配置（enginePath / storage / transport 等）继续有效。

## 验证

- `npm test` 全绿，共 **437** 个断言。
- 真机：改名后 `install_bundle` 返回 `application: applied`；`/project-cockpit/api/panel` 与 `/workspaces` 均 200；返回体已含 `parallel` 字段；profile 依赖只剩 `@hunyed15/project-cockpit`（旧名消失，无重复别名）。

## License

MIT
