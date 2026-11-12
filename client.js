/**
 * 协同 panel — Client half.
 *
 * Registers a third Conversation view ("协同") beside 对话 / 轨迹. All data is
 * fetched from this package's Host half (`/claude-review/api/panel`), which reads
 * the project's `.trellis/` tree. Nothing here reads the filesystem or mutates
 * session state; the view is strictly read-only.
 */
window.__ModuleLoader__.load({
  id: '@local/claude-code-review',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const CSS = `
.crc-root { display:flex; flex-direction:column; height:100%; min-height:0; overflow:hidden;
  color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-base); font-size:13px; }
.crc-head { padding:14px 18px 10px; border-bottom:1px solid var(--dsw-alias-border-l1); flex:none; }
.crc-title { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; }
.crc-title strong { font-size:15px; font-weight:600; }
.crc-muted { color:var(--dsw-alias-label-secondary); font-size:12px; }
.crc-badges { display:flex; gap:6px; margin-top:8px; flex-wrap:wrap; }
.crc-badge { display:inline-flex; align-items:center; gap:4px; padding:2px 8px; border-radius:999px;
  border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); font-size:11.5px; }
.crc-badge-ok { color:var(--dsw-alias-state-success-primary); border-color:currentColor; }
.crc-badge-bad { color:var(--dsw-alias-state-error-primary); border-color:currentColor; }
.crc-badge-warn { color:var(--dsw-alias-state-warn-primary); border-color:currentColor; }
.crc-badge-idle { color:var(--dsw-alias-state-idle-primary); }
.crc-body { flex:1; min-height:0; overflow:auto; padding:12px 18px 24px; }
.crc-section { margin-top:16px; }
.crc-section > h4 { margin:0 0 8px; font-size:12px; letter-spacing:.04em; text-transform:uppercase;
  color:var(--dsw-alias-label-secondary); font-weight:600; }
.crc-round { border:1px solid var(--dsw-alias-border-l1); border-radius:10px; background:var(--dsw-alias-bg-layer-1);
  margin-bottom:8px; overflow:hidden; }
.crc-round-head { display:flex; align-items:center; gap:10px; padding:9px 12px; cursor:pointer; flex-wrap:wrap; }
.crc-round-head:hover { background:var(--dsw-alias-bg-layer-2); }
.crc-round-no { font-variant-numeric:tabular-nums; font-weight:600; }
.crc-round-summary { color:var(--dsw-alias-label-secondary); font-size:12px; margin-left:auto; }
.crc-issues { border-top:1px solid var(--dsw-alias-border-l1); padding:6px 12px 10px; }
.crc-issue { padding:7px 0; border-bottom:1px dashed var(--dsw-alias-border-l1); }
.crc-issue:last-child { border-bottom:none; }
.crc-issue-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.crc-sev { font-size:11px; padding:1px 6px; border-radius:4px; border:1px solid currentColor; }
.crc-sev-critical { color:var(--dsw-alias-state-error-primary); }
.crc-sev-important { color:var(--dsw-alias-state-warn-primary); }
.crc-sev-minor { color:var(--dsw-alias-label-secondary); }
.crc-loc { font-family:ui-monospace,Consolas,monospace; font-size:11.5px;
  color:var(--dsw-alias-label-secondary); }
.crc-issue-text { flex:1 1 320px; min-width:220px; }
.crc-detail { margin-top:6px; padding-left:2px; color:var(--dsw-alias-label-secondary); font-size:12px; line-height:1.55; }
.crc-detail b { color:var(--dsw-alias-label-primary); font-weight:600; }
.crc-dot { color:var(--dsw-alias-label-secondary); }
.crc-empty { color:var(--dsw-alias-label-secondary); padding:18px 0; }
.crc-btn { margin-left:auto; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary); border-radius:6px; padding:3px 10px; font-size:12px; cursor:pointer; }
.crc-btn:hover { background:var(--dsw-alias-bg-layer-2); }
.crc-artifacts { display:flex; gap:14px; flex-wrap:wrap; }
.crc-ok { color:var(--dsw-alias-state-success-primary); }
.crc-no { color:var(--dsw-alias-state-idle-primary); }
`

    function shortId(value) {
      const text = String(value || '')
      if (text === '') return '—'
      const tail = text.slice(-8)
      return `…${tail}`
    }

    function when(value) {
      if (!value) return ''
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return String(value)
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function badge(text, tone) {
      return h('span', { className: `crc-badge crc-badge-${tone}` }, text)
    }

    function verdictTone(verdict) {
      if (verdict === 'pass' || verdict === 'gate-pass') return 'ok'
      if (verdict === 'fix' || verdict === 'reject' || verdict === 'fail' || verdict === 'gate-blocked') return 'bad'
      if (verdict === 'nothing-to-review') return 'idle'
      return 'warn'
    }

    const DISPOSITION_LABEL = {
      fixed: ['已修', 'ok'],
      'counter-evidence': ['已反证', 'warn'],
      deferred: ['暂缓', 'idle'],
      gone: ['视为已修（推断）', 'ok'],
      'same-file': ['同文件另有问题', 'warn'],
      'still-there': ['复检仍存在', 'bad'],
      unreviewed: ['未复检', 'idle'],
    }

    function dispositionBadge(disposition) {
      if (!disposition) return null
      const [label, tone] = DISPOSITION_LABEL[disposition.status] || [disposition.status, 'idle']
      const title = disposition.note ? `${label} · ${disposition.note}` : label
      return h('span', { className: `crc-badge crc-badge-${tone}`, title }, label)
    }

    function IssueRow(props) {
      const issue = props.issue
      const [open, setOpen] = React.useState(false)
      const sev = String(issue.severity || 'minor')
      return h(
        'div',
        { className: 'crc-issue' },
        h(
          'div',
          { className: 'crc-issue-head' },
          h('span', { className: `crc-sev crc-sev-${sev}` }, sev),
          h('span', { className: 'crc-loc' }, `${issue.file || '—'}${issue.line ? `:${issue.line}` : ''}`),
          h('span', { className: 'crc-issue-text' }, issue.issue || '(无描述)'),
          dispositionBadge(issue.disposition),
          h(
            'button',
            {
              className: 'crc-btn',
              onClick: (event) => {
                event.stopPropagation()
                setOpen(!open)
              },
            },
            open ? '收起' : '详情',
          ),
        ),
        open
          ? h(
              'div',
              { className: 'crc-detail' },
              issue.why ? h('div', null, h('b', null, '后果：'), issue.why) : null,
              issue.fix ? h('div', null, h('b', null, '方向：'), issue.fix) : null,
              issue.disposition?.note ? h('div', null, h('b', null, '处置：'), issue.disposition.note) : null,
              issue.key ? h('div', null, h('b', null, 'key：'), issue.key) : null,
            )
          : null,
      )
    }

    function RoundCard(props) {
      const round = props.round
      const [open, setOpen] = React.useState(false)
      const counts = round.counts || {}
      const mustFix = (counts.critical || 0) + (counts.important || 0)
      return h(
        'div',
        { className: 'crc-round' },
        h(
          'div',
          { className: 'crc-round-head', onClick: () => setOpen(!open) },
          h('span', { className: 'crc-round-no' }, `#${round.round}`),
          h('span', { className: 'crc-muted' }, round.mode || ''),
          badge(round.verdict || 'unknown', verdictTone(round.verdict)),
          h(
            'span',
            { className: 'crc-muted' },
            `critical ${counts.critical || 0} · important ${counts.important || 0} · minor ${counts.minor || 0}`,
          ),
          h('span', { className: 'crc-muted' }, `会话 ${shortId(round.sessionId)}`),
          h('span', { className: 'crc-muted' }, when(round.at)),
          round.costUsd ? h('span', { className: 'crc-muted' }, `$${Number(round.costUsd).toFixed(2)}`) : null,
          h('span', { className: 'crc-round-summary' }, open ? '收起' : mustFix > 0 ? `${mustFix} 条必修` : '展开'),
        ),
        open
          ? h(
              'div',
              { className: 'crc-issues' },
              round.summary ? h('div', { className: 'crc-detail' }, h('b', null, '结论：'), round.summary) : null,
              (round.issues || []).length === 0
                ? h('div', { className: 'crc-muted' }, '本轮没有条目化问题')
                : round.issues.map((issue) => h(IssueRow, { key: `${round.round}-${issue.index}`, issue })),
            )
          : null,
      )
    }

    function CollabView(props) {
      const sessionId = props && props.sessionId ? String(props.sessionId) : ''
      const [state, setState] = React.useState({ loading: true, data: null, error: '', at: 0 })

      const load = React.useCallback(async () => {
        if (sessionId === '') {
          setState({ loading: false, data: null, error: '缺少会话标识', at: Date.now() })
          return
        }
        try {
          const response = await fetch(`/claude-review/api/panel?sessionId=${encodeURIComponent(sessionId)}`, {
            headers: { accept: 'application/json' },
          })
          const payload = await response.json()
          setState({ loading: false, data: payload, error: payload?.ok === false ? String(payload.error || '') : '', at: Date.now() })
        } catch (error) {
          setState({ loading: false, data: null, error: String((error && error.message) || error), at: Date.now() })
        }
      }, [sessionId])

      React.useEffect(() => {
        let alive = true
        const run = () => {
          if (alive) load()
        }
        run()
        const timer = setInterval(run, 8000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [load])

      const data = state.data
      const active = data && data.active ? data.active : null

      const header = h(
        'div',
        { className: 'crc-head' },
        h(
          'div',
          { className: 'crc-title' },
          h('strong', null, active && active.task?.title ? active.task.title : '协同审核'),
          data && data.project ? h('span', { className: 'crc-muted' }, data.project.root) : null,
          h(
            'button',
            {
              className: 'crc-btn',
              onClick: () => {
                setState((prev) => ({ ...prev, loading: true }))
                load()
              },
            },
            state.loading ? '刷新中…' : '刷新',
          ),
        ),
        active
          ? h(
              'div',
              { className: 'crc-badges' },
              active.task?.status ? badge(`阶段 ${active.task.status}`, 'idle') : null,
              active.task?.priority ? badge(active.task.priority, 'idle') : null,
              active.gate ? badge(`门禁 ${active.gate.state}`, active.gate.state === 'pass' ? 'ok' : active.gate.state === 'blocked' ? 'bad' : 'idle') : null,
              active.rounds?.length ? badge(`${active.rounds.length} 轮审核`, 'idle') : null,
              h('span', { className: 'crc-muted' }, `会话 ${shortId(sessionId)}`),
            )
          : null,
      )

      let body
      if (state.error === 'session-not-resolved') {
        body = h('div', { className: 'crc-empty' }, '无法解析当前会话所属的项目目录：面板只显示会话自己项目的数据。重启 DSH 后仍有问题请检查插件配置。')
      } else if (state.error === 'no-trellis') {
        body = h('div', { className: 'crc-empty' }, '这个工作区没有 .trellis/ 目录：面板只在 Trellis 项目里显示内容。')
      } else if (state.error) {
        body = h('div', { className: 'crc-empty' }, `读取失败：${state.error}`)
      } else if (!active) {
        body = h('div', { className: 'crc-empty' }, state.loading ? '加载中…' : '还没有 Trellis 任务或审核记录。')
      } else {
        const rounds = (active.rounds || []).slice().reverse()
        body = h(
          'div',
          null,
          h(
            'div',
            { className: 'crc-section' },
            h('h4', null, '审核轮次（本项目全部会话）'),
            rounds.length === 0
              ? h('div', { className: 'crc-muted' }, '还没有审核记录。跑一次 claude_review 就会出现在这里。')
              : rounds.map((round) => h(RoundCard, { key: round.round, round })),
          ),
          h(
            'div',
            { className: 'crc-section' },
            h('h4', null, 'Trellis 进度'),
            h(
              'div',
              { className: 'crc-artifacts' },
              h('span', { className: active.artifacts?.prd ? 'crc-ok' : 'crc-no' }, `prd ${active.artifacts?.prd ? '✓' : '—'}`),
              h('span', { className: active.artifacts?.design ? 'crc-ok' : 'crc-no' }, `design ${active.artifacts?.design ? '✓' : '—'}`),
              h('span', { className: active.artifacts?.implement ? 'crc-ok' : 'crc-no' }, `implement ${active.artifacts?.implement ? '✓' : '—'}`),
              h('span', { className: 'crc-muted' }, `check.jsonl ${active.manifests?.check ?? 0} 条`),
              h('span', { className: 'crc-muted' }, `implement.jsonl ${active.manifests?.implement ?? 0} 条`),
            ),
            active.gate?.reason ? h('div', { className: 'crc-detail' }, h('b', null, '门禁：'), active.gate.reason) : null,
            data.tasks && data.tasks.length > 1
              ? h(
                  'div',
                  { className: 'crc-detail' },
                  h('b', null, '其它任务：'),
                  data.tasks
                    .filter((task) => task.name !== active.task?.dir?.split(/[\\/]/).pop())
                    .slice(0, 6)
                    .map((task) => `${task.title || task.name}${task.status ? `（${task.status}）` : ''}`)
                    .join('、'),
                )
              : null,
          ),
        )
      }

      return h('div', { className: 'crc-root' }, header, h('div', { className: 'crc-body' }, body))
    }

    return {
      // `styles` 是模块级 builtin（styles.insert(css)），不是 cordis 服务：
      // 写进 inject 会让插件声明在激活时失败（unknown service），整个视图注册不上。
      inject: ['slots'],
      apply(ctx) {
        // styles 是模块级 builtin；万一宿主没提供，样式失败也不能拖垮整个视图注册。
        const styleApi = typeof styles !== 'undefined' ? styles : undefined
        if (styleApi && typeof styleApi.insert === 'function') {
          ctx.effect(() => styleApi.insert(CSS))
        }
        ctx.slots.inject('conversation.view', () =>
          ctx.slots.register(
            { name: 'conversation.view', id: 'collab', order: 20, label: () => '协同' },
            CollabView,
          ),
        )
      },
    }
  },
})

