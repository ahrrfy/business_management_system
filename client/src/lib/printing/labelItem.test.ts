// حراسة ثوابت ملصق الباركود (١٦/٧). كلّ اختبار هنا يحرس **علّة صحّة وقعت فعلاً**، لا تفضيلَ شكل.
import { describe, expect, it } from "vitest";
import { ellipsize, labelName, labelPrice, toLabelItem, TIER_LABEL, wrapTwoLines } from "./labelItem";

/** قياسٌ حتميّ للاختبار: كل حرفٍ عرضه ١٠ وحدات (بلا Canvas). */
const w10 = (s: string) => s.length * 10;

describe("labelName — تمييز المتغيّر", () => {
  it("يُدرج اللون والقياس والوحدة في اسم الملصق", () => {
    expect(labelName({ productName: "قلم جاف", color: "أزرق", size: "L", unitName: "درزن" }))
      .toBe("قلم جاف أزرق L — درزن");
  });

  // الثابت الأصل: كانت الصفحة تبني `المنتج — الوحدة` فقط ⇒ ملصقات ألوان المنتج الواحد
  // تخرج **متطابقةً نصّياً** فلا يفرّقها أحد على الرفّ. اسمان للونين مختلفين يجب أن يختلفا.
  it("لونان مختلفان ⇒ اسمان مختلفان (لا ملصقات متطابقة)", () => {
    const blue = labelName({ productName: "قلم جاف", color: "أزرق", unitName: "قطعة" });
    const red = labelName({ productName: "قلم جاف", color: "أحمر", unitName: "قطعة" });
    expect(blue).not.toBe(red);
  });

  it("بلا لون/قياس ⇒ الاسم والوحدة فقط بلا فواصل معلّقة", () => {
    expect(labelName({ productName: "ورق A4", color: null, size: null, unitName: "رزمة" }))
      .toBe("ورق A4 — رزمة");
  });

  it("بلا وحدة ⇒ بلا شرطة ذيلية", () => {
    expect(labelName({ productName: "ورق A4" })).toBe("ورق A4");
  });

  it("يتجاهل الفراغات المحضة في اللون/القياس", () => {
    expect(labelName({ productName: "دفتر", color: "  ", size: "", unitName: "قطعة" }))
      .toBe("دفتر — قطعة");
  });

  // حارس التكرار: بيانات فعلية (البذرة نفسها) تحمل اللون داخل اسم المنتج ⇒ الإلحاق الأعمى
  // كان يُخرج «قلم جاف أزرق أزرق — قطعة» على الرفّ.
  it("اللون موجود أصلاً في الاسم ⇒ لا يتكرّر", () => {
    expect(labelName({ productName: "قلم جاف أزرق", color: "أزرق", unitName: "قطعة" }))
      .toBe("قلم جاف أزرق — قطعة");
  });

  it("يُلحق القياس ولو كان اللون مكرّراً في الاسم", () => {
    expect(labelName({ productName: "قلم جاف أزرق", color: "أزرق", size: "L", unitName: "قطعة" }))
      .toBe("قلم جاف أزرق L — قطعة");
  });

  // الحارس يعمل على حدود الكلمات فقط: «أحمر» ليست موجودةً في «أحمرار» ⇒ تُلحَق.
  it("لا يبتلع وسماً هو جزءٌ من كلمةٍ أطول", () => {
    expect(labelName({ productName: "كريم أحمرار البشرة", color: "أحمر", unitName: "علبة" }))
      .toBe("كريم أحمرار البشرة أحمر — علبة");
  });

  it("يكشف التكرار عبر الفواصل لا الفراغات وحدها", () => {
    expect(labelName({ productName: "قميص · أزرق", color: "أزرق", unitName: "قطعة" }))
      .toBe("قميص · أزرق — قطعة");
  });

  it("عبارة لونٍ متعدّدة الكلمات موجودة في الاسم ⇒ لا تتكرّر", () => {
    expect(labelName({ productName: "ورق أزرق فاتح", color: "أزرق فاتح", unitName: "رزمة" }))
      .toBe("ورق أزرق فاتح — رزمة");
  });
});

describe("labelPrice — الملصق لا يكذب أثناء العرض", () => {
  // الثابت الأصل: `posList` يعيد `price` = الأصليّ و`promotionEffectivePrice` = بعد الخصم.
  // طباعة `price` وحده ⇒ الرفّ يقول ١٠٠٠ والكاشير يحصّل ٨٠٠ (خرق «نقطة العرض = نقطة الفرض»).
  it("عرضٌ سارٍ ⇒ المطبوع هو السعر الفعّال والأصليّ يُشطب", () => {
    expect(labelPrice({ price: "1000.00", promotionEffectivePrice: "800.00" }))
      .toEqual({ price: "800.00", basePrice: "1000.00" });
  });

  it("بلا عرض ⇒ سعر الفئة بلا سعرٍ مشطوب", () => {
    expect(labelPrice({ price: "1000.00", promotionEffectivePrice: null }))
      .toEqual({ price: "1000.00", basePrice: null });
  });

  // العرض المساوي للسعر ليس خصماً ⇒ شطبُ «١٠٠٠» بجانب «١٠٠٠» تشويشٌ محض على الزبون.
  it("سعر عرض مساوٍ للأصليّ ⇒ لا شطب", () => {
    expect(labelPrice({ price: "1000.00", promotionEffectivePrice: "1000.00" }))
      .toEqual({ price: "1000.00", basePrice: null });
  });

  it("سعر عرض فارغ نصّاً ⇒ يُعامَل كغياب عرض", () => {
    expect(labelPrice({ price: "1000.00", promotionEffectivePrice: "" }))
      .toEqual({ price: "1000.00", basePrice: null });
  });

  it("بلا سعرٍ للفئة أصلاً ⇒ null بلا انهيار", () => {
    expect(labelPrice({ price: null })).toEqual({ price: null, basePrice: null });
  });
});

