/**
 * Host-side projection for the 协同 panel.
 *
 * Everything here is read-only over the project's `.trellis/` tree, except
 * `appendDispositions()`, which appends one JSON line per call (方案 A: 处置记录).
 *
 * The panel never recomputes review logic: it joins the artifacts the review
 * engine already wrote (`review-N.json`, `history.jsonl`) with the dispositions
 * the main session recorded, and derives a per-finding status in three layers:
 *   1. explicit disposition (recorded)
 *   2. next reviewed round no longer reports it → "视为已修（推断）"
 *      （下一轮必须有 review-N.json 且不是 nothing-to-review；干净 pass 也算复检）
 *   3. next reviewed round still reports it      → "复检仍存在"
 *   4. no next reviewed round                    → "未复检"
 */
import { appendFile, mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

const TASK_SKIP = new Set(['archive', '_adhoc', '_gatetest'])
const DISPOSITION_STATUSES = new Set(['fixed', 'counter-evidence', 'deferred'])

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function readTextOr(path, fallback = '') {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return fallback
  }
}

async function readJsonOr(path, fallback = null) {
  const text = await readTextOr(path, '')
  if (text.trim() === '') return fallback
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

function readJsonl(text) {
  const rows = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      rows.push(JSON.parse(trimmed))
    } catch {
      // 损坏行不影响其它行：面板展示的是历史，不该因为一行坏掉而全空
    }
  }
  return rows
}

function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s]+/g, ' ')
    .replace(/[，。；：、,.;:!?！？"'`()[\]{}<>《》]/g, '')
    .trim()
}

function tokens(value) {
  const norm = normalizeText(value)
  if (norm === '') return new Set()
  return new Set(norm.split(' ').filter((token) => token.length > 0))
}

// 中文没有空格，按「词」切分算 Jaccard 会把同一句话判成不相似。
// 这里用字符二元组 Dice 系数：对中英混排都稳，且不需要分词器。
function bigrams(value) {
  const norm = normalizeText(value).replace(/\s+/g, '')
  const set = new Set()
  for (let i = 0; i + 1 < norm.length; i += 1) set.add(norm.slice(i, i + 2))
  return set
}

export const SIMILARITY_THRESHOLD = 0.4

export function textSimilarity(a, b) {
  const left = bigrams(a)
  const right = bigrams(b)
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const gram of left) if (right.has(gram)) shared += 1
  return (2 * shared) / (left.size + right.size)
}

/**
 * 给上一轮的每条问题找下一轮的对应条目。
 * 纯函数，便于自测：返回 Map<index, {state, round, index}>。
 * state: 'gone' | 'still-there' | 'same-file'
 */
export function matchFollowUp(prevIssues, nextIssues) {
  const result = new Map()
  const all = Array.isArray(prevIssues) ? prevIssues : []
  const candidates = Array.isArray(nextIssues) ? nextIssues : []
  all.forEach((issue, index) => {
    const byKey = issue?.key ? candidates.find((candidate) => candidate?.key && candidate.key === issue.key) : undefined
    if (byKey) {
      result.set(index, { state: 'still-there', matched: byKey })
      return
    }
    const sameFile = candidates.filter(
      (candidate) => candidate?.file === issue?.file && candidate?.severity === issue?.severity,
    )
    const similar = sameFile.find((candidate) => textSimilarity(issue?.issue, candidate?.issue) >= SIMILARITY_THRESHOLD)
    if (similar) {
      result.set(index, { state: 'still-there', matched: similar })
      return
    }
    if (sameFile.length > 0) {
      result.set(index, { state: 'same-file', matched: sameFile[0] })
      return
    }
    result.set(index, { state: 'gone' })
  })
  return result
}

async function listTaskDirs(projectRoot) {
  const tasksRoot = join(projectRoot, '.trellis', 'tasks')
  let names = []
  try {
    names = await readdir(tasksRoot)
  } catch {
    return []
  }
  const dirs = []
  for (const name of names) {
    if (TASK_SKIP.has(name)) continue
    const dir = join(tasksRoot, name)
    const info = await stat(dir).catch(() => null)
    if (!info?.isDirectory()) continue
    dirs.push({ name, dir })
  }
  return dirs
}

