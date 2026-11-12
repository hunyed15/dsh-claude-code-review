# Engine gate scenarios — no model calls.
# Usage: pwsh -NoProfile -File test/engine-gate.ps1
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
    $dir = Join-Path $env:TEMP ("crc-gate-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    & git -C $dir init -q 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'git init failed' }
    [IO.File]::WriteAllText((Join-Path $dir 'README.md'), "# gate test`n", (New-Object Text.UTF8Encoding($false)))
    & git -C $dir add -A 2>&1 | Out-Null
    & git -C $dir -c user.name=gate-test -c user.email=gate@test commit -qm init 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'git commit failed' }
    return $dir
}

function Get-HeadTree([string]$repo) {
    $tree = (& git -C $repo rev-parse 'HEAD^{tree}' 2>$null)
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($tree)) { throw 'rev-parse HEAD^{tree} failed' }
    return "$tree".Trim()
}

function Initialize-TrellisTask([string]$repo) {
    $taskDir = Join-Path $repo '.trellis/tasks/test'
    New-Item -ItemType Directory -Path $taskDir -Force | Out-Null
    $task = @{ id = 'test'; name = 'test'; title = 'gate test'; status = 'in_progress' } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText((Join-Path $taskDir 'task.json'), $task, (New-Object Text.UTF8Encoding($false)))
    & git -C $repo add '.trellis/tasks/test/task.json' 2>&1 | Out-Null
    & git -C $repo -c user.name=gate-test -c user.email=gate@test commit -qm 'add trellis task' 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'commit trellis task failed' }
}

function Get-ReviewDir([string]$repo, [string]$storage) {
    if ($storage -eq 'trellis') {
        return (Join-Path $repo '.trellis/tasks/test/review')
    }
    return (Join-Path $repo '.dsh/claude-review/ledger/review')
}

function Write-History([string]$repo, [string]$storage, [object[]]$rows) {
    $review = Get-ReviewDir $repo $storage
    New-Item -ItemType Directory -Path $review -Force | Out-Null
    if ($storage -eq 'trellis') {
        $taskDir = Join-Path $repo '.trellis/tasks/test'
        New-Item -ItemType Directory -Path $taskDir -Force | Out-Null
        $task = @{ id = 'test'; name = 'test'; title = 'gate test'; status = 'in_progress' } | ConvertTo-Json -Compress
        [IO.File]::WriteAllText((Join-Path $taskDir 'task.json'), $task, (New-Object Text.UTF8Encoding($false)))
    }
    $lines = @($rows | ForEach-Object { $_ | ConvertTo-Json -Compress })
    [IO.File]::WriteAllText((Join-Path $review 'history.jsonl'), (($lines -join "`n") + "`n"), (New-Object Text.UTF8Encoding($false)))
}

function New-HistoryRow([string]$mode, [string]$verdict, [string]$snapshot, [int]$critical = 0) {
    return [ordered]@{
        at        = (Get-Date).ToString('s')
        round     = 1
        mode      = $mode
        verdict   = $verdict
        critical  = $critical
        important = 0
        minor     = 0
        files     = 1
        snapshot  = $snapshot
        degraded  = $false
        report    = ''
    }
}

function Invoke-Gate([string]$repo, [string]$storage) {
    $out = & pwsh -NoProfile -File $engine -Mode gate -Cwd $repo -Storage $storage -Json 2>&1
    $code = $LASTEXITCODE
    $line = @($out | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1)
    $json = $null
    if ($line.Count -gt 0) {
        try { $json = $line | ConvertFrom-Json } catch { $json = $null }
    }
    return [pscustomobject]@{
        exitCode = $code
        json     = $json
        raw      = ($out -join "`n")
    }
}

