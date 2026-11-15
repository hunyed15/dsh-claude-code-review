/**
 * 面板数据投影的确定性自测（不依赖 DSH、不调用模型）。
 *
 * 覆盖：
 *   A. matchFollowUp：按 key 匹配、按 file+severity+文本相似度匹配、同文件但文本变了、彻底消失
 *   B. loadPanel：用临时 fixture 目录验证轮次聚合、处置叠加、gate 推导、no-trellis 降级
 *   C. appendDispositions：校验 status/round，写入后能被 loadPanel 读回
 *   E. 复检推断：下一轮干净 pass 判 gone；nothing-to-review 不算复检
 *   F. 真实仓库（可选，CLAUDE_REVIEW_REPO 指定；无 .trellis 时跳过）
 *
 * 用法：从本包目录运行 `node test/panel-smoke.mjs`；真实仓库断言可用
 *       CLAUDE_REVIEW_REPO=D:\path\to\trellis-repo 指定（缺省用包上两级目录）。
 */
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  appendDispositions,
  deriveIssueStatus,
  deriveLifecycles,
  deriveNextAction,
  deriveRoundStatus,
  loadPanel,
  matchFollowUp,
  resolveTaskDir,
  textSimilarity,
} from '../panel.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = dirname(HERE)
const REPO = dirname(dirname(PACKAGE_DIR))

let passed = 0
const failures = []

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function check(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`PASS  ${name}`)
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// A. 匹配逻辑
{
  const prev = [
    { key: 'k1', file: 'a.js', severity: 'important', issue: 'timeoutSec 未接线，配置改了不生效' },
    { key: 'k2', file: 'b.js', severity: 'minor', issue: 'dryRun 返回 unknown' },
    { key: 'k3', file: 'c.js', severity: 'critical', issue: '并发写导致数据丢失' },
    { key: 'k4', file: 'd.js', severity: 'important', issue: '完全没有再现的问题' },
  ]
  const next = [
    { key: 'k1', file: 'a.js', severity: 'important', issue: 'timeoutSec 未接线，配置改了不生效' },
    { key: 'k9', file: 'b.js', severity: 'minor', issue: 'dryRun 仍然返回 unknown 而不是 dry-run' },
    { key: 'k8', file: 'c.js', severity: 'critical', issue: '加锁之后仍然存在竞态' },
  ]
  const matches = matchFollowUp(prev, next)
  check('A1 key 命中 → still-there', matches.get(0)?.state === 'still-there')
  check('A2 file+severity+相似 → still-there', matches.get(1)?.state === 'still-there', JSON.stringify(matches.get(1)))
  check('A3 同文件但文本变了 → same-file', matches.get(2)?.state === 'same-file', JSON.stringify(matches.get(2)))
  check('A4 完全消失 → gone', matches.get(3)?.state === 'gone')
  check('A5 相似度自反', textSimilarity('abc def', 'abc def') === 1)
}