function deriveGate(history) {
  const last = history.length > 0 ? history[history.length - 1] : null
  if (!last) return { state: 'unknown', reason: '还没有审核记录', source: 'panel' }
  const suffix = '（面板口径，提交前请跑 claude_review gate 复核快照是否仍一致）'
  if (last.degraded) return { state: 'blocked', reason: `最近一次审核在快照降级下运行${suffix}`, source: 'panel' }
  if (last.mode !== 'full') {
    return { state: 'blocked', reason: `最近一次是 ${last.mode}，收尾门禁要求 full${suffix}`, source: 'panel' }
  }
  if (last.verdict === 'pass' || last.verdict === 'nothing-to-review') {
    return { state: 'pass', reason: `第 ${last.round} 轮 full 通过${suffix}`, source: 'panel' }
  }
  return { state: 'blocked', reason: `最近一次 full 结论是 ${last.verdict}${suffix}`, source: 'panel' }
}

async function readTaskDetail(taskDir) {
  const task = await readJsonOr(join(taskDir, 'task.json'), {})
  const artifacts = {
    prd: await exists(join(taskDir, 'prd.md')),
    design: await exists(join(taskDir, 'design.md')),
    implement: await exists(join(taskDir, 'implement.md')),
  }
  const checkRows = readJsonl(await readTextOr(join(taskDir, 'check.jsonl')))
  const implementRows = readJsonl(await readTextOr(join(taskDir, 'implement.jsonl')))
  const reviewDir = join(taskDir, 'review')
  const history = readJsonl(await readTextOr(join(reviewDir, 'history.jsonl')))
  const dispositionRows = readJsonl(await readTextOr(join(reviewDir, 'dispositions.jsonl')))

  const dispositions = new Map()
  for (const row of dispositionRows) {
    if (!DISPOSITION_STATUSES.has(String(row?.status))) continue
    const round = Number(row?.round)
    const key = row?.key ? String(row.key) : ''
    const index = Number(row?.index)
    if (key !== '') dispositions.set(`${round}|key:${key}`, row)
    else if (Number.isFinite(index)) dispositions.set(`${round}|index:${index}`, row)
  }

  // 轮次：history 决定顺序；review-N.json 提供问题清单
  const rounds = []
  // 只有真正跑过模型并落盘的轮次才有 review-N.json；nothing-to-review 不写报告。
  const reportedRounds = new Set()
  for (const row of history) {
    if (!row || typeof row !== 'object') continue
    const round = Number(row.round)
    if (!Number.isFinite(round)) continue
    const reportFile = join(reviewDir, `review-${round}.json`)
    const report = await readJsonOr(reportFile, null)
    if (report !== null) reportedRounds.add(round)
    rounds.push({
      round,
      mode: String(row.mode ?? report?.meta?.mode ?? ''),
      verdict: String(row.verdict ?? report?.review?.verdict ?? ''),
      at: String(row.at ?? report?.meta?.reviewed_at ?? ''),
      costUsd: typeof row.cost_usd === 'number' ? row.cost_usd : Number(report?.meta?.cost_usd ?? 0),
      sessionId: String(report?.meta?.session?.id ?? row.sessionId ?? ''),
      reportPath: String(row.report ?? ''),
      files: Number(row.files ?? report?.meta?.files ?? 0),
      counts: {
        critical: Number(row.critical ?? 0),
        important: Number(row.important ?? 0),
        minor: Number(row.minor ?? 0),
      },
      summary: String(report?.review?.summary ?? ''),
      issues: Array.isArray(report?.review?.issues)
        ? report.review.issues.map((issue, index) => ({
            index,
            key: String(issue?.key ?? ''),
            severity: String(issue?.severity ?? ''),
            file: String(issue?.file ?? ''),
            line: String(issue?.line ?? ''),
            issue: String(issue?.issue ?? ''),
            why: String(issue?.why ?? ''),
            fix: String(issue?.fix ?? ''),
          }))
        : [],
    })
  }

  rounds.sort((a, b) => a.round - b.round)

  // 只与「确实跑过模型并留下报告」的下一轮比较：
  //  - 下一轮 pass 且问题清空，正是“已修复”的最强证据，不能因为 issues 为空而被跳过；
  //  - nothing-to-review 没有 review-N.json（代码没变、没人复检），不能算作“已消失”。
  const nextReviewedRound = (round) => {
    const next = rounds.find(
      (candidate) =>
        candidate.round > round && reportedRounds.has(candidate.round) && candidate.verdict !== 'nothing-to-review',
    )
    return next ? { round: next.round, mode: next.mode, issues: next.issues } : null
  }
  for (const round of rounds) {
    const explicitByKey = new Map()
    for (const [mapKey, row] of dispositions) {
      const [rowRound] = mapKey.split('|')
      if (Number(rowRound) !== round.round) continue
      explicitByKey.set(mapKey.split('|')[1], row)
    }
    const followUp = nextReviewedRound(round.round)
    const followUpLabel = followUp ? `第 ${followUp.round} 轮${followUp.mode ? `（${followUp.mode}）` : ''}` : ''
    const matches = followUp ? matchFollowUp(round.issues, followUp.issues) : new Map()
    round.issues = round.issues.map((issue) => {
      const explicit = explicitByKey.get(`key:${issue.key}`) ?? explicitByKey.get(`index:${issue.index}`)
      const match = matches.get(issue.index)
      let status = 'unreviewed'
      let source = 'none'
      let note = ''
      if (explicit) {
        status = String(explicit.status)
        source = 'recorded'
        note = String(explicit.note ?? '')
      } else if (match?.state === 'still-there') {
        status = 'still-there'
        source = 'inferred'
        note = `${followUpLabel}复检仍报告同类问题`
      } else if (match?.state === 'same-file') {
        status = 'same-file'
        source = 'inferred'
        note = `${followUpLabel}同文件仍报问题，但文本已变化（可能不是同一条）`
      } else if (match?.state === 'gone') {
        status = 'gone'
        source = 'inferred'
        note = `${followUpLabel}未再出现`
      } else {
        status = 'unreviewed'
        note = '后续没有可对照的轮次'
      }
      return { ...issue, disposition: { status, source, note } }
    })
  }

  return {
    task: {
      dir: taskDir,
      id: String(task.id ?? ''),
      title: String(task.title ?? ''),
      status: String(task.status ?? ''),
      priority: String(task.priority ?? ''),
      branch: String(task.branch ?? ''),
    },
    artifacts,
    manifests: { check: checkRows.length, implement: implementRows.length },
    gate: deriveGate(history),
    rounds,
    lastRound: rounds.length > 0 ? rounds[rounds.length - 1].round : null,
  }
}

