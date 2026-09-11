// جسر الطباعة على الخادم: يستقبل بايتات ESC/POS **جاهزة** (يولّدها العميل، فالعربية تُرسَّم
// نقطياً على Canvas في المتصفّح) ويرسلها للطابعة محلياً — طباعة صامتة بلا حوار متصفّح ولا قيد WebUSB.
//
// مصدر الحقيقة لوجهة الطباعة = متغيّر البيئة PRINT_TARGET. الصيغ المدعومة:
//   tcp://<host>[:<port>]   طابعة شبكية RAW (JetDirect/منفذ 9100) — الأوثق، بلا تعريفات. (موصى به)
//   share://<ShareName>     طابعة Windows مشتركة بنوع RAW عبر spooler (للطابعة USB المشتركة باسم)
//   <host>:<port>           اختصار يعادل tcp://host:port
// إن لم يُضبط PRINT_TARGET ⇒ الجسر «غير مفعّل» (enabled:false) فيتراجع العميل تلقائياً لـWebUSB ثم المتصفّح.
//
// دوال نقية قابلة للاختبار (parsePrintTarget) + إرسال شبكي/مشاركة. لا تعتمد على الحالة.
import net from "node:net";
import { writeFile, unlink } from "node:fs/promises";
import { execFile, execSync } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { logger } from "../logger";

const execFileP = promisify(execFile);

export const DEFAULT_RAW_PORT = 9100;

export interface PrintTarget {
  kind: "tcp" | "share" | "windows";
  /** للعرض/التشخيص فقط — لا يُسرّب أسراراً (لا توجد أسرار في وجهة الطباعة). */
  raw: string;
  host?: string;
  port?: number;
  name?: string;
  driverName?: string;
}

/**
 * تحليل وجهة الطباعة من نصّ PRINT_TARGET. دالة نقية (لا آثار جانبية) ⇒ قابلة للاختبار.
 * يعيد null إن كان الإدخال فارغاً أو غير صالح أو auto.
 */