// B/C. 用临时 fixture 跑 loadPanel 与 appendDispositions
{
  const root = await mkdtemp(join(tmpdir(), 'crc-panel-'))
  const taskName = '11-12-demo'
  const taskDir = join(root, '.trellis', 'tasks', taskName)
  const reviewDir = join(taskDir, 'review')
  await mkdir(reviewDir, { recursive: true })
  await writeFile(join(taskDir, 'task.json'), JSON.stringify({ id: 'demo', title: '演示任务', status: 'in_progress', priority: 'P1' }))
  await writeFile(join(taskDir, 'prd.md'), '# prd')
  await writeFile(join(taskDir, 'check.jsonl'), '{"file":"a.md","reason":"x"}\n{"file":"b.md","reason":"y"}\n')
  await writeFile(join(taskDir, 'implement.jsonl'), '{"file":"c.md","reason":"z"}\n')
  await writeFile(
    join(reviewDir, 'history.jsonl'),
    [
      JSON.stringify({ at: '2026-11-12T10:00:00', round: 1, mode: 'full', verdict: 'fix', critical: 1, important: 0, minor: 1, files: 2, cost_usd: null, transport: 'acp', transportWarning: 'ACP 不可用，已回退 CLI：fake' }),
      JSON.stringify({ at: '2026-11-12T10:10:00', round: 2, mode: 'full', verdict: 'pass', critical: 0, important: 0, minor: 1, files: 2, cost_usd: 0.4, transport: 'cli' }),
    ].join('\n') + '\n',
  )
  const issue1 = { key: 'aaa', severity: 'critical', file: 'x.js', line: '10', issue: '空指针崩溃', why: '会崩', fix: '判空' }
  const issue2 = { key: 'bbb', severity: 'minor', file: 'y.js', line: '2', issue: '命名不一致', why: '难读', fix: '改名' }
  const issue4 = { key: 'ddd', severity: 'minor', file: 'z.js', line: '5', issue: '空指针崩溃', why: '会崩', fix: '判空' }
  const issue3 = { key: 'ccc', severity: 'minor', file: 'y.js', line: '2', issue: '命名不一致', why: '难读', fix: '改名' }
  const issue5 = { key: 'eee', severity: 'minor', file: 'z.js', line: '5', issue: '内存泄漏', why: '会涨', fix: '释放' }
  await writeFile(
    join(reviewDir, 'review-1.json'),
    JSON.stringify({ meta: { round: 1, mode: 'full', session: { id: 'session-abc12345' } }, review: { verdict: 'fix', summary: '有问题', issues: [issue1, issue2, issue4] } }),
  )
  await writeFile(
    join(reviewDir, 'review-2.json'),
    JSON.stringify({ meta: { round: 2, mode: 'full', session: { id: 'session-abc12345' } }, review: { verdict: 'pass', summary: '只剩一条', issues: [issue3, issue5] } }),
  )

  const panel = await loadPanel(root)
  check('B1 识别项目', panel?.ok === true && panel.project.name === root.split(/[\\/]/).filter(Boolean).pop())
  check('B2 选中活动任务', panel.active?.task?.title === '演示任务')
  check('B3 两轮审核', panel.active?.rounds?.length === 2)
  check('B4 gate=pass（最后 full pass）', panel.active?.gate?.state === 'pass', JSON.stringify(panel.active?.gate))
  check('B5 prd 存在 / design 不存在', panel.active?.artifacts?.prd === true && panel.active?.artifacts?.design === false)
  check('B6 manifests 计数', panel.active?.manifests?.check === 2 && panel.active?.manifests?.implement === 1)

  const round1 = panel.active.rounds.find((round) => round.round === 1)
  const fixedIssue = round1.issues.find((issue) => issue.key === 'aaa')
  const lingering = round1.issues.find((issue) => issue.key === 'bbb')
  check('B7 第 1 轮消失的问题 → gone', fixedIssue?.disposition?.status === 'gone', JSON.stringify(fixedIssue?.disposition))
  check('B8 第 1 轮仍存在的问题 → still-there', lingering?.disposition?.status === 'still-there', JSON.stringify(lingering?.disposition))
  const otherFileIssue = round1.issues.find((issue) => issue.key === 'ddd')
  check('B10 同文件不同问题 → same-file（不复用 still-there）', otherFileIssue?.disposition?.status === 'same-file', JSON.stringify(otherFileIssue?.disposition))
  check('B9 第 2 轮无下一轮 → unreviewed', panel.active.rounds.find((r) => r.round === 2).issues[0]?.disposition?.status === 'unreviewed')
  const acpRound = panel.active.rounds.find((round) => round.round === 1)
  const acpWarning = acpRound?.transportWarning
  check('B11 面板透传 transportWarning', String(acpWarning ?? '').includes('ACP 不可用'), JSON.stringify(acpWarning))
  // round 1 是 ACP（成本未知）；round 2 有 costUsd；总成本必须标记为部分和
  check('B12 成本未知轮次让总成本标记不完整', panel.active?.totalCostKnown === false, JSON.stringify({ totalCostUsd: panel.active?.totalCostUsd, totalCostKnown: panel.active?.totalCostKnown }))

  await appendDispositions(taskDir, [{ round: 1, key: 'aaa', status: 'fixed', note: '已加判空', evidence: ['x.js'] }], 'session-abc12345')
  const panel2 = await loadPanel(root)
  const explicit = panel2.active.rounds.find((round) => round.round === 1).issues.find((issue) => issue.key === 'aaa')
  check('C1 显式处置覆盖推断', explicit?.disposition?.status === 'fixed' && explicit?.disposition?.source === 'recorded')
  check('C2 处置备注可见', String(explicit?.disposition?.note).includes('已加判空'))

  let rejected = ''
  try {
    await appendDispositions(taskDir, [{ round: 1, key: 'x', status: 'nonsense' }], 's')
  } catch (error) {
    rejected = String(error?.message ?? error)
  }
  check('C3 非法 status 被拒', rejected.includes('status 必须是'), rejected)

  let strictRejected = ''
  try {
    await resolveTaskDir(root)
  } catch (error) {
    strictRejected = String(error?.message ?? error)
  }
  check('C4 Trellis 无显式 taskDir → 拒绝猜测', strictRejected.includes('taskDir') || strictRejected.includes('TaskDir'), strictRejected)
  const explicitResolved = await resolveTaskDir(root, taskDir)
  check('C5 显式 taskDir 可解析', explicitResolved.toLowerCase().includes('11-12-demo'), explicitResolved)

  const missing = await loadPanel(join(root, 'not-a-project'))
  check('D1 不存在的项目 → cwd-not-found', missing?.ok === false && missing.error === 'cwd-not-found', JSON.stringify(missing))

  await rm(root, { recursive: true, force: true })
}

// T. 截断/自定义 Base：面板可见，且不能过 gate
{
  const root = await mkdtemp(join(tmpdir(), 'crc-trunc-'))
  const taskDir = join(root, '.trellis', 'tasks', 'trunc')
  const reviewDir = join(taskDir, 'review')
  await mkdir(reviewDir, { recursive: true })
  await writeFile(join(taskDir, 'task.json'), JSON.stringify({ id: 'trunc', name: 'trunc', title: '截断', status: 'in_progress' }))
  await writeFile(
    join(reviewDir, 'history.jsonl'),
    JSON.stringify({
      at: '2026-11-13T10:00:00',
      round: 1,
      mode: 'full',
      verdict: 'pass',
      critical: 0,
      important: 0,
      minor: 0,
      files: 1,
      snapshot: 'x',
      truncated: true,
    }) + '\n',
  )
  await writeFile(join(reviewDir, 'review-1.json'), JSON.stringify({ meta: { truncated: true, mode: 'full' }, review: { verdict: 'pass', issues: [] } }))
  const panel = await loadPanel(root)
  check('T1 轮次带 truncated 标记', panel?.active?.rounds?.[0]?.truncated === true, JSON.stringify(panel?.active?.rounds?.[0]))
  check(
    'T2 截断 full pass → gate blocked',
    panel?.active?.gate?.state === 'blocked' && String(panel.active.gate.reason).includes('截断'),
    JSON.stringify(panel?.active?.gate),
  )
  await rm(root, { recursive: true, force: true })
}

