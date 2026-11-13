/**
 * Claude Code review — Host plugin.
 *
 * Registers one native DSH tool, `claude_review`, that runs an independent,
 * read-only review of the current workspace with the local Claude Code CLI and
 * returns graded findings plus a submit-gate verdict.
 *
 * The heavy lifting lives in a PowerShell engine that resolves its own git
 * snapshot, diff scope, prompt, report directory and exit-code semantics. This
 * plugin only resolves paths/config, spawns it through `ctx.subprocess`, and
 * normalizes the JSON envelope into the tool result. Keeping one engine means
 * the CLI/Trellis workflow and the in-app tool never drift apart.
 */
import { access, readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { appendDispositions, loadPanel, resolveTaskDir } from './panel.js'

export const name = 'claude-code-review'
// 这个版本的 cordis 只认字符串数组形式的 inject（对象形式会被解析成服务名 "required"/"optional"）。
// webServer 不在静态列表里：它在非 Web profile 下不存在，而面板只是可选能力；
// 需要时用 ctx.inject(['webServer'], cb) 动态获取（启动后按依赖满足回调）。
export const inject = ['tools', 'subprocess']

const PANEL_ROUTE = '/claude-review/api'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLED_ENGINE = join(HERE, 'scripts', 'Invoke-ClaudeReview.ps1')
const WORKSPACE_ENGINE = join('tools', 'claude-review', 'Invoke-ClaudeReview.ps1')
const ALT_WORKSPACE_ENGINE = join('.dsh', 'claude-review', 'Invoke-ClaudeReview.ps1')

const REVIEW_TIMEOUT_MS = 30 * 60 * 1000
// 子进程没有控制台时，PowerShell 会把中文按系统代码页（cp936）写成字节，宿主再按 UTF-8 解码
// 就变成乱码。这里在执行引擎前强制把控制台输出编码钉成 UTF-8（与引擎自身的 try/catch 一致）。
const PS_ENCODING_PROLOGUE =
  'try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ' +
  '$OutputEncoding = [Console]::OutputEncoding } catch { }; '

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function buildCommandLine(engine, parts) {
  // 参数名不能加引号：PowerShell 会把 '-Mode' 当成值，绑定失败。只对值加引号。
  return PS_ENCODING_PROLOGUE + '& ' + psQuote(engine) + ' ' + parts.join(' ')
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function isDirectory(path) {
  try {
    const info = await stat(path)
    return info.isDirectory()
  } catch {
    return false
  }
}

function agentCwd(ctx, exec, explicit) {
  if (typeof explicit === 'string' && explicit.trim() !== '') return resolve(explicit)
  const wd = ctx.get('workingDirectory')
  if (wd && typeof wd.get === 'function') {
    try {
      const fromSession = wd.get(exec.agent)
      if (typeof fromSession === 'string' && fromSession !== '') return fromSession
    } catch {
      // fall through to the remaining strategies
    }
  }
  const fromHeader = exec.agent?.session?.header?.cwd
  if (typeof fromHeader === 'string' && fromHeader !== '') return fromHeader
  return process.cwd()
}

// 插件只认 cordis.patch.yml 这一层 storage；引擎的 -Storage 由这里传入。
// 直接 CLI 调用才用引擎自己的 -Storage（config.json 不再提供 storage，避免双源）。
function storageMode(config) {
  return ['auto', 'trellis', 'local'].includes(config?.storage) ? config.storage : 'auto'
}

// 引擎能力握手：文件头 `# claude-review-api: 3` 是静态标记，避免每次审核多 spawn 一次探测。
// 旧目标仓库（例如 tools/claude-review 里的旧脚本）没有这个标记，插件必须回退自带引擎，
// 否则新插件传 -Storage 会在旧脚本的参数绑定阶段直接失败。
const ENGINE_API = 3
const ENGINE_API_RE = /#\s*claude-review-api:\s*(\d+)/
const engineApiCache = new Map()

async function readEngineApi(engine) {
  let info
  try { info = await stat(engine) } catch { return 0 }
  const key = `${engine}|${info.mtimeMs}|${info.size}`
  if (engineApiCache.has(key)) return engineApiCache.get(key)
  let api = 0
  try {
    const text = await readFile(engine, 'utf8')
    const match = text.slice(0, 4096).match(ENGINE_API_RE)
    if (match) api = Number(match[1])
  } catch {
    api = 0
  }
  engineApiCache.set(key, api)
  return api
}

async function resolveEngine(ctx, cwd, config) {
  const configured = typeof config.enginePath === 'string' ? config.enginePath.trim() : ''
  const candidates = []
  if (configured !== '') {
    candidates.push({ path: isAbsolute(configured) ? configured : resolve(cwd, configured), source: 'configured' })
    if (config.allowBundledFallback !== false) {
      candidates.push({ path: BUNDLED_ENGINE, source: 'bundled' })
    }
  } else {
    candidates.push({ path: join(cwd, WORKSPACE_ENGINE), source: 'workspace' })
    candidates.push({ path: join(cwd, ALT_WORKSPACE_ENGINE), source: 'local-engine' })
    if (config.allowBundledFallback !== false) {
      candidates.push({ path: BUNDLED_ENGINE, source: 'bundled' })
    }
  }

  let fallbackReason = ''
  let firstMissing = ''
  const sourceLabel = (source) =>
    ({ configured: '配置的', workspace: '目标仓库', 'local-engine': '目标仓库 .dsh 的', bundled: '插件自带的' })[source] || source
  for (const candidate of candidates) {
    if (!(await exists(candidate.path))) {
      if (candidate.source === 'configured') {
        throw new Error(`claude_review: 配置的 enginePath 不存在：${candidate.path}`)
      }
      if (firstMissing === '') firstMissing = candidate.path
      continue
    }
    const api = await readEngineApi(candidate.path)
    if (api >= ENGINE_API) {
      const warning = fallbackReason
        ? `${fallbackReason}；已回退到${sourceLabel(candidate.source)}引擎 ${candidate.path}。`
        : ''
      return { path: candidate.path, source: candidate.source, warning }
    }
    const reason =
      `${candidate.path} 的接口版本为 ${api > 0 ? `v${api}` : '未知（没有 claude-review-api 标记）'}，` +
      `当前插件需要 v${ENGINE_API}`
    if (fallbackReason === '') fallbackReason = reason
    if (candidate.source === 'configured' && config.allowBundledFallback === false) {
      throw new Error(`claude_review: ${reason}；allowBundledFallback=false，无法回退。请升级该引擎或修改 enginePath。`)
    }
  }

  const hint = firstMissing ? `（也找不到 ${firstMissing}）` : ''
  throw new Error(
    `claude_review: 找不到审核引擎${hint}。目标引擎接口过旧或缺失，且自带引擎不可用；` +
      '请升级目标仓库的 Invoke-ClaudeReview.ps1，或在插件配置里设置 enginePath。',
  )
}

function lastJsonLine(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().startsWith('{'))
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index])
    } catch {
      // keep scanning upwards
    }
  }
  return undefined
}

