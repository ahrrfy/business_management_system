#requires -Version 5.1
<#
  detect-printers.ps1 — Scan the local machine for printers usable by the bridge.
  Outputs JSON to stdout describing:
    - spooler printers (Get-Printer)
    - candidate USB devices that look like printers (Get-PnpDevice, filtered by known printer VIDs)
    - reachable network printers on the local /24 subnet at port 9100 (optional, slow, off by default)

  Used by install.ps1 to build an interactive selection list.
  Pure read-only: no admin required, no side effects.
#>
[CmdletBinding()]
param(
  [switch]$IncludeNetworkScan,
  [int]$NetworkScanTimeoutMs = 800
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Known USB Vendor IDs for receipt/label printers (hex, lowercase, 4 chars)
$PRINTER_VIDS = @{
  '04b8' = 'Epson'
  '0519' = 'Star Micronics'
  '1504' = 'BIXOLON'
  '1d90' = 'Citizen'
  '04f9' = 'Brother'
  '28e9' = 'HPRT'
  '0fe6' = 'ICS Advent / generic POS'
  '0922' = 'Dymo'
  '0a5f' = 'Zebra'
  '154f' = 'SNBC'
  '20d1' = 'Rongta'
  '0483' = 'STMicro (Xprinter clones)'
  '067b' = 'Prolific (serial-to-USB)'
}

function Get-SpoolerPrinters {
  try {
    $printers = Get-Printer -ErrorAction Stop | Where-Object { $_.Name -notmatch '^Microsoft (Print to PDF|XPS Document Writer)$' -and $_.Name -ne 'Fax' -and $_.Name -ne 'OneNote.*' }
    return @($printers | ForEach-Object {
      [PSCustomObject]@{
        kind       = 'spooler'
        name       = $_.Name
        portName   = $_.PortName
        driverName = $_.DriverName
        shared     = [bool]$_.Shared
        offline    = ($_.PrinterStatus -eq 'Offline')
        type       = if ($_.PortName -like 'TCP*' -or $_.PortName -like 'WSD*') { 'network-driver' } elseif ($_.PortName -like 'USB*') { 'usb-driver' } else { 'local-driver' }
      }
    })
  } catch {
    return @()
  }
}

function Get-CandidateUsbDevices {
  try {
    $devs = Get-PnpDevice -PresentOnly -ErrorAction Stop | Where-Object { $_.InstanceId -like 'USB\VID_*' }
  } catch {
    return @()
  }
  $out = @()
  foreach ($d in $devs) {
    $m = [regex]::Match($d.InstanceId, 'VID_([0-9A-Fa-f]{4})&PID_([0-9A-Fa-f]{4})')
    if (-not $m.Success) { continue }
    $vid = $m.Groups[1].Value.ToLower()
    $pid = $m.Groups[2].Value.ToLower()
    if (-not $PRINTER_VIDS.ContainsKey($vid)) { continue }
    $out += [PSCustomObject]@{
      kind         = 'usb-candidate'
      friendlyName = $d.FriendlyName
      vid          = "0x$($vid)"
      pid          = "0x$($pid)"
      vendor       = $PRINTER_VIDS[$vid]
      hasDriver    = ($d.Status -eq 'OK')
      instanceId   = $d.InstanceId
    }
  }
  return $out
}

function Get-LocalSubnetGateways {
  try {
    Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
      Where-Object { $_.IPAddress -notlike '169.*' -and $_.IPAddress -ne '127.0.0.1' -and $_.PrefixLength -ge 16 } |
      ForEach-Object {
        $parts = $_.IPAddress -split '\.'
        if ($parts.Count -eq 4) { "$($parts[0]).$($parts[1]).$($parts[2])" }
      } | Select-Object -Unique
  } catch {
    return @()
  }
}

function Get-NetworkPrinters([int]$TimeoutMs) {
  $found = @()
  $prefixes = Get-LocalSubnetGateways
  if (-not $prefixes) { return $found }
  # Scan only common printer host suffixes (.10, .50, .100, .200, .250) to keep it fast.
  $suffixes = @(10, 50, 100, 150, 200, 250)
  foreach ($prefix in $prefixes) {
    foreach ($s in $suffixes) {
      $ip = "$prefix.$s"
      try {
        $client = New-Object System.Net.Sockets.TcpClient
        $ar = $client.BeginConnect($ip, 9100, $null, $null)
        $ok = $ar.AsyncWaitHandle.WaitOne($TimeoutMs, $false)
        if ($ok -and $client.Connected) {
          $found += [PSCustomObject]@{
            kind = 'network'
            host = $ip
            port = 9100
          }
          $client.EndConnect($ar) | Out-Null
        }
        $client.Close()
      } catch { }
    }
  }
  return $found
}

$result = [PSCustomObject]@{
  schema       = 'alroya-detect-printers/1'
  scannedAt    = (Get-Date).ToString('o')
  spoolers     = @(Get-SpoolerPrinters)
  usbCandidates = @(Get-CandidateUsbDevices)
  networks     = @(if ($IncludeNetworkScan) { Get-NetworkPrinters -TimeoutMs $NetworkScanTimeoutMs } else { @() })
}

$result | ConvertTo-Json -Depth 6 -Compress
