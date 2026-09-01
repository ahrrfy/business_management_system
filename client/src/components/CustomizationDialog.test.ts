/**
 * **عنوانُ أمر الشغل يُشتقّ ولا يُفرَض** (بلاغ المالك ١/٩/٢٦).
 *
 * كان الحقلُ إلزامياً (`disabled={!data.title.trim()}`) ومبذوراً باسم سطر السلّة — فالخدمةُ
 * الحرّة تُبذَر بالاسم العامّ «خدمة / أمر شغل»، وهو نصٌّ **غير فارغ** فيمرّ الحفظُ به كما هو.
 * النتيجة في لوحة أوامر الشغل: بطاقاتٌ عمياء لا يُعرَف صاحبُها ولا شغلُها (ظاهرةٌ في لقطة
 * المالك). فصار الحقلُ اختيارياً ويُشتقّ ما يُحفَظ من سياق الطلب.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  GENERIC_SERVICE_NAME,
  deriveWorkOrderTitle,
  emptyCustomization,
} from "./CustomizationDialog";

const base = { title: "", customizationText: "", size: "", material: "" };

describe("اشتقاق عنوان أمر الشغل", () => {
  it("ما كتبه الموظّف يسبق كلَّ شيء", () => {
    expect(
      deriveWorkOrderTitle({ ...base, title: "  درع تكريم  ", customizationText: "نصّ" }, "ختم Oval 55"),
    ).toBe("درع تكريم");
  });

  it("اسمُ المنتج الحقيقيّ دالٌّ بذاته فيُستعمَل عنواناً", () => {
    expect(deriveWorkOrderTitle(base, "ختم Oval 55")).toBe("ختم Oval 55");
  });

  it("⭐ الاسمُ العامّ لا يُقبَل عنواناً — لا مبذوراً ولا مكتوباً", () => {
    // الخدمة الحرّة: اسمُ السطر عامّ، ووصفُ الشغل في نصّ التخصيص.
    expect(
      deriveWorkOrderTitle(
        { ...base, customizationText: "بنر افتتاح مطعم الشام" },
        GENERIC_SERVICE_NAME,
      ),
    ).toBe("بنر افتتاح مطعم الشام");
    // وحتى لو وصل الاسمُ العامّ في حقل العنوان نفسه (بذرةٌ قديمة) يُتخطّى.
    expect(
      deriveWorkOrderTitle(
        { ...base, title: GENERIC_SERVICE_NAME, customizationText: "ختم دائري" },
        GENERIC_SERVICE_NAME,
      ),
    ).toBe("ختم دائري");
  });

  it("يأخذ أوّلَ سطرٍ ذي محتوى من نصّ التخصيص ويقصّه عند ٨٠ محرفاً", () => {
    expect(
      deriveWorkOrderTitle(
        { ...base, customizationText: "\n\n  لافتة محل  \nتفاصيل أخرى" },
        GENERIC_SERVICE_NAME,
      ),
    ).toBe("لافتة محل");

    const long = "ل".repeat(120);
    const out = deriveWorkOrderTitle({ ...base, customizationText: long }, GENERIC_SERVICE_NAME);
    expect(out).toHaveLength(80);
    expect(out.endsWith("…")).toBe(true);
  });

  it("يسقط على المقاس والخامة قبل الاسم العامّ", () => {
    expect(
      deriveWorkOrderTitle({ ...base, size: "1×3 م", material: "فينيل" }, GENERIC_SERVICE_NAME),
    ).toBe("1×3 م — فينيل");
  });

  it("والاسمُ العامّ آخرُ الملاذات — حين لا يوجد شيءٌ إطلاقاً", () => {
    expect(deriveWorkOrderTitle(base, GENERIC_SERVICE_NAME)).toBe(GENERIC_SERVICE_NAME);
  });

  it("⛔ لا يُبذَر الاسمُ العامّ في حقل العنوان أصلاً", () => {
    expect(emptyCustomization(GENERIC_SERVICE_NAME).title).toBe("");
    expect(emptyCustomization("ختم Oval 55").title).toBe("ختم Oval 55");
  });
});

describe("عقد نافذة التخصيص", () => {
  const source = readFileSync(new URL("./CustomizationDialog.tsx", import.meta.url), "utf8");

  it("⭐ العنوان لم يعد يحجب الحفظ، والمحفوظ هو المشتقّ", () => {
    expect(source).not.toContain('disabled={!data.title.trim()}');
    expect(source).not.toContain("عنوان أمر الشغل مطلوب");
    expect(source).toContain("onSave({ ...data, title: derivedTitle })");
    // ويُعرَض حيّاً قبل الحفظ — لا عنوانَ يُفاجئ الموظّف.
    expect(source).toContain("placeholder={derivedTitle}");
  });

  it("⭐ الاختياريّ مطويٌّ افتراضاً ويُفتَح تلقائياً متى حمل قيمة", () => {
    expect(source).toContain("تفاصيل إضافية (اختيارية)");
    expect(source).toContain("const [showExtras, setShowExtras] = useState(false)");
    expect(source).toContain("setShowExtras(extrasFilled)");
    // وعدّادٌ يمنع إخفاءَ بياناتٍ مكتوبةٍ بلا أثرٍ ظاهر.
    expect(source).toContain("مُعبَّأة");
  });
});
