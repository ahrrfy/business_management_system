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
import { decodeStudioThumbnail, isCompleteStillWebp } from "../productStudioService";

/** WebP صالح ١×١ (VP8L، مقطعٌ واحد كامل) — نفس ما ينتجه canvas. */
const WEBP_1X1 = "data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA";
/** JPEG أساسيّ ١×١ يبدأ FFD8FF وينتهي FFD9. */
const JPEG_1X1 =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

const ONE_BY_ONE = { width: 1, height: 1 };

/**
 * ⭐ مخرَجٌ **حقيقيّ** من `canvas.toDataURL("image/webp")` في Chromium 148 — التُقط في جولةٍ
 * حيّة على الشاشة. بنيته `[VP8X 10, ICCP 456, VP8  50]`: المتصفّح يُضمّن ملفّ ألوان sRGB،
 * فيصير الملفّ ثلاثة مقاطع لا واحداً. صورة ٤×٣.
 */
const CHROME_VP8X_4X3 = "data:image/webp;base64,UklGRiACAABXRUJQVlA4WAoAAAAgAAAAAwAAAgAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZWUDggMgAAADACAJ0BKgQAAwABwCwlnAJ0fwCNQCzay6iAAP7+AkzY/yADW+E8I/i6O+8w3iO/gAAA";

describe("بنية WebP: مشيٌ على مقاطع RIFF لا افتراضُ شكل", () => {
  const bytesOf = (dataUrl: string) => Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");

  it("⭐ يقبل مخرَج Chrome الحقيقيّ (VP8X + ICCP + VP8) — كان مرفوضاً بالكامل", () => {
    // العطب: الفحص القديم يشترط **مقطعاً واحداً** بترويسة VP8/VP8L، وChrome يُخرج ثلاثة.
    // فكان كل مصوّرٍ على Chrome/Edge يُمنع من الإرسال برسالة «بنية/إطار غير مكتمل».
    expect(isCompleteStillWebp(bytesOf(CHROME_VP8X_4X3))).toBe(true);
  });

  it("ويقبل WebP بسيطاً بمقطعٍ واحد (VP8L) كما كان", () => {
    expect(isCompleteStillWebp(bytesOf(WEBP_1X1))).toBe(true);
  });

  it("يرفض المبتور — الصرامة ازدادت لا نقصت", () => {
    const raw = bytesOf(CHROME_VP8X_4X3);
    expect(isCompleteStillWebp(raw.subarray(0, raw.length - 10))).toBe(false);
  });

  it("يرفض ذيلَ بايتاتٍ زائدٍ بعد نهاية RIFF", () => {
    const raw = bytesOf(CHROME_VP8X_4X3);
    expect(isCompleteStillWebp(Buffer.concat([raw, Buffer.from([0, 0, 0, 0])]))).toBe(false);
  });

  it("يرفض مقطعاً يدّعي حجماً أكبر من الملفّ (تلاعب)", () => {
    const raw = Buffer.from(bytesOf(CHROME_VP8X_4X3));
    raw.writeUInt32LE(0x7fffffff, 16); // حجم مقطع VP8X
    expect(isCompleteStillWebp(raw)).toBe(false);
  });

  it("يرفض ما ليس RIFF/WEBP", () => {
    expect(isCompleteStillWebp(Buffer.from("NOTAWEBPFILEXXXXXXXX"))).toBe(false);
    expect(isCompleteStillWebp(Buffer.alloc(4))).toBe(false);
  });
});

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

  it("⭐ مخرَج Chrome يمرّ من الطرف إلى الطرف بأبعاده الحقيقية", () => {
    // الدليل الكامل: نفس البايتات التي رفضها الإنتاج تُقبل الآن وتُقرأ أبعادها ٤×٣.
    const result = decodeStudioThumbnail(CHROME_VP8X_4X3, { width: 4, height: 3 });
    expect(result).toMatchObject({ width: 4, height: 3 });
  });

  it("يرفض مرشّحاً بلا أبعاد — لا مصغّرة بلا ما تُشتقّ منه", () => {
    expect(() => decodeStudioThumbnail(JPEG_1X1, { width: null, height: null })).toThrow(/ربط المصغّرة/);
  });
});