describe("TIER_LABEL — شارة الفئة", () => {
  // المفرد هو سعر الرفّ الافتراضيّ ⇒ شارته ضجيجٌ على ملصق 50×25مم. الجملة/الحكومي **يجب**
  // أن تُوسَما وإلّا لم يُفرَّق ملصق العقد عن ملصق الرفّ عند التلصيق.
  it("المفرد بلا شارة، والجملة/الحكومي موسومان", () => {
    expect(TIER_LABEL.RETAIL).toBe("");
    expect(TIER_LABEL.WHOLESALE).toBe("جملة");
    expect(TIER_LABEL.GOVERNMENT).toBe("حكومي");
  });
});

describe("wrapTwoLines — توحيد لفّ الاسم بين الناقلين", () => {
  // الثابت الأصل: الراستر الحراريّ كان يقصّ سطراً واحداً بينما المعاينة/التصميم يلفّان سطرين
  // ⇒ اسمٌ مبتور على الطابعة الحرارية واسمٌ كامل في المعاينة (خرق WYSIWYG، §٥).
  it("نصّ يسع سطراً واحداً ⇒ سطر واحد", () => {
    expect(wrapTwoLines("قلم", 100, w10)).toEqual(["قلم"]);
  });

  it("نصّ أطول من سطر ⇒ يُكسر على الفراغ إلى سطرين", () => {
    // "قلم جاف أزرق" (١٢ حرفاً مع الفراغات) بعرض ٧٠: "قلم جاف"(٧) يسع، "قلم جاف أزرق"(١٢) لا.
    expect(wrapTwoLines("قلم جاف أزرق", 70, w10)).toEqual(["قلم جاف", "أزرق"]);
  });

  it("السطر الثاني الفائض يُقصّ بـ«…»", () => {
    const [l1, l2] = wrapTwoLines("منتج طويلجدا وصفمطول اضافي زائد", 60, w10);
    expect(l1).toBe("منتج");
    expect(l2.endsWith("…")).toBe(true);
    expect(w10(l2)).toBeLessThanOrEqual(60);
  });

  it("كلمة أولى أعرض من السطر ⇒ تُقصّ حرفياً على سطرين بلا انهيار", () => {
    const lines = wrapTwoLines("كلمةطويلةجدابلافراغات", 50, w10);
    expect(lines).toHaveLength(2);
    expect(w10(lines[0])).toBeLessThanOrEqual(50);
  });

  it("نصّ فارغ ⇒ لا أسطر", () => {
    expect(wrapTwoLines("   ", 100, w10)).toEqual([]);
  });
});

describe("ellipsize", () => {
  it("يُبقي النصّ كما هو إن اتّسع", () => {
    expect(ellipsize("قلم", 100, w10)).toBe("قلم");
  });
  it("يقصّ ويُلحق «…» إن فاض", () => {
    const s = ellipsize("قلمطويل", 40, w10);
    expect(s.endsWith("…")).toBe(true);
    expect(w10(s)).toBeLessThanOrEqual(40);
  });
});

describe("toLabelItem — التركيب الكامل", () => {
  it("يجمع الاسم المميّز + سعر العرض + الشارة + الباركود المختار", () => {
    expect(
      toLabelItem(
        {
          productName: "قلم جاف",
          color: "أزرق",
          size: null,
          unitName: "درزن",
          sku: "PEN-BLU",
          price: "1000.00",
          promotionEffectivePrice: "800.00",
        },
        "ALR0000042",
        "WHOLESALE",
      ),
    ).toEqual({
      name: "قلم جاف أزرق — درزن",
      sku: "PEN-BLU",
      price: "800.00",
      basePrice: "1000.00",
      tierLabel: "جملة",
      barcode: "ALR0000042",
    });
  });

  it("المفرد بلا عرض ⇒ بلا شارة وبلا سعرٍ مشطوب", () => {
    const item = toLabelItem(
      { productName: "ورق A4", unitName: "رزمة", sku: "PPR-A4", price: "12000.00" },
      "6212442744532",
      "RETAIL",
    );
    expect(item.tierLabel).toBe("");
    expect(item.basePrice).toBeNull();
    expect(item.price).toBe("12000.00");
  });

  // حالة حافّة أمسكتها المعاينة الحيّة: فئةٌ بلا سعرٍ معرَّف (لا سعر حكومي لهذا الصنف) ⇒
  // لا شارة «حكومي» على ملصقٍ بلا رقم (تشويشٌ لا تمييز).
  it("فئة جملة/حكومي بلا سعر ⇒ لا شارة", () => {
    const item = toLabelItem(
      { productName: "قلم", unitName: "قطعة", sku: "PEN", price: null },
      "ALR0000001",
      "GOVERNMENT",
    );
    expect(item.tierLabel).toBe("");
    expect(item.price).toBeNull();
  });
});
