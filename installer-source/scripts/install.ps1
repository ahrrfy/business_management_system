#requires -Version 5.1
<#
  install.ps1 — Al-Ru'ya ERP unified store installer.
  - Asks for device role (cashier / admin / branch)
  - Detects connected printers, lets user pick receipt + label printer
  - Generates HMAC secret, writes bridge config
  - Installs bridge to %LOCALAPPDATA%\AlruyaERP\bridge\
  - Registers bridge auto-start (Task Scheduler — runs at user logon, user-level)
  - Creates desktop shortcut to PWA in Edge --app mode
  - Optionally registers a daily update check
  - Optionally pins to Start menu and Startup folder
  - Optionally runs a test print to verify the printer
  - Optionally opens the PWA with ?bridge=<secret> to seed localStorage

  Reversible: every change is recorded so uninstall.ps1 can undo it.
  User-level only: no UAC, no system32 writes. WinUSB driver install (rare opt-in) is the
  sole admin-required step — install.ps1 spawns install-driver.ps1 elevated only if chosen.
#>
[CmdletBinding()]
param(
  [string]$CloudUrl = 'https://srv1548487.hstgr.cloud',
  [string]$ResourcesDir = $(Join-Path $PSScriptRoot '..' 'resources'),
  [switch]$NonInteractive,
  [string]$Role = 'cashier',          # used only with -NonInteractive
  [string]$ReceiptSpoolerName = '',   # used only with -NonInteractive
  [string]$LabelSpoolerName = '',
  [switch]$NoAutoStart,
  [switch]$NoUpdateCheck,
  [switch]$NoTestPrint
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# ── Paths ────────────────────────────────────────────────────────────────
$AppDataLocal = Join-Path $env:LOCALAPPDATA 'AlruyaERP'
$AppDataRoam  = Join-Path $env:APPDATA 'AlruyaERP'
$BridgeDir    = Join-Path $AppDataLocal 'bridge'
$ConfigPath   = Join-Path $AppDataLocal 'config.json'
$InstallLog   = Join-Path $AppDataLocal 'install.log'
$Manifest     = Join-Path $AppDataLocal 'install-manifest.json'
$DesktopLnk   = Join-Path ([Environment]::GetFolderPath('Desktop')) 'الرؤية العربية.lnk'
$StartupLnk   = Join-Path ([Environment]::GetFolderPath('Startup')) 'الرؤية العربية.lnk'
$StartMenuLnk = Join-Path ([Environment]::GetFolderPath('Programs')) 'الرؤية العربية.lnk'
$IconSrc      = Join-Path $ResourcesDir 'icons\الرؤية.ico'
$IconTarget   = Join-Path $AppDataLocal 'icon\الرؤية.ico'
$BridgeExeSrc = Join-Path $ResourcesDir 'bridge\alroya-bridge.exe'
$BridgeExeDst = Join-Path $BridgeDir 'alroya-bridge.exe'

# ── Helpers ──────────────────────────────────────────────────────────────
function Write-Step($n, $msg) {
  Write-Host ""
  Write-Host "[$n] $msg" -ForegroundColor Cyan
}

function Write-Info($msg) { Write-Host "  $msg" -ForegroundColor Gray }
function Write-OK($msg)   { Write-Host "  ✓ $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "  ⚠ $msg" -ForegroundColor Yellow }
function Write-Err2($msg) { Write-Host "  ✗ $msg" -ForegroundColor Red }

function Ensure-Dir($path) {
  if (-not (Test-Path $path)) { New-Item -ItemType Directory -Force -Path $path | Out-Null }
}

function Log($msg) {
  Ensure-Dir $AppDataLocal
  $line = "[{0}] {1}" -f ((Get-Date).ToString('o')), $msg
  Add-Content -Path $InstallLog -Value $line -Encoding UTF8
}

function New-RandomSecret([int]$bytes = 32) {
  $b = New-Object byte[] $bytes
  ([System.Security.Cryptography.RandomNumberGenerator]::Create()).GetBytes($b)
  return [Convert]::ToBase64String($b)
}

function Find-Edge {
  $candidates = @(
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
  )
  foreach ($p in $candidates) { if (Test-Path $p) { return $p } }
  return $null
}

function Find-Chrome {
  $candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  )
  foreach ($p in $candidates) { if (Test-Path $p) { return $p } }
  return $null
}

function Create-Shortcut($lnkPath, $targetPath, $arguments, $iconPath, $description) {
  $sh = New-Object -ComObject WScript.Shell
  $sc = $sh.CreateShortcut($lnkPath)
  $sc.TargetPath = $targetPath
  $sc.Arguments = $arguments
  $sc.IconLocation = "$iconPath,0"
  $sc.WorkingDirectory = $env:USERPROFILE
  $sc.Description = $description
  $sc.WindowStyle = 1
  $sc.Save()
}

function Confirm-YesNo($prompt, $default = 'y') {
  if ($NonInteractive) { return ($default -eq 'y') }
  $opts = if ($default -eq 'y') { '[نعم/لا]' } else { '[لا/نعم]' }
  while ($true) {
    $a = (Read-Host "$prompt $opts").Trim()
    if (-not $a) { $a = $default }
    $low = $a.ToLower()
    if ($low -in @('y','yes','نعم','ن')) { return $true }
    if ($low -in @('n','no','لا','ل')) { return $false }
    Write-Host "أدخل: نعم أو لا" -ForegroundColor Yellow
  }
}

function Read-Choice($prompt, $max) {
  if ($NonInteractive) { return 0 }
  while ($true) {
    $a = (Read-Host $prompt).Trim()
    if ($a -match '^\d+$') {
      $n = [int]$a
      if ($n -ge 1 -and $n -le $max) { return $n - 1 }
    }
    Write-Host "أدخل رقماً من 1 إلى $max" -ForegroundColor Yellow
  }
}

function Detect-Printers {
  $script = Join-Path $PSScriptRoot 'detect-printers.ps1'
  if (-not (Test-Path $script)) {
    Log "detect-printers.ps1 not found at $script"
    return @{ spoolers=@(); usbCandidates=@(); networks=@() }
  }
  try {
    $json = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script
    return ($json | ConvertFrom-Json)
  } catch {
    Log "detect-printers failed: $($_.Exception.Message)"
    return @{ spoolers=@(); usbCandidates=@(); networks=@() }
  }
}

function Choose-Printer($detect, $kindLabel) {
  Write-Host ""
  Write-Host "اختر طابعة لـ$kindLabel:" -ForegroundColor White
  $options = @()
  $i = 1
  foreach ($p in $detect.spoolers) {
    Write-Host ("  [{0}] {1}" -f $i, $p.name) -ForegroundColor White
    Write-Host ("       ({0}، تعريف Windows)" -f $p.type) -ForegroundColor DarkGray
    $options += @{ kind='spooler'; spoolerName=$p.name }
    $i++
  }
  foreach ($p in $detect.networks) {
    Write-Host ("  [{0}] طابعة شبكة {1}:{2}" -f $i, $p.host, $p.port) -ForegroundColor White
    $options += @{ kind='network'; host=$p.host; port=$p.port }
    $i++
  }
  Write-Host ("  [{0}] تخطّي — لا طابعة الآن" -f $i) -ForegroundColor DarkGray
  $options += @{ kind='none' }
  $choice = Read-Choice "اختيارك [1-$i]" $i
  return $options[$choice]
}

function Save-Json($path, $obj) {
  Ensure-Dir (Split-Path $path)
  $json = $obj | ConvertTo-Json -Depth 8
  $json | Out-File -FilePath $path -Encoding UTF8 -Force
}

# ── Splash ───────────────────────────────────────────────────────────────
Clear-Host
Write-Host ""
Write-Host "  ╔═══════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "  ║                                                           ║" -ForegroundColor Cyan
Write-Host "  ║         مُثبِّت نظام الرؤية العربية للمتجر                    ║" -ForegroundColor Cyan
Write-Host "  ║         Al-Ru'ya ERP — Store Installer                    ║" -ForegroundColor Cyan
Write-Host "  ║                                                           ║" -ForegroundColor Cyan
Write-Host "  ╚═══════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

Log "install.ps1 started"
Ensure-Dir $AppDataLocal
Ensure-Dir $AppDataRoam

# ── Step 1: role ─────────────────────────────────────────────────────────
Write-Step 1 "نوع هذا الجهاز"
$selectedRole = $Role
if (-not $NonInteractive) {
  Write-Host "  [1] كاشير / فرع كامل (به طابعة وماسح باركود)"
  Write-Host "  [2] إدارة (للمراجعة والتقارير — بلا طابعة)"
  $r = Read-Choice "اختيارك" 2
  $selectedRole = if ($r -eq 0) { 'cashier' } else { 'admin' }
}
Write-OK "الدور: $selectedRole"

# ── Step 2: copy icon + ensure Edge ──────────────────────────────────────
Write-Step 2 "تجهيز المتصفّح والأيقونة"
Ensure-Dir (Split-Path $IconTarget)
if (Test-Path $IconSrc) {
  Copy-Item $IconSrc $IconTarget -Force
  Write-OK "أيقونة الشركة جاهزة"
} else {
  Write-Warn2 "ملف الأيقونة غير موجود في $IconSrc — سيُستعمل أيقونة المتصفح الافتراضية"
}

$browser = Find-Edge
$browserName = "Microsoft Edge"
if (-not $browser) {
  $browser = Find-Chrome
  $browserName = "Google Chrome"
}
if (-not $browser) {
  Write-Err2 "لم يُعثر على Edge ولا Chrome. ثبّت أحدهما ثم أعد تشغيل المُثبِّت."
  exit 1
}
Write-OK "المتصفّح: $browserName ($browser)"

# ── Step 3: bridge install (cashier only) ───────────────────────────────
$secret = $null
$bridgeInstalled = $false
$receiptCfg = $null
$labelCfg = $null
$cashDrawerCfg = $null

if ($selectedRole -eq 'cashier') {
  Write-Step 3 "نسخ جسر الطباعة المحلي"
  if (-not (Test-Path $BridgeExeSrc)) {
    Write-Err2 "alroya-bridge.exe غير موجود في $BridgeExeSrc"
    Write-Info "ابنِ الجسر أولاً: pnpm --filter alroya-bridge install && node installer-source/bridge/build-sea.mjs"
    exit 1
  }
  Ensure-Dir $BridgeDir
  Copy-Item $BridgeExeSrc $BridgeExeDst -Force
  Write-OK "alroya-bridge.exe → $BridgeExeDst"
  $bridgeInstalled = $true

  Write-Step 4 "كشف الطابعات المتصلة"
  $detect = Detect-Printers
  Write-Info "طابعات بتعريف Windows: $($detect.spoolers.Count) — مرشّحات USB: $($detect.usbCandidates.Count)"

  $receipt = Choose-Printer $detect "إيصالات الكاشير (الحرارية)"
  if ($receipt.kind -ne 'none') {
    if ($receipt.kind -eq 'spooler') {
      $receiptCfg = @{ mode='spooler'; spoolerName=$receipt.spoolerName }
    } elseif ($receipt.kind -eq 'network') {
      $receiptCfg = @{ mode='network'; host=$receipt.host; port=$receipt.port }
    }
    Write-OK "طابعة الإيصالات: $($receipt | ConvertTo-Json -Compress)"
  } else {
    Write-Warn2 "لم تختر طابعة إيصالات — يمكنك إضافتها لاحقاً بتعديل config.json"
  }

  if (Confirm-YesNo "هل لديك طابعة ملصقات منفصلة؟" 'n') {
    $label = Choose-Printer $detect "طابعة الملصقات"
    if ($label.kind -ne 'none') {
      if ($label.kind -eq 'spooler') {
        $labelCfg = @{ mode='spooler'; spoolerName=$label.spoolerName }
      } elseif ($label.kind -eq 'network') {
        $labelCfg = @{ mode='network'; host=$label.host; port=$label.port }
      }
      Write-OK "طابعة الملصقات: $($label | ConvertTo-Json -Compress)"
    }
  }

  Write-Step 5 "درج النقدية"
  if ($receiptCfg -and (Confirm-YesNo "هل يفتح درج النقد عبر إشارة من الطابعة الحرارية؟" 'y')) {
    $cashDrawerCfg = @{ method='kickout-on-print'; pulseHex='1B70001930' }
    Write-OK "سيُفتح الدرج تلقائياً عند طباعة الإيصال"
  } else {
    $cashDrawerCfg = @{ method='manual' }
  }

  # Generate secret and write config
  $secret = New-RandomSecret 32
  $cfg = @{
    cloudUrl    = $CloudUrl
    hmacSecret  = $secret
    port        = 9101
    deviceRole  = 'cashier'
    version     = '1.0.0'
  }
  if ($receiptCfg) { $cfg.receiptPrinter = $receiptCfg }
  if ($labelCfg)   { $cfg.labelPrinter = $labelCfg }
  if ($cashDrawerCfg) { $cfg.cashDrawer = $cashDrawerCfg }
  Save-Json $ConfigPath $cfg
  Write-OK "ملف الإعدادات: $ConfigPath"

  # Register bridge as a logon task with restart-on-failure policy.
  # ⚠️ لا نستعمل schtasks.exe لأن /sc onlogon لا يدعم إعادة التشغيل التلقائية عند الـcrash
  # (PR #8 review). Register-ScheduledTask من PSScheduledJob يدعم RestartCount/Interval
  # ⇒ لو الجسر مات بسبب uncaughtException/EADDRINUSE ⇒ Task Scheduler يعيد تشغيله
  # خلال دقيقة (حتى ٥ محاولات) بلا حاجة لإعادة تسجيل دخول المستخدم.
  if (-not $NoAutoStart) {
    Write-Step 6 "تسجيل تشغيل الجسر تلقائياً عند الدخول (مع إعادة تشغيل عند الفشل)"
    $taskName = 'AlroyaBridge'
    try {
      Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
      $action = New-ScheduledTaskAction -Execute $BridgeExeDst
      $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
      $settings = New-ScheduledTaskSettingsSet `
        -StartWhenAvailable `
        -RestartCount 5 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit (New-TimeSpan -Days 0) `
        -DontStopOnIdleEnd `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries
      $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
      Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
      Write-OK "مهمّة AlroyaBridge مُسجَّلة (إعادة تشغيل ٥× بفاصل دقيقة عند الفشل)"
      # Kick it off now so the user can test print immediately.
      Start-Process -FilePath $BridgeExeDst -WindowStyle Hidden
      Start-Sleep -Seconds 1
    } catch {
      Write-Warn2 "تعذّر تسجيل المهمة: $($_.Exception.Message) — سيعمل الجسر فقط حين تشغّله يدوياً"
    }
  }
}

# ── Desktop shortcut (all roles) ─────────────────────────────────────────
Write-Step 7 "إنشاء اختصار سطح المكتب"
$args = "--app=$CloudUrl/ --new-window"
$iconForLnk = if (Test-Path $IconTarget) { $IconTarget } else { $browser }
Create-Shortcut $DesktopLnk $browser $args $iconForLnk "نظام إدارة أعمال الرؤية العربية"
Write-OK "اختصار «الرؤية العربية» على سطح المكتب"

if (-not $NonInteractive) {
  if (Confirm-YesNo "إضافة إلى قائمة Start؟" 'y') {
    Create-Shortcut $StartMenuLnk $browser $args $iconForLnk "نظام إدارة أعمال الرؤية العربية"
    Write-OK "في قائمة Start أيضاً"
  }
  if ($selectedRole -eq 'cashier' -and (Confirm-YesNo "فتح النظام تلقائياً عند تشغيل Windows؟" 'y')) {
    Create-Shortcut $StartupLnk $browser $args $iconForLnk "نظام الرؤية — تشغيل تلقائي"
    Write-OK "تشغيل تلقائي عند الإقلاع"
  }
}

# ── Update check (all roles) ─────────────────────────────────────────────
if (-not $NoUpdateCheck) {
  Write-Step 8 "جدولة التحقّق من التحديثات"
  $updScript = Join-Path $PSScriptRoot 'check-update.ps1'
  if (Test-Path $updScript) {
    # Persist a copy next to the bridge so uninstall keeps it clean.
    $persistedUpd = Join-Path $AppDataLocal 'check-update.ps1'
    Copy-Item $updScript $persistedUpd -Force
    schtasks.exe /delete /tn 'AlroyaUpdate' /f 2>$null | Out-Null
    $cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$persistedUpd`" -CloudUrl `"$CloudUrl`""
    # `/tr` يجب أن يُمرَّر كحجة واحدة مغلَّفة بـquotes؛ بدونها schtasks يقسم الأمر على المسافات
    # ويفشل تسجيل المهمة (لا سيما إن $CloudUrl يحوي مسافة أو رمزاً خاصاً).
    $rc = schtasks.exe /create /tn 'AlroyaUpdate' /tr "$cmd" /sc daily /st 03:00 /f 2>&1
    if ($LASTEXITCODE -eq 0) {
      Write-OK "تحقّق يومي الساعة 03:00"
    } else {
      Write-Warn2 "تعذّر جدولة التحديث: $rc"
    }
  } else {
    Write-Warn2 "check-update.ps1 غير موجود — التحديث الذاتي معطّل"
  }
}

# ── Test print (cashier with configured printer) ────────────────────────
if ($selectedRole -eq 'cashier' -and $receiptCfg -and -not $NoTestPrint) {
  Write-Step 9 "اختبار الطباعة"
  Start-Sleep -Seconds 2  # give bridge a moment to come up
  $testScript = Join-Path $PSScriptRoot 'test-print.ps1'
  if (Test-Path $testScript) {
    try {
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $testScript -Secret $secret -Port 9101
      if ($LASTEXITCODE -eq 0) {
        Write-OK "تم إرسال إيصال اختبار — تحقّق من الطابعة"
      } else {
        Write-Warn2 "اختبار الطباعة فشل — راجع $InstallLog"
      }
    } catch {
      Write-Warn2 "اختبار الطباعة رمى خطأ: $($_.Exception.Message)"
    }
  }
}

# ── Open PWA with bridge token (cashier only) ───────────────────────────
Write-Step 10 "ربط المتصفّح بالنظام"
$setupUrl = if ($selectedRole -eq 'cashier' -and $secret) {
  # base64 السرّ يحوي '+'، '/'، '=' — System.Web.HttpUtility.UrlEncode يرمّز '+' كـ'+'
  # (application/x-www-form-urlencoded) لا %2B، فتفشل مصادقة الجسر. [Uri]::EscapeDataString
  # يطبّق ترميز RFC 3986 الصحيح للـquery parameters.
  $encoded = [Uri]::EscapeDataString($secret)
  "$CloudUrl/?bridge=$encoded"
} else {
  "$CloudUrl/"
}

# Write the install manifest for uninstall
$manifest = @{
  installedAt = (Get-Date).ToString('o')
  role        = $selectedRole
  cloudUrl    = $CloudUrl
  paths       = @{
    bridgeDir    = $BridgeDir
    bridgeExe    = $BridgeExeDst
    configPath   = $ConfigPath
    desktopLnk   = $DesktopLnk
    startMenuLnk = $StartMenuLnk
    startupLnk   = $StartupLnk
    iconTarget   = $IconTarget
    appDataLocal = $AppDataLocal
    appDataRoam  = $AppDataRoam
  }
  tasks       = @('AlroyaBridge','AlroyaUpdate')
}
Save-Json $Manifest $manifest

Write-Host ""
Write-Host "  ╔═══════════════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "  ║   ✓ تم التثبيت بنجاح                                       ║" -ForegroundColor Green
Write-Host "  ╚═══════════════════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Info "أيقونة «الرؤية العربية» على سطح المكتب — اضغطها لتفتح النظام."
if ($bridgeInstalled) {
  Write-Info "جسر الطباعة يعمل في الخلفية على المنفذ 9101."
  Write-Info "سرّ الجسر محفوظ في: $ConfigPath"
}
Write-Host ""

Log "install complete: role=$selectedRole"

# Open the PWA so the user sees it right away (and seeds bridge secret if cashier).
# ArgumentList كـarray لكل حجة منفصلة ⇒ ‎+/=‎ في base64 السرّ لا تُفسَّر كفاصل حجج.
try {
  Start-Process -FilePath $browser -ArgumentList @("--app=$setupUrl", "--new-window")
  Write-OK "تم فتح النظام في $browserName"
} catch {
  Write-Warn2 "تعذّر فتح المتصفّح — افتحه يدوياً من اختصار سطح المكتب"
}

exit 0
