import { TRPCError } from "@trpc/server";

/** يَتحقّق من سلسلة صورة data URL: نوع MIME مسموح (png/jpeg/webp) + حجم تقديري ≤ maxBytes.
 *  null/undefined/"" تَمرّ بلا فحص (الحقول الاختيارية). افتراضي ٢MB.
 */
export function assertValidImageDataUrl(s: string | null | undefined, maxBytes = 2_000_000) {
  if (s == null || s === "") return;
  if (!/^data:image\/(png|jpe?g|webp);base64,/.test(s)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "صورة بصيغة غير صالحة" });
  }
  const commaIdx = s.indexOf(",");
  const sizeEstimate = (s.length - commaIdx - 1) * 0.75;
  if (sizeEstimate > maxBytes) {
    throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "حجم الصورة أكبر من المسموح" });
  }
}
