/**
 * Host-side projection for the 协同 panel.
 *
 * Read-only over the project's review ledger, except `appendDispositions()`,
 * which appends one JSON line per call (方案 A: 处置记录).
 *
 * The ledger lives in one of two stores:
 *   - Trellis: `<project>/.trellis/tasks/<task>/review/`
 *   - Local:   `<project>/.dsh/claude-review/ledger/` (one ledger per repo)
 *
 * The panel never recomputes review logic: it joins the artifacts the review
 * engine already wrote (`review-N.json`, `history.jsonl`) with the dispositions
 * the main session recorded, and derives:
 *   - disposition: explicit record > next-round inference (as before)
 *   - lifecycle:   new / still-there / fixed / reopened / unreviewed, by key
 *   - nextAction:  the single next thing to do for the active task
 */
import { appendFile, mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

const TASK_SKIP = new Set(['archive', '_adhoc', '_gatetest'])
const DISPOSITION_STATUSES = new Set(['fixed', 'counter-evidence', 'deferred'])
const STORAGE_MODES = new Set(['auto', 'trellis', 'local'])
export const LOCAL_LEDGER = join('.dsh', 'claude-review', 'ledger')

async function exists(path) {
  try {
    await stat(path)
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

/**
 * 只与「确实跑过模型并留下报告」的下一轮比较：
 *  - 下一轮 pass 且问题清空，正是“已修复”的最强证据，不能因为 issues 为空而被跳过；
 *  - nothing-to-review 没有 review-N.json（代码没变、没人复检），不能算作“已消失”。
 */
function nextReviewedRound(rounds, reportedRounds, round) {
  const next = rounds.find(
    (candidate) =>
      candidate.round > round && reportedRounds.has(candidate.round) && candidate.verdict !== 'nothing-to-review',
  )
  return next ? { round: next.round, mode: next.mode, issues: next.issues } : null
}

/**
 * 跨轮问题生命周期（纯函数，便于单测）。
 * keyless 但带 file/severity 的旧数据参与模糊聚类；file 为空的极端旧数据保持 unknown。
 * state: new | still-there | fixed | reopened | unreviewed | unknown
 */
export function deriveLifecycles(rounds, reportedRounds) {
  const clusters = []
  const clusterByIssue = new WeakMap()
  const ordered = [...rounds].sort((a, b) => a.round - b.round)

  // 先按 key 精确分组；key 对不上时，再按 file + severity + 文本相似度归并。
  // 审核员换一种措辞会把 key 换掉，但同一个缺陷不该因此变成「新问题」。
  for (const round of ordered) {
    for (const issue of round.issues) {
      if (!issue || typeof issue !== 'object') continue
      const file = String(issue.file ?? '').replace(/\\/g, '/').trim().toLowerCase()
      const severity = String(issue.severity ?? '').trim().toLowerCase()
      const key = String(issue.key ?? '').trim()
      // 没有 file 且没有 key 的极端旧数据保持 unknown；只有 key 的仍可按 key 精确跟踪。
      if (file === '' && key === '') {
        issue.lifecycle = { state: 'unknown', firstRound: null, lastRound: null, seen: 0, reopened: false }
        continue
      }
      const noFile = file === ''
      let cluster = key ? clusters.find((candidate) => candidate.keys.has(key)) : undefined
      if (!cluster && !noFile) {
        let best = null
        let bestScore = 0
        for (const candidate of clusters) {
          if (candidate.file !== file || candidate.severity !== severity) continue
          for (const item of candidate.items) {
            const score = textSimilarity(String(issue.issue ?? ''), String(item.issue?.issue ?? ''))
            if (score >= SIMILARITY_THRESHOLD && score > bestScore) {
              best = candidate
              bestScore = score
            }
          }
        }
        cluster = best
      }
      if (!cluster) {
        cluster = { file, severity, keys: new Set(), items: [], reopenedRounds: new Set() }
        clusters.push(cluster)
      }
      if (key) cluster.keys.add(key)
      cluster.items.push({ round: round.round, issue })
      clusterByIssue.set(issue, cluster)
    }
  }

  for (const cluster of clusters) {
    const clusterRounds = [...new Set(cluster.items.map((item) => item.round))].sort((a, b) => a - b)
    for (let index = 1; index < clusterRounds.length; index += 1) {
      const from = clusterRounds[index - 1]
      const to = clusterRounds[index]
      const hadGap = rounds.some(
        (candidate) =>
          candidate.round > from &&
          candidate.round < to &&
          reportedRounds.has(candidate.round) &&
          candidate.verdict !== 'nothing-to-review',
      )
      if (hadGap) cluster.reopenedRounds.add(to)
    }
  }

  for (const round of rounds) {
    const followUp = nextReviewedRound(rounds, reportedRounds, round.round)
    for (const issue of round.issues) {
      const cluster = clusterByIssue.get(issue)
      if (!cluster) {
        issue.lifecycle = { state: 'unknown', firstRound: null, lastRound: null, seen: 0, reopened: false }
        continue
      }
      const clusterRounds = [...new Set(cluster.items.map((item) => item.round))].sort((a, b) => a - b)
      const first = clusterRounds[0]
      const last = clusterRounds[clusterRounds.length - 1]
      const isReopened = cluster.reopenedRounds.has(round.round)
      const isLatestHistory = !rounds.some((candidate) => candidate.round > round.round)
      let state
      if (isReopened) state = 'reopened'
      else if (round.round === last && followUp) state = 'fixed'
      else if (round.round === first && (round.round < last || isLatestHistory)) state = 'new'
      else if (round.round < last) state = 'still-there'
      else if (clusterRounds.length > 1) state = 'still-there'
      else state = 'unreviewed'
      issue.lifecycle = { state, firstRound: first, lastRound: last, seen: clusterRounds.length, reopened: isReopened }
    }
  }
}

/** 只有重跑 full 能解决的门禁阻断（直接跑 gate 会再次 blocked）。 */
function gateNeedsFull(reason) {
  return /截断|自定义 -Base|快照降级/.test(String(reason || ''))
}

/**
 * issue 的终态（纯函数）：
 *   open → fixed（待复检）→ verified（下一轮确认消失）/ reopened（下一轮仍在）
 *   deferred / counter-evidence 是明确处置；没有处置且没有下一轮才是 open。
 * `disposition.status` 保留审核/推断来源；`followUp` 只表示下一轮是否再出现。
 */
export function deriveIssueStatus(issue) {
  const disposition = String(issue?.disposition?.status ?? '')
  const followUp = String(issue?.followUp ?? '')
  if (disposition === 'deferred') return 'deferred'
  if (disposition === 'counter-evidence') return 'counter-evidence'
  if (disposition === 'fixed') {
    if (followUp === 'still-there' || followUp === 'same-file') return 'reopened'
    if (followUp === 'gone') return 'verified'
    return 'fixed'
  }
  if (followUp === 'gone') return 'verified'
  if (followUp === 'still-there' || followUp === 'same-file') return 'reopened'
  if (disposition === 'still-there' || disposition === 'same-file') return 'reopened'
  if (disposition === 'gone') return 'verified'
  return 'open'
}

const DEFAULT_FAIL_ON = ['critical', 'important']

/**
 * round 的关闭状态（纯函数）。blocking 由 failOn 决定；minor 不阻断关闭。
 *   open → fixing → ready-for-verification → verified / closed-with-risk / reopened
 * `openBlocking` 只算 open+reopened，面板“待处置”不要拿发现总数冒充。
 */
export function deriveRoundStatus(round, failOn = DEFAULT_FAIL_ON) {
  const blockingSeverities = new Set(
    (Array.isArray(failOn) && failOn.length > 0 ? failOn : DEFAULT_FAIL_ON).map((severity) => String(severity).toLowerCase()),
  )
  const issues = Array.isArray(round?.issues) ? round.issues : []
  const counts = { open: 0, fixed: 0, verified: 0, reopened: 0, deferred: 0, counterEvidence: 0, minorOpen: 0 }
  let blocking = 0
  for (const issue of issues) {
    const status = String(issue?.status ?? deriveIssueStatus(issue))
    const isBlocking = blockingSeverities.has(String(issue?.severity ?? '').toLowerCase())
    if (!isBlocking) {
      if (status === 'open' || status === 'fixed' || status === 'reopened') counts.minorOpen += 1
      continue
    }
    blocking += 1
    if (status === 'fixed') counts.fixed += 1
    else if (status === 'verified') counts.verified += 1
    else if (status === 'reopened') counts.reopened += 1
    else if (status === 'deferred') counts.deferred += 1
    else if (status === 'counter-evidence') counts.counterEvidence += 1
    else counts.open += 1
  }
  const disposed = counts.fixed + counts.verified + counts.deferred + counts.counterEvidence
  let status
  if (counts.reopened > 0) status = 'reopened'
  else if (counts.open > 0 && disposed > 0) status = 'fixing'
  else if (counts.open > 0) status = 'open'
  else if (counts.fixed > 0) status = 'ready-for-verification'
  else if (counts.deferred + counts.counterEvidence > 0) status = 'closed-with-risk'
  else status = 'verified'
  return {
    status,
    blocking,
    open: counts.open,
    fixed: counts.fixed,
    verified: counts.verified,
    reopened: counts.reopened,
    deferred: counts.deferred,
    counterEvidence: counts.counterEvidence,
    minorOpen: counts.minorOpen,
    openBlocking: counts.open + counts.reopened,
  }
}

/** 下一件事：让看板告诉人该做什么，而不只是展示状态。 */
export function deriveNextAction(active) {
  const rounds = Array.isArray(active?.rounds) ? active.rounds : []
  if (rounds.length === 0) {
    return {
      key: 'review',
      tone: 'brand',
      label: '跑第一次审核',
      detail: '让主代理跑一次 claude_review，建立第一轮基线。',
    }
  }
  const latest = [...rounds].sort((a, b) => b.round - a.round)[0]
  const hasIssueList = Array.isArray(latest.issues)
  if (hasIssueList) {
    const state = latest.status ? { ...latest, status: latest.status, openBlocking: latest.openBlocking } : deriveRoundStatus(latest)
    const open = Number(state.openBlocking) || 0
    if (state.status === 'open' || state.status === 'fixing' || state.status === 'reopened') {
      return {
        key: 'fix',
        tone: 'bad',
        label: open > 0 ? `修复并处置 ${open} 条必修问题` : '按结论修复并处置',
        detail: '修完用 claude_review_disposition 标记 fixed/deferred/counter-evidence；未处置前不允许进入下一轮。',
      }
    }
    if (state.status === 'ready-for-verification') {
      return {
        key: 'review',
        tone: 'warn',
        label: '复检本轮修复',
        detail: '用 claude_review 重跑同一模式；已处置的 findings 允许进入复检，复检仍存在会标为复现。',
      }
    }
    if (state.status === 'verified' && (latest.verdict === 'fix' || latest.verdict === 'reject')) {
      return {
        key: 'gate',
        tone: 'bad',
        label: '处理门禁阻断',
        detail: active?.gate?.reason || '本轮 blocking 已全部验证；最近一次结论是 fix，先跑 gate 或重跑 full 取得 pass。',
      }
    }
    if (state.status === 'closed-with-risk') {
      return {
        key: 'gate',
        tone: 'bad',
        label: '处理门禁阻断',
        detail: 'blocking findings 已暂缓/反证；最终仍需 full pass，或接受 gate 阻断。',
      }
    }
  }
  if (latest.verdict === 'nothing-to-review') {
    const previous = [...rounds]
      .sort((a, b) => b.round - a.round)
      .find((candidate) => candidate.round < latest.round && candidate.status === 'ready-for-verification')
    if (previous) {
      return {
        key: 'range',
        tone: 'warn',
        label: '用 range 复检上次修复',
        detail: '工作区已干净；用 -Mode range 覆盖上次修复的提交区间，确认 findings 已消失。',
      }
    }
  }
  const mustFix = (latest.counts?.critical || 0) + (latest.counts?.important || 0)
  if (latest.verdict === 'fix' || latest.verdict === 'reject') {
    return {
      key: 'fix',
      tone: 'bad',
      label: mustFix > 0 ? `修 ${mustFix} 条必修问题` : '按结论修复',
      detail: '修完重跑同一模式；不要直接跑 gate。',
    }
  }
  if (latest.verdict === 'pass' || latest.verdict === 'gate-pass') {
    if (latest.mode !== 'full') {
      return { key: 'full', tone: 'warn', label: '跑一次 full 收尾', detail: '收尾门禁要求最近一次是 full。' }
    }
    if (active?.gate?.state === 'blocked') {
      const reason = String(active.gate.reason || '')
      // 截断/自定义 Base/快照降级只有重跑 full 能解决；直接跑 gate 会再次 blocked。
      if (gateNeedsFull(reason)) {
        return {
          key: 'full',
          tone: 'warn',
          label: '重跑 full（处理截断/Base/快照降级）',
          detail: reason || '先重跑 full，再复核门禁。',
        }
      }
      return {
        key: 'gate',
        tone: 'bad',
        label: '处理门禁阻断',
        detail: reason || '先处理阻断，再跑 gate。',
      }
    }
    return { key: 'gate', tone: 'ok', label: '跑 gate 复核', detail: '提交前复核快照是否仍与审核时一致。' }
  }
  if (latest.verdict === 'nothing-to-review') {
    if (latest.mode === 'full') {
      if (active?.gate?.state === 'blocked') {
        const reason = String(active.gate.reason || '')
        if (gateNeedsFull(reason)) {
          return {
            key: 'full',
            tone: 'warn',
            label: '重跑 full（处理截断/Base/快照降级）',
            detail: reason || '先重跑 full，再复核门禁。',
          }
        }
        return {
          key: 'gate',
          tone: 'bad',
          label: '处理门禁阻断',
          detail: reason || '先处理阻断，再跑 gate。',
        }
      }
      if (active?.gate?.state === 'pass') {
        return { key: 'gate', tone: 'ok', label: '跑 gate 复核', detail: '审核后工作区没有变化，直接复核门禁。' }
      }
      return { key: 'gate', tone: 'ok', label: '跑 gate 复核', detail: '复核门禁后提交。' }
    }
    return { key: 'full', tone: 'warn', label: '跑一次 full 收尾', detail: '收尾门禁要求最近一次是 full。' }
  }
  return {
    key: 'review',
    tone: 'warn',
    label: '检查最近一轮结论',
    detail: `最近一轮结论是 ${latest.verdict || '未知'}。`,
  }
}

function deriveGate(history) {
  const last = history.length > 0 ? history[history.length - 1] : null
  if (!last) return { state: 'unknown', reason: '还没有审核记录', source: 'panel' }
  const suffix = '（面板口径，提交前请跑 claude_review gate 复核快照是否仍一致）'
  if (last.degraded) return { state: 'blocked', reason: `最近一次审核在快照降级下运行${suffix}`, source: 'panel' }
  if (last.truncated) {
    return { state: 'blocked', reason: `最近一次审核的 diff 被截断，结论不完整；调大 maxDiffChars 或分片后重跑 full${suffix}`, source: 'panel' }
  }
  if (last.baseCustom) {
    return { state: 'blocked', reason: `最近一次 full 使用了自定义 -Base，不是收尾门禁的普通 full${suffix}`, source: 'panel' }
  }
  if (last.mode !== 'full') {
    return { state: 'blocked', reason: `最近一次是 ${last.mode}，收尾门禁要求 full${suffix}`, source: 'panel' }
  }
  if (last.verdict === 'pass' || last.verdict === 'nothing-to-review') {
    return { state: 'pass', reason: `第 ${last.round} 轮 full 通过${suffix}`, source: 'panel' }
  }
  return { state: 'blocked', reason: `最近一次 full 结论是 ${last.verdict}${suffix}`, source: 'panel' }
}

async function readRunState(reviewDir) {
  const run = await readJsonOr(join(reviewDir, 'run.json'), null)
  if (!run || typeof run !== 'object') return null
  const status = String(run.status ?? '')
  if (status === 'done') return null
  const updated = Date.parse(String(run.updatedAt ?? ''))
  const started = Date.parse(String(run.startedAt ?? ''))
  const ageSec = Number.isFinite(updated) ? Math.max(0, Math.round((Date.now() - updated) / 1000)) : null
  const elapsedSec = Number.isFinite(started) ? Math.max(0, Math.round((Date.now() - started) / 1000)) : ageSec
  return {
    status,
    phase: String(run.phase ?? ''),
    startedAt: String(run.startedAt ?? ''),
    updatedAt: String(run.updatedAt ?? ''),
    elapsedSec,
    stale: status === 'running' && ageSec !== null && ageSec > 120,
    error: String(run.error ?? ''),
    verdict: String(run.verdict ?? ''),
  }
}

async function listTaskDirs(projectRoot, storage = 'trellis') {
  if (storage === 'local') {
    const dir = join(projectRoot, LOCAL_LEDGER)
    return (await isDirectory(dir)) ? [{ name: 'local', dir }] : []
  }
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

function taskNameFromRoot(root) {
  return String(root ?? '')
    .split(/[\\/]/)
    .filter(Boolean)
    .pop() || String(root ?? '')
}

function syntheticLocalTask(root) {
  const title = taskNameFromRoot(root)
  const task = {
    dir: join(root, LOCAL_LEDGER),
    id: 'local',
    name: 'local',
    title,
    status: 'in_progress',
    priority: '',
    branch: '',
  }
  const base = {
    task,
    storage: 'local',
    artifacts: { prd: false, design: false, implement: false },
    manifests: { check: 0, implement: 0 },
    gate: { state: 'unknown', reason: '还没有审核记录', source: 'panel' },
    rounds: [],
    lastRound: null,
    totalCostUsd: 0,
    pending: 0,
    lastVerdict: '',
    nextAction: null,
    run: null,
  }
  base.nextAction = deriveNextAction(base)
  return base
}

async function readTaskDetail(taskDir, storage = 'trellis', entryName = '') {
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
    const report = await readJsonOr(join(reviewDir, `review-${round}.json`), null)
    if (report !== null) reportedRounds.add(round)
    const rowCost = typeof row.cost_usd === 'number' ? row.cost_usd : null
    const metaCost = typeof report?.meta?.cost_usd === 'number' ? report.meta.cost_usd : null
    const rowVerdict = String(row.verdict ?? report?.review?.verdict ?? '')
    // nothing-to-review 没有调用模型，成本是确定的 0，而不是未知。
    const nothingToReview = rowVerdict === 'nothing-to-review'
    const costKnown = nothingToReview || rowCost !== null || metaCost !== null
    const costUsd = nothingToReview ? 0 : (costKnown ? (rowCost ?? metaCost) : 0)
    rounds.push({
      round,
      mode: String(row.mode ?? report?.meta?.mode ?? ''),
      transport: String(row.transport ?? report?.meta?.transport ?? ''),
      transportWarning: String(row.transportWarning ?? report?.meta?.transportWarning ?? ''),
      verdict: rowVerdict,
      at: String(row.at ?? report?.meta?.reviewed_at ?? ''),
      costUsd,
      costKnown,
      sessionId: String(report?.meta?.session?.id ?? row.sessionId ?? ''),
      reportPath: String(row.report ?? ''),
      files: Number(row.files ?? report?.meta?.files ?? 0),
      truncated: Boolean(row.truncated ?? report?.meta?.truncated),
      failOn: Array.isArray(report?.meta?.failOn) && report.meta.failOn.length > 0 ? report.meta.failOn.map(String) : null,
      counts: {
        critical: Number(row.critical ?? 0),
        important: Number(row.important ?? 0),
        minor: Number(row.minor ?? 0),
      },
      summary: String(report?.review?.summary ?? ''),
      assessment: String(report?.review?.assessment ?? ''),
      strengths: Array.isArray(report?.review?.strengths)
        ? report.review.strengths
            .map((item) => ({ point: String(item?.point ?? ''), evidence: String(item?.evidence ?? '') }))
            .filter((item) => item.point !== '')
        : [],
      recommendations: Array.isArray(report?.review?.recommendations)
        ? report.review.recommendations.map(String).filter(Boolean)
        : [],
      issues: Array.isArray(report?.review?.issues)
        ? report.review.issues.flatMap((issue, index) =>
            issue == null || typeof issue !== 'object'
              ? []
              : [
                  {
                    index,
                    key: String(issue?.key ?? ''),
                    severity: String(issue?.severity ?? ''),
                    file: String(issue?.file ?? ''),
                    line: String(issue?.line ?? ''),
                    issue: String(issue?.issue ?? ''),
                    why: String(issue?.why ?? ''),
                    fix: String(issue?.fix ?? ''),
                  },
                ],
          )
        : [],
    })
  }

  rounds.sort((a, b) => a.round - b.round)

  // 逐条问题的处置：显式记录优先，其次按下一轮复检推断
  for (const round of rounds) {
    const explicitByKey = new Map()
    for (const [mapKey, row] of dispositions) {
      const [rowRound] = mapKey.split('|')
      if (Number(rowRound) !== round.round) continue
      explicitByKey.set(mapKey.split('|')[1], row)
    }
    const followUp = nextReviewedRound(rounds, reportedRounds, round.round)
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
      return { ...issue, followUp: match?.state ?? '', disposition: { status, source, note } }
    })
  }

  deriveLifecycles(rounds, reportedRounds)

  for (const round of rounds) {
    for (const issue of round.issues) issue.status = deriveIssueStatus(issue)
    const roundState = deriveRoundStatus(round, round.failOn ?? DEFAULT_FAIL_ON)
    round.status = roundState.status
    round.openBlocking = roundState.openBlocking
    round.fixedBlocking = roundState.fixed
    round.verifiedBlocking = roundState.verified
    round.deferredBlocking = roundState.deferred + roundState.counterEvidence
    round.reopenedBlocking = roundState.reopened
    round.minorOpen = roundState.minorOpen
  }

  const gate = deriveGate(history)
  const latest = rounds.length > 0 ? rounds[rounds.length - 1] : null
  const totalCostUsd = rounds.reduce((sum, round) => sum + (Number(round.costUsd) || 0), 0)
  const totalCostKnown = rounds.every((round) => round.costKnown !== false)
  const pending = latest ? Number(latest.openBlocking) || 0 : 0
  const detail = {
    task: {
      dir: taskDir,
      id: String(task.id ?? ''),
      name: String(task.name ?? entryName ?? ''),
      title: String(task.title ?? ''),
      status: String(task.status ?? ''),
      priority: String(task.priority ?? ''),
      branch: String(task.branch ?? ''),
    },
    storage,
    artifacts,
    manifests: { check: checkRows.length, implement: implementRows.length },
    gate,
    rounds,
    lastRound: latest ? latest.round : null,
    lastVerdict: latest ? latest.verdict : '',
    pending,
    totalCostUsd,
    totalCostKnown,
    nextAction: null,
    run: await readRunState(reviewDir),
  }
  detail.nextAction = deriveNextAction(detail)
  return detail
}

function summaryOf(detail, mtimeMs = 0) {
  const latest = detail.rounds.length > 0 ? detail.rounds[detail.rounds.length - 1] : null
  return {
    name: detail.task.name,
    title: detail.task.title || detail.task.name,
    status: detail.task.status,
    priority: detail.task.priority,
    lastRound: detail.lastRound,
    rounds: detail.rounds.length,
    roundStatus: latest ? latest.status : '',
    gate: detail.gate,
    pending: detail.pending,
    lastVerdict: detail.lastVerdict,
    totalCostUsd: detail.totalCostUsd,
    totalCostKnown: detail.totalCostKnown,
    storage: detail.storage,
    mtime: mtimeMs,
  }
}

function selectActive(details) {
  let active = null
  for (const detail of details) {
    if (detail.rounds.length === 0 && detail.task.status !== 'in_progress') continue
    if (active === null) {
      active = detail
      continue
    }
    const hasRounds = (candidate) => candidate.rounds.length > 0
    if (hasRounds(detail) && !hasRounds(active)) {
      active = detail
      continue
    }
    if ((detail.lastRound ?? -1) > (active.lastRound ?? -1)) active = detail
  }
  return active
}

/**
 * 读取一个项目（工作区）的协同面板数据。
 * storage=auto 时 Trellis 优先；没有 .trellis 就用本地账本（即使账本还不存在，
 * 也返回一个空的本地任务，让面板可以展示“跑第一次审核”的空状态）。
 */
export async function loadPanel(projectRoot, options = {}) {
  const root = String(projectRoot ?? '').trim()
  if (root === '') return { ok: false, error: 'cwd 为空' }
  if (!(await isDirectory(root))) return { ok: false, error: 'cwd-not-found' }
  const configured = STORAGE_MODES.has(String(options.storage ?? '')) ? String(options.storage) : 'auto'
  const storage = configured === 'auto' ? ((await exists(join(root, '.trellis'))) ? 'trellis' : 'local') : configured
  if (storage === 'trellis' && !(await exists(join(root, '.trellis')))) {
    return { ok: false, error: 'trellis-not-initialized' }
  }

  const entries = await listTaskDirs(root, storage)
  const details = []
  const mtimes = new Map()
  for (const entry of entries) {
    details.push(await readTaskDetail(entry.dir, storage, entry.name))
    mtimes.set(entry.dir, (await stat(entry.dir).catch(() => ({ mtimeMs: 0 }))).mtimeMs)
  }

  if (storage === 'local' && details.length === 0) {
    const synthetic = syntheticLocalTask(root)
    details.push(synthetic)
  }

  const tasks = details.map((detail) => summaryOf(detail, mtimes.get(detail.task.dir) ?? 0))
  const requested = typeof options.task === 'string' ? options.task.trim() : ''
  let active = requested !== '' ? details.find((detail) => detail.task.name === requested) : null
  if (!active) active = selectActive(details)

  return {
    ok: true,
    storage,
    project: {
      root,
      name: taskNameFromRoot(root),
      generatedAt: new Date().toISOString(),
    },
    active: active || null,
    tasks: tasks.sort((a, b) => (b.lastRound ?? -1) - (a.lastRound ?? -1)),
  }
}

/**
 * 解析要写入处置记录的任务目录：显式指定优先；本地模式取 `.dsh/claude-review/ledger`；
 * Trellis 下没有显式 taskDir 直接报错，不会按 history/in_progress 猜任务。
 */
export async function resolveTaskDir(projectRoot, explicit, options = {}) {
  const root = String(projectRoot ?? '').trim()
  if (root === '') throw new Error('cwd 为空')
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    const dir = isAbsolute(explicit) ? explicit : join(root, explicit)
    if ((await exists(join(dir, 'task.json'))) || (await exists(join(dir, 'review')))) return dir
    throw new Error(`任务目录不存在或不是审核任务：${dir}`)
  }

  const configured = STORAGE_MODES.has(String(options.storage ?? '')) ? String(options.storage) : 'auto'
  const storage = configured === 'auto' ? ((await exists(join(root, '.trellis'))) ? 'trellis' : 'local') : configured
  if (storage === 'local') {
    const dir = join(root, LOCAL_LEDGER)
    if ((await exists(join(dir, 'task.json'))) || (await exists(join(dir, 'review')))) return dir
    throw new Error('还没有本地审核账本；先跑一次 claude_review 再记录处置。')
  }

  // 写入类操作不允许猜任务：猜错会把处置记录写进别的任务，和误审一样糟。
  // 面板不持有 DSH 会话身份，所以 Trellis 下必须显式传 taskDir（或由调用方解析后传入）。
  throw new Error(
    '无法确定 Trellis 任务：请显式传 taskDir（例如 .trellis/tasks/<task>），或改用 storage=local；' +
      '不会按 review/history 或 in_progress 状态猜任务。',
  )
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
