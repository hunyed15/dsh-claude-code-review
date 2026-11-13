#!/usr/bin/env node
/**
 * Internal ACP transport bridge for claude-code-review.
 *
 * Spawned by the PowerShell engine. It uses the official
 * @agentclientprotocol/sdk client and @agentclientprotocol/claude-agent-acp,
 * both installed as plugin dependencies. The user does not configure ACP.
 *
 * stdout is exactly one JSON envelope shaped like Claude Code's
 * `--output-format json` result, so the engine can keep its existing parser.
 * Adapter/AI logs go to stderr.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = dirname(HERE)

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (!key.startsWith('--')) continue
    const name = key.slice(2)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) {
      out[name] = true
    } else {
      out[name] = value
      i += 1
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const promptFile = String(args.prompt ?? '')
const roleFile = String(args.role ?? '')
const cwd = String(args.cwd ?? process.cwd())
const claudeExe = String(args.claude ?? '')
const timeoutMs = args['timeout-ms'] === true || args['timeout-ms'] === undefined ? 0 : Number(args['timeout-ms'])
const startupTimeoutMs = args['startup-timeout-ms'] === true || args['startup-timeout-ms'] === undefined ? 30000 : Number(args['startup-timeout-ms'])
const maxBudgetUsd = args['max-budget-usd'] === true || args['max-budget-usd'] === undefined ? 0 : Number(args['max-budget-usd'])
const model = args.model === true || args.model === undefined ? '' : String(args.model)
const effort = args.effort === true || args.effort === undefined ? '' : String(args.effort)
const adapterEntry = String(args.adapter ?? join(PLUGIN_ROOT, 'node_modules', '@agentclientprotocol', 'claude-agent-acp', 'dist', 'index.js'))

function envelope(payload) {
  return JSON.stringify({ type: 'result', ...payload })
}

function finish(code, payload) {
  const text = envelope(payload) + '\n'
  if (code === 0) {
    // 成功结果可能很大（整段 assistant 文本）：等管道写完再退出，并留 1s 兜底。
    const fallback = setTimeout(() => process.exit(0), 1000)
    fallback.unref?.()
    process.stdout.write(text, () => process.exit(0))
    return
  }
  // 错误 envelope 很小；同步写 fd 再退出，既保证完整又立即终止后续顶层代码。
  try { writeSync(1, text) } catch {}
  process.exit(code)
}

function fail(code, message, extra = {}) {
  finish(code, { subtype: 'error', is_error: true, errors: [String(message)], ...extra })
}

function killTree(pid) {
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } else {
      try { process.kill(-pid, 'SIGKILL') } catch { process.kill(pid, 'SIGKILL') }
    }
  } catch {
    // best effort
  }
}

// ACP sessions can prepend host hook output (e.g. Trellis SessionStart) to the
// assistant message. Extract the last valid JSON object so the engine's existing
// review parser still receives exactly the review object.
function extractLastJsonObject(text) {
  const source = String(text ?? '')
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  let last = ''
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      if (depth === 0) start = i
      depth += 1
    } else if (ch === '}') {
      if (depth > 0) depth -= 1
      if (depth === 0 && start >= 0) {
        const candidate = source.slice(start, i + 1)
        try {
          JSON.parse(candidate)
          last = candidate
        } catch {
          // not JSON; keep scanning
        }
        start = -1
      }
    }
  }
  return last
}

if (!promptFile || !existsSync(promptFile)) fail(3, `ACP prompt file missing: ${promptFile}`)
if (!existsSync(adapterEntry)) fail(3, `ACP adapter not installed: ${adapterEntry}`)

let sdk
try {
  sdk = await import('@agentclientprotocol/sdk')
} catch (error) {
  fail(3, `ACP SDK is not installed: ${String(error?.message ?? error)}`)
}

const { client, methods, ndJsonStream } = sdk

const promptText = readFileSync(promptFile, 'utf8')
let roleText = ''
if (roleFile && existsSync(roleFile)) roleText = readFileSync(roleFile, 'utf8').trim()
// 默认回退：role 拼进 prompt。init 后若 adapter 支持 systemPrompt，则改为 system 层。
let fullPrompt = roleText
  ? `# Reviewer role (read-only)\n${roleText}\n\n---\n\n${promptText}`
  : promptText
let roleMode = roleText ? 'prompt' : 'none'

const child = spawn(process.execPath, [adapterEntry], {
  cwd,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
  env: {
    ...process.env,
    // When the bridge itself runs as Electron's Node, the adapter needs the same switch.
    ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    ...(claudeExe ? { CLAUDE_CODE_EXECUTABLE: claudeExe } : {}),
    CLAUDE_AGENT_ACP_PROTOCOL: 'v1',
  },
})

let childStderr = ''
child.stderr.on('data', (chunk) => {
  const text = String(chunk)
  childStderr += text
  if (childStderr.length > 64_000) childStderr = childStderr.slice(-64_000)
  process.stderr.write(text)
})

let sessionHandle
let promptSent = false
let phase = 'initialize'
let finished = false
function done(code, payload) {
  if (finished) return
  finished = true
  try { sessionHandle?.dispose?.() } catch {}
  killTree(child.pid)
  finish(code, payload)
}

// spawn 失败（adapter 缺失/不可执行）必须变成 exit 3，引擎的 auto 才能回退 CLI。
child.on('error', (error) => {
  done(3, {
    subtype: 'adapter_unavailable',
    is_error: true,
    errors: [`ACP adapter could not start: ${String(error?.message ?? error)}`],
  })
})

// 只读：ACP 只允许 read/search；edit/execute/terminal/fetch 一律拒绝。
// 另有 session mode=default + disallowedTools 在 adapter 层兜底，不能只依赖这里。
const READ_ONLY_TOOL_KINDS = new Set(['read', 'search'])
const ALLOW_OPTION_KINDS = new Set(['allow_once', 'allow_always'])
const REJECT_OPTION_KINDS = new Set(['reject_once', 'reject_always'])

const app = client({ name: 'dsh-claude-code-review' })

app.onRequest(methods.client.session.requestPermission, async (ctx) => {
  const kind = String(ctx.params?.toolCall?.kind ?? '')
  const options = Array.isArray(ctx.params?.options) ? ctx.params.options : []
  const allowed = READ_ONLY_TOOL_KINDS.has(kind)
  const wanted = allowed ? ALLOW_OPTION_KINDS : REJECT_OPTION_KINDS
  const picked = options.find((option) => wanted.has(String(option?.kind ?? '')))
  if (!picked?.optionId) {
    return { outcome: { outcome: 'cancelled' } }
  }
  return { outcome: { outcome: 'selected', optionId: picked.optionId } }
})

app.onRequest(methods.client.fs.readTextFile, async (ctx) => {
  const path = String(ctx.params?.path ?? '')
  try {
    let content = readFileSync(path, 'utf8')
    const line = Number(ctx.params?.line ?? 0)
    const limit = Number(ctx.params?.limit ?? 0)
    if (line > 0 || limit > 0) {
      const rows = content.split(/\r?\n/)
      const start = line > 0 ? line - 1 : 0
      const end = limit > 0 ? start + limit : rows.length
      content = rows.slice(start, end).join('\n')
    }
    return { content }
  } catch (error) {
    throw new Error(`read denied or unreadable: ${path}: ${String(error?.message ?? error)}`)
  }
})

app.onRequest(methods.client.fs.writeTextFile, async () => {
  throw new Error('claude-code-review is a read-only reviewer: file writes are denied')
})

let timer
let startupTimer
try {
  const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))
  await app.connectWith(stream, async (ctx) => {
    if (startupTimeoutMs > 0) {
      // 启动预算必须短：卡死时 auto 要尽快回退 CLI，不能吃掉整轮 TimeoutSec。
      startupTimer = setTimeout(() => {
        if (!promptSent) {
          done(3, { subtype: 'acp_startup_timeout', is_error: true, phase, errors: [`ACP startup timed out after ${startupTimeoutMs}ms during ${phase}`] })
        }
      }, startupTimeoutMs)
      startupTimer.unref?.()
    }

    const init = await ctx.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: false },
        terminal: false,
      },
    })
    if (!init || init.protocolVersion !== 1) {
      throw new Error(`ACP initialize failed: ${JSON.stringify(init).slice(0, 500)}`)
    }
    phase = 'session'

    // reviewer role 必须留在 system 层，不能和不可信 diff 同级。
    // claude-agent-acp 声明 systemPrompt 能力时走 session/new；否则才退回 prompt 前置。
    const systemPromptSupported = Boolean(init?.agentCapabilities?.sessionCapabilities?.systemPrompt)
    const extraArgs = {}
    if (maxBudgetUsd > 0) extraArgs['max-budget-usd'] = maxBudgetUsd
    if (model) extraArgs.model = model
    if (effort) extraArgs.effort = effort
    const sessionRequest = {
      cwd,
      mcpServers: [],
      _meta: {
        claudeCode: {
          options: {
            disallowedTools: ['Write', 'Edit', 'NotebookEdit', 'Bash', 'PowerShell', 'WebFetch', 'WebSearch'],
            ...(Object.keys(extraArgs).length > 0 ? { extraArgs } : {}),
          },
        },
      },
    }
    if (roleText && systemPromptSupported) {
      sessionRequest.systemPrompt = {
        mode: 'append',
        content: [{ type: 'text', text: roleText }],
      }
      fullPrompt = promptText
      roleMode = 'system'
    }

    // 工具层只读必须显式建立：adapter 默认可能是 auto（分类器批准），
    // 而且被审仓库自己的 .claude/settings.json 可能把它改成 acceptEdits/bypassPermissions。
    // 1) 让 adapter 禁用写/执行/联网工具；2) 把会话模式切回 default，失败即中止。
    // 注意不要给 allowedTools 裸名：adapter 会先自动放行，canUseTool/requestPermission 根本收不到。
    sessionHandle = await ctx.buildSession(sessionRequest).start()
    phase = 'permission-mode'
    try {
      await ctx.request(methods.agent.session.setMode, {
        sessionId: sessionHandle.sessionId,
        modeId: 'default',
      })
    } catch (error) {
      throw new Error(`ACP 无法切到 default 权限模式（只读未建立）：${String(error?.message ?? error)}`)
    }
    phase = 'prompt'
    if (startupTimer) { clearTimeout(startupTimer); startupTimer = null }
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        done(1, { subtype: 'acp_timeout', is_error: true, phase, errors: [`ACP review timed out after ${timeoutMs}ms`] })
      }, timeoutMs)
      timer.unref?.()
    }

    const textPromise = sessionHandle.readText()
    promptSent = true
    const promptResponse = await sessionHandle.prompt(fullPrompt)
    const text = await textPromise
    const reviewJson = extractLastJsonObject(text)
    done(0, {
      subtype: 'success',
      is_error: false,
      result: reviewJson || text,
      stopReason: promptResponse?.stopReason ?? '',
      total_cost_usd: null,
      transport: 'acp',
      roleMode,
    })
  })
} catch (error) {
  const message = `ACP review failed${phase ? ` during ${phase}` : ''}: ${String(error?.message ?? error)}`
  const details = childStderr.trim() ? childStderr.trim().slice(-2000) : ''
  if (!promptSent) {
    // 尚未发出 prompt：传输/启动失败，没有任何 token 消耗，auto 可安全回退 CLI。
    done(3, {
      subtype: 'acp_startup_failed',
      is_error: true,
      phase,
      errors: details ? [message, details] : [message],
    })
  } else {
    done(1, {
      subtype: 'error',
      is_error: true,
      phase,
      errors: details ? [message, details] : [message],
    })
  }
} finally {
  if (timer) clearTimeout(timer)
  if (startupTimer) clearTimeout(startupTimer)
}
