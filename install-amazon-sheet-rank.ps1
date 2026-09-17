param(
    [string]$InstallRoot,
    [string]$CodexRoot,
    [string]$TencentDocUrl,
    [switch]$SkipDependencyInstall,
    [switch]$SkipUserEnvironment,
    [switch]$SkipDocumentSetup
)
$ErrorActionPreference = 'Stop'
$bundleRoot = $PSScriptRoot
$sourceProject = Join-Path $bundleRoot 'project'
$sourceSkill = Join-Path $bundleRoot 'skill'
$targetProject = if ($InstallRoot) { $InstallRoot } else { Join-Path $env:LOCALAPPDATA 'AmazonSheetRank' }
$codexRoot = if ($CodexRoot) { $CodexRoot } elseif ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$targetSkill = Join-Path (Join-Path $codexRoot 'skills') 'amazon-sheet-rank'

# Never mix newly copied coordinator files with an old process that is still
# collecting a Sheet. The user can rerun the installer after that Sheet ends.
$oldStatusPath = Join-Path $targetProject 'bridge\runner-status.json'
if (Test-Path -LiteralPath $oldStatusPath) {
    try {
        $oldStatus = Get-Content -LiteralPath $oldStatusPath -Raw | ConvertFrom-Json
        $oldAge = ((Get-Date).ToUniversalTime() - ([datetime]$oldStatus.updatedAt).ToUniversalTime()).TotalSeconds
        if ($oldStatus.activeCount -gt 0 -and $oldAge -le 45) { throw 'Existing Amazon runner is busy. Wait for the current Sheet to finish, then install again.' }
    } catch {
        if ($_.Exception.Message -like 'Existing Amazon runner is busy*') { throw }
    }
}

if (-not (Test-Path -LiteralPath (Join-Path $sourceProject 'package.json'))) { throw 'Installer bundle is incomplete: project/package.json missing.' }
if (-not (Test-Path -LiteralPath (Join-Path $sourceSkill 'SKILL.md'))) { throw 'Installer bundle is incomplete: skill/SKILL.md missing.' }
$chrome = @(
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $chrome) { throw 'Google Chrome is required. Install Chrome, then run this installer again.' }
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $node -or -not $npm) { throw 'Node.js LTS with npm is required. Install Node.js, then run this installer again.' }

New-Item -ItemType Directory -Path $targetProject -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path $targetSkill -Parent) -Force | Out-Null
Copy-Item -Path (Join-Path $sourceProject '*') -Destination $targetProject -Recurse -Force
if (Test-Path -LiteralPath $targetSkill) { Remove-Item -LiteralPath $targetSkill -Recurse -Force }
Copy-Item -LiteralPath $sourceSkill -Destination $targetSkill -Recurse -Force
if (-not $SkipDependencyInstall) {
    $npmCache = Join-Path $targetProject '.npm-cache'
    & $npm ci --prefix $targetProject --omit=dev --cache $npmCache
    if ($LASTEXITCODE -ne 0) { throw 'npm dependency installation failed.' }
}
$docConfigPath = Join-Path $targetProject 'tencent-doc-config.json'
if ($TencentDocUrl) {
    & (Join-Path $targetProject 'setup-doc.ps1') -Url $TencentDocUrl
} elseif (Test-Path -LiteralPath $docConfigPath) {
    Write-Host 'Tencent document: existing local configuration preserved.'
} elseif (-not $SkipDocumentSetup) {
    & (Join-Path $targetProject 'setup-doc.ps1')
} else {
    Write-Host 'Tencent document: not configured (test/install override).'
}
if (-not $SkipDocumentSetup -and -not (Test-Path -LiteralPath $docConfigPath)) { throw 'Tencent document configuration is required.' }
if (-not $SkipUserEnvironment) { [Environment]::SetEnvironmentVariable('AMAZON_RANK_PROJECT', $targetProject, 'User') }
$env:AMAZON_RANK_PROJECT = $targetProject
& (Join-Path $targetProject 'start_local_runner.ps1')
Start-Sleep -Seconds 3
$runnerStatus = Get-Content -LiteralPath (Join-Path $targetProject 'bridge\runner-status.json') -Raw | ConvertFrom-Json
$expectedVersion = (Get-Content -LiteralPath (Join-Path $targetProject 'version.json') -Raw | ConvertFrom-Json).version
$heartbeatAge = ((Get-Date).ToUniversalTime() - ([datetime]$runnerStatus.updatedAt).ToUniversalTime()).TotalSeconds
if ($heartbeatAge -gt 45 -or $runnerStatus.version -ne $expectedVersion) { throw "Runner verification failed. expected=$expectedVersion actual=$($runnerStatus.version) age=$heartbeatAge" }
Write-Host "Installed project: $targetProject"
Write-Host "Installed skill:   $targetSkill"
Write-Host "Version:           $expectedVersion"
Write-Host "Runner heartbeat:  OK"
if (-not $env:TENCENT_DOCS_TOKEN) {
    Write-Host 'Tencent authorization is not configured. Run setup-token.ps1 in the installed project.'
}
Write-Host 'Restart Codex once so the new Skill is discovered.'
