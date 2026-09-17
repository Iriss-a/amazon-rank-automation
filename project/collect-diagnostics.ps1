param(
    [string[]]$Sheets,
    [string]$OutputPath
)
$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
if (-not $OutputPath) {
    $OutputPath = Join-Path $env:TEMP "amazon-sheet-rank-diagnostics-$stamp"
}

if (Test-Path -LiteralPath $OutputPath) {
    throw "Output path already exists: $OutputPath"
}

New-Item -ItemType Directory -Path $OutputPath -Force | Out-Null

function Copy-IfExists {
    param([string]$Path, [string]$Destination)
    if (Test-Path -LiteralPath $Path) {
        New-Item -ItemType Directory -Path (Split-Path $Destination -Parent) -Force | Out-Null
        Copy-Item -LiteralPath $Path -Destination $Destination -Force
    }
}

Copy-IfExists (Join-Path $root 'version.json') (Join-Path $OutputPath 'version.json')
Copy-IfExists (Join-Path $root 'bridge\runner-status.json') (Join-Path $OutputPath 'bridge\runner-status.json')

$stateDir = Join-Path $root 'state'
$bridgeDirs = @{
    logs = Join-Path $root 'bridge\logs'
    executions = Join-Path $root 'bridge\executions'
    results = Join-Path $root 'bridge\results'
    tasks = Join-Path $root 'bridge\tasks'
}

if ($Sheets -and $Sheets.Count) {
    foreach ($sheet in $Sheets) {
        $safe = ($sheet -replace '[^\w.-]+', '-').Trim('-')
        Copy-IfExists (Join-Path $stateDir "tencent-sheet-$safe-state.json") (Join-Path $OutputPath "state\tencent-sheet-$safe-state.json")
        Copy-IfExists (Join-Path $stateDir "tencent-sheet-$safe.paused.json") (Join-Path $OutputPath "state\tencent-sheet-$safe.paused.json")
    }
} elseif (Test-Path -LiteralPath $stateDir) {
    New-Item -ItemType Directory -Path (Join-Path $OutputPath 'state') -Force | Out-Null
    Get-ChildItem -LiteralPath $stateDir -Filter '*.json' -File -ErrorAction SilentlyContinue |
        Copy-Item -Destination (Join-Path $OutputPath 'state') -Force
}

foreach ($name in $bridgeDirs.Keys) {
    $dir = $bridgeDirs[$name]
    if (-not (Test-Path -LiteralPath $dir)) { continue }
    $target = Join-Path $OutputPath "bridge\$name"
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 20 |
        Copy-Item -Destination $target -Force
}

$zipPath = "$OutputPath.zip"
Compress-Archive -LiteralPath $OutputPath -DestinationPath $zipPath -CompressionLevel Optimal -Force
Write-Host "Diagnostics package: $zipPath"
Write-Host 'This package excludes Tencent tokens and document config.'
