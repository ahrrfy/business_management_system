# install-autostart.ps1 — يسجّل تشغيل النظام تلقائياً عند الإقلاع + مهام الصيانة في Windows Task Scheduler.
# يُشغَّل مرّة واحدة بصلاحيات مدير (Run as Administrator):
#   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
#
# يسجّل ثلاث مهام (idempotent — يستبدل الموجود):
#   1) AlRoya ERP - Boot         عند تسجيل الدخول: يشغّل حاوية MySQL ثم يحيي خادم PM2 (pm2 resurrect)
#   2) AlRoya ERP - Docker Watchdog  كل ساعة: يعيد تشغيل حاوية MySQL إن توقّفت (scripts\docker-watchdog.mjs)
#   3) AlRoya ERP - Daily Backup     يومياً 2ص: نسخة احتياطية + تدوير (scripts\backup.mjs)
#
# ⚠ المتطلّبات المسبقة (مرّة واحدة، خارج هذا السكربت):
#   - pnpm build               (لبناء dist/ الذي يشغّله PM2)
#   - pm2 start ecosystem.config.cjs ; pm2 save   (لحفظ قائمة العمليات كي يحييها resurrect)
#   - ضبط Docker Desktop ليبدأ عند الإقلاع (Settings → General → Start Docker Desktop when you sign in)

$ErrorActionPreference = "Stop"

# جذر المشروع = أب مجلّد scripts/
$RepoRoot   = Split-Path -Parent $PSScriptRoot
$Container  = if ($env:DB_CONTAINER) { $env:DB_CONTAINER } else { "erp-mysql-prod" }
$NodeExe    = (Get-Command node).Source
$PnpmCmd    = (Get-Command pnpm -ErrorAction SilentlyContinue)
$Pm2Cmd     = (Get-Command pm2  -ErrorAction SilentlyContinue)

Write-Host "جذر المشروع: $RepoRoot"
Write-Host "حاوية MySQL: $Container"

# يتطلّب صلاحيات مدير لتسجيل مهام النظام.
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not $isAdmin) {
  Write-Error "شغّل هذا السكربت بصلاحيات مدير (Run as Administrator)."
  exit 1
}

function Register-ErpTask {
  param([string]$Name, [string]$Command, $Trigger)
  $action  = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -Command `"$Command`"" -WorkingDirectory $RepoRoot
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 1)
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
  Register-ScheduledTask -TaskName $Name -Action $action -Trigger $Trigger -Settings $settings -Principal $principal -Force | Out-Null
  Write-Host "✓ سُجّلت المهمة: $Name"
}

# 1) الإقلاع: شغّل الحاوية ثم أحيِ PM2.
$bootCmd = "docker start $Container 2>`$null; Start-Sleep -Seconds 8; pm2 resurrect"
Register-ErpTask -Name "AlRoya ERP - Boot" -Command $bootCmd -Trigger (New-ScheduledTaskTrigger -AtLogOn)

# 2) حارس Docker كل ساعة.
$watchCmd = "node `"$RepoRoot\scripts\docker-watchdog.mjs`""
$hourly = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Days 3650)
Register-ErpTask -Name "AlRoya ERP - Docker Watchdog" -Command $watchCmd -Trigger $hourly

# 3) النسخ الاحتياطي اليومي 2ص.
$backupCmd = "node `"$RepoRoot\scripts\backup.mjs`""
Register-ErpTask -Name "AlRoya ERP - Daily Backup" -Command $backupCmd -Trigger (New-ScheduledTaskTrigger -Daily -At 2am)

Write-Host ""
Write-Host "✅ اكتمل التسجيل. للتحقّق:  Get-ScheduledTask -TaskName 'AlRoya ERP*'"
Write-Host "   تذكير: نفّذ مرّة واحدة:  pnpm build ; pm2 start ecosystem.config.cjs ; pm2 save"
