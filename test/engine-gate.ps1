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

# 0. 能力握手：插件靠这个标记决定是否复用目标仓库引擎；旧引擎没有 -Capabilities。
$capRaw = & pwsh -NoProfile -File $engine -Capabilities 2>$null
$cap = $null
try { $cap = ($capRaw | Out-String) | ConvertFrom-Json } catch { }
Check 'CAP1 -Capabilities 输出 api=3' ($null -ne $cap -and [int]$cap.api -eq 3) ($capRaw | Out-String)
Check 'CAP2 -Capabilities 声明 local storage' ($null -ne $cap -and (@($cap.storage) -contains 'local'))
Check 'CAP3 -Capabilities 声明 transport' ($null -ne $cap -and (@($cap.transport) -contains 'acp') -and (@($cap.transport) -contains 'cli'))

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

function New-HistoryRow([string]$mode, [string]$verdict, [string]$snapshot, [int]$critical = 0, [bool]$truncated = $false, [bool]$baseCustom = $false) {
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
        truncated = $truncated
        baseCustom = $baseCustom
        report    = ''
    }
}

function Invoke-Gate([string]$repo, [string]$storage, [string]$taskDir = '') {
    $engineArgs = @('-NoProfile', '-File', $engine, '-Mode', 'gate', '-Cwd', $repo, '-Storage', $storage, '-Json')
    if ($taskDir) { $engineArgs += @('-TaskDir', $taskDir) }
    $out = & pwsh @engineArgs 2>&1
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

# 1. 本地账本：干净工作区、无历史 → blocked（干净 ≠ 已审核，不能 fail-open）
$repo = New-TestRepo
try {
    $result = Invoke-Gate $repo 'auto'
    Check 'G1 本地无历史/干净 → blocked（不能把没跑过当 pass）' ($result.exitCode -eq 1 -and $result.json.gate -eq 'blocked') $result.raw
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
    $result = Invoke-Gate $repo 'trellis' (Join-Path $repo '.trellis/tasks/test')
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

# 10. Trellis 有任务/历史但没有活动任务身份：不得按 history 猜，必须 exit 2
$repo = New-TestRepo
try {
    Initialize-TrellisTask $repo
    $tree = Get-HeadTree $repo
    Write-History $repo 'trellis' @((New-HistoryRow 'full' 'pass' $tree))
    $engineArgs = @('-NoProfile', '-File', $engine, '-Mode', 'gate', '-Cwd', $repo, '-Storage', 'trellis', '-Json')
    $out = & pwsh @engineArgs 2>&1
    $code = $LASTEXITCODE
    Check 'G18 无活动任务不按 history 猜 → exit 2' ($code -eq 2) ($out -join "`n")
    Check 'G19 提示显式 taskDir' (($out -join "`n") -match 'taskDir|TaskDir|任务目录') ($out -join "`n")
} finally { Remove-TestRepo $repo }

# 11. 插件 SessionId 通过 DSH_SESSION_ID 交给 task.py current，解析出任务
$repo = New-TestRepo
try {
    $taskDir = Join-Path $repo '.trellis/tasks/test'
    New-Item -ItemType Directory -Path $taskDir -Force | Out-Null
    $task = @{ id = 'test'; name = 'test'; title = 'gate test'; status = 'planning' } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText((Join-Path $taskDir 'task.json'), $task, (New-Object Text.UTF8Encoding($false)))
    $scripts = Join-Path $repo '.trellis/scripts'
    New-Item -ItemType Directory -Path $scripts -Force | Out-Null
    $fake = @'
import os, sys
if sys.argv[1:2] == ["current"] and os.environ.get("DSH_SESSION_ID") == "sess-test":
    print("Current task: .trellis/tasks/test")
else:
    print("(none)")
'@
    [IO.File]::WriteAllText((Join-Path $scripts 'task.py'), $fake, (New-Object Text.UTF8Encoding($false)))
    Add-Content -LiteralPath (Join-Path $repo 'README.md') -Value 'changed' -Encoding utf8
    $engineArgs = @('-NoProfile', '-File', $engine, '-Mode', 'full', '-Cwd', $repo, '-Storage', 'trellis', '-SessionId', 'sess-test', '-DryRun', '-Json')
    $out = & pwsh @engineArgs 2>&1
    $json = $null
    try { $json = (@($out | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1) | Out-String) | ConvertFrom-Json } catch { }
    Check 'G20 SessionId → task.py current 解析任务' ($null -ne $json -and [string]$json.task -eq 'test') ($out -join "`n")
} finally { Remove-TestRepo $repo }

# 12. range：评审已提交区间（HEAD~1..HEAD），不需要 soft reset
$repo = New-TestRepo
try {
    Add-Content -LiteralPath (Join-Path $repo 'README.md') -Value 'range change' -Encoding utf8
    & git -C $repo add -A 2>&1 | Out-Null
    & git -C $repo -c user.name=gate-test -c user.email=gate@test commit -qm 'range change' 2>&1 | Out-Null
    $engineArgs = @('-NoProfile', '-File', $engine, '-Mode', 'range', '-Cwd', $repo, '-Storage', 'local', '-Base', 'HEAD~1', '-DryRun', '-Json')
    $out = & pwsh @engineArgs 2>&1
    $json = $null
    try { $json = (@($out | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1) | Out-String) | ConvertFrom-Json } catch { }
    Check 'G21 range 解析提交区间' ($null -ne $json -and [string]$json.mode -eq 'range') ($out -join "`n")
    Check 'G22 range 有 1 个文件' ($null -ne $json -and [int]$json.files -eq 1) ($out -join "`n")
    Check 'G23 range 的 base/head 标签可用' ($null -ne $json -and [string]$json.base -match 'Base HEAD~1' -and [string]$json.head -match 'HEAD') ($out -join "`n")
} finally { Remove-TestRepo $repo }

# 13. range 必须显式给 Base
$repo = New-TestRepo
try {
    $engineArgs = @('-NoProfile', '-File', $engine, '-Mode', 'range', '-Cwd', $repo, '-Storage', 'local', '-DryRun', '-Json')
    $out = & pwsh @engineArgs 2>&1
    Check 'G24 range 缺 Base → exit 2' ($LASTEXITCODE -eq 2) ($out -join "`n")
    Check 'G25 range 缺 Base 的提示可诊断' (($out -join "`n") -match 'Base') ($out -join "`n")
} finally { Remove-TestRepo $repo }

# 14. full -Base 也能审已提交区间（工作区干净）
$repo = New-TestRepo
try {
    Add-Content -LiteralPath (Join-Path $repo 'README.md') -Value 'committed change' -Encoding utf8
    & git -C $repo add -A 2>&1 | Out-Null
    & git -C $repo -c user.name=gate-test -c user.email=gate@test commit -qm 'committed change' 2>&1 | Out-Null
    $engineArgs = @('-NoProfile', '-File', $engine, '-Mode', 'full', '-Cwd', $repo, '-Storage', 'local', '-Base', 'HEAD~1', '-DryRun', '-Json')
    $out = & pwsh @engineArgs 2>&1
    $json = $null
    try { $json = (@($out | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1) | Out-String) | ConvertFrom-Json } catch { }
    Check 'G26 full -Base 包含已提交改动' ($null -ne $json -and [int]$json.files -eq 1 -and [string]$json.base -match 'Base HEAD~1') ($out -join "`n")
} finally { Remove-TestRepo $repo }

# 15b. 自定义 -Base 的 full 不能冒充收尾门禁的普通 full
$repo = New-TestRepo
try {
    $tree = Get-HeadTree $repo
    Write-History $repo 'local' @((New-HistoryRow 'full' 'pass' $tree 0 $false $true))
    $result = Invoke-Gate $repo 'local'
    Check 'G33 full -Base → gate blocked' ($result.exitCode -eq 1 -and $result.json.gate -eq 'blocked') $result.raw
    Check 'G34 自定义 Base 原因可诊断' ($result.raw -match 'Base') $result.raw
} finally { Remove-TestRepo $repo }

# 15c. gate 忽略 -Base；非 range 的 -Head 必须拒绝
$repo = New-TestRepo
try {
    $engineArgs = @('-NoProfile', '-File', $engine, '-Mode', 'gate', '-Cwd', $repo, '-Storage', 'local', '-Base', 'not-a-rev', '-Json')
    $out = & pwsh @engineArgs 2>&1
    $json = $null
    try { $json = (@($out | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1) | Out-String) | ConvertFrom-Json } catch { }
    Check 'G35 gate 忽略非法 -Base（不因 Base 参数报错）' ($LASTEXITCODE -ne 2 -and $null -ne $json -and $json.gate -in @('pass', 'blocked')) ($out -join "`n")

    $engineArgs = @('-NoProfile', '-File', $engine, '-Mode', 'full', '-Cwd', $repo, '-Storage', 'local', '-Head', 'HEAD', '-DryRun', '-Json')
    $out = & pwsh @engineArgs 2>&1
    Check 'G36 非 range 传 -Head → exit 2' ($LASTEXITCODE -eq 2) ($out -join "`n")
    Check 'G37 -Head 错误提示可诊断' (($out -join "`n") -match 'Head|range') ($out -join "`n")
} finally { Remove-TestRepo $repo }

# 15d. scope 的 dotfile 路径不能被 TrimStart('./') 吃掉
$repo = New-TestRepo
try {
    $dotDir = Join-Path $repo '.trellis'
    New-Item -ItemType Directory -Path $dotDir -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $dotDir 'foo.md'), "# dot`n", (New-Object Text.UTF8Encoding($false)))
    & git -C $repo add -A 2>&1 | Out-Null
    & git -C $repo -c user.name=gate-test -c user.email=gate@test commit -qm 'add dotfile' 2>&1 | Out-Null
    Add-Content -LiteralPath (Join-Path $repo 'README.md') -Value 'dot scope' -Encoding utf8
    $engineArgs = @('-NoProfile', '-File', $engine, '-Mode', 'full', '-Cwd', $repo, '-Storage', 'local', '-Description', '修改 .trellis/foo.md', '-DryRun', '-Json')
    $out = & pwsh @engineArgs 2>&1
    Check 'G38 dotfile scope 不一致 → exit 2' ($LASTEXITCODE -eq 2) ($out -join "`n")
    Check 'G39 dotfile scope 原因可诊断' (($out -join "`n") -match 'scope 不一致') ($out -join "`n")
} finally { Remove-TestRepo $repo }

