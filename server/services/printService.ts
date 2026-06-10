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
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { logger } from "../logger";

const execFileP = promisify(execFile);

export const DEFAULT_RAW_PORT = 9100;

export interface PrintTarget {
  kind: "tcp" | "share";
  /** للعرض/التشخيص فقط — لا يُسرّب أسراراً (لا توجد أسرار في وجهة الطباعة). */
  raw: string;
  host?: string;
  port?: number;
  name?: string;
}

/**
 * تحليل وجهة الطباعة من نصّ PRINT_TARGET. دالة نقية (لا آثار جانبية) ⇒ قابلة للاختبار.
 * يعيد null إن كان الإدخال فارغاً أو غير صالح.
 */
export function parsePrintTarget(raw?: string | null): PrintTarget | null {
  const v = (raw ?? "").trim();
  if (!v) return null;

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

  // اختصار host:port (يُفسَّر كـTCP RAW).
  const hp = v.match(/^([^/:\s]+):(\d+)$/);
  if (hp) {
    const port = Number(hp[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { kind: "tcp", host: hp[1], port, raw: v };
  }

  return null;
}

/** الوجهة المضبوطة حالياً من البيئة، أو null إن لم يُفعّل الجسر. */
export function getConfiguredTarget(): PrintTarget | null {
  return parsePrintTarget(process.env.PRINT_TARGET);
}

export function isBridgeEnabled(): boolean {
  return getConfiguredTarget() != null;
}

/** وصف مختصر للعرض في الواجهة (بلا كشف تفاصيل حسّاسة). */
export function describeTarget(t: PrintTarget | null): string {
  if (!t) return "غير مفعّل";
  if (t.kind === "tcp") return `طابعة شبكية ${t.host}:${t.port}`;
  return `طابعة Windows مشتركة «${t.name}»`;
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

/** إرسال بايتات خام لطابعة Windows مشتركة بنوع RAW عبر spooler (copy /b ⇒ نسخ ثنائي للمشاركة). */
export async function sendWindowsShare(shareName: string, bytes: Buffer): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("الطباعة عبر مشاركة Windows متاحة على نظام Windows فقط — استعمل tcp:// لطابعة شبكية.");
  }
  // اسم المشاركة يُمرَّر إلى cmd الذي يعيد تحليل سطر الأوامر؛ نرفض أي اسم خارج القائمة البيضاء
  // (أحرف/أرقام ومسافة و _ . - $) لإغلاق أي حقن أوامر — حتى وإن أتى من PRINT_TARGET الموثوق (دفاع عميق).
  if (!/^[A-Za-z0-9 _.$-]+$/.test(shareName)) {
    throw new Error(`اسم مشاركة غير صالح: «${shareName}». يُسمح بالأحرف والأرقام والمسافة و _ . - $ فقط.`);
  }
  const tmp = path.join(tmpdir(), `escpos-${process.pid}-${Date.now()}-${tmpCounter++}.bin`);
  await writeFile(tmp, bytes);
  try {
    const unc = `\\\\localhost\\${shareName}`;
    // copy /b <file> <printerShare> ⇒ يرسل البايتات خاماً للطابعة المشتركة (datatype RAW).
    await execFileP("cmd", ["/c", "copy", "/b", tmp, unc], { windowsHide: true });
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
    throw new Error("جسر الطباعة غير مفعّل (PRINT_TARGET غير مضبوط).");
  }
  if (target.kind === "tcp") {
    await sendTcp(target.host!, target.port!, bytes);
  } else {
    await sendWindowsShare(target.name!, bytes);
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
