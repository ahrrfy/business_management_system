// حراسة حلّال ملاءمة الملصق (٢١/٧). القاعدة القاطعة: **لا تختفي أيّ معلومة أساسية** —
// الاسم الكامل + الباركود + اللون + الوحدة + السعر تظهر دائماً؛ الوحيدان القابلان للإخفاء على
// المقاس الصغير جداً هما رقم الباركود المقروء والرمز (SKU) — ما لم يطلبه المالك.
import { describe, expect, it } from "vitest";
import { solveLabelLayout, labelContentOf, BAR_FLOOR_MM, type LabelContent, type LabelPart } from "./labelLayout";

/** محتوى صفٍّ نموذجيّ (اسم + سعر + رمز + شارة + باركود). التخطيط المنظّم مُطفأ افتراضياً. */
function content(over: Partial<LabelContent> = {}): LabelContent {
  return {
    name: "قلم جاف أزرق — درزن",
    hasAttrs: false,
    hasBarcode: true,
    hasPrice: true,
    hasBasePrice: false,
    hasSku: true,
    hasTier: true,
    ...over,
  };
}

describe("solveLabelLayout — المجموعة الإلزامية لا تختفي أبداً (قاعدة المالك)", () => {
  it("الاسم + السعر + الباركود ظاهرة على كلّ الارتفاعات المسموحة (١٥→٤٠مم)", () => {
    for (let h = 15; h <= 40; h++) {
      const L = solveLabelLayout(
        { widthMm: 38, heightMm: h },
        content({ name: "دفتر مدرسي مسطر ٢٠٠ ورقة غلاف مقوّى" }),
      );
      expect(L.name.show).toBe(true); // الاسم لا يختفي
      expect(L.bottom.showPrice).toBe(true); // **السعر لا يختفي** (كان يُسقَط — الإصلاح)
      expect(L.barcode.show).toBe(true); // الباركود لا يختفي
      expect(L.barcode.scannable).toBe(true); // ويبقى قابلاً للمسح (≥٥مم)
      expect(L.overflow).toBe(false);
    }
  });

  it("38×15 اسم طويل: السعر **يبقى** + الاسم كامل؛ يُخفى رقم الباركود/الرمز فقط، والخطّ صغير", () => {
    const L = solveLabelLayout(
      { widthMm: 38, heightMm: 15 },
      content({ name: "دفتر مدرسي مسطر ٢٠٠ ورقة غلاف مقوّى فاخر" }),
    );
    expect(L.name.show).toBe(true);
    expect(L.bottom.showPrice).toBe(true); // ← الإصلاح: السعر لم يعُد يختفي
    expect(L.barcode.scannable).toBe(true);
    expect(L.dropped).toContain("digits"); // الرقم المكرَّر (القضبان تُغني عنه)
    expect(L.tiny).toBe(true); // خطّ عند الأرضية الصلبة — مقروء لكن صغير
  });

  it("خيار «بلا سعر» صريحٌ من المستخدم ⇒ لا يُعرَض (ليس إخفاءً قسرياً)", () => {
    const L = solveLabelLayout({ widthMm: 38, heightMm: 15 }, content(), { price: false });
    expect(L.bottom.showPrice).toBe(false);
  });
});

describe("solveLabelLayout — الملصق الواسع (صفر انحدار)", () => {
  it("50×25مم يُظهر كلّ شيء بلا إخفاء ولا ضغط", () => {
    const L = solveLabelLayout({ widthMm: 50, heightMm: 25 }, content());
    expect(L.dropped).toEqual([]);
    expect(L.compressed).toBe(false);
    expect(L.tiny).toBe(false);
    expect(L.name.show).toBe(true);
    expect(L.digits.show).toBe(true);
    expect(L.bottom.showPrice).toBe(true);
    expect(L.bottom.showSku).toBe(true);
    expect(L.bottom.showTier).toBe(true);
    expect(L.barcode.scannable).toBe(true);
  });
});

