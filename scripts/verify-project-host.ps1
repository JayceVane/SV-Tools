param([Parameter(Mandatory = $true)][string]$CodePath, [string]$ExtensionPath)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $ExtensionPath) { $ExtensionPath = $repoRoot }
$testRoot = Join-Path $repoRoot ('bin/project-host/run-' + [guid]::NewGuid().ToString('N'))
$testWorkspace = Join-Path $testRoot 'workspace'
$profilePath = Join-Path $testRoot 'profile'
$extensionsPath = Join-Path $testRoot 'extensions'
New-Item -ItemType Directory -Path $testWorkspace,$extensionsPath,(Join-Path $profilePath 'User') -Force | Out-Null
Set-Content -LiteralPath (Join-Path $profilePath 'User/settings.json') -Encoding utf8 -Value '{"update.mode":"none","extensions.autoUpdate":false,"telemetry.telemetryLevel":"off","workbench.startupEditor":"none"}'
$arguments = @('--new-window','--disable-extensions','--disable-workspace-trust','--skip-welcome','--skip-release-notes',
    ('--user-data-dir="' + $profilePath + '"'),('--extensions-dir="' + $extensionsPath + '"'),
    ('--extensionDevelopmentPath="' + $ExtensionPath + '"'),('--extensionTestsPath="' + (Join-Path $repoRoot 'test/vscode_project_host.js') + '"'),('"' + $testWorkspace + '"'))
# 只启动独立测试宿主；窗口隐藏，完成后由测试运行器退出。
$process = Start-Process -FilePath $CodePath -ArgumentList $arguments -WindowStyle Hidden -PassThru -Wait `
    -RedirectStandardOutput (Join-Path $testRoot 'stdout.log') -RedirectStandardError (Join-Path $testRoot 'stderr.log')
if ($process.ExitCode -ne 0) {
    Get-Content -LiteralPath (Join-Path $testRoot 'stdout.log') -Tail 24
    Get-Content -LiteralPath (Join-Path $testRoot 'stderr.log') -Tail 24
    throw ('工程宿主验收失败：' + $process.ExitCode + '；日志 ' + $testRoot)
}
$report = Join-Path $testRoot 'host-report.json'
if (-not (Test-Path -LiteralPath $report)) { throw ('测试宿主未生成报告：' + $testRoot) }
Get-Content -LiteralPath $report
Write-Output ('宿主验收报告：' + $report)