# 15e. scope 支持 Windows 绝对路径与无扩展名文件（不能 fail-open）
$repo = New-TestRepo
try {
    $src = Join-Path $repo 'src'
    New-Item -ItemType Directory -Path $src -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $src 'a.ts'), "export const a = 1`n", (New-Object Text.UTF8Encoding($false)))
    [IO.File]::WriteAllText((Join-Path $repo 'Makefile'), "all:`n`t@echo ok`n", (New-Object Text.UTF8Encoding($false)))
    & git -C $repo add -A 2>&1 | Out-Null
    & git -C $repo -c user.name=gate-test -c user.email=gate@test commit -qm 'add scope files' 2>&1 | Out-Null
    Add-Content -LiteralPath (Join-Path $repo 'README.md') -Value 'scope path test' -Encoding utf8
    $absPath = (Join-Path $src 'a.ts')
    $engineArgs = @('-NoProfile', '-File', $engine, '-Mode', 'full', '-Cwd', $repo, '-Storage', 'local', '-Description', "修改 $absPath", '-DryRun', '-Json')
    $out = & pwsh @engineArgs 2>&1
    Check 'G40 Windows 绝对路径 scope 不一致 → exit 2' ($LASTEXITCODE -eq 2) ($out -join "`n")

    $engineArgs = @('-NoProfile', '-File', $engine, '-Mode', 'full', '-Cwd', $repo, '-Storage', 'local', '-Description', '改动了src/a.ts', '-DryRun', '-Json')
    $out = & pwsh @engineArgs 2>&1
    Check 'G42 CJK 紧贴路径 scope 不一致 → exit 2' ($LASTEXITCODE -eq 2) ($out -join "`n")

    $engineArgs = @('-NoProfile', '-File', $engine, '-Mode', 'full', '-Cwd', $repo, '-Storage', 'local', '-Description', '修改Makefile', '-DryRun', '-Json')
    $out = & pwsh @engineArgs 2>&1
    Check 'G43 CJK 紧贴无扩展名文件 → exit 2' ($LASTEXITCODE -eq 2) ($out -join "`n")

    $outside = 'C:\Windows\win.ini'
    if (Test-Path -LiteralPath $outside) {
        $engineArgs = @('-NoProfile', '-File', $engine, '-Mode', 'full', '-Cwd', $repo, '-Storage', 'local', '-Description', "修改 $outside", '-DryRun', '-Json')
        $out = & pwsh @engineArgs 2>&1
        Check 'G44 跨盘符绝对路径 scope 不一致 → exit 2' ($LASTEXITCODE -eq 2) ($out -join "`n")
    }

    $spaceDir = 'C:\Temp'
    New-Item -ItemType Directory -Path $spaceDir -Force | Out-Null
    $spaceFile = Join-Path $spaceDir 'crc scope target.txt'
    [IO.File]::WriteAllText($spaceFile, 'scope', (New-Object Text.UTF8Encoding($false)))
    try {
        $engineArgs = @('-NoProfile', '-File', $engine, '-Mode', 'full', '-Cwd', $repo, '-Storage', 'local', '-Description', "修改 `"$spaceFile`"", '-DryRun', '-Json')
        $out = & pwsh @engineArgs 2>&1
        Check 'G45 带空格绝对路径 scope 不一致 → exit 2' ($LASTEXITCODE -eq 2) ($out -join "`n")
    } finally {
        Remove-Item -LiteralPath $spaceFile -Force -ErrorAction SilentlyContinue
    }

    $engineArgs = @('-NoProfile', '-File', $engine, '-Mode', 'full', '-Cwd', $repo, '-Storage', 'local', '-Description', '修改 Makefile', '-DryRun', '-Json')
    $out = & pwsh @engineArgs 2>&1
    Check 'G41 无扩展名文件 scope 不一致 → exit 2' ($LASTEXITCODE -eq 2) ($out -join "`n")

    $cjk = Join-Path $repo '中文.md'
    [IO.File]::WriteAllText($cjk, "# cjk`n", (New-Object Text.UTF8Encoding($false)))
    & git -C $repo add -- $cjk 2>&1 | Out-Null
    & git -C $repo -c user.name=gate-test -c user.email=gate@test commit -qm 'add cjk' 2>&1 | Out-Null
    Add-Content -LiteralPath $cjk -Value 'change' -Encoding utf8
    $engineArgs = @('-NoProfile', '-File', $engine, '-Mode', 'full', '-Cwd', $repo, '-Storage', 'local', '-Description', '修改 中文.md', '-DryRun', '-Json')
    $out = & pwsh @engineArgs 2>&1
    Check 'G49 CJK 文件名在 diff 中不误报' ($LASTEXITCODE -eq 0) ($out -join "`n")

    & git -C $repo checkout -- '中文.md' 2>&1 | Out-Null
    $engineArgs = @('-NoProfile', '-File', $engine, '-Mode', 'full', '-Cwd', $repo, '-Storage', 'local', '-Description', '修复了中文.md 的编码', '-DryRun', '-Json')
    $out = & pwsh @engineArgs 2>&1
    Check 'G52 CJK 文件名不在 diff 中 → exit 2' ($LASTEXITCODE -eq 2) ($out -join "`n")
} finally { Remove-TestRepo $repo }