// U. 自定义 -Base 的 full 不能冒充收尾门禁
{
  const root = await mkdtemp(join(tmpdir(), 'crc-basecustom-'))
  const taskDir = join(root, '.trellis', 'tasks', 'base')
  const reviewDir = join(taskDir, 'review')
  await mkdir(reviewDir, { recursive: true })
  await writeFile(join(taskDir, 'task.json'), JSON.stringify({ id: 'base', name: 'base', title: 'base', status: 'in_progress' }))
  await writeFile(
    join(reviewDir, 'history.jsonl'),
    JSON.stringify({ at: '2026-11-13T10:00:00', round: 1, mode: 'full', verdict: 'pass', critical: 0, important: 0, minor: 0, files: 1, snapshot: 'x', baseCustom: true }) + '\n',
  )
  await writeFile(join(reviewDir, 'review-1.json'), JSON.stringify({ meta: { baseCustom: true, mode: 'full' }, review: { verdict: 'pass', issues: [] } }))
  const panel = await loadPanel(root)
  check(
    'U1 full -Base → gate blocked',
    panel?.active?.gate?.state === 'blocked' && String(panel.active.gate.reason).includes('Base'),
    JSON.stringify(panel?.active?.gate),
  )
  await rm(root, { recursive: true, force: true })
}

// S. 换措辞但语义相同 → 同一 lifecycle 簇；同文件不同问题 → 不误并
{
  const r1 = { round: 1, issues: [{ key: 'aaa', file: 'x.js', severity: 'important', issue: '缺少空值判断，可能崩溃' }] }
  const r2 = { round: 2, issues: [{ key: 'zzz', file: 'x.js', severity: 'important', issue: '空值判断缺失，可能崩溃' }] }
  deriveLifecycles([r1, r2], new Set([1, 2]))
  check(
    'S1 换措辞仍判 still-there 且 firstRound=1',
    r2.issues[0]?.lifecycle?.state === 'still-there' && r2.issues[0]?.lifecycle?.firstRound === 1,
    JSON.stringify(r2.issues[0]?.lifecycle),
  )

  const r3 = { round: 1, issues: [{ key: 'aaa', file: 'x.js', severity: 'important', issue: '缺少空值判断' }] }
  const r4 = { round: 2, issues: [{ key: 'bbb', file: 'x.js', severity: 'important', issue: '日志格式错误，缺少字段' }] }
  deriveLifecycles([r3, r4], new Set([1, 2]))
  check('S2 同文件不同问题不误并', r4.issues[0]?.lifecycle?.state === 'new', JSON.stringify(r4.issues[0]?.lifecycle))

  const r5 = { round: 1, issues: [{ key: '', file: '', severity: '', issue: '遗留问题 A' }] }
  const r6 = { round: 2, issues: [{ key: '', file: '', severity: '', issue: '遗留问题 B' }] }
  deriveLifecycles([r5, r6], new Set([1, 2]))
  check(
    'S3 空 file/空 key 的极端旧数据保持 unknown',
    r5.issues[0]?.lifecycle?.state === 'unknown' && r6.issues[0]?.lifecycle?.state === 'unknown',
    JSON.stringify([r5.issues[0]?.lifecycle, r6.issues[0]?.lifecycle]),
  )

  const r7 = { round: 1, issues: [{ key: 'empty-file-key', file: '', severity: 'important', issue: '无文件信息但 key 稳定' }] }
  const r8 = { round: 2, issues: [{ key: 'empty-file-key', file: '', severity: 'important', issue: '无文件信息但 key 稳定' }] }
  deriveLifecycles([r7, r8], new Set([1, 2]))
  check(
    'S4 空 file 但有 key 仍跨轮跟踪',
    r8.issues[0]?.lifecycle?.state === 'still-there' && r8.issues[0]?.lifecycle?.firstRound === 1,
    JSON.stringify(r8.issues[0]?.lifecycle),
  )
}