function Remove-TestRepo([string]$repo) {
    if ($repo -and (Test-Path -LiteralPath $repo)) {
        Remove-Item -LiteralPath $repo -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# 1. 本地账本：干净工作区、无历史 → pass，且不创建 .trellis
$repo = New-TestRepo
try {
    $result = Invoke-Gate $repo 'auto'
    Check 'G1 本地无历史/干净 → pass' ($result.exitCode -eq 0 -and $result.json.gate -eq 'pass') $result.raw
    Check 'G2 本地模式不创建 .trellis' (-not (Test-Path (Join-Path $repo '.trellis')))
    Check 'G3 本地账本 task.json 已创建' (Test-Path (Join-Path $repo '.dsh/claude-review/ledger/task.json'))
    Check 'G4 gate 结果带 storage=local' ($result.json.storage -eq 'local') $result.raw
} finally { Remove-TestRepo $repo }

# 2. 本地账本：full pass + 快照一致 → pass
$repo = New-TestRepo
try {
    Write-History $repo 'local' @((New-HistoryRow 'full' 'pass' (Get-HeadTree $repo)))
    $result = Invoke-Gate $repo 'local'
    Check 'G5 本地 full pass/快照一致 → pass' ($result.exitCode -eq 0 -and $result.json.gate -eq 'pass') $result.raw
} finally { Remove-TestRepo $repo }

# 3. 本地账本：full pass 但工作区已变 → blocked
$repo = New-TestRepo
try {
    $tree = Get-HeadTree $repo
    Write-History $repo 'local' @((New-HistoryRow 'full' 'pass' $tree))
    Add-Content -LiteralPath (Join-Path $repo 'README.md') -Value 'dirty' -Encoding utf8
    $result = Invoke-Gate $repo 'local'
    Check 'G6 快照不一致 → blocked' ($result.exitCode -eq 1 -and $result.json.gate -eq 'blocked') $result.raw
    Check 'G7 blocked 原因包含快照' (($result.json.reasons -join ' ') -match '快照') $result.raw
} finally { Remove-TestRepo $repo }

# 4. 本地账本：incremental pass 不足以过收尾门禁
$repo = New-TestRepo
try {
    Write-History $repo 'local' @((New-HistoryRow 'incremental' 'pass' (Get-HeadTree $repo)))
    $result = Invoke-Gate $repo 'local'
    Check 'G8 incremental pass → blocked' ($result.exitCode -eq 1 -and $result.json.gate -eq 'blocked') $result.raw
    Check 'G9 blocked 原因要求 full' (($result.json.reasons -join ' ') -match 'full') $result.raw
} finally { Remove-TestRepo $repo }

# 5. 本地账本：full fix → blocked
$repo = New-TestRepo
try {
    Write-History $repo 'local' @((New-HistoryRow 'full' 'fix' (Get-HeadTree $repo) 1))
    $result = Invoke-Gate $repo 'local'
    Check 'G10 full fix → blocked' ($result.exitCode -eq 1 -and $result.json.gate -eq 'blocked') $result.raw
} finally { Remove-TestRepo $repo }

# 6. 本地账本：history 损坏 → fail-closed
$repo = New-TestRepo
try {
    $review = Get-ReviewDir $repo 'local'
    New-Item -ItemType Directory -Path $review -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $review 'history.jsonl'), "{bad`n", (New-Object Text.UTF8Encoding($false)))
    $result = Invoke-Gate $repo 'local'
    Check 'G11 history 损坏 → blocked' ($result.exitCode -eq 1 -and $result.json.gate -eq 'blocked') $result.raw
    Check 'G12 blocked 原因包含不可解析' (($result.json.reasons -join ' ') -match '不可解析') $result.raw
} finally { Remove-TestRepo $repo }

# 7. 本地账本：有未审改动且无历史 → blocked
$repo = New-TestRepo
try {
    Add-Content -LiteralPath (Join-Path $repo 'README.md') -Value 'dirty no history' -Encoding utf8
    $result = Invoke-Gate $repo 'local'
    Check 'G13 有改动且无历史 → blocked' ($result.exitCode -eq 1 -and $result.json.gate -eq 'blocked') $result.raw
} finally { Remove-TestRepo $repo }

# 8. Trellis：full pass + 快照一致 → pass
$repo = New-TestRepo
try {
    Initialize-TrellisTask $repo
    $tree = Get-HeadTree $repo
    Write-History $repo 'trellis' @((New-HistoryRow 'full' 'pass' $tree))
    $result = Invoke-Gate $repo 'trellis'
    Check 'G14 Trellis full pass → pass' ($result.exitCode -eq 0 -and $result.json.gate -eq 'pass') $result.raw
    Check 'G15 Trellis 结果带 storage=trellis' ($result.json.storage -eq 'trellis') $result.raw
} finally { Remove-TestRepo $repo }

# 9. 显式 storage=trellis 但仓库没有 .trellis → exit 2
$repo = New-TestRepo
try {
    $result = Invoke-Gate $repo 'trellis'
    Check 'G16 缺 .trellis 的显式 trellis → exit 2' ($result.exitCode -eq 2) $result.raw
    Check 'G17 错误信息可诊断' ($result.raw -match '\.trellis') $result.raw
} finally { Remove-TestRepo $repo }

Write-Host ''
Write-Host "结果: passed=$passed failed=$failed"
foreach ($failure in $failures) { Write-Host "  FAIL $failure" }
if ($failed -gt 0) { exit 1 }
exit 0