describe("solveLabelLayout — إخفاء الثانويّات فقط، بالترتيب", () => {
  const ORDER: LabelPart[] = ["digits", "sku", "tier"];

  it("الإخفاء يتّبع الترتيب المعلَن (رقم الباركود ← الرمز ← الشارة)", () => {
    for (const heightMm of [15, 16, 18, 20, 22, 25]) {
      const L = solveLabelLayout({ widthMm: 38, heightMm }, content({ name: "منتج طويل الاسم نسبياً هنا" }));
      const idx = L.dropped.map((p) => ORDER.indexOf(p));
      expect(idx).toEqual([...idx].sort((a, b) => a - b));
    }
  });

  it("الباركود ديناميكيّ: يُبقي السعر مع الاسم الطويل حين يتّسع المقاس قليلاً (18مم، باركود متقلّص)", () => {
    const L = solveLabelLayout(
      { widthMm: 38, heightMm: 18 },
      content({ name: "دفتر مدرسي مسطر ٢٠٠ ورقة غلاف مقوّى فاخر", hasTier: false }),
    );
    expect(L.name.show).toBe(true);
    expect(L.bottom.showPrice).toBe(true);
    expect(L.barcode.scannable).toBe(true);
  });

  it("صنفٌ بلا رمزٍ ولا شارة ⇒ لا يظهران ولا يُعدّان مُخفيَّين", () => {
    const L = solveLabelLayout({ widthMm: 38, heightMm: 15 }, content({ name: "قلم", hasSku: false, hasTier: false }));
    expect(L.bottom.showSku).toBe(false);
    expect(L.bottom.showTier).toBe(false);
    expect(L.dropped).not.toContain("sku");
    expect(L.dropped).not.toContain("tier");
  });

  it("خيار «بلا اسم» ⇒ لا يُحجَز له ارتفاع", () => {
    const L = solveLabelLayout({ widthMm: 50, heightMm: 25 }, content(), { name: false });
    expect(L.name.show).toBe(false);
    expect(L.name.heightMm).toBe(0);
  });
});

describe("solveLabelLayout — التخطيط الاحترافي المنظّم (اسم أساس + سطر خصائص + رمز لون)", () => {
  it("مقاس مريح + خصائص ⇒ تخطيط منظّم يظهر", () => {
    const L = solveLabelLayout(
      { widthMm: 50, heightMm: 30 },
      content({ name: "قلم جاف أزرق L — درزن", baseName: "قلم جاف", hasAttrs: true }),
    );
    expect(L.name.structured).toBe(true);
    expect(L.attrs.show).toBe(true);
    expect(L.attrs.heightMm).toBeGreaterThan(0);
    expect(L.dropped).toEqual([]);
  });

  it("مقاس ضيّق (38×15) + خصائص ⇒ يتراجع للاسم المدموج (اللون/الوحدة فيه ⇒ لا تختفي معلومة)", () => {
    const L = solveLabelLayout(
      { widthMm: 38, heightMm: 15 },
      content({ name: "قلم أزرق L — درزن", baseName: "قلم", hasAttrs: true }),
    );
    expect(L.name.structured).toBe(false); // مدموج
    expect(L.attrs.show).toBe(false);
    expect(L.name.show).toBe(true); // الاسم (وفيه اللون/الوحدة) يبقى ظاهراً
    expect(L.bottom.showPrice).toBe(true);
  });

  it("minHeightMmForAll يقترح ارتفاعاً مريحاً؛ والحلّ عنده بلا إخفاء ولا ضغط", () => {
    const size = { widthMm: 38, heightMm: 15 };
    const c = content({ name: "دفتر مدرسي مسطر ٢٠٠ ورقة", baseName: "دفتر مدرسي", hasAttrs: true });
    const L = solveLabelLayout(size, c);
    expect(L.minHeightMmForAll).toBeGreaterThan(size.heightMm);
    const bigger = solveLabelLayout({ widthMm: 38, heightMm: L.minHeightMmForAll }, c);
    expect(bigger.dropped).toEqual([]);
    expect(bigger.tiny).toBe(false);
  });
});

describe("labelContentOf — اشتقاق التوفّر من عنصر الملصق", () => {
  it("يلتقط توفّر كلّ جزء بدقّة + hasAttrs/baseName", () => {
    expect(
      labelContentOf({ name: "قلم", sku: "PEN", price: "1000", basePrice: "1200", tierLabel: "جملة", barcode: "ALR1", attrs: { baseName: "قلم", tags: ["أزرق"], colorHex: "#1D4ED8", unitName: "درزن" } }),
    ).toEqual({
      name: "قلم",
      baseName: "قلم",
      hasAttrs: true,
      hasBarcode: true,
      hasPrice: true,
      hasBasePrice: true,
      hasSku: true,
      hasTier: true,
    });
  });

  it("hasAttrs=false لصنفٍ بلا لون/قياس وبلا لونٍ معرَّف (سلعة بسيطة)", () => {
    const c = labelContentOf({ barcode: "ALR1", attrs: { baseName: "دفتر", tags: [], colorHex: null, unitName: "قطعة" } });
    expect(c.hasAttrs).toBe(false);
  });

  it("القيم الفارغة/الغائبة ⇒ غير متوفّرة", () => {
    const c = labelContentOf({ price: "", basePrice: null, tierLabel: "", barcode: "ALR2" });
    expect(c.hasPrice).toBe(false);
    expect(c.hasTier).toBe(false);
    expect(c.hasSku).toBe(false);
  });
});