// D. 本地账本：没有 .trellis 也能看板，不要求 Trellis
{
  const plain = await mkdtemp(join(tmpdir(), 'crc-plain-'))
  const emptyPanel = await loadPanel(plain)
  check('D2 无 .trellis → 本地空账本', emptyPanel?.ok === true && emptyPanel.storage === 'local')
  check('D3 本地空账本有活动任务', emptyPanel?.active?.rounds?.length === 0 && emptyPanel.active.task.name === 'local')
  await rm(plain, { recursive: true, force: true })

  const root = await mkdtemp(join(tmpdir(), 'crc-local-panel-'))
  const taskDir = join(root, '.dsh', 'claude-review', 'ledger')
  const reviewDir = join(taskDir, 'review')
  await mkdir(reviewDir, { recursive: true })
  await writeFile(join(taskDir, 'task.json'), JSON.stringify({ id: 'local', name: 'local', title: '本地项目', status: 'in_progress' }))
  await writeFile(
    join(reviewDir, 'history.jsonl'),
    JSON.stringify({ at: '2026-11-12T10:00:00', round: 1, mode: 'full', verdict: 'pass', critical: 0, important: 0, minor: 0, files: 1, cost_usd: 0.2 }) + '\n',
  )
  await writeFile(
    join(reviewDir, 'review-1.json'),
    JSON.stringify({
      meta: {},
      review: {
        verdict: 'pass',
        summary: 'ok',
        issues: [],
        strengths: [{ point: '做得稳', evidence: 'x.js:1' }],
        recommendations: ['补一个边界测试'],
        assessment: '结构清晰',
      },
    }),
  )
  const panel = await loadPanel(root)
  check('D4 本地账本 storage=local', panel?.ok === true && panel.storage === 'local')
  check('D5 本地任务标题', panel?.active?.task?.title === '本地项目', panel?.active?.task?.title)
  check('D6 本地轮次可读', panel?.active?.rounds?.length === 1)
  check('D7 strengths/recommendations 可读', panel?.active?.rounds?.[0]?.strengths?.[0]?.point === '做得稳')
  check('D8 本地成本累计', panel?.active?.totalCostUsd === 0.2)
  check('D9 full pass → 下一步 gate', panel?.active?.nextAction?.key === 'gate')

  const runPath = join(reviewDir, 'run.json')
  const now = new Date()
  const running = {
    status: 'running',
    phase: 'reviewing',
    storage: 'local',
    mode: 'full',
    round: 1,
    task: 'local',
    startedAt: new Date(now.getTime() - 5000).toISOString(),
    updatedAt: now.toISOString(),
  }
  await writeFile(runPath, JSON.stringify(running))
  let runningPanel = await loadPanel(root)
  check('D10 运行中可读', runningPanel?.active?.run?.status === 'running' && runningPanel.active.run.stale === false)
  await writeFile(runPath, JSON.stringify({ ...running, updatedAt: new Date(now.getTime() - 300000).toISOString() }))
  runningPanel = await loadPanel(root)
  check('D11 心跳超时 → stale', runningPanel?.active?.run?.stale === true)
  await writeFile(runPath, JSON.stringify({ status: 'failed', phase: 'failed', error: 'timeout', updatedAt: now.toISOString() }))
  runningPanel = await loadPanel(root)
  check('D12 失败状态可读', runningPanel?.active?.run?.status === 'failed' && runningPanel.active.run.error === 'timeout')
  await writeFile(runPath, JSON.stringify({ status: 'done', updatedAt: now.toISOString() }))
  runningPanel = await loadPanel(root)
  check('D13 完成态不显示运行条', runningPanel?.active?.run === null)
  await rm(root, { recursive: true, force: true })
}

// E. 问题生命周期：new / still-there / fixed / reopened
{
  const root = await mkdtemp(join(tmpdir(), 'crc-life-'))
  const taskDir = join(root, '.trellis', 'tasks', 'lifecycle')
  const reviewDir = join(taskDir, 'review')
  await mkdir(reviewDir, { recursive: true })
  await writeFile(join(taskDir, 'task.json'), JSON.stringify({ name: 'lifecycle', title: '生命周期', status: 'in_progress' }))
  const issue = (key, text) => ({ key, severity: 'important', file: 'a.js', line: '1', issue: text, why: 'x', fix: 'y' })
  await writeFile(
    join(reviewDir, 'history.jsonl'),
    [
      JSON.stringify({ at: '2026-11-12T10:00:00', round: 1, mode: 'full', verdict: 'fix', critical: 0, important: 3, minor: 0, files: 1 }),
      JSON.stringify({ at: '2026-11-12T10:10:00', round: 2, mode: 'full', verdict: 'pass', critical: 0, important: 0, minor: 0, files: 1 }),
      JSON.stringify({ at: '2026-11-12T10:20:00', round: 3, mode: 'full', verdict: 'pass', critical: 0, important: 0, minor: 0, files: 1 }),
    ].join('\n') + '\n',
  )
  await writeFile(join(reviewDir, 'review-1.json'), JSON.stringify({ meta: {}, review: { verdict: 'fix', summary: 'x', issues: [issue('a', 'A'), issue('b', 'B'), issue('c', 'C')] } }))
  await writeFile(join(reviewDir, 'review-2.json'), JSON.stringify({ meta: {}, review: { verdict: 'pass', summary: 'y', issues: [issue('a', 'A')] } }))
  await writeFile(join(reviewDir, 'review-3.json'), JSON.stringify({ meta: {}, review: { verdict: 'pass', summary: 'z', issues: [issue('a', 'A'), issue('b', 'B')] } }))

  const panel = await loadPanel(root)
  const round = (n) => panel.active.rounds.find((item) => item.round === n)
  const lifecycle = (n, key) => round(n).issues.find((item) => item.key === key)?.lifecycle?.state
  check('E1 首轮发现 → new', lifecycle(1, 'a') === 'new' && lifecycle(1, 'b') === 'new')
  check('E2 后续仍存在 → still-there', lifecycle(2, 'a') === 'still-there')
  check('E3 后续消失 → fixed', lifecycle(1, 'c') === 'fixed', lifecycle(1, 'c'))
  check('E4 消失后复发 → reopened', lifecycle(3, 'b') === 'reopened', lifecycle(3, 'b'))
  await rm(root, { recursive: true, force: true })
}

