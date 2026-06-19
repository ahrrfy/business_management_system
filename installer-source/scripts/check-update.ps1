#requires -Version 5.1
<#
  check-update.ps1 — Daily self-update for alroya-bridge.exe.
  - Queries CloudUrl/api/installer/latest-version
  - Compares with the local file's known sha256 (stored in version.json)
  - If newer: downloads to .new, verifies sha256, then schedules a replace at
    next bridge restart via MOVEFILE_DELAY_UNTIL_REBOOT.

  No UI. Logs to %APPDATA%\AlruyaERP\logs\update.log
#>
[CmdletBinding()]
param(
  [string]$CloudUrl = 'https://srv1548487.hstgr.cloud'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$AppDataLocal = Join-Path $env:LOCALAPPDATA 'AlruyaERP'
$BridgeExe    = Join-Path $AppDataLocal 'bridge\alroya-bridge.exe'
$VersionFile  = Join-Path $AppDataLocal 'bridge\version.json'
$LogDir       = Join-Path $env:APPDATA 'AlruyaERP\logs'
$LogPath      = Join-Path $LogDir 'update.log'

function Ensure-Dir($p) { if (-not (Test-Path $p)) { New-Item -ItemType Directory -Force -Path $p | Out-Null } }
Ensure-Dir $LogDir
function Log($msg) {
  $line = "[{0}] {1}" -f ((Get-Date).ToString('o')), $msg
  Add-Content -Path $LogPath -Value $line -Encoding UTF8
}

if (-not (Test-Path $BridgeExe)) { Log "no bridge installed; skip"; exit 0 }

$current = $null
if (Test-Path $VersionFile) {
  try { $current = Get-Content $VersionFile -Raw | ConvertFrom-Json } catch { $current = $null }
}
$currentVersion = if ($current) { $current.version } else { 'unknown' }

Log "checking $CloudUrl/api/installer/latest-version (current=$currentVersion)"

$remote = $null
try {
  $remote = Invoke-RestMethod -Uri "$CloudUrl/api/installer/latest-version" -TimeoutSec 15
} catch {
  Log "fetch failed: $($_.Exception.Message)"
  exit 0
}

if (-not $remote -or -not $remote.version -or -not $remote.url -or -not $remote.sha256) {
  Log "bad remote payload: $($remote | ConvertTo-Json -Compress -Depth 4)"
  exit 0
}

if ($remote.version -eq $currentVersion) { Log "already up to date ($currentVersion)"; exit 0 }

Log "new version available: $($remote.version)"

$newExe = "$BridgeExe.new"
try {
  Invoke-WebRequest -Uri $remote.url -OutFile $newExe -TimeoutSec 120
} catch {
  Log "download failed: $($_.Exception.Message)"
  exit 0
}

$hash = (Get-FileHash $newExe -Algorithm SHA256).Hash.ToLower()
if ($hash -ne $remote.sha256.ToLower()) {
  Log "sha256 mismatch: expected=$($remote.sha256) got=$hash"
  Remove-Item $newExe -Force
  exit 0
}

# Backup current and try a clean rename. If bridge is running, the rename fails;
# fall back to MoveFileEx with MOVEFILE_DELAY_UNTIL_REBOOT.
try {
  Copy-Item $BridgeExe "$BridgeExe.bak" -Force
  Move-Item $newExe $BridgeExe -Force
  Log "replaced bridge immediately"
} catch {
  # Schedule pending replacement at next reboot
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public class FileMover {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool MoveFileEx(string lpExistingFileName, string lpNewFileName, int dwFlags);
  public const int MOVEFILE_REPLACE_EXISTING = 0x1;
  public const int MOVEFILE_DELAY_UNTIL_REBOOT = 0x4;
}
'@
  $ok = [FileMover]::MoveFileEx($newExe, $BridgeExe, [FileMover]::MOVEFILE_REPLACE_EXISTING -bor [FileMover]::MOVEFILE_DELAY_UNTIL_REBOOT)
  Log "scheduled replace on reboot (ok=$ok)"
}

# Write version.json so we don't re-download
@{ version = $remote.version; sha256 = $remote.sha256; updatedAt = (Get-Date).ToString('o') } |
  ConvertTo-Json | Out-File -FilePath $VersionFile -Encoding UTF8 -Force

Log "update applied (version=$($remote.version))"
exit 0
