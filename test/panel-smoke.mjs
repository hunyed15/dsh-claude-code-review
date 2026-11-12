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

import { appendDispositions, deriveNextAction, loadPanel, matchFollowUp, textSimilarity } from '../panel.js'

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
      JSON.stringify({ at: '2026-11-12T10:00:00', round: 1, mode: 'full', verdict: 'fix', critical: 1, important: 0, minor: 1, files: 2, cost_usd: 0.5 }),
      JSON.stringify({ at: '2026-11-12T10:10:00', round: 2, mode: 'full', verdict: 'pass', critical: 0, important: 0, minor: 1, files: 2, cost_usd: 0.4 }),
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

  const missing = await loadPanel(join(root, 'not-a-project'))
  check('D1 不存在的项目 → cwd-not-found', missing?.ok === false && missing.error === 'cwd-not-found', JSON.stringify(missing))

  await rm(root, { recursive: true, force: true })
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

console.log('')
console.log(`结果: passed=${passed} failed=${failures.length}`)
for (const failure of failures) console.log(`  FAIL ${failure}`)
process.exit(failures.length > 0 ? 1 : 0)

