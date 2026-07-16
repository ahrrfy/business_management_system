/**
 * ترميز الصور المرفوعة — WebP إن كانت **أصغر فعلاً**، وإلّا JPEG.
 *
 * **الفخّ الأوّل:** `canvas.toDataURL("image/webp")` في متصفّحٍ لا يدعم WebP **لا يفشل ولا يرمي**
 * — بل يعود بـ**PNG** (سلوكٌ مُواصَف: نوعٌ غير مدعوم ⇒ الافتراضي `image/png`). وPNG لصورةٍ
 * فوتوغرافية أكبر من JPEG بأضعاف ⇒ «تحسينُ» الحجم يصير **مضاعفةً صامتة** على سفاري القديم.
 * الحارس: فحص **بادئة الناتج** لا نجاح النداء.
 *
 * **الفخّ الثاني (قِيس فعلياً، لم يُفترَض):** WebP **ليس أصغر دائماً** — على صورةٍ عالية الضوضاء
 * كان **أكبر ٤٨٪** من JPEG بنفس الجودة (٣٧٧ مقابل ٢٥٥ ك.ب). لذا نُرمّز الاثنين ونأخذ **الأصغر
 * قياساً**: التحسين يصير مُبرهناً لا مُرجَّحاً. (على بنرات الإنتاج الحقيقية: WebP أصغر **٢٦٪**.)
 *
 * البيئة `node` بلا `Image` ⇒ `compressImageDataUrl` يسقط للأصل قبل الترميز، فاختبارُه هنا كان
 * سيمرّ **بلا أن يلمس المنطق** (حراسةٌ وهمية). نختبر الوحدة مباشرةً.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetEncoderCache, webpSupported } from "../ImageUploader";

/** canvas وهميّ يحاكي متصفّحاً بدعمٍ مُحدَّد لـWebP، ويسجّل ما طُلب منه. */
function stubCanvas(supportsWebp: boolean) {
  const asked: string[] = [];
  vi.stubGlobal("document", {
    createElement: () => ({
      width: 0,
      height: 0,
      toDataURL: (type?: string) => {
        asked.push(type ?? "");
        // 🎯 جوهر المحاكاة: نوعٌ غير مدعوم ⇒ **PNG بلا خطأ** (سلوك المتصفّح الحقيقيّ).
        if (type === "image/webp" && !supportsWebp) return "data:image/png;base64,AAAA";
        return `data:${type ?? "image/png"};base64,AAAA`;
      },
    }),
  });
  return asked;
}

afterEach(() => {
  vi.unstubAllGlobals();
  __resetEncoderCache();
});

describe("webpSupported — كشف الدعم", () => {
  it("⭐ متصفّحٌ يدعم WebP ⇒ true", () => {
    const asked = stubCanvas(true);
    expect(webpSupported()).toBe(true);
    expect(asked[0]).toBe("image/webp"); // فُحص فعلاً
  });

  it("⭐ متصفّحٌ يعود بـPNG (لا يدعم) ⇒ false — لا نثق بنجاح النداء", () => {
    stubCanvas(false);
    expect(webpSupported()).toBe(false);
  });

  it("بيئةٌ بلا document (SSR/اختبار) ⇒ false بلا انفجار", () => {
    vi.stubGlobal("document", undefined);
    expect(webpSupported()).toBe(false);
  });

  it("النتيجة تُخبّأ (لا فحص canvas لكل صورة)", () => {
    const asked = stubCanvas(true);
    webpSupported();
    webpSupported();
    webpSupported();
    expect(asked).toHaveLength(1);
  });
});
