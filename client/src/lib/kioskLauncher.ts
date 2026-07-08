/**
 * kioskLauncher — توليد رابط الكشك + مُشغّل Windows (.cmd) لشاشة قارئ الأسعار الخارجية.
 *
 * الفكرة: المُشغّل يفتح المتصفّح بوضع --kiosk على `/kiosk#t=<token>`.
 * الرمز في **جزء العنوان (#fragment)** عمداً ⇒ لا يُرسَل إلى الخادم ولا يظهر في سجلّات nginx؛
 * صفحة /kiosk تقرؤه بالـJS، تبادله بكوكي جهاز، ثم تمسحه من شريط العنوان (history.replaceState).
 *
 * ملاحظة أمنية: ملف .cmd يحوي سرّاً (رمز الجهاز) ⇒ خزّنه على الجهاز بصلاحيات مقيّدة،
 * وألغِ الجهاز من لوحة الإدارة إن فُقد الجهاز/الملف (الإلغاء فوري على الخادم).
 */

/** رابط تشغيل الكشك (الرمز في الـfragment، لا يصل الخادم). */
export function kioskUrl(origin: string, token: string): string {
  const base = origin.replace(/\/+$/, "");
  return `${base}/kiosk#t=${encodeURIComponent(token)}`;
}

/** اسم ملف آمن من تسمية الجهاز (يزيل محارف أسماء ملفات Windows الممنوعة؛ بلا /u لتوافق tsc). */
function safeFileName(label: string): string {
  const cleaned = (label || "kiosk")
    .replace(/[\\/:*?"<>|]+/g, "")
    .replace(/[\x00-\x1f]+/g, "")
    .trim()
    .replace(/\s+/g, "-");
  return (cleaned || "kiosk").slice(0, 48);
}

export interface LauncherInfo {
  origin: string;
  token: string;
  label: string;
  branchName?: string | null;
  deviceId: number;
  /** ثواني الانتظار قبل فتح المتصفّح (لبدء التشغيل التلقائي مع الوندوز). افتراضي 120 ثانية. */
  bootDelaySeconds?: number;
}

/** نصّ مُشغّل Windows (.cmd): Chrome أولاً ثم Edge، بوضع كشك وملء شاشة وملف تعريف مخصّص. */
export function buildLauncherCmd(info: LauncherInfo): string {
  const url = kioskUrl(info.origin, info.token);
  const profile = `%LOCALAPPDATA%\\AlroyaKiosk\\dev-${info.deviceId}`;
  const delay = Math.max(0, Math.floor(info.bootDelaySeconds ?? 120));
  const lines = [
    "@echo off",
    "chcp 65001 >nul",
    `title قارئ الأسعار - ${info.label}`,
    "REM ============================================================",
    "REM  مُشغّل شاشة قارئ الأسعار — الرؤية العربية",
    `REM  الجهاز: ${info.label}   |   الفرع: ${info.branchName ?? ""}`,
    "REM  للتشغيل التلقائي عند الإقلاع: ضع هذا الملف في مجلّد بدء التشغيل",
    "REM  (Win+R ثم اكتب: shell:startup ثم انسخ الملف هناك).",
    "REM  تنبيه: هذا الملف يحوي رمز الجهاز — احفظه بأمان، وألغِ الجهاز من النظام إن فُقد.",
    "REM ============================================================",
    "",
    "REM --- تأخير الإقلاع: ينتظر استقرار الوندوز والشبكة قبل فتح المتصفّح. ---",
    "REM     غيّر الرقم أدناه لتغيير مدّة الانتظار بالثواني (0 = بلا انتظار).",
    `set "BOOT_DELAY_SECS=${delay}"`,
    `set "KURL=${url}"`,
    `set "PROFILE=${profile}"`,
    "",
    "if %BOOT_DELAY_SECS% GTR 0 (",
    "  echo.",
    "  echo   قارئ الأسعار سيبدأ خلال %BOOT_DELAY_SECS% ثانية...",
    "  echo   (انتظار استقرار الوندوز والاتصال بالخادم)",
    "  echo.",
    "  timeout /t %BOOT_DELAY_SECS% /nobreak >nul",
    ")",
    "",
    "set \"CHROME=\"",
    "if exist \"%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe\" set \"CHROME=%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe\"",
    "if exist \"%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe\" set \"CHROME=%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe\"",
    "if defined CHROME (",
    "  start \"\" \"%CHROME%\" --kiosk --app=\"%KURL%\" --user-data-dir=\"%PROFILE%\" --no-first-run --no-default-browser-check --noerrdialogs --disable-pinch --overscroll-history-navigation=0 --disable-features=TranslateUI --check-for-update-interval=604800",
    "  goto :eof",
    ")",
    "",
    "set \"EDGE=\"",
    "if exist \"%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe\" set \"EDGE=%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe\"",
    "if exist \"%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe\" set \"EDGE=%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe\"",
    "if defined EDGE (",
    "  start \"\" \"%EDGE%\" --kiosk --app=\"%KURL%\" --user-data-dir=\"%PROFILE%\" --no-first-run --noerrdialogs --overscroll-history-navigation=0",
    "  goto :eof",
    ")",
    "",
    "echo لم يُعثر على متصفّح Chrome أو Edge على هذا الجهاز. ثبّت أحدهما ثم أعد المحاولة.",
    "pause",
    "",
  ];
  return lines.join("\r\n");
}

/** تنزيل المُشغّل كملف .cmd (UTF-8 مع BOM ليقرأ Windows العربية في التعليقات). */
export function downloadLauncherCmd(info: LauncherInfo): void {
  const content = "﻿" + buildLauncherCmd(info);
  const blob = new Blob([content], { type: "application/octet-stream" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `qari-${safeFileName(info.label)}.cmd`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
