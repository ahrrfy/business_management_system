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
  [int]$KeepLogLines = 400
)
$ErrorActionPreference = "Stop"
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
$newest = Get-ChildItem $BackupDir -Filter *.sql.gpg -ErrorAction SilentlyContinue |
  Sort-Object Name -Descending | Select-Object -First 1
if (-not $newest) {
  $failures += "no *.sql.gpg files in $BackupDir - pull layer never ran here"
} else {
  # Prefer the UTC stamp embedded in the name (authoritative: when the dump was TAKEN,
  # not when it was copied); fall back to file mtime if the name does not parse.
  $m = [regex]::Match($newest.Name, "\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}")
  if ($m.Success) {
    $stampUtc = [datetime]::ParseExact($m.Value, "yyyy-MM-dd'T'HH-mm-ss", $null)
    $ageH = ((Get-Date).ToUniversalTime() - $stampUtc).TotalHours
  } else {
    $ageH = ((Get-Date) - $newest.LastWriteTime).TotalHours
  }
  if ($ageH -gt $MaxAgeHours) {
    $failures += ("newest offsite backup {0} is {1:N1}h old (> {2}h) - nightly backup on the VPS or the daily pull task is BROKEN" -f $newest.Name, $ageH, $MaxAgeHours)
  }
}

# -- Report --------------------------------------------------------------------
$stamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
if ($failures.Count -eq 0) {
  Add-Content -Path $logFile -Value "$stamp OK  site + backup fresh"
  Write-Host "OK: site up, offsite backup fresh."
} else {
  $msg = $failures -join "; "
  Add-Content -Path $logFile -Value "$stamp FAIL $msg"
  Write-Host "FAIL: $msg"
  # Toast notification so a human actually SEES it (log files rot unread).
  try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
    $texts = $xml.GetElementsByTagName("text")
    $texts.Item(0).AppendChild($xml.CreateTextNode("AlRoya ERP - HEALTH CHECK FAILED")) | Out-Null
    $texts.Item(1).AppendChild($xml.CreateTextNode($msg)) | Out-Null
    $toast = New-Object Windows.UI.Notifications.ToastNotification($xml)
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("AlRoya ERP Monitor").Show($toast)
  } catch {
    Write-Host "(toast unavailable: $($_.Exception.Message))"
  }
}

# -- Log rotation (keep the tail; the log grows one line per day) ---------------
try {
  $lines = Get-Content $logFile -ErrorAction SilentlyContinue
  if ($lines -and $lines.Count -gt $KeepLogLines) {
    $lines | Select-Object -Last $KeepLogLines | Set-Content -Path $logFile
  }
} catch {}

if ($failures.Count -gt 0) { exit 1 }
