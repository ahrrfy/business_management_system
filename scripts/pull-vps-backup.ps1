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
. (Join-Path $PSScriptRoot 'lib/offsite-integrity.ps1')
if ($SshHost -notmatch '^[A-Za-z0-9][A-Za-z0-9_.@-]*$' -or
    $RemoteDir -notmatch '^/[A-Za-z0-9_./-]+$' -or $RemoteDir -match '(^|/)\.\.(/|$)' -or $MaxAgeHours -le 0) {
  throw 'Unsafe host, remote directory or age limit'
}
New-Item -ItemType Directory -Force -Path $LocalDir | Out-Null
$lock = Open-BackupLock $LocalDir
try {
  $remoteList = @(ssh -o BatchMode=yes -o ConnectTimeout=15 $SshHost "ls -1 '$RemoteDir/'*.sql.gpg 2>/dev/null")
  if ($LASTEXITCODE -ne 0) { throw 'Remote backup listing failed' }
  $remoteNames = @($remoteList | ForEach-Object { ($_.Trim() -split '/')[-1] } | Where-Object { $_ } | Sort-Object -Unique -Descending)
  if (-not $remoteNames.Count) { throw 'No encrypted backups found' }
  foreach ($name in $remoteNames) { Assert-BackupName $name }
  $age = Get-BackupAgeHours $remoteNames[0]
  if ($age -gt $MaxAgeHours) { throw 'Newest server backup is stale' }
  $verified = 0
  foreach ($name in $remoteNames) {
    try {
      # A manifest is the source publication marker. Never trust legacy existence alone.
      $json = @(ssh -o BatchMode=yes -o ConnectTimeout=15 $SshHost "cat '$RemoteDir/$name.manifest.json'") -join "`n"
      if ($LASTEXITCODE -ne 0) { throw 'Source manifest missing or unreadable' }
      $manifest = Read-BackupManifest $json $name
      $local = Join-Path $LocalDir $name
      $receipt = "$local.manifest.json"
      $valid = $false
      if (Test-Path -LiteralPath $local) {
        try { Assert-BackupIntegrity $local $manifest; $valid = $true } catch { $valid = $false }
      }
      if (-not $valid) {
        $partial = "$local.$([guid]::NewGuid().ToString('N')).partial"
        scp -o BatchMode=yes -o ConnectTimeout=15 "${SshHost}:$RemoteDir/$name" $partial
        if ($LASTEXITCODE -ne 0) { throw 'Transfer failed; incomplete file is not a published backup' }
        Assert-BackupIntegrity $partial $manifest
        # Keep the unverified original as evidence. Never overwrite or delete it.
        if (Test-Path -LiteralPath $local) { [IO.File]::Move($local, "$local.unverified-$([guid]::NewGuid().ToString('N'))") }
        [IO.File]::Move($partial, $local)
      }
      # Recheck the immutable source marker before publishing the local receipt.
      $afterJson = @(ssh -o BatchMode=yes -o ConnectTimeout=15 $SshHost "cat '$RemoteDir/$name.manifest.json'") -join "`n"
      if ($LASTEXITCODE -ne 0) { throw 'Could not recheck source publication' }
      $after = Read-BackupManifest $afterJson $name
      if ($after.sha256 -cne $manifest.sha256 -or $after.size -ne $manifest.size) { throw 'Source publication changed' }
      $pendingReceipt = "$receipt.$([guid]::NewGuid().ToString('N')).partial"
      [IO.File]::WriteAllText($pendingReceipt, $json, (New-Object Text.UTF8Encoding($false)))
      if (Test-Path -LiteralPath $receipt) { [IO.File]::Move($receipt, "$receipt.previous-$([guid]::NewGuid().ToString('N'))") }
      [IO.File]::Move($pendingReceipt, $receipt)
      $verified++
    } catch {
      if ($name -ceq $remoteNames[0]) { throw }
      Write-Warning "Backfill deferred: $name ($($_.Exception.Message))"
    }
  }
  Write-Host "OK: newest integrity verified; $verified backup(s) verified. Restore verification is separate."
  # KeepLocal retained for invocation compatibility. No pruning without a proven recovery set.
  Write-Host 'Retention paused; no existing files deleted.'
} finally {
  $lock.Dispose()
}
exit 0
