# Engine round guard — a new review must not start while the previous round's
# blocking findings are still undisposed. No model calls (all runs -DryRun).
# Usage: pwsh -NoProfile -File test/engine-round-guard.ps1
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }

$packageRoot = Split-Path $PSScriptRoot -Parent
$engine = Join-Path $packageRoot 'scripts/Invoke-ClaudeReview.ps1'
if (-not (Test-Path -LiteralPath $engine)) { throw "engine not found: $engine" }

$passed = 0
$failed = 0
$failures = @()

function Check([string]$name, [bool]$condition, [string]$detail = '') {
    if ($condition) {
        $script:passed++
        Write-Host "PASS  $name"
    } else {
        $script:failed++
        $script:failures += "$name$(if ($detail) { " — $detail" })"
        Write-Host "FAIL  $name$(if ($detail) { " — $detail" })"
    }
}

function New-TestRepo {
    $dir = Join-Path $env:TEMP ("crc-guard-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    & git -C $dir init -q 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'git init failed' }
    [IO.File]::WriteAllText((Join-Path $dir 'README.md'), "# guard test`n", (New-Object Text.UTF8Encoding($false)))
    & git -C $dir add -A 2>&1 | Out-Null
    & git -C $dir -c user.name=guard-test -c user.email=guard@test commit -qm init 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'git commit failed' }
    # 有 diff，-DryRun 才会走到“计划”分支；guard 必须在 diff 之前就拦住。
    [IO.File]::WriteAllText((Join-Path $dir 'change.txt'), "change`n", (New-Object Text.UTF8Encoding($false)))
    return $dir
}

function Get-ReviewDir([string]$repo) {
    return (Join-Path $repo '.dsh/claude-review/ledger/review')
}

function Write-Task([string]$repo) {
    $ledger = Join-Path $repo '.dsh/claude-review/ledger'
    New-Item -ItemType Directory -Path $ledger -Force | Out-Null
    $task = @{ id = 'local'; name = 'local'; title = 'guard test'; status = 'in_progress' } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText((Join-Path $ledger 'task.json'), $task, (New-Object Text.UTF8Encoding($false)))
}

function Write-Report([string]$repo, [int]$round, [string]$verdict, [object[]]$issues, [string[]]$failOn = @()) {
    $review = Get-ReviewDir $repo
    New-Item -ItemType Directory -Path $review -Force | Out-Null
    $meta = [ordered]@{ round = $round; mode = 'full'; reviewed_at = '2026-11-13T10:00:00' }
    if ($failOn.Count -gt 0) { $meta.failOn = @($failOn) }
    $report = [ordered]@{
        meta   = $meta
        review = [ordered]@{ verdict = $verdict; summary = 'guard fixture'; issues = @($issues) }
    }
    $path = Join-Path $review "review-$round.json"
    [IO.File]::WriteAllText($path, ($report | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding($false)))
    return $path
}

