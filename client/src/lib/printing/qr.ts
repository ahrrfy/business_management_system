/**
 * QR Code generation wrapper — Facade فوق مكتبة qrcode (MIT، صفر تكلفة).
 *
 * لماذا qrcode وليس تطبيق ذاتي؟
 * QR يحتاج Reed-Solomon error correction + version matrix + masking patterns = 500+ سطر.
 * Code128 كُتب ذاتياً (barcode.ts) لأنه 170 سطراً. QR لا يستحق إعادة الاختراع.
 *
 * الواجهة:
 *  • qrCodeSvg()     → SVG string مضمَّن في HTML (طريقة المتصفح)
 *  • qrCodeDataUrl() → PNG data URL يُرسم على Canvas (طريقة الطباعة الحرارية)
 */

import QRCode from "qrcode";

export interface QROptions {
  /** حجم الصورة بالبكسل (افتراضي: 200) */
  size?: number;
  /** هامش هادئ quiet zone بوحدات المودول (افتراضي: 1) */
  margin?: number;
  /** لون القضبان (افتراضي: #000000) */
  dark?: string;
  /** لون الخلفية (افتراضي: #ffffff) */
  light?: string;
  /** مستوى تصحيح الخطأ: L=7%، M=15%، Q=25%، H=30% (افتراضي: M) */
  errorCorrectionLevel?: "L" | "M" | "Q" | "H";
}

/**
 * يُولِّد SVG string — للتضمين المباشر في HTML (طباعة المتصفح).
 * async لأن مكتبة qrcode تعمل بـ Promise.
 */
export async function qrCodeSvg(data: string, opts: QROptions = {}): Promise<string> {
  if (!data) throw new Error("QR: البيانات فارغة");
  return QRCode.toString(data, {
    type: "svg",
    width: opts.size ?? 200,
    margin: opts.margin ?? 1,
    color: {
      dark: opts.dark ?? "#000000",
      light: opts.light ?? "#ffffff",
    },
    errorCorrectionLevel: opts.errorCorrectionLevel ?? "M",
  });
}

/**
 * يُولِّد PNG data URL — لرسمه على Canvas بـ ctx.drawImage (طباعة حرارية).
 * async لأن مكتبة qrcode تعمل بـ Promise.
 */
export async function qrCodeDataUrl(data: string, opts: QROptions = {}): Promise<string> {
  if (!data) throw new Error("QR: البيانات فارغة");
  return QRCode.toDataURL(data, {
    type: "image/png",
    width: opts.size ?? 200,
    margin: opts.margin ?? 1,
    color: {
      dark: opts.dark ?? "#000000",
      light: opts.light ?? "#ffffff",
    },
    errorCorrectionLevel: opts.errorCorrectionLevel ?? "M",
  });
}
