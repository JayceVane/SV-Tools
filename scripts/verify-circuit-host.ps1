param(
    [Parameter(Mandatory = $true)][string]$CodePath,
    [string]$ExtensionPath,
    [string]$YosysPath
)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $ExtensionPath) { $ExtensionPath = $repoRoot }
$testRoot = Join-Path $repoRoot ('bin/circuit-host/run-' + [guid]::NewGuid().ToString('N'))
$testWorkspace = Join-Path $testRoot 'workspace'
$profilePath = Join-Path $testRoot 'profile'
$extensionsPath = Join-Path $testRoot 'extensions'
New-Item -ItemType Directory -Path $testWorkspace,$extensionsPath,(Join-Path $profilePath 'User') -Force | Out-Null
Set-Content -LiteralPath (Join-Path $profilePath 'User/settings.json') -Encoding utf8 -Value '{"update.mode":"none","extensions.autoUpdate":false,"telemetry.telemetryLevel":"off","workbench.startupEditor":"none"}'
$arguments = @('--new-window','--disable-extensions','--disable-workspace-trust','--skip-welcome','--skip-release-notes',
    ('--user-data-dir="' + $profilePath + '"'),('--extensions-dir="' + $extensionsPath + '"'),
    ('--extensionDevelopmentPath="' + $ExtensionPath + '"'),('--extensionTestsPath="' + (Join-Path $repoRoot 'test/vscode_circuit_host.js') + '"'),('"' + $testWorkspace + '"'))
$previousYosys = $env:SVTOOLS_CIRCUIT_YOSYS
try {
    if ($YosysPath) { $env:SVTOOLS_CIRCUIT_YOSYS = [IO.Path]::GetFullPath($YosysPath) }
    $process = Start-Process -FilePath $CodePath -ArgumentList $arguments -WindowStyle Hidden -PassThru -Wait `
        -RedirectStandardOutput (Join-Path $testRoot 'stdout.log') -RedirectStandardError (Join-Path $testRoot 'stderr.log')
    if ($process.ExitCode -ne 0) {
        Get-Content -LiteralPath (Join-Path $testRoot 'stdout.log') -Tail 24
        Get-Content -LiteralPath (Join-Path $testRoot 'stderr.log') -Tail 24
        throw ('电路宿主验收失败：' + $process.ExitCode + '；日志 ' + $testRoot)
    }
    $report = Join-Path $testRoot 'host-report.json'
    if (-not (Test-Path -LiteralPath $report)) { throw ('测试宿主未生成报告：' + $testRoot) }
    Get-Content -LiteralPath $report
} finally { $env:SVTOOLS_CIRCUIT_YOSYS = $previousYosys }
