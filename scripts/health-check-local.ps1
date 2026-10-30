# Local operational monitor (store machine) - two checks, toast + log + exit code on failure:
#   1. Production site liveness:  GET https://<host>/healthz must return 200.
#   2. Offsite backup freshness:  newest *.sql.gpg in $BackupDir must be < $MaxAgeHours old
#      (covers BOTH failure modes: nightly backup broken on the VPS *or* the daily pull
#       task broken on this machine - either way the newest local file goes stale).
# NOTE: messages are ASCII-only on purpose - Windows PowerShell 5.1 mis-parses non-ASCII
#       scripts saved as UTF-8 without BOM (proven 2026-06-10).
#
# Manual run:      pnpm health:check
# Schedule: do NOT give this its own daily trigger. It runs as action [1] of the single
#   "AlRoya ERP - Pull VPS Backup" task, right after the pull action, so it always reads a
#   fully-downloaded backup folder. A separate timer here races the pull on catch-up wakes
#   (both fire at once when the machine boots after being asleep) and fires false "backup
#   stale" toasts (proven 2026-07-15). See the head of scripts/pull-vps-backup.ps1 for the
#   one-shot Register-ScheduledTask that wires pull + check into one task.
param(
  [string]$SiteUrl = "https://srv1548487.hstgr.cloud/healthz",
  [string]$BackupDir = "$env:USERPROFILE\erp-vps-backups",
  [int]$MaxAgeHours = 26,
  [int]$KeepLogLines = 400,
  [switch]$NoToast
)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot 'lib/offsite-integrity.ps1')
$logFile = Join-Path $BackupDir "health-check.log"
New-Item -ItemType Directory -Force $BackupDir | Out-Null
$failures = @()

# -- Check 1: site liveness ---------------------------------------------------
try {
  # TLS 1.2 explicitly - PS 5.1 defaults can be older than what the server accepts.
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $resp = Invoke-WebRequest -Uri $SiteUrl -UseBasicParsing -TimeoutSec 30
  if ($resp.StatusCode -ne 200) { $failures += "site returned HTTP $($resp.StatusCode) (expected 200)" }
} catch {
  $failures += "site unreachable: $($_.Exception.Message)"
}

# -- Check 2: offsite backup freshness ----------------------------------------
$lock = $null
try {
  if ($MaxAgeHours -le 0) { throw 'Invalid age limit' }
  $lock = Open-BackupLock $BackupDir
  $newest = Get-ChildItem -LiteralPath $BackupDir -Filter *.sql.gpg -File |
    Sort-Object Name -Descending | Select-Object -First 1
  if (-not $newest) { throw 'No encrypted offsite backup found' }
  $manifest = Read-BackupManifest (Get-Content -LiteralPath "$($newest.FullName).manifest.json" -Raw) $newest.Name
  Assert-BackupIntegrity $newest.FullName $manifest
  $ageH = Get-BackupAgeHours $newest.Name
  if ($ageH -gt $MaxAgeHours) { throw 'Newest integrity-verified backup is stale' }
} catch {
  $failures += "offsite integrity/freshness failed: $($_.Exception.Message)"
} finally {
  if ($null -ne $lock) { $lock.Dispose() }
}
# -- Report --------------------------------------------------------------------
$stamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
if ($failures.Count -eq 0) {
  Add-Content -Path $logFile -Value "$stamp OK  site + backup integrity/freshness (restore not verified)"
  Write-Host "OK: site up, offsite backup integrity/freshness verified; restore verification is separate."
} else {
  $msg = $failures -join "; "
  Add-Content -Path $logFile -Value "$stamp FAIL $msg"
  Write-Host "FAIL: $msg"
  # Toast notification so a human actually SEES it (log files rot unread).
  if (-not $NoToast) { try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
    $texts = $xml.GetElementsByTagName("text")
    $texts.Item(0).AppendChild($xml.CreateTextNode("AlRoya ERP - HEALTH CHECK FAILED")) | Out-Null
    $texts.Item(1).AppendChild($xml.CreateTextNode($msg)) | Out-Null
    $toast = New-Object Windows.UI.Notifications.ToastNotification($xml)
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("AlRoya ERP Monitor").Show($toast)
  } catch {
    Write-Host "(toast unavailable: $($_.Exception.Message))"
  } }
}

# -- Log rotation (keep the tail; the log grows one line per day) ---------------
try {
  $lines = Get-Content $logFile -ErrorAction SilentlyContinue
  if ($lines -and $lines.Count -gt $KeepLogLines) {
    $lines | Select-Object -Last $KeepLogLines | Set-Content -Path $logFile
  }
} catch {}

if ($failures.Count -gt 0) { exit 1 }
