/**
 * 协同 panel — Client half.
 *
 * Registers a third Conversation view ("协同") beside 对话 / 轨迹. All data is
 * fetched from this package's Host half (`/claude-review/api/panel`), which reads
 * the project's `.trellis/` tree. Nothing here reads the filesystem or mutates
 * session state; the view is strictly read-only.
 */
window.__ModuleLoader__.load({
  id: '@hunyed15/claude-code-review',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PLUGIN_ID = '@hunyed15/claude-code-review'
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
.crc-board { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:8px; margin-top:10px; }
.crc-board-col { min-width:0; border:1px solid var(--crc-border); border-radius:8px; background:var(--crc-surface-2); padding:8px; }
.crc-board-head { display:flex; align-items:center; justify-content:space-between; gap:6px; margin-bottom:6px; color:var(--crc-muted); font-size:11px; }
.crc-board-head b { color:var(--crc-text); font-weight:600; }
.crc-board-list { list-style:none; margin:0; padding:0; }
.crc-board .crc-issue + .crc-issue { border-top:1px solid var(--crc-border); }
.crc-board .crc-issue-head { padding:7px 0; }
.crc-board .crc-issue-text { flex-basis:100%; }
.crc-board-empty { color:var(--crc-muted); font-size:11px; padding:4px 0; }
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
  .crc-board { grid-template-columns:repeat(2,minmax(0,1fr)); }
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
  .crc-board { grid-template-columns:minmax(0,1fr); }
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
    const ISSUE_STATUS_META = {
      open: ['待处理', 'bad'],
      fixed: ['待复检', 'warn'],
      verified: ['已验证', 'ok'],
      reopened: ['复现', 'bad'],
      deferred: ['已暂缓', 'idle'],
      'counter-evidence': ['已反证', 'warn'],
    }
    const ROUND_STATUS_META = {
      open: ['待处置', 'bad'],
      fixing: ['处置中', 'warn'],
      'ready-for-verification': ['待复检', 'warn'],
      verified: ['已关闭', 'ok'],
      reopened: ['复现', 'bad'],
      'closed-with-risk': ['带风险关闭', 'idle'],
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
      const mustFix = latest ? Number(latest.openBlocking) || 0 : null
      const fixedPending = latest ? Number(latest.fixedBlocking) || 0 : 0
      const verifiedCount = latest ? Number(latest.verifiedBlocking) || 0 : 0
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
          label: '待处置问题',
          value: mustFix === null ? '—' : String(mustFix),
          sub: latest ? `待复检 ${fixedPending} · 已验证 ${verifiedCount}` : '暂无待处置',
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
      const statusMeta = meta(ISSUE_STATUS_META, issue.status)
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
          h(Pill, { tone: statusMeta[1], title: `问题状态 ${statusMeta[0]}` }, statusMeta[0]),
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
      const roundStatusMeta = meta(ROUND_STATUS_META, round.status)
      const counts = round.counts || {}
      const issues = Array.isArray(round.issues) ? round.issues : []
      const board = [
        { key: 'open', label: '待处理' },
        { key: 'fixed', label: '待复检' },
        { key: 'verified', label: '已验证' },
        { key: 'reopened', label: '复现' },
        { key: 'deferred', label: '暂缓/反证' },
      ]
      const boardGroups = new Map(board.map((column) => [column.key, []]))
      for (const issue of issues) {
        const key = issue.status === 'counter-evidence' ? 'deferred' : issue.status
        const group = boardGroups.get(key) || boardGroups.get('open')
        group.push(issue)
      }
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
            h(Pill, { tone: roundStatusMeta[1], title: `本轮状态 ${roundStatusMeta[0]}` }, roundStatusMeta[0]),
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
                      'div',
                      { className: 'crc-board' },
                      board.map((column) =>
                        h(
                          'div',
                          { className: 'crc-board-col', key: column.key },
                          h(
                            'div',
                            { className: 'crc-board-head' },
                            h('b', null, column.label),
                            h('span', null, boardGroups.get(column.key).length),
                          ),
                          boardGroups.get(column.key).length > 0
                            ? h(
                                'ul',
                                { className: 'crc-board-list' },
                                boardGroups.get(column.key).map((issue) =>
                                  h(IssueItem, { key: issue.key || `${round.round}-${issue.index}`, issue }),
                                ),
                              )
                            : h('span', { className: 'crc-board-empty' }, '无'),
                        ),
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
            task.roundStatus
              ? h(
                  Pill,
                  { tone: meta(ROUND_STATUS_META, task.roundStatus)[1], title: '本轮状态' },
                  meta(ROUND_STATUS_META, task.roundStatus)[0],
                )
              : null,
            task.pending > 0 ? h('span', { className: 'crc-task-pending' }, `${task.pending} 待处置`) : null,
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
                next.key === 'fix'
                  ? h(
                      'p',
                      { className: 'crc-note' },
                      '处置用 ',
                      h('span', { className: 'crc-code' }, 'claude_review_disposition'),
                      ' 标记 fixed/deferred/counter-evidence。',
                    )
                  : null,
                next.key === 'review'
                  ? h('p', { className: 'crc-note' }, '复检本轮修复：用 claude_review 重跑同一模式；仍存在会标为复现。')
                  : null,
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


    // ===== 项目驾驶舱（原 @hunyed15/project-cockpit，已并入本包） =====
    // 用 IIFE 隔离内部命名（CSS / PANEL_ID / 各种辅助函数），避免与协同面板撞名。
    const PC = (() => {

    // 左栏入口 id 与中央面板 key 必须严格同名，否则 selectPanel 会抛错。
    // 单一常量，测试断言二者同源。
    const PANEL_ID = 'project-cockpit'
    const API = '/project-cockpit/api'
    const SENT_KEY = 'project-cockpit:last-sent'
    const LAST_PROJECT_KEY = 'project-cockpit:last-project'
    const POLL_MS = 8000
    const REQUEST_TIMEOUT_MS = 10000

    const STATE_TEXT = { done: '已完成', current: '当前', pending: '未开始' }
    const TASK_STATUS = { in_progress: '进行中', completed: '已完成', planning: '未开始', unknown: '未知' }
    const VERDICT = { fix: '有需修复项', pass: '通过', fail: '未通过', 'gate-blocked': '门禁未过' }
    const SEVERITY_TEXT = { critical: '严重', important: '重要', minor: '次要' }
    // 第一版里这两道门恒为 pending：说"卡在"会让人以为是自己没做完，
    // 实际是功能还没接入。
    const LATER_GATES = new Set(['验效果', '发出去'])

    // 面板是 root scope，拿不到 session，也没有任何公开的「向会话注入用户消息」API
    // （Host 侧 commands.execute 只跑斜杠命令、不会把文本发给模型）。
    // 所以行动层走已验证的路径：面板把指令放进这个模块级槽位 → 跳到对话 →
    // 由 conversation.input.dock 上的常驻条用 inputActions.setDraft/submit 真正发出去。
    const pending = { value: null, listeners: new Set() }
    const setPending = (value) => {
      pending.value = value
      for (const listener of pending.listeners) listener()
    }
    const usePending = () => {
      const [value, setValue] = React.useState(pending.value)
      React.useEffect(() => {
        const listener = () => setValue(pending.value)
        pending.listeners.add(listener)
        return () => pending.listeners.delete(listener)
      }, [])
      return value
    }

    // apply 里注入的 layout 服务；面板按钮用它跳回对话。
    let layout = null

    // 发送痕迹：只在本地记「什么时候点过发送」，不伪造账本状态。
    // 用可订阅的模块级 store，否则 markSent 只写 localStorage，
    // 同一次挂载内界面永远显示不出「上次发送」。
    const readSent = () => {
      try {
        return JSON.parse(window.localStorage.getItem(SENT_KEY) || '{}') || {}
      } catch {
        return {}
      }
    }
    const sentStore = { value: readSent(), listeners: new Set() }
    const markSent = (kind) => {
      if (!kind) return
      try {
        const all = { ...sentStore.value, [kind]: new Date().toISOString() }
        window.localStorage.setItem(SENT_KEY, JSON.stringify(all))
        sentStore.value = all
        for (const listener of sentStore.listeners) listener()
      } catch {
        // 隐私模式/配额满：痕迹功能失效，但不影响发送
      }
    }
    const useSent = () => {
      const [value, setValue] = React.useState(sentStore.value)
      React.useEffect(() => {
        const listener = () => setValue(sentStore.value)
        sentStore.listeners.add(listener)
        return () => sentStore.listeners.delete(listener)
      }, [])
      return value
    }
    const formatTime = (value) => {
      const date = value instanceof Date ? value : new Date(value)
      if (Number.isNaN(date.getTime())) return ''
      // 固定 24 小时制：否则部分 locale 会出 "10:41:03 PM"，宽度和别处对不上
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    }
    const formatRelative = (value) => {
      const date = value instanceof Date ? value : new Date(value)
      if (Number.isNaN(date.getTime())) return ''
      const diff = Date.now() - date.getTime()
      if (diff < 60_000) return '刚刚'
      if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
      const now = new Date()
      const sameDay = date.toDateString() === now.toDateString()
      return sameDay
        ? formatTime(date).slice(0, 5)
        : `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${formatTime(date).slice(0, 5)}`
    }
    const samePath = (left, right) => {
      const norm = (value) => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
      return norm(left) !== '' && norm(left) === norm(right)
    }

    // 记住上次看的项目：多项目用户每天打开都要重新选，是每天都在付的成本。
    const readLastProject = () => {
      try {
        return window.localStorage.getItem(LAST_PROJECT_KEY) || ''
      } catch {
        return ''
      }
    }
    const saveLastProject = (path) => {
      if (!path) return
      try {
        window.localStorage.setItem(LAST_PROJECT_KEY, path)
      } catch {
        // 隐私模式：记住失败不影响使用
      }
    }

    // 指令里混着中英文标识符（claude_review(mode:"gate")）。不区分字体会让人读串行、
    // 抄错命令，所以把反引号段渲染成等宽。
    function renderInstruction(text) {
      const parts = String(text ?? '').split('`')
      return parts.map((part, index) =>
        index % 2 === 1 ? h('code', { key: index, className: 'pc-code' }, part) : part,
      )
    }

    // 后端错误码对用户没有意义；翻成人话，原文留在 title 里供排查。
    const ERROR_TEXT = {
      'workspace-not-allowed': '这个工作区不在已登记列表里。在另一个项目目录里打开会话后回到这里，或点重试。',
      'no-workspace': '还没有登记任何工作区，先在某个目录里打开一个会话。',
      'method-not-allowed': '请求方式不被支持。',
    }
    function explainError(raw) {
      const message = String(raw ?? '')
      for (const [code, text] of Object.entries(ERROR_TEXT)) {
        if (message.includes(code)) return text
      }
      if (/请求超时/.test(message)) return '请求超时，检查 DSH 是否还在运行。'
      if (/不是 JSON/.test(message)) return message
      if (/Failed to fetch|NetworkError/i.test(message)) return '连接不上 DSH，确认它还在运行。'
      return message
    }

    const CSS = `
.pc-root { height:100%; overflow:auto; color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-base);
  font-family:ui-sans-serif,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; font-size:13px; line-height:1.55; }
.pc-sr { position:absolute; width:1px; height:1px; margin:-1px; padding:0; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; border:0; }
.pc-head { position:sticky; top:0; z-index:2; background:var(--dsw-alias-bg-base); border-bottom:1px solid var(--dsw-alias-border-l1); }
.pc-head-inner { max-width:1120px; margin:0 auto; padding:14px 24px; display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
/* flex 子项默认 min-width:auto，长标识符会把整页顶宽；这里逐项放开收缩 */
.pc-head-inner > *, .pc-dock > *, .pc-action-row > * { min-width:0; }
.pc-body { max-width:1120px; margin:0 auto; padding:16px 24px 32px; display:flex; flex-direction:column; gap:12px; }
h1.pc-name { margin:0; font-size:16px; font-weight:600; overflow-wrap:anywhere; }
.pc-muted { color:var(--dsw-alias-label-secondary); }
.pc-chip { border:1px solid currentColor; border-radius:6px; padding:1px 8px; font-size:12px; font-weight:600; white-space:nowrap; }
.pc-chip-bad { color:var(--dsw-alias-state-error-primary); }
.pc-chip-ok { color:var(--dsw-alias-state-success-primary); }
.pc-chip-unknown { color:var(--dsw-alias-label-secondary); border-style:dashed; }
.pc-time { font-variant-numeric:tabular-nums; }
.pc-banner-stack { flex-direction:column; align-items:stretch; gap:4px; }
.pc-banner-list { margin:0; padding-left:20px; display:flex; flex-direction:column; gap:2px; }
.pc-meta { font-size:11px; margin-top:10px; }
.pc-spacer { flex:1 1 auto; }
.pc-banner { max-width:1120px; margin:12px auto 0; padding:8px 14px; border-radius:8px; display:flex; gap:12px;
  align-items:flex-start; justify-content:space-between; flex-wrap:wrap; font-size:12px;
  border:1px solid var(--dsw-alias-state-warn-primary); color:var(--dsw-alias-state-warn-primary); }
/* 必须在 .pc-banner 之后、且用双类提高权重：同权重时后面的 .pc-banner 会把
   margin:auto 盖回来，在 column flex 里让页内横幅缩成居中窄条。 */
.pc-banner.pc-banner-inline { margin:0; max-width:none; align-self:stretch; }
.pc-banner.pc-banner-error { border-color:var(--dsw-alias-state-error-primary);
  color:var(--dsw-alias-state-error-primary); }
.pc-card { border:1px solid var(--dsw-alias-border-l1); border-radius:10px; background:var(--dsw-alias-bg-layer-1); padding:14px 16px; }
h2.pc-card-title { margin:0 0 10px; font-size:12px; font-weight:600; color:var(--dsw-alias-label-secondary);
  padding-left:8px; border-left:2px solid var(--dsw-alias-border-l2); line-height:1.4; }
.pc-action-label { font-size:16px; font-weight:600; color:var(--dsw-alias-brand-primary); }
.pc-action-text { margin:6px 0 4px; white-space:pre-wrap; overflow-wrap:anywhere; }
.pc-action-text code, .pc-code { font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;
  font-size:12px; background:var(--dsw-alias-bg-layer-2); border-radius:4px; padding:1px 4px;
  overflow-wrap:anywhere; word-break:break-word; }
/* 中文舒适行长约 40 字；1120px 容器下 13px 会有 80 字/行，扫读两次才读完 */
.pc-action-text, .pc-gate-summary, .pc-gate-basis, .pc-dock-main > div { max-width:min(46em, 100%); }
.pc-action-row { display:flex; gap:8px; align-items:center; margin-top:10px; flex-wrap:wrap; }
.pc-issues { margin:10px 0 0; padding-left:18px; display:flex; flex-direction:column; gap:5px; }
.pc-issue-title { overflow-wrap:anywhere; }
.pc-issue-meta { font-size:11px; color:var(--dsw-alias-label-secondary);
  font-family:ui-monospace,SFMono-Regular,Consolas,monospace; margin-left:6px; }
.pc-issue-sev-critical { color:var(--dsw-alias-state-error-primary); font-weight:600; }
.pc-issue-sev-important { color:var(--dsw-alias-state-warn-primary); font-weight:600; }
.pc-blocked-hint { color:var(--dsw-alias-state-warn-primary); margin-top:8px; }
.pc-gate-summary { font-size:14px; font-weight:600; margin-bottom:10px; }
.pc-progress { display:flex; gap:4px; margin:0 0 8px; }
.pc-seg { flex:1 1 0; height:6px; border-radius:999px; background:var(--dsw-alias-border-l1); }
/* 第二版才接入的门：虚线表示"还没轮到"，与"没做"的实心浅灰区分 */
.pc-seg-later { background:transparent; border:1px dashed var(--dsw-alias-border-l2); box-sizing:border-box; }
/* 数据不可信时的"当前阶段"：虚线 + 警告色，表示这个位置本身没把握 */
.pc-seg-unknown { background:transparent; border:1px dashed var(--dsw-alias-state-warn-primary); box-sizing:border-box; }
.pc-seg-done { background:var(--dsw-alias-state-success-primary); }
.pc-seg-current { background:var(--dsw-alias-state-warn-primary); }
.pc-gate-list { display:flex; flex-direction:column; gap:6px; margin:8px 0 0; padding:0; list-style:none; }
/* 作者样式 display:flex 会盖掉 [hidden] 的 UA display:none，必须显式处理 */
.pc-gate-list[hidden] { display:none; }
.pc-gate { display:flex; gap:8px; align-items:baseline; flex-wrap:wrap; padding:6px 8px; border-radius:6px; }
.pc-gate-current { background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent); }
.pc-gate-name { font-weight:600; }
.pc-gate-state { font-size:11px; color:var(--dsw-alias-label-secondary); }
.pc-gate-basis { font-size:12px; color:var(--dsw-alias-label-secondary); line-height:1.45; }
.pc-table-wrap { overflow-x:auto; }
.pc-table { width:100%; border-collapse:collapse; }
.pc-table caption { text-align:left; }
.pc-table th { text-align:left; font-weight:600; font-size:12px; color:var(--dsw-alias-label-secondary);
  padding:6px 8px; border-bottom:1px solid var(--dsw-alias-border-l1); white-space:nowrap; }
.pc-table td { padding:8px; border-bottom:1px solid var(--dsw-alias-border-l1); }
/* 首列现在是 th scope="row"：保留单元格外观，但带上行表头语义 */
.pc-table th.pc-row-head { text-align:left; font-weight:400; font-size:13px; color:inherit;
  padding:8px; border-bottom:1px solid var(--dsw-alias-border-l1); overflow-wrap:anywhere; }
.pc-table th:first-child, .pc-table td:first-child { width:100%; overflow-wrap:anywhere; }
/* 首列现在是 th，用 td + td 会漏掉 th 后面那个单元格（"进行中"会被挤成竖排） */
.pc-table tr > *:not(:first-child) { white-space:nowrap; }
.pc-bad { color:var(--dsw-alias-state-error-primary); font-weight:600; }
.pc-ok { color:var(--dsw-alias-state-success-primary); }
.pc-btn { border:1px solid var(--dsw-alias-border-l2); background:transparent; color:var(--dsw-alias-label-primary);
  border-radius:6px; padding:5px 12px; cursor:pointer; font-size:12px; font-family:inherit; }
.pc-btn:hover:not(:disabled) { border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-brand-primary); }
.pc-btn:disabled { opacity:.55; cursor:default; }
.pc-btn-primary { background:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary);
  color:var(--dsw-alias-bg-base); font-weight:600; }
.pc-btn-primary:hover:not(:disabled) { color:var(--dsw-alias-bg-base); filter:brightness(1.06); }
.pc-btn-link { border:0; background:transparent; color:var(--dsw-alias-brand-primary); cursor:pointer;
  font-size:12px; padding:2px 4px; font-family:inherit; }
.pc-btn:focus-visible, .pc-btn-link:focus-visible, .pc-select:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; }
.pc-select { border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-2); color:inherit;
  border-radius:6px; padding:4px 8px; font-size:12px; font-family:inherit; max-width:100%; flex:0 1 auto; }
.pc-dock { max-width:1120px; margin:0 auto 8px; border:1px solid var(--dsw-alias-border-l2); border-radius:10px;
  background:var(--dsw-alias-bg-layer-1); padding:10px 14px; display:flex; align-items:flex-start; gap:12px; flex-wrap:wrap; }
.pc-dock-main { flex:1 1 320px; min-width:0; }
.pc-dock-label { font-weight:600; color:var(--dsw-alias-brand-primary); }
.pc-dock-actions { display:flex; gap:8px; flex-wrap:wrap; }
.pc-dock-hint { flex:0 0 100%; font-size:11px; margin-top:4px; }
/* 全局提醒：shell.overlay 里的条目默认不接管点击，这里自己开 */
.pc-toast { position:fixed; right:16px; bottom:16px; z-index:60; pointer-events:auto;
  display:flex; align-items:center; gap:8px; max-width:min(420px, calc(100vw - 32px));
  padding:10px 14px; border-radius:10px; font-size:12px;
  background:var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1));
  border:1px solid var(--dsw-alias-state-warn-primary); color:var(--dsw-alias-label-primary);
  box-shadow:0 6px 24px rgba(0,0,0,.18); }
@media (max-width:640px) {
  .pc-head-inner, .pc-body { padding-left:14px; padding-right:14px; }
}
/* 窄窗口下先收掉次要列，别让用户以为表格被截断了 */
@media (max-width:560px) {
  .pc-col-secondary { display:none; }
}
`

    // CSS 必须全局注入一次：面板、通栏、提醒是三个独立挂载点，
    // 只在 Page 里渲染 <style> 会让"没打开过面板"的用户看到无样式的裸文本。
    const STYLE_ID = 'claude-code-review-pc-style'
    function ensureStyles() {
      if (typeof document === 'undefined' || !document || !document.head) return
      if (document.getElementById(STYLE_ID)) return
      const el = document.createElement('style')
      el.id = STYLE_ID
      el.textContent = CSS
      document.head.appendChild(el)
    }

    function Icon(props) {
      const size = props && props.size ? props.size : 16
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('rect', { x: 1.5, y: 2.5, width: 13, height: 11, rx: 2, stroke: 'currentColor', strokeWidth: 1.2 }),
        h('path', { d: 'M1.5 6.5h13', stroke: 'currentColor', strokeWidth: 1.2 }),
        h('path', { d: 'M5 9.5h3', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
      )
    }

    async function getJson(url) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null
      try {
        const response = await fetch(url, {
          credentials: 'same-origin',
          ...(controller ? { signal: controller.signal } : {}),
        })
        const text = await response.text()
        let body = null
        try {
          body = text === '' ? null : JSON.parse(text)
        } catch {
          body = null
        }
        if (!response.ok) throw new Error((body && body.error) || `HTTP ${response.status}`)
        // 200 + 非 JSON（登录页拦截、代理改写）必须报错，否则界面会永远停在"加载中"。
        if (body === null) throw new Error('响应不是 JSON，可能被登录页或代理拦截')
        return body
      } catch (error) {
        if (error && error.name === 'AbortError') throw new Error('请求超时')
        throw error
      } finally {
        if (timer) clearTimeout(timer)
      }
    }

    function useCockpit() {
      const [workspaces, setWorkspaces] = React.useState([])
      const [selected, setSelected] = React.useState('')
      const [model, setModel] = React.useState(null)
      const [error, setError] = React.useState('')
      const [loading, setLoading] = React.useState(true)
      const [goodAt, setGoodAt] = React.useState(null)
      const [empty, setEmpty] = React.useState(false)
      const seq = React.useRef(0)
      // 记「哪一次请求在飞」，而不是布尔：旧请求被判废时不能把新请求的占用清掉。
      const inflight = React.useRef(0)

      // 序号守卫：轮询与手动刷新并发时，旧响应不许覆盖新响应。
      // 另外跳过"已有请求在飞"的静默轮询，避免 8s 轮询周期 < 10s 超时时叠请求。
      const loadPanel = React.useCallback(async (path, silent) => {
        if (silent && inflight.current !== 0) return
        const mine = ++seq.current
        inflight.current = mine
        if (!silent) setLoading(true)
        try {
          const next = await getJson(`${API}/panel${path ? `?path=${encodeURIComponent(path)}` : ''}`)
          if (mine !== seq.current) return
          setModel(next)
          setError('')
          setEmpty(false)
          setGoodAt(Date.now())
        } catch (failure) {
          if (mine !== seq.current) return
          setError(String(failure && failure.message ? failure.message : failure))
        } finally {
          if (inflight.current === mine) inflight.current = 0
          if (mine === seq.current) setLoading(false)
        }
      }, [])

      // 拉工作区列表。以前只跑一次且失败后 selected 恒为空，
      // 于是错误横幅里的「重试」按了没反应 —— 必须能重跑。
      const loadWorkspaces = React.useCallback(async (alive) => {
        try {
          const list = await getJson(`${API}/workspaces`)
          if (alive && !alive()) return
          const items = Array.isArray(list) ? list : []
          setWorkspaces(items)
          setSelected((prev) => {
            if (prev) return prev
            // 上次看的项目还在列表里就回到它，否则退回第一个
            const remembered = readLastProject()
            const hit = items.find((item) => samePath(item.path, remembered))
            return hit ? hit.path : items[0] ? items[0].path : ''
          })
          if (items.length === 0) {
            // 空态不是故障：不该走 error 通道，也不该给一个必然失败的重试。
            setEmpty(true)
            setLoading(false)
          } else {
            setError('')
          }
        } catch (failure) {
          if (alive && !alive()) return
          setError(String(failure && failure.message ? failure.message : failure))
          setLoading(false)
        }
      }, [])

      React.useEffect(() => {
        let mounted = true
        loadWorkspaces(() => mounted)
        return () => {
          mounted = false
        }
      }, [loadWorkspaces])

      // 面板与轮询只跟随选中的项目。
      React.useEffect(() => {
        if (!selected) return undefined
        let alive = true
        loadPanel(selected, false)
        const timer = setInterval(() => {
          if (alive) loadPanel(selected, true)
        }, POLL_MS)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [selected, loadPanel])

      const refresh = React.useCallback(() => {
        if (selected) loadPanel(selected, false)
        else loadWorkspaces()
      }, [loadPanel, loadWorkspaces, selected])

      return { workspaces, selected, setSelected, model, error, loading, goodAt, empty, refresh }
    }

    // 复制摘要：给站会/周报用。只从当前模型生成，不额外读盘。
    function summaryMarkdown(model) {
      const lines = [`## ${model.project.name}`, '']
      const blocking = (model.totals && model.totals.blocking) || 0
      const done = model.gates.filter((gate) => gate.state === 'done').length
      const current = model.gates.find((gate) => gate.state === 'current') || null
      const issues = (model.totals && model.totals.issues) || []
      lines.push(`- 未处置阻塞：${blocking}`)
      lines.push(`- 阶段门：${done}/7${current ? `，当前「${current.name}」` : '，全部完成'}`)
      lines.push(`- 下一步：${model.nextAction.label}`)
      lines.push(`- 指令：\`${model.nextAction.instruction}\``)
      if (issues.length > 0) {
        lines.push('- 待修：')
        for (const issue of issues) {
          const where = issue.file ? `（${issue.file}${issue.line ? `:${issue.line}` : ''}）` : ''
          lines.push(`  - [${SEVERITY_TEXT[issue.severity] || issue.severity}] ${issue.title}${where}`)
        }
      }
      if (model.warnings && model.warnings.length > 0) lines.push(`- 数据异常：${model.warnings.length} 处（数字可能偏低）`)
      lines.push('', `_更新于 ${formatTime(model.generatedAt)}_`)
      return lines.join('\n')
    }

    /**
     * 全局提醒：新会话/刷新后，若上一轮还有未处置阻塞，在 shell.overlay 浮一条。
     * 同一项目每小时最多提醒一次，避免变成噪音。
     */
    function BlockingToast() {
      const [state, setState] = React.useState(null)
      React.useEffect(() => {
        ensureStyles()
      }, [])
      React.useEffect(() => {
        let alive = true
        getJson(`${API}/panel`)
          .then((model) => {
            if (!alive) return
            const blocking = (model?.totals?.blocking) || 0
            if (blocking <= 0) return
            const key = `project-cockpit:toast:${(model.project && model.project.path) || ''}`
            let last = 0
            try {
              last = Number(window.localStorage.getItem(key) || 0)
            } catch {
              last = 0
            }
            if (Date.now() - last < 3600_000) return
            try {
              window.localStorage.setItem(key, String(Date.now()))
            } catch {
              // 隐私模式：不记忆，最多重复提醒
            }
            setState({ blocking, name: (model.project && model.project.name) || '' })
          })
          .catch(() => {})
        return () => {
          alive = false
        }
      }, [])
      if (!state) return null
      return h(
        'div',
        { className: 'pc-toast', role: 'status' },
        h('span', null, `${state.name ? `${state.name}：` : ''}还有 ${state.blocking} 条未处置阻塞`),
        h(
          'button',
          {
            className: 'pc-btn pc-btn-primary',
            onClick: () => {
              setState(null)
              if (layout && typeof layout.selectPanel === 'function') layout.selectPanel(PANEL_ID)
            },
          },
          '去看',
        ),
        h('button', { className: 'pc-btn', onClick: () => setState(null), 'aria-label': '关闭提醒' }, '×'),
      )
    }

    function GateList(props) {
      const gates = props.gates
      return h(
        'ol',
        {
          className: 'pc-gate-list',
          id: 'pc-gate-details',
          // 折叠时用 hidden 而不是卸载：否则 aria-controls 指向不存在的元素。
          hidden: props.hidden ? true : undefined,
          // list-style:none 会让部分读屏丢掉列表语义，显式补回来。
          role: 'list',
        },
        gates.map((gate) =>
          h(
            'li',
            {
              key: gate.name,
              className: `pc-gate pc-gate-${gate.state}`,
              'aria-current': gate.state === 'current' ? 'step' : undefined,
            },
            h('span', { className: 'pc-gate-name' }, gate.name),
            h(
              'span',
              { className: 'pc-gate-state' },
              props.degraded && gate.state === 'current' ? '待确认' : STATE_TEXT[gate.state] || gate.state,
            ),
            h('span', { className: 'pc-gate-basis' }, gate.basis),
          ),
        ),
      )
    }

    function TaskRow(props) {
      const task = props.task
      const bugs = task.bugs || {}
      const blocking = bugs.blocking
      const verdict = bugs.lastVerdict ? VERDICT[bugs.lastVerdict] || bugs.lastVerdict : ''
      // 数据不可信时不要显示绿色 0：那等于替统计结果背书。
      if (props.degraded) {
        return h(
          'tr',
          null,
          h('th', { scope: 'row', className: 'pc-row-head' }, task.title || task.id),
          h('td', null, TASK_STATUS[task.status] || task.status),
          h('td', { className: 'pc-col-secondary' }, task.priority || '—'),
          h('td', { className: 'pc-muted' }, '—'),
          h('td', { className: 'pc-col-secondary' }, bugs.lastRound == null ? '—' : `#${bugs.lastRound}`),
        )
      }
      return h(
        'tr',
        null,
        h('td', null, task.title || task.id),
        h('td', null, TASK_STATUS[task.status] || task.status),
        h('td', { className: 'pc-col-secondary' }, task.priority || '—'),
        // 读不到就当"未统计"（—），不能显示成绿色的 0：
        // "账本里没问题"和"根本没读到账本"是两件事。
        blocking == null
          ? h('td', { className: 'pc-muted' }, '—')
          : h('td', { className: blocking > 0 ? 'pc-bad' : 'pc-ok' }, String(blocking)),
        h(
          'td',
          { className: 'pc-col-secondary' },
          bugs.lastRound == null ? '—' : `#${bugs.lastRound}${verdict ? ` ${verdict}` : ''}`,
        ),
      )
    }

    /**
     * 对话输入框上方的常驻条：只有面板点过「去对话发送」才出现。
     * 这里才拿得到 inputActions（session scope），面板拿不到。
     */
    function NextActionDock(props) {
      const value = usePending()
      const boxRef = React.useRef(null)
      React.useEffect(() => {
        ensureStyles()
      }, [])
      // 从面板跳过来时焦点会落在 body；这里主动接管，读屏才知道多了这条通栏。
      React.useEffect(() => {
        if (value && boxRef.current && typeof boxRef.current.focus === 'function') {
          boxRef.current.focus()
        }
      }, [value])
      if (!value) return null
      const actions = props.inputActions
      const fill = () => {
        if (actions) actions.setDraft(value.instruction)
        setPending(null)
      }
      const send = () => {
        if (!actions) return
        actions.setDraft(value.instruction)
        actions.submit()
        markSent(value.kind)
        setPending(null)
      }
      // 项目名进标题：多项目时"这条指令属于谁"必须一眼可见。
      const where = value.projectName || value.projectPath || ''
      return h(
        'div',
        {
          className: 'pc-dock',
          ref: boxRef,
          tabIndex: -1,
          // live region 里不要包按钮：部分读屏会把整段连按钮一起播报或漏掉按钮。
          role: 'region',
          'aria-label': `项目驾驶舱下一步${where ? `（${where}）` : ''}`,
        },
        h(
          'div',
          { className: 'pc-dock-main', role: 'status' },
          h('div', { className: 'pc-dock-label' }, `项目驾驶舱 · ${where ? `${where} · ` : ''}${value.label}`),
          h('div', { className: 'pc-action-text' }, renderInstruction(value.instruction)),
          h('div', { className: 'pc-muted' }, value.reason),
        ),
        h(
          'div',
          { className: 'pc-dock-actions' },
          // 「填入输入框」是主按钮：先让人看见、自己按回车，比直接覆盖草稿并发送安全。
          h('button', { className: 'pc-btn pc-btn-primary', onClick: fill }, '填入输入框'),
          h('button', { className: 'pc-btn', onClick: send }, '发送'),
          h('button', { className: 'pc-btn', onClick: () => setPending(null) }, '忽略'),
        ),
        h('div', { className: 'pc-muted pc-dock-hint' }, '两个按钮都会替换输入框里已有的内容。'),
      )
    }

    function Page() {
      const { workspaces, selected, setSelected, model, error, loading, goodAt, empty, refresh } =
        useCockpit()
      const [gatesOpen, setGatesOpen] = React.useState(false)
      const [copyState, setCopyState] = React.useState('idle')
      const [summaryState, setSummaryState] = React.useState('idle')
      const copyTimer = React.useRef(null)
      const summaryTimer = React.useRef(null)
      const sent = useSent()

      React.useEffect(
        () => () => {
          clearTimeout(copyTimer.current)
          clearTimeout(summaryTimer.current)
        },
        [],
      )

      // 换项目就丢掉上一条待发送指令：否则可能把 A 项目的指令发到 B 项目。
      React.useEffect(() => {
        setPending(null)
        saveLastProject(selected)
      }, [selected])

      const copyText = (text, setState, timer) => {
        const write = navigator.clipboard && navigator.clipboard.writeText
        // 失败态也要能回去，否则按钮会永久停在"复制失败"
        const fail = () => {
          setState('fail')
          clearTimeout(timer.current)
          timer.current = setTimeout(() => setState('idle'), 4000)
        }
        if (!write) {
          fail()
          return
        }
        write.call(navigator.clipboard, text).then(() => {
          setState('done')
          clearTimeout(timer.current)
          timer.current = setTimeout(() => setState('idle'), 1600)
        }, fail)
      }

      const copyInstruction = () => {
        if (model) copyText(action.instruction, setCopyState, copyTimer)
      }

      const copySummary = () => {
        if (model) copyText(summaryMarkdown(model), setSummaryState, summaryTimer)
      }

      const sendToAgent = () => {
        if (!model) return
        setPending({
          ...action,
          projectPath: model.project ? model.project.path : '',
          projectName: model.project ? model.project.name : '',
        })
        if (layout && typeof layout.selectPanel === 'function') layout.selectPanel('conversation')
      }

      // 面板、通栏、提醒三个挂载点各自保证样式在，幂等
      React.useEffect(() => {
        ensureStyles()
      }, [])
      const style = null
      const totals = model && model.totals ? model.totals : null
      const blocking = totals ? totals.blocking : 0
      // 服务端少字段时不要落到 ErrorBoundary 白板：逐项兜底，页面还能显示"数据不完整"。
      const gates = model && Array.isArray(model.gates) ? model.gates : []
      const trellis = (model && model.trellis) || { initialized: false, version: null, specFiles: 0 }
      const action =
        (model && model.nextAction) || {
          kind: 'unknown',
          label: '暂无建议',
          instruction: '',
          reason: '服务端没有返回下一步，可能是插件版本不匹配。',
        }
      const current = gates.find((gate) => gate.state === 'current') || null
      const lastSent = action.kind ? sent[action.kind] : null
      const taskCount = totals && Number.isInteger(totals.taskCount) ? totals.taskCount : (model ? model.tasks.length : 0)
      const issueList =
        !error && totals && totals.blocking > 0 && Array.isArray(totals.issues) ? totals.issues : []

      // 数据不完整时不能给绿色结论：warnings 说"数字可能偏低"、error 说"这是旧数据"，
      // 而 chip 却显示"无阻塞"，就是首屏自相矛盾。
      const degraded = Boolean(error) || (model && model.warnings && model.warnings.length > 0)
      const chipClass = degraded
        ? 'pc-chip pc-chip-unknown'
        : blocking > 0
          ? 'pc-chip pc-chip-bad'
          : 'pc-chip pc-chip-ok'
      const chipText = degraded
        ? '状态待确认'
        : blocking > 0
          ? `待修 ${blocking}`
          : '无待修问题'

      // "验效果/发出去"第一版恒 pending：那是功能没接入，不是用户卡住了。
      // 数据不可信时阶段门也不可信：账本异常会让 rounds/blocking 偏低，
      // "卡在挑毛病"可能只是没读到 —— 不能当结论说。
      const gateSummary = degraded
        ? `阶段门待确认：数据有 ${(model && model.warnings && model.warnings.length) || 0} 处异常，先修数据再判断走到哪一步`
        : !current
          ? '七道门全部完成'
          : LATER_GATES.has(current.name)
            ? `下一阶段：${current.name}（第二版接入，当前不影响）`
            : `卡在「${current.name}」：${current.basis}`

      // 切换项目的瞬间，下拉已经是新项目、数据还是旧的：标题跟下拉走，
      // 并用一条横幅说明"下面是上一个项目的数据"，不让人误读。
      const selectedWorkspace = workspaces.find((item) => samePath(item.path, selected))
      const selectedTitle = selectedWorkspace
        ? selectedWorkspace.title || selectedWorkspace.path
        : selected
      const stale =
        Boolean(model && model.project) && selected !== '' && !samePath(model.project.path, selected)
      const pageTitle = stale
        ? selectedTitle
        : model && model.project
          ? model.project.name
          : selectedTitle || '项目'

      const header = h(
        'header',
        { className: 'pc-head' },
        h(
          'div',
          { className: 'pc-head-inner' },
          h('h1', { className: 'pc-name' }, pageTitle),
          model ? h('span', { className: chipClass, role: 'status' }, chipText) : null,
          workspaces.length > 1
            ? h(
                'select',
                {
                  className: 'pc-select',
                  value: selected,
                  'aria-label': '项目工作区',
                  onChange: (event) => setSelected(event.target.value),
                },
                workspaces.map((item) => h('option', { key: item.path, value: item.path }, item.title || item.path)),
              )
            : null,
          h('span', { className: 'pc-spacer' }),
          // 时间戳不挂 aria-live：generatedAt 每 8 秒都变，会把读屏变成节拍器。
          model && model.generatedAt
            ? h('span', { className: 'pc-muted pc-time' }, `更新于 ${formatTime(model.generatedAt)}`)
            : null,
          loading ? h('span', { className: 'pc-sr', role: 'status' }, '正在刷新') : null,
          h(
            'button',
            { className: 'pc-btn', onClick: refresh, disabled: loading, 'aria-busy': loading ? 'true' : 'false' },
            '刷新',
          ),
        ),
      )

      // 错误不换掉整页：有旧数据时降级为横幅，并明确标出数据时间。
      // 用 alert 而不是 status：这是"当前这一屏不能当真"的强提示。
      const banner = error
        ? h(
            'div',
            { className: 'pc-banner pc-banner-error', role: 'alert' },
            h(
              'span',
              { title: error },
              model && goodAt
                ? `刷新失败，下面是 ${formatTime(goodAt)} 的数据：${explainError(error)}`
                : `读取面板失败：${explainError(error)}`,
            ),
            h('button', { className: 'pc-btn', onClick: refresh, disabled: loading }, '重试'),
          )
        : null

      let cards = null
      if (model) {
        cards = h(
          React.Fragment,
          null,
          stale
            ? h(
                'section',
                { className: 'pc-banner pc-banner-inline', role: 'status' },
                h('span', null, `正在切换到「${selectedTitle}」…下面是上一个项目的数据。`),
              )
            : null,
          model.warnings && model.warnings.length > 0
            ? h(
                'section',
                { className: 'pc-banner pc-banner-inline pc-banner-stack', role: 'status' },
                h('div', null, `数据有 ${model.warnings.length} 处异常，下面的数字可能偏低：`),
                h(
                  'ul',
                  { className: 'pc-banner-list' },
                  model.warnings.slice(0, 3).map((line, index) => h('li', { key: index }, line)),
                  model.warnings.length > 3
                    ? h('li', { key: 'more', className: 'pc-muted' }, `还有 ${model.warnings.length - 3} 处未显示`)
                    : null,
                ),
              )
            : null,
          model.truncated
            ? h(
                'section',
                { className: 'pc-banner pc-banner-inline', role: 'status' },
                h(
                  'span',
                  null,
                  `任务过多，只显示前 ${model.taskLimit || model.tasks.length} 个；卡点数与阶段门仍按全部任务计算。`,
                ),
              )
            : null,
          h(
            'section',
            { className: 'pc-card' },
            h('h2', { className: 'pc-card-title' }, degraded ? '下一步（待数据确认）' : '下一步'),
            // 降级时不能给"你可以提交"的结论和可点主按钮 ——
            // 那是把"我读不到"翻译成"你没问题"。
            h('div', { className: 'pc-action-label' }, degraded ? '先确认数据' : action.label),
            h('div', { className: 'pc-action-text' }, renderInstruction(action.instruction)),
            h(
              'div',
              { className: 'pc-muted pc-action-text' },
              degraded ? '（结论基于不完整账本，仅供排查，不要据此提交）' : issueList.length > 0 ? null : action.reason,
            ),
            issueList.length > 0
              ? h(
                  'ol',
                  { className: 'pc-issues' },
                  issueList.map((issue, index) =>
                    h(
                      'li',
                      { key: issue.key || `i${index}` },
                      h('span', { className: `pc-issue-sev-${issue.severity}` }, SEVERITY_TEXT[issue.severity] || issue.severity),
                      ' ',
                      h('span', { className: 'pc-issue-title' }, issue.title),
                      issue.file
                        ? h(
                            'span',
                            { className: 'pc-issue-meta' },
                            `${issue.file}${issue.line ? `:${issue.line}` : ''}`,
                          )
                        : null,
                    ),
                  ),
                )
              : null,
            degraded
              ? h(
                  'div',
                  { className: 'pc-blocked-hint' },
                  `数据有 ${(model.warnings && model.warnings.length) || 0} 处异常，先处理上面的提示再行动。`,
                )
              : null,
            lastSent
              ? h(
                  'div',
                  { className: 'pc-muted', title: new Date(lastSent).toLocaleString() },
                  `上次发送 ${formatRelative(lastSent)}`,
                )
              : null,
            h(
              'div',
              { className: 'pc-action-row' },
              h(
                'button',
                { className: 'pc-btn pc-btn-primary', onClick: sendToAgent, disabled: degraded },
                '去对话发送',
              ),
              h(
                'button',
                { className: 'pc-btn', onClick: copyInstruction },
                copyState === 'done' ? '已复制' : copyState === 'fail' ? '复制失败，请手动选择' : '复制指令',
              ),
              h(
                'button',
                { className: 'pc-btn', onClick: copySummary },
                summaryState === 'done'
                  ? '已复制摘要'
                  : summaryState === 'fail'
                    ? '复制失败，请手动选择'
                    : '复制摘要',
              ),
            ),
          ),
          h(
            'section',
            { className: 'pc-card' },
            h('h2', { className: 'pc-card-title' }, '阶段门（推断，非声明）'),
            h('div', { className: 'pc-gate-summary' }, gateSummary),
            h(
              'div',
              { className: 'pc-progress', 'aria-hidden': 'true' },
              gates.map((gate) =>
                h('span', {
                  key: gate.name,
                  // "第二版才接入"的门在视觉上要区别于"还没做"
                  className: `pc-seg pc-seg-${degraded && gate.state === 'current' ? 'unknown' : LATER_GATES.has(gate.name) && gate.state !== 'done' ? 'later' : gate.state}`,
                  title: LATER_GATES.has(gate.name) ? `${gate.name}：第二版接入` : gate.name,
                }),
              ),
            ),
            h(
              'button',
              {
                className: 'pc-btn-link',
                onClick: () => setGatesOpen((open) => !open),
                'aria-expanded': gatesOpen ? 'true' : 'false',
                'aria-controls': 'pc-gate-details',
              },
              gatesOpen ? '收起七道门的依据' : '展开七道门的依据',
            ),
            h(GateList, { gates, hidden: !gatesOpen, degraded }),
            // 环境元数据放到可见位置：塞进 h2 的 title 里只有鼠标悬停能拿到。
            h(
              'div',
              { className: 'pc-muted pc-meta' },
              `trellis ${trellis.version || '未知'} · spec ${trellis.specFiles} 个文件 · ${taskCount} 个任务`,
            ),
          ),
          h(
            'section',
            { className: 'pc-card' },
            h('h2', { className: 'pc-card-title' }, '任务'),
            // 窄屏时让表格自己横向滚动，而不是把整页（连同 sticky 头）拖走
            h(
              'div',
              { className: 'pc-table-wrap' },
              h(
                'table',
                { className: 'pc-table' },
                h('caption', { className: 'pc-sr' }, '项目任务与审核状态'),
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    h('th', { scope: 'col' }, '任务'),
                    h('th', { scope: 'col' }, '状态'),
                    h('th', { scope: 'col', className: 'pc-col-secondary' }, '优先级'),
                    h('th', { scope: 'col' }, '待修'),
                    h('th', { scope: 'col', className: 'pc-col-secondary' }, '最近轮次'),
                  ),
                ),
                h(
                  'tbody',
                  null,
                  model.tasks.length === 0
                    ? h('tr', null, h('td', { colSpan: 5, className: 'pc-muted' }, '还没有任务'))
                    : model.tasks.map((task) => h(TaskRow, { key: task.id, task, degraded })),
                ),
              ),
            ),
          ),
        )
      }

      return h(
        React.Fragment,
        null,
        style,
        h(
          'div',
          { className: 'pc-root' },
          header,
          banner,
          h(
            'main',
            { className: 'pc-body', 'aria-busy': loading ? 'true' : 'false' },
            empty
              ? h(
                  'div',
                  { className: 'pc-card' },
                  h('h2', { className: 'pc-card-title' }, '还没有项目'),
                  h('div', null, '在任意目录里打开一个会话后，这里会自动出现该项目。'),
                )
              : null,
            loading && !model && !empty
              ? h('div', { className: 'pc-card pc-muted', role: 'status' }, '加载中…')
              : null,
            cards,
          ),
        ),
      )
    }

    // 渲染期异常（比如服务端字段缺失）不能让面板白屏：兜住并给一句可读的原因。
    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error }
      }
      render() {
        if (this.state.error) {
          const message = String(this.state.error && this.state.error.message ? this.state.error.message : this.state.error)
          return h(
            'div',
            { className: 'pc-root' },
            h(
              'div',
              { className: 'pc-banner', role: 'alert' },
              h('span', null, `面板渲染失败：${message}`),
              h('button', { className: 'pc-btn', onClick: () => this.setState({ error: null }) }, '重试'),
            ),
          )
        }
        return this.props.children
      }
    }

    function PanelRoot() {
      return h(Boundary, null, h(Page))
    }

      return {
        PanelRoot,
        Icon,
        Dock: NextActionDock,
        Toast: BlockingToast,
        PanelId: PANEL_ID,
        setLayout: (value) => {
          layout = value
        },
      }
    })()

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
        // 项目驾驶舱：注册失败只影响它自己，不连累协同面板与 claude_review 工具。
        try {
          // layout 是可选能力：不写进 inject，免得某个 profile 缺它就整块不激活。
          let layoutService = null
          try {
            layoutService = typeof ctx.get === 'function' ? ctx.get('layout') : null
          } catch {
            layoutService = null
          }
          PC.setLayout(layoutService || null)
          ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PC.PanelId }, PC.PanelRoot))
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              { name: 'sidebar.panellist', id: PC.PanelId, order: 20, label: () => '项目' },
              PC.Icon,
            ),
          )
          ctx.slots.inject('conversation.input.dock', () =>
            ctx.slots.register(
              { name: 'conversation.input.dock', id: 'project-cockpit-next', order: 30, label: () => '项目下一步' },
              PC.Dock,
            ),
          )
          // 未处置阻塞的全局提醒（同一项目每小时最多一次），复用 shell.overlay。
          ctx.slots.inject('shell.overlay', () =>
            ctx.slots.register(
              { name: 'shell.overlay', id: 'project-cockpit-blocking-toast' },
              PC.Toast,
            ),
          )
        } catch (error) {
          console.warn('[claude-code-review] 项目面板注册失败（不影响协同面板）：', error)
        }
      },
    }
  },
})