async function latestJournalLine() {
  // journal 属于开发者身份目录，路径不稳定；这里只做 best-effort 读取
  return ''
}

/**
 * 读取一个项目（工作区）的协同面板数据。缺 `.trellis/` 时返回 null。
 */
export async function loadPanel(projectRoot) {
  const root = String(projectRoot ?? '').trim()
  if (root === '') return { ok: false, error: 'cwd 为空' }
  const trellisDir = join(root, '.trellis')
  if (!(await exists(trellisDir))) return null

  const tasks = []
  for (const entry of await listTaskDirs(root)) {
    const detail = await readTaskDetail(entry.dir)
    tasks.push({
      name: entry.name,
      title: detail.task.title,
      status: detail.task.status,
      priority: detail.task.priority,
      lastRound: detail.lastRound,
      rounds: detail.rounds.length,
      gate: detail.gate,
      mtime: (await stat(entry.dir).catch(() => ({ mtimeMs: 0 }))).mtimeMs,
    })
  }

  // 当前任务：有审核轮次的优先，其次按目录 mtime
  let active = null
  for (const entry of await listTaskDirs(root)) {
    const detail = await readTaskDetail(entry.dir)
    if (detail.rounds.length === 0 && detail.task.status !== 'in_progress') continue
    if (active === null) {
      active = detail
      continue
    }
    const pickExisting = (candidate) => candidate.rounds.length > 0
    if (pickExisting(detail) && !pickExisting(active)) {
      active = detail
      continue
    }
    const detailLast = detail.lastRound ?? -1
    const activeLast = active.lastRound ?? -1
    if (detailLast > activeLast) active = detail
  }

  const journalLine = await latestJournalLine()

  return {
    ok: true,
    project: { root, name: root.split(/[\\/]/).filter(Boolean).pop() ?? root, generatedAt: new Date().toISOString() },
    active,
    tasks: tasks.sort((a, b) => (b.lastRound ?? -1) - (a.lastRound ?? -1)),
    journalLine,
  }
}