# 15f. rangeDirty 用同一套 excludes，不能因 HEAD 跟踪了 review 文件而恒 true
$repo = New-TestRepo
try {
    $trackedReview = Join-Path $repo '.trellis/tasks/test/review/report.json'
    New-Item -ItemType Directory -Path (Split-Path $trackedReview -Parent) -Force | Out-Null
    [IO.File]::WriteAllText($trackedReview, '{"ok":true}', (New-Object Text.UTF8Encoding($false)))
    & git -C $repo add -A 2>&1 | Out-Null
    & git -C $repo -c user.name=gate-test -c user.email=gate@test commit -qm 'track review artifact' 2>&1 | Out-Null
    Add-Content -LiteralPath (Join-Path $repo 'README.md') -Value 'range clean head' -Encoding utf8
    & git -C $repo add -A 2>&1 | Out-Null
    & git -C $repo -c user.name=gate-test -c user.email=gate@test commit -qm 'range clean head' 2>&1 | Out-Null
    $engineArgs = @('-NoProfile', '-File', $engine, '-Mode', 'range', '-Cwd', $repo, '-Storage', 'local', '-Base', 'HEAD~1', '-Head', 'HEAD', '-DryRun', '-Json')
    $out = & pwsh @engineArgs 2>&1
    $json = $null
    try { $json = (@($out | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1) | Out-String) | ConvertFrom-Json } catch { }
    Check 'G50 跟踪的 review 文件不把 range 误判为 dirty' ($null -ne $json -and $json.rangeDirty -eq $false) ($out -join "`n")
} finally { Remove-TestRepo $repo }

