import { TRPCError } from "@trpc/server";

/** يَتحقّق من سلسلة صورة data URL: نوع MIME مسموح (png/jpeg/webp) + حجم تقديري ≤ maxBytes.
 *  null/undefined/"" تَمرّ بلا فحص (الحقول الاختيارية). افتراضي ٢MB.
 */
export function assertValidImageDataUrl(s: string | null | undefined, maxBytes = 2_000_000, strictMagic = false) {
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
}