// F. 任务切换：loadPanel({ task }) 选中指定任务
{
  const root = await mkdtemp(join(tmpdir(), 'crc-switch-'))
  for (const name of ['alpha', 'beta']) {
    const taskDir = join(root, '.trellis', 'tasks', name)
    const reviewDir = join(taskDir, 'review')
    await mkdir(reviewDir, { recursive: true })
    await writeFile(join(taskDir, 'task.json'), JSON.stringify({ name, title: `任务 ${name}`, status: 'in_progress' }))
    await writeFile(join(reviewDir, 'history.jsonl'), JSON.stringify({ at: '2026-11-12T10:00:00', round: 1, mode: 'full', verdict: 'pass', critical: 0, important: 0, minor: 0, files: 1 }) + '\n')
    await writeFile(join(reviewDir, 'review-1.json'), JSON.stringify({ meta: {}, review: { verdict: 'pass', summary: name, issues: [] } }))
  }
  const panel = await loadPanel(root, { task: 'beta' })
  check('F1 指定 task 被选中', panel?.active?.task?.name === 'beta', panel?.active?.task?.name)
  check('F2 任务列表包含两个任务', panel?.tasks?.length === 2)
  await rm(root, { recursive: true, force: true })
}

// G. nextAction 推导
{
  check('G1 无轮次 → review', deriveNextAction({ rounds: [], gate: { state: 'unknown' } }).key === 'review')
  check(
    'G2 最近 fix → fix',
    deriveNextAction({ rounds: [{ round: 1, verdict: 'fix', mode: 'full', counts: { critical: 1, important: 1 } }], gate: { state: 'blocked' } }).key === 'fix',
  )
  check(
    'G3 incremental pass → full',
    deriveNextAction({ rounds: [{ round: 1, verdict: 'pass', mode: 'incremental', counts: {} }], gate: { state: 'blocked' } }).key === 'full',
  )
  check(
    'G4 full pass + gate pass → gate',
    deriveNextAction({ rounds: [{ round: 1, verdict: 'pass', mode: 'full', counts: {} }], gate: { state: 'pass' } }).key === 'gate',
  )
  check(
    'G5 full nothing-to-review + gate pass → gate',
    deriveNextAction({ rounds: [{ round: 1, verdict: 'nothing-to-review', mode: 'full', counts: {} }], gate: { state: 'pass' } }).key ===
      'gate',
  )
  check(
    'G6 incremental nothing-to-review → full',
    deriveNextAction({ rounds: [{ round: 1, verdict: 'nothing-to-review', mode: 'incremental', counts: {} }], gate: { state: 'blocked' } })
      .key === 'full',
  )
  check(
    'G7 range pass + gate blocked → full',
    deriveNextAction({ rounds: [{ round: 1, verdict: 'pass', mode: 'range', counts: {} }], gate: { state: 'blocked' } }).key === 'full',
  )
  check(
    'G8 truncated full pass → 重跑 full',
    deriveNextAction({ rounds: [{ round: 1, verdict: 'pass', mode: 'full', counts: {} }], gate: { state: 'blocked', reason: '最近一次审核的 diff 被截断' } }).key ===
      'full',
  )
  check(
    'G9 自定义 Base full pass → 重跑 full',
    deriveNextAction({ rounds: [{ round: 1, verdict: 'pass', mode: 'full', counts: {} }], gate: { state: 'blocked', reason: '最近一次 full 使用了自定义 -Base' } })
      .key === 'full',
  )
  check(
    'G10 nothing-to-review + 快照降级 → 重跑 full',
    deriveNextAction({
      rounds: [{ round: 1, verdict: 'nothing-to-review', mode: 'full', counts: {} }],
      gate: { state: 'blocked', reason: '最近一次审核在快照降级下运行' },
    }).key === 'full',
  )
  check(
    'G11 nothing-to-review + 自定义 Base → 重跑 full',
    deriveNextAction({
      rounds: [{ round: 1, verdict: 'nothing-to-review', mode: 'full', counts: {} }],
      gate: { state: 'blocked', reason: '最近一次 full 使用了自定义 -Base' },
    }).key === 'full',
  )
}