function firstLine(text) {
  return (
    String(text ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== '') ?? ''
  )
}

function normalizedResult(envelope, exitCode) {
  const base = {
    ok: envelope?.ok !== false,
    mode: String(envelope?.mode ?? ''),
    verdict: String(envelope?.verdict ?? ''),
    critical: Number(envelope?.critical ?? 0),
    important: Number(envelope?.important ?? 0),
    minor: Number(envelope?.minor ?? 0),
    summary: String(envelope?.summary ?? ''),
    reportPath: String(envelope?.report ?? ''),
    markdownPath: String(envelope?.markdown ?? ''),
    storage: String(envelope?.storage ?? ''),
    base: String(envelope?.base ?? ''),
    head: String(envelope?.head ?? ''),
    profile: String(envelope?.profile ?? ''),
    transport: String(envelope?.transport ?? ''),
    roleMode: String(envelope?.roleMode ?? ''),
    transportWarning: String(envelope?.transportWarning ?? ''),
    truncated: envelope?.truncated === true,
    scopeWarning: String(envelope?.scopeWarning ?? ''),
    cached: envelope?.cached === true,
    costUsd: typeof envelope?.cost_usd === 'number' ? envelope.cost_usd : 0,
    costKnown: typeof envelope?.cost_usd === 'number',
    exitCode,
    dryRun: envelope?.dryRun === true,
    escalated: String(envelope?.escalate ?? ''),
    note: String(envelope?.note ?? ''),
  }
  if (base.dryRun) {
    base.verdict = 'dry-run'
    base.note = '只组装了审核输入，未调用模型。'
    return base
  }
  if (envelope?.nothingToReview) {
    base.verdict = 'nothing-to-review'
    base.note = '该范围内没有改动；nothing-to-review 不等于 pass。'
  } else if (envelope?.gate) {
    base.verdict = envelope.gate === 'pass' ? 'gate-pass' : 'gate-blocked'
    base.ok = envelope.gate === 'pass'
    const reasons = Array.isArray(envelope.reasons) ? envelope.reasons.join('；') : String(envelope.reason ?? '')
    base.note = reasons
  } else if (typeof envelope?.error === 'string') {
    base.ok = false
    base.note = envelope.error
  }
  // ok 是调用方判断「可否继续/可否提交」的主信号：结论不通过时必须为 false，
  // 不能只靠 note 的文字提醒（否则门禁在工具层就被绕过了）。
  if (exitCode === 1 || base.verdict === 'fix' || base.verdict === 'reject') base.ok = false
  if (base.transportWarning) {
    base.note = base.note ? `${base.note} ${base.transportWarning}` : base.transportWarning
  }
  return base
}

