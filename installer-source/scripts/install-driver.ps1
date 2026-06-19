#requires -Version 5.1
<#
  install-driver.ps1 — Apply WinUSB driver to a USB device by VID/PID (advanced/optional path).
  Requires admin. Used only when the user explicitly chose "escpos-usb" mode for direct
  ESC/POS over USB (bypasses Windows print spooler entirely).

  Default path (spooler) does not call this script — printers installed via Windows driver
  work directly through the bridge.

  Strategy:
    1. Try `pnputil /add-driver <inf> /install` with a generated WinUSB INF (cleanest).
    2. Fall back to libwdi-cli.exe if shipped in resources/drivers/ (covers older Windows).
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$Vid,
  [Parameter(Mandatory=$true)][string]$Pid,
  [string]$DeviceName = "Al-Ru'ya printer",
  [string]$ResourcesDir = $(Join-Path $PSScriptRoot '..' 'resources' 'drivers')
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Test-IsAdmin {
  $current = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  return $current.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdmin)) {
  Write-Host "تعريف WinUSB يحتاج صلاحيات المسؤول. أعد تشغيل المُثبِّت بصلاحيات Administrator." -ForegroundColor Yellow
  exit 87
}

# Normalize VID/PID to 4-char hex without 0x
$vidHex = ($Vid -replace '0x', '').ToUpper().PadLeft(4, '0')
$pidHex = ($Pid -replace '0x', '').ToUpper().PadLeft(4, '0')

# Try libwdi-cli first if available (it generates+installs WinUSB INF in one shot).
$libwdi = Join-Path $ResourcesDir 'libwdi-cli.exe'
if (Test-Path $libwdi) {
  Write-Host "محاولة تثبيت WinUSB عبر libwdi لـ VID_$vidHex / PID_$pidHex ..."
  try {
    & $libwdi --vid "0x$vidHex" --pid "0x$pidHex" --type winusb --name $DeviceName --quiet
    if ($LASTEXITCODE -eq 0) {
      Write-Host "✓ تم تطبيق تعريف WinUSB بنجاح." -ForegroundColor Green
      exit 0
    } else {
      Write-Host "libwdi فشل (رمز $LASTEXITCODE) — نُجرّب pnputil ..." -ForegroundColor Yellow
    }
  } catch {
    Write-Host "libwdi رمى خطأ: $($_.Exception.Message)" -ForegroundColor Yellow
  }
}

# Fallback: generate a minimal WinUSB INF and use pnputil.
$infText = @"
[Version]
Signature   = "`$Windows NT`$"
Class       = USBDevice
ClassGuid   = {88BAE032-5A81-49f0-BC3D-A4FF138216D6}
Provider    = %Provider%
DriverVer   = 01/01/2026,1.0.0.0
CatalogFile = AlroyaWinUSB.cat

[Manufacturer]
%Provider% = Standard,NTamd64

[Standard.NTamd64]
%DeviceName% = USB_Install, USB\VID_$vidHex&PID_$pidHex

[USB_Install]
Include    = winusb.inf
Needs      = WINUSB.NT

[USB_Install.Services]
Include    = winusb.inf
Needs      = WINUSB.NT.Services

[Strings]
Provider   = "Al-Ru'ya"
DeviceName = "$DeviceName"
"@

$tmpDir = Join-Path $env:TEMP "alroya-winusb-$vidHex-$pidHex"
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
$infPath = Join-Path $tmpDir 'AlroyaWinUSB.inf'
Set-Content -Path $infPath -Value $infText -Encoding ASCII

Write-Host "محاولة pnputil لـ VID_$vidHex / PID_$pidHex ..."
try {
  & pnputil.exe /add-driver $infPath /install
  if ($LASTEXITCODE -eq 0) {
    Write-Host "✓ pnputil أنهى التعريف بنجاح." -ForegroundColor Green
    exit 0
  }
} catch {
  Write-Host "pnputil فشل: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host "تعذّر تطبيق WinUSB. يمكنك استخدام Zadig يدوياً من مجلد resources\drivers\zadig.exe" -ForegroundColor Yellow
exit 1
