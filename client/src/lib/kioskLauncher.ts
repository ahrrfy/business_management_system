/**
 * kioskLauncher — مُشغّل كشك قارئ الأسعار الخارجي (ملف واحد كوني لكل الأجهزة).
 *
 * **الفكرة الجديدة (٧-٧-٢٠٢٦):** ملف `.cmd` واحد للمالك يُنزَّل من لوحة الإدارة مرّة،
 * ثم يُنسَخ على كل جهاز كشك. عند التشغيل أوّل مرّة يطلب رمز الجهاز (الذي أصدره المدير للجهاز
 * المعنيّ) ⇒ يحفظه في `%LOCALAPPDATA%\AlroyaKiosk\token.txt` ⇒ **يُنسّخ نفسه تلقائياً**
 * إلى مجلّد بدء التشغيل (Startup) للوندوز ⇒ يفتح المتصفّح ملء الشاشة على `/kiosk#t=<TOKEN>`.
 *
 * عند الإقلاعات اللاحقة (النسخة الموجودة في Startup تعمل تلقائياً): ينتظر `BOOT_DELAY_SECS`
 * ثانية (١٢٠ افتراضياً) ثم يفتح الكشك بلا سؤال. لا رمز في الملف نفسه ⇒ الملف كوني وقابل للمشاركة.
 *
 * الرمز في **جزء العنوان (#fragment)** ⇒ لا يصل الخادم ولا سجلّات nginx (نفس مبدأ السلامة السابق).
 */

import { saveFileAs } from "@/lib/export";

/** رابط تشغيل الكشك (الرمز في الـfragment، لا يصل الخادم). */
export function kioskUrl(origin: string, token: string): string {
  const base = origin.replace(/\/+$/, "");
  return `${base}/kiosk#t=${encodeURIComponent(token)}`;
}

export interface InstallerInfo {
  /** أصل الخادم (مثلاً https://srv1548487.hstgr.cloud). */
  origin: string;
  /** ثواني الانتظار قبل فتح المتصفّح بعد إقلاع الوندوز. افتراضي 120. */
  bootDelaySeconds?: number;
}

/**
 * نصّ مُشغّل التثبيت الكوني (.cmd) لوندوز.
 *
 * منطقه:
 *   1. إن لم يوجد ملف الرمز (`token.txt`) ⇒ وضع «تفعيل»: يطلب لصق الرمز، يحفظه،
 *      يُنسّخ نفسه إلى مجلّد بدء التشغيل، ثم يفتح الكشك فوراً (بلا انتظار).
 *   2. إن كان يعمل من مجلّد بدء التشغيل (بعد إقلاع الوندوز) ⇒ ينتظر BOOT_DELAY_SECS ثم يفتح.
 *   3. إن كان يعمل يدوياً بعد التفعيل ⇒ يفتح مباشرةً بلا انتظار.
 *
 * ملاحظات تقنية:
 * - كشف «تشغيل من Startup» عبر مقارنة `%~dp0` بمسار مجلّد Startup للمستخدم.
 * - يفضّل Chrome ثم يقع إلى Edge؛ ملف تعريف متصفّح مخصّص معزول عن جلسات المستخدم.
 * - `--kiosk` يخفي كل شرائط المتصفّح (ملء شاشة كامل).
 * - العلامة `title` تُظهر «قارئ الأسعار» في شريط مهام الوندوز لتمييز النافذة.
 */
