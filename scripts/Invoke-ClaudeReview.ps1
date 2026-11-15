# claude-review-api: 3
<#
.SYNOPSIS
    DSH × Claude Code 审核回环（Trellis 集成版）。

.DESCRIPTION
    把「本轮实现」交给本地 Claude Code CLI 做独立只读审核，结论回到 DSH。
    与 D:\Scripts\claude-review.ps1（claude-code-review 技能）保持同一契约：
    同样的 verdict 词表（pass/fix/reject）、同样的 severity（critical/important/minor）、
    同样的退出码（0/1/2）。差别在于：

      1. 用 git 树对象快照算「增量」，支持每轮小步审核，而不是始终审整棵工作区；
      2. 从 Trellis 活跃任务取上下文，报告落进 .trellis/tasks/<task>/review/，随任务归档；
      3. 提供 -Mode gate，供 Phase 3.4 提交前做纯本地门禁校验（不调模型）。

    审核员只读：只挂 Read/Grep/Glob，不开放 Bash，禁 Write/Edit，权限提示一律拒绝。

.PARAMETER Mode
    incremental（默认）| full | gate | range
      incremental : 自上次审核快照以来的改动
      full        : 相对 HEAD（或 -Base）的全部未提交改动
      gate        : 只读本地 state/history，判断「收尾全量审核是否已 pass」，不调模型
      range       : 评审已提交区间 Base..Head；不再需要 soft reset

.PARAMETER Cwd
    仓库目录，默认当前目录。

.PARAMETER TaskDir
    Trellis 任务目录。显式传入最优先；留空时用 DSH_SESSION_ID + task.py current 解析。
    没有当前任务就 exit 2，不再按 review/history 或 in_progress 猜任务。

.PARAMETER Base
    diff 基线 revision（例如 HEAD~1）；range 模式必填。

.PARAMETER Head
    range 模式的终点 revision，默认 HEAD。

.PARAMETER Profile
    quick（low effort + 40k diff）/ deep（high effort + 200k diff）；显式 Effort/MaxDiffChars 优先。

.PARAMETER Paths
    限定审核范围的 git pathspec（可多个）。留空表示整个仓库。

.PARAMETER Description
    本轮做了什么，直接影响审核质量。留空时用任务标题 + 模式。

.PARAMETER Requirements
    验收要求 / 计划文件。留空时自动指向任务 prd.md / design.md / implement.md。

.PARAMETER Checks
    本轮已执行的客观检查（例如 "cargo test 12/12 通过"）。

.PARAMETER Focus
    额外侧重，例如 "重点看前后端契约一致性"。

.PARAMETER OutDir
    报告目录，默认 <task>/review。

.PARAMETER MaxDiffChars
    内联进 prompt 的 diff 上限，超出部分写 patch 文件，默认取 config.json（200000）。
    截断的 full pass 不能过 gate；会写 truncated 标记。

.PARAMETER TimeoutSec
    单次审核超时，默认取 config.json（当前 1500 秒；网关波动大，别调太小）。

.PARAMETER DryRun
    只组装 prompt 与 dry-run 摘要，不调用模型、不推进快照。

.PARAMETER Json
    以 JSON 输出摘要（便于脚本消费）。

.EXAMPLE
    pwsh -NoProfile -File tools/claude-review/Invoke-ClaudeReview.ps1 -Mode incremental -Description "实现知识库条目删除" -Checks "cargo test kb 5/5 通过"

.EXAMPLE
    pwsh -NoProfile -File tools/claude-review/Invoke-ClaudeReview.ps1 -Mode full

.EXAMPLE
    pwsh -NoProfile -File tools/claude-review/Invoke-ClaudeReview.ps1 -Mode gate

.EXAMPLE
    pwsh -NoProfile -File tools/claude-review/Invoke-ClaudeReview.ps1 -Mode range -Base HEAD~2 -Head HEAD

.EXAMPLE
    pwsh -NoProfile -File scripts/Invoke-ClaudeReview.ps1 -Capabilities
#>
[CmdletBinding()]
param(
    [ValidateSet('incremental', 'full', 'gate', 'range')]
    [string]$Mode = 'incremental',
    [string]$Cwd = '',
    [ValidateSet('auto', 'trellis', 'local')]
    [string]$Storage = 'auto',
    [string]$TaskDir = '',
    [ValidateSet('', 'auto', 'acp', 'cli')]
    [string]$Transport = '',
    [string]$NodeExe = '',
    [switch]$NodeRunAsNode,
    [string]$AcpAdapter = '',
    [string]$Base = '',
    [string]$Head = '',
    [ValidateSet('', 'quick', 'deep')]
    [string]$Profile = '',
    [string[]]$Paths = @(),
    [string]$Description = '',
    [string]$Requirements = '',
    [string[]]$Checks = @(),
    [string]$Focus = '',
    [string]$Model = '',
    [string]$Effort = '',
    [string]$SessionId = '',
    [string]$SessionName = '',
    [string]$OutDir = '',
    [int]$MaxDiffChars = 0,
    [int]$TimeoutSec = 0,
    [switch]$DryRun,
    [switch]$Json,
    [switch]$Capabilities,
    [switch]$NoStrictScope,
    [switch]$Help
)

$ErrorActionPreference = 'Continue'
$PSNativeCommandUseErrorActionPreference = $false

# 被无控制台的父进程拉起时（DSH 插件 / Start-Process 重定向），PowerShell 会按系统代码页（cp936）
# 写 stdout，父进程按 UTF-8 解码就成了乱码。这里把控制台输出钉成 UTF-8。
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }

function Write-Info([string]$m) { if (-not $Json) { [Console]::Out.WriteLine("claude-review: $m") } }
$script:runStatePath = ''
function Fail([string]$m, [int]$code = 2) {
    if ($script:runStatePath) {
        try {
            $failed = [ordered]@{ status = 'failed'; phase = 'failed'; error = $m; updatedAt = (Get-Date).ToString('s') }
            [IO.File]::WriteAllText($script:runStatePath, ($failed | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
        } catch { }
    }
    if ($Json) {
        [Console]::Out.WriteLine((@{ ok = $false; error = $m; exitCode = $code } | ConvertTo-Json -Compress))
    } else {
        [Console]::Error.WriteLine("claude-review: $m")
    }
    exit $code
}

if ($Help) {
    Get-Help $MyInvocation.MyCommand.Path -Detailed | Out-String | Write-Output
    exit 0
}

# 能力握手：插件先读文件头的 claude-review-api 标记；这里同时提供可执行探测。
# 必须在任何路径/配置/账本检查之前返回，保证旧仓库里的引擎不会因为 Cwd 不存在而误判。
if ($Capabilities) {
    [Console]::Out.WriteLine(([ordered]@{
                api           = 3
                name          = 'claude-code-review'
                storage       = @('auto', 'trellis', 'local')
                base          = $true
                range         = $true
                truncatedGate = $true
                profiles      = @('quick', 'deep')
                transport     = @('auto', 'acp', 'cli')
            } | ConvertTo-Json -Compress))
    exit 0
}

# ---------------------------------------------------------------- 0. 路径与配置
$scriptRoot = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($Cwd)) { $Cwd = (Get-Location).Path }
if (-not (Test-Path -LiteralPath $Cwd)) { Fail "目录不存在：$Cwd" }
$Cwd = (Resolve-Path -LiteralPath $Cwd).Path

$inside = (& git -C $Cwd rev-parse --is-inside-work-tree 2>$null)
if ($LASTEXITCODE -ne 0 -or "$inside".Trim() -ne 'true') { Fail "$Cwd 不是 git 仓库" }
$root = (& git -C $Cwd rev-parse --show-toplevel 2>$null)
if (-not $root) { Fail "无法解析仓库根目录" }
$root = $root.Trim()

$configPath = Join-Path $scriptRoot 'config.json'
$cfg = @{
    claudeExe        = ''
    model            = ''
    effort           = 'low'
    timeoutSec       = 600
    maxDiffChars     = 200000
    maxRounds        = 3
    failOn           = @('critical', 'important')
    allowTruncatedGate = $false
    strictScope      = $true
    transport        = 'auto'
    reviewerRoleFile = '.trellis/agents/review.md'
    snapshotExcludePathspecs = @(':(exclude).trellis/tasks/*/review/**', ':(exclude).dsh/claude-review/ledger/**')
    excludePathspecs = @(':(exclude).trellis/tasks/*/review/**', ':(exclude).dsh/claude-review/ledger/**')
}
if (Test-Path -LiteralPath $configPath) {
    try {
        $raw = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
        foreach ($p in $raw.PSObject.Properties) {
            if ($p.Name -eq '$comment') { continue }
            $cfg[$p.Name] = $p.Value
        }
    } catch { Fail "config.json 解析失败：$($_.Exception.Message)" }
}

if ($TimeoutSec -le 0) { $TimeoutSec = [int]$cfg.timeoutSec }
if ($MaxDiffChars -le 0) { $MaxDiffChars = [int]$cfg.maxDiffChars }
if ([string]::IsNullOrWhiteSpace($Model)) { $Model = [string]$cfg.model }
if ([string]::IsNullOrWhiteSpace($Effort)) { $Effort = [string]$cfg.effort }
if ([string]::IsNullOrWhiteSpace($Transport)) { $Transport = if ($cfg.transport) { [string]$cfg.transport } else { 'auto' } }
if ($Transport -notin @('auto', 'acp', 'cli')) { Fail "transport 必须是 auto|acp|cli（当前 '$Transport'）" }
$failOn = @($cfg.failOn)
# 缓存键用「用户原始输入」，不要用后面自动补的、带轮次号的 Description。
$cacheDescription = $Description
$cacheRequirements = $Requirements

# profile 只是两个预设；显式 -Effort / -MaxDiffChars 仍然优先。
if ($Profile -eq 'quick') {
    if (-not $PSBoundParameters.ContainsKey('Effort')) { $Effort = 'low' }
    if (-not $PSBoundParameters.ContainsKey('MaxDiffChars')) { $MaxDiffChars = [Math]::Min($MaxDiffChars, 40000) }
} elseif ($Profile -eq 'deep') {
    if (-not $PSBoundParameters.ContainsKey('Effort')) { $Effort = 'high' }
    if (-not $PSBoundParameters.ContainsKey('MaxDiffChars')) { $MaxDiffChars = [Math]::Max($MaxDiffChars, 200000) }
}

# 存储选择：-Storage 是唯一入口（插件从 cordis.patch.yml 传，直接 CLI 自己传；
# 未传时默认 auto）。不从 config.json 再读一份，避免双源静默路由。
$hasTrellis = Test-Path -LiteralPath (Join-Path $root '.trellis')
if ($Storage -eq 'auto') { $Storage = if ($hasTrellis) { 'trellis' } else { 'local' } }
if ($Storage -eq 'trellis' -and -not $hasTrellis) {
    Fail "storage=trellis 但 $root 下没有 .trellis。先初始化 Trellis，或改用 -Storage local / auto。"
}

# 数组型参数允许两种写法：重复传参（-Checks a -Checks b，仅命令行）或逗号分隔（-Checks "a,b"）
$Checks = @(
    $Checks |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        ForEach-Object { $_ -split ',' } |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_ }
)

# -Paths 允许三种写法：-Paths a,b,c / -Paths a -Paths b / 逗号分隔的单个字符串（pwsh -File 传参时常见）。
$Paths = @(
    $Paths |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        ForEach-Object { $_ -split ',' } |
        ForEach-Object { $_.Trim().Trim("'").Trim('"').Trim() } |
        Where-Object { $_ }
)
foreach ($p in $Paths) {
    $probe = if ([IO.Path]::IsPathRooted($p)) { $p } else { Join-Path $root $p }
    if (-not (Test-Path -LiteralPath $probe)) {
        Write-Info "警告：-Paths 里的 '$p' 在仓库中不存在，git 会静默返回空 diff。"
    }
}

# gate 是对「准备提交的东西」下判断，不能被 -Paths 缩窄：否则窄路径/空路径会让 diff 为空，
# 被误判成「干净工作区」而放行别处未审的改动。gate 始终判定整个工作区。
if ($Mode -eq 'gate' -and $Paths.Count -gt 0) {
    Write-Info '注意：gate 模式忽略 -Paths，始终对整个工作区判定。'
    $Paths = @()
}

