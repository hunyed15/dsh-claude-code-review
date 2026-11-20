/**
 * 并行视图：把 sessionQuery 的会话记录整理成"谁在干什么"的行。
 *
 * 纯函数、不碰盘、不碰服务——服务调用在 index.js，便于单测。
 *
 * 一个项目里可能有多个会话并行：
 *   - 主会话（cwd = 项目根）
 *   - 子代理会话（origin='subagent'，parentSession 指向父）
 *   - worktree 会话（cwd 指向另一个目录）
 * 只有把这三类放在一起看，才知道"是不是真的在并行"。
 */

const norm = (value) => String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

export function buildParallelView(records, options = {}) {
  const projectRoot = String(options.projectRoot ?? '')
  const rootNorm = norm(projectRoot)
  const titles = options.titles instanceof Map ? options.titles : new Map()
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 20

  const all = (Array.isArray(records) ? records : [])
    .map((record) => {
      const header = record?.header ?? {}
      const cwd = typeof header.cwd === 'string' ? header.cwd : ''
      return {
        id: String(header.id ?? ''),
        parentId: header.parentSession == null ? null : String(header.parentSession),
        cwd,
        createdAt: Number.isFinite(header.createdAt) ? header.createdAt : 0,
        live: record?.live === true,
        persisted: record?.persisted === true,
        origin: header.origin === 'subagent' ? 'subagent' : 'session',
        delegationDepth: Number.isInteger(header.delegationDepth) ? header.delegationDepth : 0,
        title: typeof titles.get(String(header.id ?? '')) === 'string' ? titles.get(String(header.id ?? '')) : '',
      }
    })
    .filter((item) => item.id !== '')

  const byId = new Map(all.map((item) => [item.id, item]))

  // 归属判断：cwd 在项目根下，或者它的祖先链能追到一个归属于本项目的会话
  // （worktree 会话的 cwd 不在根下，但父会话在）。
  const belongs = new Map()
  const resolveBelongs = (item, seen = new Set()) => {
    if (belongs.has(item.id)) return belongs.get(item.id)
    if (seen.has(item.id)) return false
    seen.add(item.id)
    const inRoot = rootNorm !== '' && norm(item.cwd) === rootNorm
    const underRoot = rootNorm !== '' && norm(item.cwd).startsWith(`${rootNorm}/`)
    let result = inRoot || underRoot
    if (!result && item.parentId) {
      const parent = byId.get(item.parentId)
      if (parent) result = resolveBelongs(parent, seen)
    }
    belongs.set(item.id, result)
    return result
  }

  const rows = all
    .filter((item) => resolveBelongs(item))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .map((item) => ({
      id: item.id,
      shortId: item.id.length > 12 ? `${item.id.slice(0, 8)}…` : item.id,
      title: item.title || '',
      cwd: item.cwd,
      origin: item.origin,
      parentId: item.parentId,
      delegationDepth: item.delegationDepth,
      createdAt: item.createdAt,
      live: item.live,
      persisted: item.persisted,
      // 目录与项目根不同 —— 可能是 worktree，也可能只是另一个目录。
      // 不做 git 判定（那要跑命令），界面按"其他目录"如实呈现。
      offRoot: rootNorm !== '' && norm(item.cwd) !== rootNorm,
    }))

  const truncated = rows.length > limit
  return {
    projectRoot,
    total: rows.length,
    liveCount: rows.filter((row) => row.live).length,
    rows: rows.slice(0, limit),
    truncated,
  }
}

/**
 * 撞车预警：两个"活着"的会话在同一个目录里。
 * 这只是最保守的一条（同 cwd 并行改同一份文件必然互相覆盖）；
 * 写作用域级别的判断要等任务板接入（P2）。
 */
export function detectCollisions(view) {
  const rows = Array.isArray(view?.rows) ? view.rows : []
  const byDir = new Map()
  for (const row of rows) {
    if (!row.live) continue
    const key = norm(row.cwd)
    if (key === '') continue
    const bucket = byDir.get(key) ?? []
    bucket.push(row)
    byDir.set(key, bucket)
  }
  const collisions = []
  for (const [dir, bucket] of byDir) {
    if (bucket.length < 2) continue
    collisions.push({ dir, ids: bucket.map((row) => row.id), count: bucket.length })
  }
  return collisions
}