# 19. 已跟踪的本地账本也不能让 snapshot 漂移
$repo = New-TestRepo
try {
    $trackedHistory = Join-Path $repo '.dsh/claude-review/ledger/review/history.jsonl'
    New-Item -ItemType Directory -Path (Split-Path $trackedHistory -Parent) -Force | Out-Null
    [IO.File]::WriteAllText($trackedHistory, '{"round":1,"mode":"full","verdict":"pass","snapshot":"x"}' + "`n", (New-Object Text.UTF8Encoding($false)))
    & git -C $repo add -A 2>&1 | Out-Null
    & git -C $repo -c user.name=gate-test -c user.email=gate@test commit -qm 'track local ledger' 2>&1 | Out-Null
    Add-Content -LiteralPath (Join-Path $repo 'README.md') -Value 'tracked ledger test' -Encoding utf8
    $engineArgs = @('-NoProfile', '-File', $engine, '-Mode', 'full', '-Cwd', $repo, '-Storage', 'local', '-DryRun', '-Json')
    $out1 = & pwsh @engineArgs 2>&1
    $j1 = (@($out1 | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1) | Out-String) | ConvertFrom-Json
    Add-Content -LiteralPath $trackedHistory -Value '{"round":2,"mode":"full","verdict":"pass","snapshot":"y"}' -Encoding utf8
    $out2 = & pwsh @engineArgs 2>&1
    $j2 = ($out2 | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1) | ConvertFrom-Json
    Check 'G51 跟踪的本地账本不改变 snapshot' ($null -ne $j1 -and $null -ne $j2 -and $j1.snapshotOk -eq $true -and [string]$j1.snapshot -eq [string]$j2.snapshot) ($out1 -join "`n")
} finally { Remove-TestRepo $repo }