# ---------------------------------------------------------------- 1. 审核账本（Trellis / 本地）
function Resolve-TrellisTaskDir([string]$explicit) {
    if (-not [string]::IsNullOrWhiteSpace($explicit)) {
        $p = $explicit
        if (-not [IO.Path]::IsPathRooted($p)) { $p = Join-Path $root $p }
        if (-not (Test-Path -LiteralPath $p)) { Fail "任务目录不存在：$p" }
        return (Resolve-Path -LiteralPath $p).Path
    }

    # 只认「真正的当前任务」，不再按 history 最新 / in_progress 猜。
    # 插件把 DSH session id 传进来；Trellis 的 task.py 通过 DSH_SESSION_ID 解析 session 指针。
    $gitRoot = Push-Location $root
    $oldDshSession = $env:DSH_SESSION_ID
    $oldTrellisContext = $env:TRELLIS_CONTEXT_ID
    if (-not [string]::IsNullOrWhiteSpace($SessionId)) {
        $env:DSH_SESSION_ID = $SessionId
        # 插件传入的 session 必须优先于 Host 进程里可能残留的 TRELLIS_CONTEXT_ID；
        # 否则 task.py 会按外层上下文挑到别的任务。
        Remove-Item Env:TRELLIS_CONTEXT_ID -ErrorAction SilentlyContinue
    }
    try {
        $taskPy = Join-Path $root '.trellis/scripts/task.py'
        if (Test-Path -LiteralPath $taskPy) {
            $out = & python $taskPy current 2>$null
            if ($LASTEXITCODE -eq 0 -and $out) {
                $rel = ''
                $line = @($out) | Where-Object { $_ -match '^Current task:\s*(.+)$' } | Select-Object -First 1
                if ($line -and $line -match '^Current task:\s*(.+)$') {
                    $rel = $Matches[1].Trim()
                } else {
                    # 不带 --source 时 task.py 只输出任务路径本身
                    $first = (@($out) | Where-Object { $_.Trim() } | Select-Object -First 1)
                    if ($first) { $rel = $first.Trim() }
                }
                if ($rel -and $rel -ne '(none)') {
                    $abs = if ([IO.Path]::IsPathRooted($rel)) { $rel } else { Join-Path $root $rel }
                    if (Test-Path -LiteralPath $abs) { return (Resolve-Path -LiteralPath $abs).Path }
                }
            }
        }
    } finally {
        if ($null -eq $oldDshSession) { Remove-Item Env:DSH_SESSION_ID -ErrorAction SilentlyContinue }
        else { $env:DSH_SESSION_ID = $oldDshSession }
        if ($null -eq $oldTrellisContext) { Remove-Item Env:TRELLIS_CONTEXT_ID -ErrorAction SilentlyContinue }
        else { $env:TRELLIS_CONTEXT_ID = $oldTrellisContext }
        Pop-Location
    }

    # 没有会话身份时不要猜：猜错任务会连带用错 diff 基线和写错账本，比失败更糟。
    Fail ("无法确定 Trellis 任务：task.py current 没有返回当前任务（SessionId='$SessionId'）。" +
        "请显式传 -TaskDir <任务目录>，或在 Trellis 会话里先 task.py start <任务>；" +
        "脚本不会按 review/history 的最新修改或 in_progress 状态猜测任务。")
}

function Get-LocalLedgerDir {
    return (Join-Path $root '.dsh/claude-review/ledger')
}

function Initialize-LocalLedger([string]$dir) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    # 账本目录可能没有 .gitignore（目标仓库），在这里自忽略，避免 git add/diff 把审核产物带进快照。
    $ledgerIgnore = Join-Path $dir '.gitignore'
    if (-not (Test-Path -LiteralPath $ledgerIgnore)) {
        [IO.File]::WriteAllText($ledgerIgnore, "*`n", (New-Object Text.UTF8Encoding($false)))
    }
    $taskJson = Join-Path $dir 'task.json'
    if (-not (Test-Path -LiteralPath $taskJson)) {
        $repoName = Split-Path -Leaf $root
        $task = [ordered]@{
            id          = 'local'
            name        = 'local'
            title       = $repoName
            description = 'Local review ledger (no Trellis)'
            status      = 'in_progress'
            priority    = ''
            storage     = 'local'
            createdAt   = (Get-Date).ToString('s')
        }
        [IO.File]::WriteAllText($taskJson, ($task | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($false)))
        Write-Info "本地审核账本：$dir"
    }
}

function Resolve-ReviewStore([string]$storage, [string]$explicit) {
    if (-not [string]::IsNullOrWhiteSpace($explicit)) {
        $p = $explicit
        if (-not [IO.Path]::IsPathRooted($p)) { $p = Join-Path $root $p }
        if (-not (Test-Path -LiteralPath $p)) { Fail "任务目录不存在：$p" }
        return @{ Storage = $storage; TaskDir = (Resolve-Path -LiteralPath $p).Path }
    }
    if ($storage -eq 'trellis') {
        return @{ Storage = 'trellis'; TaskDir = (Resolve-TrellisTaskDir '') }
    }
    $dir = Get-LocalLedgerDir
    Initialize-LocalLedger $dir
    return @{ Storage = 'local'; TaskDir = $dir }
}

$store = Resolve-ReviewStore $Storage $TaskDir
$storageMode = $store.Storage
$taskPath = $store.TaskDir
$taskName = if ($storageMode -eq 'local') { 'local' } else { Split-Path -Leaf $taskPath }
if ([string]::IsNullOrWhiteSpace($OutDir)) { $OutDir = Join-Path $taskPath 'review' }
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$statePath = Join-Path $OutDir 'state.json'
$historyPath = Join-Path $OutDir 'history.jsonl'

$taskTitle = ''
$taskJsonPath = Join-Path $taskPath 'task.json'
if (Test-Path -LiteralPath $taskJsonPath) {
    try { $taskTitle = [string](Get-Content -LiteralPath $taskJsonPath -Raw | ConvertFrom-Json).title } catch { }
}

$state = @{ round = 0; lastSnapshot = ''; lastMode = ''; lastVerdict = ''; lastInputHash = ''; lastReport = ''; updatedAt = '' }
if (Test-Path -LiteralPath $statePath) {
    try {
        $s = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
        foreach ($p in $s.PSObject.Properties) { $state[$p.Name] = $p.Value }
    } catch { }
}

function Add-History($entry) {
    Add-Content -LiteralPath $historyPath -Value ($entry | ConvertTo-Json -Compress) -Encoding utf8
}

function Get-HistoryRows {
    if (-not (Test-Path -LiteralPath $historyPath)) { return @() }
    $rows = @()
    foreach ($l in (Get-Content -LiteralPath $historyPath | Where-Object { $_.Trim() })) {
        try { $rows += ($l | ConvertFrom-Json) } catch { }
    }
    return $rows
}

function Get-RoundGuard([bool]$hadFailing) {
    $maxRounds = [int]$cfg.maxRounds
    $consecutive = if ($hadFailing) { 1 } else { 0 }
    if ($maxRounds -gt 0) {
        $rows = @(Get-HistoryRows)
        for ($k = $rows.Count - 2; $k -ge 0; $k--) {   # 最后一行是本轮，已计入
            $r = $rows[$k]
            if ([string]$r.mode -ne $Mode) { break }
            if ([string]$r.verdict -in @('pass', 'nothing-to-review')) { break }
            $consecutive++
        }
    }
    $escalate = ''
    if ($hadFailing -and $maxRounds -gt 0 -and $consecutive -ge $maxRounds) {
        $escalate = "同一模式已连续 $consecutive 轮未通过（上限 $maxRounds 轮，计数不区分是否为同一缺陷）：建议停止自动循环，把 review-*.md 与仍未解决的问题交给用户决策。"
    }
    return @{ consecutive = $consecutive; escalate = $escalate }
}

function Get-DispositionRows {
    # 处置写入固定落在 <task>/review；不能用 -OutDir 覆盖，否则守卫查不到 disposition。
    $path = Join-Path (Join-Path $taskPath 'review') 'dispositions.jsonl'
    if (-not (Test-Path -LiteralPath $path)) { return @() }
    $rows = @()
    foreach ($line in (Get-Content -LiteralPath $path | Where-Object { $_.Trim() })) {
        try { $rows += ($line | ConvertFrom-Json) } catch { }
    }
    return $rows
}

# 轮次门禁：上一轮还有未处置的 blocking findings，就不允许进入下一轮。
# “处置”是主代理的显式状态更新（fixed / deferred / counter-evidence），下一轮负责复检。
function Assert-FindingsDisposed {
    if ($Mode -eq 'gate') { return }
    $lastReport = [string]$state.lastReport
    if ([string]::IsNullOrWhiteSpace($lastReport)) { return }
    if (-not (Test-Path -LiteralPath $lastReport)) { return }
    $report = $null
    try { $report = Get-Content -LiteralPath $lastReport -Raw | ConvertFrom-Json } catch { return }
    $issues = @($report.review.issues)
    if ($issues.Count -eq 0) { return }

    # 旧报告没有 meta.failOn 时，回退必须与面板 DEFAULT_FAIL_ON 一致；
    # 当前 config.failOn 只解释新报告，不能拿来改写旧报告。
    $reportFailOn = @($report.meta.failOn | Where-Object { $_ })
    if ($reportFailOn.Count -eq 0) { $reportFailOn = @('critical', 'important') }

    $blocking = @()
    for ($i = 0; $i -lt $issues.Count; $i++) {
        if ($null -eq $issues[$i]) { continue }
        $severity = ([string]$issues[$i].severity).Trim().ToLowerInvariant()
        if ($reportFailOn -notcontains $severity) { continue }
        $blocking += [pscustomobject]@{ issue = $issues[$i]; index = $i }
    }
    if ($blocking.Count -eq 0) { return }

    # 轮次号以报告自身为准：nothing-to-review 会递增 state.round，但 lastReport 仍指向上一份报告。
    $roundNo = if ($report.meta -and $report.meta.round) { [int]$report.meta.round } else { 0 }
    if ($roundNo -le 0) { $roundNo = [int]$state.round }
    $dispositions = @(Get-DispositionRows)
    $missing = @()
    foreach ($item in $blocking) {
        $key = [string]$item.issue.key
        $index = [int]$item.index
        $hit = $false
        foreach ($row in $dispositions) {
            if ([string]$row.status -notin @('fixed', 'counter-evidence', 'deferred')) { continue }
            if ([int]$row.round -ne $roundNo) { continue }
            if ($key -ne '' -and [string]$row.key -eq $key) { $hit = $true; break }
            $rowIndex = $row.index
            if ($null -ne $rowIndex -and [string]$rowIndex -ne '' -and [int]$rowIndex -eq $index) { $hit = $true; break }
        }
        if (-not $hit) { $missing += $item }
    }
    if ($missing.Count -eq 0) { return }

    $labels = @($missing | ForEach-Object { "$([string]$_.issue.severity) $([string]$_.issue.file):$([string]$_.issue.line) $([string]$_.issue.key)" }) -join '；'
    Fail "第 $roundNo 轮还有 $($missing.Count) 条未处置的 blocking findings（$labels）。先修复并用 claude_review_disposition 标记 fixed/deferred/counter-evidence，再进入下一轮；本轮未调用模型。"
}

Assert-FindingsDisposed

# ---------------------------------------------------------------- 2. 快照
function Get-WorktreeTree([string]$repoRoot, [string[]]$exclude = @()) {
    # 临时索引放在系统临时目录：放进仓库内会被 git add -A 当成未跟踪文件，导致快照每次都不一致
    $idx = Join-Path ([IO.Path]::GetTempPath()) ("claude-review-index-" + [guid]::NewGuid().ToString('N') + '.tmp')
    $oldIdx = $env:GIT_INDEX_FILE
    try {
        $env:GIT_INDEX_FILE = $idx
        $head = (& git -C $repoRoot rev-parse --verify HEAD 2>$null)
        if ($LASTEXITCODE -eq 0 -and "$head".Trim()) {
            & git -C $repoRoot read-tree HEAD 2>&1 | Out-Null
        } else {
            & git -C $repoRoot read-tree --empty 2>&1 | Out-Null
        }
        if ($LASTEXITCODE -ne 0) { throw 'read-tree 失败' }
        # 快照里排除审核产物等非受审内容：否则「写报告」本身会改变快照，导致 gate 误判「工作区又变了」
        $ex = @($exclude | Where-Object { $_ })
        & git -C $repoRoot add -A -- . 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'git add -A 失败（临时索引）' }
        # 在临时索引里删掉排除路径：对 tracked 的账本/review 文件也生效，且不受 .gitignore 影响。
        $plainExcludes = @($ex | ForEach-Object { $_ -replace '^:\(exclude\)', '' } | Where-Object { $_ })
        if ($plainExcludes.Count -gt 0) {
            & git -C $repoRoot rm --cached -r --ignore-unmatch --quiet -- @plainExcludes 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'git rm --cached 排除审核产物失败' }
        }
        $tree = (& git -C $repoRoot write-tree 2>$null)
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($tree)) { throw 'git write-tree 失败' }
        return $tree.Trim()
    } finally {
        if ($null -eq $oldIdx) { Remove-Item Env:GIT_INDEX_FILE -ErrorAction SilentlyContinue }
        else { $env:GIT_INDEX_FILE = $oldIdx }
        Remove-Item -LiteralPath $idx -Force -ErrorAction SilentlyContinue
    }
}

