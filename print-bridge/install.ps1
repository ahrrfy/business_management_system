# تثبيت جسر الطباعة المحلي على جهاز كاشير/حاسبة (يُشغَّل مرّة واحدة، يُفضَّل كمسؤول للسياسات).
#   powershell -ExecutionPolicy Bypass -File install.ps1 -AppOrigin "https://srv1548487.hstgr.cloud" -Token "رمز-سرّي"
#
# يقوم بـ: كتابة bridge.config.json + جدولة تشغيل الجسر عند الدخول (مخفي) + سياسة Chrome/Edge لإخفاء
# نافذة «الوصول للشبكة المحلية» (LNA) لأصل التطبيق. الطباعة RAW لا تحتاج تعريف WinUSB ولا صلاحيات مرتفعة.

param(
  [string]$AppOrigin = "https://srv1548487.hstgr.cloud",
  [string]$Token = "",
  [int]$Port = 17777
)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# ١) ملفّ الإعداد
$cfg = [ordered]@{
  port    = $Port
  token   = $Token
  origins = @($AppOrigin, "http://localhost:3000")
  log     = ""
}
$cfgPath = Join-Path $here "bridge.config.json"
$cfg | ConvertTo-Json -Depth 4 | Out-File -FilePath $cfgPath -Encoding utf8
Write-Host "✓ كُتب الإعداد: $cfgPath"

# ٢) مهمة مجدولة عند الدخول (مخفية)
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Warning "Node غير موجود في PATH — ثبّت Node.js ثم أعد التشغيل."; }
else {
  $bridge = Join-Path $here "bridge.mjs"
  $action = "`"$node`" `"$bridge`""
  schtasks /Create /TN "ERP Print Bridge" /TR $action /SC ONLOGON /RL LIMITED /F | Out-Null
  Write-Host "✓ سُجِّلت مهمة بدء التشغيل: ERP Print Bridge"
  Start-Process -FilePath $node -ArgumentList "`"$bridge`"" -WindowStyle Hidden
  Write-Host "✓ شُغِّل الجسر الآن."
}

# ٣) سياسة Chrome/Edge لإخفاء نافذة LNA لأصل التطبيق (تتطلّب صلاحيات مسؤول)
function Set-LnaPolicy([string]$vendorKey) {
  $base = "HKLM:\SOFTWARE\Policies\$vendorKey"
  foreach ($pol in @("LocalNetworkAccessAllowedForUrls", "InsecurePrivateNetworkRequestsAllowedForUrls")) {
    $key = Join-Path $base $pol
    New-Item -Path $key -Force | Out-Null
    New-ItemProperty -Path $key -Name "1" -Value $AppOrigin -PropertyType String -Force | Out-Null
  }
}
try {
  Set-LnaPolicy "Google\Chrome"
  Set-LnaPolicy "Microsoft\Edge"
  Write-Host "✓ ضُبطت سياسة LNA لـ$AppOrigin (Chrome + Edge)."
} catch {
  Write-Warning "تعذّر ضبط سياسة المتصفّح (شغّل كمسؤول). بدونها قد يظهر إذن «الوصول للشبكة المحلية» مرّة — يقبله المستخدم ويُحفظ."
}

Write-Host ""
Write-Host "توصية: أضِف استثناء Microsoft Defender لمجلد الجسر إن لزم:"
Write-Host "  Add-MpPreference -ExclusionPath `"$here`""
Write-Host "تمّ. الجسر يستمع على http://127.0.0.1:$Port"
