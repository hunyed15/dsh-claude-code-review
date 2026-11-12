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
    incremental（默认）| full | gate
      incremental : 自上次审核快照以来的改动
      full        : 相对 HEAD 的全部未提交改动
      gate        : 只读本地 state/history，判断「收尾全量审核是否已 pass」，不调模型

.PARAMETER Cwd
    仓库目录，默认当前目录。

.PARAMETER TaskDir
    Trellis 任务目录。留空则用 `task.py current`；无活跃任务时用 .trellis/tasks/_adhoc。

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
    内联进 prompt 的 diff 上限，超出部分写 patch 文件，默认取 config.json（40000）。

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
#>
[CmdletBinding()]
param(
    [ValidateSet('incremental', 'full', 'gate')]
    [string]$Mode = 'incremental',
    [string]$Cwd = '',
    [ValidateSet('auto', 'trellis', 'local')]
    [string]$Storage = 'auto',
    [string]$TaskDir = '',
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
    maxDiffChars     = 40000
    maxRounds        = 3
    failOn           = @('critical', 'important')
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
$failOn = @($cfg.failOn)

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
    $gitRoot = Push-Location $root
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
    } finally { Pop-Location }

    # 2) `task.py current` 依赖会话身份；Host 进程（插件/工具调用）里通常没有这个身份，
    #    于是会退化。这里按「审核记录最新」再按「in_progress」兜底，避免所有报告被写进 _adhoc。
    $tasksRoot = Join-Path $root '.trellis/tasks'
    if (Test-Path -LiteralPath $tasksRoot) {
        $skip = @('archive', '_adhoc', '_gatetest')
        $best = $null
        foreach ($d in (Get-ChildItem -LiteralPath $tasksRoot -Directory -ErrorAction SilentlyContinue)) {
            if ($skip -contains $d.Name) { continue }
            $h = Join-Path $d.FullName 'review/history.jsonl'
            if (Test-Path -LiteralPath $h) {
                $t = (Get-Item -LiteralPath $h).LastWriteTimeUtc
                if (-not $best -or $t -gt $best.time) { $best = @{ dir = $d.FullName; time = $t } }
            }
        }
        if ($best) { return $best.dir }

        $inProgress = @()
        foreach ($d in (Get-ChildItem -LiteralPath $tasksRoot -Directory -ErrorAction SilentlyContinue)) {
            if ($skip -contains $d.Name) { continue }
            $tj = Join-Path $d.FullName 'task.json'
            if (-not (Test-Path -LiteralPath $tj)) { continue }
            try {
                $j = Get-Content -LiteralPath $tj -Raw | ConvertFrom-Json
                if ("$($j.status)" -eq 'in_progress') {
                    $inProgress += @{ dir = $d.FullName; time = (Get-Item -LiteralPath $tj).LastWriteTimeUtc }
                }
            } catch { }
        }
        if ($inProgress.Count -gt 0) {
            return ($inProgress | Sort-Object { $_.time } -Descending | Select-Object -First 1).dir
        }
    }

    # 3) 实在没有 Trellis 任务时才用 _adhoc
    $adhoc = Join-Path $root '.trellis/tasks/_adhoc'
    New-Item -ItemType Directory -Path $adhoc -Force | Out-Null
    return $adhoc
}

function Get-LocalLedgerDir {
    return (Join-Path $root '.dsh/claude-review/ledger')
}

function Initialize-LocalLedger([string]$dir) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
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

$state = @{ round = 0; lastSnapshot = ''; lastMode = ''; lastVerdict = ''; updatedAt = '' }
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
        if ($ex.Count -gt 0) {
            & git -C $repoRoot add -A -- . @ex 2>&1 | Out-Null
        } else {
            & git -C $repoRoot add -A 2>&1 | Out-Null
        }
        if ($LASTEXITCODE -ne 0) { throw 'git add -A 失败（临时索引）' }
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
# 快照只排除「审核产物」：否则写报告本身会改变快照，导致 gate 误判「工作区又变了」。
# 注意不要把这些路径加进快照排除表：.gitignore 已忽略的目录作为 pathspec 传给 git add 会报错。
$snapshotExcludes = @($cfg.snapshotExcludePathspecs | Where-Object { $_ })
if ($snapshotExcludes.Count -eq 0) { $snapshotExcludes = @(':(exclude).trellis/tasks/*/review/**') }
try { $curTree = Get-WorktreeTree $root $snapshotExcludes } catch {
    $snapshotOk = $false
    Write-Info "快照降级：$($_.Exception.Message)。改用工作区直读。"
}

$headSha = (& git -C $root rev-parse --verify HEAD 2>$null)
$headSha = if ($headSha) { "$headSha".Trim() } else { '' }

# ---------------------------------------------------------------- 4. 计算 diff 范围
$baseRev = ''
$baseLabel = ''
if ($Mode -eq 'full') {
    $baseRev = if ($headSha) { $headSha } else { '4b825dc642cb6eb9a060e54bf8d69288fbee4904' }
    $baseLabel = if ($headSha) { "HEAD ($headSha)" } else { '(空树)' }
} elseif ($state.lastSnapshot) {
    $baseRev = [string]$state.lastSnapshot
    $baseLabel = "上次审核快照 ($($baseRev.Substring(0, [Math]::Min(12, $baseRev.Length))))"
} else {
    $baseRev = if ($headSha) { $headSha } else { '4b825dc642cb6eb9a060e54bf8d69288fbee4904' }
    $baseLabel = if ($headSha) { "HEAD ($headSha) [首次审核，范围=全部未提交改动]" } else { '(空树) [首次审核]' }
}

$headRev = if ($snapshotOk -and $curTree) { $curTree } else { '' }
$excludes = @($cfg.excludePathspecs | Where-Object { $_ })