export function parsePrintTarget(raw?: string | null): PrintTarget | null {
  const v = (raw ?? "").trim();
  if (!v || v.toLowerCase() === "auto") return null;

  const tcp = v.match(/^tcp:\/\/([^/:\s]+)(?::(\d+))?\/?$/i);
  if (tcp) {
    const port = tcp[2] ? Number(tcp[2]) : DEFAULT_RAW_PORT;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { kind: "tcp", host: tcp[1], port, raw: v };
  }

  const share = v.match(/^share:\/\/(.+)$/i);
  if (share) {
    const name = share[1].trim();
    return name ? { kind: "share", name, raw: v } : null;
  }

  const win = v.match(/^(?:windows|printer|win):\/\/(.+)$/i);
  if (win) {
    const name = win[1].trim();
    return name ? { kind: "windows", name, raw: v } : null;
  }

  // اختصار host:port (يُفسَّر كـTCP RAW).
  const hp = v.match(/^([^/:\s]+):(\d+)$/);
  if (hp) {
    const port = Number(hp[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { kind: "tcp", host: hp[1], port, raw: v };
  }

  return null;
}

let cachedDetectedTarget: { target: PrintTarget | null; expiresAt: number } = { target: null, expiresAt: 0 };

/** مسح الكاش لاختبارات الوحدة */
export function _resetDetectedPrinterCacheForTesting(): void {
  cachedDetectedTarget = { target: null, expiresAt: 0 };
}

/**
 * فحص هل مواصفات الطابعة تطابق طابعة إيصالات حرارية (Receipt / POS / Thermal)
 * تستبعد الطابعات المكتبية (PDF / OneNote / Inkjet / Laser) وتتعرف على الموديلات الحرارية الشائعة.
 */
export function isThermalCandidate(p: { name?: string; driverName?: string; portName?: string }): boolean {
  const name = p.name ?? "";
  const driver = p.driverName ?? "";
  const port = p.portName ?? "";
  const text = `${name} ${driver} ${port}`.toLowerCase();

  // استبعاد الطابعات المكتبية الافتراضية أو طابعات الحبر/الليزر أو ملفات PDF
  if (/(pdf|onenote|xps|fax|anydesk|c5390|c579r|l8050|ecotank|laserjet|deskjet|officejet|workforce)/i.test(text)) {
    return false;
  }

  // الكلمات الدلالية وموديلات الطابعات الحرارية وإيصالات نقاط البيع
  if (/(receipt|pos|pos-80|pos80|pos-58|pos58|thermal|tm-|t20|t88|t82|m30|hprt|lpq|xprinter|xp-|bixolon|srp-|rongta|rp-|star|tsp|citizen|ct-s|sewoo|gprinter|zj-|58mm|80mm|roll|tmt|esc\/pos|tmu)/i.test(text)) {
    return true;
  }

  // المنافذ المخصصة لطابعات الإيصالات الحرارية (مثل TMUSB لطابعات إبسون)
  if (/^(tmusb|esdprt)/i.test(port)) {
    return true;
  }

  return false;
}

/**
 * اكتشاف أي طابعة حرارية متصلة بالخادم محلياً على نظام Windows.
 * يفحص الطابعات المثبتة في النظام أولاً (سواء كانت مشتركة أم غير مشتركة عبر USB/COM/LPT)،
 * ويتراجع إلى مشاركات الطباعة عبر net view \\localhost عند الحاجة.
 */
export function detectConnectedThermalPrinter(): PrintTarget | null {
  if (process.platform !== "win32") return null;
  const now = Date.now();
  if (cachedDetectedTarget.expiresAt > now) {
    return cachedDetectedTarget.target;
  }

  // ١. فحص الطابعات المثبتة عبر CIM/PowerShell
  try {
    const json = execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Printer | Select-Object Name,DriverName,PortName,Shared,ShareName,PrinterStatus,WorkOffline | ConvertTo-Json -Compress"',
      { encoding: "utf8", windowsHide: true, timeout: 5000 }
    );
    const parsed = JSON.parse(json);
    const list: Array<{
      Name: string;
      DriverName?: string;
      PortName?: string;
      Shared?: boolean;
      ShareName?: string | null;
      PrinterStatus?: number;
      WorkOffline?: boolean;
    }> = Array.isArray(parsed) ? parsed : [parsed];

    // استبعاد الطابعات غير المتصلة أو المعطلة (WorkOffline = true أو حالة خطأ 6/7/8/9) وترشيح الطابعات الحرارية
    const candidates = list.filter(
      (p) =>
        !p.WorkOffline &&
        p.PrinterStatus !== 9 &&
        p.PrinterStatus !== 8 &&
        p.PrinterStatus !== 7 &&
        p.PrinterStatus !== 6 &&
        isThermalCandidate({ name: p.Name, driverName: p.DriverName, portName: p.PortName })
    );

    if (candidates.length > 0) {
      // تفضيل الطابعة الجاهزة (PrinterStatus = 3)، ثم المشتركة أو ذات منفذ USB/TMUSB
      candidates.sort((a, b) => {
        const aReady = a.PrinterStatus === 3 ? 0 : 1;
        const bReady = b.PrinterStatus === 3 ? 0 : 1;
        return aReady - bReady;
      });

      const best =
        candidates.find((p) => p.Shared && p.ShareName) ??
        candidates.find((p) => /^(tmusb|usb)/i.test(p.PortName ?? "")) ??
        candidates[0];

      let target: PrintTarget;
      if (best.Shared && best.ShareName) {
        target = { kind: "share", name: best.ShareName, driverName: best.DriverName, raw: `share://${best.ShareName}` };
      } else {
        target = { kind: "windows", name: best.Name, driverName: best.DriverName, raw: `windows://${best.Name}` };
      }
      cachedDetectedTarget = { target, expiresAt: now + 60_000 };
      return target;
    }
  } catch {
    // تراجع لفحص المشاركات
  }

  // ٢. تراجع احتياطي: فحص مشاركات الطباعة عبر net view \\localhost
  try {
    const out = execSync("net view \\\\localhost", { encoding: "utf8", windowsHide: true, timeout: 3000 });
    const lines = out.split(/\r?\n/);
    const shares: string[] = [];
    for (const line of lines) {
      const match = line.match(/^(.+?)\s+Print\s+/i);
      if (match) shares.push(match[1].trim());
    }
    const thermalShare = shares.find((s) => isThermalCandidate({ name: s })) ?? shares[0];
    if (thermalShare) {
      const target: PrintTarget = { kind: "share", name: thermalShare, raw: `share://${thermalShare}` };
      cachedDetectedTarget = { target, expiresAt: now + 60_000 };
      return target;
    }
  } catch {
    // ignore
  }

  cachedDetectedTarget = { target: null, expiresAt: now + 30_000 };
  return null;
}

/** توافقية مع الاستدعاءات السابقة */
export const detectWindowsSharedPrinter = detectConnectedThermalPrinter;

/** الوجهة المضبوطة حالياً من البيئة، أو null إن لم يُفعّل الجسر. */
export function getConfiguredTarget(): PrintTarget | null {
  const envVal = (process.env.PRINT_TARGET ?? "").trim();
  if (envVal && envVal.toLowerCase() !== "auto") {
    return parsePrintTarget(envVal);
  }
  // في بيئة Windows: إن لم يُحدد PRINT_TARGET صراحةً أو كُتب auto، نكتشف أي طابعة حرارية متصلة بالخادم تلقائياً
  if (process.platform === "win32") {
    const detected = detectConnectedThermalPrinter();
    if (detected) return detected;
  }
  return null;
}

export function isBridgeEnabled(): boolean {
  return getConfiguredTarget() != null;
}

/** وصف مختصر للعرض في الواجهة (بلا كشف تفاصيل حسّاسة). */
export function describeTarget(t: PrintTarget | null): string {
  if (!t) return "غير مفعّل";
  if (t.kind === "tcp") return `طابعة شبكية ${t.host}:${t.port}`;
  if (t.kind === "share") return `طابعة مشتركة «${t.name}»`;
  return `طابعة حرارية «${t.name}»`;
}

// ───────────────────────── ناقلات الإرسال ─────────────────────────

/** إرسال بايتات خام لطابعة شبكية عبر TCP RAW (9100). يحلّ عند تأكيد الكتابة وإغلاق الاتصال برفق. */
export function sendTcp(
  host: string,
  port: number,
  bytes: Buffer,
  timeoutMs = 8000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* تجاهل */ }
      if (err) reject(err);
      else resolve();
    };
    socket.setTimeout(timeoutMs);
    socket.once("error", (e) => finish(e instanceof Error ? e : new Error(String(e))));
    socket.once("timeout", () => finish(new Error(`انتهت مهلة الاتصال بالطابعة ${host}:${port}`)));
    socket.connect(port, host, () => {
      socket.write(bytes, (err) => {
        if (err) return finish(err);
        // أمهِل الطابعة لاستهلاك البيانات ثم أغلق برفق (end يُفرغ المخزن قبل FIN).
        socket.end(() => finish());
      });
    });
  });
}

