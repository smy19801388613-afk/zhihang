param([switch]$NoOpenBrowser)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $taskRoot
$taskPort = 4317
if ($env:PORT -match '^\d+$') { $taskPort = [int]$env:PORT }
$taskEnvPath = Join-Path $taskRoot '.env'
if (Test-Path -LiteralPath $taskEnvPath) {
  $taskPortLine = Get-Content -LiteralPath $taskEnvPath | Where-Object { $_ -match '^PORT=\d+$' } | Select-Object -Last 1
  if ($taskPortLine) { $taskPort = [int]($taskPortLine -replace '^PORT=', '') }
}
$taskUrl = "http://127.0.0.1:$taskPort"
$env:PORT = [string]$taskPort
$taskBundledNode = Join-Path $taskRoot 'runtime/node.exe'
$taskPortable = Test-Path -LiteralPath $taskBundledNode
if ($taskPortable) { $env:DATA_DIR = Join-Path $taskRoot 'data' }
$taskHasher = [Security.Cryptography.SHA256]::Create()
try { $taskInstallationId = ([BitConverter]::ToString($taskHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($taskRoot.ToLowerInvariant())))).Replace('-', '').ToLowerInvariant().Substring(0, 16) }
finally { $taskHasher.Dispose() }
$taskStatus = $null
try {
  $taskStatus = Invoke-RestMethod -Uri "$taskUrl/api/status" -TimeoutSec 2
} catch {}
if ($taskStatus) {
  if ($taskStatus.application -eq 'zhihang' -and $taskStatus.installationId -eq $taskInstallationId) { if (!$NoOpenBrowser) { Start-Process $taskUrl }; exit 0 }
  throw 'Port 4317 is occupied by another installation. Close that application first; this copy will not open its workspace.'
}
if ($taskPortable) {
  $taskNode = $taskBundledNode
  if (!(Test-Path -LiteralPath (Join-Path $taskRoot 'node_modules/tsx/dist/loader.mjs')) -or !(Test-Path -LiteralPath (Join-Path $taskRoot 'dist/index.html'))) { throw 'The portable package is incomplete. Extract the whole ZIP to a writable folder before starting.' }
} else {
  $taskNodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if (!$taskNodeCommand) { throw 'Node.js 24 or newer is required for the source edition. Use the Windows portable ZIP to start without installing Node.js.' }
  $taskNode = $taskNodeCommand.Source
}
$taskNodeVersion = & $taskNode --version
$taskNodeMajor = (($taskNodeVersion -replace '^v', '') -split '\.')[0]
if ($LASTEXITCODE -ne 0 -or [int]$taskNodeMajor -lt 24) { throw 'Node.js 24 or newer is required.' }
if (!(Test-Path -LiteralPath (Join-Path $taskRoot 'node_modules'))) {
  & npm.cmd ci --no-fund --no-audit
  if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
}
if (!(Test-Path -LiteralPath (Join-Path $taskRoot 'dist/index.html'))) {
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
}
$taskData = Join-Path $taskRoot 'data'
New-Item -ItemType Directory -Path $taskData -Force | Out-Null
$taskLogSuffix = Get-Date -Format 'yyyyMMdd-HHmmss'
$taskProcess = Start-Process -FilePath $taskNode -ArgumentList '--import','tsx','server/index.ts' -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskData "server-$taskLogSuffix.log") -RedirectStandardError (Join-Path $taskData "server-$taskLogSuffix.error.log")
$taskProcess.Id | Set-Content -LiteralPath (Join-Path $taskData 'server.pid')
try {
  for ($taskAttempt = 0; $taskAttempt -lt 30; $taskAttempt++) {
    Start-Sleep -Milliseconds 500
    $taskProcess.Refresh()
    if ($taskProcess.HasExited) { throw 'Server exited. Read data/server-*.error.log for details.' }
    try {
      $taskStatus = Invoke-RestMethod -Uri "$taskUrl/api/status" -TimeoutSec 2
      if ($taskStatus.application -eq 'zhihang' -and $taskStatus.installationId -eq $taskInstallationId) { if (!$NoOpenBrowser) { Start-Process $taskUrl }; exit 0 }
    } catch {}
  }
  throw 'Server did not become ready. Read data/server-*.error.log for details.'
} catch {
  $taskProcess.Refresh()
  if (!$taskProcess.HasExited) { Stop-Process -Id $taskProcess.Id -ErrorAction SilentlyContinue }
  throw
}
