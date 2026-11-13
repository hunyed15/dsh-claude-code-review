# Engine ACP transport — fake agent, no model calls.
# Usage: pwsh -NoProfile -File test/engine-acp.ps1 [-EnginePath <path>]
param([string]$EnginePath = '')
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }

$packageRoot = Split-Path $PSScriptRoot -Parent
$engine = if ([string]::IsNullOrWhiteSpace($EnginePath)) { Join-Path $packageRoot 'scripts/Invoke-ClaudeReview.ps1' } else { $EnginePath }
$fake = Join-Path $PSScriptRoot 'fixtures/acp-fake-agent.mjs'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not (Test-Path -LiteralPath $engine)) { throw "engine not found: $engine" }
if (-not (Test-Path -LiteralPath $fake)) { throw "fake agent not found: $fake" }
if (-not $node) { throw 'node not found' }

$passed = 0
$failed = 0
function Check([string]$name, [bool]$condition, [string]$detail = '') {
    if ($condition) { $script:passed++; Write-Host "PASS  $name" }
    else { $script:failed++; Write-Host "FAIL  $name$(if ($detail) { " — $detail" })" }
}

function New-TestRepo {
    param([switch]$WithSpace)
    $parent = $env:TEMP
    if ($WithSpace) {
        $parent = Join-Path $env:TEMP ("crc acp space " + [guid]::NewGuid().ToString('N').Substring(0, 6))
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    $dir = Join-Path $parent ("crc-acp-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    & git -C $dir init -q 2>&1 | Out-Null
    [IO.File]::WriteAllText((Join-Path $dir 'README.md'), "# acp test`n", (New-Object Text.UTF8Encoding($false)))
    & git -C $dir add -A 2>&1 | Out-Null
    & git -C $dir -c user.name=acp-test -c user.email=acp@test commit -qm init 2>&1 | Out-Null
    Add-Content -LiteralPath (Join-Path $dir 'README.md') -Value 'acp transport change' -Encoding utf8
    return $dir
}

# Build a temporary engine whose ACP bridge exits 3 but whose CLI is a fake.
# This exercises auto -> CLI fallback without calling a real model.
function New-FakeCliEngine([string]$Repo, [string]$FakeCli, [switch]$RealBridge) {
    $root = Join-Path $env:TEMP ("crc-acp-engine-" + [guid]::NewGuid().ToString('N').Substring(0, 6))
    $scripts = Join-Path $root 'scripts'
    New-Item -ItemType Directory -Path $scripts -Force | Out-Null
    Copy-Item (Join-Path $packageRoot 'scripts/Invoke-ClaudeReview.ps1') (Join-Path $scripts 'Invoke-ClaudeReview.ps1')
    Copy-Item (Join-Path $packageRoot 'scripts/review-schema.json') (Join-Path $scripts 'review-schema.json')
    Copy-Item (Join-Path $packageRoot 'scripts/reviewer-role.md') (Join-Path $scripts 'reviewer-role.md')
    $cfg = Get-Content (Join-Path $packageRoot 'scripts/config.json') -Raw | ConvertFrom-Json
    $cfg.claudeExe = $FakeCli
    $cfg.transport = 'auto'
    [IO.File]::WriteAllText((Join-Path $scripts 'config.json'), ($cfg | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding($false)))
    if ($RealBridge) {
        Copy-Item (Join-Path $packageRoot 'scripts/acp-review.mjs') (Join-Path $scripts 'acp-review.mjs')
        $sdkDest = Join-Path $root 'node_modules/@agentclientprotocol/sdk'
        New-Item -ItemType Directory -Path (Split-Path $sdkDest -Parent) -Force | Out-Null
        Copy-Item (Join-Path $packageRoot 'node_modules/@agentclientprotocol/sdk') $sdkDest -Recurse
        $zodSrc = Join-Path $packageRoot 'node_modules/zod'
        if (Test-Path -LiteralPath $zodSrc) {
            Copy-Item $zodSrc (Join-Path $root 'node_modules/zod') -Recurse
        }
    } else {
        $fakeBridge = @'
process.stdout.write(JSON.stringify({ type: "result", subtype: "adapter_unavailable", is_error: true, errors: ["fake unavailable"] }) + "\n")
process.exit(3)
'@
        [IO.File]::WriteAllText((Join-Path $scripts 'acp-review.mjs'), $fakeBridge, (New-Object Text.UTF8Encoding($false)))
    }
    $adapterDir = Join-Path $root 'node_modules/@agentclientprotocol/claude-agent-acp/dist'
    New-Item -ItemType Directory -Path $adapterDir -Force | Out-Null
    $adapterBody = if ($RealBridge) { 'throw new Error("fake adapter bootstrap failure")' } else { '// dummy adapter' }
    [IO.File]::WriteAllText((Join-Path $adapterDir 'index.js'), $adapterBody, (New-Object Text.UTF8Encoding($false)))
    return (Join-Path $scripts 'Invoke-ClaudeReview.ps1')
}

function New-FakeCli([string]$Path) {
    $review = '{"verdict":"pass","summary":"fake CLI fallback","strengths":[],"issues":[],"recommendations":[],"assessment":"fake"}'
    $escaped = $review.Replace('"', '\"')
    $line = '@echo off' + "`r`n" + 'echo {"type":"result","subtype":"success","is_error":false,"result":"' + $escaped + '","total_cost_usd":0.01}'
    [IO.File]::WriteAllText($Path, $line, (New-Object Text.UTF8Encoding($false)))
}

$repo = New-TestRepo
try {
    $args = @('-NoProfile', '-File', $engine, '-Mode', 'full', '-Cwd', $repo, '-Storage', 'local',
        '-Transport', 'acp', '-AcpAdapter', $fake, '-NodeExe', $node, '-Json', '-TimeoutSec', '60')
    $out = & pwsh @args 2>&1
    $jsonLine = @($out | Where-Object { ([string]$_).TrimStart().StartsWith('{') } | Select-Object -Last 1)
    $j = $null
    try { $j = ($jsonLine | Out-String) | ConvertFrom-Json } catch { }
    Check 'ACP1 engine exits 0' ($LASTEXITCODE -eq 0) ($out -join "`n")
    Check 'ACP2 fake ACP review is pass' ($null -ne $j -and $j.verdict -eq 'pass') ($out -join "`n")
    Check 'ACP3 output transport=acp' ($null -ne $j -and $j.transport -eq 'acp') ($out -join "`n")

    $report = $null
    if ($j -and $j.report -and (Test-Path -LiteralPath $j.report)) {
        try { $report = Get-Content -LiteralPath $j.report -Raw | ConvertFrom-Json } catch { }
    }
    Check 'ACP4 report meta.transport=acp' ($null -ne $report -and $report.meta.transport -eq 'acp') ($out -join "`n")

    $gateOut = & pwsh -NoProfile -File $engine -Mode gate -Cwd $repo -Storage local -Json 2>&1
    $gateLine = @($gateOut | Where-Object { ([string]$_).TrimStart().StartsWith('{') } | Select-Object -Last 1)
    $gate = $null
    try { $gate = ($gateLine | Out-String) | ConvertFrom-Json } catch { }
    Check 'ACP5 gate passes after fake ACP full' ($LASTEXITCODE -eq 0 -and $null -ne $gate -and $gate.gate -eq 'pass') ($gateOut -join "`n")
} finally {
    Remove-Item -LiteralPath $repo -Recurse -Force -ErrorAction SilentlyContinue
}

# Path with spaces: Start-Process must quote --cwd/--prompt/--role.
$spaceRepo = New-TestRepo -WithSpace
try {
    $args = @('-NoProfile', '-File', $engine, '-Mode', 'full', '-Cwd', $spaceRepo, '-Storage', 'local',
        '-Transport', 'acp', '-AcpAdapter', $fake, '-NodeExe', $node, '-Json', '-TimeoutSec', '60')
    $out = & pwsh @args 2>&1
    $jsonLine = @($out | Where-Object { ([string]$_).TrimStart().StartsWith('{') } | Select-Object -Last 1)
    $j = $null
    try { $j = ($jsonLine | Out-String) | ConvertFrom-Json } catch { }
    Check 'ACP6 space-containing cwd still works' ($LASTEXITCODE -eq 0 -and $null -ne $j -and $j.verdict -eq 'pass' -and $j.transport -eq 'acp') ($out -join "`n")
} finally {
    Remove-Item -LiteralPath $spaceRepo -Recurse -Force -ErrorAction SilentlyContinue
}

# auto fallback: bridge exits 3 -> CLI; fake CLI gives a valid review.
$fallbackRepo = New-TestRepo
$fakeCli = Join-Path $env:TEMP ("crc-acp-fake-cli-" + [guid]::NewGuid().ToString('N').Substring(0, 6) + '.cmd')
$tempEngine = $null
try {
    New-FakeCli $fakeCli
    $tempEngine = New-FakeCliEngine $fallbackRepo $fakeCli
    $args = @('-NoProfile', '-File', $tempEngine, '-Mode', 'full', '-Cwd', $fallbackRepo, '-Storage', 'local',
        '-Transport', 'auto', '-NodeExe', $node, '-Json', '-TimeoutSec', '60')
    $out = & pwsh @args 2>&1
    $jsonLine = @($out | Where-Object { ([string]$_).TrimStart().StartsWith('{') } | Select-Object -Last 1)
    $j = $null
    try { $j = ($jsonLine | Out-String) | ConvertFrom-Json } catch { }
    Check 'ACP7 auto falls back to CLI' ($LASTEXITCODE -eq 0 -and $null -ne $j -and $j.verdict -eq 'pass' -and $j.transport -eq 'cli' -and ([string]$j.transportWarning) -match 'fake unavailable') ($out -join "`n")
} finally {
    Remove-Item -LiteralPath $fallbackRepo -Recurse -Force -ErrorAction SilentlyContinue
    if ($tempEngine) { Remove-Item -LiteralPath (Split-Path (Split-Path $tempEngine -Parent) -Parent) -Recurse -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $fakeCli -Force -ErrorAction SilentlyContinue
}

# Timeout: adapter never answers; engine must kill the tree and fail closed, not hang.
$slowRepo = New-TestRepo
$slowAdapter = Join-Path $env:TEMP ("crc-acp-slow-" + [guid]::NewGuid().ToString('N').Substring(0, 6) + '.mjs')
try {
    [IO.File]::WriteAllText($slowAdapter, "process.stdin.resume()`nsetInterval(() => {}, 1000)`n", (New-Object Text.UTF8Encoding($false)))
    $args = @('-NoProfile', '-File', $engine, '-Mode', 'full', '-Cwd', $slowRepo, '-Storage', 'local',
        '-Transport', 'acp', '-AcpAdapter', $slowAdapter, '-NodeExe', $node, '-TimeoutSec', '1', '-Json')
    $out = & pwsh @args 2>&1
    $text = $out -join "`n"
    Check 'ACP8 ACP timeout fails closed' ($LASTEXITCODE -eq 2 -and $text -match '审核超时') $text
} finally {
    Remove-Item -LiteralPath $slowRepo -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $slowAdapter -Force -ErrorAction SilentlyContinue
}

# Startup failure after spawn (adapter throws) must be exit 3 and auto -> CLI.
$startupRepo = New-TestRepo
$startupCli = Join-Path $env:TEMP ("crc-acp-startup-cli-" + [guid]::NewGuid().ToString('N').Substring(0, 6) + '.cmd')
$startupEngine = $null
try {
    New-FakeCli $startupCli
    $startupEngine = New-FakeCliEngine $startupRepo $startupCli -RealBridge
    $args = @('-NoProfile', '-File', $startupEngine, '-Mode', 'full', '-Cwd', $startupRepo, '-Storage', 'local',
        '-Transport', 'auto', '-NodeExe', $node, '-Json', '-TimeoutSec', '60')
    $out = & pwsh @args 2>&1
    $jsonLine = @($out | Where-Object { ([string]$_).TrimStart().StartsWith('{') } | Select-Object -Last 1)
    $j = $null
    try { $j = ($jsonLine | Out-String) | ConvertFrom-Json } catch { }
    $acpRaw = if ($j -and $j.report) { Join-Path (Split-Path $j.report -Parent) 'raw-1-acp.json' } else { '' }
    $acpRawText = if ($acpRaw -and (Test-Path -LiteralPath $acpRaw)) { Get-Content -LiteralPath $acpRaw -Raw } else { '' }
    Check 'ACP9 pre-prompt crash falls back to CLI' ($LASTEXITCODE -eq 0 -and $null -ne $j -and $j.verdict -eq 'pass' -and $j.transport -eq 'cli' -and ([string]$j.transportWarning) -match 'ACP' -and $acpRawText -match 'fake adapter bootstrap failure') ($out -join "`n")
} finally {
    Remove-Item -LiteralPath $startupRepo -Recurse -Force -ErrorAction SilentlyContinue
    if ($startupEngine) { Remove-Item -LiteralPath (Split-Path (Split-Path $startupEngine -Parent) -Parent) -Recurse -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $startupCli -Force -ErrorAction SilentlyContinue
}

# Bridge's own startup timeout: no prompt sent -> exit 3 -> auto -> CLI, with warning.
$slowStartRepo = New-TestRepo
$slowStartCli = Join-Path $env:TEMP ("crc-acp-slowstart-cli-" + [guid]::NewGuid().ToString('N').Substring(0, 6) + '.cmd')
$slowStartEngine = $null
try {
    New-FakeCli $slowStartCli
    $slowStartEngine = New-FakeCliEngine $slowStartRepo $slowStartCli -RealBridge
    $slowEngineRoot = Split-Path (Split-Path $slowStartEngine -Parent) -Parent
    $slowAdapterPath = Join-Path $slowEngineRoot 'node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js'
    [IO.File]::WriteAllText($slowAdapterPath, "process.stdin.resume()`nsetInterval(() => {}, 1000)`n", (New-Object Text.UTF8Encoding($false)))
    $args = @('-NoProfile', '-File', $slowStartEngine, '-Mode', 'full', '-Cwd', $slowStartRepo, '-Storage', 'local',
        '-Transport', 'auto', '-NodeExe', $node, '-Json', '-TimeoutSec', '20')
    $out = & pwsh @args 2>&1
    $jsonLine = @($out | Where-Object { ([string]$_).TrimStart().StartsWith('{') } | Select-Object -Last 1)
    $j = $null
    try { $j = ($jsonLine | Out-String) | ConvertFrom-Json } catch { }
    Check 'ACP10 startup timeout falls back to CLI' ($LASTEXITCODE -eq 0 -and $null -ne $j -and $j.verdict -eq 'pass' -and $j.transport -eq 'cli' -and ([string]$j.transportWarning) -match 'ACP') ($out -join "`n")
} finally {
    Remove-Item -LiteralPath $slowStartRepo -Recurse -Force -ErrorAction SilentlyContinue
    if ($slowStartEngine) { Remove-Item -LiteralPath (Split-Path (Split-Path $slowStartEngine -Parent) -Parent) -Recurse -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $slowStartCli -Force -ErrorAction SilentlyContinue
}

Write-Host "`n结果: passed=$passed failed=$failed"
exit ($(if ($failed -gt 0) { 1 } else { 0 }))