let tmpCounter = 0;

/**
 * إرسال بايتات خام لأي طابعة Windows مثبتة محلياً عبر Windows Spooler API (winspool.drv بنوع RAW).
 * يعمل مع الطابعات المتصلة عبر USB/COM/LPT والشبكة دون اشتراط مشاركتها عبر الشبكة.
 */
export async function sendWindowsSpooler(printerName: string, bytes: Buffer): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("الطباعة عبر Windows Spooler متاحة على نظام Windows فقط.");
  }
  if (!/^[A-Za-z0-9 _.$,()#-]+$/.test(printerName)) {
    throw new Error(`اسم طابعة غير صالح: «${printerName}».`);
  }
  const tmp = path.join(tmpdir(), `escpos-spool-${process.pid}-${Date.now()}-${tmpCounter++}.bin`);
  await writeFile(tmp, bytes);
  try {
    const script = `
Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Runtime.InteropServices;
public class WinSpoolRaw {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
  public class DOCINFOA {
    [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
  }
  [DllImport("winspool.Drv", EntryPoint = "OpenPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true)]
  public static extern bool OpenPrinter([MarshalAs(UnmanagedType.LPStr)] string szPrinter, out IntPtr hPrinter, IntPtr pd);
  [DllImport("winspool.Drv", EntryPoint = "ClosePrinter", SetLastError = true, ExactSpelling = true)]
  public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint = "StartDocPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true)]
  public static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);
  [DllImport("winspool.Drv", EntryPoint = "EndDocPrinter", SetLastError = true, ExactSpelling = true)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint = "StartPagePrinter", SetLastError = true, ExactSpelling = true)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint = "EndPagePrinter", SetLastError = true, ExactSpelling = true)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint = "WritePrinter", SetLastError = true, ExactSpelling = true)]
  public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);
  public static bool SendFileToPrinter(string szPrinterName, string szFileName) {
    if (!File.Exists(szFileName)) return false;
    byte[] bytes = File.ReadAllBytes(szFileName);
    IntPtr hPrinter = IntPtr.Zero;
    DOCINFOA di = new DOCINFOA();
    bool bSuccess = false;
    di.pDocName = "Thermal Spooler Print";
    di.pDataType = "RAW";
    if (OpenPrinter(szPrinterName, out hPrinter, IntPtr.Zero)) {
      if (StartDocPrinter(hPrinter, 1, di)) {
        if (StartPagePrinter(hPrinter)) {
          IntPtr pUnmanagedBytes = Marshal.AllocCoTaskMem(bytes.Length);
          Marshal.Copy(bytes, 0, pUnmanagedBytes, bytes.Length);
          int dwWritten = 0;
          bSuccess = WritePrinter(hPrinter, pUnmanagedBytes, bytes.Length, out dwWritten);
          Marshal.FreeCoTaskMem(pUnmanagedBytes);
          EndPagePrinter(hPrinter);
        }
        EndDocPrinter(hPrinter);
      }
      ClosePrinter(hPrinter);
    }
    return bSuccess;
  }
}
"@
if (-not [WinSpoolRaw]::SendFileToPrinter("${printerName}", "${tmp.replace(/\\/g, "\\\\")}")) { exit 2 }
`;
    const b64 = Buffer.from(script, "utf16le").toString("base64");
    await execFileP("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", b64], { windowsHide: true });
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

/** إرسال بايتات خام لطابعة Windows مشتركة بنوع RAW عبر spooler (copy /b ⇒ نسخ ثنائي للمشاركة). */
export async function sendWindowsShare(shareName: string, bytes: Buffer): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("الطباعة عبر مشاركة Windows متاحة على نظام Windows فقط — استعمل tcp:// لطابعة شبكية.");
  }
  // اسم المشاركة يُمرَّر إلى cmd الذي يعيد تحليل سطر الأوامر؛ نرفض أي اسم خارج القائمة البيضاء
  // (أحرف/أرقام ومسافة و _ . - $) لإغلاق أي حقن أوامر — حتى وإن أتى من PRINT_TARGET الموثوق (دفاع عميق).
  if (!/^[A-Za-z0-9 _.$,()#-]+$/.test(shareName)) {
    throw new Error(`اسم مشاركة غير صالح: «${shareName}». يُسمح بالأحرف والأرقام والمسافة و _ . - $ فقط.`);
  }
  const tmp = path.join(tmpdir(), `escpos-${process.pid}-${Date.now()}-${tmpCounter++}.bin`);
  await writeFile(tmp, bytes);
  try {
    const unc = `\\\\localhost\\${shareName}`;
    try {
      // copy /b <file> <printerShare> ⇒ يرسل البايتات خاماً للطابعة المشتركة (datatype RAW).
      await execFileP("cmd", ["/c", "copy", "/b", tmp, unc], { windowsHide: true });
    } catch {
      // محاولة بديلة عبر 127.0.0.1 إن تعذّر مسار localhost
      const fallbackUnc = `\\\\127.0.0.1\\${shareName}`;
      try {
        await execFileP("cmd", ["/c", "copy", "/b", tmp, fallbackUnc], { windowsHide: true });
      } catch {
        // تراجع أخير لطابعة Spooler المباشرة
        await sendWindowsSpooler(shareName, bytes);
      }
    }
  } finally {
    await unlink(tmp).catch(() => { /* الملف المؤقّت ليس حرجاً */ });
  }
}

