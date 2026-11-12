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

import { appendDispositions, loadPanel, matchFollowUp, textSimilarity } from '../panel.js'

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

  const none = await loadPanel(join(root, 'not-a-project'))
  check('D1 无 .trellis → null', none === null)

  await rm(root, { recursive: true, force: true })
}

// E. 后续“干净 pass”也算复检；nothing-to-review 不算
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
  check('E1 后续干净 pass → gone', first?.issues?.[0]?.disposition?.status === 'gone', JSON.stringify(first?.issues?.[0]?.disposition))
  check(
    'E2 用第 3 轮（full）复检，跳过 nothing-to-review',
    String(first?.issues?.[0]?.disposition?.note).includes('第 3 轮') &&
      String(first?.issues?.[0]?.disposition?.note).includes('full'),
    String(first?.issues?.[0]?.disposition?.note),
  )
  check('E3 nothing-to-review 轮次没有问题', (panel.active.rounds.find((round) => round.round === 2)?.issues?.length ?? -1) === 0)
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
  check('E4 只有 nothing-to-review → unreviewed', still?.issues?.[0]?.disposition?.status === 'unreviewed', JSON.stringify(still?.issues?.[0]?.disposition))
  await rm(root2, { recursive: true, force: true })
}

// F. 真实仓库（有 .trellis）应能读出任务；包不在 Trellis 仓库内时跳过
{
  const realRepo = process.env.CLAUDE_REVIEW_REPO || REPO
  if (!(await exists(join(realRepo, '.trellis')))) {
    console.log(`SKIP  F1/F2 真实仓库（${realRepo} 下没有 .trellis；可用 CLAUDE_REVIEW_REPO 指定）`)
  } else {
    const panel = await loadPanel(realRepo)
    check('F1 真实仓库可读', panel?.ok === true && Array.isArray(panel.tasks))
    check('F2 有活动任务或至少有任务列表', Boolean(panel) && (panel.active !== null || panel.tasks.length > 0))
  }
}

console.log('')
console.log(`结果: passed=${passed} failed=${failures.length}`)
for (const failure of failures) console.log(`  FAIL ${failure}`)
process.exit(failures.length > 0 ? 1 : 0)