# 15. 截断的 full pass 不能过 gate（除非显式 allowTruncatedGate）
$repo = New-TestRepo
try {
    $tree = Get-HeadTree $repo
    Write-History $repo 'local' @((New-HistoryRow 'full' 'pass' $tree 0 $true))
    $result = Invoke-Gate $repo 'local'
    Check 'G27 截断 full pass → gate blocked' ($result.exitCode -eq 1 -and $result.json.gate -eq 'blocked') $result.raw
    Check 'G28 截断原因可诊断' ($result.raw -match '截断|maxDiffChars') $result.raw
} finally { Remove-TestRepo $repo }

# 17. range 的工作区读取警告：dirty / head 不是当前 HEAD
$repo = New-TestRepo
try {
    Add-Content -LiteralPath (Join-Path $repo 'README.md') -Value 'range commit 1' -Encoding utf8
    & git -C $repo add -A 2>&1 | Out-Null
    & git -C $repo -c user.name=gate-test -c user.email=gate@test commit -qm 'range commit 1' 2>&1 | Out-Null
    Add-Content -LiteralPath (Join-Path $repo 'README.md') -Value 'dirty worktree' -Encoding utf8
    $engineArgs = @('-NoProfile', '-File', $engine, '-Mode', 'range', '-Cwd', $repo, '-Storage', 'local', '-Base', 'HEAD~1', '-Head', 'HEAD', '-DryRun', '-Json')
    $out = & pwsh @engineArgs 2>&1
    $json = $null
    try { $json = (@($out | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1) | Out-String) | ConvertFrom-Json } catch { }
    Check 'G46 range dirty worktree 被标记' ($null -ne $json -and $json.rangeDirty -eq $true) ($out -join "`n")

    Add-Content -LiteralPath (Join-Path $repo 'README.md') -Value 'range commit 2' -Encoding utf8
    & git -C $repo add -A 2>&1 | Out-Null
    & git -C $repo -c user.name=gate-test -c user.email=gate@test commit -qm 'range commit 2' 2>&1 | Out-Null
    $engineArgs = @('-NoProfile', '-File', $engine, '-Mode', 'range', '-Cwd', $repo, '-Storage', 'local', '-Base', 'HEAD~2', '-Head', 'HEAD~1', '-DryRun', '-Json')
    $out = & pwsh @engineArgs 2>&1
    $json = $null
    try { $json = (@($out | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1) | Out-String) | ConvertFrom-Json } catch { }
    Check 'G47 range head 不是当前 HEAD 被标记' ($null -ne $json -and $json.rangeHeadMismatch -eq $true) ($out -join "`n")
} finally { Remove-TestRepo $repo }

