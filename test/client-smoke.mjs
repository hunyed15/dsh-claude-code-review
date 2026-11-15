/**
 * 客户端模块的静态自测（不启动浏览器，约 1 秒）。
 *
 * 为什么需要它：`client.js` 只能在 Web 页面里真正执行，Node 里跑不了。
 * 但历史上正是这里出过一次线上故障——把模块级 builtin `styles` 写进 cordis
 * 的 `inject` 列表，导致插件激活失败、整个 bundle 都挂掉（连 Host 工具一起消失）。
 * 这类错误用静态断言就能挡住，不必等重启才发现。
 *
 * 当前 DSH 的官方客户端包直接往 document.head 插 <style>；`styles` builtin
 * 在本运行时没有生效，所以样式改为原生 style 标签注入（C9）。
 *
 * 用法：从本包目录运行 `node test/client-smoke.mjs`。
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = dirname(HERE)
const CLIENT = join(PACKAGE_DIR, 'client.js')

const source = await readFile(CLIENT, 'utf8')

let passed = 0
const failures = []

function check(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`PASS  ${name}`)
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// 1. 只注入真实存在的 cordis 服务（slots）；styles / React / host / console 都是模块级 builtin
{
  const match = source.match(/inject:\s*\[([^\]]*)\]/)
  const declared = match ? match[1].split(',').map((part) => part.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : []
  check('C1 声明了 inject', declared.length > 0, String(declared))
  check('C2 只注入 slots', declared.length === 1 && declared[0] === 'slots', declared.join(','))
  check('C3 未把 styles 写进 inject', !declared.includes('styles'), declared.join(','))
  check('C4 不访问 ctx.styles', !source.includes('ctx.styles'), 'found ctx.styles')
}

// 2. 注册目标与标识
{
  check('C5 注册到 conversation.view', source.includes("'conversation.view'"), 'missing slot name')
  check('C6 视图 id 为 collab', /id:\s*'collab'/.test(source), 'missing id collab')
  check('C7 提供 label', /label:\s*\(\)\s*=>/.test(source) || /label:\s*'/.test(source), 'missing label')
  check('C8 模块 id 与包名一致', source.includes("id: '@local/claude-code-review'"), 'module id mismatch')
}

// 3. 样式注入：直接插原生 <style>，不依赖 styles builtin
{
  const directStyle = /document\.createElement\(['"]style['"]\)/.test(source)
  const tagged = source.includes('dataset.pluginCss') && source.includes('document.head.appendChild')
  check('C9 用原生 style 标签注入样式', directStyle && tagged, 'no direct style injection')
}

// 4. 读数据只走自己的 Host 路由，不直连磁盘/别的服务
{
  check('C10 只 fetch 自己的面板路由', source.includes('/claude-review/api/panel'), 'missing panel route')
  check('C11 不引用 node 内置模块', !/from 'node:/.test(source) && !/require\('node:/.test(source), 'node builtin import in client')
  check('C12 轮次显示 transport 与未知成本', source.includes('crc-round-transport') && source.includes("'成本 —'"), 'missing transport/cost rendering')
  check('C13 显示 transportWarning 与部分成本', source.includes('crc-round-warning') && source.includes('累计 ≥'), 'missing warning/partial total')
  check('C14 全未知成本不显示 $0.00', source.includes("totalKnown ? '$0.00' : '成本 —'"), 'unknown cost still $0.00')
}

// 5. 缺陷全流程看板（issue 状态、round 状态、board、下一步处置）
{
  check(
    'C15 有 issue 状态映射',
    source.includes('ISSUE_STATUS_META') && source.includes('待复检') && source.includes('复现'),
    'missing issue status meta',
  )
  check(
    'C16 有 round 状态映射',
    source.includes('ROUND_STATUS_META') && source.includes('待处置') && source.includes('已关闭'),
    'missing round status meta',
  )
  check('C17 有 board 列', source.includes('crc-board') && source.includes('crc-board-col'), 'missing board')
  check(
    'C18 下一步提示处置与复检',
    source.includes('claude_review_disposition') && source.includes('复检本轮修复'),
    'missing dispose/review action',
  )
}

console.log('')
console.log(`结果: passed=${passed} failed=${failures.length}`)
for (const failure of failures) console.log(`  FAIL ${failure}`)
process.exit(failures.length > 0 ? 1 : 0)
