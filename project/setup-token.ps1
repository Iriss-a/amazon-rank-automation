param([SecureString]$Token)
$ErrorActionPreference = 'Stop'
if (-not $Token) { $Token = Read-Host 'Tencent Docs authorization token' -AsSecureString }
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Token)
try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
if ([string]::IsNullOrWhiteSpace($plain)) { throw 'Tencent Docs token cannot be empty.' }
[Environment]::SetEnvironmentVariable('TENCENT_DOCS_TOKEN', $plain, 'User')
$tokenPath = Join-Path $PSScriptRoot '.tencent-docs-token'
[IO.File]::WriteAllText($tokenPath, $plain, [Text.UTF8Encoding]::new($false))
Write-Host 'Tencent Docs authorization saved for the current Windows user.'