# 18. 本地账本被 .gitignore 忽略时，snapshot 不能降级（否则 gate 永久 blocked）
$repo = New-TestRepo
try {
    [IO.File]::WriteAllText((Join-Path $repo '.gitignore'), ".dsh/`n", (New-Object Text.UTF8Encoding($false)))
    New-Item -ItemType Directory -Path (Join-Path $repo '.dsh/claude-review/ledger') -Force | Out-Null
    Add-Content -LiteralPath (Join-Path $repo 'README.md') -Value 'ignored ledger' -Encoding utf8
    $engineArgs = @('-NoProfile', '-File', $engine, '-Mode', 'full', '-Cwd', $repo, '-Storage', 'local', '-DryRun', '-Json')
    $out = & pwsh @engineArgs 2>&1
    $json = $null
    try { $json = (@($out | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1) | Out-String) | ConvertFrom-Json } catch { }
    Check 'G48 忽略的本地账本不导致 snapshot 降级' ($null -ne $json -and $json.snapshotOk -eq $true) ($out -join "`n")
} finally { Remove-TestRepo $repo }
$repo = New-TestRepo
try {
    $src = Join-Path $repo 'src'
    New-Item -ItemType Directory -Path $src -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $src 'a.ts'), "export const a = 1`n", (New-Object Text.UTF8Encoding($false)))
    & git -C $repo add -A 2>&1 | Out-Null
    & git -C $repo -c user.name=gate-test -c user.email=gate@test commit -qm 'add src' 2>&1 | Out-Null
    Add-Content -LiteralPath (Join-Path $repo 'README.md') -Value 'scope test' -Encoding utf8
    $engineArgs = @('-NoProfile', '-File', $engine, '-Mode', 'full', '-Cwd', $repo, '-Storage', 'local', '-Description', '修改 src/a.ts', '-DryRun', '-Json')
    $out = & pwsh @engineArgs 2>&1
    Check 'G29 简报/diff scope 不一致 → exit 2' ($LASTEXITCODE -eq 2) ($out -join "`n")
    Check 'G30 scope 错误信息可诊断' (($out -join "`n") -match 'scope 不一致') ($out -join "`n")

    $engineArgs = @('-NoProfile', '-File', $engine, '-Mode', 'full', '-Cwd', $repo, '-Storage', 'local', '-Description', '修改 src/a.ts', '-NoStrictScope', '-DryRun', '-Json')
    $out = & pwsh @engineArgs 2>&1
    $json = $null
    try { $json = (@($out | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1) | Out-String) | ConvertFrom-Json } catch { }
    Check 'G31 NoStrictScope 降级为 warning' ($LASTEXITCODE -eq 0 -and $null -ne $json -and [string]$json.scopeWarning -match 'scope 不一致') ($out -join "`n")

    $engineArgs = @('-NoProfile', '-File', $engine, '-Mode', 'full', '-Cwd', $repo, '-Storage', 'local', '-Description', '修改 README.md', '-DryRun', '-Json')
    $out = & pwsh @engineArgs 2>&1
    Check 'G32 简报命中 diff → 不误报' ($LASTEXITCODE -eq 0) ($out -join "`n")
} finally { Remove-TestRepo $repo }

Write-Host ''
Write-Host "结果: passed=$passed failed=$failed"
foreach ($failure in $failures) { Write-Host "  FAIL $failure" }
if ($failed -gt 0) { exit 1 }
exit 0
