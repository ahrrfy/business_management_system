#requires -Version 5.1
<#
  uninstall.ps1 — Cleanly remove everything install.ps1 created.
  Reads install-manifest.json for the exact paths and tasks to undo.
  Safe to run multiple times.
#>
[CmdletBinding()]
param([switch]$Force)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$AppDataLocal = Join-Path $env:LOCALAPPDATA 'AlruyaERP'
$AppDataRoam  = Join-Path $env:APPDATA 'AlruyaERP'
$Manifest     = Join-Path $AppDataLocal 'install-manifest.json'

function Try-Remove($path) {
  if ($path -and (Test-Path $path)) {
    try {
      Remove-Item -Path $path -Recurse -Force -ErrorAction Stop
      Write-Host "  ✓ حُذف: $path" -ForegroundColor Green
    } catch {
      Write-Host "  ⚠ تعذّر حذف $path : $($_.Exception.Message)" -ForegroundColor Yellow
    }
  }
}

function Stop-BridgeProcess {
  try {
    Get-Process -Name 'alroya-bridge' -ErrorAction SilentlyContinue | ForEach-Object {
      Write-Host "  إيقاف عملية: PID=$($_.Id)" -ForegroundColor Gray
      $_.Kill()
    }
  } catch { }
}

function Unschedule($taskName) {
  try {
    schtasks.exe /delete /tn $taskName /f 2>$null | Out-Null
    Write-Host "  ✓ ألغيت المهمّة: $taskName" -ForegroundColor Green
  } catch { }
}

Write-Host ""
Write-Host "حذف نظام الرؤية العربية من هذا الجهاز..." -ForegroundColor Cyan
Write-Host ""

if (-not $Force) {
  $a = Read-Host "هل أنت متأكّد؟ سيُحذَف الجسر والإعدادات والاختصارات. [نعم/لا]"
  if ($a.ToLower() -notin @('y','yes','نعم','ن')) {
    Write-Host "أُلغي الحذف."
    exit 0
  }
}

$manifestData = $null
if (Test-Path $Manifest) {
  try { $manifestData = Get-Content $Manifest -Raw | ConvertFrom-Json } catch { $manifestData = $null }
}

# Stop running bridge first
Stop-BridgeProcess

# Unschedule tasks
foreach ($t in @('AlroyaBridge','AlroyaUpdate')) { Unschedule $t }
if ($manifestData -and $manifestData.tasks) {
  foreach ($t in $manifestData.tasks) { Unschedule $t }
}

# Remove shortcuts
$desktopLnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'الرؤية العربية.lnk'
$startupLnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'الرؤية العربية.lnk'
$startMenuLnk = Join-Path ([Environment]::GetFolderPath('Programs')) 'الرؤية العربية.lnk'
Try-Remove $desktopLnk
Try-Remove $startupLnk
Try-Remove $startMenuLnk

# Remove app data
Try-Remove $AppDataLocal
Try-Remove $AppDataRoam

Write-Host ""
Write-Host "  ✓ تم الحذف — الجهاز أصبح نظيفاً." -ForegroundColor Green
Write-Host ""
exit 0
