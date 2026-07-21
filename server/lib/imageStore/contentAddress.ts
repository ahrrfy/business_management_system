/**
 * العنونة-بالمحتوى: مفتاح الكائن = sha256 لبايتات الصورة المفكوكة (لا نصّ data-URL — تصحيح ضعف
 * `imageHash` اليوم الذي يهشّ النصّ لا البكسلات). مصدرٌ وحيدٌ لـ contentHash + `?v=` + ETag +
 * بصمة الأوفلاين. راجع docs/product-image-studio-design-2026-07-21.md §١ (قاعدتا الهاش) + §٢.ز.
 */
import { createHash } from "node:crypto";

/** sha256 (٦٤ hex) لبايتات الصورة المفكوكة — البصمة القانونية الوحيدة. */
export function contentHash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** أوّل ١٦ hex — قيمة `?v=`/ETag (تُقرأ من عمود contentHash، لا تُعاد حسابها). */
export function shortHash(hash: string): string {
  return hash.slice(0, 16);
}

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

/** لاحقة الملف من الـMIME (افتراضي bin للمجهول — لا تُخمَّن من امتداد المدخل). */
export function extForMime(mime: string): string {
  return MIME_EXT[mime.toLowerCase()] ?? "bin";
}

/**
 * مفتاح كائن معنون-بالمحتوى منطَّق بالشركة: `<companyPrefix>/p/<h0h1>/<fullhash>.<ext>`.
 * التشظّي بأوّل محرفين hex يوزّع الكائنات ويتجنّب أدلّة ضخمة. النطاق بالشركة يمنع خدمة صورة
 * شركةٍ أخرى عند تصادم هاش (تعدّد الشركات).
 */
export function objectKeyFor(hash: string, mime: string, companyPrefix = "default"): string {
  const shard = hash.slice(0, 2);
  return `${companyPrefix}/p/${shard}/${hash}.${extForMime(mime)}`;
}
