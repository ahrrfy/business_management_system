# Pull the newest encrypted backup from the VPS to the store machine (offsite layer - G4).
# No plain backups leave the server: only .sql.gpg is pulled; decrypting needs BACKUP_GPG_PASSPHRASE.
# NOTE: messages are ASCII-only on purpose - Windows PowerShell 5.1 mis-parses non-ASCII
#       scripts saved as UTF-8 without BOM (proven 2026-06-10).
#
# Manual run:      pnpm backup:pull-vps
# Daily schedule (once, as admin):
#   schtasks /Create /TN "AlRoya ERP - Pull VPS Backup" /SC DAILY /ST 07:30 /F ^
#     /TR "powershell -NoProfile -ExecutionPolicy Bypass -File D:\business_management_system\scripts\pull-vps-backup.ps1"
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

# Modern scp (SFTP since OpenSSH 9) does not expand $() remotely => ask ssh for the name first.
$newest = ssh $SshHost "ls -t $RemoteDir/*.sql.gpg 2>/dev/null | head -1"
if (-not $newest) {
  Write-Error "No .sql.gpg files on the server - check BACKUP_GPG_PASSPHRASE and the nightly backup cron."
  exit 1
}
$newest = "$newest".Trim()
$name = ($newest -split "/")[-1]

scp "${SshHost}:$newest" "$LocalDir\$name"
if (-not (Test-Path "$LocalDir\$name")) { Write-Error "Pull failed - file did not arrive."; exit 1 }

# Freshness check from the filename (UTC stamp from backup.mjs):
# a copy older than $MaxAgeHours means the nightly backup on the server is broken.
$m = [regex]::Match($name, "\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}")
if ($m.Success) {
  $stampUtc = [datetime]::ParseExact($m.Value, "yyyy-MM-dd'T'HH-mm-ss", $null)
  $ageH = ((Get-Date).ToUniversalTime() - $stampUtc).TotalHours
  if ($ageH -gt $MaxAgeHours) {
    Write-Error ("Newest server backup is {0:N1}h old (> {1}) - nightly backup on the VPS is BROKEN! Check logs/backup.log there." -f $ageH, $MaxAgeHours)
    exit 1
  }
  Write-Host ("OK: pulled {0} ({1:N1}h old) into {2}" -f $name, $ageH, $LocalDir)
} else {
  Write-Host "OK: pulled $name into $LocalDir (could not parse timestamp from name)"
}

# Local rotation: keep the newest $KeepLocal files (names are timestamped => name sort = time sort).
Get-ChildItem $LocalDir -Filter *.sql.gpg |
  Sort-Object Name -Descending |
  Select-Object -Skip $KeepLocal |
  Remove-Item -Force
