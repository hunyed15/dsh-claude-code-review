# v2.1.1 — 修复 v2.1.0 导致的插件无法激活

**v2.1.0 装上去是坏的**：插件完全没起来，左侧栏「项目」和「协同」面板全部 404，`claude_review` 等工具也一起消失。请升级到本版本。

## 根因

v2.1.0 新增的 `project_status` 工具漏了 DSH 要求的 `output` 声明：

```
TypeError: tool "project_status" must declare output { schema, render, presentationMeta? }
```

DSH 在激活插件时校验工具契约，**一个工具不合规就会让整个插件激活失败**——所以不是"新功能不可用"，而是这个包的全部能力（工具 + 两个面板 + 两条路由）都不存在。表现出来就是点「项目」404。

## 修复

给 `project_status` 补上 `output: { schema, render }`，并新增一条断言守住它（`P1b 声明了 output.schema 与 render`）。

## 顺带修的安装状态问题

排查过程中发现 profile 里有两个 bundle 指向同一个包（`@local/claude-code-review` 与 `@hunyed15/claude-code-review`），行 id 重复。已清理，现在只剩 `@hunyed15/claude-code-review`。

## 值得记住的一条

**工具契约错误会让整个插件静默失效。** 加工具时不能只测 `execute()`，还必须确认它满足注册契约——`npm test` 里的 smoke 是直接调 `execute` 的，这类问题它抓不到。以后凡是新增工具，都要在真机上确认插件 `application: applied`，并且 `listTools` 里能看到。

## 升级

```powershell
plugin_manager(action: "install_bundle", target: "git+https://github.com/hunyed15/dsh-claude-code-review.git#v2.1.1")
```

然后重启 DSH。

## 验证

- `npm test` 全绿，共 **416** 个断言。
- 真机核对：`/project-cockpit/api/panel` → 200（blocking 0、taskCount 1、7 道门、next=verify-gate）；`listTools` 里 `claude_review` / `claude_review_disposition` / `project_status` / `claude_review_install_hook` 齐全。
- `/claude-review/api/panel` 无 `sessionId` 时返回 404 `session-not-resolved` 是**设计如此**，不是故障。

## License

MIT