/**
 * الإرسال الرئيسي: يحلّ الوجهة من البيئة ويوجّه البايتات. يرمي إن كان الجسر غير مفعّل
 * أو فشل الإرسال (ليتراجع العميل للبديل أو يُظهر خطأً واضحاً).
 */
export async function sendToPrinter(bytes: Buffer, override?: PrintTarget | null): Promise<PrintTarget> {
  const target = override ?? getConfiguredTarget();
  if (!target) {
    throw new Error("جسر الطباعة غير مفعّل (لم يتم العثور على طابعة حرارية متصلة بالخادم).");
  }
  if (target.kind === "tcp") {
    await sendTcp(target.host!, target.port!, bytes);
  } else if (target.kind === "share") {
    await sendWindowsShare(target.name!, bytes);
  } else {
    await sendWindowsSpooler(target.name!, bytes);
  }
  logger.info({ target: target.raw, bytes: bytes.length }, "print job sent via server bridge");
  return target;
}

// ───────────────────────── تذكرة اختبار (ASCII، بلا Canvas) ─────────────────────────

/**
 * بايتات ESC/POS لتذكرة اختبار بسيطة (ASCII فقط — لا تحتاج Canvas/عربية) للتحقق من سلامة
 * المسار + القاطع من الخادم مباشرة. النصّ لاتيني عمداً لأن الطابعات الحرارية لا ترسم العربية نصياً.
 */
export function buildTestTicket(): Buffer {
  const ESC = 0x1b, GS = 0x1d, LF = 0x0a;
  const text = (s: string) => Array.from(Buffer.from(s, "ascii"));
  const bytes: number[] = [
    ESC, 0x40,            // ESC @  تهيئة
    ESC, 0x61, 0x01,      // ESC a 1  توسيط
    ...text("AL-ROYA ERP\n"),
    ...text("PRINT BRIDGE OK\n"),
    ...text(new Date().toISOString().replace("T", " ").slice(0, 19) + "\n"),
    LF, LF, LF,
    GS, 0x56, 0x42, 0x00, // GS V B 0  قطع جزئي
  ];
  return Buffer.from(bytes);
}
