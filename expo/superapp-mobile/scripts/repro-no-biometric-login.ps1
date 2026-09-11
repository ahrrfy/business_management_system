param(
  [string]$Device = "emulator-5556",
  [switch]$Remember
)

$ErrorActionPreference = "Stop"
$packageName = "online.alarabiya.store"

function Invoke-Adb {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
  $output = & adb -s $Device @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "adb failed: $($Arguments -join ' ')"
  }
  return $output
}

function Get-UiNodes {
  Invoke-Adb shell uiautomator dump /sdcard/superapp-repro.xml *> $null
  [xml]$document = (Invoke-Adb shell cat /sdcard/superapp-repro.xml) -join "`n"
  return $document.SelectNodes("//node")
}

function Get-NodeCenter {
  param([System.Xml.XmlElement]$Node)
  if ($Node.bounds -notmatch '^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$') {
    throw "Invalid UI bounds."
  }
  return @(
    [int](([int]$Matches[1] + [int]$Matches[3]) / 2),
    [int](([int]$Matches[2] + [int]$Matches[4]) / 2)
  )
}

function Invoke-NodeTap {
  param([System.Xml.XmlElement]$Node)
  $center = Get-NodeCenter $Node
  Invoke-Adb shell input tap $center[0] $center[1] *> $null
}

Invoke-Adb shell pm clear $packageName *> $null
Invoke-Adb shell am start -n "$packageName/.MainActivity" *> $null
Start-Sleep -Seconds 2

$nodes = Get-UiNodes
$start = $nodes | Where-Object { $_.'content-desc' -eq "بدء الدخول الآمن" } | Select-Object -First 1
if (-not $start) { throw "Secure login entry was not rendered." }
Invoke-NodeTap $start
Start-Sleep -Seconds 1

$nodes = Get-UiNodes
$fields = @($nodes | Where-Object { $_.class -eq "android.widget.EditText" })
if ($fields.Count -lt 2) { throw "Login fields were not rendered." }

Invoke-NodeTap $fields[0]
Invoke-Adb shell input text "codex_no_biometric" *> $null
Invoke-NodeTap $fields[1]
Invoke-Adb shell input text "InvalidPassword123" *> $null

$nodes = Get-UiNodes
$rememberNode = $nodes | Where-Object { $_.checkable -eq "true" } | Select-Object -First 1
if (-not $rememberNode) { throw "Remember-device control was not rendered." }
if ($Remember -and $rememberNode.checked -ne "true") { Invoke-NodeTap $rememberNode }
if (-not $Remember -and $rememberNode.checked -eq "true") { Invoke-NodeTap $rememberNode }

$continue = $nodes | Where-Object { $_.'content-desc' -eq "متابعة" } | Select-Object -First 1
if (-not $continue) { throw "Continue action was not rendered." }
Invoke-NodeTap $continue
Start-Sleep -Seconds 3

$visibleText = (Get-UiNodes | ForEach-Object { $_.text }) -join "`n"
$symptom = "تعذر إتمام الطلب الآن"
if ($visibleText.Contains($symptom)) {
  Write-Error "RED: login failed locally before the server response: $symptom"
  exit 1
}

Write-Output "GREEN: the local pre-request login failure did not reproduce."
