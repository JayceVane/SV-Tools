param([Parameter(Mandatory = $true)][string]$CodePath, [string]$IcarusPath = '', [string]$CygwinPath = '')
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$testRoot = Join-Path $repoRoot ('bin/completion-host/run-' + [guid]::NewGuid().ToString('N'))
$testWorkspace = Join-Path $testRoot 'workspace'
$profilePath = Join-Path $testRoot 'profile'
$extensionsPath = Join-Path $testRoot 'extensions'
New-Item -ItemType Directory -Path $testWorkspace,$extensionsPath,(Join-Path $profilePath 'User') -Force | Out-Null
if ($IcarusPath) {
    if (-not (Test-Path -LiteralPath $IcarusPath -PathType Leaf)) { throw ('Icarus 路径不存在：' + $IcarusPath) }
    Set-Content -LiteralPath (Join-Path $testRoot 'tools.json') -Encoding utf8 -Value (@{ iverilog = $IcarusPath; cygwin = $CygwinPath } | ConvertTo-Json)
}
$settings = @{ 'update.mode' = 'none'; 'extensions.autoUpdate' = $false; 'telemetry.telemetryLevel' = 'off';
    'workbench.startupEditor' = 'none'; 'svtools.iverilog.lintOnSave' = $false; 'svtools.iverilog.lintOnOpen' = $false }
Set-Content -LiteralPath (Join-Path $profilePath 'User/settings.json') -Encoding utf8 -Value ($settings | ConvertTo-Json)
$testFile = Join-Path $repoRoot 'test/vscode_completion_host.js'
$arguments = @('--new-window','--disable-extensions','--disable-workspace-trust','--skip-welcome','--skip-release-notes',
    ('--user-data-dir="' + $profilePath + '"'),('--extensions-dir="' + $extensionsPath + '"'),
    ('--extensionDevelopmentPath="' + $repoRoot + '"'),('--extensionTestsPath="' + $testFile + '"'),('"' + $testWorkspace + '"'))
# 宿主拥有独立用户目录、扩展目录和夹具，隐藏启动；完成后由测试宿主退出。
$process = Start-Process -FilePath $CodePath -ArgumentList $arguments -WindowStyle Hidden -PassThru -Wait `
    -RedirectStandardOutput (Join-Path $testRoot 'stdout.log') -RedirectStandardError (Join-Path $testRoot 'stderr.log')
$report = Join-Path $testRoot 'host-report.json'
if (Test-Path -LiteralPath $report) { Get-Content -LiteralPath $report }
if ($process.ExitCode -ne 0) {
    Get-Content -LiteralPath (Join-Path $testRoot 'stdout.log') -Tail 30
    Get-Content -LiteralPath (Join-Path $testRoot 'stderr.log') -Tail 30
    throw ('VS Code 补全宿主验收失败，退出码 ' + $process.ExitCode + '；日志 ' + $testRoot)
}
if (-not (Test-Path -LiteralPath $report)) { throw ('测试宿主未生成报告：' + $testRoot) }
Write-Output ('补全宿主验收报告：' + $report)