$snapshotOk = $true
$curTree = ''
$rangeWorktreeTree = ''
$rangeDirty = $false
$rangeHeadMismatch = $false
# 快照只排除「审核产物」：否则写报告本身会改变快照，导致 gate 误判「工作区又变了」。
# 注意不要把这些路径加进快照排除表：.gitignore 已忽略的目录作为 pathspec 传给 git add 会报错。
$snapshotExcludes = @($cfg.snapshotExcludePathspecs | Where-Object { $_ })
if ($snapshotExcludes.Count -eq 0) { $snapshotExcludes = @(':(exclude).trellis/tasks/*/review/**') }
if ($Mode -ne 'range') {
    try { $curTree = Get-WorktreeTree $root $snapshotExcludes } catch {
        $snapshotOk = $false
        Write-Info "快照降级：$($_.Exception.Message)。改用工作区直读。"
    }
} else {
    # range 的 diff 是提交区间；工作区树只用于检测「审核员 Read 到的文件是否与区间一致」。
    try { $rangeWorktreeTree = Get-WorktreeTree $root $snapshotExcludes } catch {
        $rangeDirty = $true
        Write-Info "range 工作区树读取失败：$($_.Exception.Message)。按工作区可能已偏离被审区间处理。"
    }
}

$headSha = (& git -C $root rev-parse --verify HEAD 2>$null)
$headSha = if ($headSha) { "$headSha".Trim() } else { '' }

# ---------------------------------------------------------------- 4. 计算 diff 范围
function Resolve-Revision([string]$ref, [string]$label) {
    $sha = (& git -C $root rev-parse --verify "$ref^{commit}" 2>$null)
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($sha)) { Fail "无法解析 $label：$ref" }
    return "$sha".Trim()
}

# -Head 只对 range 有意义；full/incremental 的 head 是工作区快照。
if (-not [string]::IsNullOrWhiteSpace($Head) -and $Mode -ne 'range') {
    Fail '-Head 只用于 range 模式；full/incremental 的 head 始终是工作区快照。'
}
if ($Mode -eq 'gate') {
    if (-not [string]::IsNullOrWhiteSpace($Base)) { Write-Info 'gate 模式忽略 -Base。' }
    $baseOverride = ''
    $headOverride = ''
} else {
    $baseOverride = if (-not [string]::IsNullOrWhiteSpace($Base)) { Resolve-Revision $Base 'Base' } else { '' }
    $headOverride = if ($Mode -eq 'range' -and -not [string]::IsNullOrWhiteSpace($Head)) { Resolve-Revision $Head 'Head' } else { '' }
}
$baseRev = ''
$baseLabel = ''
$headRev = ''
$headLabel = ''
if ($Mode -eq 'range') {
    if (-not $baseOverride) { Fail 'range 模式必须提供 -Base <rev>（可选 -Head <rev>，默认 HEAD）。' }
    $baseRev = $baseOverride
    $baseLabel = "Base $Base ($($baseRev.Substring(0, [Math]::Min(12, $baseRev.Length))))"
    $headRev = if ($headOverride) { $headOverride } else { $headSha }
    if ([string]::IsNullOrWhiteSpace($headRev)) { Fail 'range 模式没有可解析的 HEAD；请显式传 -Head <rev>。' }
    $headLabel = if ($headOverride) { "Head $Head ($($headRev.Substring(0, [Math]::Min(12, $headRev.Length))))" } else { "HEAD ($($headRev.Substring(0, [Math]::Min(12, $headRev.Length))))" }
    $rangeHeadMismatch = $headRev -ne $headSha
    # 用同一套 excludes 检查工作区是否偏离 HEAD；直接比树会把「HEAD 跟踪了 review 文件」误判成 dirty。
    $statusArgs = @('-C', $root, '-c', 'core.quotePath=false', 'status', '--porcelain', '--untracked-files=all', '--', '.') + @($snapshotExcludes)
    $statusText = (& git @statusArgs 2>$null) -join "`n"
    $rangeDirty = -not [string]::IsNullOrWhiteSpace($statusText)
} elseif ($Mode -eq 'full') {
    $baseRev = if ($baseOverride) { $baseOverride } elseif ($headSha) { $headSha } else { '4b825dc642cb6eb9a060e54bf8d69288fbee4904' }
    $baseLabel = if ($baseOverride) { "Base $Base ($($baseRev.Substring(0, [Math]::Min(12, $baseRev.Length))))" } elseif ($headSha) { "HEAD ($headSha)" } else { '(空树)' }
    $headRev = if ($snapshotOk -and $curTree) { $curTree } else { '' }
    $headLabel = if ($headRev) { "工作区快照 $($headRev.Substring(0, [Math]::Min(12, $headRev.Length)))" } else { '工作区（快照降级）' }
} elseif ($baseOverride) {
    $baseRev = $baseOverride
    $baseLabel = "Base $Base ($($baseRev.Substring(0, [Math]::Min(12, $baseRev.Length))))"
    $headRev = if ($snapshotOk -and $curTree) { $curTree } else { '' }
    $headLabel = if ($headRev) { "工作区快照 $($headRev.Substring(0, [Math]::Min(12, $headRev.Length)))" } else { '工作区（快照降级）' }
} elseif ($state.lastSnapshot) {
    $baseRev = [string]$state.lastSnapshot
    $baseLabel = "上次审核快照 ($($baseRev.Substring(0, [Math]::Min(12, $baseRev.Length))))"
    $headRev = if ($snapshotOk -and $curTree) { $curTree } else { '' }
    $headLabel = if ($headRev) { "工作区快照 $($headRev.Substring(0, [Math]::Min(12, $headRev.Length)))" } else { '工作区（快照降级）' }
} else {
    $baseRev = if ($headSha) { $headSha } else { '4b825dc642cb6eb9a060e54bf8d69288fbee4904' }
    $baseLabel = if ($headSha) { "HEAD ($headSha) [首次审核，范围=全部未提交改动]" } else { '(空树) [首次审核]' }
    $headRev = if ($snapshotOk -and $curTree) { $curTree } else { '' }
    $headLabel = if ($headRev) { "工作区快照 $($headRev.Substring(0, [Math]::Min(12, $headRev.Length)))" } else { '工作区（快照降级）' }
}

$excludes = @($cfg.excludePathspecs | Where-Object { $_ })