// H. 后续“干净 pass”也算复检；nothing-to-review 不算
{
  const root = await mkdtemp(join(tmpdir(), 'crc-clean-'))
  const taskDir = join(root, '.trellis', 'tasks', 'clean')
  const reviewDir = join(taskDir, 'review')
  await mkdir(reviewDir, { recursive: true })
  await writeFile(join(taskDir, 'task.json'), JSON.stringify({ title: '干净收尾', status: 'in_progress' }))
  const issue = { key: 'aaa', severity: 'critical', file: 'x.js', line: '1', issue: '空指针', why: '会崩', fix: '判空' }
  await writeFile(
    join(reviewDir, 'history.jsonl'),
    [
      JSON.stringify({ at: '2026-11-12T10:00:00', round: 1, mode: 'full', verdict: 'fix', critical: 1, important: 0, minor: 0 }),
      JSON.stringify({ at: '2026-11-12T10:10:00', round: 2, mode: 'full', verdict: 'nothing-to-review', critical: 0, important: 0, minor: 0 }),
      JSON.stringify({ at: '2026-11-12T10:20:00', round: 3, mode: 'full', verdict: 'pass', critical: 0, important: 0, minor: 0 }),
    ].join('\n') + '\n',
  )
  await writeFile(join(reviewDir, 'review-1.json'), JSON.stringify({ meta: {}, review: { verdict: 'fix', summary: 'x', issues: [issue] } }))
  await writeFile(join(reviewDir, 'review-3.json'), JSON.stringify({ meta: {}, review: { verdict: 'pass', summary: 'clean', issues: [] } }))

  const panel = await loadPanel(root)
  const first = panel.active.rounds.find((round) => round.round === 1)
  check('H1 后续干净 pass → gone', first?.issues?.[0]?.disposition?.status === 'gone', JSON.stringify(first?.issues?.[0]?.disposition))
  check(
    'H2 用第 3 轮（full）复检，跳过 nothing-to-review',
    String(first?.issues?.[0]?.disposition?.note).includes('第 3 轮') &&
      String(first?.issues?.[0]?.disposition?.note).includes('full'),
    String(first?.issues?.[0]?.disposition?.note),
  )
  check('H3 nothing-to-review 轮次没有问题', (panel.active.rounds.find((round) => round.round === 2)?.issues?.length ?? -1) === 0)
  await rm(root, { recursive: true, force: true })

  // 只有 nothing-to-review 时，没人复检过，不能推断为已修
  const root2 = await mkdtemp(join(tmpdir(), 'crc-ntr-'))
  const taskDir2 = join(root2, '.trellis', 'tasks', 'ntr')
  const reviewDir2 = join(taskDir2, 'review')
  await mkdir(reviewDir2, { recursive: true })
  await writeFile(join(taskDir2, 'task.json'), JSON.stringify({ title: '只跑了空快照', status: 'in_progress' }))
  await writeFile(
    join(reviewDir2, 'history.jsonl'),
    [
      JSON.stringify({ at: '2026-11-12T10:00:00', round: 1, mode: 'full', verdict: 'fix', critical: 1, important: 0, minor: 0 }),
      JSON.stringify({ at: '2026-11-12T10:10:00', round: 2, mode: 'full', verdict: 'nothing-to-review', critical: 0, important: 0, minor: 0 }),
    ].join('\n') + '\n',
  )
  await writeFile(join(reviewDir2, 'review-1.json'), JSON.stringify({ meta: {}, review: { verdict: 'fix', summary: 'x', issues: [issue] } }))
  const panel2 = await loadPanel(root2)
  const still = panel2.active.rounds.find((round) => round.round === 1)
  check('H4 只有 nothing-to-review → unreviewed', still?.issues?.[0]?.disposition?.status === 'unreviewed', JSON.stringify(still?.issues?.[0]?.disposition))
  check('H5 只有 nothing-to-review → lifecycle unreviewed', still?.issues?.[0]?.lifecycle?.state === 'unreviewed', JSON.stringify(still?.issues?.[0]?.lifecycle))
  const nothingRound = panel2.active.rounds.find((round) => round.round === 2)
  check('H6 nothing-to-review 成本已知为 0', nothingRound?.costKnown === true && nothingRound?.costUsd === 0, JSON.stringify({ costKnown: nothingRound?.costKnown, costUsd: nothingRound?.costUsd }))
  await rm(root2, { recursive: true, force: true })
}

// I. 真实仓库（有 .trellis）应能读出任务；包不在 Trellis 仓库内时跳过
{
  const realRepo = process.env.CLAUDE_REVIEW_REPO || REPO
  if (!(await exists(join(realRepo, '.trellis')))) {
    console.log(`SKIP  I1/I2 真实仓库（${realRepo} 下没有 .trellis；可用 CLAUDE_REVIEW_REPO 指定）`)
  } else {
    const panel = await loadPanel(realRepo)
    check('I1 真实仓库可读', panel?.ok === true && Array.isArray(panel.tasks))
    check('I2 有活动任务或至少有任务列表', Boolean(panel) && (panel.active !== null || panel.tasks.length > 0))
  }
}

