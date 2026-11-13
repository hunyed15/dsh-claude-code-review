param(
    [string]$Cwd = '',
    [string]$EnginePath = '',
    [string]$TaskDir = '',
    [switch]$Force
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }

if ([string]::IsNullOrWhiteSpace($Cwd)) { $Cwd = (Get-Location).Path }
if (-not (Test-Path -LiteralPath $Cwd)) { throw "目录不存在：$Cwd" }

$root = (& git -C $Cwd rev-parse --show-toplevel 2>$null)
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($root)) { throw "不是 git 仓库：$Cwd" }
$root = $root.Trim()

if ([string]::IsNullOrWhiteSpace($EnginePath)) {
    $EnginePath = Join-Path $PSScriptRoot 'Invoke-ClaudeReview.ps1'
} elseif (-not [IO.Path]::IsPathRooted($EnginePath)) {
    $EnginePath = Join-Path $Cwd $EnginePath
}
if (-not (Test-Path -LiteralPath $EnginePath)) { throw "engine 不存在：$EnginePath" }
$engine = (Resolve-Path -LiteralPath $EnginePath).Path

$hooksRel = (& git -C $root rev-parse --git-path hooks 2>$null)
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($hooksRel)) { throw 'git rev-parse --git-path hooks 失败' }
$hooks = if ([IO.Path]::IsPathRooted($hooksRel.Trim())) { $hooksRel.Trim() } else { Join-Path $root $hooksRel.Trim() }
$preCommit = Join-Path $hooks 'pre-commit'

if ((Test-Path -LiteralPath $preCommit) -and -not $Force) {
    throw "pre-commit 已存在：$preCommit（确认要替换时加 -Force，会先备份）"
}

$template = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'git-hooks/pre-commit') -Raw
function ConvertTo-ShSingleQuoted([string]$value) {
    return ([string]$value).Replace('\', '/').Replace("'", "'\''")
}
$content = $template.Replace('__ENGINE__', (ConvertTo-ShSingleQuoted $engine)).Replace('__TASKDIR__', (ConvertTo-ShSingleQuoted $TaskDir))
New-Item -ItemType Directory -Path $hooks -Force | Out-Null
if (Test-Path -LiteralPath $preCommit) {
    $backup = "$preCommit.bak-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
    Copy-Item -LiteralPath $preCommit -Destination $backup -Force
    Write-Output "已备份：$backup"
}
[IO.File]::WriteAllText($preCommit, $content, (New-Object Text.UTF8Encoding($false)))

Write-Output "已安装：$preCommit"
Write-Output "引擎    ：$engine"
Write-Output "说明    ：提交前必须通过 -Mode gate；紧急可用 git commit --no-verify"
Write-Output "Trellis ：可用 CLAUDE_REVIEW_TASKDIR 指定任务目录；否则 -Storage auto"
