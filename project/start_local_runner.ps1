$ErrorActionPreference = 'Stop'
$env:AMAZON_RUNNER_CONCURRENCY = '1'
$env:AMAZON_LAUNCH_INTERVAL_MS = '0'
$runner = Join-Path $PSScriptRoot 'local_runner.cjs'
# Node resolution order: explicit override, then PATH.
$nodeCandidates = @(
  $env:AMAZON_RANK_NODE,
  (Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -ErrorAction SilentlyContinue)
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
if (-not $nodeCandidates) { throw 'Node.js was not found. Install Node.js LTS or set AMAZON_RANK_NODE to node.exe.' }
$existing = Get-CimInstance Win32_Process -Filter "name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($runner) }
foreach ($process in $existing) { Stop-Process -Id $process.ProcessId -Force }
Start-Process -FilePath $nodeCandidates[0] -ArgumentList @($runner) -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
