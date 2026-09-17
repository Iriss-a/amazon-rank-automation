param([string]$Url)
$ErrorActionPreference = 'Stop'
if (-not $Url) { $Url = Read-Host 'Tencent Docs Sheet URL' }
if (-not $Url) { throw 'Tencent Docs Sheet URL is required.' }
& node.exe (Join-Path $PSScriptRoot 'configure_tencent_doc.cjs') $Url
if ($LASTEXITCODE -ne 0) { throw 'Tencent document configuration failed. Use an https://docs.qq.com/sheet/... URL.' }