// K. 缺陷全流程：issue 状态机 / round 状态机 / nextAction
{
  const issue = (over = {}) => ({ key: 'k', severity: 'critical', file: 'a.js', line: '1', issue: 'x', ...over })
  const disp = (status) => ({ disposition: { status, source: 'recorded', note: '' } })

  check('K1 显式 fixed + 下一轮消失 → verified', deriveIssueStatus({ ...issue(), ...disp('fixed'), followUp: 'gone' }) === 'verified')
  check('K2 显式 fixed + 下一轮仍存在 → reopened', deriveIssueStatus({ ...issue(), ...disp('fixed'), followUp: 'still-there' }) === 'reopened')
  check('K3 显式 fixed + 无后续 → fixed', deriveIssueStatus({ ...issue(), ...disp('fixed') }) === 'fixed')
  check('K4 无处置 + 下一轮消失 → verified', deriveIssueStatus({ ...issue(), followUp: 'gone' }) === 'verified')
  check('K5 无处置 + 下一轮仍存在 → reopened', deriveIssueStatus({ ...issue(), followUp: 'still-there' }) === 'reopened')
  check('K6 deferred → deferred', deriveIssueStatus({ ...issue(), ...disp('deferred') }) === 'deferred')
  check('K7 无处置/无后续 → open', deriveIssueStatus(issue()) === 'open')

  check('K8 未处置 blocking → open', deriveRoundStatus({ round: 1, issues: [issue({ status: 'open' })] }).status === 'open')
  check(
    'K9 部分处置 → fixing',
    deriveRoundStatus({ round: 1, issues: [issue({ status: 'fixed' }), issue({ key: 'k2', status: 'open' })] }).status === 'fixing',
  )
  check('K10 全部 fixed → ready-for-verification', deriveRoundStatus({ round: 1, issues: [issue({ status: 'fixed' })] }).status === 'ready-for-verification')
  check(
    'K11 verified + minor → verified',
    deriveRoundStatus({ round: 1, issues: [issue({ status: 'verified' }), issue({ key: 'm', severity: 'minor', status: 'open' })] }).status === 'verified',
  )
  check('K12 deferred → closed-with-risk', deriveRoundStatus({ round: 1, issues: [issue({ status: 'deferred' })] }).status === 'closed-with-risk')
  check('K13 reopened → reopened', deriveRoundStatus({ round: 1, issues: [issue({ status: 'reopened' })] }).status === 'reopened')
  check('K14 只有 minor open → verified（不阻断）', deriveRoundStatus({ round: 1, issues: [issue({ key: 'm', severity: 'minor', status: 'open' })] }).status === 'verified')

  const openAction = deriveNextAction({
    rounds: [{ round: 1, verdict: 'fix', mode: 'full', counts: { critical: 1 }, issues: [issue({ status: 'open' })] }],
    gate: { state: 'blocked' },
  })
  check(
    'K15 nextAction 未处置 → fix + 处置提示',
    openAction.key === 'fix' && openAction.label.includes('处置') && openAction.detail.includes('claude_review_disposition'),
    JSON.stringify(openAction),
  )
  const readyAction = deriveNextAction({
    rounds: [{ round: 1, verdict: 'fix', mode: 'full', counts: { critical: 1 }, issues: [issue({ status: 'fixed' })] }],
    gate: { state: 'blocked' },
  })
  check('K16 nextAction 全部 fixed → review（复检）', readyAction.key === 'review' && readyAction.label.includes('复检'), JSON.stringify(readyAction))
  const riskAction = deriveNextAction({
    rounds: [{ round: 1, verdict: 'fix', mode: 'full', counts: { critical: 1 }, issues: [issue({ status: 'deferred' })] }],
    gate: { state: 'blocked' },
  })
  check('K17 nextAction deferred → gate（风险提示）', riskAction.key === 'gate' && riskAction.detail.includes('暂缓'), JSON.stringify(riskAction))
  const rangeAction = deriveNextAction({
    rounds: [
      { round: 1, verdict: 'fix', mode: 'full', counts: { critical: 1 }, status: 'ready-for-verification', issues: [issue({ status: 'fixed' })] },
      { round: 2, verdict: 'nothing-to-review', mode: 'full', counts: {}, issues: [] },
    ],
    gate: { state: 'pass' },
  })
  check('K18 nextAction nothing + 上轮 ready → range', rangeAction.key === 'range' && rangeAction.detail.includes('-Mode range'), JSON.stringify(rangeAction))
}

