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
import { __resetEncoderCache, encodeSmallest, webpSupported } from "../ImageUploader";

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

/**
 * الترميز صار غير متزامن عبر `toBlob`: `toDataURL` يُرمّز **متزامناً على الخيط الرئيسي**
 * ويبني نصّ base64 كاملاً قبل أن يعود ⇒ لوحة ١٦٠٠×١٦٠٠ تُجمّد الصفحة، والدفعة تُضاعف ذلك.
 * والمقارنة صارت على **حجم الـblob** لا طول النصّ، فلا يُبنى نصّان ضخمان لمجرّد المقارنة.
 */
function stubBlobCanvas(sizes: { jpeg: number; webp: number }, webpReturnsPng = false) {
  const asked: string[] = [];
  const canvas = {
    width: 1600,
    height: 1600,
    toDataURL: (type?: string) => `data:${type ?? "image/png"};base64,AAAA`,
    toBlob: (cb: (b: Blob | null) => void, type?: string) => {
      asked.push(type ?? "");
      // الفخّ نفسه في صيغة blob: نوعٌ غير مدعوم ⇒ ناتجٌ من نوع PNG بلا خطأ.
      const actualType = type === "image/webp" && webpReturnsPng ? "image/png" : (type ?? "image/png");
      const size = type === "image/webp" ? sizes.webp : sizes.jpeg;
      cb({ size, type: actualType } as Blob);
    },
  } as unknown as HTMLCanvasElement;
  return { canvas, asked };
}

describe("encodeSmallest — أصغر ناتجٍ فعليّ عبر toBlob", () => {
  it("⭐ لا يستدعي toDataURL إطلاقاً — الترميز المتزامن هو سبب التجميد", async () => {
    stubCanvas(true); // يُثبّت دعم WebP في الكاش
    const { canvas, asked } = stubBlobCanvas({ jpeg: 900, webp: 700 });
    await encodeSmallest(canvas, 0.82);
    expect(asked).toEqual(["image/jpeg", "image/webp"]);
  });

  it("⭐ يأخذ الأصغر قياساً بحجم الـblob لا بطول النصّ", async () => {
    stubCanvas(true);
    const smallerWebp = await encodeSmallest(stubBlobCanvas({ jpeg: 900, webp: 700 }).canvas, 0.82);
    expect(smallerWebp).toMatchObject({ bytes: 700 });
    // الصورة عالية الضوضاء: WebP أكبر ⇒ JPEG يفوز (التحسين مُبرهَنٌ لا مُرجَّح).
    const smallerJpeg = await encodeSmallest(stubBlobCanvas({ jpeg: 255, webp: 377 }).canvas, 0.82);
    expect(smallerJpeg).toMatchObject({ bytes: 255 });
  });

  it("⭐ ناتجٌ طُلب webp وعاد png ⇒ يُرفَض ويُؤخذ JPEG — الحكم على نوع الناتج", async () => {
    stubCanvas(true); // الكاش يقول «مدعوم» بينما toBlob يعود PNG
    const { canvas } = stubBlobCanvas({ jpeg: 900, webp: 100 }, true);
    // لولا فحص النوع لفاز «webp» الوهميّ (١٠٠ < ٩٠٠) وهو PNG أكبر بأضعاف على صورةٍ فوتوغرافية.
    expect(await encodeSmallest(canvas, 0.82)).toMatchObject({ bytes: 900 });
  });
});
