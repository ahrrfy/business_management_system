# Mirror the VPS's retained encrypted backups to the store machine (offsite layer - G4).
# Secures the NEWEST first (+ freshness gate), then backfills any older retained backups the
# store is missing - so a day skipped while this machine was off still reaches the offsite copy
# before it rotates off the server. No plain backups leave the server: only .sql.gpg is pulled;
# decrypting needs BACKUP_GPG_PASSPHRASE.
# NOTE: messages are ASCII-only on purpose - Windows PowerShell 5.1 mis-parses non-ASCII
#       scripts saved as UTF-8 without BOM (proven 2026-06-10).
#
# Manual run:      pnpm backup:pull-vps
# Daily schedule: this script is action [0] of ONE task "AlRoya ERP - Pull VPS Backup";
#   health-check-local.ps1 is action [1] of the SAME task. Task Scheduler runs a task's
#   actions sequentially (each in its own process) => the health check can never read the
#   backup folder mid-download. Do NOT give the health check its own separate timer: when
#   the machine is asleep at the scheduled hour, BOTH catch-up runs (StartWhenAvailable)
#   fire at the same second on wake and the check reads a half-pulled folder => a false
#   "backup stale" toast (proven 2026-07-15). Provision once, as admin, settings baked in:
#     $pull  = New-ScheduledTaskAction -Execute powershell -Argument "-NoProfile -ExecutionPolicy Bypass -File D:\business_management_system\scripts\pull-vps-backup.ps1"
#     $check = New-ScheduledTaskAction -Execute powershell -Argument "-NoProfile -ExecutionPolicy Bypass -File D:\business_management_system\scripts\health-check-local.ps1"
#     $trig  = New-ScheduledTaskTrigger -Daily -At 7:30AM
#     $trig.Repetition = (New-ScheduledTaskTrigger -Once -At 7:30AM -RepetitionInterval (New-TimeSpan -Hours 4) -RepetitionDuration (New-TimeSpan -Hours 16)).Repetition
#     $logon = New-ScheduledTaskTrigger -AtLogOn -User "<store windows user>"
#     $set   = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 10)
#     Register-ScheduledTask -TaskName "AlRoya ERP - Pull VPS Backup" -Action $pull,$check -Trigger $trig,$logon -Settings $set -RunLevel Limited
#   WHY these settings (a single 07:30 attempt is NOT enough - the machine may be OFF then):
#   - AtLogOn + a 4-hourly repeat => it pulls whenever the machine is actually in use, not only at
#     one clock time; RestartCount => a transient SSH/network blip retries instead of losing a day.
#     WakeToRun wakes it from sleep for 07:30; StartWhenAvailable + battery-allowed catch up runs
#     missed while off - default schtasks refuses both (bit us 2026-07-03..06: three days with no
#     offsite pull, Last Result 0x800710E0).
# Requires: SSH key for the VPS + Host alias in ~/.ssh/config (default: alroya-erp).
param(
  [string]$SshHost = "alroya-erp",
  [string]$RemoteDir = "/home/deploy/erp/backups",
  [string]$LocalDir = "$env:USERPROFILE\erp-vps-backups",
  [int]$MaxAgeHours = 26,
  [int]$KeepLocal = 14
)
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force $LocalDir | Out-Null

# Modern scp (SFTP since OpenSSH 9) does not expand $() remotely => ask ssh for the file list first.
$remoteList = ssh $SshHost "ls -1 $RemoteDir/*.sql.gpg 2>/dev/null"
$remoteNames = @("$remoteList" -split "`n" | ForEach-Object { ($_.Trim() -split "/")[-1] } | Where-Object { $_ })
if ($remoteNames.Count -eq 0) {
  Write-Error "No .sql.gpg files on the server - check BACKUP_GPG_PASSPHRASE and the nightly backup cron."
  exit 1
}

# Newest by embedded UTC stamp (timestamped names sort lexically = chronologically).
$name = ($remoteNames | Sort-Object -Descending | Select-Object -First 1)

# 1) CRITICAL PATH: secure the NEWEST backup first (the whole point of the offsite pull).
$newestLocal = Join-Path $LocalDir $name
if (-not (Test-Path $newestLocal)) {
  scp "${SshHost}:$RemoteDir/$name" "$newestLocal"
  if (-not (Test-Path $newestLocal)) { Write-Error "Pull failed - $name did not arrive."; exit 1 }
}

# 2) FRESHNESS GATE on the newest (UTC stamp from backup.mjs). Older than $MaxAgeHours means
#    the nightly backup on the server itself is broken - fail loudly so the health check alerts.
$m = [regex]::Match($name, "\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}")
if ($m.Success) {
  $stampUtc = [datetime]::ParseExact($m.Value, "yyyy-MM-dd'T'HH-mm-ss", $null)
  $ageH = ((Get-Date).ToUniversalTime() - $stampUtc).TotalHours
  if ($ageH -gt $MaxAgeHours) {
    Write-Error ("Newest server backup is {0:N1}h old (> {1}) - nightly backup on the VPS is BROKEN! Check logs/backup.log there." -f $ageH, $MaxAgeHours)
    exit 1
  }
}

# 3) MIRROR / BACKFILL (best-effort): pull any OTHER retained server backups we do not hold yet.
#    A day missed while this machine was off/asleep would otherwise never reach the offsite copy
#    and would rotate off the server (7/4/3) => a permanent hole in disaster recovery. Non-fatal:
#    the newest is already secured above, so a transient scp miss here just retries next run.
$backfilled = 0
foreach ($bn in $remoteNames) {
  $lp = Join-Path $LocalDir $bn
  if (Test-Path $lp) { continue }
  scp "${SshHost}:$RemoteDir/$bn" "$lp"
  if (Test-Path $lp) { $backfilled++ } else { Write-Host "  (backfill deferred - transient miss: $bn)" }
}

if ($m.Success) {
  Write-Host ("OK: newest {0} ({1:N1}h old); {2} older backup(s) backfilled into {3}" -f $name, $ageH, $backfilled, $LocalDir)
} else {
  Write-Host ("OK: newest {0}; {1} older backup(s) backfilled into {2} (timestamp unparsed)" -f $name, $backfilled, $LocalDir)
}

# Local rotation: keep the newest $KeepLocal files (names are timestamped => name sort = time sort).
Get-ChildItem $LocalDir -Filter *.sql.gpg |
  Sort-Object Name -Descending |
  Select-Object -Skip $KeepLocal |
  Remove-Item -Force
