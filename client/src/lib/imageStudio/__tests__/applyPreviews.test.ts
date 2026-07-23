/**
 * applyStudioPreviews — الناتج يُطبَّق على الصورة المستهدَفة بالمعرّف فقط.
 *
 * يحرس علّة المالك المُبلَّغة (٢٣/٧): «تعديل صورةٍ من عدّة صور كان يحدّد عشوائياً/يكرّر المعدَّلة».
 * الثابت: استهداف صورةٍ واحدة ⇒ تتغيّر **هي فقط**، والبقية دون مساس، ولا تُنسَخ نتيجةٌ على غير صاحبتها.
 */
import { describe, expect, it } from "vitest";
import { type ImageItem } from "@/components/form/ImageUploader";
import { applyStudioPreviews } from "../applyPreviews";

const img = (id: string, dataUrl: string, isPrimary = false): ImageItem => ({ id, dataUrl, url: dataUrl, isPrimary });

describe("applyStudioPreviews", () => {
  it("استهداف صورةٍ واحدة من ثلاث ⇒ تتغيّر هي فقط، والباقيتان دون مساس", () => {
    const value = [img("a", "AAA"), img("b", "BBB"), img("c", "CCC")];
    const out = applyStudioPreviews(value, [{ id: "b", after: "BBB-studio" }]);
    expect(out[0]).toEqual(value[0]); // a دون مساس
    expect(out[2]).toEqual(value[2]); // c دون مساس
    expect(out[1].dataUrl).toBe("BBB-studio"); // b وحدها تغيّرت
    expect(out[1].url).toBeUndefined(); // url مُمسوح ⇒ تُعاد بايتاتها الجديدة عند الحفظ
    expect(out[1].id).toBe("b"); // الهوية محفوظة
  });

  it("لا تُنسَخ نتيجةٌ على صورةٍ غير مستهدَفة (لا تكرار/خلط)", () => {
    const value = [img("a", "AAA"), img("b", "BBB")];
    const out = applyStudioPreviews(value, [{ id: "a", after: "SAME" }]);
    expect(out[0].dataUrl).toBe("SAME");
    expect(out[1].dataUrl).toBe("BBB"); // b لم تتلقَّ نتيجة a
    expect(out[1].url).toBe("BBB"); // b لم تُمَسّ إطلاقاً
  });

  it("استهداف عدّة صور (تحديد الكل) ⇒ كلٌّ تتلقّى ناتجها بالمعرّف", () => {
    const value = [img("a", "AAA"), img("b", "BBB")];
    const out = applyStudioPreviews(value, [
      { id: "a", after: "A2" },
      { id: "b", after: "B2" },
    ]);
    expect(out.map((i) => i.dataUrl)).toEqual(["A2", "B2"]);
  });

  it("معاينة بمعرّف غير موجود ⇒ تُتجاهَل (لا صفوف طيفية)", () => {
    const value = [img("a", "AAA")];
    const out = applyStudioPreviews(value, [{ id: "ghost", after: "X" }]);
    expect(out).toEqual(value);
  });

  it("يصون خصائص الصورة الأخرى (isPrimary/name) عند التعديل", () => {
    const value: ImageItem[] = [{ id: "a", dataUrl: "AAA", url: "AAA", isPrimary: true, name: "cover.png" }];
    const out = applyStudioPreviews(value, [{ id: "a", after: "A2" }]);
    expect(out[0].isPrimary).toBe(true);
    expect(out[0].name).toBe("cover.png");
    expect(out[0].dataUrl).toBe("A2");
  });
});