function Invoke-GitDiff([string[]]$extraArgs) {
    $a = @('-C', $root, 'diff', '--no-color') + $extraArgs
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
        $cleanPass = (-not $last) -or (
            [string]$last.mode -eq 'full' -and
            (@('pass', 'nothing-to-review') -contains [string]$last.verdict) -and
            (-not (($last.PSObject.Properties.Name -contains 'degraded') -and $last.degraded)) -and
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
    if (-not $last) { $reasons += '还有未审改动，且没有任何审核记录' }
    else {
        if ([string]$last.mode -ne 'full') { $reasons += "最近一次审核是 $($last.mode) 模式，收尾门禁要求 full" }
        if ([string]$last.verdict -ne 'pass') { $reasons += "最近一次审核结论是 $($last.verdict)" }
        if ([string]$last.snapshot -ne [string]$headRev) {
            $reasons += '最近一次审核的快照与当前工作区不一致（含「上次审核在快照降级下运行、未覆盖未跟踪文件」的情况），需要重跑 -Mode full'
        }
        if (($last.PSObject.Properties.Name -contains 'degraded') -and $last.degraded) {
            $reasons += '上次审核在快照降级下运行，未覆盖未跟踪文件，需在索引可写时重跑 -Mode full'
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
            degraded  = (-not $snapshotOk)
            report    = ''
            cost_usd  = $null
        })
    $state.round = $cleanRound
    $state.lastMode = $Mode
    $state.lastVerdict = 'nothing-to-review'
    $state.updatedAt = (Get-Date).ToString('s')
    if ($snapshotOk -and $headRev) { $state.lastSnapshot = $headRev }
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
Head: $(if ($headRev) { "工作区快照 $($headRev.Substring(0,[Math]::Min(12,$headRev.Length)))" } else { '工作区（快照降级）' })
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
9. 按下面 JSON 结构输出**一个 JSON 对象**，不要 markdown 围栏、不要前后解释文字。

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

if ($DryRun) {
    $summary = [ordered]@{
        ok          = $true
        dryRun      = $true
        mode        = $Mode
        storage     = $storageMode
        task        = $taskName
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
$proc = Start-Process -FilePath $claudeExe -ArgumentList $cliArgs `
    -RedirectStandardInput $promptIn -RedirectStandardOutput $outFile -RedirectStandardError $errFile `
    -NoNewWindow -PassThru
Write-RunState 'running' 'reviewing' @{ pid = $proc.Id }
$timedOut = $false
# 用 WaitForExit(5000) 做阻塞式探测：返回值会刷新进程状态，避免 HasExited 缓存误判；
# 每次 5s 超时后再写心跳，既保留进度又不丢正常退出。
while (-not $proc.WaitForExit(5000)) {
    if ($sw.Elapsed.TotalSeconds -ge $TimeoutSec) {
        $timedOut = $true
        try { $proc.Kill() } catch { }
        break
    }
    Write-RunState 'running' 'reviewing' @{ pid = $proc.Id; elapsedSec = [int]$sw.Elapsed.TotalSeconds }
}
if ($timedOut) {
    $sw.Stop()
    Get-ChildItem $runDir -File -ErrorAction SilentlyContinue | Copy-Item -Destination $OutDir -Force -ErrorAction SilentlyContinue
    Fail "审核超时（>${TimeoutSec}s）。可调大 -TimeoutSec、调小 -MaxDiffChars，或用 -Paths 缩小范围。"
}
$sw.Stop()

$rawOut = if (Test-Path -LiteralPath $outFile) { [IO.File]::ReadAllText($outFile) } else { '' }
$rawErr = if (Test-Path -LiteralPath $errFile) { [IO.File]::ReadAllText($errFile) } else { '' }
$rawPath = Join-Path $OutDir ("raw-$round.json")
[IO.File]::WriteAllText($rawPath, $rawOut, (New-Object Text.UTF8Encoding($false)))
Get-ChildItem $runDir -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
Remove-Item $runDir -Recurse -Force -ErrorAction SilentlyContinue

$procExit = if ($null -ne $proc.ExitCode) { [int]$proc.ExitCode } else { 0 }
if ([string]::IsNullOrWhiteSpace($rawOut)) {
    Fail ("claude 无输出（退出码 $procExit）。stderr: " + $rawErr.Substring(0, [Math]::Min(600, $rawErr.Length)))
}

# ---------------------------------------------------------------- 8. 解析
$envelope = $null
try { $envelope = $rawOut | ConvertFrom-Json } catch { $envelope = $null }

# 执行器故障优先判定：非零退出或错误 envelope 一律 exit 2，绝不当成审核结论
if ($procExit -ne 0) {
    Fail ("claude 非零退出（$procExit）。stderr: " + $rawErr.Substring(0, [Math]::Min(600, $rawErr.Length)) + " raw: $rawPath")
}
if ($envelope -and ((($envelope.PSObject.Properties.Name -contains 'is_error') -and $envelope.is_error) -or (($envelope.PSObject.Properties.Name -contains 'type') -and [string]$envelope.type -eq 'error'))) {
    Fail ("claude 返回错误结果（subtype=$($envelope.subtype), status=$($envelope.api_error_status)）。raw: $rawPath")
}

$resultText = if ($envelope -and $envelope.PSObject.Properties.Name -contains 'result') { [string]$envelope.result } else { $rawOut }
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
$state.updatedAt = (Get-Date).ToString('s')
if ($snapshotOk -and $headRev) { $state.lastSnapshot = $headRev }
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
        degraded  = (-not $snapshotOk)
        report    = $reportPath
        cost_usd  = $costUsd
    })

# 轮次上限：同一模式连续未通过达到 maxRounds 时提示停止自动循环
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
