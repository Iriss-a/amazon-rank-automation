param(
    [ValidateSet('run', 'resume', 'status', 'pause')]
    [string]$Action = 'run',
    [Parameter(Mandatory = $true)]
    [string[]]$Sheets,
    [switch]$RecheckNotFound
)
$ErrorActionPreference = 'Stop'
$projectRoot = if ($env:AMAZON_RANK_PROJECT) { $env:AMAZON_RANK_PROJECT } else { Join-Path $env:LOCALAPPDATA 'AmazonSheetRank' }
$entry = Join-Path $projectRoot 'run_owned_sheets.cjs'
if (-not (Test-Path -LiteralPath $entry)) { throw "Amazon Sheet Rank project is not installed at $projectRoot" }
if ($Sheets.Count -eq 0 -or $Sheets.Where({ [string]::IsNullOrWhiteSpace($_) -or $_ -match '[*?]' -or $_ -ieq 'all' }).Count) {
    throw 'Supply one or more exact Sheet names. Wildcards and all are not allowed.'
}
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'Node.js is missing. Run the Amazon Sheet Rank installer first.' }
if ($Action -in @('run', 'resume')) {
    $expected = $null
    $actual = $null
    $status = $null
    try { $expected = (Get-Content -LiteralPath (Join-Path $projectRoot 'version.json') -Raw | ConvertFrom-Json).version } catch {}
    try { $status = Get-Content -LiteralPath (Join-Path $projectRoot 'bridge\runner-status.json') -Raw | ConvertFrom-Json; $actual = $status.version } catch {}
    $age = if ($status -and $status.updatedAt) { ((Get-Date).ToUniversalTime() - ([datetime]$status.updatedAt).ToUniversalTime()).TotalSeconds } else { [double]::PositiveInfinity }
    $runnerAlive = $false
    if ($status -and $status.pid) {
        $runnerAlive = [bool](Get-Process -Id $status.pid -ErrorAction SilentlyContinue)
    }
    if ($status -and $status.activeCount -gt 0 -and $runnerAlive -and ($age -gt 45 -or ($expected -and $actual -ne $expected))) {
        throw "Runner is busy but stale or version-mismatched. Let the current Sheet finish before upgrading/restarting. expected=$expected actual=$actual"
    }
    if (-not $status -or $age -gt 45 -or ($expected -and $actual -ne $expected)) {
        & (Join-Path $projectRoot 'start_local_runner.ps1')
        Start-Sleep -Seconds 3
        $status = Get-Content -LiteralPath (Join-Path $projectRoot 'bridge\runner-status.json') -Raw | ConvertFrom-Json
        $age = ((Get-Date).ToUniversalTime() - ([datetime]$status.updatedAt).ToUniversalTime()).TotalSeconds
        if ($age -gt 45 -or ($expected -and $status.version -ne $expected)) { throw 'Runner failed post-start heartbeat/version verification.' }
    }
}
$args = @($entry, $Action, ("--sheets=" + ($Sheets -join ',')))
if ($RecheckNotFound) { $args += '--recheck-not-found' }
& $node @args
exit $LASTEXITCODE