// L. loadPanel 全流程：issue/round 状态与 nextAction 串联
{
  const critical = { key: 'k1', severity: 'critical', file: 'a.js', line: '1', issue: '空指针', why: '会崩', fix: '判空' }
  async function flowPanel({ review2 = 'none', disposition = null, failOn = null, severity = 'critical', withNull = false } = {}) {
    const root = await mkdtemp(join(tmpdir(), 'crc-flow-'))
    const taskDir = join(root, '.trellis', 'tasks', 'flow')
    const reviewDir = join(taskDir, 'review')
    const issue = { ...critical, severity }
    const meta = failOn ? { failOn } : {}
    await mkdir(reviewDir, { recursive: true })
    await writeFile(join(taskDir, 'task.json'), JSON.stringify({ title: '流程任务', status: 'in_progress' }))
    const rows = [
      JSON.stringify({
        at: '2026-11-12T10:00:00',
        round: 1,
        mode: 'full',
        verdict: 'fix',
        critical: severity === 'critical' ? 1 : 0,
        important: severity === 'important' ? 1 : 0,
        minor: 0,
        files: 1,
      }),
    ]
    const firstIssues = withNull ? [null, issue] : [issue]
    await writeFile(join(reviewDir, 'review-1.json'), JSON.stringify({ meta, review: { verdict: 'fix', summary: '发现空指针', issues: firstIssues } }))
    if (review2 !== 'none') {
      const verdict = review2 === 'pass' ? 'pass' : review2 === 'nothing' ? 'nothing-to-review' : 'fix'
      rows.push(
        JSON.stringify({
          at: '2026-11-12T10:10:00',
          round: 2,
          mode: 'full',
          verdict,
          critical: review2 === 'still' && severity === 'critical' ? 1 : 0,
          important: review2 === 'still' && severity === 'important' ? 1 : 0,
          minor: 0,
          files: 1,
        }),
      )
      if (review2 !== 'nothing') {
        await writeFile(
          join(reviewDir, 'review-2.json'),
          JSON.stringify({ meta, review: { verdict, summary: '复检', issues: review2 === 'still' ? [issue] : [] } }),
        )
      }
    }
    await writeFile(join(reviewDir, 'history.jsonl'), rows.join('\n') + '\n')
    if (disposition) {
      await writeFile(join(reviewDir, 'dispositions.jsonl'), JSON.stringify({ round: 1, key: 'k1', status: disposition, note: '已处理' }) + '\n')
    }
    const panel = await loadPanel(root)
    await rm(root, { recursive: true, force: true })
    return panel
  }

  const verified = await flowPanel({ review2: 'pass', disposition: 'fixed' })
  const v1 = verified.active.rounds.find((round) => round.round === 1)
  const v2 = verified.active.rounds.find((round) => round.round === 2)
  check('L1 复检通过 → issue verified', v1.issues[0].status === 'verified', JSON.stringify(v1.issues[0]))
  check('L2 round 1 verified', v1.status === 'verified', JSON.stringify(v1))
  check('L3 round 2 verified/pass', v2.status === 'verified' && v2.verdict === 'pass')
  check('L4 pending 归零', verified.active.pending === 0, JSON.stringify(verified.active.pending))
  check('L5 nextAction gate', verified.active.nextAction.key === 'gate', JSON.stringify(verified.active.nextAction))

  const ready = await flowPanel({ disposition: 'fixed' })
  const r1 = ready.active.rounds.find((round) => round.round === 1)
  check('L6 已修待复检 → issue fixed', r1.issues[0].status === 'fixed', JSON.stringify(r1.issues[0]))
  check('L7 已修待复检 → round ready-for-verification', r1.status === 'ready-for-verification', JSON.stringify(r1))
  check('L8 已修待复检 → nextAction review', ready.active.nextAction.key === 'review', JSON.stringify(ready.active.nextAction))

  const ntr = await flowPanel({ review2: 'nothing', disposition: 'fixed' })
  const n1 = ntr.active.rounds.find((round) => round.round === 1)
  check('L9 nothing 不算复检 → issue fixed', n1.issues[0].status === 'fixed', JSON.stringify(n1.issues[0]))
  check('L10 nothing 后 → nextAction range', ntr.active.nextAction.key === 'range', JSON.stringify(ntr.active.nextAction))

  const still = await flowPanel({ review2: 'still', disposition: 'fixed' })
  const s1 = still.active.rounds.find((round) => round.round === 1)
  check('L11 复检仍存在 → issue reopened', s1.issues[0].status === 'reopened', JSON.stringify(s1.issues[0]))
  check('L12 复检仍存在 → round reopened', s1.status === 'reopened', JSON.stringify(s1))

  const deferred = await flowPanel({ disposition: 'deferred' })
  const d1 = deferred.active.rounds.find((round) => round.round === 1)
  check('L13 deferred → issue deferred', d1.issues[0].status === 'deferred', JSON.stringify(d1.issues[0]))
  check('L14 deferred → round closed-with-risk', d1.status === 'closed-with-risk', JSON.stringify(d1))
  check('L15 deferred → nextAction gate', deferred.active.nextAction.key === 'gate', JSON.stringify(deferred.active.nextAction))

  const open = await flowPanel()
  const o1 = open.active.rounds.find((round) => round.round === 1)
  check('L16 未处置 → issue open', o1.issues[0].status === 'open', JSON.stringify(o1.issues[0]))
  check('L17 未处置 → round open', o1.status === 'open', JSON.stringify(o1))
  check('L18 未处置 → nextAction fix', open.active.nextAction.key === 'fix', JSON.stringify(open.active.nextAction))

  const custom = await flowPanel({ failOn: ['critical'], severity: 'important' })
  const c1 = custom.active.rounds.find((round) => round.round === 1)
  check(
    'L19 自定义 failOn=critical → important 不阻断',
    c1.status === 'verified' && c1.openBlocking === 0 && custom.active.pending === 0,
    JSON.stringify({ status: c1.status, openBlocking: c1.openBlocking, pending: custom.active.pending, meta: c1.failOn }),
  )
  check('L20 自定义 failOn → nextAction 不要求处置', custom.active.nextAction.key === 'gate', JSON.stringify(custom.active.nextAction))

  const nullIssue = await flowPanel({ withNull: true })
  const nullR1 = nullIssue.active.rounds.find((round) => round.round === 1)
  check(
    'L21 null issue 不生成幻影条目且保留原始 index',
    nullR1.issues.length === 1 && nullR1.issues[0].index === 1,
    JSON.stringify(nullR1.issues),
  )
}

console.log('')
console.log(`结果: passed=${passed} failed=${failures.length}`)
for (const failure of failures) console.log(`  FAIL ${failure}`)
process.exit(failures.length > 0 ? 1 : 0)

