# v2.1.0 — Agent 也能读项目状态，加提醒与摘要

从社区插件 `dsh-todos`（给 Agent 一套读写待办的工具 + 侧栏面板）得到启发，补了三个东西。**没有**改成"AI 当项目经理"——这个插件的立场仍是只读派生，不另存状态。

## 新增

**1. `project_status` 工具（Host 侧，只读）**

以前只有人能看到「项目」页，Agent 得自己翻 `.trellis` 猜，口径可能和面板不一致。现在 Agent 读的是**同一份投影**：

| 参数 | 说明 |
| --- | --- |
| `cwd` | 项目根，默认会话工作目录 |
| `detail` | `true` 时附带每道阶段门的依据与全部账本异常 |

返回 `{ ok, text, project, blocking, degraded, nextAction, gates, issues, warnings }`；`text` 是分行摘要（阶段门进度、未处置阻塞那几条、下一步指令与理由）。

> 只给一个读取工具，不给七个。工具越多，模型选错的概率越大。

**2. 未处置阻塞的全局提醒**

有未处置阻塞时，`shell.overlay` 上浮一条「还有 N 条未处置阻塞 · 去看 · ×」。同一项目每小时最多一次（localStorage 节流，隐私模式下可能重复）。点「去看」直接切到「项目」页。

**3. `复制摘要`**

把当前状态生成 Markdown（卡点数、阶段门进度、下一步、待修清单、数据异常提示），贴进站会/周报。

## 修掉的一个真 bug

加提醒时用预览截图发现：**通栏与提醒没有样式**——因为 CSS 只在面板组件里渲染，用户没打开过面板时它们是裸文本。改为幂等的全局样式注入（按 id 只插一次），三个挂载点都调用。

## 保持不变的立场

`dsh-plugin-todos` 的 README 有句话说得比我们文档更狠：

> 两套 source of truth 互相追赶，最后一定有一边失真。

所以 `project_status` **只读同一份账本**，不为工具方便另存状态。驾驶舱依然不写项目里任何文件。

## 测试

`npm test` 全绿，共 **415** 个断言：

| 套件 | 断言 |
| --- | --- |
| tool-smoke / panel-smoke / client-smoke / acp-smoke | 66 / 105 / 18 / 13 |
| cockpit: count/reader/gates/next-action/panel/route/client | 118（合计） |
| engine: gate / cache / round-guard / acp | 55 / 8 / 22 / 10 |

新增覆盖：`project_status` 的注册与返回形状（P1–P6）、提醒的节流键与「去看」跳转、摘要生成与复制按钮。

## 兼容性

- 无破坏性变更；升级只需重装 + 重启 DSH（Host 侧多注册了一个工具）。
- 账本格式、引擎契约（`# claude-review-api: 3`）均未变。

## 仍未验证

- 颜色对比度（预览用近似主题变量，需真机）。
- `blocking > 0` 在真实账本上的显示（本机历史审核全 pass）。

## License

MIT
