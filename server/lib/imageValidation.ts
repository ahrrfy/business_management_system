import { TRPCError } from "@trpc/server";

/** حدّ أبعاد افتراضيّ (px) لكلّ بُعد — يمنع «قنبلة البكسلات» (ملفّ صغير يُعلن أبعاداً ضخمة ⇒ فكّ
 *  ضغطٍ يستنزف الذاكرة). العميل يضغط ≤1600px، وهذا حارس خادميّ دفاعيّ. راجع التصميم §٥ #٤. */
const DEFAULT_MAX_DIMENSION = 4096;

/**
 * يقرأ أبعاد الصورة من ترويستها (PNG IHDR / JPEG SOFn / WebP VP8·VP8L·VP8X) دون فكّ الصورة كاملةً.
 * يعيد null إن تعذّر التحليل (ترويسة أقصر من المتوقّع/صيغة غير معروفة) ⇒ يتساهل الفاحص عندها
 * (فحص المغناطيس والحجم يبقيان حارسَين). يتعامل فقط مع الصيغ المسموحة (png/jpeg/webp).
 */
export function parseImageDimensions(bytes: Buffer, mime: string): { width: number; height: number } | null {
  try {
    if (mime === "image/png") {
      if (bytes.length < 24 || bytes.toString("ascii", 12, 16) !== "IHDR") return null;
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    if (mime === "image/jpeg" || mime === "image/jpg") {
      let off = 2; // بعد SOI (FF D8)
      while (off + 9 <= bytes.length) {
        if (bytes[off] !== 0xff) {
          off++;
          continue;
        }
        const marker = bytes[off + 1];
        // SOF0..SOF15 عدا DHT(C4)/JPG(C8)/DAC(CC) ⇒ يحمل الأبعاد.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: bytes.readUInt16BE(off + 5), width: bytes.readUInt16BE(off + 7) };
        }
        if (marker === 0xff) {
          off++; // حشو 0xFF متتالٍ
          continue;
        }
        const len = bytes.readUInt16BE(off + 2);
        if (len < 2) return null; // مقطع غير صالح
        off += 2 + len; // تخطّي المقطع بطوله
      }
      return null;
    }
    if (mime === "image/webp") {
      if (bytes.length < 16 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP") {
        return null;
      }
      const fourcc = bytes.toString("ascii", 12, 16);
      if (fourcc === "VP8X" && bytes.length >= 30) {
        return {
          width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)),
          height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)),
        };
      }
      if (fourcc === "VP8 " && bytes.length >= 30) {
        return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
      }
      if (fourcc === "VP8L" && bytes.length >= 25) {
        const b1 = bytes[21];
        const b2 = bytes[22];
        const b3 = bytes[23];
        const b4 = bytes[24];
        return {
          width: 1 + (b1 | ((b2 & 0x3f) << 8)),
          height: 1 + (((b2 & 0xc0) >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10)),
        };
      }
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

/** يَتحقّق من سلسلة صورة data URL: نوع MIME مسموح (png/jpeg/webp) + حجم تقديري ≤ maxBytes.
 *  مع strictMagic: يفحص أنّ البايتات base64 صالحة، ومطابقة المغناطيس للصيغة المعلنة، و**أبعاداً**
 *  ≤ maxDimension (حارس قنبلة البكسلات). null/undefined/"" تَمرّ بلا فحص (الحقول الاختيارية).
 */
export function assertValidImageDataUrl(
  s: string | null | undefined,
  maxBytes = 2_000_000,
  strictMagic = false,
  maxDimension = DEFAULT_MAX_DIMENSION,
) {
  if (s == null || s === "") return;
  if (!/^data:image\/(png|jpe?g|webp);base64,/.test(s)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "صورة بصيغة غير صالحة" });
  }
  const commaIdx = s.indexOf(",");
  const base64 = s.slice(commaIdx + 1);
  if (strictMagic && (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "بيانات الصورة غير صالحة" });
  }
  const sizeEstimate = base64.length * 0.75;
  if (sizeEstimate > maxBytes) {
    throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "حجم الصورة أكبر من المسموح" });
  }
  if (!strictMagic) return;
  const bytes = Buffer.from(base64, "base64");
  const mime = s.slice(5, s.indexOf(";"));
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp = bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (!((mime === "image/png" && png) || (mime === "image/jpeg" && jpeg) || (mime === "image/jpg" && jpeg) || (mime === "image/webp" && webp))) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "محتوى الصورة لا يطابق صيغتها المعلنة" });
  }
  // حارس «قنبلة البكسلات»: نرفض ما يتجاوز الحدّ في أيّ بُعد. تعذّر التحليل ⇒ تساهل (المغناطيس والحجم يحرسان).
  const dims = parseImageDimensions(bytes, mime);
  if (dims && (dims.width > maxDimension || dims.height > maxDimension)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "أبعاد الصورة أكبر من المسموح" });
  }
}
