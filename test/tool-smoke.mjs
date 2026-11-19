/**
 * claude_review / claude_review_disposition 工具的确定性自测（不调用模型，约 5 秒）。
 *
 * 用假的 ctx 直接驱动插件导出的 apply()：
 *   A. 命令行构造：`-Command` + UTF-8 前置段、参数名裸写、超时接线、SessionId 透传
 *   B. verdict=fix 的 envelope 必须 ok=false
 *   C. gate blocked 必须 ok=false 且保留 reason
 *   D. exit 2 必须抛错并带原因
 *   E. dryRun 必须标成 dry-run
 *   F. 引擎缺失必须抛出可诊断错误
 *   G. 处置工具：批量写入 / 单条写入 / 非法输入拒绝
 *   H.（可选）真实 spawn 引擎跑一次 gate：用临时 git 仓库；沙箱内 Node 管道 spawn 会 EPERM，此时记 SKIP
 *   I. sessionId → 项目目录解析
 *   J/K/N. 面板路由：路径授权 / 冷启动重试 / 大小写比较（全部用临时 Trellis fixture，不依赖包所在布局）
 *
 * 用法：从本包目录运行 `node test/tool-smoke.mjs`。
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply, resolveCwdForSession } from '../index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = dirname(HERE)
// A–E 只把它当普通 cwd；涉及真实项目的用例都用临时 fixture，避免绑死包所在布局。
const REPO = dirname(dirname(PACKAGE_DIR))

let passed = 0
const failures = []
const skipped = []

function check(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`PASS  ${name}`)
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function cannedSpawn(stdout, exitCode, collector) {
  return (spec) => {
    if (collector) collector.argv = spec.argv
    return {
      collected: {
        stdout: { readFrom: () => ({ text: stdout, nextOffset: 0, lossy: false }) },
        stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
      },
      done: Promise.resolve({ exitCode, signal: null }),
      terminate() {},
    }
  }
}

function realSpawn(spec) {
  const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, windowsHide: true })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8')
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8')
  })
  const done = new Promise((resolve) => {
    child.on('close', (exitCode) => resolve({ exitCode, signal: null }))
  })
  return {
    collected: {
      stdout: { readFrom: () => ({ text: stdout, nextOffset: 0, lossy: false }) },
      stderr: { readFrom: () => ({ text: stderr, nextOffset: 0, lossy: false }) },
    },
    done,
    terminate() {
      child.kill()
    },
  }
}

// 自包含的 Trellis 项目 fixture：J/K/N 用它当“会话所属项目”，不依赖本包放在哪个仓库。
async function makeTrellisProject(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const taskDir = join(root, '.trellis', 'tasks', 'demo')
  const reviewDir = join(taskDir, 'review')
  await mkdir(reviewDir, { recursive: true })
  await writeFile(join(taskDir, 'task.json'), JSON.stringify({ title: '演示任务', status: 'in_progress' }))
  await writeFile(
    join(reviewDir, 'history.jsonl'),
    JSON.stringify({
      at: '2026-11-12T10:00:00',
      round: 1,
      mode: 'full',
      verdict: 'pass',
      critical: 0,
      important: 0,
      minor: 0,
      files: 1,
    }) + '\n',
  )
  await writeFile(
    join(reviewDir, 'review-1.json'),
    JSON.stringify({ meta: { round: 1, mode: 'full', session: { id: 'session-panel' } }, review: { verdict: 'pass', summary: 'ok', issues: [] } }),
  )
  return root
}

function initGitRepo(dir) {
  const result = spawnSync('git', ['-C', dir, 'init', '-q'], { stdio: 'ignore', windowsHide: true })
  return result.status === 0
}

async function makeLocalProject(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const ledger = join(root, '.dsh', 'claude-review', 'ledger')
  const review = join(ledger, 'review')
  await mkdir(review, { recursive: true })
  await writeFile(join(ledger, 'task.json'), JSON.stringify({ id: 'local', name: 'local', title: '本地项目', status: 'in_progress' }))
  await writeFile(
    join(review, 'history.jsonl'),
    JSON.stringify({ at: '2026-11-12T10:00:00', round: 1, mode: 'full', verdict: 'pass', critical: 0, important: 0, minor: 0, files: 1 }) + '\n',
  )
  await writeFile(join(review, 'review-1.json'), JSON.stringify({ meta: {}, review: { verdict: 'pass', summary: 'ok', issues: [] } }))
  return root
}

function makeCtx(spawnImpl, pluginConfig = {}, services = {}) {
  const tools = new Map()
  const ctx = {
    effect(fn) {
      return fn()
    },
    get(service) {
      return services[service]
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => {}
      },
    },
    subprocess: {
      async resolveExecutable(command) {
        return command
      },
      spawn(spec) {
        return spawnImpl(spec)
      },
    },
  }
  apply(ctx, pluginConfig)
  return tools
}

const exec = (agentId) => ({ signal: undefined, agent: agentId ? { id: agentId } : undefined })

// A. 命令行构造
{
  const collector = {}
  const tools = makeCtx(cannedSpawn('{"ok":true,"verdict":"pass","mode":"full"}', 0, collector))
  const tool = tools.get('claude_review')
  await tool.execute({ mode: 'gate', cwd: REPO, description: '带 中文 的描述', checks: ['a b', '第二项'] }, exec('session-abc'))
  const argv = collector.argv ?? []
  const line = argv.join(' ')
  check('A1 使用 -Command', argv.includes('-Command'))
  check('A2 含 UTF-8 前置段', line.includes('[Console]::OutputEncoding'))
  check('A3 参数名未被引号包裹', !line.includes("'-Mode'"), line.slice(0, 200))
  check('A4 超时已接线', line.includes('-TimeoutSec'))
  check('A5 值被单引号包裹', line.includes("'gate'") && line.includes("'带 中文 的描述'"))
  check('A6 SessionId 透传', line.includes("-SessionId 'session-abc'"), line.slice(0, 240))
  check("A7 多个 checks 合并成一个数组实参", line.includes("-Checks 'a b','第二项'"), line.slice(0, 260))
  check('A8 Storage 透传', line.includes("-Storage 'auto'"), line.slice(0, 260))
}

// A9. range / Base / Head 透传
{
  const collector = {}
  const tools = makeCtx(cannedSpawn('{"ok":true,"dryRun":true,"mode":"range"}', 0, collector))
  const tool = tools.get('claude_review')
  await tool.execute({ mode: 'range', cwd: REPO, base: 'HEAD~1', head: 'HEAD', dryRun: true }, exec())
  const line = (collector.argv ?? []).join(' ')
  check("A9 range/Base/Head 透传", line.includes("-Mode 'range'") && line.includes("-Base 'HEAD~1'") && line.includes("-Head 'HEAD'"), line.slice(0, 300))
}

// A10. profile 透传
{
  const collector = {}
  const tools = makeCtx(cannedSpawn('{"ok":true,"dryRun":true,"mode":"full"}', 0, collector))
  const tool = tools.get('claude_review')
  await tool.execute({ mode: 'full', cwd: REPO, profile: 'deep', dryRun: true }, exec())
  const line = (collector.argv ?? []).join(' ')
  check("A10 profile 透传", line.includes("-Profile 'deep'"), line.slice(0, 300))
}

// B. verdict=fix 必须 ok=false
{
  const envelope = JSON.stringify({ ok: true, mode: 'full', verdict: 'fix', critical: 1, important: 0, minor: 0, summary: 'x', report: 'r.json' })
  const tool = makeCtx(cannedSpawn(envelope, 1)).get('claude_review')
  const result = await tool.execute({ mode: 'full', cwd: REPO }, exec())
  check('B1 fix: ok=false', result.ok === false, `ok=${result.ok}`)
  check('B2 fix: 计数保留', result.critical === 1)
  check('B3 fix: note 提示必须先修', String(result.note).includes('必须先修'), String(result.note))
}

// C. gate blocked
{
  const envelope = JSON.stringify({ ok: false, gate: 'blocked', reasons: ['快照不一致'] })
  const tool = makeCtx(cannedSpawn(envelope, 1)).get('claude_review')
  const result = await tool.execute({ mode: 'gate', cwd: REPO }, exec())
  check('C1 gate: ok=false', result.ok === false)
  check('C2 gate: verdict=gate-blocked', result.verdict === 'gate-blocked', result.verdict)
  check('C3 gate: reason 透传', String(result.note).includes('快照不一致'), String(result.note))
}

// D. exit 2 抛错
{
  const tool = makeCtx(cannedSpawn(JSON.stringify({ ok: false, error: '审核超时（>1500s）' }), 2)).get('claude_review')
  let message = ''
  try {
    await tool.execute({ mode: 'full', cwd: REPO }, exec())
  } catch (error) {
    message = String(error?.message ?? error)
  }
  check('D1 exit2 抛错', message.includes('审核未完成'), message)
  check('D2 exit2 带原因', message.includes('审核超时'), message)
}

// E. dryRun
{
  const envelope = JSON.stringify({ ok: true, dryRun: true, mode: 'full', files: 3, diffChars: 120 })
  const tool = makeCtx(cannedSpawn(envelope, 0)).get('claude_review')
  const result = await tool.execute({ mode: 'full', cwd: REPO, dryRun: true }, exec())
  check('E1 dryRun: verdict=dry-run', result.verdict === 'dry-run', result.verdict)
  check('E2 dryRun: dryRun=true', result.dryRun === true)
}

// F. 引擎缺失
{
  const empty = await mkdtemp(join(tmpdir(), 'no-engine-'))
  const tool = makeCtx(cannedSpawn('{}', 0), { allowBundledFallback: false }).get('claude_review')
  let message = ''
  try {
    await tool.execute({ mode: 'gate', cwd: empty }, exec())
  } catch (error) {
    message = String(error?.message ?? error)
  }
  check('F1 引擎缺失可诊断', message.includes('找不到审核引擎'), message)
  await rm(empty, { recursive: true, force: true })
}

// G. 处置工具
{
  const root = await mkdtemp(join(tmpdir(), 'crc-disp-'))
  const reviewDir = join(root, '.trellis', 'tasks', '11-12-demo', 'review')
  const taskDir = join(root, '.trellis', 'tasks', '11-12-demo')
  await mkdir(reviewDir, { recursive: true })
  await writeFile(join(root, '.trellis', 'tasks', '11-12-demo', 'task.json'), JSON.stringify({ id: 'demo', title: '演示', status: 'in_progress' }))
  const tools = makeCtx(cannedSpawn('{}', 0))
  const tool = tools.get('claude_review_disposition')
  check('G0 处置工具已注册', tool !== undefined)

  const batch = await tool.execute(
    {
      cwd: root,
      taskDir,
      entries: [
        { round: 3, key: 'aaa1', status: 'fixed', note: '已修空指针' },
        { round: 3, index: 2, status: 'deferred', note: '设计如此，下一版再说' },
      ],
    },
    exec('session-abc'),
  )
  check('G1 批量写入 2 条', batch.written === 2, JSON.stringify(batch))
  const written = (await readFile(join(reviewDir, 'dispositions.jsonl'), 'utf8')).trim().split('\n')
  check('G2 文件里确有 2 行', written.length === 2)
  const parsed = JSON.parse(written[0])
  check('G3 记录带 sessionId', parsed.sessionId === 'session-abc')
  check('G4 记录带 status', parsed.status === 'fixed')

  const single = await tool.execute({ cwd: root, taskDir, round: 3, key: 'bbb2', status: 'counter-evidence' }, exec())
  check('G5 单条写入', single.written === 1, JSON.stringify(single))

  let rejected = ''
  try {
    await tool.execute({ cwd: root, entries: [] }, exec())
  } catch (error) {
    rejected = String(error?.message ?? error)
  }
  check('G6 空输入被拒', rejected.includes('需要 entries'), rejected)

  await rm(root, { recursive: true, force: true })
}

// O. 本地账本处置：没有 .trellis 时写到 .dsh/claude-review/ledger
{
  const root = await makeLocalProject('crc-local-disposition-')
  const tools = makeCtx(cannedSpawn('{}', 0))
  const tool = tools.get('claude_review_disposition')
  const result = await tool.execute({ cwd: root, round: 1, key: 'aaa', status: 'fixed', note: '本地处置' }, exec('session-local'))
  check('O1 本地处置写入', result.ok === true && result.written === 1, JSON.stringify(result))
  check('O2 本地账本路径', result.taskDir === join(root, '.dsh', 'claude-review', 'ledger'), result.taskDir)
  const rows = (await readFile(join(root, '.dsh', 'claude-review', 'ledger', 'review', 'dispositions.jsonl'), 'utf8')).trim().split('\n')
  check('O3 本地处置落盘', rows.length === 1 && JSON.parse(rows[0]).key === 'aaa')
  await rm(root, { recursive: true, force: true })
}

// P. 目标仓库旧引擎：没有 claude-review-api 标记时必须回退自带引擎并给出可见 warning
{
  const root = await mkdtemp(join(tmpdir(), 'crc-old-engine-'))
  const engineDir = join(root, 'tools', 'claude-review')
  await mkdir(engineDir, { recursive: true })
  await writeFile(join(engineDir, 'Invoke-ClaudeReview.ps1'), "param([string]$Mode = 'full')\n")
  const envelope = JSON.stringify({ ok: true, dryRun: true, mode: 'full', storage: 'local', files: 1, diffChars: 10 })
  const tool = makeCtx(cannedSpawn(envelope, 0)).get('claude_review')
  const result = await tool.execute({ mode: 'full', cwd: root, dryRun: true }, exec())
  check('P1 旧目标引擎回退自带引擎', result.engineSource === 'bundled', JSON.stringify(result))
  check('P2 回退 warning 可见', String(result.note).includes('回退') || String(result.engineWarning).includes('回退'), String(result.note))
  await rm(root, { recursive: true, force: true })
}

// Q. 完全相同输入的缓存结果：cached=true，成本 0
{
  const envelope = JSON.stringify({
    ok: true,
    cached: true,
    verdict: 'pass',
    mode: 'full',
    critical: 0,
    important: 0,
    minor: 0,
    round: 1,
    report: 'r.json',
    cost_usd: 0,
    note: '复用与上次完全相同的 diff/输入，未调用模型',
  })
  const tool = makeCtx(cannedSpawn(envelope, 0)).get('claude_review')
  const result = await tool.execute({ mode: 'full', cwd: REPO }, exec())
  check('Q1 cached=true', result.cached === true)
  check('Q2 cached 成本为 0', result.costUsd === 0)
  check('Q3 cached 说明可见', String(result.note).includes('复用'), String(result.note))
}

// H. 可选：真实 spawn（沙箱内 EPERM 记 SKIP）；用临时 git 仓库，不依赖包所在布局
{
  const root = await mkdtemp(join(tmpdir(), 'crc-real-'))
  let result
  if (!initGitRepo(root)) {
    skipped.push('H 真实 spawn（git init 失败，跳过）')
    console.log('SKIP  H 真实 spawn 引擎（git init 失败）')
  } else {
    const tool = makeCtx(realSpawn).get('claude_review')
    try {
      result = await tool.execute({ mode: 'gate', cwd: root }, exec())
    } catch (error) {
      if (error?.code === 'EPERM') {
        skipped.push('H 真实 spawn（沙箱内 Node 管道 spawn 被拒，属已知边界；沙箱外可覆盖）')
        console.log('SKIP  H 真实 spawn 引擎（EPERM，沙箱边界）')
      } else {
        throw error
      }
    }
    if (result) {
      check('H1 真实 gate 返回结论', ['gate-pass', 'gate-blocked'].includes(result.verdict), result.verdict)
      check('H2 无替换字符', !String(result.note).includes('\uFFFD'))
    }
  }
  await rm(root, { recursive: true, force: true })
}

// I. sessionId → 项目目录解析（多候选 + 只在有 .trellis 时采用）
{
  const root = await mkdtemp(join(tmpdir(), 'crc-cwd-'))
  await mkdir(join(root, '.trellis'), { recursive: true })
  const agent = { id: 'session-xyz' }
  const ctxWith = (wd) => ({
    get: (service) =>
      service === 'agents' ? { get: () => agent, list: () => [agent] } : service === 'workingDirectory' ? wd : undefined,
  })
  const good = await resolveCwdForSession(ctxWith({ get: () => root, defaultDirectory: '' }), 'session-xyz')
  check('I1 按会话解析到项目目录', good === root, good)
  const strict = await resolveCwdForSession(
    ctxWith({
      get: () => {
        throw new Error('boom')
      },
      defaultDirectory: root,
    }),
    'session-xyz',
  )
  check('I2 会话解析失败时默认不回退默认工作区', strict === '', strict)
  const optedIn = await resolveCwdForSession(
    ctxWith({ get: () => { throw new Error('boom') }, defaultDirectory: root }),
    'session-xyz',
    { fallbackToDefaultWorkspace: true },
  )
  check('I2b 显式开启回退时才用 defaultDirectory', optedIn === root, optedIn)
  const empty = await resolveCwdForSession({ get: () => undefined }, 'session-xyz')
  check('I3 什么服务都没有时返回空串', empty === '', empty)
  const plain = await mkdtemp(join(tmpdir(), 'crc-local-cwd-'))
  const local = await resolveCwdForSession(ctxWith({ get: () => plain, defaultDirectory: '' }), 'session-xyz')
  check('I4 无 .trellis 的普通目录按本地项目解析', local === plain, local)
  await rm(plain, { recursive: true, force: true })
  await rm(root, { recursive: true, force: true })
}

// P. project_status：Agent 读到的必须是和侧栏「项目」页同一份投影
{
  const project = await makeTrellisProject('crc-status-project-')
  try {
    const services = { workingDirectory: { get: () => project, defaultDirectory: project } }
    const tools = makeCtx(cannedSpawn('{}', 0), {}, services)
    const tool = tools.get('project_status')
    check('P1 注册了 project_status 工具', Boolean(tool))
    // DSH 要求工具声明 output { schema, render }，否则整个插件激活失败（v2.1.0 曾因此 404）
    check('P1b 声明了 output.schema 与 render', typeof tool?.output?.schema === 'object' && typeof tool?.output?.render === 'function')
    const out = await tool.execute({}, exec('session-status'))
    check(
      'P2 返回 ok/blocking/text',
      out?.ok === true && out.blocking === 0 && typeof out.text === 'string',
      JSON.stringify(out).slice(0, 160),
    )
    check('P3 文本含下一步与理由', out.text.includes('下一步：') && out.text.includes('理由：'))
    check('P4 七道阶段门齐全', Array.isArray(out.gates) && out.gates.length === 7, String(out.gates?.length))
    const detail = await tool.execute({ detail: true }, exec('session-status'))
    check('P5 detail 展开每道门依据', detail.text.includes('阶段门依据：'))
    check('P6 不写任何文件', out.ok === true)
  } finally {
    await rm(project, { recursive: true, force: true })
  }
}

// J. 面板路由：路径授权 / 正常返回 / 未知路径（临时 Trellis fixture）
{
  const project = await makeTrellisProject('crc-panel-project-')
  let captured = null
  const registeredPaths = []
  const agent = { id: 'session-panel' }
  const services = {
    webServer: {
      register(route) {
        registeredPaths.push(route.path)
        // 现在同一次 apply 会注册两条前缀路由，测试只认审核面板那条；
        // 驾驶舱路由另用 J0b 单独断言，避免"最后注册者获胜"掩盖问题。
        if (route.path === '/claude-review/api') captured = route
        return () => {}
      },
    },
    agents: { get: (id) => (id === 'session-panel' ? agent : undefined), list: () => [agent] },
    workingDirectory: { get: () => project, defaultDirectory: project },
  }
  makeCtx(cannedSpawn('{}', 0), {}, services)
  check('J0 注册了面板路由', captured !== null && captured.path === '/claude-review/api')
  check(
    'J0b 同时注册了项目驾驶舱路由',
    registeredPaths.includes('/project-cockpit'),
    registeredPaths.join(','),
  )

  const call = async (query) => {
    const response = await captured.resource(new Request(`http://127.0.0.1/claude-review/api/panel${query}`))
    const body = await response.json().catch(() => null)
    return { status: response.status, body }
  }

  const bySession = await call('?sessionId=session-panel')
  check('J1 按 sessionId 返回项目数据', bySession.status === 200 && bySession.body?.ok === true, JSON.stringify(bySession.body).slice(0, 200))
  check('J2 数据含轮次', Array.isArray(bySession.body?.active?.rounds), 'no rounds')

  const denied = await call(`?cwd=${encodeURIComponent('C:\\Windows')}`)
  check('J3 跨项目 cwd 被拒 403', denied.status === 403 && denied.body?.error === 'cwd-not-allowed', JSON.stringify(denied))

  const sameProject = await call(`?sessionId=session-panel&cwd=${encodeURIComponent(project)}`)
  check('J4 与会话项目一致的 cwd 放行', sameProject.status === 200 && sameProject.body?.ok === true, JSON.stringify(sameProject.body).slice(0, 160))

  const missing = await captured.resource(new Request('http://127.0.0.1/claude-review/api/nope'))
  check('J5 未知子路径 404', missing.status === 404)

  const unknownSession = await captured.resource(new Request('http://127.0.0.1/claude-review/api/panel?sessionId=session-unknown'))
  check('J6 无效 sessionId 拒绝且不回落默认项目', unknownSession.status === 404, String(unknownSession.status))

  const localProject = await makeLocalProject('crc-local-route-')
  let localCaptured = null
  const localServices = {
    webServer: {
      register(route) {
        if (route.path === '/claude-review/api') localCaptured = route
        return () => {}
      },
    },
    agents: { get: (id) => (id === 'session-panel' ? agent : undefined), list: () => [agent] },
    workingDirectory: { get: () => localProject, defaultDirectory: localProject },
  }
  makeCtx(cannedSpawn('{}', 0), {}, localServices)
  const localResponse = await localCaptured.resource(
    new Request('http://127.0.0.1/claude-review/api/panel?sessionId=session-panel'),
  )
  const localBody = await localResponse.json().catch(() => null)
  check(
    'J7 本地模式路由',
    localResponse.status === 200 && localBody?.storage === 'local' && localBody?.active?.task?.title === '本地项目',
    JSON.stringify(localBody).slice(0, 200),
  )
  await rm(localProject, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
}
// K. 冷启动竞态：webServer 晚到，靠有限重试补上（不依赖任何动态注入 API）
{
  const project = await makeTrellisProject('crc-retry-project-')
  let captured = null
  let calls = 0
  const webServer = { register(route) { if (route.path === '/claude-review/api') captured = route; return () => {} } }
  const agent = { id: 'session-panel' }
  const services = {
    agents: { get: (id) => (id === 'session-panel' ? agent : undefined), list: () => [agent] },
    workingDirectory: { get: () => project, defaultDirectory: project },
  }
  const ctx = {
    effect: (fn) => fn(),
    get: (name) => {
      if (name !== 'webServer') return services[name]
      calls += 1
      return calls >= 3 ? webServer : undefined // 前两次拿不到，模拟冷启动
    },
    tools: { register: () => () => {} },
    subprocess: { resolveExecutable: async (c) => c, spawn: () => ({ collected: {}, done: Promise.resolve({ exitCode: 0 }), terminate() {} }) },
  }
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  apply(ctx, { panelRetryMs: 10, panelRetryAttempts: 6, panelWatchdogMs: 40 })
  await new Promise((resolve) => setTimeout(resolve, 120))
  console.warn = originalWarn
  check('K0 重试成功后无假告警', !warnings.some((line) => line.includes('未注册成功')), warnings.join(' | '))
  check('K1 webServer 晚到时经重试注册路由', captured !== null && captured.path === '/claude-review/api')
  if (captured) {
    const response = await captured.resource(new Request('http://127.0.0.1/claude-review/api/panel?sessionId=session-panel'))
    check('K2 重试注册后路由可用', response.status === 200, String(response.status))
  }
  await rm(project, { recursive: true, force: true })
}

// L. webServer 始终缺失：工具照常注册，面板安静降级但留下日志
{
  const tools = new Map()
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    const ctx = {
      effect: (fn) => fn(),
      get: () => undefined,
      tools: { register: (def) => { tools.set(def.name, def); return () => {} } },
      subprocess: { resolveExecutable: async (c) => c, spawn: () => ({ collected: {}, done: Promise.resolve({ exitCode: 0 }), terminate() {} }) },
    }
    apply(ctx, { panelRetryMs: 5, panelRetryAttempts: 2 })
    await new Promise((resolve) => setTimeout(resolve, 80))
    check('L1 面板缺失时两个工具仍注册', tools.has('claude_review') && tools.has('claude_review_disposition'))
    check('L2 降级有可观测日志', warnings.some((line) => line.includes('协同面板') || line.includes('webServer')), warnings.join(' | '))
  } finally {
    console.warn = originalWarn
  }
}
// K3. 生产路径：ctx.inject 存在时，由回调提供的 scope 完成注册
{
  let captured = null
  const webServer = { register(route) { if (route.path === '/claude-review/api') captured = route; return () => {} } }
  const agent = { id: 'session-panel' }
  const services = {
    agents: { get: (id) => (id === 'session-panel' ? agent : undefined), list: () => [agent] },
    workingDirectory: { get: () => REPO, defaultDirectory: REPO },
  }
  const ctx = {
    effect: (fn) => fn(),
    get: (name) => services[name],
    tools: { register: () => () => {} },
    subprocess: { resolveExecutable: async (c) => c, spawn: () => ({ collected: {}, done: Promise.resolve({ exitCode: 0 }), terminate() {} }) },
    inject: (_deps, cb) => cb({ effect: (fn) => fn(), webServer, get: (name) => services[name] }),
  }
  apply(ctx, {})
  await new Promise((resolve) => setTimeout(resolve, 20))
  check('K3 inject 回调路径完成注册', captured !== null && captured.path === '/claude-review/api')
}

// M. inject 存在但回调永不触发：看门狗必须留下可观测告警（不静默）
{
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    const ctx = {
      effect: (fn) => fn(),
      get: () => undefined,
      tools: { register: () => () => {} },
      subprocess: { resolveExecutable: async (c) => c, spawn: () => ({ collected: {}, done: Promise.resolve({ exitCode: 0 }), terminate() {} }) },
      inject: () => {}, // 永不回调
    }
    apply(ctx, { panelWatchdogMs: 20 })
    await new Promise((resolve) => setTimeout(resolve, 80))
    check('M1 回调不触发时看门狗告警', warnings.some((line) => line.includes('未注册成功')), warnings.join(' | '))
  } finally {
    console.warn = originalWarn
  }
}

// N. Windows 下 cwd 比较大小写不敏感（否则同项目会被 403）
if (process.platform === 'win32') {
  const project = await makeTrellisProject('crc-case-project-')
  let captured = null
  const webServer = { register(route) { if (route.path === '/claude-review/api') captured = route; return () => {} } }
  const agent = { id: 'session-panel' }
  const services = {
    agents: { get: (id) => (id === 'session-panel' ? agent : undefined), list: () => [agent] },
    workingDirectory: { get: () => project, defaultDirectory: project },
  }
  const ctx = {
    effect: (fn) => fn(),
    get: (name) => services[name],
    tools: { register: () => () => {} },
    subprocess: { resolveExecutable: async (c) => c, spawn: () => ({ collected: {}, done: Promise.resolve({ exitCode: 0 }), terminate() {} }) },
    inject: (_deps, cb) => cb({ effect: (fn) => fn(), webServer, get: (name) => services[name] }),
  }
  apply(ctx, {})
  const upper = project.toUpperCase()
  const response = await captured.resource(
    new Request(`http://127.0.0.1/claude-review/api/panel?sessionId=session-panel&cwd=${encodeURIComponent(upper)}`),
  )
  check('N1 同项目 cwd 大小写差异不误拒', response.status === 200, String(response.status))
  await rm(project, { recursive: true, force: true })
}

console.log('')
console.log(`结果: passed=${passed} failed=${failures.length} skipped=${skipped.length}`)
for (const failure of failures) console.log(`  FAIL ${failure}`)
for (const skip of skipped) console.log(`  SKIP ${skip}`)
process.exit(failures.length > 0 ? 1 : 0)









