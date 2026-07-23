/**
 * productImages — تحويل صور المنتج بين الخادم وحالة الرافع بمطابقة المعرّف.
 *
 * الثوابت المُختبَرة (جوهر الحفظ الاقتصاديّ الآمن):
 *   • القراءة تَسِم الصور القائمة بمعرّف القاعدة وتضبط dataUrl=url (تُعرَض مباشرةً).
 *   • الصورة القائمة غير المتغيّرة تُرسَل **بمعرّفها فقط** (بلا بايتات) ⇒ لا تكرار للشبكة، ويصون id خادمياً.
 *   • الجديدة (رفع) تُرسَل ببايتاتها بلا id.
 *   • الاستوديو يمسح url ويبدّل dataUrl ⇒ استبدالٌ في المكان (id باقٍ + بايتات جديدة).
 *   • جولة ذهاب-عودة (hydrate ثم build بلا لمس) لا تُرسِل أيّ بايتات.
 */
import { describe, expect, it } from "vitest";
import { type ImageItem } from "@/components/form/ImageUploader";
import { buildProductImagesPayload, DB_IMG_PREFIX, hydrateProductImages } from "../productImages";

describe("hydrateProductImages", () => {
  it("يحوّل صور الخادم إلى عناصر رافع بمعرّف موسوم وdataUrl=url", () => {
    const out = hydrateProductImages([
      { id: 7, url: "data:image/png;base64,AAA", isPrimary: true, sortOrder: 0 },
      { id: 9, url: "data:image/png;base64,BBB", isPrimary: false, sortOrder: 1 },
    ]);
    expect(out).toEqual([
      { id: "dbimg:7", dataUrl: "data:image/png;base64,AAA", url: "data:image/png;base64,AAA", isPrimary: true },
      { id: "dbimg:9", dataUrl: "data:image/png;base64,BBB", url: "data:image/png;base64,BBB", isPrimary: false },
    ]);
  });

  it("مدخل غائب/فارغ ⇒ مصفوفة فارغة", () => {
    expect(hydrateProductImages(undefined)).toEqual([]);
    expect(hydrateProductImages([])).toEqual([]);
  });
});

describe("buildProductImagesPayload", () => {
  it("صورة قائمة غير متغيّرة ⇒ تُرسَل بمعرّفها بلا بايتات (url=undefined)", () => {
    const items: ImageItem[] = [
      { id: "dbimg:7", dataUrl: "data:image/png;base64,AAA", url: "data:image/png;base64,AAA", isPrimary: true },
    ];
    expect(buildProductImagesPayload(items)).toEqual([
      { id: 7, url: undefined, isPrimary: true, sortOrder: 0 },
    ]);
  });

  it("صورة جديدة (رفع، بلا url) ⇒ تُرسَل ببايتاتها بلا id", () => {
    const items: ImageItem[] = [
      { id: "img_new1", dataUrl: "data:image/webp;base64,NEW", isPrimary: true },
    ];
    expect(buildProductImagesPayload(items)).toEqual([
      { id: undefined, url: "data:image/webp;base64,NEW", isPrimary: true, sortOrder: 0 },
    ]);
  });

  it("صورة قائمة استبدلها الاستوديو (url مُمسوح، dataUrl جديد) ⇒ id باقٍ + بايتات جديدة", () => {
    const items: ImageItem[] = [
      // ImageStudioUploader.accept يضبط dataUrl الجديد ويمسح url.
      { id: "dbimg:7", dataUrl: "data:image/webp;base64,STUDIO", url: undefined, isPrimary: true },
    ];
    expect(buildProductImagesPayload(items)).toEqual([
      { id: 7, url: "data:image/webp;base64,STUDIO", isPrimary: true, sortOrder: 0 },
    ]);
  });

  it("الترتيب = ترتيب المصفوفة (sortOrder = الفهرس)", () => {
    const items: ImageItem[] = [
      { id: "dbimg:1", dataUrl: "a", url: "a", isPrimary: false },
      { id: "img_x", dataUrl: "data:image/png;base64,ZZZ", isPrimary: true },
      { id: "dbimg:2", dataUrl: "b", url: "b", isPrimary: false },
    ];
    const out = buildProductImagesPayload(items);
    expect(out.map((o) => o.sortOrder)).toEqual([0, 1, 2]);
    expect(out[1]).toEqual({ id: undefined, url: "data:image/png;base64,ZZZ", isPrimary: true, sortOrder: 1 });
  });

  it("معرّف مُشوَّه (ليس dbimg:رقم) ⇒ يُعامَل جديداً (id=undefined، ببايتاته)", () => {
    const items: ImageItem[] = [
      { id: `${DB_IMG_PREFIX}abc`, dataUrl: "data:image/png;base64,QQQ", url: "data:image/png;base64,QQQ", isPrimary: true },
    ];
    // slice ⇒ Number("abc") = NaN ⇒ لا معرّف ⇒ جديدة ببايتاتها (لا نُرسِل id=NaN يرفضه zod).
    expect(buildProductImagesPayload(items)).toEqual([
      { id: undefined, url: "data:image/png;base64,QQQ", isPrimary: true, sortOrder: 0 },
    ]);
  });

  it("جولة ذهاب-عودة (hydrate ثم build بلا لمس) لا تُرسِل أيّ بايتات", () => {
    const server = [
      { id: 3, url: "data:image/png;base64,AAA", isPrimary: true, sortOrder: 0 },
      { id: 5, url: "data:image/png;base64,BBB", isPrimary: false, sortOrder: 1 },
    ];
    const payload = buildProductImagesPayload(hydrateProductImages(server));
    expect(payload).toEqual([
      { id: 3, url: undefined, isPrimary: true, sortOrder: 0 },
      { id: 5, url: undefined, isPrimary: false, sortOrder: 1 },
    ]);
  });

  it("مصفوفة فارغة (المستخدم أزال كل الصور) ⇒ حمولة فارغة ⇒ الخادم يحذف الكل", () => {
    expect(buildProductImagesPayload([])).toEqual([]);
  });
});
