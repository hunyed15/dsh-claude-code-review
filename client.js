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

    const PLUGIN_ID = '@local/claude-code-review'
    const CSS_TAG = `${PLUGIN_ID}/panel.css`

    const CSS = `
.crc-root {
  --crc-bg: var(--dsw-alias-bg-base);
  --crc-surface: var(--dsw-alias-bg-layer-1);
  --crc-surface-2: var(--dsw-alias-bg-layer-2);
  --crc-border: var(--dsw-alias-border-l1);
  --crc-border-strong: var(--dsw-alias-border-l2);
  --crc-text: var(--dsw-alias-label-primary);
  --crc-muted: var(--dsw-alias-label-secondary);
  --crc-brand: var(--dsw-alias-brand-primary);
  --crc-ok: var(--dsw-alias-state-success-primary);
  --crc-warn: var(--dsw-alias-state-warn-primary);
  --crc-bad: var(--dsw-alias-state-error-primary);
  --crc-idle: var(--dsw-alias-state-idle-primary);
  display:flex; flex-direction:column; height:100%; min-height:0; overflow:hidden;
  color:var(--crc-text); background:var(--crc-bg);
  font-family:ui-sans-serif,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  font-size:13px; line-height:1.55; -webkit-font-smoothing:antialiased;
}
.crc-root *, .crc-root *::before, .crc-root *::after { box-sizing:border-box; }
.crc-root ::selection { background:color-mix(in srgb, var(--crc-brand) 26%, transparent); }
.crc-head { flex:none; border-bottom:1px solid var(--crc-border); background:var(--crc-bg); }
.crc-head-inner { max-width:1180px; margin:0 auto; padding:20px 24px 16px; display:flex; align-items:flex-start; justify-content:space-between; gap:20px; flex-wrap:wrap; }
.crc-head-main { flex:1 1 320px; min-width:0; }
.crc-title-row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.crc-title { margin:0; font-size:19px; line-height:1.3; font-weight:620; letter-spacing:-.01em; text-wrap:balance; }
.crc-meta { display:flex; align-items:center; gap:16px; flex-wrap:wrap; margin-top:7px; color:var(--crc-muted); font-size:12px; }
.crc-meta-item { display:inline-flex; align-items:baseline; gap:6px; min-width:0; }
.crc-meta-label { color:var(--crc-muted); }
.crc-meta-value { color:var(--crc-text); font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:320px; }
.crc-meta-readonly { color:var(--crc-muted); }
.crc-head-actions { display:flex; align-items:center; gap:8px; flex:none; margin-left:auto; }
.crc-btn { appearance:none; border:1px solid var(--crc-border-strong); background:var(--crc-surface); color:var(--crc-text); border-radius:8px; padding:7px 11px; font:inherit; font-size:12px; font-weight:500; line-height:1.2; display:inline-flex; align-items:center; gap:6px; cursor:pointer; transition:background-color .16s ease,border-color .16s ease,color .16s ease,opacity .16s ease; }
.crc-btn:hover:not(:disabled) { background:var(--crc-surface-2); }
.crc-btn:disabled { opacity:.6; cursor:default; }
.crc-btn:focus-visible { outline:2px solid var(--crc-brand); outline-offset:2px; }
.crc-spin { animation:crc-spin .9s linear infinite; }
@keyframes crc-spin { to { transform:rotate(360deg); } }
.crc-body { flex:1; min-height:0; overflow:auto; padding:20px 24px 36px; scrollbar-width:thin; scrollbar-color:var(--crc-border-strong) transparent; }
.crc-body::-webkit-scrollbar { width:10px; }
.crc-body::-webkit-scrollbar-thumb { background:var(--crc-border-strong); border-radius:999px; border:3px solid transparent; background-clip:content-box; }
.crc-body::-webkit-scrollbar-track { background:transparent; }
.crc-content { max-width:1180px; margin:0 auto; }
.crc-inline-error { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:16px; padding:8px 12px; border:1px solid var(--crc-bad); border-radius:8px; color:var(--crc-bad); background:var(--crc-surface); font-size:12px; }
.crc-run { display:flex; align-items:center; gap:8px; margin-bottom:14px; padding:8px 12px; border:1px solid var(--crc-border-strong); border-radius:8px; background:var(--crc-surface); font-size:12px; }
.crc-run-dot { width:7px; height:7px; border-radius:50%; background:var(--crc-brand); flex:none; }
.crc-run-running .crc-run-dot { animation:crc-pulse 1.2s ease-in-out infinite; }
.crc-run-stale { border-color:var(--crc-warn); color:var(--crc-warn); }
.crc-run-failed { border-color:var(--crc-bad); color:var(--crc-bad); }
.crc-run-stale .crc-run-dot, .crc-run-failed .crc-run-dot { background:currentColor; }
.crc-run-detail { margin-left:auto; color:var(--crc-muted); font-size:11.5px; }
.crc-rail { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); border:1px solid var(--crc-border); border-radius:10px; background:var(--crc-surface); overflow:hidden; margin-bottom:26px; }
.crc-rail-cell { padding:12px 16px; min-width:0; }
.crc-rail-cell + .crc-rail-cell { border-left:1px solid var(--crc-border); }
.crc-rail-label { color:var(--crc-muted); font-size:11.5px; line-height:1.4; }
.crc-rail-value { margin-top:3px; font-size:14px; font-weight:600; font-variant-numeric:tabular-nums; display:flex; align-items:center; gap:7px; min-width:0; }
.crc-rail-sub { margin-top:2px; color:var(--crc-muted); font-size:11.5px; line-height:1.45; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.crc-grid { display:grid; grid-template-columns:minmax(0,1fr) 300px; gap:28px; align-items:start; }
.crc-section-head { display:flex; align-items:baseline; justify-content:space-between; gap:12px; margin-bottom:12px; }
.crc-section-head h2 { margin:0; font-size:13px; line-height:1.4; font-weight:600; }
.crc-section-count { color:var(--crc-muted); font-size:11.5px; }
.crc-timeline { position:relative; display:flex; flex-direction:column; gap:10px; }
.crc-timeline::before { content:""; position:absolute; left:9px; top:8px; bottom:8px; width:1px; background:var(--crc-border-strong); }
.crc-round { position:relative; padding-left:30px; }
.crc-node { position:absolute; left:4px; top:17px; width:11px; height:11px; border-radius:50%; background:var(--crc-idle); box-shadow:0 0 0 3px var(--crc-bg); z-index:1; }
.crc-node-ok { background:var(--crc-ok); }
.crc-node-bad { background:var(--crc-bad); }
.crc-node-warn { background:var(--crc-warn); }
.crc-node-idle { background:var(--crc-idle); }
.crc-round-latest .crc-node { box-shadow:0 0 0 3px var(--crc-bg),0 0 0 4px var(--crc-brand); }
.crc-round-body { border:1px solid var(--crc-border); border-radius:10px; background:var(--crc-surface); overflow:hidden; }
.crc-round-latest .crc-round-body { border-color:var(--crc-border-strong); }
.crc-round-head { width:100%; appearance:none; border:0; background:transparent; color:inherit; font:inherit; text-align:left; display:flex; align-items:center; gap:9px; flex-wrap:wrap; padding:11px 14px; cursor:pointer; }
.crc-round-head:hover { background:var(--crc-surface-2); }
.crc-round-head:focus-visible { outline:2px solid var(--crc-brand); outline-offset:-2px; }
.crc-round-no { font-size:12.5px; font-weight:650; font-variant-numeric:tabular-nums; }
.crc-round-mode { color:var(--crc-muted); font-size:11.5px; }
.crc-round-transport { color:var(--crc-accent, var(--crc-muted)); font-size:10.5px; letter-spacing:.04em; border:1px solid var(--crc-line); border-radius:999px; padding:0 6px; }
.crc-round-warning { margin:6px 0 0; color:var(--crc-warn, var(--crc-muted)); font-size:12px; line-height:1.5; }
.crc-round-counts { display:inline-flex; align-items:center; gap:8px; color:var(--crc-muted); font-size:11.5px; font-variant-numeric:tabular-nums; }
.crc-count-critical { color:var(--crc-bad); }
.crc-count-important { color:var(--crc-warn); }
.crc-count-minor { color:var(--crc-muted); }
.crc-round-when { margin-left:auto; color:var(--crc-muted); font-size:11.5px; font-variant-numeric:tabular-nums; white-space:nowrap; }
.crc-round-cost { color:var(--crc-muted); font-size:11.5px; font-variant-numeric:tabular-nums; white-space:nowrap; }
.crc-chevron { flex:none; color:var(--crc-muted); transition:transform .16s ease; }
.crc-round-head[aria-expanded="true"] .crc-chevron,
.crc-issue-head[aria-expanded="true"] .crc-chevron { transform:rotate(90deg); }
.crc-chevron-sm { width:13px; height:13px; }
.crc-round-detail { padding:0 14px 14px; border-top:1px solid var(--crc-border); }
.crc-summary { margin:12px 0 0; font-size:12.5px; line-height:1.6; }
.crc-advice { margin-top:10px; padding-top:10px; border-top:1px dashed var(--crc-border); color:var(--crc-muted); font-size:12px; line-height:1.6; }
.crc-advice-block + .crc-advice-block { margin-top:6px; }
.crc-advice b { color:var(--crc-text); font-weight:600; margin-right:6px; }
.crc-advice ul { margin:4px 0 0; padding-left:16px; }
.crc-advice li { margin:2px 0; }
.crc-advice-assessment { margin:6px 0 0; }
.crc-round-meta { display:flex; gap:14px; flex-wrap:wrap; margin-top:8px; color:var(--crc-muted); font-size:11.5px; font-variant-numeric:tabular-nums; }
.crc-issues { list-style:none; margin:10px 0 0; padding:0; }
.crc-issue + .crc-issue { border-top:1px solid var(--crc-border); }
.crc-issue-head { width:100%; appearance:none; border:0; background:transparent; color:inherit; font:inherit; text-align:left; display:flex; align-items:baseline; gap:9px; flex-wrap:wrap; padding:9px 0; cursor:pointer; }
.crc-issue-head:focus-visible { outline:2px solid var(--crc-brand); outline-offset:1px; }
.crc-sev { flex:none; font-size:11px; line-height:1.5; padding:0 6px; border:1px solid currentColor; border-radius:999px; }
.crc-sev-bad { color:var(--crc-bad); }
.crc-sev-warn { color:var(--crc-warn); }
.crc-sev-idle { color:var(--crc-muted); }
.crc-loc { flex:none; max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--crc-muted); font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:11px; }
.crc-issue-text { flex:1 1 260px; min-width:160px; font-size:12.5px; line-height:1.5; }
.crc-issue-detail { padding:2px 0 12px; color:var(--crc-muted); font-size:12px; line-height:1.6; }
.crc-issue-detail p { margin:4px 0 0; }
.crc-issue-detail b { color:var(--crc-text); font-weight:600; margin-right:6px; }
.crc-key { font-size:11.5px; }
.crc-pill { display:inline-flex; align-items:center; gap:4px; padding:1px 7px; border:1px solid currentColor; border-radius:999px; font-size:11px; line-height:1.6; font-weight:500; white-space:nowrap; }
.crc-pill-ok { color:var(--crc-ok); }
.crc-pill-bad { color:var(--crc-bad); }
.crc-pill-warn { color:var(--crc-warn); }
.crc-pill-idle { color:var(--crc-muted); }
.crc-pill-brand { color:var(--crc-brand); }
.crc-dot { width:7px; height:7px; border-radius:50%; background:currentColor; flex:none; }
.crc-dot-ok { color:var(--crc-ok); }
.crc-dot-bad { color:var(--crc-bad); }
.crc-dot-warn { color:var(--crc-warn); }
.crc-dot-idle { color:var(--crc-idle); }
.crc-dot-brand { color:var(--crc-brand); }
.crc-aside { position:sticky; top:0; }
.crc-side-card { border:1px solid var(--crc-border); border-radius:10px; background:var(--crc-surface); overflow:hidden; }
.crc-side-section { padding:14px 16px; }
.crc-side-section + .crc-side-section { border-top:1px solid var(--crc-border); }
.crc-side-section h2 { margin:0 0 8px; font-size:12px; font-weight:600; }
.crc-next { background:var(--crc-surface-2); }
.crc-next-row { display:flex; align-items:center; gap:7px; }
.crc-next-label { font-size:13px; font-weight:600; line-height:1.4; }
.crc-gate-head { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:8px; }
.crc-gate-head h2 { margin:0; }
.crc-gate-reason { margin:0; color:var(--crc-muted); font-size:12px; line-height:1.55; }
.crc-note { margin:10px 0 0; color:var(--crc-muted); font-size:11.5px; line-height:1.55; }
.crc-check-list { display:flex; flex-direction:column; gap:6px; }
.crc-check-row { display:flex; align-items:center; gap:7px; font-size:12px; min-width:0; }
.crc-check-row svg { flex:none; }
.crc-check-label { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.crc-check-yes { color:var(--crc-ok); }
.crc-check-no { color:var(--crc-muted); }
.crc-manifests { display:flex; gap:14px; flex-wrap:wrap; margin-top:10px; color:var(--crc-muted); font-size:11.5px; }
.crc-manifests b { color:var(--crc-text); font-weight:600; font-variant-numeric:tabular-nums; }
.crc-task-list { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:4px; }
.crc-task { min-width:0; }
.crc-task-btn { width:100%; display:flex; align-items:center; gap:8px; padding:6px 8px; border:1px solid transparent; border-radius:7px; background:transparent; color:inherit; font:inherit; font-size:12px; text-align:left; cursor:pointer; transition:background-color .16s ease,border-color .16s ease; }
.crc-task-btn:hover { background:var(--crc-surface-2); }
.crc-task-btn:focus-visible { outline:2px solid var(--crc-brand); outline-offset:1px; }
.crc-task-active { background:var(--crc-surface-2); border-color:var(--crc-border-strong); }
.crc-task-title { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.crc-task-pending { color:var(--crc-bad); font-size:11px; white-space:nowrap; }
.crc-task-round { color:var(--crc-muted); font-size:11px; font-variant-numeric:tabular-nums; }
.crc-empty-timeline { position:relative; border:1px dashed var(--crc-border-strong); border-radius:10px; background:var(--crc-surface); padding:18px 18px 18px 42px; }
.crc-empty-node { position:absolute; left:16px; top:23px; width:11px; height:11px; border-radius:50%; background:var(--crc-surface-2); border:1px solid var(--crc-border-strong); }
.crc-empty-timeline h3 { margin:0; font-size:13px; font-weight:600; }
.crc-empty-timeline p { margin:4px 0 0; color:var(--crc-muted); font-size:12px; line-height:1.55; }
.crc-empty-steps { display:flex; gap:16px; flex-wrap:wrap; margin-top:14px; padding-top:12px; border-top:1px solid var(--crc-border); }
.crc-empty-step { display:inline-flex; align-items:center; gap:6px; color:var(--crc-muted); font-size:11.5px; }
.crc-empty-step b { width:18px; height:18px; border-radius:50%; border:1px solid var(--crc-border-strong); display:inline-flex; align-items:center; justify-content:center; font-size:10.5px; font-weight:600; color:var(--crc-text); }
.crc-root .crc-code { font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:11px; padding:1px 5px; border:1px solid var(--crc-border); border-radius:4px; background:var(--crc-surface-2); color:var(--crc-text); text-decoration:none; }
.crc-foot { margin:26px 0 0; color:var(--crc-muted); font-size:11px; text-align:center; }
.crc-state { min-height:420px; display:flex; align-items:center; justify-content:center; padding:24px; }
.crc-state-inner { max-width:460px; text-align:center; }
.crc-state-icon { width:38px; height:38px; margin:0 auto 12px; border:1px solid var(--crc-border-strong); border-radius:50%; display:flex; align-items:center; justify-content:center; color:var(--crc-muted); background:var(--crc-surface); }
.crc-state h2 { margin:0; font-size:15px; font-weight:600; }
.crc-state p { margin:6px 0 0; color:var(--crc-muted); font-size:12.5px; line-height:1.6; }
.crc-state .crc-btn { margin-top:14px; }
.crc-skeleton { max-width:1180px; margin:0 auto; }
.crc-skel { background:var(--crc-surface-2); border-radius:6px; animation:crc-pulse 1.4s ease-in-out infinite; }
.crc-skel-line { height:14px; margin-bottom:10px; }
.crc-skel-rail { height:66px; border-radius:10px; margin-bottom:26px; }
.crc-skel-grid { display:grid; grid-template-columns:minmax(0,1fr) 300px; gap:28px; }
.crc-skel-card { height:120px; border-radius:10px; }
@keyframes crc-pulse { 0%,100% { opacity:.55; } 50% { opacity:.9; } }
@media (max-width:960px) {
  .crc-grid, .crc-skel-grid { grid-template-columns:minmax(0,1fr); }
  .crc-aside { position:static; }
}
@media (max-width:720px) {
  .crc-rail { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .crc-rail-cell:nth-child(3) { border-left:0; }
  .crc-rail-cell:nth-child(n+3) { border-top:1px solid var(--crc-border); }
  .crc-head-inner { padding:16px 16px 14px; }
  .crc-body { padding:16px 16px 30px; }
  .crc-round-when { margin-left:0; }
}
@media (max-width:520px) {
  .crc-title { font-size:17px; }
  .crc-meta { gap:10px; }
  .crc-round-head { gap:7px; }
  .crc-round-cost { display:none; }
  .crc-loc { max-width:100%; }
}
@media (prefers-reduced-motion:reduce) {
  .crc-root *, .crc-root *::before, .crc-root *::after { animation-duration:.001ms !important; animation-iteration-count:1 !important; transition-duration:.001ms !important; scroll-behavior:auto !important; }
}
`

    // Official DSH client packages append a <style> tag to document.head.
    // The `styles` builtin was not applying in this runtime, so inject directly
    // (idempotent; remove our previous tag first so HMR reloads pick up new CSS).
    if (typeof document !== 'undefined' && document.head) {
      for (const old of document.querySelectorAll(`style[data-plugin="${PLUGIN_ID}"]`)) old.remove()
      const tag = document.createElement('style')
      tag.dataset.plugin = PLUGIN_ID
      tag.dataset.pluginCss = CSS_TAG
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    const MODE_LABEL = { incremental: '增量', full: '全量', gate: '门禁', range: '范围' }
    const VERDICT_META = {
      pass: ['通过', 'ok'],
      fix: ['需修', 'bad'],
      reject: ['驳回', 'bad'],
      'nothing-to-review': ['无改动', 'idle'],
      'gate-pass': ['门禁通过', 'ok'],
      'gate-blocked': ['门禁阻断', 'bad'],
    }
    const SEVERITY_META = {
      critical: ['严重', 'bad'],
      important: ['重要', 'warn'],
      minor: ['次要', 'idle'],
    }
    const DISPOSITION_META = {
      fixed: ['已修', 'ok'],
      'counter-evidence': ['已反证', 'warn'],
      deferred: ['暂缓', 'idle'],
      gone: ['视为已修', 'ok'],
      'same-file': ['同文件另有问题', 'warn'],
      'still-there': ['复检仍存在', 'bad'],
      unreviewed: ['未复检', 'idle'],
    }
    const GATE_META = {
      pass: ['通过', 'ok'],
      blocked: ['阻断', 'bad'],
      unknown: ['未判定', 'idle'],
    }
    const TASK_STATUS_META = {
      in_progress: ['进行中', 'brand'],
      pending: ['待开始', 'idle'],
      completed: ['已完成', 'ok'],
      archived: ['已归档', 'idle'],
    }
    const LIFECYCLE_META = {
      new: ['新发现', 'brand'],
      'still-there': ['仍存在', 'warn'],
      fixed: ['已修复', 'ok'],
      reopened: ['复发', 'bad'],
      unreviewed: ['未复检', 'idle'],
      unknown: ['—', 'idle'],
    }
    const STORAGE_META = {
      trellis: ['Trellis', 'brand'],
      local: ['本地账本', 'idle'],
    }

    function meta(map, key, fallback) {
      return map[key] || [fallback || String(key || '未知'), 'idle']
    }

    function cx(...values) {
      return values.filter(Boolean).join(' ')
    }

    function shortId(value) {
      const text = String(value || '')
      return text === '' ? '—' : `…${text.slice(-8)}`
    }

    function when(value) {
      if (!value) return '—'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return String(value)
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function timeOf(value) {
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return ''
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    function money(value) {
      const amount = Number(value)
      return Number.isFinite(amount) && amount > 0 ? `$${amount.toFixed(2)}` : ''
    }

    function elapsedLabel(value) {
      const seconds = Number(value)
      if (!Number.isFinite(seconds) || seconds < 0) return ''
      if (seconds < 60) return `${Math.round(seconds)} 秒`
      const minutes = Math.floor(seconds / 60)
      const rest = Math.round(seconds % 60)
      return rest > 0 ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`
    }

    function modeLabel(value) {
      return MODE_LABEL[value] || value || '—'
    }

    function Svg(props) {
      return h(
        'svg',
        {
          width: props.size || 16,
          height: props.size || 16,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          className: props.className,
          'aria-hidden': 'true',
          focusable: 'false',
        },
        props.children,
      )
    }

    function RefreshIcon(props) {
      return h(
        Svg,
        { className: props.spinning ? 'crc-spin' : undefined },
        h('path', { d: 'M13.2 8a5.2 5.2 0 1 1-1.5-3.7' }),
        h('path', { d: 'M13.2 2.6v3.2H10' }),
      )
    }

    function ChevronIcon(props) {
      return h(Svg, { className: props.className }, h('path', { d: 'M6 3.5 10.5 8 6 12.5' }))
    }

    function CheckIcon() {
      return h(Svg, null, h('path', { d: 'M3 8.2l3.2 3.2L13 4.6' }))
    }

    function MinusIcon() {
      return h(Svg, null, h('path', { d: 'M4 8h8' }))
    }

    function AlertIcon() {
      return h(
        Svg,
        null,
        h('circle', { cx: 8, cy: 8, r: 5.6 }),
        h('path', { d: 'M8 5.2v3.4' }),
        h('path', { d: 'M8 10.9h.01' }),
      )
    }

    function Pill(props) {
      return h('span', { className: `crc-pill crc-pill-${props.tone || 'idle'}`, title: props.title }, props.children)
    }

    function MetaItem(props) {
      return h(
        'span',
        { className: 'crc-meta-item', title: props.title },
        h('span', { className: 'crc-meta-label' }, props.label),
        h('span', { className: 'crc-meta-value' }, props.value),
      )
    }

    function Header(props) {
      const active = props.active
      const data = props.data || {}
      const title = active?.task?.title || '协同审核'
      const status = active?.task?.status ? meta(TASK_STATUS_META, active.task.status) : null
      const storage = data.storage ? meta(STORAGE_META, data.storage) : null
      return h(
        'header',
        { className: 'crc-head' },
        h(
          'div',
          { className: 'crc-head-inner' },
          h(
            'div',
            { className: 'crc-head-main' },
            h(
              'div',
              { className: 'crc-title-row' },
              h('h1', { className: 'crc-title', title }, title),
              status ? h(Pill, { tone: status[1], title: `状态 ${active.task.status}` }, status[0]) : null,
              active?.task?.priority ? h(Pill, { tone: 'idle', title: '优先级' }, active.task.priority) : null,
              storage ? h(Pill, { tone: storage[1], title: '审核账本' }, storage[0]) : null,
            ),
            h(
              'div',
              { className: 'crc-meta' },
              data.project
                ? h(MetaItem, { label: '项目', value: data.project.name || '—', title: data.project.root || '' })
                : null,
              props.sessionId
                ? h(MetaItem, { label: '会话', value: shortId(props.sessionId), title: props.sessionId })
                : null,
              h('span', { className: 'crc-meta-readonly' }, '只读'),
            ),
          ),
          h(
            'div',
            { className: 'crc-head-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'crc-btn',
                onClick: props.onRefresh,
                disabled: props.loading,
                'aria-label': '刷新审核数据',
                'aria-busy': props.loading ? 'true' : 'false',
              },
              h(RefreshIcon, { spinning: props.loading }),
              h('span', null, props.loading ? '刷新中' : '刷新'),
            ),
          ),
        ),
      )
    }

    function RailCell(props) {
      return h(
        'div',
        { className: 'crc-rail-cell', title: props.title },
        h('div', { className: 'crc-rail-label' }, props.label),
        h('div', { className: 'crc-rail-value' }, props.value),
        props.sub ? h('div', { className: 'crc-rail-sub' }, props.sub) : null,
      )
    }

    function StatusRail(props) {
      const active = props.active
      const rounds = props.rounds
      const latest = props.latest
      const gate = meta(GATE_META, active?.gate?.state, '未判定')
      const mustFix = latest ? (latest.counts?.critical || 0) + (latest.counts?.important || 0) : null
      const gateSub = latest
        ? `最近 ${modeLabel(latest.mode)} ${meta(VERDICT_META, latest.verdict)[0]}`
        : '还没有审核记录'
      const latestSub = latest
        ? `${modeLabel(latest.mode)}${latest.transport ? ` · ${String(latest.transport).toUpperCase()}` : ''}${latest.costKnown !== false && latest.costUsd ? `，${money(latest.costUsd)}` : ''}`
        : '等待第一次审核'
      const totalCost = Number(props.totalCostUsd) || 0
      const totalKnown = props.totalCostKnown !== false
      const totalText = totalCost > 0 ? `${totalKnown ? '累计' : '累计 ≥'} ${money(totalCost)}${totalKnown ? '' : '（含未知）'}` : '累计 —'
      return h(
        'section',
        { className: 'crc-rail', 'aria-label': '审核概览' },
        h(RailCell, {
          label: '门禁',
          value: h('span', { className: 'crc-rail-value' }, h('span', { className: `crc-dot crc-dot-${gate[1]}` }), gate[0]),
          sub: gateSub,
          title: active?.gate?.reason || '还没有审核记录',
        }),
        h(RailCell, {
          label: '审核轮次',
          value: String(rounds.length),
          sub: latest ? `最近 #${latest.round}，${totalText}` : '等待第一次审核',
        }),
        h(RailCell, {
          label: '待修问题',
          value: mustFix === null ? '—' : String(mustFix),
          sub: latest ? `严重 ${latest.counts?.critical || 0}，重要 ${latest.counts?.important || 0}` : '暂无待修',
        }),
        h(RailCell, {
          label: '最近审核',
          value: latest ? when(latest.at) : '—',
          sub: latestSub,
        }),
      )
    }

    function EmptyTimeline(props) {
      return h(
        'div',
        { className: 'crc-empty-timeline' },
        h('span', { className: 'crc-empty-node', 'aria-hidden': 'true' }),
        h('h3', null, props.hasTask ? '还没有审核记录' : '还没有 Trellis 任务'),
        props.hasTask
          ? h(
              'p',
              null,
              '让主代理跑一次 ',
              h('span', { className: 'crc-code' }, 'claude_review'),
              '，轮次、结论和问题会显示在这里。',
            )
          : h('p', null, '在项目根目录创建 Trellis 任务后，这里会显示审核进度。'),
        props.hasTask
          ? h(
              'div',
              { className: 'crc-empty-steps' },
              h('span', { className: 'crc-empty-step' }, h('b', null, '1'), '开发一轮'),
              h('span', { className: 'crc-empty-step' }, h('b', null, '2'), '跑审核'),
              h('span', { className: 'crc-empty-step' }, h('b', null, '3'), '修复后重跑'),
            )
          : null,
      )
    }

    function IssueItem(props) {
      const issue = props.issue
      const [open, setOpen] = React.useState(false)
      const severity = meta(SEVERITY_META, issue.severity, '次要')
      const disposition = issue.disposition ? meta(DISPOSITION_META, issue.disposition.status) : null
      const lifecycle = issue.lifecycle ? meta(LIFECYCLE_META, issue.lifecycle.state) : null
      const hasLifecycle = lifecycle && lifecycle[0] !== '—'
      const recorded = disposition && issue.disposition?.source === 'recorded' ? disposition : null
      const cycle = issue.lifecycle
      const cycleText =
        cycle && cycle.state !== 'unknown'
          ? `${meta(LIFECYCLE_META, cycle.state)[0]}（首次 #${cycle.firstRound}，最近 #${cycle.lastRound}${
              cycle.seen > 1 ? `，共 ${cycle.seen} 轮` : ''
            }）`
          : ''
      const dispositionText = disposition
        ? `${disposition[0]}${issue.disposition?.source === 'recorded' ? '（记录）' : '（推断）'}${
            issue.disposition?.note ? `：${issue.disposition.note}` : ''
          }`
        : ''
      return h(
        'li',
        { className: 'crc-issue' },
        h(
          'button',
          {
            type: 'button',
            className: 'crc-issue-head',
            onClick: () => setOpen(!open),
            'aria-expanded': open ? 'true' : 'false',
          },
          h('span', { className: `crc-sev crc-sev-${severity[1]}` }, severity[0]),
          h('span', { className: 'crc-loc', title: issue.file }, `${issue.file || '—'}${issue.line ? `:${issue.line}` : ''}`),
          h('span', { className: 'crc-issue-text' }, issue.issue || '(无描述)'),
          hasLifecycle ? h(Pill, { tone: lifecycle[1], title: cycleText || lifecycle[0] }, lifecycle[0]) : null,
          recorded ? h(Pill, { tone: recorded[1], title: dispositionText }, recorded[0]) : null,
          !hasLifecycle && !recorded && disposition
            ? h(Pill, { tone: disposition[1], title: dispositionText }, disposition[0])
            : null,
          h(ChevronIcon, { className: 'crc-chevron crc-chevron-sm' }),
        ),
        open
          ? h(
              'div',
              { className: 'crc-issue-detail' },
              cycleText ? h('p', null, h('b', null, '生命周期'), cycleText) : null,
              dispositionText ? h('p', null, h('b', null, '处置'), dispositionText) : null,
              issue.why ? h('p', null, h('b', null, '后果'), issue.why) : null,
              issue.fix ? h('p', null, h('b', null, '方向'), issue.fix) : null,
              issue.key ? h('p', { className: 'crc-key' }, h('b', null, 'key'), h('span', { className: 'crc-code' }, issue.key)) : null,
            )
          : null,
      )
    }

    function RoundAdvice(props) {
      const round = props.round
      const strengths = Array.isArray(round.strengths) ? round.strengths : []
      const recommendations = Array.isArray(round.recommendations) ? round.recommendations : []
      if (strengths.length === 0 && recommendations.length === 0 && !round.assessment) return null
      return h(
        'div',
        { className: 'crc-advice' },
        strengths.length > 0
          ? h(
              'div',
              { className: 'crc-advice-block' },
              h('b', null, '做得好'),
              h(
                'ul',
                null,
                strengths.map((item) =>
                  h('li', { key: `${item.point}|${item.evidence}` }, `${item.point}${item.evidence ? `（${item.evidence}）` : ''}`),
                ),
              ),
            )
          : null,
        recommendations.length > 0
          ? h(
              'div',
              { className: 'crc-advice-block' },
              h('b', null, '建议'),
              h('ul', null, recommendations.map((item) => h('li', { key: item }, item))),
            )
          : null,
        round.assessment ? h('p', { className: 'crc-advice-assessment' }, h('b', null, '判断'), round.assessment) : null,
      )
    }

    function RoundItem(props) {
      const round = props.round
      const [open, setOpen] = React.useState(Boolean(props.latest))
      const verdict = meta(VERDICT_META, round.verdict)
      const counts = round.counts || {}
      const issues = Array.isArray(round.issues) ? round.issues : []
      return h(
        'article',
        { className: cx('crc-round', props.latest && 'crc-round-latest') },
        h('span', { className: `crc-node crc-node-${verdict[1]}`, 'aria-hidden': 'true' }),
        h(
          'div',
          { className: 'crc-round-body' },
          h(
            'button',
            {
              type: 'button',
              className: 'crc-round-head',
              onClick: () => setOpen(!open),
              'aria-expanded': open ? 'true' : 'false',
            },
            h('span', { className: 'crc-round-no' }, `#${round.round}`),
            h(Pill, { tone: verdict[1], title: `结论 ${round.verdict || '未知'}` }, verdict[0]),
            h('span', { className: 'crc-round-mode', title: `模式 ${round.mode || '未知'}` }, modeLabel(round.mode)),
            round.transport ? h('span', { className: 'crc-round-transport', title: `传输 ${round.transport}` }, String(round.transport).toUpperCase()) : null,
            round.truncated ? h(Pill, { tone: 'bad', title: 'diff 被截断，结论不完整' }, '截断') : null,
            h(
              'span',
              { className: 'crc-round-counts' },
              h('span', { className: 'crc-count-critical' }, `严重 ${counts.critical || 0}`),
              h('span', { className: 'crc-count-important' }, `重要 ${counts.important || 0}`),
              h('span', { className: 'crc-count-minor' }, `次要 ${counts.minor || 0}`),
            ),
            h('span', { className: 'crc-round-when', title: round.at || '' }, when(round.at)),
            round.costKnown === false && round.transport === 'acp'
              ? h('span', { className: 'crc-round-cost', title: 'ACP 目前不返回逐轮成本' }, '成本 —')
              : round.costKnown !== false && round.costUsd
                ? h('span', { className: 'crc-round-cost' }, money(round.costUsd))
                : null,
            h(ChevronIcon, { className: 'crc-chevron' }),
          ),
          open
            ? h(
                'div',
                { className: 'crc-round-detail' },
                round.summary ? h('p', { className: 'crc-summary' }, round.summary) : null,
                round.transportWarning ? h('p', { className: 'crc-round-warning' }, round.transportWarning) : null,
                h(
                  'div',
                  { className: 'crc-round-meta' },
                  h('span', null, `文件 ${round.files ?? 0}`),
                  h('span', null, `会话 ${shortId(round.sessionId)}`),
                  round.transport ? h('span', null, `传输 ${String(round.transport).toUpperCase()}`) : null,
                  round.costKnown === false && round.transport === 'acp'
                    ? h('span', null, '成本 —')
                    : round.costKnown !== false && round.costUsd
                      ? h('span', null, `成本 ${money(round.costUsd)}`)
                      : null,
                ),
                h(RoundAdvice, { round }),
                issues.length === 0
                  ? h('p', { className: 'crc-note' }, '本轮没有条目化问题。')
                  : h(
                      'ul',
                      { className: 'crc-issues' },
                      issues.map((issue) =>
                        h(IssueItem, { key: issue.key || `${round.round}-${issue.index}`, issue }),
                      ),
                    ),
              )
            : null,
        ),
      )
    }

    function Timeline(props) {
      const ordered = [...props.rounds].sort((a, b) => b.round - a.round)
      return h(
        'section',
        { className: 'crc-section', 'aria-label': '审核轮次' },
        h(
          'div',
          { className: 'crc-section-head' },
          h('h2', null, '审核轮次'),
          h('span', { className: 'crc-section-count' }, ordered.length ? `共 ${ordered.length} 轮` : '等待第一次审核'),
        ),
        ordered.length === 0
          ? h(EmptyTimeline, { hasTask: Boolean(props.active) })
          : h(
              'div',
              { className: 'crc-timeline' },
              ordered.map((round, index) => h(RoundItem, { key: round.round, round, latest: index === 0 })),
            ),
      )
    }

    function CheckRow(props) {
      const Icon = props.ok ? CheckIcon : MinusIcon
      return h(
        'div',
        { className: 'crc-check-row' },
        h('span', { className: props.ok ? 'crc-check-yes' : 'crc-check-no' }, h(Icon)),
        h('span', { className: 'crc-check-label' }, props.label),
        h('span', { className: props.ok ? 'crc-check-yes' : 'crc-check-no' }, props.ok ? '已有' : '未建'),
      )
    }

    function Aside(props) {
      const active = props.active
      const data = props.data || {}
      const gate = active?.gate || { state: 'unknown', reason: '还没有审核记录' }
      const gateMeta = meta(GATE_META, gate.state)
      const tasks = Array.isArray(data.tasks) ? data.tasks : []
      const activeName = active?.task?.name || ''
      const next = active?.nextAction || null
      const totalCost = Number(active?.totalCostUsd) || 0
      const totalKnown = active?.totalCostKnown !== false
      const totalText = totalCost > 0 ? `${totalKnown ? '' : '≥ '}${money(totalCost)}` : (totalKnown ? '$0.00' : '成本 —')
      const taskRow = (task) => {
        const isActive = task.name === activeName
        const taskGate = meta(GATE_META, task.gate?.state)
        return h(
          'li',
          { className: 'crc-task', key: task.name },
          h(
            'button',
            {
              type: 'button',
              className: cx('crc-task-btn', isActive && 'crc-task-active'),
              'aria-current': isActive ? 'true' : 'false',
              title: task.title || task.name,
              onClick: () => {
                if (props.onSelectTask) props.onSelectTask(task.name)
              },
            },
            h('span', { className: 'crc-task-title' }, task.title || task.name),
            h(Pill, { tone: taskGate[1], title: `门禁 ${taskGate[0]}` }, taskGate[0]),
            task.pending > 0 ? h('span', { className: 'crc-task-pending' }, `${task.pending} 待修`) : null,
            task.lastRound ? h('span', { className: 'crc-task-round' }, `#${task.lastRound}`) : null,
          ),
        )
      }

      return h(
        'aside',
        { className: 'crc-aside' },
        h(
          'div',
          { className: 'crc-side-card' },
          next
            ? h(
                'section',
                { className: 'crc-side-section crc-next' },
                h('h2', null, '下一步'),
                h(
                  'div',
                  { className: 'crc-next-row' },
                  h('span', { className: `crc-dot crc-dot-${next.tone || 'idle'}` }),
                  h('strong', { className: 'crc-next-label' }, next.label || '继续'),
                ),
                next.detail ? h('p', { className: 'crc-note' }, next.detail) : null,
              )
            : null,
          h(
            'section',
            { className: 'crc-side-section' },
            h(
              'div',
              { className: 'crc-gate-head' },
              h('h2', null, '门禁'),
              h(Pill, { tone: gateMeta[1] }, gateMeta[0]),
            ),
            h('p', { className: 'crc-gate-reason' }, gate.reason || '还没有审核记录'),
          ),
          data.storage === 'trellis'
            ? h(
                'section',
                { className: 'crc-side-section' },
                h('h2', null, 'Trellis 进度'),
                h(
                  'div',
                  { className: 'crc-check-list' },
                  h(CheckRow, { label: 'prd.md', ok: active?.artifacts?.prd }),
                  h(CheckRow, { label: 'design.md', ok: active?.artifacts?.design }),
                  h(CheckRow, { label: 'implement.md', ok: active?.artifacts?.implement }),
                ),
                h(
                  'div',
                  { className: 'crc-manifests' },
                  h('span', null, 'check.jsonl ', h('b', null, active?.manifests?.check ?? 0)),
                  h('span', null, 'implement.jsonl ', h('b', null, active?.manifests?.implement ?? 0)),
                  h('span', null, '累计 ', h('b', null, totalText)),
                ),
              )
            : h(
                'section',
                { className: 'crc-side-section' },
                h('h2', null, '本地账本'),
                h('p', { className: 'crc-note' }, '存储：', h('span', { className: 'crc-code' }, '.dsh/claude-review/ledger')),
                h(
                  'div',
                  { className: 'crc-manifests' },
                  h('span', null, '轮次 ', h('b', null, (active?.rounds || []).length)),
                  h('span', null, '累计 ', h('b', null, totalText)),
                ),
                h('p', { className: 'crc-note' }, '没有 .trellis，不依赖 Trellis；上下文来自 Description 与实际改动。'),
              ),
          h(
            'section',
            { className: 'crc-side-section' },
            h('h2', null, '项目任务'),
            tasks.length === 0
              ? h('p', { className: 'crc-note' }, '还没有任务。')
              : h('ul', { className: 'crc-task-list' }, tasks.map(taskRow)),
          ),
        ),
      )
    }

    function StateShell(props) {
      return h(
        'div',
        { className: 'crc-root' },
        h(
          'header',
          { className: 'crc-head' },
          h(
            'div',
            { className: 'crc-head-inner' },
            h(
              'div',
              { className: 'crc-head-main' },
              h('h1', { className: 'crc-title' }, '协同审核'),
              h('div', { className: 'crc-meta' }, h('span', { className: 'crc-meta-readonly' }, '只读面板')),
            ),
          ),
        ),
        h(
          'div',
          { className: 'crc-body' },
          h(
            'div',
            { className: 'crc-state' },
            h(
              'div',
              { className: 'crc-state-inner' },
              h('div', { className: 'crc-state-icon' }, h(AlertIcon)),
              h('h2', null, props.title),
              h('p', null, props.body),
              props.onRetry
                ? h(
                    'button',
                    { type: 'button', className: 'crc-btn', onClick: props.onRetry, disabled: props.loading },
                    props.loading ? '重试中' : '重试',
                  )
                : null,
            ),
          ),
        ),
      )
    }

    function SkeletonShell() {
      return h(
        'div',
        { className: 'crc-root' },
        h(
          'header',
          { className: 'crc-head' },
          h(
            'div',
            { className: 'crc-head-inner' },
            h(
              'div',
              { className: 'crc-head-main' },
              h('div', { className: 'crc-skel crc-skel-line', style: { width: '220px' } }),
              h('div', { className: 'crc-skel crc-skel-line', style: { width: '320px' } }),
            ),
          ),
        ),
        h(
          'div',
          { className: 'crc-body' },
          h(
            'div',
            { className: 'crc-skeleton' },
            h('div', { className: 'crc-skel crc-skel-rail' }),
            h(
              'div',
              { className: 'crc-skel-grid' },
              h(
                'div',
                null,
                h('div', { className: 'crc-skel crc-skel-line', style: { width: '40%' } }),
                h('div', { className: 'crc-skel crc-skel-card' }),
              ),
              h('div', null, h('div', { className: 'crc-skel crc-skel-card' })),
            ),
          ),
        ),
      )
    }

    function usePanel(sessionId, task) {
      const [state, setState] = React.useState({
        loading: sessionId !== '',
        data: null,
        error: sessionId === '' ? 'missing-session' : '',
        at: 0,
      })
      const sequence = React.useRef(0)

      const load = React.useCallback(async () => {
        if (!sessionId) {
          setState({ loading: false, data: null, error: 'missing-session', at: Date.now() })
          return
        }
        const requestId = ++sequence.current
        setState((previous) => ({ ...previous, loading: true }))
        try {
          const params = new URLSearchParams({ sessionId })
          if (task) params.set('task', task)
          const response = await fetch(`/claude-review/api/panel?${params.toString()}`, {
            headers: { accept: 'application/json' },
          })
          const payload = await response.json()
          if (requestId !== sequence.current) return
          setState({
            loading: false,
            data: payload,
            error: payload?.ok === false ? String(payload.error || 'unknown') : '',
            at: Date.now(),
          })
        } catch (error) {
          if (requestId !== sequence.current) return
          setState((previous) => ({
            ...previous,
            loading: false,
            error: String((error && error.message) || error),
          }))
        }
      }, [sessionId, task])

      React.useEffect(() => {
        let alive = true
        const run = () => {
          if (alive) load()
        }
        run()
        const timer = setInterval(() => {
          if (!document.hidden) run()
        }, 8000)
        const onVisibility = () => {
          if (!document.hidden) run()
        }
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
          alive = false
          clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [load])

      return { ...state, reload: load }
    }

    function CollabView(props) {
      const sessionId = props && props.sessionId ? String(props.sessionId) : ''
      const [selectedTask, setSelectedTask] = React.useState('')
      const { loading, data, error, at, reload } = usePanel(sessionId, selectedTask)

      if (!sessionId) {
        return h(StateShell, {
          title: '缺少会话标识',
          body: '从会话内打开这个面板。',
          onRetry: reload,
          loading,
        })
      }
      if (error === 'session-not-resolved') {
        return h(StateShell, {
          title: '无法解析当前会话的项目',
          body: '面板只显示会话自己项目的数据。确认这个会话在一个项目目录里打开，然后重试。',
          onRetry: reload,
          loading,
        })
      }
      if (error === 'trellis-not-initialized') {
        return h(StateShell, {
          title: 'Trellis 未初始化',
          body: '当前配置是 storage=trellis，但这个项目没有 .trellis。改用 local/auto，或先初始化 Trellis。',
          onRetry: reload,
          loading,
        })
      }
      if (error === 'cwd-not-found') {
        return h(StateShell, {
          title: '项目目录不存在',
          body: '当前会话的工作目录不存在或已移动。回到一个存在的项目里再打开面板。',
          onRetry: reload,
          loading,
        })
      }
      if (error && !data) {
        return h(StateShell, {
          title: '读取失败',
          body: String(error),
          onRetry: reload,
          loading,
        })
      }
      if (!data) return h(SkeletonShell)

      const active = data.active || null
      const rounds = Array.isArray(active?.rounds) ? active.rounds : []
      const latest = rounds.length ? [...rounds].sort((a, b) => b.round - a.round)[0] : null
      const run = active?.run || null
      const runClass = run ? (run.stale ? 'stale' : run.status) : ''
      const runTitle = run
        ? run.status === 'failed'
          ? '上次审核失败'
          : run.stale
            ? '上次审核中断'
            : '审核进行中'
        : ''
      const runDetail = run
        ? run.status === 'failed'
          ? run.error
          : run.stale
            ? '心跳已停止，可能进程崩溃或被取消。'
            : `已 ${elapsedLabel(run.elapsedSec)}`
        : ''

      return h(
        'div',
        { className: 'crc-root' },
        h(Header, { data, active, sessionId, loading, onRefresh: reload }),
        h(
          'div',
          { className: 'crc-body' },
          h(
            'div',
            { className: 'crc-content' },
            error && data
              ? h(
                  'div',
                  { className: 'crc-inline-error' },
                  h('span', null, `刷新失败：${error}`),
                  h('button', { type: 'button', className: 'crc-btn', onClick: reload }, '重试'),
                )
              : null,
            run
              ? h(
                  'div',
                  { className: `crc-run crc-run-${runClass}`, role: 'status' },
                  h('span', { className: 'crc-run-dot', 'aria-hidden': 'true' }),
                  h('strong', null, runTitle),
                  runDetail ? h('span', { className: 'crc-run-detail' }, runDetail) : null,
                )
              : null,
            h(StatusRail, { active, rounds, latest, totalCostUsd: active?.totalCostUsd || 0, totalCostKnown: active?.totalCostKnown !== false }),
            h(
              'div',
              { className: 'crc-grid' },
              h(Timeline, { active, rounds }),
              h(Aside, { active, data, onSelectTask: setSelectedTask }),
            ),
            h(
              'p',
              { className: 'crc-foot' },
              `只读面板，每 8 秒自动刷新。${at ? `更新于 ${timeOf(at)}` : ''}`,
            ),
          ),
        ),
      )
    }

    return {
      // `styles` is a module-level builtin, not a cordis service: putting it in
      // inject makes the plugin fail activation (unknown service) and takes the
      // whole view down. CSS is injected directly by this module instead.
      inject: ['slots'],
      apply(ctx) {
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
