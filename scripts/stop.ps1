param()
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskPidFile = Join-Path $taskRoot 'data/server.pid'
if (!(Test-Path -LiteralPath $taskPidFile)) { Write-Output 'This copy is not running.'; exit 0 }
$taskServerPid = [int](Get-Content -LiteralPath $taskPidFile)
$taskProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$taskServerPid"
if (!$taskProcess) { Write-Output 'This copy is not running.'; exit 0 }
$taskExpectedNode = Join-Path $taskRoot 'runtime/node.exe'
if (!(Test-Path -LiteralPath $taskExpectedNode)) { $taskExpectedNode = (Get-Command node.exe).Source }
if ($taskProcess.ExecutablePath -ne $taskExpectedNode -or $taskProcess.CommandLine -notmatch '--import tsx server/index.ts') { throw 'Process identity changed; nothing was stopped.' }
$taskPort = 4317
if ($env:PORT -match '^\d+$') { $taskPort = [int]$env:PORT }
$taskEnv = Join-Path $taskRoot '.env'
if (Test-Path -LiteralPath $taskEnv) {
  $taskLine = Get-Content -LiteralPath $taskEnv | Where-Object { $_ -match '^PORT=\d+$' } | Select-Object -Last 1
  if ($taskLine) { $taskPort = [int]($taskLine -replace '^PORT=', '') }
}
$taskHasher = [Security.Cryptography.SHA256]::Create()
try { $taskInstallationId = ([BitConverter]::ToString($taskHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($taskRoot.ToLowerInvariant())))).Replace('-', '').ToLowerInvariant().Substring(0, 16) }
finally { $taskHasher.Dispose() }
$taskStatus = Invoke-RestMethod -Uri "http://127.0.0.1:$taskPort/api/status" -TimeoutSec 3
if ($taskStatus.application -ne 'zhihang' -or $taskStatus.installationId -ne $taskInstallationId) { throw 'A different installation is using this port; nothing was stopped.' }
$taskListeners = @(Get-NetTCPConnection -LocalPort $taskPort -State Listen -ErrorAction Stop)
if ($taskListeners.Count -ne 1 -or $taskListeners[0].OwningProcess -ne $taskServerPid) { throw 'The listener identity changed; nothing was stopped.' }
Stop-Process -Id $taskServerPid
Write-Output 'Zhihang stopped. Saved data remains in this folder.'