function renderSummary(value) {
  const result = value ?? {}
  const verdict = typeof result.verdict === 'string' ? result.verdict : ''
  const lines = []
  if (result.mode === 'gate' || verdict.startsWith('gate-')) {
    lines.push(`gate: ${result.ok === false ? 'blocked' : 'pass'}`)
    if (result.note) lines.push(`reason: ${result.note}`)
  } else {
    lines.push(`verdict: ${verdict || 'unknown'}`)
    lines.push(`issues: critical=${result.critical ?? 0} important=${result.important ?? 0} minor=${result.minor ?? 0}`)
    if (result.summary) lines.push(`summary: ${result.summary}`)
    if (result.note) lines.push(`note: ${result.note}`)
    if (result.reportPath) lines.push(`report: ${result.reportPath}`)
  }
  if (result.truncated) lines.push('truncated: diff 已截断，结论不完整；gate 不会通过')
  if (result.cached) lines.push('cached: 复用与上次完全相同的 diff/输入，未调用模型')
  if (result.scopeWarning) lines.push(`scope: ${result.scopeWarning}`)
  if (result.escalated) lines.push(`escalate: ${result.escalated}`)
  return lines.join('\n')
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function attempt(fn) {
  try {
    return fn()
  } catch {
    return undefined
  }
}

function attemptString(fn) {
  const value = attempt(fn)
  return typeof value === 'string' && value.trim() !== '' ? value : ''
}

/**
 * 客户端只传 sessionId，由 Host 把会话解析成项目目录。
 * 多会话/多工作区下按会话解析；解析不到时退回默认工作目录，避免面板空白。
 * 只在「目录里确实有 .trellis」时才采用，防止在无关项目里误读。
 */
export async function resolveCwdForSession(ctx, sessionId, options = {}) {
  const agents = attempt(() => ctx.get('agents'))
  const workingDirectory = attempt(() => ctx.get('workingDirectory'))
  let agent = attempt(() => agents?.get?.(sessionId))
  if (!agent) {
    agent = attempt(() => (agents?.list?.() ?? []).find((entry) => String(entry?.id) === sessionId))
  }

  const candidates = []
  if (agent) {
    candidates.push(attemptString(() => workingDirectory?.get?.(agent)))
    candidates.push(attemptString(() => agent?.ctx?.get?.('workingDirectory')?.get?.(agent?.session ?? agent)))
    candidates.push(attemptString(() => agent?.session?.header?.cwd))
    candidates.push(attemptString(() => agent?.header?.cwd))
  }
  // 默认**不**回退到宿主默认工作区：否则任何无效 sessionId 都能读到宿主的默认项目。
  // 需要这条便利时显式打开 fallbackToDefaultWorkspace。
  if (options.fallbackToDefaultWorkspace === true) {
    candidates.push(attemptString(() => workingDirectory?.defaultDirectory))
  }
  const unique = [...new Set(candidates.filter((candidate) => candidate !== ''))]
  for (const candidate of unique) {
    // 本地模式不要求 .trellis：会话自己的工作目录就是一个合法项目。
    if (!(await isDirectory(candidate))) continue
    return candidate
  }
  return ''
}

export function apply(ctx, config = {}) {
  const configuredTimeoutSec =
    Number.isFinite(config.timeoutSec) && config.timeoutSec > 0 ? Math.trunc(config.timeoutSec) : 1500
  // 工具级超时要盖住引擎超时并留出进程启动余量，否则插件先把进程掐掉、引擎的 -TimeoutSec 形同虚设。
  const toolTimeoutMs = Math.min(Math.max(configuredTimeoutSec * 1000 + 120_000, REVIEW_TIMEOUT_MS), 60 * 60 * 1000)

  const definition = {
    name: 'claude_review',
    description:
      'Run an independent, read-only code review of the current workspace with the local Claude Code CLI. ' +
      'Use it after each implementation round ("incremental"), before composing commits ("full"), for an already ' +
      'committed range ("range"), and for the local submit gate ("gate"). The reviewer cannot modify files; it ' +
      'returns graded findings (critical / important / minor) with file:line evidence, and the tool fails when the gate blocks.',
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['incremental', 'full', 'gate', 'range'],
          description:
            'incremental = changes since the previous review snapshot; full = all uncommitted changes vs HEAD ' +
            '(or vs base when provided); range = committed range base..head; gate = local submit-gate check without calling the model.',
        },
        base: {
          type: 'string',
          description: 'Optional git revision to use as diff base (e.g. HEAD~1). Required for range mode.',
        },
        head: {
          type: 'string',
          description: 'Optional git revision to use as range head (default HEAD). Only used by range mode.',
        },
        profile: {
          type: 'string',
          enum: ['quick', 'deep'],
          description: 'quick = low effort + 40k diff cap; deep = high effort + 200k diff cap. Explicit effort/maxDiffChars win.',
        },
        description: {
          type: 'string',
          description: 'What this round implemented. Strongly affects review quality; avoid vague text.',
        },
        checks: {
          type: 'array',
          items: { type: 'string' },
          description: 'Objective checks already run this round, e.g. "cargo test 12/12 passed".',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional git pathspecs to narrow the reviewed scope. Ignored by gate mode.',
        },
        focus: {
          type: 'string',
          description: 'Optional extra focus for the reviewer, e.g. "check Rust↔bindings contract drift".',
        },
        taskDir: {
          type: 'string',
          description:
            'Trellis task directory. Required when the session has no current Trellis task; the engine never guesses from history/in_progress.',
        },
        cwd: {
          type: 'string',
          description: 'Repository to review. Defaults to the current session working directory.',
        },
        dryRun: {
          type: 'boolean',
          description: 'Assemble the review input without calling the model. Useful to verify scope.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          mode: { type: 'string' },
          verdict: { type: 'string' },
          critical: { type: 'integer' },
          important: { type: 'integer' },
          minor: { type: 'integer' },
          summary: { type: 'string' },
          reportPath: { type: 'string' },
          markdownPath: { type: 'string' },
          storage: { type: 'string' },
          base: { type: 'string' },
          head: { type: 'string' },
          profile: { type: 'string' },
          transport: { type: 'string' },
          roleMode: { type: 'string' },
          transportWarning: { type: 'string' },
          truncated: { type: 'boolean' },
          scopeWarning: { type: 'string' },
          cached: { type: 'boolean' },
          costUsd: { type: 'number' },
          costKnown: { type: 'boolean' },
          exitCode: { type: 'integer' },
          dryRun: { type: 'boolean' },
          escalated: { type: 'string' },
          note: { type: 'string' },
          enginePath: { type: 'string' },
          engineSource: { type: 'string' },
          engineWarning: { type: 'string' },
        },
        required: ['ok', 'mode', 'verdict', 'exitCode'],
      },
      render(_args, value) {
        return [{ type: 'text', text: renderSummary(value) }]
      },
    },
    timeoutMs: toolTimeoutMs,
    isConcurrencySafe() {
      return false
    },
    async execute(args, exec) {
      const options = args ?? {}
      const mode = ['incremental', 'full', 'gate', 'range'].includes(options.mode) ? options.mode : 'incremental'
      const storage = storageMode(config)
      const cwd = agentCwd(ctx, exec, options.cwd)
      const engineInfo = await resolveEngine(ctx, cwd, config)
      const engine = engineInfo.path
      const pwsh = await ctx.subprocess.resolveExecutable('pwsh')

      const parts = [
        '-Mode',
        psQuote(mode),
        '-Storage',
        psQuote(storage),
        '-Cwd',
        psQuote(cwd),
        '-Json',
        '-TimeoutSec',
        String(configuredTimeoutSec),
      ]
      const sessionId = typeof exec.agent?.id === 'string' ? exec.agent.id : ''
      if (sessionId !== '') {
        parts.push('-SessionId', psQuote(sessionId))
      }
      const pushValue = (flag, value) => {
        parts.push(flag, psQuote(value))
      }
      // PowerShell 不允许同一个命名参数出现多次（"多次指定了参数 'Checks'"），
      // 所以数组型参数必须拼成 -Checks 'a','b' 这种单个数组实参。
      const pushList = (flag, values) => {
        const list = (Array.isArray(values) ? values : []).filter((value) => typeof value === 'string' && value.trim() !== '')
        if (list.length === 0) return
        parts.push(flag, list.map(psQuote).join(','))
      }
      if (typeof options.description === 'string' && options.description.trim() !== '') {
        pushValue('-Description', options.description)
      }
      if (typeof options.focus === 'string' && options.focus.trim() !== '') {
        pushValue('-Focus', options.focus)
      }
      if (typeof options.taskDir === 'string' && options.taskDir.trim() !== '') {
        pushValue('-TaskDir', options.taskDir)
      }
      if (typeof options.base === 'string' && options.base.trim() !== '') {
        pushValue('-Base', options.base)
      }
      if (typeof options.head === 'string' && options.head.trim() !== '') {
        pushValue('-Head', options.head)
      }
      if (typeof options.profile === 'string' && options.profile.trim() !== '') {
        pushValue('-Profile', options.profile)
      }
      const configuredTransport = ['auto', 'acp', 'cli'].includes(config.transport) ? config.transport : 'auto'
      parts.push('-Transport', psQuote(configuredTransport))
      if (typeof process.execPath === 'string' && process.execPath !== '') {
        // 用 DSH Host 自己的运行时，不要求用户 PATH 里有 node。
        parts.push('-NodeExe', psQuote(process.execPath))
      }
      if (process.versions && process.versions.electron) parts.push('-NodeRunAsNode')
      pushList('-Checks', options.checks)
      pushList('-Paths', options.paths)
      if (options.dryRun === true) parts.push('-DryRun')

      const argv = [
        pwsh,
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        buildCommandLine(engine, parts),
      ]

      const handle = ctx.subprocess.spawn({
        argv,
        cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 4 * 1024 * 1024 },
          stderr: { maxBytes: 256 * 1024 },
        },
        graceMs: 5000,
        signal: exec.signal,
      })

      const outcome = await handle.done
      const stdout = handle.collected.stdout?.readFrom(0)?.text ?? ''
      const stderr = handle.collected.stderr?.readFrom(0)?.text ?? ''
      const exitCode = typeof outcome?.exitCode === 'number' ? outcome.exitCode : -1
      if (stdout.includes('\uFFFD') || stderr.includes('\uFFFD')) {
        // 静默的编码损坏比失败更糟：宁可大声失败，也不要把乱码当成审核结论。
        throw new Error(
          'claude_review: 引擎输出编码异常（含替换字符 U+FFFD）。请确认 pwsh 控制台按 UTF-8 输出，或升级本插件。',
        )
      }
      const envelope = lastJsonLine(stdout)
      const enginePrefix = engineInfo.warning ? `${engineInfo.warning} ` : ''

      if (exitCode === 2) {
        const detail = envelope?.error || firstLine(stderr) || 'unknown failure'
        throw new Error(`claude_review: ${enginePrefix}审核未完成（exit 2）：${detail}`)
      }
      if (envelope === undefined && exitCode !== 0) {
        // 旧引擎的参数绑定错误会走这里：必须把 stderr 首行透出来，不能伪装成“模型输出坏了”。
        throw new Error(
          `claude_review: ${enginePrefix}引擎执行失败（exit ${exitCode}）：${firstLine(stderr) || firstLine(stdout) || '无输出'}`,
        )
      }
      if (exitCode !== 0 && exitCode !== 1) {
        throw new Error(`claude_review: ${enginePrefix}引擎异常退出（exit ${exitCode}）：${firstLine(stderr)}`)
      }
      if (envelope === undefined) {
        throw new Error(
          `claude_review: ${enginePrefix}引擎输出不可解析。stdout=${stdout.trim().slice(0, 400)} stderr=${stderr.trim().slice(0, 400)}`,
        )
      }

      const result = normalizedResult(envelope, exitCode)
      result.enginePath = engineInfo.path
      result.engineSource = engineInfo.source
      result.engineWarning = engineInfo.warning
      if (engineInfo.warning) {
        result.note = result.note ? `${result.note} ${engineInfo.warning}` : engineInfo.warning
      }
      if (exitCode === 1) {
        // fix/reject 需要修；gate-blocked 的「同一模式」是 gate，重跑 gate 会再次阻断。
        if (result.verdict === 'gate-blocked') {
          const gateNote = '门禁阻断：按 reasons 处理后重跑 full（截断/自定义 Base/快照降级）；不要直接重跑 gate'
          result.note = result.note ? `${gateNote}。${result.note}` : gateNote
        } else {
          const fixNote = '必须先修，再重跑同一模式'
          result.note = result.note ? `${result.note}（${fixNote}）` : fixNote
        }
      }
      return result
    },
  }

  // 面板数据：Host 读文件，客户端只 fetch 一个 JSON（不暴露任意路径，全部读在 cwd/.trellis 下）。
  // 冷启动时 webServer 可能还没激活。这里不依赖任何未经验证的动态注入 API：
  // 只做「立刻试一次，失败就有限次重试」，且面板注册永远排在工具注册之后、任何异常都被吞掉并记日志。
  const logWarn = (message) => {
    try {
      if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn(`[claude-code-review] ${message}`)
      else console.warn(`[claude-code-review] ${message}`)
    } catch {
      // 日志本身不能影响插件
    }
  }

  const registerPanelRoute = (scope) => {
    // 未解析的服务在 cordis 的 Proxy 上可能抛错而不是返回 undefined，取服务必须包住。
    const resolveWebServer = () => {
      try {
        return scope.webServer ?? scope.get?.('webServer') ?? undefined
      } catch {
        return undefined
      }
    }
    const webServer = resolveWebServer()
    if (!webServer || typeof webServer.register !== 'function') return false
    scope.effect(() =>
      webServer.register({
        kind: 'prefix',
        path: PANEL_ROUTE,
        resource: async (request) => {
          try {
            const url = new URL(request.url, 'http://127.0.0.1')
            if (url.pathname !== `${PANEL_ROUTE}/panel`) return new Response('not found', { status: 404 })
            if (request.method !== 'GET' && request.method !== 'HEAD') {
              return jsonResponse({ ok: false, error: 'method-not-allowed' }, 405)
            }
            const sessionId = url.searchParams.get('sessionId') ?? ''
            const requestedCwd = url.searchParams.get('cwd') ?? ''
            const task = url.searchParams.get('task') ?? ''
            let cwd = await resolveCwdForSession(ctx, sessionId, {
              fallbackToDefaultWorkspace: config.fallbackToDefaultWorkspace === true,
            })
            if (requestedCwd !== '') {
              // 路径授权：默认只允许「与会话自身项目一致」的 cwd（调试用途），
              // 否则本机任意进程都能让面板去读机器上任意一个项目目录。
              const resolvedRequested = isAbsolute(requestedCwd) ? resolve(requestedCwd) : resolve(cwd || process.cwd(), requestedCwd)
              // Windows 路径大小写不敏感：直接字符串比较会把 D:\\coding\\xinhuo 误判成「不同项目」
              const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)
              if (config.allowPanelCwd === true) cwd = resolvedRequested
              else if (cwd !== '' && samePath(resolve(cwd), resolvedRequested)) cwd = resolvedRequested
              else return jsonResponse({ ok: false, error: 'cwd-not-allowed' }, 403)
            }
            // 解析不出会话所属项目就明确拒绝，绝不回退到宿主默认项目（那会让任意无效 sessionId 读到别人项目）
            if (cwd === '') return jsonResponse({ ok: false, error: 'session-not-resolved' }, 404)
            const panel = await loadPanel(cwd, { storage: storageMode(config), task })
            return jsonResponse(panel)
          } catch (error) {
            return jsonResponse({ ok: false, error: String(error?.message ?? error) }, 500)
          }
        },
      }),
    )
    return true
  }
  const panelAttempts = Number.isFinite(config.panelRetryAttempts) ? Math.max(1, Math.trunc(config.panelRetryAttempts)) : 10
  const panelRetryMs = Number.isFinite(config.panelRetryMs) ? Math.max(1, Math.trunc(config.panelRetryMs)) : 500

  // 面板是否真的注册成功（看门狗用它判断，避免「重试成功但看门狗仍报警」的假告警）
  let panelReady = false
  const markReady = () => {
    panelReady = true
  }

  const installPanel = (scope, attempt) => {
    try {
      if (registerPanelRoute(scope)) {
        markReady()
        if (attempt > 1) logWarn(`协同面板在第 ${attempt} 次尝试时注册成功（webServer 晚于插件就绪）`)
        return true
      }
      // 路由已存在也视为就绪
    } catch (error) {
      const message = String(error?.message ?? error)
      if (/duplicate|already|collision|exists/i.test(message)) {
        markReady()
        logWarn(`协同面板路由已存在，沿用现有注册：${message}`)
        return true
      }
      logWarn(`协同面板注册异常（第 ${attempt} 次，已忽略）：${message}`)
    }
    if (attempt >= panelAttempts) {
      let hint = ''
      try {
        hint = scope.webServer === undefined ? '（webServer 未激活）' : '（webServer 已存在但注册失败）'
      } catch (error) {
        hint = `（读取 webServer 抛错：${String(error?.message ?? error)}）`
      }
      logWarn(`webServer 在 ${attempt} 次尝试内仍不可用${hint}，本次不启用协同面板（claude_review 工具不受影响）`)
      return false
    }
    const timer = setTimeout(() => installPanel(scope, attempt + 1), panelRetryMs)
    if (typeof timer?.unref === 'function') timer.unref()
    ctx.effect(() => () => clearTimeout(timer))
    return false
  }

  // 处置记录（方案 A）：主会话修完一轮后写一条，面板据此显示「已修 / 已反证 / 暂缓」
  const dispositionTool = {
    name: 'claude_review_disposition',
    description:
      'Record how the main session handled review findings, so the 协同 panel can show "problem → resolution" per finding. ' +
      'Call it after fixing (or consciously deferring) issues from a review round. status: fixed | counter-evidence | deferred.',
    parameters: {
      type: 'object',
      properties: {
        entries: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              round: { type: 'integer', description: 'The review round the finding came from.' },
              key: { type: 'string', description: 'issues[].key from that round (preferred).' },
              index: { type: 'integer', description: 'issues[] index in that round (fallback when key is unknown).' },
              status: { type: 'string', enum: ['fixed', 'counter-evidence', 'deferred'] },
              note: { type: 'string', description: 'One line: what was changed, or why it is rejected/deferred.' },
              evidence: { type: 'array', items: { type: 'string' }, description: 'Files or checks that prove it.' },
            },
            required: ['round', 'status'],
            additionalProperties: false,
          },
          description: 'Batch form: one row per finding.',
        },
        round: { type: 'integer', description: 'Single-entry form: review round.' },
        key: { type: 'string', description: 'Single-entry form: issues[].key.' },
        index: { type: 'integer', description: 'Single-entry form: issues[] index.' },
        status: { type: 'string', enum: ['fixed', 'counter-evidence', 'deferred'], description: 'Single-entry form.' },
        note: { type: 'string', description: 'Single-entry form.' },
        evidence: { type: 'array', items: { type: 'string' }, description: 'Single-entry form.' },
        taskDir: { type: 'string', description: 'Trellis task directory. Required for Trellis writes; no guessing from history/in_progress.' },
        cwd: { type: 'string', description: 'Project root. Defaults to the session working directory.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          written: { type: 'integer' },
          taskDir: { type: 'string' },
        },
        required: ['ok', 'written'],
      },
      render(_args, value) {
        return [
          {
            type: 'text',
            text: value?.ok ? `记录 ${value.written} 条处置 → ${value.taskDir}` : '处置记录未写入',
          },
        ]
      },
    },
    timeoutMs: 30_000,
    async execute(args, exec) {
      const options = args ?? {}
      const cwd = agentCwd(ctx, exec, options.cwd)
      const batch = Array.isArray(options.entries) && options.entries.length > 0 ? options.entries : []
      const single =
        options.round !== undefined || options.key !== undefined || options.index !== undefined
          ? [
              {
                round: options.round,
                key: options.key,
                index: options.index,
                status: options.status,
                note: options.note,
                evidence: options.evidence,
              },
            ]
          : []
      const entries = batch.length > 0 ? batch : single
      if (entries.length === 0) throw new Error('claude_review_disposition: 需要 entries 数组或单条 round/key/status')
      const taskDir = await resolveTaskDir(cwd, options.taskDir, { storage: storageMode(config) })
      const written = await appendDispositions(taskDir, entries, String(exec.agent?.id ?? ''))
      return { ok: true, written, taskDir }
    },
  }

  ctx.effect(() => ctx.tools.register(definition))
  ctx.effect(() => ctx.tools.register(dispositionTool))

  // 工具先注册完，再尝试可选的协同面板：
  //  1) 首选 ctx.inject(['webServer'], cb)：cordis 保证服务就绪后才回调。
  //     实测回调实参是 context scope（有 get/effect/webServer），第二个实参暂为 undefined。
  //  2) inject 不存在或同步抛错时，退回「立刻试 + 有限重试」。
  //  3) 另设看门狗：两条路都没成时，明确 log 一条「面板未启用」，不留静默失败。
  const watchdogMs = Number.isFinite(config.panelWatchdogMs) ? Math.max(1, Math.trunc(config.panelWatchdogMs)) : 15000
  const watchTimer = setTimeout(() => {
    if (!panelReady) {
      logWarn(`协同面板 ${watchdogMs}ms 内未注册成功（webServer 未就绪或注入回调未触发），本次不启用；claude_review 工具不受影响`)
    }
  }, watchdogMs)
  if (typeof watchTimer?.unref === 'function') watchTimer.unref()
  ctx.effect(() => () => clearTimeout(watchTimer))

  const startPanel = () => {
    if (typeof ctx.inject === 'function') {
      try {
        ctx.inject(['webServer'], (scope) => {
          try {
            if (installPanel(scope, 1)) markReady()
          } catch (error) {
            logWarn(`协同面板注册异常（已忽略）：${String(error?.message ?? error)}`)
          }
        })
        return
      } catch (error) {
        logWarn(`ctx.inject 不可用，改用轮询注册面板：${String(error?.message ?? error)}`)
      }
    }
    if (installPanel(ctx, 1)) markReady()
  }

  try {
    startPanel()
  } catch (error) {
    logWarn(`协同面板启动失败（已忽略）：${String(error?.message ?? error)}`)
  }
}



