param([Parameter(Mandatory = $true)][string]$CodePath)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$testRoot = Join-Path $repoRoot ('bin/vivado-host/run-' + [guid]::NewGuid().ToString('N'))
$testWorkspace = Join-Path $testRoot 'workspace'
$profilePath = Join-Path $testRoot 'profile'
$extensionsPath = Join-Path $testRoot 'extensions'
New-Item -ItemType Directory -Path $testWorkspace,$extensionsPath,(Join-Path $profilePath 'User') -Force | Out-Null
Set-Content -LiteralPath (Join-Path $profilePath 'User/settings.json') -Encoding utf8 -Value '{"update.mode":"none","extensions.autoUpdate":false,"telemetry.telemetryLevel":"off","workbench.startupEditor":"none"}'
Set-Content -LiteralPath (Join-Path $testWorkspace 'top.sv') -Encoding utf8 -Value 'module top; leaf u_leaf(); endmodule'
Set-Content -LiteralPath (Join-Path $testWorkspace 'leaf.sv') -Encoding utf8 -Value 'module leaf; endmodule'
Set-Content -LiteralPath (Join-Path $testWorkspace 'orphan.sv') -Encoding utf8 -Value 'module orphan; endmodule'
$projectText = @'
<Project><FileSets><FileSet Name="sources_1" Type="DesignSrcs"><File Path="$PPRDIR/top.sv"/><File Path="$PPRDIR/leaf.sv"/><Config><Option Name="TopModule" Val="top"/></Config></FileSet><FileSet Name="sim_1" Type="SimulationSrcs"/></FileSets></Project>
'@
Set-Content -LiteralPath (Join-Path $testWorkspace 'design.xpr') -Encoding utf8 -Value $projectText
$testFile = Join-Path $repoRoot 'test/vscode_vivado_host.js'
$arguments = @('--new-window','--disable-extensions','--disable-workspace-trust','--skip-welcome','--skip-release-notes',
    ('--user-data-dir="' + $profilePath + '"'),('--extensions-dir="' + $extensionsPath + '"'),
    ('--extensionDevelopmentPath="' + $repoRoot + '"'),('--extensionTestsPath="' + $testFile + '"'),('"' + $testWorkspace + '"'))
# 独立用户目录、扩展目录和窗口；测试完成由 VS Code 测试宿主退出，不安装到用户环境。
$process = Start-Process -FilePath $CodePath -ArgumentList $arguments -WindowStyle Hidden -PassThru -Wait `
    -RedirectStandardOutput (Join-Path $testRoot 'stdout.log') -RedirectStandardError (Join-Path $testRoot 'stderr.log')
if ($process.ExitCode -ne 0) {
    Get-Content -LiteralPath (Join-Path $testRoot 'stdout.log') -Tail 30
    Get-Content -LiteralPath (Join-Path $testRoot 'stderr.log') -Tail 30
    throw ('VS Code 宿主验收失败，退出码 ' + $process.ExitCode + '；日志 ' + $testRoot)
}
$report = Join-Path $testRoot 'host-report.json'
if (-not (Test-Path -LiteralPath $report)) { throw ('测试宿主未生成报告：' + $testRoot) }
Get-Content -LiteralPath $report
Write-Output ('宿主验收报告：' + $report)
