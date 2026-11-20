import test from 'node:test'
import assert from 'node:assert/strict'
import { buildParallelView, detectCollisions } from '../lib/cockpit/sessions.js'

const ROOT = 'D:/Coding/proj'

const rec = (id, overrides = {}) => ({
  header: {
    version: 1,
    id,
    createdAt: 1000,
    cwd: ROOT,
    isSeeded: false,
    ...overrides,
  },
  live: true,
  persisted: true,
})

test('只收录归属于本项目的会话', () => {
  const view = buildParallelView(
    [rec('a'), rec('b', { cwd: 'D:/Coding/other' })],
    { projectRoot: ROOT },
  )
  assert.deepEqual(view.rows.map((r) => r.id), ['a'])
  assert.equal(view.total, 1)
})

test('项目根的子目录也算本项目', () => {
  const view = buildParallelView([rec('a', { cwd: 'D:/Coding/proj/sub' })], { projectRoot: ROOT })
  assert.equal(view.total, 1)
})

test('worktree 会话（cwd 在根之外但父会话在根）被收录并标 offRoot', () => {
  const view = buildParallelView(
    [
      rec('lead', { createdAt: 1000 }),
      rec('backend', { createdAt: 2000, cwd: 'D:/Coding/proj-backend', parentSession: 'lead' }),
    ],
    { projectRoot: ROOT },
  )
  const backend = view.rows.find((r) => r.id === 'backend')
  assert.ok(backend, 'worktree 会话必须收录')
  assert.equal(backend.offRoot, true)
  assert.equal(backend.parentId, 'lead')
})

test('按创建时间排序，标题来自标题映射', () => {
  const titles = new Map([['b', '订单接口'], ['a', '主线']])
  const view = buildParallelView(
    [rec('b', { createdAt: 2000 }), rec('a', { createdAt: 1000 })],
    { projectRoot: ROOT, titles },
  )
  assert.deepEqual(view.rows.map((r) => r.id), ['a', 'b'])
  assert.deepEqual(view.rows.map((r) => r.title), ['主线', '订单接口'])
})

test('live 计数只算活着的会话', () => {
  const view = buildParallelView(
    [rec('a', { createdAt: 1 }), { ...rec('b', { createdAt: 2 }), live: false }],
    { projectRoot: ROOT },
  )
  assert.equal(view.liveCount, 1)
  assert.equal(view.total, 2)
})

test('超过上限时截断并标记', () => {
  const records = Array.from({ length: 25 }, (_, index) => rec(`s${index}`, { createdAt: index + 1 }))
  const view = buildParallelView(records, { projectRoot: ROOT, limit: 20 })
  assert.equal(view.rows.length, 20)
  assert.equal(view.total, 25)
  assert.equal(view.truncated, true)
})

test('缺 cwd 的会话不会误判为本项目', () => {
  const view = buildParallelView([rec('a', { cwd: undefined })], { projectRoot: ROOT })
  assert.equal(view.total, 0)
})

test('撞车预警：两个活会话在同一目录', () => {
  const view = buildParallelView(
    [
      rec('a', { createdAt: 1 }),
      rec('b', { createdAt: 2 }),
      { ...rec('c', { createdAt: 3 }), live: false },
    ],
    { projectRoot: ROOT },
  )
  const collisions = detectCollisions(view)
  assert.equal(collisions.length, 1)
  assert.deepEqual(collisions[0].ids.sort(), ['a', 'b'])
  assert.equal(collisions[0].count, 2)
})

test('不同目录不报撞车', () => {
  const view = buildParallelView(
    [rec('a', { cwd: 'D:/Coding/proj-a' }), rec('b', { cwd: 'D:/Coding/proj-b' })],
    { projectRoot: ROOT },
  )
  assert.deepEqual(detectCollisions(view), [])
})