function Invoke-GitDiff([string[]]$extraArgs) {
    $a = @('-C', $root, '-c', 'core.quotePath=false', 'diff', '--no-color') + $extraArgs
    if ($headRev) {
        $a += @($baseRev, $headRev)
    } else {
        $a += @($baseRev.Trim())   # 快照失败时尽力而为：base..worktree
    }
    $a += @('--')
    if ($Paths.Count -gt 0) { $a += $Paths }
    $a += $excludes
    if ($env:CLAUDE_REVIEW_DEBUG -eq '1') {
        [Console]::Error.WriteLine("DEBUG paths=[$($Paths -join ' | ')] excludes=$($excludes.Count) args=[$($a -join ' ')]")
    }
    $o = & git @a 2>$null
    $code = $LASTEXITCODE
    if ($env:CLAUDE_REVIEW_DEBUG -eq '1') {
        [Console]::Error.WriteLine("DEBUG git exit=$code stdoutChars=$((($o -join "`n")).Length)")
    }
    if ($code -ne 0) { return '' }
    return ($o -join "`n")
}

$statText = Invoke-GitDiff @('--stat')
$diffText = Invoke-GitDiff @('--unified=3', '--find-renames')

$fileList = @()
$nameOut = Invoke-GitDiff @('--name-only')
if ($nameOut) { $fileList = @($nameOut -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
$fileCount = $fileList.Count
$fileListText = if ($fileCount -gt 0) { ($fileList | ForEach-Object { "- $_" }) -join "`n" } else { '- （无）' }

# ---------------------------------------------------------------- 5. gate 模式（不调模型）
if ($Mode -eq 'gate') {
    $last = $null
    $historyCorrupt = $false
    if (Test-Path -LiteralPath $historyPath) {
        $lines = @(Get-Content -LiteralPath $historyPath | Where-Object { $_.Trim() })
        if ($lines.Count -gt 0) {
            try { $last = $lines[-1] | ConvertFrom-Json } catch { $last = $null }
            # 「有历史但最后一行读不出」不能当成「没有历史」：fail-closed
            if (-not $last) { $historyCorrupt = $true }
        }
    }
    $lastTruncated = ($null -ne $last -and ($last.PSObject.Properties.Name -contains 'truncated') -and [bool]$last.truncated)
    $lastBaseCustom = ($null -ne $last -and ($last.PSObject.Properties.Name -contains 'baseCustom') -and [bool]$last.baseCustom)
    $allowTruncatedGate = [bool]$cfg.allowTruncatedGate

    # 快照降级时 diff 会丢掉未跟踪文件，「有没有待审改动」的判断不可信 ⇒ 先 fail-closed。
    # 这个检查必须早于下面任何放行分支（包括「干净工作区」分支），否则未跟踪改动会漏检。
    if ($historyCorrupt) {
        $msg = 'history.jsonl 最后一行不可解析（可能中断写入/手工改动），无法判定最近一次审核结论，门禁 fail-closed。人工核对后修复或删除该行。'
        if ($Json) { [Console]::Out.WriteLine((@{ ok = $false; gate = 'blocked'; reasons = @($msg); storage = $storageMode } | ConvertTo-Json -Compress)) }
        else {
            Write-Output "gate      : blocked"
            Write-Output "  - $msg"
            Write-Output "下一步    : 检查 $historyPath"
        }
        exit 1
    }

    if ((-not $snapshotOk) -or [string]::IsNullOrWhiteSpace($headRev)) {
        $msg = '快照降级：无法可靠判定是否还有未审改动（未跟踪文件会漏检），门禁 fail-closed。请在 git 索引可写时重跑 -Mode full，或人工确认后再提交。'
        if ($Json) { [Console]::Out.WriteLine((@{ ok = $false; gate = 'blocked'; reasons = @($msg); storage = $storageMode } | ConvertTo-Json -Compress)) }
        else {
            Write-Output "gate      : blocked"
            Write-Output "  - $msg"
            Write-Output "下一步    : 修复 git 索引可写性后重跑 -Mode full"
        }
        exit 1
    }

    # 没有待审改动时**不能无条件放行**：否则「只跑 incremental」或「上次 full 判 fix 后撤掉改动」
    # 都会因干净工作区被放行，绕过「提交前必须有一次 full 且 pass」的门禁语义。
    # 只有在「最近一次就是 full 且 pass」时，干净工作区才算无事可做。
    if ([string]::IsNullOrWhiteSpace($diffText)) {
        # full 审核在干净工作区上会记录 verdict='nothing-to-review'（见下方空 diff 分支），
        # 它同样是「已做过 full 且无待修问题」的终态；若只认 'pass'，无净改动的任务会永久卡死
        # 且提示的下一步（重跑 full）无法自救。incremental 记录、fix、无记录三类仍然阻断。
        # 与脏分支对称：放行必须同时满足 mode=full、verdict∈{pass,nothing-to-review}、
        # 历史未标记 degraded、且快照与当前一致。否则「干净」可能只是「降级审核后把漏审内容 commit 掉」。
        $cleanPass = ($null -ne $last) -and (
            [string]$last.mode -eq 'full' -and
            (@('pass', 'nothing-to-review') -contains [string]$last.verdict) -and
            (-not (($last.PSObject.Properties.Name -contains 'degraded') -and $last.degraded)) -and
            (-not $lastTruncated -or $allowTruncatedGate) -and
            (-not $lastBaseCustom) -and
            ([string]$last.snapshot -eq [string]$headRev)
        )
        if ($cleanPass) {
            # 两种子情形文案要分开：从未审核过 ≠ 已审核且没再改动
            $reasonCode = if (-not $last) { 'nothing-to-review' } else { 'reviewed-snapshot-unchanged' }
            $reasonText = if (-not $last) { '当前没有待审改动，也没有审核历史（无事可做）' } else { '工作区与最近一次通过的 full 审核快照一致（无新增未审改动）' }
            if ($Json) { [Console]::Out.WriteLine((@{ ok = $true; gate = 'pass'; reason = $reasonCode; mode = $Mode; storage = $storageMode } | ConvertTo-Json -Compress)) }
            else {
                Write-Output "gate      : pass"
                Write-Output "reason    : $reasonText"
            }
            exit 0
        }
        # 没有改动但最近一次不是 full+pass：落到下面的 $reasons 检查给出具体原因
    }

    $reasons = @()
    if (-not $last) { $reasons += '工作区是干净的，但没有任何审核记录；干净不等于已审核，请先跑一次 -Mode full 并通过' }
    else {
        if ([string]$last.mode -ne 'full') { $reasons += "最近一次审核是 $($last.mode) 模式，收尾门禁要求 full" }
        if ([string]$last.verdict -ne 'pass') { $reasons += "最近一次审核结论是 $($last.verdict)" }
        if ([string]$last.snapshot -ne [string]$headRev) {
            $reasons += '最近一次审核的快照与当前工作区不一致（含「上次审核在快照降级下运行、未覆盖未跟踪文件」的情况），需要重跑 -Mode full'
        }
        if (($last.PSObject.Properties.Name -contains 'degraded') -and $last.degraded) {
            $reasons += '上次审核在快照降级下运行，未覆盖未跟踪文件，需在索引可写时重跑 -Mode full'
        }
        if ($lastTruncated -and -not $allowTruncatedGate) {
            $reasons += '最近一次审核的 diff 被截断（maxDiffChars），结论不完整；请调大 -MaxDiffChars 后重跑 -Mode full，或显式设置 allowTruncatedGate=true'
        }
        if ($lastBaseCustom) {
            $reasons += '最近一次 full 使用了自定义 -Base，不是收尾门禁的普通 full；请不带 -Base 重跑 -Mode full'
        }
    }
    if ($reasons.Count -eq 0) {
        if ($Json) { [Console]::Out.WriteLine((@{ ok = $true; gate = 'pass'; report = $last.report; storage = $storageMode } | ConvertTo-Json -Compress)) }
        else { Write-Output "gate      : pass"; Write-Output "report    : $($last.report)" }
        exit 0
    }
    if ($Json) { [Console]::Out.WriteLine((@{ ok = $false; gate = 'blocked'; reasons = $reasons; storage = $storageMode } | ConvertTo-Json -Compress)) }
    else {
        Write-Output "gate      : blocked"
        foreach ($r in $reasons) { Write-Output "  - $r" }
        Write-Output "下一步    : 运行 -Mode full 重新审核"
    }
    exit 1
}

if ([string]::IsNullOrWhiteSpace($diffText)) {
    # 用递增的新轮次，避免写出一条与既有第 N 轮同号的记录（面板会按 round 生成卡片，重号=重复 key）
    $cleanRound = [int]$state.round + 1
    Add-History ([ordered]@{
            at        = (Get-Date).ToString('s')
            round     = $cleanRound
            mode      = $Mode
            verdict   = 'nothing-to-review'
            critical  = 0
            important = 0
            minor     = 0
            files     = 0
            snapshot  = $headRev
            base      = $baseLabel
            head      = $headLabel
            profile   = $Profile
            baseCustom = [bool]($baseOverride -and $Mode -eq 'full')
            degraded  = (-not $snapshotOk)
            truncated = $false
            report    = ''
            cost_usd  = $null
        })
    $state.round = $cleanRound
    $state.lastMode = $Mode
    $state.lastVerdict = 'nothing-to-review'
    # 空 diff 不能保留上一轮 full 的缓存键：否则下一次相同 diff 的 full 会复用旧结论。
    # 但 lastReport 必须保留：轮次守卫下一次还要用它判断上一轮 findings 是否已处置；
    # 清空会让 nothing-to-review 变成绕过 V2 门禁的“洗白轮”。
    $state.lastInputHash = ''
    $state.updatedAt = (Get-Date).ToString('s')
    if ($snapshotOk -and $headRev -and $Mode -ne 'range') { $state.lastSnapshot = $headRev }
    [IO.File]::WriteAllText($statePath, ($state | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
    if ($Json) { [Console]::Out.WriteLine((@{ ok = $true; nothingToReview = $true; mode = $Mode; storage = $storageMode; round = $cleanRound; snapshot = $headRev; snapshotOk = $snapshotOk } | ConvertTo-Json -Compress)) }
    else {
        Write-Output "verdict   : nothing-to-review"
        Write-Output "mode      : $Mode"
        Write-Output "note      : 该范围内没有改动。nothing-to-review 不等于 pass（但 gate 模式下视为无事可做）。"
    }
    exit 0
}

$round = [int]$state.round + 1
$scopeWarning = ''
# scope preflight：简报/侧重里明确提到的文件，必须至少有一个出现在 diff 里。
# 只扫 Description + Focus（Requirements 常引用规范/参考文件，不能要求它们被改）。
if (-not [string]::IsNullOrWhiteSpace($Description) -or -not [string]::IsNullOrWhiteSpace($Focus)) {
    $scopeText = "$Description`n$Focus"
    # 保护盘符冒号，避免后续按非路径字符切分时把 C:\... 切成 C 和 \...
    $scopeText = $scopeText -replace '([A-Za-z]):([\\/])', '$1__CRC_DRIVE__$2'
    $scopePattern = '(?<![A-Za-z0-9_./\\-])((?:[\w.-]+/)*[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|ps1|json|md|py|rs|go|sql|yaml|yml|toml|css|scss|html|vue|svelte|sh|bat|cmd|ini|conf))'
    $scopeCandidates = @(
        [regex]::Matches($scopeText, $scopePattern, 'IgnoreCase') | ForEach-Object { $_.Groups[1].Value }
        ($scopeText -split '[^A-Za-z0-9_.\-/\\]+')
        ([regex]::Matches($scopeText, '"([^"]+)"|''([^'']+)''') | ForEach-Object {
            if ($_.Groups[1].Success) { $_.Groups[1].Value } else { $_.Groups[2].Value }
        })
    )
    $scopeTokens = @()
    foreach ($raw in $scopeCandidates) {
        $token = ([string]$raw).Trim().TrimEnd('.')
        if (-not $token) { continue }
        $token = $token -replace '__CRC_DRIVE__', ':'
        $token = $token -replace '\\', '/'
        if ($token -match '^https?:' -or $token -match '\*') { continue }
        $abs = if ([IO.Path]::IsPathRooted($token)) { $token } else { Join-Path $root $token }
        if (-not (Test-Path -LiteralPath $abs -PathType Leaf)) { continue }
        try { $resolved = (Resolve-Path -LiteralPath $abs).Path } catch { continue }
        $rel = [IO.Path]::GetRelativePath($root, $resolved)
        if ($rel.StartsWith('..')) {
            # 仓库外的绝对路径同样不能静默放过：它不可能出现在本次 diff 里。
            $scopeTokens += $resolved.Replace('\', '/').ToLowerInvariant()
            continue
        }
        $scopeTokens += $rel.Replace('\', '/').ToLowerInvariant()
    }
    # 反向兜底：CJK 文件名紧贴中文说明时，上面的 \w 正则会把前导汉字吞进 token。
    # 直接扫描仓库文件清单，按路径边界在 scopeText 里找真实文件（tracked + untracked）。
    $scanText = $scopeText.Replace('\', '/')
    $repoFiles = @(
        & git -C $root -c core.quotePath=false ls-files 2>$null
        & git -C $root -c core.quotePath=false ls-files --others --exclude-standard 2>$null
    ) | Where-Object { $_ } | ForEach-Object { $_.Replace('\', '/').Trim() } | Sort-Object -Unique
    $pathChar = '[A-Za-z0-9_.\-/\\]'
    foreach ($rel in $repoFiles) {
        if (-not $rel) { continue }
        $idx = $scanText.IndexOf($rel, [StringComparison]::OrdinalIgnoreCase)
        while ($idx -ge 0) {
            $before = if ($idx -gt 0) { [string]$scanText[$idx - 1] } else { '' }
            $afterIdx = $idx + $rel.Length
            $after = if ($afterIdx -lt $scanText.Length) { [string]$scanText[$afterIdx] } else { '' }
            if (($before -eq '' -or $before -notmatch $pathChar) -and ($after -eq '' -or $after -notmatch $pathChar)) {
                $scopeTokens += $rel.ToLowerInvariant()
                break
            }
            $idx = $scanText.IndexOf($rel, $idx + 1, [StringComparison]::OrdinalIgnoreCase)
        }
    }
    $scopeTokens = @($scopeTokens | Sort-Object -Unique)
    if ($scopeTokens.Count -gt 0) {
        $diffFiles = @($fileList | ForEach-Object { $_.Replace('\', '/').ToLowerInvariant() })
        $hit = @($scopeTokens | Where-Object { $diffFiles -contains $_ })
        if ($hit.Count -eq 0) {
            $msg = "scope 不一致：简报/侧重提到的文件（$($scopeTokens -join ', ')）都不在本次 diff（$($diffFiles -join ', ')）里。" +
                ' 请检查 -TaskDir/-Base/工作区，或确认简报写错了；如确认是有意为之，可在引擎 config.json 设 strictScope=false（直接 CLI 也可加 -NoStrictScope）。'
            $strict = if ($NoStrictScope) { $false } else { [bool]$cfg.strictScope }
            if ($strict) { Fail $msg }
            $scopeWarning = $msg
            Write-Info "警告：$msg"
        }
    }
}
$truncated = $false
$patchPath = ''
$inlineDiff = $diffText
if ($diffText.Length -gt $MaxDiffChars) {
    $truncated = $true
    $patchPath = Join-Path $OutDir ("diff-$round.patch")
    [IO.File]::WriteAllText($patchPath, $diffText, (New-Object Text.UTF8Encoding($false)))
    $inlineDiff = $diffText.Substring(0, $MaxDiffChars)
}

# ---------------------------------------------------------------- 5. 组装 prompt
if ([string]::IsNullOrWhiteSpace($Description)) {
    $t = if ($taskTitle) { $taskTitle } else { '（未命名任务）' }
    $scope = if ($storageMode -eq 'trellis') { "Trellis 任务《$t》" } else { "本地审核《$t》" }
    $Description = "$scope 第 $round 轮实现（$Mode 模式，$fileCount 个文件）"
}
if ([string]::IsNullOrWhiteSpace($Requirements)) {
    $candidates = if ($storageMode -eq 'trellis') {
        @('prd.md', 'design.md', 'implement.md')
    } else {
        @('REVIEW.md', 'CONTRIBUTING.md')
    }
    $reqFiles = @($candidates | ForEach-Object { Join-Path $taskPath $_ } | Where-Object { Test-Path -LiteralPath $_ })
    if ($reqFiles.Count -gt 0) {
        $Requirements = ($reqFiles | ForEach-Object { "- $($_.Substring($root.Length).TrimStart('\', '/'))" }) -join "`n"
    } elseif ($storageMode -eq 'trellis') {
        $Requirements = '（本任务没有 prd/design/implement，按 Description 与实际改动判断）'
    } else {
        $Requirements = '（本地账本没有任务产物；按 Description、实际改动和项目规范判断）'
    }
}

# 项目规范：只给路径，让审核员按需 Read，不把整棵 spec 内联。
$specPaths = @()
if ($storageMode -eq 'trellis') {
    $specRoot = Join-Path $root '.trellis/spec'
    if (Test-Path -LiteralPath $specRoot) {
        $specPaths = @(
            Get-ChildItem -LiteralPath $specRoot -Recurse -File -Filter 'index.md' -ErrorAction SilentlyContinue |
                ForEach-Object { $_.FullName.Substring($root.Length).TrimStart('\', '/') } |
                Select-Object -First 12
        )
    }
} else {
    foreach ($candidate in @('AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md')) {
        if (Test-Path -LiteralPath (Join-Path $root $candidate)) { $specPaths += $candidate }
    }
}
$specText = if ($specPaths.Count -gt 0) { ($specPaths | ForEach-Object { "- $_" }) -join "`n" } else { '- （无项目规范文件）' }

# 角色文件 = 项目自己的 reviewer role + 插件自带的通用 role（可同时存在）。
$roleParts = @()
$projectRole = [string]$cfg.reviewerRoleFile
if (-not [string]::IsNullOrWhiteSpace($projectRole)) {
    if (-not [IO.Path]::IsPathRooted($projectRole)) { $projectRole = Join-Path $root $projectRole }
    if (Test-Path -LiteralPath $projectRole) { $roleParts += (Get-Content -LiteralPath $projectRole -Raw) }
}
$bundledRole = Join-Path $scriptRoot 'reviewer-role.md'
if (Test-Path -LiteralPath $bundledRole) { $roleParts += (Get-Content -LiteralPath $bundledRole -Raw) }
$rolePath = ''
$roleExists = $false
if ($roleParts.Count -gt 0) {
    $rolePath = Join-Path $OutDir ("role-$round.md")
    [IO.File]::WriteAllText($rolePath, ($roleParts -join "`n`n---`n`n"), (New-Object Text.UTF8Encoding($false)))
    $roleExists = $true
}

$checksText = if ($Checks.Count -gt 0) { ($Checks | ForEach-Object { "- $_" }) -join "`n" } else { '- （本轮未提供客观检查结果；请自行判断改动是否需要补测试/编译）' }
$focusText = if ($Focus) { $Focus } else { '无特别侧重，按下列维度常规审查。' }
$scopeNote = if ($scopeWarning) { "## 范围警告`n$scopeWarning`n" } else { '' }
$rangeNote = if ($Mode -eq 'range' -and ($rangeDirty -or $rangeHeadMismatch)) {
    "## range 读取警告`n当前工作区与被审提交区间不一致（dirty=$rangeDirty, headMismatch=$rangeHeadMismatch）。" +
    "你用 Read 打开的是当前工作区文件，不是 base..head 的提交版本；不要用工作区内容反驳 diff 里的旧行，评审以 diff 为准。`n"
} else { '' }
$patchNote = if ($truncated) {
    $rel = $patchPath.Substring($root.Length).TrimStart('\', '/')
    "内联部分只包含前 $MaxDiffChars 字符；完整 diff 已落盘：$rel 。用 Read 分段读取（先读前 300 行，再用 offset/limit 续读），不要凭内联片段推断全部改动。"
} else {
    '以下 diff 为完整内容。'
}

$prompt = @"
# 审核简报 · 第 $round 轮 · $taskName

## 本轮做了什么
$Description

## 验收要求 / 计划
$Requirements

## 项目规范（按需 Read，不要通读）
$specText

## 审核范围
模式: $Mode
账本: $storageMode
Base: $baseLabel
Head: $headLabel
文件数: $fileCount
diff 字符数: $($diffText.Length)

## 改动文件清单
$fileListText

## git diff --stat
$statText

## 已执行检查（实现者自述，需要你判断是否足够）
$checksText

## 本轮侧重
$focusText

$scopeNote
$rangeNote
## git diff
$patchNote

----- diff 开始 -----
$inlineDiff
----- diff 结束 -----

## 评审要求（严格遵守）
1. 先读任务产物（上面「验收要求 / 计划」里的路径）和「项目规范」中与本轮文件相关的条目，再判实现是否真的覆盖了它们，而不是完成了别的东西。
2. 只审本次 diff 及其**直接**影响面（被改函数/命令的调用方、对应类型与契约、相关测试）。不要通读仓库、不要点评无关模块。
3. 每条 issue 必须给 severity + file + line + issue + why + fix。「测试通过」不是实现正确的证据；读不到、判不了的写进 assessment 并说明缺什么。
4. 你只读：不要修改文件，不要执行 `git add/commit/checkout/stash/reset/clean`、不要安装依赖、不要启动服务。
5. 工具可能受限（部分沙箱下只有 Read 可用，Grep/Glob 也会被拒绝；Bash 不开放）。以内联 diff + 上面的改动文件清单为依据，必要时用 Read 打开被改文件；diff 被截断时按提示分段读完整 patch。工具被拒不是放弃取证的理由，也不要把「无法验证」当成通过。
6. severity 只用 critical / important / minor 三个词，不要写 BLOCKING/MAJOR/MINOR（词表不一致会让门禁失效）。
7. 有 critical 或 important 时 verdict 必须是 fix 或 reject，不得 pass；只有 minor 或没有发现才可 pass。
8. 没有真问题就给空 issues，不要凑数。
9. 如果 diff 被截断，必须先用 Read 读完整 patch 再下结论；没有读全就不得给 pass，并在 assessment 里写明读了哪些文件/为什么没读完。
10. 按下面 JSON 结构输出**一个 JSON 对象**，不要 markdown 围栏、不要前后解释文字。

## 输出 JSON 结构
{
  "verdict": "pass | fix | reject",
  "summary": "一句话结论",
  "strengths": [{ "point": "做得好的地方", "evidence": "file:line" }],
  "issues": [{
    "severity": "critical | important | minor",
    "file": "相对仓库根路径",
    "line": "行号或范围，未知写 0",
    "issue": "什么情况下会错",
    "why": "为什么重要（后果）",
    "fix": "往哪个方向改，具体到可执行"
  }],
  "recommendations": ["非阻塞的改进建议"],
  "assessment": "1-2 句技术判断"
}
"@

$promptPath = Join-Path $OutDir ("prompt-$round.md")
[IO.File]::WriteAllText($promptPath, $prompt, (New-Object Text.UTF8Encoding($false)))

# 安全缓存：只有「diff + 本次输入 + 审核员会读的上下文文件」完全相同时才复用。
# 不做「未变文件沿用上轮结论」——跨文件契约变化无法用文件级缓存证明安全。
function Get-Sha256([string]$text) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $bytes = [Text.Encoding]::UTF8.GetBytes($text); return (($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join '') }
    finally { $sha.Dispose() }
}
$cacheFiles = @()
if ($storageMode -eq 'trellis') {
    foreach ($n in @('prd.md', 'design.md', 'implement.md')) {
        $p = Join-Path $taskPath $n
        if (Test-Path -LiteralPath $p) { $cacheFiles += $p }
    }
    $specRoot = Join-Path $root '.trellis/spec'
    if (Test-Path -LiteralPath $specRoot) {
        $cacheFiles += @(Get-ChildItem -LiteralPath $specRoot -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
    }
} else {
    foreach ($n in @('REVIEW.md', 'AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md')) {
        $p = Join-Path $root $n
        if (Test-Path -LiteralPath $p) { $cacheFiles += $p }
    }
}
if (Test-Path -LiteralPath $taskJsonPath) { $cacheFiles += $taskJsonPath }
if ($rolePath -and (Test-Path -LiteralPath $rolePath)) { $cacheFiles += $rolePath }
$cacheSchema = Join-Path $scriptRoot 'review-schema.json'
if (Test-Path -LiteralPath $cacheSchema) { $cacheFiles += $cacheSchema }
# reviewer 的 CLI 模型/端点也属于输入：settings 变了就不能复用旧结论。
$claudeSettings = Join-Path $env:USERPROFILE '.claude/settings.json'
if (Test-Path -LiteralPath $claudeSettings) { $cacheFiles += $claudeSettings }
# 引擎脚本与 config（failOn/reviewerRoleFile/exclude 等）也属于审核输入。
if (Test-Path -LiteralPath $PSCommandPath) { $cacheFiles += $PSCommandPath }
if (Test-Path -LiteralPath $configPath) { $cacheFiles += $configPath }
# ACP transport 的 bridge/依赖版本也影响输出；缓存不能把 CLI 的旧结论当成 ACP 的。
$acpBridgeCache = Join-Path $scriptRoot 'acp-review.mjs'
if (Test-Path -LiteralPath $acpBridgeCache) { $cacheFiles += $acpBridgeCache }
$pluginPackageCache = Join-Path (Split-Path -Parent $scriptRoot) 'package.json'
if (Test-Path -LiteralPath $pluginPackageCache) { $cacheFiles += $pluginPackageCache }
$acpAdapterCache = Join-Path (Split-Path -Parent $scriptRoot) 'node_modules/@agentclientprotocol/claude-agent-acp/package.json'
if (Test-Path -LiteralPath $acpAdapterCache) { $cacheFiles += $acpAdapterCache }
$cacheFiles = @($cacheFiles | Sort-Object -Unique)
$cacheParts = @(
    'api=3',
    $Mode,
    $storageMode,
    $taskPath,
    $baseRev,
    $headRev,
    $rangeWorktreeTree,
    $rangeDirty,
    $rangeHeadMismatch,
    $cacheDescription,
    $cacheRequirements,
    $Focus,
    ($Checks -join "`n"),
    ($Paths -join "`n"),
    $Model,
    $Effort,
    [string]$MaxDiffChars,
    $Profile,
    $Transport,
    $scopeWarning,
    $diffText
)
foreach ($f in $cacheFiles) {
    try {
        $label = if ($rolePath -and $f -eq $rolePath) { 'role' } else { $f }
        $cacheParts += "$label|" + (Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash
    } catch { $cacheParts += "$f|unreadable" }
}
$inputHash = Get-Sha256 ($cacheParts -join "`n")

if (-not $DryRun -and $state.lastInputHash -eq $inputHash -and $state.lastReport -and (Test-Path -LiteralPath $state.lastReport)) {
    $sourceReport = $null
    try { $sourceReport = Get-Content -LiteralPath $state.lastReport -Raw | ConvertFrom-Json } catch { $sourceReport = $null }
    $cachedVerdict = if ($sourceReport) { [string]$sourceReport.review.verdict } else { '' }
    if ($sourceReport -and $sourceReport.review -and $cachedVerdict -in @('pass', 'fix', 'reject')) {
        $srcIssues = @($sourceReport.review.issues | Where-Object { $_ })
        $cachedCrit = @($srcIssues | Where-Object { [string]$_.severity -eq 'critical' }).Count
        $cachedImp = @($srcIssues | Where-Object { [string]$_.severity -eq 'important' }).Count
        $cachedMin = @($srcIssues | Where-Object { [string]$_.severity -eq 'minor' }).Count
        $cachedSummary = [string]$sourceReport.review.summary
        $cachedExit = if ($cachedVerdict -in @('fix', 'reject')) { 1 } else { 0 }
        $cachedBaseCustom = [bool]($baseOverride -and $Mode -eq 'full')
        $cachedReportPath = Join-Path $OutDir ("review-$round.json")
        $cachedMdPath = Join-Path $OutDir ("review-$round.md")
        $mdLines = @(
            "# 审核报告 · 第 $round 轮（$Mode，缓存）",
            '',
            "- 来源：$($state.lastReport)",
            "- 结论：**$cachedVerdict**",
            "- 问题：critical=$cachedCrit important=$cachedImp minor=$cachedMin",
            '',
            '## 结论',
            $cachedSummary,
            ''
        )
        if ($srcIssues.Count -gt 0) {
            $mdLines += '## 问题清单'
            $n = 0
            foreach ($i in $srcIssues) {
                $n++
                $mdLines += ''
                $mdLines += "### $n. [$($i.severity)] $($i.file):$($i.line)"
                $mdLines += "- key：``$($i.key)``（index $($n - 1)，0-based，与 review-$round.json 的 issues 下标一致）"
                $mdLines += "- 问题：$($i.issue)"
                $mdLines += "- 后果：$($i.why)"
                $mdLines += "- 方向：$($i.fix)"
            }
            $mdLines += ''
        }
        $srcStrengths = @($sourceReport.review.strengths | Where-Object { $_ })
        if ($srcStrengths.Count -gt 0) {
            $mdLines += '## 做得好的地方'
            foreach ($s in $srcStrengths) { $mdLines += "- $($s.point)（$($s.evidence)）" }
            $mdLines += ''
        }
        $srcRecs = @($sourceReport.review.recommendations | Where-Object { $_ })
        if ($srcRecs.Count -gt 0) {
            $mdLines += '## 非阻塞建议'
            foreach ($r in $srcRecs) { $mdLines += "- $r" }
            $mdLines += ''
        }
        if ($sourceReport.review.assessment) {
            $mdLines += '## 技术判断'
            $mdLines += [string]$sourceReport.review.assessment
            $mdLines += ''
        }
        $mdLines += '## 说明'
        $mdLines += '复用与上次完全相同的 diff/输入，未调用模型；本次是当前轮次的缓存报告。'
        [IO.File]::WriteAllText($cachedMdPath, (($mdLines -join "`n") + "`n"), (New-Object Text.UTF8Encoding($false)))
        $cacheTransport = if ($sourceReport -and $sourceReport.meta -and $sourceReport.meta.transport) {
            [string]$sourceReport.meta.transport
        } else {
            ''
        }
        $cacheRoleMode = if ($sourceReport -and $sourceReport.meta -and $sourceReport.meta.roleMode) { [string]$sourceReport.meta.roleMode } else { '' }
        $cacheTransportWarning = if ($sourceReport -and $sourceReport.meta -and $sourceReport.meta.transportWarning) { [string]$sourceReport.meta.transportWarning } else { '' }
        $cachedMeta = [ordered]@{
            task = $taskName; storage = $storageMode; round = $round; mode = $Mode
            base = $baseLabel; head = $headLabel; baseCustom = $cachedBaseCustom
            snapshot = $headRev; session = [ordered]@{ id = $SessionId; name = $SessionName }
            files = $fileCount; diffChars = $diffText.Length; truncated = $truncated
            patch = $patchPath; model = $Model; effort = $Effort; cost_usd = 0
            duration_s = 0; reviewed_at = (Get-Date).ToString('s'); prompt = $promptPath
            raw = ''; cached = $true; cachedFrom = [string]$state.lastReport
            scopeWarning = $scopeWarning
            transport = $cacheTransport
            roleMode = $cacheRoleMode
            transportWarning = $cacheTransportWarning
        }
        $cachedReportObj = [ordered]@{ meta = $cachedMeta; review = $sourceReport.review }
        [IO.File]::WriteAllText($cachedReportPath, ($cachedReportObj | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding($false)))

        Add-History ([ordered]@{
                at        = (Get-Date).ToString('s')
                round     = $round
                mode      = $Mode
                storage   = $storageMode
                verdict   = $cachedVerdict
                critical  = $cachedCrit
                important = $cachedImp
                minor     = $cachedMin
                files     = $fileCount
                snapshot  = $headRev
                base      = $baseLabel
                head      = $headLabel
                profile   = $Profile
                transport = $cacheTransport
                roleMode = $cacheRoleMode
                transportWarning = $cacheTransportWarning
                baseCustom = $cachedBaseCustom
                degraded  = (-not $snapshotOk)
                truncated = $truncated
                report    = $cachedReportPath
                cost_usd  = 0
                cached    = $true
            })
        $state.round = $round
        $state.lastMode = $Mode
        $state.lastVerdict = $cachedVerdict
        $state.storage = $storageMode
        $state.lastInputHash = $inputHash
        $state.lastReport = $cachedReportPath
        $state.updatedAt = (Get-Date).ToString('s')
        if ($snapshotOk -and $headRev -and $Mode -ne 'range') { $state.lastSnapshot = $headRev }
        [IO.File]::WriteAllText($statePath, ($state | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))

        # 缓存命中也复用正常分支的连续失败/熔断提示，避免连续 fix 在缓存路径里静默。
        $cachedHadFailing = (@($srcIssues | Where-Object { $failOn -contains [string]$_.severity }).Count -gt 0)
        $roundGuard = Get-RoundGuard $cachedHadFailing
        $consecutive = $roundGuard.consecutive
        $escalate = $roundGuard.escalate

        $script:runStatePath = Join-Path $OutDir 'run.json'
        $cachedRun = [ordered]@{
            status = 'done'; phase = 'done'; storage = $storageMode; mode = $Mode
            round = $round; task = $taskName; cached = $true
            verdict = $cachedVerdict; exitCode = $cachedExit
            updatedAt = (Get-Date).ToString('s')
        }
        try {
            [IO.File]::WriteAllText($script:runStatePath, ($cachedRun | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
        } catch { }
        if ($Json) {
            [Console]::Out.WriteLine(([ordered]@{
                        ok        = $true
                        cached    = $true
                        verdict   = $cachedVerdict
                        critical  = $cachedCrit
                        important = $cachedImp
                        minor     = $cachedMin
                        summary   = $cachedSummary
                        round     = $round
                        mode      = $Mode
                        storage   = $storageMode
                        base      = $baseLabel
                        head      = $headLabel
                        profile   = $Profile
                        transport = $cacheTransport
                        roleMode  = $cacheRoleMode
                        transportWarning = $cacheTransportWarning
                        truncated = $truncated
                        scopeWarning = $scopeWarning
                        report    = $cachedReportPath
                        markdown  = $cachedMdPath
                        cost_usd  = 0
                        exitCode  = $cachedExit
                        consecutive = $consecutive
                        escalate  = $escalate
                        note      = '复用与上次完全相同的 diff/输入，未调用模型；已按当前快照落一条 history，gate 可正常判定'
                    } | ConvertTo-Json -Compress))
        } else {
            Write-Output "verdict   : $cachedVerdict (cached)"
            Write-Output "report    : $cachedReportPath"
            Write-Output "note      : 复用与上次完全相同的 diff/输入，未调用模型；已按当前快照落一条 history。"
        }
        exit $cachedExit
    }
}

if ($DryRun) {
    $summary = [ordered]@{
        ok          = $true
        dryRun      = $true
        mode        = $Mode
        storage     = $storageMode
        task        = $taskName
        profile     = $Profile
        round       = $round
        files       = $fileCount
        diffChars   = $diffText.Length
        truncated   = $truncated
        patch       = $patchPath
        prompt      = $promptPath
        roleFile    = $rolePath
        roleExists  = $roleExists
        snapshotOk  = $snapshotOk
        snapshot    = $headRev
        base        = $baseLabel
        head        = $headLabel
        scopeWarning = $scopeWarning
        rangeDirty  = $rangeDirty
        rangeHeadMismatch = $rangeHeadMismatch
    }
    if ($Json) { [Console]::Out.WriteLine(($summary | ConvertTo-Json -Compress -Depth 5)) }
    else {
        Write-Output "dry-run   : 已组装审核输入，未调用模型"
        Write-Output "mode      : $Mode"
        Write-Output "storage   : $storageMode"
        Write-Output "round     : $round"
        Write-Output "task      : $taskName"
        Write-Output "files     : $fileCount"
        Write-Output "diffChars : $($diffText.Length)$(if ($truncated) { " (截断，完整: $patchPath)" })"
        Write-Output "prompt    : $promptPath"
        Write-Output "role      : $rolePath (exists=$roleExists)"
        Write-Output "snapshot  : $(if ($snapshotOk) { 'ok' } else { '降级' })"
    }
    exit 0
}

# ---------------------------------------------------------------- 6. 定位 claude
function Resolve-ClaudeExe([string]$explicit) {
    if (-not [string]::IsNullOrWhiteSpace($explicit)) {
        if (Test-Path -LiteralPath $explicit) { return (Resolve-Path -LiteralPath $explicit).Path }
        Fail "config.json 的 claudeExe 不存在：$explicit"
    }
    $candidates = @(
        'D:\dev\npm-global\node_modules\@anthropic-ai\claude-code\bin\claude.exe',
        (Join-Path $env:USERPROFILE 'AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe')
    )
    foreach ($c in $candidates) { if (Test-Path -LiteralPath $c) { return $c } }
    $cmd = Get-Command claude -ErrorAction SilentlyContinue
    if ($cmd) {
        if ($cmd.Source -match '\.exe$') { return $cmd.Source }
        if ($cmd.Source -match '\.ps1$') {
            $p = Join-Path (Split-Path -Parent $cmd.Source) 'node_modules\@anthropic-ai\claude-code\bin\claude.exe'
            if (Test-Path -LiteralPath $p) { return $p }
        }
    }
    Fail '找不到 Claude Code CLI 可执行文件。安装后重试，或在 tools/claude-review/config.json 填 claudeExe。'
}

$claudeExe = Resolve-ClaudeExe ([string]$cfg.claudeExe)

function Resolve-NodeExe([string]$explicit) {
    if (-not [string]::IsNullOrWhiteSpace($explicit)) {
        if (Test-Path -LiteralPath $explicit) { return (Resolve-Path -LiteralPath $explicit).Path }
        return ''
    }
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source -and (Test-Path -LiteralPath $cmd.Source)) { return (Resolve-Path -LiteralPath $cmd.Source).Path }
    return ''
}

# PowerShell 的 Start-Process -ArgumentList <数组> 只是按空格拼接，不会给含空格的路径加引号。
# 路径里有空格时（Windows 用户名/项目目录很常见）必须自己构造带引号的命令行。
function Quote-ProcessArg([string]$value) {
    if ($value -match '[\s"]') {
        return '"' + ($value -replace '"', '\"') + '"'
    }
    return $value
}

# ACP 是 引擎 -> bridge -> adapter -> claude 的多级进程树；只杀 bridge 会留下孤儿 reviewer。
function Stop-ReviewProcessTree([int]$processId) {
    if (-not $processId) { return }
    try {
        if ($IsWindows) { & taskkill.exe /PID $processId /T /F 2>$null | Out-Null }
        else { Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue }
    } catch { }
    try { Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue } catch { }
}

# ---------------------------------------------------------------- 7. 调用
# 只读边界：只开放 Read/Grep/Glob，不开放 Bash（git 写操作、--output 写文件都无从谈起）。
$allowedTools = 'Read,Grep,Glob'
$cliArgs = @('-p', '--output-format', 'json', '--allowedTools', $allowedTools, '--disallowedTools', 'Write,Edit,NotebookEdit', '--permission-prompts', 'none')

# 结构化输出：--json-schema 需要单个参数，Windows 下必须自己转义引号
$schemaPath = Join-Path $scriptRoot 'review-schema.json'
if (Test-Path -LiteralPath $schemaPath) {
    try {
        $schemaJson = (Get-Content -LiteralPath $schemaPath -Raw | ConvertFrom-Json | ConvertTo-Json -Depth 20 -Compress)
        if ($schemaJson.Contains('\')) {
            # Windows 命令行里「反斜杠后跟引号」需要 \" 三连转义，容易把 schema 拆成多个参数。
            # 现有 review-schema.json 不含反斜杠；一旦含了就退回 prompt 内的 JSON 约束（保守但不失效）。
            Write-Info 'review-schema.json 含反斜杠，跳过 --json-schema，改用 prompt 内 JSON 约束。'
        } else {
            # 先转义引号再加外层引号：这是 Windows 命令行的标准写法（Start-Process 的 ArgumentList 会原样拼命令行）
            $cliArgs += @('--json-schema', ('"' + $schemaJson.Replace('"', '\"') + '"'))
        }
    } catch {
        Write-Info "review-schema.json 不可用（$($_.Exception.Message)），改用 prompt 内的 JSON 结构约束。"
    }
}
if ($roleExists) { $cliArgs += @('--append-system-prompt-file', $rolePath) }
if ($Model) { $cliArgs += @('--model', $Model) }
if ($Effort) { $cliArgs += @('--effort', $Effort) }
$maxBudgetUsd = if ($null -ne $cfg.maxBudgetUsd) { [double]$cfg.maxBudgetUsd } else { 0 }
if ($maxBudgetUsd -gt 0) { $cliArgs += @('--max-budget-usd', [string]$maxBudgetUsd) }

$runDir = Join-Path ([IO.Path]::GetTempPath()) ("claude-review-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $runDir -Force | Out-Null
$promptIn = Join-Path $runDir 'prompt.txt'
$outFile = Join-Path $runDir 'out.json'
$errFile = Join-Path $runDir 'err.txt'
[IO.File]::WriteAllText($promptIn, $prompt, (New-Object Text.UTF8Encoding($false)))

$runStatePath = Join-Path $OutDir 'run.json'
$script:runStatePath = $runStatePath
$runStartedAt = (Get-Date).ToString('s')
function Write-RunState([string]$status, [string]$phase, [hashtable]$extra = @{}) {
    $payload = [ordered]@{
        status    = $status
        phase     = $phase
        storage   = $storageMode
        mode      = $Mode
        round     = $round
        task      = $taskName
        startedAt = $runStartedAt
        updatedAt = (Get-Date).ToString('s')
    }
    foreach ($key in $extra.Keys) { $payload[$key] = $extra[$key] }
    try {
        [IO.File]::WriteAllText($runStatePath, ($payload | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
    } catch { }
}

Write-RunState 'running' 'starting' @{}
$sw = [Diagnostics.Stopwatch]::StartNew()

# ACP is an internal transport: deps are plugin dependencies, no user ACP setup.
# auto = ACP when bridge/adapter/node are available, otherwise the existing CLI.
$acpBridge = Join-Path $scriptRoot 'acp-review.mjs'
$acpAdapter = if (-not [string]::IsNullOrWhiteSpace($AcpAdapter)) {
    $AcpAdapter
} else {
    Join-Path (Split-Path -Parent $scriptRoot) 'node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js'
}
$nodeExe = Resolve-NodeExe $NodeExe
$useAcp = $Transport -ne 'cli' -and (Test-Path -LiteralPath $acpBridge) -and (Test-Path -LiteralPath $acpAdapter) -and -not [string]::IsNullOrWhiteSpace($nodeExe)
if ($Transport -eq 'acp' -and -not $useAcp) {
    Fail "ACP transport 不可用：需要 acp-review.mjs、插件依赖 @agentclientprotocol/claude-agent-acp 和 Node 运行时。重装/更新插件即可，无需单独配置 ACP。"
}
# 启动预算必须短：ACP 初始化卡死时尽快回退 CLI，而不是吃掉整轮 TimeoutSec。
$acpStartupMs = [Math]::Min(30000, [Math]::Max(5000, [int]($TimeoutSec * 1000 / 10)))

$script:ReviewBridge = $acpBridge
$script:ReviewAdapter = $acpAdapter
$script:ReviewNodeExe = $nodeExe
$script:ReviewClaudeExe = $claudeExe
$script:ReviewPromptIn = $promptIn
$script:ReviewRolePath = $rolePath
$script:ReviewCliArgs = $cliArgs
$script:ReviewOutFile = $outFile
$script:ReviewErrFile = $errFile
$script:ReviewTimeoutSec = $TimeoutSec
$script:ReviewNodeRunAsNode = [bool]$NodeRunAsNode
$script:ReviewStartupMs = $acpStartupMs
$script:ReviewMaxBudgetUsd = $maxBudgetUsd
$script:ReviewModel = $Model
$script:ReviewEffort = $Effort

function Start-ReviewProcess([ValidateSet('acp', 'cli')][string]$kind) {
    if ($kind -eq 'acp') {
        $acpArgs = @($script:ReviewBridge, '--prompt', $script:ReviewPromptIn, '--role', $script:ReviewRolePath,
            '--cwd', $root, '--claude', $script:ReviewClaudeExe,
            '--adapter', $script:ReviewAdapter,
            '--startup-timeout-ms', [string]$script:ReviewStartupMs,
            '--timeout-ms', [string]([Math]::Max(5000, ($script:ReviewTimeoutSec * 1000) - 10000)))
        if ($script:ReviewMaxBudgetUsd -gt 0) { $acpArgs += @('--max-budget-usd', [string]$script:ReviewMaxBudgetUsd) }
        if (-not [string]::IsNullOrWhiteSpace($script:ReviewModel)) { $acpArgs += @('--model', [string]$script:ReviewModel) }
        if (-not [string]::IsNullOrWhiteSpace($script:ReviewEffort)) { $acpArgs += @('--effort', [string]$script:ReviewEffort) }
        $acpLine = (@($acpArgs | ForEach-Object { Quote-ProcessArg ([string]$_) }) -join ' ')
        $oldRunAsNode = $env:ELECTRON_RUN_AS_NODE
        if ($script:ReviewNodeRunAsNode) { $env:ELECTRON_RUN_AS_NODE = '1' }
        try {
            return Start-Process -FilePath $script:ReviewNodeExe -ArgumentList $acpLine `
                -RedirectStandardOutput $script:ReviewOutFile -RedirectStandardError $script:ReviewErrFile `
                -NoNewWindow -PassThru
        } finally {
            if ($null -ne $oldRunAsNode) { $env:ELECTRON_RUN_AS_NODE = $oldRunAsNode }
            else { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
        }
    }
    # --json-schema 元素本身已带外层引号，不能再包一层；其余含空格的参数需要引用。
    $cliLine = (@($script:ReviewCliArgs | ForEach-Object {
                $item = [string]$_
                if ($item -match '^".*"$') { $item } else { Quote-ProcessArg $item }
            }) -join ' ')
    return Start-Process -FilePath $script:ReviewClaudeExe -ArgumentList $cliLine `
        -RedirectStandardInput $script:ReviewPromptIn -RedirectStandardOutput $script:ReviewOutFile -RedirectStandardError $script:ReviewErrFile `
        -NoNewWindow -PassThru
}

$acpUsed = $useAcp
$transportUsed = if ($acpUsed) { 'acp' } else { 'cli' }
$transportWarning = ''
$proc = Start-ReviewProcess $(if ($acpUsed) { 'acp' } else { 'cli' })
Write-RunState 'running' $(if ($acpUsed) { 'reviewing (acp)' } else { 'reviewing' }) @{ pid = $proc.Id; transport = $transportUsed }
$timedOut = $false
while ($true) {
    # 用 WaitForExit(5000) 做阻塞式探测：返回值会刷新进程状态，避免 HasExited 缓存误判；
    # 每次 5s 超时后再写心跳，既保留进度又不丢正常退出。
    while (-not $proc.WaitForExit(5000)) {
        if ($sw.Elapsed.TotalSeconds -ge $TimeoutSec) {
            $timedOut = $true
            try { Stop-ReviewProcessTree $proc.Id } catch { }
            break
        }
        Write-RunState 'running' 'reviewing' @{ pid = $proc.Id; elapsedSec = [int]$sw.Elapsed.TotalSeconds; transport = $transportUsed }
    }
    if ($timedOut) {
        $sw.Stop()
        Get-ChildItem $runDir -File -ErrorAction SilentlyContinue | Copy-Item -Destination $OutDir -Force -ErrorAction SilentlyContinue
        Fail "审核超时（>${TimeoutSec}s）。可调大 -TimeoutSec、调小 -MaxDiffChars，或用 -Paths 缩小范围。"
    }

    $rawOut = if (Test-Path -LiteralPath $outFile) { [IO.File]::ReadAllText($outFile) } else { '' }
    $rawErr = if (Test-Path -LiteralPath $errFile) { [IO.File]::ReadAllText($errFile) } else { '' }
    $procExit = if ($null -ne $proc.ExitCode) { [int]$proc.ExitCode } else { 0 }

    # The bridge exits 3 only when the ACP runtime is unavailable (not when the model failed).
    if ($acpUsed -and $procExit -eq 3 -and $Transport -eq 'auto') {
        $acpErrors = @()
        try {
            $acpEnvelope = $rawOut | ConvertFrom-Json
            if ($acpEnvelope -and $acpEnvelope.PSObject.Properties.Name -contains 'errors' -and $acpEnvelope.errors) {
                $acpErrors = @($acpEnvelope.errors | ForEach-Object { [string]$_ } | Where-Object { $_ })
            }
        } catch { }
        $firstError = if ($acpErrors.Count -gt 0) { $acpErrors[0] } elseif (-not [string]::IsNullOrWhiteSpace($rawErr)) {
            (@($rawErr -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -First 1) -join ' ')
        } else { "exit $procExit" }
        $transportWarning = "ACP 不可用，已回退 CLI：$firstError"
        # 保留失败现场，避免 CLI 覆盖 ACP 的 raw/err。
        try {
            [IO.File]::WriteAllText((Join-Path $OutDir "raw-$round-acp.json"), $rawOut, (New-Object Text.UTF8Encoding($false)))
            [IO.File]::WriteAllText((Join-Path $OutDir "acp-err-$round.txt"), $rawErr, (New-Object Text.UTF8Encoding($false)))
        } catch { }
        Write-Info $transportWarning
        $acpUsed = $false
        $transportUsed = 'cli'
        $proc = Start-ReviewProcess 'cli'
        # ACP 启动预算不能占用 CLI 的审核预算：回退后重新计时。
        $sw.Restart()
        Write-RunState 'running' 'reviewing' @{ pid = $proc.Id; transport = 'cli'; transportWarning = $transportWarning }
        $timedOut = $false
        continue
    }
    break
}
$sw.Stop()
$rawPath = Join-Path $OutDir ("raw-$round.json")
[IO.File]::WriteAllText($rawPath, $rawOut, (New-Object Text.UTF8Encoding($false)))
Get-ChildItem $runDir -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
Remove-Item $runDir -Recurse -Force -ErrorAction SilentlyContinue
if ([string]::IsNullOrWhiteSpace($rawOut)) {
    $kindLabel = if ($acpUsed) { 'ACP' } else { 'claude' }
    Fail ("$kindLabel 无输出（退出码 $procExit）。stderr: " + $rawErr.Substring(0, [Math]::Min(600, $rawErr.Length)))
}

# ---------------------------------------------------------------- 8. 解析
$envelope = $null
try { $envelope = $rawOut | ConvertFrom-Json } catch { $envelope = $null }

# 执行器故障优先判定：非零退出或错误 envelope 一律 exit 2，绝不当成审核结论
$cliErrors = @()
if ($envelope -and ($envelope.PSObject.Properties.Name -contains 'errors') -and $envelope.errors) {
    $cliErrors = @($envelope.errors | ForEach-Object { [string]$_ } | Where-Object { $_ })
}
if ($procExit -ne 0) {
    $kindLabel = if ($acpUsed) { 'ACP' } else { 'claude' }
    $errDetail = if ($cliErrors.Count -gt 0) { "；errors: " + ($cliErrors -join '; ') } else { '' }
    Fail ("$kindLabel 非零退出（$procExit）$errDetail。stderr: " + $rawErr.Substring(0, [Math]::Min(600, $rawErr.Length)) + " raw: $rawPath")
}
if ($envelope -and ((($envelope.PSObject.Properties.Name -contains 'is_error') -and $envelope.is_error) -or (($envelope.PSObject.Properties.Name -contains 'type') -and [string]$envelope.type -eq 'error'))) {
    $kindLabel = if ($acpUsed) { 'ACP' } else { 'claude' }
    $errDetail = if ($cliErrors.Count -gt 0) { " errors: " + ($cliErrors -join '; ') } else { '' }
    Fail ("$kindLabel 返回错误结果（subtype=$($envelope.subtype), status=$($envelope.api_error_status)）$errDetail。raw: $rawPath")
}

$resultText = if ($envelope -and $envelope.PSObject.Properties.Name -contains 'result') { [string]$envelope.result } else { $rawOut }
$roleMode = if ($envelope -and ($envelope.PSObject.Properties.Name -contains 'roleMode')) {
    [string]$envelope.roleMode
} elseif ($roleExists) {
    # CLI 用 --append-system-prompt-file 把 role 放在 system 层；envelope 不带 roleMode。
    'system'
} else {
    'none'
}
$clean = $resultText.Trim()
$clean = $clean -replace '(?s)^```(?:json)?\s*', ''
$clean = $clean -replace '(?s)\s*```\s*$', ''

$review = $null
try { $review = $clean | ConvertFrom-Json } catch { $review = $null }
if (-not $review) {
    # 退化：从文本里截取第一个平衡的 JSON 对象
    $start = $clean.IndexOf('{')
    if ($start -ge 0) {
        $depth = 0; $end = -1; $inStr = $false; $esc = $false
        for ($i = $start; $i -lt $clean.Length; $i++) {
            $ch = $clean[$i]
            if ($inStr) {
                if ($esc) { $esc = $false }
                elseif ($ch -eq '\') { $esc = $true }
                elseif ($ch -eq '"') { $inStr = $false }
            } else {
                if ($ch -eq '"') { $inStr = $true }
                elseif ($ch -eq '{') { $depth++ }
                elseif ($ch -eq '}') { $depth--; if ($depth -eq 0) { $end = $i; break } }
            }
        }
        if ($end -gt $start) { try { $review = $clean.Substring($start, $end - $start + 1) | ConvertFrom-Json } catch { } }
    }
}

$costUsd = if ($envelope -and $envelope.PSObject.Properties.Name -contains 'total_cost_usd') { $envelope.total_cost_usd } else { $null }
$durS = [int]$sw.Elapsed.TotalSeconds

# --json-schema 生效时优先采用结构化结果，避免再从自由文本里抠 JSON
if ($envelope -and ($envelope.PSObject.Properties.Name -contains 'structured_output') -and $envelope.structured_output) {
    $review = $envelope.structured_output
    # CLI 也可能把结构化结果以 JSON 字符串返回，统一成对象
    if ($review -is [string]) {
        try { $review = $review | ConvertFrom-Json } catch { $review = $null }
    }
}

if (-not $review) {
    $rawResultPath = Join-Path $OutDir ("unparsed-$round.txt")
    [IO.File]::WriteAllText($rawResultPath, $resultText, (New-Object Text.UTF8Encoding($false)))
    Fail "审核输出不是合法 JSON。原文已落盘：$rawResultPath（envelope: $rawPath）"
}

# 词表归一化：容忍审核员漂移到 blocking/major/minor 或全大写，避免条目被静默丢弃
$reviewProps = $review.PSObject.Properties.Name
if (-not ($reviewProps -contains 'issues')) {
    $legacy = @()
    foreach ($m in @(@('blocking', 'critical'), @('major', 'important'), @('minor', 'minor'))) {
        if ($reviewProps -contains $m[0]) {
            foreach ($it in @($review.($m[0]) | Where-Object { $_ })) {
                $legacy += [pscustomobject]@{
                    severity = $m[1]
                    file     = [string]$it.file
                    line     = [string]$it.line
                    issue    = [string]$it.issue
                    why      = [string]$it.why
                    fix      = [string]$it.fix
                }
            }
        }
    }
    if ($legacy.Count -gt 0) {
        Write-Info '注意：审核员用了非约定键（blocking/major/minor），已归一化为 critical/important/minor。'
    }
    $review | Add-Member -NotePropertyName issues -NotePropertyValue $legacy -Force
}

$sevMap = @{ 'CRITICAL' = 'critical'; 'BLOCKING' = 'critical'; 'IMPORTANT' = 'important'; 'MAJOR' = 'important'; 'MINOR' = 'minor' }

# 给每条问题一个稳定的短指纹：同一 file+severity+规范化文本 → 同一 key。
# 跨轮匹配与「处置状态」都靠它；文本被改写时匹配不上会退化为按 file+severity 推断。
function Get-IssueKey([string]$file, [string]$sev, [string]$text) {
    $norm = ($text -replace '\s+', ' ').Trim().ToLowerInvariant()
    $bytes = [Text.Encoding]::UTF8.GetBytes("$file|$sev|$norm")
    $sha = [Security.Cryptography.SHA1]::Create()
    try { $hash = $sha.ComputeHash($bytes) } finally { $sha.Dispose() }
    return (-join ($hash[0..3] | ForEach-Object { $_.ToString('x2') }))
}

$issues = @()
foreach ($i in @($review.issues | Where-Object { $_ })) {
    $rawSev = [string]$i.severity
    $sev = if ($sevMap.ContainsKey($rawSev.ToUpperInvariant())) { $sevMap[$rawSev.ToUpperInvariant()] } else { $rawSev.ToLowerInvariant() }
    if ($sev -notin @('critical', 'important', 'minor')) { $sev = 'important' }
    if ($i.PSObject.Properties.Name -contains 'severity') { $i.severity = $sev }
    else { $i | Add-Member -NotePropertyName severity -NotePropertyValue $sev -Force }
    $key = Get-IssueKey ([string]$i.file) $sev ([string]$i.issue)
    if ($i.PSObject.Properties.Name -contains 'key') { $i.key = $key }
    else { $i | Add-Member -NotePropertyName key -NotePropertyValue $key -Force }
    $issues += $i
}
$review | Add-Member -NotePropertyName issues -NotePropertyValue $issues -Force

$verdictRaw = [string]$review.verdict
$verdict = $verdictRaw.ToLowerInvariant()
switch ($verdict) { 'fail' { $verdict = 'fix' } 'approve' { $verdict = 'pass' } }
if ($verdict -notin @('pass', 'fix', 'reject')) {
    Fail "审核结论不可识别：'$verdictRaw'（要求 pass|fix|reject）。raw: $rawPath"
}
$review | Add-Member -NotePropertyName verdict -NotePropertyValue $verdict -Force

$crit = @($issues | Where-Object { $_.severity -eq 'critical' }).Count
$imp = @($issues | Where-Object { $_.severity -eq 'important' }).Count
$min = @($issues | Where-Object { $_.severity -eq 'minor' }).Count

# 结论必须与证据自洽：按 failOn 命中条目定级，而不是只信 verdict 那一个词（防绕过门禁）
$hadFailing = (@($issues | Where-Object { $failOn -contains [string]$_.severity }).Count -gt 0)
if ($hadFailing -and $verdict -eq 'pass') {
    $verdict = 'fix'
    $review.verdict = 'fix'
    Write-Info '注意：审核员给了 pass，但存在 critical/important 条目，按证据判为 fix（防止门禁被绕过）。'
}
if ((-not $hadFailing) -and $verdict -ne 'pass') {
    $issues += [pscustomobject]@{
        severity = 'important'
        file     = '(审核未给出条目)'
        line     = '0'
        issue    = "审核结论为 $verdict，但没有给出任何条目化问题"
        why      = '输出不自洽，无法据此修复；按未通过处理'
        fix      = '重跑审核，或要求审核员在 issues 中补齐具体问题'
    }
    $review.issues = $issues
    $imp = 1
    $hadFailing = $true
}

$reportObj = [ordered]@{
    meta   = [ordered]@{
        task        = $taskName
        storage     = $storageMode
        round       = $round
        mode        = $Mode
        base        = $baseLabel
        head        = $headLabel
        baseCustom  = [bool]($baseOverride -and $Mode -eq 'full')
        rangeDirty  = $rangeDirty
        rangeHeadMismatch = $rangeHeadMismatch
        profile     = $Profile
        failOn      = @($failOn)
        transport   = $transportUsed
        roleMode    = $roleMode
        transportWarning = $transportWarning
        scopeWarning = $scopeWarning
        snapshot    = $headRev
        session     = [ordered]@{ id = $SessionId; name = $SessionName }
        files       = $fileCount
        diffChars   = $diffText.Length
        truncated   = $truncated
        patch       = $patchPath
        model       = $Model
        effort      = $Effort
        cost_usd    = $costUsd
        duration_s  = $durS
        reviewed_at = (Get-Date).ToString('s')
        prompt      = $promptPath
        raw         = $rawPath
    }
    review = $review
}
$reportPath = Join-Path $OutDir ("review-$round.json")
[IO.File]::WriteAllText($reportPath, ($reportObj | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding($false)))

# 人可读版
$md = New-Object System.Text.StringBuilder
[void]$md.AppendLine("# 审核报告 · 第 $round 轮（$Mode）")
[void]$md.AppendLine('')
[void]$md.AppendLine("- 任务：$taskName")
[void]$md.AppendLine("- 结论：**$verdict**")
[void]$md.AppendLine("- 问题：critical=$crit important=$imp minor=$min")
[void]$md.AppendLine("- 基准：$baseLabel")
[void]$md.AppendLine("- 耗时：${durS}s 成本：$costUsd")
[void]$md.AppendLine('')
[void]$md.AppendLine('## 结论')
[void]$md.AppendLine("$($review.summary)")
[void]$md.AppendLine('')
if ($issues.Count -gt 0) {
    [void]$md.AppendLine('## 问题清单')
    $n = 0
    foreach ($i in $issues) {
        $n++
        [void]$md.AppendLine('')
        [void]$md.AppendLine("### $n. [$($i.severity)] $($i.file):$($i.line)")
        [void]$md.AppendLine("- key：``$($i.key)``（index $($n - 1)，0-based，与 review-$round.json 的 issues 下标一致）")
        [void]$md.AppendLine("- 问题：$($i.issue)")
        [void]$md.AppendLine("- 后果：$($i.why)")
        [void]$md.AppendLine("- 方向：$($i.fix)")
    }
    [void]$md.AppendLine('')
}
$strengths = @($review.strengths | Where-Object { $_ })
if ($strengths.Count -gt 0) {
    [void]$md.AppendLine('## 做得好的地方')
    foreach ($s in $strengths) { [void]$md.AppendLine("- $($s.point)（$($s.evidence)）") }
    [void]$md.AppendLine('')
}
$recs = @($review.recommendations | Where-Object { $_ })
if ($recs.Count -gt 0) {
    [void]$md.AppendLine('## 非阻塞建议')
    foreach ($r in $recs) { [void]$md.AppendLine("- $r") }
    [void]$md.AppendLine('')
}
if ($review.assessment) { [void]$md.AppendLine('## 技术判断'); [void]$md.AppendLine("$($review.assessment)") }
$mdPath = Join-Path $OutDir ("review-$round.md")
[IO.File]::WriteAllText($mdPath, $md.ToString(), (New-Object Text.UTF8Encoding($false)))

# ---------------------------------------------------------------- 9. 状态与历史
$state.round = $round
$state.lastMode = $Mode
$state.lastVerdict = $verdict
$state.storage = $storageMode
$state.lastInputHash = $inputHash
$state.lastReport = $reportPath
$state.updatedAt = (Get-Date).ToString('s')
if ($snapshotOk -and $headRev -and $Mode -ne 'range') { $state.lastSnapshot = $headRev }
[IO.File]::WriteAllText($statePath, ($state | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))

Add-History ([ordered]@{
        at        = (Get-Date).ToString('s')
        round     = $round
        mode      = $Mode
        storage   = $storageMode
        verdict   = $verdict
        critical  = $crit
        important = $imp
        minor     = $min
        files     = $fileCount
        snapshot  = $headRev
        base      = $baseLabel
        head      = $headLabel
        profile   = $Profile
        transport = $transportUsed
        roleMode  = $roleMode
        transportWarning = $transportWarning
        baseCustom = [bool]($baseOverride -and $Mode -eq 'full')
        degraded  = (-not $snapshotOk)
        truncated = $truncated
        report    = $reportPath
        cost_usd  = $costUsd
    })

# 轮次上限：同一模式连续未通过达到 maxRounds 时提示停止自动循环
$roundGuard = Get-RoundGuard $hadFailing
$consecutive = $roundGuard.consecutive
$escalate = $roundGuard.escalate

# ---------------------------------------------------------------- 10. 输出
$exitCode = if ($hadFailing) { 1 } else { 0 }
Write-RunState 'done' 'done' @{ verdict = $verdict; exitCode = $exitCode; durationSec = $durS; costUsd = $costUsd }
if ($Json) {
    [Console]::Out.WriteLine(([ordered]@{
                ok         = $true
                verdict    = $verdict
                critical   = $crit
                important  = $imp
                minor      = $min
                round      = $round
                mode       = $Mode
                storage    = $storageMode
                base       = $baseLabel
                head       = $headLabel
                profile    = $Profile
                transport  = $transportUsed
                roleMode   = $roleMode
                transportWarning = $transportWarning
                truncated  = $truncated
                scopeWarning = $scopeWarning
                report     = $reportPath
                markdown   = $mdPath
                cost_usd   = $costUsd
                consecutive = $consecutive
                escalate   = $escalate
                exitCode   = $exitCode
            } | ConvertTo-Json -Compress))
} else {
    Write-Output "verdict   : $verdict"
    Write-Output "issues    : critical=$crit important=$imp minor=$min"
    Write-Output "summary   : $($review.summary)"
    Write-Output "report    : $reportPath"
    Write-Output "markdown  : $mdPath"
    Write-Output "cost      : $costUsd  duration: ${durS}s"
    if ($hadFailing) {
        Write-Output ''
        Write-Output '必须先处理的问题（修完重跑同一模式）：'
        foreach ($i in @($issues | Where-Object { $failOn -contains [string]$_.severity })) {
            Write-Output ("  [" + $i.severity + "] " + $i.file + ":" + $i.line + " - " + $i.issue)
            Write-Output ("      why: " + $i.why)
            Write-Output ("      fix: " + $i.fix)
        }
    }
    if ($min -gt 0) {
        Write-Output ''
        Write-Output "minor=$min：可批量修或记录结论，不阻塞；但不要假装修了。"
    }
    if ($escalate) {
        Write-Output ''
        Write-Output "升级提示  : $escalate"
    }
}
exit $exitCode
