#requires -Version 5.1
<#
  test-print.ps1 — Send a signed test-print request to the local bridge.
  Used at the end of install.ps1 to verify the printer is wired correctly.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$Secret,
  [int]$Port = 9101,
  [ValidateSet('receipt','label')][string]$Kind = 'receipt'
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$body = @{ kind = $Kind } | ConvertTo-Json -Compress
$bytes = [System.Text.Encoding]::UTF8.GetBytes($body)

# HMAC-SHA256 (hex) of the raw body
$hmac = New-Object System.Security.Cryptography.HMACSHA256
$hmac.Key = [System.Text.Encoding]::UTF8.GetBytes($Secret)
$sigBytes = $hmac.ComputeHash($bytes)
$sigHex = [BitConverter]::ToString($sigBytes).Replace('-','').ToLower()

$url = "http://127.0.0.1:$Port/test-print"

try {
  # -UseBasicParsing لتفادي IE COM initialization على PowerShell 5.1 (يفشل في إعدادات مقيَّدة).
  $resp = Invoke-RestMethod -Uri $url -Method Post -ContentType 'application/json' -Body $body -Headers @{ 'X-Alroya-Sig' = $sigHex } -TimeoutSec 15 -UseBasicParsing
  if ($resp.ok) {
    Write-Host "✓ اختبار الطباعة نجح" -ForegroundColor Green
    exit 0
  } else {
    Write-Host "✗ الجسر ردّ: $($resp.error)" -ForegroundColor Red
    exit 2
  }
} catch {
  Write-Host "✗ تعذّر الوصول للجسر: $($_.Exception.Message)" -ForegroundColor Red
  exit 3
}
