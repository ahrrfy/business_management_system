/**
 * صيغ مصغّرة عرض الاستوديو (٢٠/٨ — بلاغ إنتاج).
 *
 * كان `decodeStudioThumbnail` يفرض WebP، و`canvas.toDataURL("image/webp")` غير مدعوم على
 * Safari/iOS قبل ١٧ ⇒ المصوّر على iPhone يلتقط ويعالج ثمّ **يُمنع من الإرسال نهائياً**
 * بسبب مشتقّ عرضٍ لا علاقة له بجودة عمله. صار JPEG مقبولاً — **بنفس الصرامة لا بأقلّ**.
 *
 * اختبارُ وحدةٍ بلا قاعدة: الدالّة نقيّة (تأخذ نصّاً وأبعاداً وترمي أو تُرجع).
 */
import { describe, expect, it } from "vitest";
import { decodeStudioThumbnail } from "../productStudioService";

/** WebP صالح ١×١ (VP8L، مقطعٌ واحد كامل) — نفس ما ينتجه canvas. */
const WEBP_1X1 = "data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA";
/** JPEG أساسيّ ١×١ يبدأ FFD8FF وينتهي FFD9. */
const JPEG_1X1 =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

const ONE_BY_ONE = { width: 1, height: 1 };

describe("مصغّرة الاستوديو تقبل الصيغتين", () => {
  it("WebP يبقى مقبولاً كما كان", () => {
    const result = decodeStudioThumbnail(WEBP_1X1, ONE_BY_ONE);
    expect(result).toMatchObject({ width: 1, height: 1 });
    expect(result.hash).toMatch(/^[0-9a-f]{16,}$/);
  });

  it("⭐ JPEG صار مقبولاً — وهو مسار Safari/iOS الوحيد", () => {
    const result = decodeStudioThumbnail(JPEG_1X1, ONE_BY_ONE);
    expect(result).toMatchObject({ width: 1, height: 1 });
  });

  it("يرفض PNG — التساهل في الصيغة محدودٌ بصيغتين لا مفتوح", () => {
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    expect(() => decodeStudioThumbnail(png, ONE_BY_ONE)).toThrow(/WebP أو JPEG/);
  });

  it("يرفض JPEG مبتوراً (بلا EOI) — الصرامة لم تُخفَّض", () => {
    const raw = Buffer.from(JPEG_1X1.slice(JPEG_1X1.indexOf(",") + 1), "base64");
    const truncated = `data:image/jpeg;base64,${raw.subarray(0, raw.length - 2).toString("base64")}`;
    expect(() => decodeStudioThumbnail(truncated, ONE_BY_ONE)).toThrow(/بنية مصغّرة JPEG/);
  });

  it("يرفض مصغّرةً لا تطابق أبعاد المرشّح — الحارس المشترك أياً كانت الصيغة", () => {
    // نفس الفحص يسري على الصيغتين: المصغّرة مشتقٌّ من المرشّح لا صورةٌ حرّة.
    expect(() => decodeStudioThumbnail(JPEG_1X1, { width: 800, height: 400 })).toThrow(/أبعاد المصغّرة/);
    expect(() => decodeStudioThumbnail(WEBP_1X1, { width: 800, height: 400 })).toThrow(/أبعاد المصغّرة/);
  });

  it("يرفض مرشّحاً بلا أبعاد — لا مصغّرة بلا ما تُشتقّ منه", () => {
    expect(() => decodeStudioThumbnail(JPEG_1X1, { width: null, height: null })).toThrow(/ربط المصغّرة/);
  });
});
