# Engine identical-input cache — fake Claude, no model calls.
# Usage: pwsh -NoProfile -File test/engine-cache.ps1
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }

$packageRoot = Split-Path $PSScriptRoot -Parent
$engineSource = Join-Path $packageRoot 'scripts/Invoke-ClaudeReview.ps1'
if (-not (Test-Path -LiteralPath $engineSource)) { throw "engine not found: $engineSource" }

$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $csc)) { $csc = 'C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path -LiteralPath $csc)) {
    Write-Host 'SKIP  engine-cache（找不到 csc.exe，跳过 fake Claude 缓存测试）'
    exit 0
}

$passed = 0
$failed = 0
$failures = @()
function Check([string]$name, [bool]$condition, [string]$detail = '') {
    if ($condition) { $script:passed++; Write-Host "PASS  $name" }
    else { $script:failed++; $script:failures += "$name$(if ($detail) { " — $detail" })"; Write-Host "FAIL  $name$(if ($detail) { " — $detail" })" }
}

$base = Join-Path $env:TEMP ('crc-cache-' + [guid]::NewGuid().ToString('N').Substring(0, 6))
$engineDir = Join-Path $base 'engine'
$repo = Join-Path $base 'repo'
New-Item -ItemType Directory -Path $engineDir, $repo -Force | Out-Null
try {
    Copy-Item $engineSource, (Join-Path $packageRoot 'scripts/config.json'),
        (Join-Path $packageRoot 'scripts/review-schema.json'),
        (Join-Path $packageRoot 'scripts/reviewer-role.md') -Destination $engineDir

    $fake = Join-Path $base 'fake-claude.exe'
    $csFile = Join-Path $base 'fake.cs'
    $cs = @'
using System;
using System.IO;
class FakeClaude {
  static void Main(string[] args) {
    var log = Environment.GetEnvironmentVariable("CRC_FAKE_LOG");
    if (!string.IsNullOrEmpty(log)) File.AppendAllText(log, "call\n");
    Console.WriteLine("{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"{\\\"verdict\\\":\\\"pass\\\",\\\"summary\\\":\\\"ok\\\",\\\"strengths\\\":[],\\\"issues\\\":[],\\\"recommendations\\\":[],\\\"assessment\\\":\\\"ok\\\"}\",\"total_cost_usd\":0}");
  }
}
'@
    [IO.File]::WriteAllText($csFile, $cs, (New-Object Text.UTF8Encoding($false)))
    & $csc /nologo /out:$fake $csFile 2>&1 | Out-Null
    if (-not (Test-Path -LiteralPath $fake)) { throw 'fake Claude 编译失败' }

    $log = Join-Path $base 'calls.log'
    $env:CRC_FAKE_LOG = $log
    $cfg = [ordered]@{
        claudeExe      = $fake
        model          = ''
        effort         = 'low'
        timeoutSec     = 60
        maxBudgetUsd   = 0
        maxDiffChars   = 200000
        maxRounds      = 3
        failOn         = @('critical', 'important')
        allowTruncatedGate = $false
        strictScope    = $true
        reviewerRoleFile = ''
        snapshotExcludePathspecs = @(':(exclude).trellis/tasks/*/review/**', ':(exclude).dsh/claude-review/ledger/**')
        excludePathspecs = @(':(exclude).trellis/tasks/*/review/**', ':(exclude).dsh/claude-review/ledger/**')
    }
    [IO.File]::WriteAllText((Join-Path $engineDir 'config.json'), ($cfg | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))

    & git -C $repo init -q 2>&1 | Out-Null
    [IO.File]::WriteAllText((Join-Path $repo 'README.md'), "# cache test`n", (New-Object Text.UTF8Encoding($false)))
    & git -C $repo add -A 2>&1 | Out-Null
    & git -C $repo -c user.name=cache-test -c user.email=cache@test commit -qm init 2>&1 | Out-Null
    Add-Content -LiteralPath (Join-Path $repo 'README.md') -Value 'change 1' -Encoding utf8

    $runArgs = @('-NoProfile', '-File', (Join-Path $engineDir 'Invoke-ClaudeReview.ps1'), '-Mode', 'full', '-Cwd', $repo,
        '-Storage', 'local', '-Description', 'cache test', '-Checks', 'unit 1/1', '-Json', '-TimeoutSec', '60')

    $out1 = & pwsh @runArgs 2>&1
    $j1 = ($out1 | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1) | ConvertFrom-Json
    $calls1 = if (Test-Path -LiteralPath $log) { @(Get-Content -LiteralPath $log).Count } else { 0 }
    Check 'CACHE1 首次调用模型' ($null -ne $j1 -and -not $j1.cached -and $calls1 -eq 1) ($out1 -join "`n")

    $out2 = & pwsh @runArgs 2>&1
    $j2 = ($out2 | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1) | ConvertFrom-Json
    $calls2 = if (Test-Path -LiteralPath $log) { @(Get-Content -LiteralPath $log).Count } else { 0 }
    Check 'CACHE2 相同输入命中缓存' ($null -ne $j2 -and $j2.cached -eq $true -and $calls2 -eq 1 -and [string]$j2.summary -eq 'ok') ($out2 -join "`n")
    Check 'CACHE3 缓存命中按当前快照落新轮次' ($null -ne $j2 -and [int]$j2.round -eq 2) ($out2 -join "`n")
    $history2 = @(Get-Content -LiteralPath (Join-Path $repo '.dsh/claude-review/ledger/review/history.jsonl'))
    $lastRow2 = $history2[-1] | ConvertFrom-Json
    Check 'CACHE3b 缓存 history 标记 cached/cost0' ($lastRow2.cached -eq $true -and [double]$lastRow2.cost_usd -eq 0 -and [int]$lastRow2.round -eq 2) ($history2[-1])

    Add-Content -LiteralPath (Join-Path $repo 'README.md') -Value 'change 2' -Encoding utf8
    $out3 = & pwsh @runArgs 2>&1
    $j3 = ($out3 | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1) | ConvertFrom-Json
    $calls3 = if (Test-Path -LiteralPath $log) { @(Get-Content -LiteralPath $log).Count } else { 0 }
    Check 'CACHE4 改动后缓存失效' ($null -ne $j3 -and -not $j3.cached -and $calls3 -eq 2) ($out3 -join "`n")

    # 关键回归：pass → 空 diff 轮次 → 相同 diff 再 full。空 diff 必须清掉旧 hash，
    # 否则会拿 nothing-to-review 当缓存结果，且 gate 永远卡死。
    $incArgs = @('-NoProfile', '-File', (Join-Path $engineDir 'Invoke-ClaudeReview.ps1'), '-Mode', 'incremental', '-Cwd', $repo,
        '-Storage', 'local', '-Description', 'cache test', '-Checks', 'unit 1/1', '-Json', '-TimeoutSec', '60')
    $outInc = & pwsh @incArgs 2>&1
    $jInc = ($outInc | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1) | ConvertFrom-Json
    $callsInc = if (Test-Path -LiteralPath $log) { @(Get-Content -LiteralPath $log).Count } else { 0 }
    Check 'CACHE5 空 diff 轮次为 nothing-to-review' ($null -ne $jInc -and $jInc.nothingToReview -eq $true -and $callsInc -eq 2) ($outInc -join "`n")

    $out5 = & pwsh @runArgs 2>&1
    $j5 = ($out5 | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1) | ConvertFrom-Json
    $calls5 = if (Test-Path -LiteralPath $log) { @(Get-Content -LiteralPath $log).Count } else { 0 }
    Check 'CACHE6 空 diff 后相同 full 重新审核（不返回 nothing）' ($null -ne $j5 -and -not $j5.cached -and $j5.verdict -eq 'pass' -and [int]$j5.round -eq 5 -and $calls5 -eq 3) ($out5 -join "`n")

    $gateArgs = @('-NoProfile', '-File', (Join-Path $engineDir 'Invoke-ClaudeReview.ps1'), '-Mode', 'gate', '-Cwd', $repo, '-Storage', 'local', '-Json')
    $outGate = & pwsh @gateArgs 2>&1
    $jGate = ($outGate | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1) | ConvertFrom-Json
    Check 'CACHE7 缓存/空 diff 序列后 gate 可通过' ($LASTEXITCODE -eq 0 -and $null -ne $jGate -and $jGate.gate -eq 'pass') ($outGate -join "`n")
} finally {
    Remove-Item -LiteralPath $base -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host "结果: passed=$passed failed=$failed"
if ($failed -gt 0) {
    Write-Host '失败:'
    foreach ($f in $failures) { Write-Host "  - $f" }
    exit 1
}
exit 0