/**
 * 解析要写入处置记录的任务目录：显式指定优先，否则取「最新有审核记录」的任务，
 * 再退化为最新 in_progress 任务。
 */
export async function resolveTaskDir(projectRoot, explicit) {
  const root = String(projectRoot ?? '').trim()
  if (root === '') throw new Error('cwd 为空')
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    const dir = isAbsolute(explicit) ? explicit : join(root, explicit)
    if ((await exists(join(dir, 'task.json'))) || (await exists(join(dir, 'review')))) return dir
    throw new Error(`任务目录不存在或不是 Trellis 任务：${dir}`)
  }
  let best = null
  for (const entry of await listTaskDirs(root)) {
    const info = await stat(join(entry.dir, 'review', 'history.jsonl')).catch(() => null)
    if (!info) continue
    if (!best || info.mtimeMs > best.mtimeMs) best = { dir: entry.dir, mtimeMs: info.mtimeMs }
  }
  if (best) return best.dir
  for (const entry of await listTaskDirs(root)) {
    const task = await readJsonOr(join(entry.dir, 'task.json'), {})
    if (String(task.status) === 'in_progress') return entry.dir
  }
  // 退化为「已经有 review/ 目录」的最新任务（半初始化或测试 fixture）
  for (const entry of await listTaskDirs(root)) {
    const info = await stat(join(entry.dir, 'review')).catch(() => null)
    if (!info?.isDirectory()) continue
    if (!best || info.mtimeMs > best.mtimeMs) best = { dir: entry.dir, mtimeMs: info.mtimeMs }
  }
  if (best) return best.dir
  throw new Error('找不到活动的 Trellis 任务（没有 review/history.jsonl，也没有 in_progress 任务）')
}

/**
 * 追加处置记录（方案 A）。返回写入后的条数。
 */
export async function appendDispositions(taskDir, entries, sessionId) {
  const reviewDir = join(taskDir, 'review')
  await mkdir(reviewDir, { recursive: true })
  const rows = Array.isArray(entries) ? entries : [entries]
  const lines = []
  for (const entry of rows) {
    const status = String(entry?.status ?? '')
    if (!DISPOSITION_STATUSES.has(status)) {
      throw new Error(`status 必须是 fixed / counter-evidence / deferred，收到：${status || '(空)'}`)
    }
    const round = Number(entry?.round)
    if (!Number.isFinite(round)) throw new Error('round 必须是数字')
    const record = {
      at: new Date().toISOString(),
      round,
      key: entry?.key ? String(entry.key) : '',
      index: Number.isFinite(Number(entry?.index)) ? Number(entry.index) : null,
      status,
      note: String(entry?.note ?? ''),
      evidence: Array.isArray(entry?.evidence) ? entry.evidence.map(String) : [],
      sessionId: String(sessionId ?? ''),
    }
    if (record.key === '' && record.index === null) throw new Error('key 与 index 至少要给一个')
    lines.push(JSON.stringify(record))
  }
  if (lines.length === 0) return 0
  await appendFile(join(reviewDir, 'dispositions.jsonl'), `${lines.join('\n')}\n`, 'utf8')
  return lines.length
}