export function buildInstallerCmd(info: InstallerInfo): string {
  const base = info.origin.replace(/\/+$/, "");
  const delay = Math.max(0, Math.floor(info.bootDelaySeconds ?? 120));
  const lines = [
    "@echo off",
    "chcp 65001 >nul",
    "title قارئ الأسعار - الرؤية العربية",
    "setlocal EnableDelayedExpansion",
    "",
    "REM ============================================================",
    "REM  قارئ الأسعار — مُشغّل التثبيت والإقلاع (ملف كوني)",
    "REM  الاستعمال: شغّل هذا الملف على جهاز الشاشة ← الصق الرمز عند الطلب.",
    "REM  المُثبّت ينسخ نفسه إلى مجلّد بدء التشغيل تلقائياً — أعد التشغيل للاختبار.",
    "REM ============================================================",
    "",
    `set "SERVER_URL=${base}"`,
    "set \"APP_DIR=%LOCALAPPDATA%\\AlroyaKiosk\"",
    "set \"TOKEN_FILE=%APP_DIR%\\token.txt\"",
    "set \"PROFILE=%APP_DIR%\\chrome-profile\"",
    "set \"STARTUP=%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\"",
    `set "BOOT_DELAY_SECS=${delay}"`,
    "",
    "REM هل نحن نُشغَّل من مجلّد بدء التشغيل؟ (بعد إقلاع الوندوز)",
    "set \"FROM_STARTUP=\"",
    "if /i \"%~dp0\"==\"%STARTUP%\\\" set \"FROM_STARTUP=1\"",
    "",
    "if not exist \"%TOKEN_FILE%\" goto :activate",
    "if defined FROM_STARTUP goto :delay_then_run",
    "goto :run_now",
    "",
    ":activate",
    "if not exist \"%APP_DIR%\" mkdir \"%APP_DIR%\"",
    "cls",
    "echo.",
    "echo   ================================================",
    "echo    قارئ الأسعار - الرؤية العربية",
    "echo    تفعيل الجهاز (خطوة واحدة)",
    "echo   ================================================",
    "echo.",
    "echo   الصق رمز الجهاز الذي أصدره المدير ثم اضغط Enter",
    "echo   (الرمز يبدأ بـ kde_ ويحوي حروفاً وأرقاماً)",
    "echo.",
    "set \"TOKEN=\"",
    "set /p \"TOKEN=  الرمز: \"",
    "",
    "if \"!TOKEN!\"==\"\" (",
    "  echo.",
    "  echo   لم يُدخَل رمز. أُلغي التفعيل.",
    "  echo.",
    "  pause",
    "  exit /b 1",
    ")",
    "",
    "REM حفظ الرمز",
    "> \"%TOKEN_FILE%\" echo !TOKEN!",
    "",
    "REM تثبيت في مجلّد بدء التشغيل (يعمل بعد كل إقلاع للوندوز)",
    "copy /y \"%~f0\" \"%STARTUP%\\qari-alroya.cmd\" >nul",
    "if errorlevel 1 (",
    "  echo.",
    "  echo   تنبيه: تعذّر نسخ الملف إلى مجلّد بدء التشغيل.",
    "  echo   سيعمل قارئ الأسعار الآن، لكن لن يقلع تلقائياً بعد إعادة التشغيل.",
    "  echo   للحلّ اليدوي: افتح Win+R ثم اكتب shell:startup",
    "  echo   وانسخ هذا الملف إلى المجلّد الذي يفتح.",
    "  echo.",
    ") else (",
    "  echo.",
    "  echo   تمّ التفعيل + تثبيت الإقلاع التلقائي بنجاح.",
    ")",
    "echo   جاري فتح قارئ الأسعار...",
    "timeout /t 3 /nobreak >nul",
    "goto :run_now",
    "",
    ":delay_then_run",
    "echo.",
    "echo   قارئ الأسعار سيبدأ خلال %BOOT_DELAY_SECS% ثانية...",
    "echo   (انتظار استقرار الوندوز والاتصال بالخادم)",
    "echo.",
    "timeout /t %BOOT_DELAY_SECS% /nobreak >nul",
    "",
    ":run_now",
    "set \"TOKEN=\"",
    "set /p \"TOKEN=\" < \"%TOKEN_FILE%\"",
    "if \"!TOKEN!\"==\"\" (",
    "  echo   ملف الرمز فارغ أو تالف: %TOKEN_FILE%",
    "  echo   احذفه ثم أعد تشغيل هذا الملف لإعادة التفعيل.",
    "  pause",
    "  exit /b 1",
    ")",
    "",
    "set \"KURL=%SERVER_URL%/kiosk#t=!TOKEN!\"",
    "",
    "set \"CHROME=\"",
    "if exist \"%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe\" set \"CHROME=%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe\"",
    "if exist \"%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe\" set \"CHROME=%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe\"",
    "if defined CHROME (",
    "  start \"\" \"!CHROME!\" --kiosk --app=\"!KURL!\" --user-data-dir=\"%PROFILE%\" --no-first-run --no-default-browser-check --noerrdialogs --disable-pinch --overscroll-history-navigation=0 --disable-features=TranslateUI --check-for-update-interval=604800",
    "  exit /b 0",
    ")",
    "",
    "set \"EDGE=\"",
    "if exist \"%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe\" set \"EDGE=%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe\"",
    "if exist \"%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe\" set \"EDGE=%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe\"",
    "if defined EDGE (",
    "  start \"\" \"!EDGE!\" --kiosk --app=\"!KURL!\" --user-data-dir=\"%PROFILE%\" --no-first-run --noerrdialogs --overscroll-history-navigation=0",
    "  exit /b 0",
    ")",
    "",
    "echo لم يُعثر على متصفّح Chrome أو Edge على هذا الجهاز.",
    "echo ثبّت أحدهما ثم أعد تشغيل هذا الملف.",
    "pause",
    "",
  ];
  return lines.join("\r\n");
}

/** تنزيل المُشغّل الكوني كملف .cmd (UTF-8 مع BOM ليقرأ Windows العربية في التعليقات). */
export function downloadInstallerCmd(info: InstallerInfo): void {
  const content = "﻿" + buildInstallerCmd(info);
  saveFileAs(new Blob([content], { type: "application/octet-stream" }), {
    filename: "qari-alroya-setup.cmd",
    description: "مُشغّل الكشك",
    mime: "application/octet-stream",
  });
}