function Write-State([string]$repo, [int]$round, [string]$report, [string]$verdict = 'fix') {
    $review = Get-ReviewDir $repo
    $state = [ordered]@{
        round         = $round
        lastSnapshot  = ''
        lastMode      = 'full'
        lastVerdict   = $verdict
        lastInputHash = ''
        lastReport    = $report
        updatedAt     = '2026-11-13T10:00:00'
    }
    [IO.File]::WriteAllText((Join-Path $review 'state.json'), ($state | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
}

function Write-History([string]$repo, [int]$round, [string]$report, [string]$verdict = 'fix') {
    $review = Get-ReviewDir $repo
    $row = [ordered]@{
        at = '2026-11-13T10:00:00'; round = $round; mode = 'full'; verdict = $verdict
        critical = if ($verdict -eq 'fix') { 1 } else { 0 }; important = 0; minor = 0; files = 1
        snapshot = ''; base = 'HEAD'; head = 'worktree'; profile = ''
        baseCustom = $false; degraded = $false; truncated = $false
        report = $report; cost_usd = $null
    }
    [IO.File]::WriteAllText((Join-Path $review 'history.jsonl'), (($row | ConvertTo-Json -Compress) + "`n"), (New-Object Text.UTF8Encoding($false)))
}

function Write-Dispositions([string]$repo, [object[]]$rows) {
    $review = Get-ReviewDir $repo
    $lines = @($rows | ForEach-Object { $_ | ConvertTo-Json -Compress })
    [IO.File]::WriteAllText((Join-Path $review 'dispositions.jsonl'), (($lines -join "`n") + "`n"), (New-Object Text.UTF8Encoding($false)))
}

function Invoke-Engine([string]$repo, [string]$mode = 'full', [switch]$DryRun, [string]$Base = '') {
    $argv = @('-NoProfile', '-File', $engine, '-Mode', $mode, '-Cwd', $repo, '-Storage', 'local', '-Json')
    if ($DryRun) { $argv += '-DryRun' }
    if ($Base) { $argv += @('-Base', $Base) }
    $out = & pwsh @argv 2>&1
    $code = $LASTEXITCODE
    return [pscustomobject]@{ Code = $code; Text = (($out | ForEach-Object { "$_" }) -join "`n") }
}

function New-Critical([string]$key = 'k1') {
    return [ordered]@{ key = $key; severity = 'critical'; file = 'a.js'; line = '1'; issue = '空指针'; why = '会崩'; fix = '判空' }
}

$repo = New-TestRepo
try {
    Write-Task $repo
    $report = Write-Report $repo 1 'fix' @((New-Critical))
    Write-State $repo 1 $report
    Write-History $repo 1 $report

    # 1. 未处置：新 review 必须被拒绝，且提示可执行。
    $r = Invoke-Engine $repo 'full' -DryRun
    Check 'G1 未处置 blocking → 拒绝新 review' ($r.Code -eq 2) $r.Text
    Check 'G2 拒绝信息包含「未处置」' ($r.Text -match '未处置') $r.Text
    Check 'G3 拒绝信息指向 claude_review_disposition' ($r.Text -match 'claude_review_disposition') $r.Text

    # 2. fixed：允许进入复检。
    Write-Dispositions $repo @([ordered]@{ round = 1; key = 'k1'; status = 'fixed'; note = '已判空' })
    $r = Invoke-Engine $repo 'full' -DryRun
    Check 'G4 fixed → 允许复检' ($r.Code -ne 2) $r.Text
    Check 'G5 fixed → 真的走到 DryRun' ($r.Text -match 'dryRun') $r.Text

    # 3. deferred / counter-evidence 也是处置。
    Write-Dispositions $repo @([ordered]@{ round = 1; key = 'k1'; status = 'deferred'; note = '接受风险' })
    Check 'G6 deferred → 允许复检' ((Invoke-Engine $repo 'full' -DryRun).Code -ne 2)
    Write-Dispositions $repo @([ordered]@{ round = 1; key = 'k1'; status = 'counter-evidence'; note = '误报' })
    Check 'G7 counter-evidence → 允许复检' ((Invoke-Engine $repo 'full' -DryRun).Code -ne 2)

    # 4. index 也能定位（key 为空时）。
    $report2 = Write-Report $repo 1 'fix' @(@([ordered]@{ key = ''; severity = 'critical'; file = 'a.js'; line = '1'; issue = 'x'; why = 'y'; fix = 'z' }))
    Write-State $repo 1 $report2
    Write-History $repo 1 $report2
    Write-Dispositions $repo @([ordered]@{ round = 1; key = ''; index = 0; status = 'fixed' })
    Check 'G8 index 处置 → 允许复检' ((Invoke-Engine $repo 'full' -DryRun).Code -ne 2)

    # 5. 跨轮处置不算：round 2 的 fixed 不能给 round 1 洗白。
    Write-Dispositions $repo @([ordered]@{ round = 2; key = 'k1'; status = 'fixed' })
    Check 'G9 跨轮处置 → 仍然拒绝' ((Invoke-Engine $repo 'full' -DryRun).Code -eq 2)

    # 6. minor 不阻断。
    $minorReport = Write-Report $repo 1 'pass' @(@([ordered]@{ key = 'm1'; severity = 'minor'; file = 'b.js'; line = '2'; issue = '文案'; why = 'y'; fix = 'z' }))
    Write-State $repo 1 $minorReport 'pass'
    Write-History $repo 1 $minorReport 'pass'
    Check 'G10 只有 minor → 允许复检' ((Invoke-Engine $repo 'full' -DryRun).Code -ne 2)

    # 7. 上一轮 pass / 无报告都不阻断。
    $passReport = Write-Report $repo 1 'pass' @()
    Write-State $repo 1 $passReport 'pass'
    Write-History $repo 1 $passReport 'pass'
    Check 'G11 上一轮 pass → 允许复检' ((Invoke-Engine $repo 'full' -DryRun).Code -ne 2)
    Write-State $repo 1 '' 'pass'
    Check 'G12 没有 lastReport → 允许复检' ((Invoke-Engine $repo 'full' -DryRun).Code -ne 2)

    # 8. gate 不受这条守卫影响（它不调模型；只读 history）。
    #    重新写一份带 critical 的报告：G10/G11 已把 review-1.json 覆盖成 pass 空报告。
    $report = Write-Report $repo 1 'fix' @((New-Critical))
    Write-State $repo 1 $report
    Write-History $repo 1 $report
    Write-Dispositions $repo @([ordered]@{ round = 1; key = 'k1'; status = 'fixed' })
    $gate = Invoke-Engine $repo 'gate'
    Check 'G13 gate 不被轮次守卫拦截' ($gate.Text -notmatch '未处置') $gate.Text
    Check 'G14 gate 仍按自己的门禁语义返回' ($gate.Code -eq 1 -and $gate.Text -match 'blocked') $gate.Text

    # 9. range 也受守卫约束。
    Write-Dispositions $repo @()
    $range = Invoke-Engine $repo 'range' -DryRun -Base 'HEAD'
    Check 'G15 range 未处置 → 拒绝' ($range.Code -eq 2) $range.Text

    # 10. index 按 review-N.json 的原始下标对齐；前面有 null 也不能整体前移。
    $nullReport = Write-Report $repo 1 'fix' @($null, (New-Critical))
    Write-State $repo 1 $nullReport
    Write-History $repo 1 $nullReport
    Write-Dispositions $repo @([ordered]@{ round = 1; index = 1; status = 'fixed' })
    Check 'G16 null 前置时 index 仍按原始下标' ((Invoke-Engine $repo 'full' -DryRun).Code -ne 2)

    # 11. blocking 用报告自身的 failOn，而不是当前配置（配置变更不能让旧报告 fail-open）。
    $important = [ordered]@{ key = 'i1'; severity = 'important'; file = 'b.js'; line = '2'; issue = '重要问题'; why = 'y'; fix = 'z' }
    $report = Write-Report $repo 1 'fix' @($important) @('critical')
    Write-State $repo 1 $report
    Write-History $repo 1 $report
    Write-Dispositions $repo @()
    Check 'G17 守卫按报告 failOn（important 不阻断）' ((Invoke-Engine $repo 'full' -DryRun).Code -ne 2)

    # 12. nothing-to-review 不能清空 lastReport，否则一次空轮就能绕过 V2。
    $review1 = Write-Report $repo 1 'fix' @((New-Critical))
    Write-State $repo 1 $review1
    Write-History $repo 1 $review1
    Write-Dispositions $repo @([ordered]@{ round = 1; key = 'k1'; status = 'fixed' })
    Remove-Item -LiteralPath (Join-Path $repo 'change.txt') -Force -ErrorAction SilentlyContinue
    $nothing = Invoke-Engine $repo 'full' -DryRun
    Check 'G18 nothing-to-review 允许（已处置）' ($nothing.Code -ne 2) $nothing.Text
    $state = Get-Content -LiteralPath (Join-Path (Get-ReviewDir $repo) 'state.json') -Raw | ConvertFrom-Json
    Check 'G19 nothing-to-review 不清空 lastReport' ([string]$state.lastReport -eq $review1) ([string]$state.lastReport)

    # 13. nothing 之后仍未处置，下一轮继续拒绝。
    [IO.File]::WriteAllText((Join-Path $repo 'change.txt'), "change`n", (New-Object Text.UTF8Encoding($false)))
    Write-Dispositions $repo @()
    Check 'G20 nothing 之后未处置 → 仍拒绝' ((Invoke-Engine $repo 'full' -DryRun).Code -eq 2)

    # 14. nothing 之后保留 round=1 的 fixed，真实复检必须放行：轮次号以报告为准，不能用 state.round。
    Write-Dispositions $repo @([ordered]@{ round = 1; key = 'k1'; status = 'fixed' })
    Check 'G21 nothing 后 fixed(round=1) → 复检放行' ((Invoke-Engine $repo 'full' -DryRun).Code -ne 2)
} finally {
    Remove-Item -LiteralPath $repo -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host "结果: passed=$passed failed=$failed"
foreach ($failure in $failures) { Write-Host "  FAIL $failure" }
exit $(if ($failed -gt 0) { 1 } else { 0 })
