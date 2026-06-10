# سحب أحدث نسخة احتياطية مشفّرة من خادم الـVPS إلى جهاز المتجر (الطبقة الخارجية للنسخ — G4).
# لا نسخ عارية تغادر الخادم: يُسحب ملف .sql.gpg فقط، وفكّه يحتاج BACKUP_GPG_PASSPHRASE.
#
# التشغيل اليدوي:   pnpm backup:pull-vps
# الجدولة اليومية (مرة واحدة، كمدير):
#   schtasks /Create /TN "AlRoya ERP - Pull VPS Backup" /SC DAILY /ST 07:30 /F ^
#     /TR "powershell -NoProfile -ExecutionPolicy Bypass -File D:\business_management_system\scripts\pull-vps-backup.ps1"
# المتطلّب: مفتاح SSH للخادم + Host alias في ~/.ssh/config (الافتراضي: alroya-erp).
param(
  [string]$SshHost = "alroya-erp",
  [string]$RemoteDir = "/home/deploy/erp/backups",
  [string]$LocalDir = "$env:USERPROFILE\erp-vps-backups",
  [int]$MaxAgeHours = 26,
  [int]$KeepLocal = 14
)
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force $LocalDir | Out-Null

# scp الحديث (SFTP منذ OpenSSH 9) لا ينفّذ $() على الطرف البعيد ⇒ نسأل ssh عن الاسم أولاً ثم ننسخ به صراحةً.
$newest = ssh $SshHost "ls -t $RemoteDir/*.sql.gpg 2>/dev/null | head -1"
if (-not $newest) {
  Write-Error "لا ملفات .sql.gpg على الخادم — افحص BACKUP_GPG_PASSPHRASE وcron النسخ الليلي."
  exit 1
}
$newest = $newest.Trim()
$name = ($newest -split "/")[-1]

scp "${SshHost}:$newest" "$LocalDir\$name"
if (-not (Test-Path "$LocalDir\$name")) { Write-Error "فشل السحب — لم يصل الملف."; exit 1 }

# فحص الطزاجة من اسم الملف (طابع UTC من backup.mjs): نسخة أقدم من $MaxAgeHours = النسخ الليلي معطّل.
$m = [regex]::Match($name, "\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}")
if ($m.Success) {
  $stampUtc = [datetime]::ParseExact($m.Value, "yyyy-MM-dd'T'HH-mm-ss", $null)
  $ageH = ((Get-Date).ToUniversalTime() - $stampUtc).TotalHours
  if ($ageH -gt $MaxAgeHours) {
    Write-Error ("أحدث نسخة على الخادم عمرها {0:N1} ساعة (> {1}) — النسخ الليلي على الخادم معطّل! افحص logs/backup.log هناك." -f $ageH, $MaxAgeHours)
    exit 1
  }
  Write-Host ("✓ سُحبت {0} (عمرها {1:N1} ساعة) إلى {2}" -f $name, $ageH, $LocalDir)
} else {
  Write-Host "✓ سُحبت $name إلى $LocalDir (تعذّر تحليل الطابع الزمني من الاسم)"
}

# تدوير محلي: أبقِ آخر $KeepLocal ملفاً (الأسماء مؤرّخة ⇒ الفرز بالاسم = الفرز الزمني).
Get-ChildItem $LocalDir -Filter *.sql.gpg |
  Sort-Object Name -Descending |
  Select-Object -Skip $KeepLocal |
  Remove-Item -Force
