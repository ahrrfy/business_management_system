// اختبارات موجات تحديث الأسعار (٧/٧/٢٦، وُسّعت ٢٠/٨/٢٦): ثوابت الأمان W1..W7 + الأعطاب الثلاثة المُغلقة.
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";
import {
  applyPriceWave,
  countPriceWaveScope,
  previewPriceWave,
  listPriceWaves,
  getPriceUnitHistory,
  revertPriceWave,
  type PriceWaveFilters,
} from "../priceWaveService";
import { withTx } from "../tx";

const TABLES = [
  "priceChangeLog",
  "priceUpdateWaves",
  "promotionTargets",
  "promotions",
  "bundleComponents",
  "productPrices",
  "productUnits",
  "productVariants",
  "products",
  "auditLogs",
  "categories",
  "users",
  "branches",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function reset() {
  await truncateTables(TABLES);
}

/** نطاقٌ صريح مختصرٌ للاختبارات — W6 يفرض تمريره، والافتراضات الصامتة هي ما نُغلقه هنا. */
const ALL: PriceWaveFilters = { scope: "ALL" };
function filtered(f: Omit<PriceWaveFilters, "scope">): PriceWaveFilters {
  return { scope: "FILTERED", ...f };
}

/**
 * البذرة تُصمَّم لتُميت الأعطاب الثلاثة:
 *   • «قلم أزرق» بهمزة + وحدة **درزن** بمعامل ١٢ ⇒ يختبر التطبيع العربي وتكلفة الوحدة معاً.
 *   • SKU فيه `_` و`%` ⇒ يختبر تهريب LIKE.
 *   • باركود على وحدة ⇒ يختبر أنّ المسح يجد.
 *   • بكج بوصفة + بكج بلا وصفة ⇒ يختبران تكلفة البكج والسقوط المُعلَّل.
 *   • منتج معطَّل ⇒ يختبر أنّ الموجة لا تمسّه.
 */
async function seedBase() {
  const d = db();
  await d
    .insert(s.branches)
    .values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d
    .insert(s.users)
    .values({
      id: 1,
      openId: "local_test",
      name: "admin",
      role: "admin",
      loginMethod: "local",
    });
  await d.insert(s.categories).values([
    { id: 1, name: "قرطاسية" },
    { id: 2, name: "هدايا" },
    { id: 3, name: "أقلام", parentId: 1 },
  ]);
  await d.insert(s.products).values([
    { id: 1, name: "قلم أزرق", categoryId: 3 },
    { id: 2, name: "دفتر ٥٠", categoryId: 1 },
    { id: 3, name: "لعبة تخرّج", categoryId: 2 },
    { id: 4, name: "مكتبة خشبية", categoryId: 2 },
    { id: 5, name: "طقم هدايا", categoryId: 2, isBundle: true },
    { id: 6, name: "بكج بلا وصفة", categoryId: 2, isBundle: true },
    { id: 7, name: "صنف معطَّل", categoryId: 1, isActive: false },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "PEN-B", costPrice: "4.00" },
    { id: 2, productId: 2, sku: "NB_50", costPrice: "10.00" },
    { id: 3, productId: 3, sku: "TOY-1", costPrice: "20.00" },
    { id: 4, productId: 4, sku: "SHELF%A", costPrice: "100.00" },
    { id: 5, productId: 5, sku: "BDL-1", costPrice: "0" },
    { id: 6, productId: 6, sku: "BDL-2", costPrice: "0" },
    { id: 7, productId: 7, sku: "OFF-1", costPrice: "5.00" },
  ]);
  await d.insert(s.productUnits).values([
    {
      id: 1,
      variantId: 1,
      unitName: "قطعة",
      conversionFactor: "1",
      isBaseUnit: true,
      barcode: "6221000000017",
    },
    // ⭐ الوحدة التي كان الحارس أعمى عنها: تكلفة الدرزن = 4 × 12 = 48.
    {
      id: 2,
      variantId: 1,
      unitName: "درزن",
      conversionFactor: "12",
      isBaseUnit: false,
    },
    {
      id: 3,
      variantId: 2,
      unitName: "قطعة",
      conversionFactor: "1",
      isBaseUnit: true,
    },
    {
      id: 4,
      variantId: 3,
      unitName: "قطعة",
      conversionFactor: "1",
      isBaseUnit: true,
    },
    {
      id: 5,
      variantId: 4,
      unitName: "قطعة",
      conversionFactor: "1",
      isBaseUnit: true,
    },
    {
      id: 6,
      variantId: 5,
      unitName: "طقم",
      conversionFactor: "1",
      isBaseUnit: true,
    },
    {
      id: 7,
      variantId: 6,
      unitName: "طقم",
      conversionFactor: "1",
      isBaseUnit: true,
    },
    {
      id: 8,
      variantId: 7,
      unitName: "قطعة",
      conversionFactor: "1",
      isBaseUnit: true,
    },
  ]);
  // وصفة البكج: قلمان (تكلفة 4 لكلٍّ) + دفتر (10) ⇒ تكلفة الطقم الحقيقية 18، لا صفر.
  await d.insert(s.bundleComponents).values([
    {
      bundleVariantId: 5,
      componentVariantId: 1,
      componentBaseQuantity: 2,
      sortOrder: 0,
    },
    {
      bundleVariantId: 5,
      componentVariantId: 2,
      componentBaseQuantity: 1,
      sortOrder: 1,
    },
  ]);
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "10.00" },
    { productUnitId: 1, priceTier: "WHOLESALE", price: "8.00" },
    { productUnitId: 2, priceTier: "RETAIL", price: "100.00" },
    { productUnitId: 3, priceTier: "RETAIL", price: "20.00" },
    { productUnitId: 3, priceTier: "WHOLESALE", price: "16.00" },
    { productUnitId: 4, priceTier: "RETAIL", price: "50.00" },
    { productUnitId: 5, priceTier: "RETAIL", price: "400.00" },
    { productUnitId: 6, priceTier: "RETAIL", price: "30.00" },
    { productUnitId: 7, priceTier: "RETAIL", price: "25.00" },
    { productUnitId: 8, priceTier: "RETAIL", price: "9.00" },
  ]);
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

const RULE = {
  changeType: "INCREASE_PERCENT" as const,
  changeValue: "10",
  roundToDenom: 0,
};

// ════════════════════ ع١ — البحث ════════════════════
describe("ع١ — البحث يفلتر فعلاً (تطبيع عربي + تهريب LIKE + باركود + كلمات)", () => {
  async function search(q: string) {
    const { rows } = await withTx((tx) =>
      previewPriceWave(tx, {
        filters: filtered({ productSearch: q }),
        ...RULE,
      }),
    );
    return rows;
  }

  it("«ازرق» بلا همزة تجد «قلم أزرق» (كان LIKE الخامّ يفشل)", async () => {
    const rows = await search("ازرق");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.productName === "قلم أزرق")).toBe(true);
  });

  it("«مكتبه» بالهاء تجد «مكتبة خشبية»", async () => {
    const rows = await search("مكتبه");
    expect(rows.map((r) => r.productName)).toContain("مكتبة خشبية");
  });

  it("الأرقام اللاتينية تجد الهندية: «50» تجد «دفتر ٥٠»", async () => {
    const rows = await search("50");
    expect(rows.map((r) => r.productName)).toContain("دفتر ٥٠");
  });

  it("كلمتان متباعدتان: «قلم ازرق» تجد «قلم أزرق»", async () => {
    const rows = await search("قلم ازرق");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.productName === "قلم أزرق")).toBe(true);
  });

  it("⭐ حرفٌ واحد **يفلتر** ولا يُرجع الكتالوج كلّه (الجذر: إسقاطٌ صامت لِما دون حرفين)", async () => {
    const all = await withTx((tx) =>
      previewPriceWave(tx, { filters: ALL, ...RULE }),
    );
    const one = await search("ق");
    expect(all.rows.length).toBeGreaterThan(one.length);
    expect(one.length).toBeGreaterThan(0);
  });

  it("مصطلح لا يطابق شيئاً ⇒ صفر صفوف (لا سقوطٌ إلى «الكل»)", async () => {
    expect((await search("زززقق غير موجود")).length).toBe(0);
  });

  it("`_` في SKU لا يعمل كحرف بدل: «NB_50» تجد صنفها، و«NBX50» لا تجد شيئاً", async () => {
    expect((await search("NB_50")).length).toBeGreaterThan(0);
    expect((await search("NBX50")).length).toBe(0);
  });

  it("`%` في SKU لا يعمل كحرف بدل", async () => {
    const hit = await search("SHELF%A");
    expect(hit.map((r) => r.sku)).toContain("SHELF%A");
    expect((await search("SHELF%Z")).length).toBe(0);
  });

  it("الباركود قابلٌ للبحث (المستعمل يمسح بالقارئ)", async () => {
    const rows = await search("6221000000017");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.productName === "قلم أزرق")).toBe(true);
  });

  it("الفئة تشمل أقسامها الفرعية: «قرطاسية» تلتقط منتج قسم «أقلام»", async () => {
    const { rows } = await withTx((tx) =>
      previewPriceWave(tx, { filters: filtered({ categoryId: 1 }), ...RULE }),
    );
    expect(rows.map((r) => r.productName)).toContain("قلم أزرق");
    expect(rows.map((r) => r.productName)).toContain("دفتر ٥٠");
  });

  it("المنتج المعطَّل خارج الموجة دائماً", async () => {
    const { rows } = await withTx((tx) =>
      previewPriceWave(tx, { filters: ALL, ...RULE }),
    );
    expect(rows.some((r) => r.sku === "OFF-1")).toBe(false);
  });
});

// ════════════════════ W6 — النطاق ════════════════════
describe("W6 — النطاق قرارٌ صريح لا نتيجةُ فلترٍ فارغ", () => {
  it("FILTERED بلا أيّ فلتر ⇒ يُرَدّ (لا يعني «الكل» ضمناً)", async () => {
    await expect(
      withTx((tx) =>
        previewPriceWave(tx, { filters: { scope: "FILTERED" }, ...RULE }),
      ),
    ).rejects.toThrow(/لم تحدّد أيّ فلتر/);
  });

  it("ALL مع فلترٍ مصاحب ⇒ يُرَدّ (تناقضٌ يُربك قراءة المستند لاحقاً)", async () => {
    await expect(
      withTx((tx) =>
        previewPriceWave(tx, {
          filters: { scope: "ALL", productSearch: "قلم" },
          ...RULE,
        }),
      ),
    ).rejects.toThrow(/لا يقبل فلتر/);
  });

  it("SELECTED بلا منتجات ⇒ يُرَدّ؛ ومع منتجٍ واحد ⇒ صفوفه وحده", async () => {
    await expect(
      withTx((tx) =>
        previewPriceWave(tx, { filters: { scope: "SELECTED" }, ...RULE }),
      ),
    ).rejects.toThrow(/بلا أيّ منتج/);

    const { rows } = await withTx((tx) =>
      previewPriceWave(tx, {
        filters: { scope: "SELECTED", productIds: [1] },
        ...RULE,
      }),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.productId === 1)).toBe(true);
  });
});

// ════════════════════ ع٢ — تكلفة الوحدة ════════════════════
describe("ع٢ — تكلفة الوحدة = تكلفة الأساس × معامل التحويل", () => {
  it("⭐ الدرزن يُقارَن بتكلفة الدرزن لا بتكلفة القطعة", async () => {
    // درزن سعره 100 وتكلفة القطعة 4 ⇒ تكلفة الدرزن 48. تخفيضٌ 60٪ ⇒ 40 < 48 = تحت التكلفة.
    const { rows } = await withTx((tx) =>
      previewPriceWave(tx, {
        filters: { scope: "SELECTED", productIds: [1] },
        changeType: "DECREASE_PERCENT",
        changeValue: "60",
        roundToDenom: 0,
      }),
    );
    const dozen = rows.find((r) => r.productUnitId === 2)!;
    expect(dozen.unitCost).toBe("48.00");
    expect(dozen.newPrice).toBe("40.00");
    // قبل الإصلاح كانت المقارنة 40 < 4 ⇒ false، فيمرّ بيعٌ بخسارة ٨ دنانير للدرزن بلا أيّ إنذار.
    expect(dozen.belowCost).toBe(true);
  });

  it("SET_MARGIN على الدرزن يُشتقّ من تكلفة الدرزن", async () => {
    const { rows } = await withTx((tx) =>
      previewPriceWave(tx, {
        filters: { scope: "SELECTED", productIds: [1] },
        changeType: "SET_MARGIN",
        changeValue: "25",
        roundToDenom: 0,
      }),
    );
    // 48 × 1.25 = 60 (وليس 4 × 1.25 = 5 كما كان يحسب).
    expect(rows.find((r) => r.productUnitId === 2)!.newPrice).toBe("60.00");
    expect(
      rows.find((r) => r.productUnitId === 1 && r.priceTier === "RETAIL")!
        .newPrice,
    ).toBe("5.00");
  });

  it("الهامش قبل/بعد محسوبٌ بتكلفة الوحدة الصحيحة", async () => {
    const { rows } = await withTx((tx) =>
      previewPriceWave(tx, {
        filters: { scope: "SELECTED", productIds: [1] },
        ...RULE,
      }),
    );
    const dozen = rows.find((r) => r.productUnitId === 2)!;
    // 100 → 110، التكلفة 48 ⇒ الهامش من 52% إلى 56.4%.
    expect(dozen.oldMarginPct).toBe(52);
    expect(dozen.newMarginPct).toBe(56.4);
  });
});

// ════════════════════ ع٣ — البكجات ════════════════════
describe("ع٣ — البكج: تكلفةٌ من الوصفة لا هامشٌ ١٠٠٪ كاذب", () => {
  it("تكلفة البكج تُشتقّ من مكوّناته (2×4 + 1×10 = 18) لا من عموده الصفريّ", async () => {
    const { rows } = await withTx((tx) =>
      previewPriceWave(tx, {
        filters: { scope: "SELECTED", productIds: [5] },
        ...RULE,
      }),
    );
    const bundle = rows.find((r) => r.productUnitId === 6)!;
    expect(bundle.isBundle).toBe(true);
    expect(bundle.unitCost).toBe("18.00");
    // سعر الطقم 30 وتكلفته الحقيقية 18 ⇒ هامش 40٪. قبل الإصلاح: تكلفة 0 ⇒ «هامش 100٪».
    expect(bundle.oldMarginPct).toBe(40);
  });

  it("حارس «تحت التكلفة» يشتعل على البكج (كان مستحيلاً بتكلفةٍ صفرية)", async () => {
    const { rows } = await withTx((tx) =>
      previewPriceWave(tx, {
        filters: { scope: "SELECTED", productIds: [5] },
        changeType: "DECREASE_AMOUNT",
        changeValue: "15",
        roundToDenom: 0,
      }),
    );
    expect(rows.find((r) => r.productUnitId === 6)!.belowCost).toBe(true);
  });

  it("⭐ SET_MARGIN لا يتخطّى البكج بلا وصفة **بصمت** — يعود في skipped بسببه", async () => {
    const { rows, skipped } = await withTx((tx) =>
      previewPriceWave(tx, {
        filters: { scope: "SELECTED", productIds: [5, 6] },
        changeType: "SET_MARGIN",
        changeValue: "50",
        roundToDenom: 0,
      }),
    );
    // ذو الوصفة يُسعَّر: 18 × 1.5 = 27.
    expect(rows.find((r) => r.productUnitId === 6)!.newPrice).toBe("27.00");
    // وبلا وصفة: يظهر صراحةً بدل الاختفاء.
    const noRecipe = skipped.find((r) => r.productUnitId === 7)!;
    expect(noRecipe).toBeTruthy();
    expect(noRecipe.reason).toBe("BUNDLE_COST_UNRESOLVED");
  });
});

// ════════════════════ التقريب ════════════════════
describe("تقريب السعر الناتج (قرار المالك: أقرب ٢٥٠ في الواجهة)", () => {
  it("‎1,450 + ‎5٪ = ‎1,522.50 ⇒ ‎1,500 بتقريب ٢٥٠، ويُوسَم rounded", async () => {
    await db()
      .update(s.productPrices)
      .set({ price: "1450.00" })
      .where(
        and(
          eq(s.productPrices.productUnitId, 1),
          eq(s.productPrices.priceTier, "RETAIL"),
        ),
      );
    const { rows } = await withTx((tx) =>
      previewPriceWave(tx, {
        filters: { scope: "SELECTED", productIds: [1] },
        changeType: "INCREASE_PERCENT",
        changeValue: "5",
        roundToDenom: 250,
      }),
    );
    const r = rows.find(
      (x) => x.productUnitId === 1 && x.priceTier === "RETAIL",
    )!;
    expect(r.newPrice).toBe("1500.00");
    expect(r.rounded).toBe(true);
  });

  it("الخدمة لا تفترض تقريباً: بلا roundToDenom تبقى ‎1,522.50", async () => {
    await db()
      .update(s.productPrices)
      .set({ price: "1450.00" })
      .where(
        and(
          eq(s.productPrices.productUnitId, 1),
          eq(s.productPrices.priceTier, "RETAIL"),
        ),
      );
    const { rows } = await withTx((tx) =>
      previewPriceWave(tx, {
        filters: { scope: "SELECTED", productIds: [1] },
        changeType: "INCREASE_PERCENT",
        changeValue: "5",
      }),
    );
    expect(
      rows.find((x) => x.productUnitId === 1 && x.priceTier === "RETAIL")!
        .newPrice,
    ).toBe("1522.50");
  });
});

// ════════════════════ المعاينة العامّة ════════════════════
describe("previewPriceWave — قراءة فقط + منطق الحساب", () => {
  it("رفع بنسبة ١٠٪ على الجميع", async () => {
    const { rows } = await withTx((tx) =>
      previewPriceWave(tx, { filters: ALL, ...RULE }),
    );
    const pen = rows.find(
      (r) => r.productUnitId === 1 && r.priceTier === "RETAIL",
    )!;
    expect(pen.oldPrice).toBe("10.00");
    expect(pen.newPrice).toBe("11.00");
  });

  it("فلترة بفئة السعر: RETAIL فقط", async () => {
    const { rows } = await withTx((tx) =>
      previewPriceWave(tx, {
        filters: filtered({ priceTier: "RETAIL" }),
        ...RULE,
      }),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.priceTier === "RETAIL")).toBe(true);
  });

  it("W2: خفض بنسبة ٩٩٪ يقصّ السعر إلى 0.01 (لا صفر)", async () => {
    const { rows } = await withTx((tx) =>
      previewPriceWave(tx, {
        filters: filtered({ priceTier: "RETAIL" }),
        changeType: "DECREASE_PERCENT",
        changeValue: "99",
        roundToDenom: 0,
      }),
    );
    for (const r of rows)
      expect(Number(r.newPrice)).toBeGreaterThanOrEqual(0.01);
  });

  it("صفوف بلا تغيير فعلي تُستبعَد وتُعلَّل بـUNCHANGED", async () => {
    const { rows, skipped } = await withTx((tx) =>
      previewPriceWave(tx, {
        filters: ALL,
        changeType: "INCREASE_AMOUNT",
        changeValue: "0.001",
        roundToDenom: 0,
      }),
    );
    expect(rows.length).toBe(0);
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped.every((r) => r.reason === "UNCHANGED")).toBe(true);
  });

  it("قيمة صفر مرفوضة، وتخفيضٌ ١٠٠٪ مرفوض", async () => {
    await expect(
      withTx((tx) =>
        previewPriceWave(tx, {
          filters: ALL,
          changeType: "INCREASE_PERCENT",
          changeValue: "0",
        }),
      ),
    ).rejects.toThrow(/أكبر من صفر/);
    await expect(
      withTx((tx) =>
        previewPriceWave(tx, {
          filters: ALL,
          changeType: "DECREASE_PERCENT",
          changeValue: "100",
        }),
      ),
    ).rejects.toThrow(/يُفرّغ السعر/);
  });
});

// ════════════════════ عدّاد النطاق ════════════════════
describe("countPriceWaveScope — العدّاد الحيّ", () => {
  it("يعدّ المنتجات وصفوف الأسعار ويعطي عيّنةً بتكلفة وحدةٍ صحيحة", async () => {
    const res = await withTx((tx) =>
      countPriceWaveScope(tx, { scope: "SELECTED", productIds: [1] }),
    );
    expect(res.products).toBe(1);
    expect(res.priceRows).toBe(3); // قطعة×2 + درزن×1
    expect(res.sample?.unitCost).toBe("4.00");
  });

  it("العدّ يتبع البحث المطبَّع (لا يعود للكتالوج كلّه)", async () => {
    const all = await withTx((tx) => countPriceWaveScope(tx, ALL));
    const one = await withTx((tx) =>
      countPriceWaveScope(tx, filtered({ productSearch: "ازرق" })),
    );
    expect(one.priceRows).toBeGreaterThan(0);
    expect(one.priceRows).toBeLessThan(all.priceRows);
  });
});

// ════════════════════ التطبيق ════════════════════
describe("applyPriceWave — كتابة ذرّية + سجلّ", () => {
  const applyInput = {
    name: "رفع الدولار ٧/٧",
    description: "١٣٥٠ ⇒ ١٤٠٠",
    reason: "ارتفاع سعر الدولار",
    filters: ALL,
    ...RULE,
  };

  it("يحدّث productPrices + يُدرج priceChangeLog + يخزّن مستند النطاق", async () => {
    const before = await db().select().from(s.productPrices);
    const beforeMap = new Map(
      before.map((r) => [`${r.productUnitId}-${r.priceTier}`, String(r.price)]),
    );

    const res = await withTx((tx) => applyPriceWave(tx, applyInput, 1));
    expect(res.totalRows).toBeGreaterThan(0);

    const after = await db().select().from(s.productPrices);
    for (const r of after) {
      const oldP = beforeMap.get(`${r.productUnitId}-${r.priceTier}`)!;
      // الوحدة ٨ تعود لمنتجٍ معطَّل ⇒ خارج الموجة عمداً، فسعرها يبقى كما هو.
      const expected =
        Number(r.productUnitId) === 8
          ? Number(oldP).toFixed(2)
          : (Number(oldP) * 1.1).toFixed(2);
      expect(String(r.price)).toBe(expected);
    }

    const log = await db()
      .select()
      .from(s.priceChangeLog)
      .where(eq(s.priceChangeLog.waveId, res.waveId));
    expect(log.length).toBe(res.totalRows);
    for (const l of log) {
      expect(l.reason).toBe("ارتفاع سعر الدولار");
      expect(l.actorUserId).toBe(1);
      expect(l.oldPrice).not.toBeNull();
    }

    const [wave] = await db()
      .select()
      .from(s.priceUpdateWaves)
      .where(eq(s.priceUpdateWaves.id, res.waveId));
    expect(wave.name).toBe("رفع الدولار ٧/٧");
    expect(wave.changeType).toBe("INCREASE_PERCENT");
    const stored = JSON.parse(String(wave.filtersJson));
    expect(stored.v).toBe(2);
    expect(stored.scope).toBe("ALL");
  });

  it("W3: صفوف تحت التكلفة بلا إذن ⇒ FORBIDDEN + rollback كامل", async () => {
    await expect(
      withTx((tx) =>
        applyPriceWave(
          tx,
          {
            name: "تخفيض خطر",
            filters: { scope: "SELECTED", productIds: [1] },
            changeType: "DECREASE_AMOUNT",
            changeValue: "7",
            roundToDenom: 0,
          },
          1,
        ),
      ),
    ).rejects.toThrow(/تحت تكلفة وحدتها/);

    expect((await db().select().from(s.priceUpdateWaves)).length).toBe(0);
    expect((await db().select().from(s.priceChangeLog)).length).toBe(0);
    const pen = await db()
      .select()
      .from(s.productPrices)
      .where(
        and(
          eq(s.productPrices.productUnitId, 1),
          eq(s.productPrices.priceTier, "RETAIL"),
        ),
      );
    expect(String(pen[0].price)).toBe("10.00");
  });

  it("W3: مع allowBelowCost=true ⇒ يُطبَّق ويُسجَّل", async () => {
    const res = await withTx((tx) =>
      applyPriceWave(
        tx,
        {
          name: "تخفيض استثنائي",
          filters: { scope: "SELECTED", productIds: [1] },
          changeType: "DECREASE_AMOUNT",
          changeValue: "7",
          roundToDenom: 0,
          allowBelowCost: true,
        },
        1,
      ),
    );
    expect(res.totalRows).toBe(3);
    const pen = await db()
      .select()
      .from(s.productPrices)
      .where(
        and(
          eq(s.productPrices.productUnitId, 1),
          eq(s.productPrices.priceTier, "RETAIL"),
        ),
      );
    expect(String(pen[0].price)).toBe("3.00");
  });

  it("لا صفوف مطابقة ⇒ BAD_REQUEST، واسم فارغ مرفوض", async () => {
    await expect(
      withTx((tx) =>
        applyPriceWave(
          tx,
          {
            name: "موجة فارغة",
            filters: filtered({ productSearch: "لا يوجد xyz" }),
            ...RULE,
          },
          1,
        ),
      ),
    ).rejects.toThrow(/لا شيء/);
    await expect(
      withTx((tx) =>
        applyPriceWave(tx, { name: "", filters: ALL, ...RULE }, 1),
      ),
    ).rejects.toThrow(/اسم الموجة/);
  });

  // ── W7: البصمة ──
  it("⭐ W7: تطبيقٌ ببصمة قديمة ⇒ CONFLICT (ما سيُطبَّق ليس ما أقرّه المدير)", async () => {
    const pre = await withTx((tx) =>
      previewPriceWave(tx, { filters: ALL, ...RULE }),
    );
    // مديرٌ آخر يغيّر سعراً بين المعاينة والتطبيق.
    await db()
      .update(s.productPrices)
      .set({ price: "999.00" })
      .where(
        and(
          eq(s.productPrices.productUnitId, 1),
          eq(s.productPrices.priceTier, "RETAIL"),
        ),
      );

    await expect(
      withTx((tx) =>
        applyPriceWave(
          tx,
          {
            name: "موجة",
            filters: ALL,
            ...RULE,
            expectedFingerprint: pre.fingerprint,
          },
          1,
        ),
      ),
    ).rejects.toThrow(/تغيّرت الأسعار/);
  });

  it("⭐ W7 = حارس النقر المزدوج: التطبيق مرّتين ببصمةٍ واحدة ⇒ الثانية CONFLICT (لا ‎+21٪)", async () => {
    const pre = await withTx((tx) =>
      previewPriceWave(tx, { filters: ALL, ...RULE }),
    );
    await withTx((tx) =>
      applyPriceWave(
        tx,
        {
          name: "أولى",
          filters: ALL,
          ...RULE,
          expectedFingerprint: pre.fingerprint,
        },
        1,
      ),
    );

    await expect(
      withTx((tx) =>
        applyPriceWave(
          tx,
          {
            name: "مكرّرة",
            filters: ALL,
            ...RULE,
            expectedFingerprint: pre.fingerprint,
          },
          1,
        ),
      ),
    ).rejects.toThrow(/تغيّرت الأسعار/);

    const pen = await db()
      .select()
      .from(s.productPrices)
      .where(
        and(
          eq(s.productPrices.productUnitId, 1),
          eq(s.productPrices.priceTier, "RETAIL"),
        ),
      );
    expect(String(pen[0].price)).toBe("11.00"); // ‎+10٪ مرّةً واحدة، لا ‎12.10
  });

  it("بصمةٌ مطابقة ⇒ يمرّ", async () => {
    const pre = await withTx((tx) =>
      previewPriceWave(tx, { filters: ALL, ...RULE }),
    );
    const res = await withTx((tx) =>
      applyPriceWave(
        tx,
        {
          name: "مطابقة",
          filters: ALL,
          ...RULE,
          expectedFingerprint: pre.fingerprint,
        },
        1,
      ),
    );
    expect(res.totalRows).toBe(pre.rows.length);
  });

  // ── الاستثناء السطريّ ──
  it("الاستثناء السطريّ يُنقص الصفوف فعلاً ولا يمسّ الباقي", async () => {
    const pre = await withTx((tx) =>
      previewPriceWave(tx, { filters: ALL, ...RULE }),
    );
    const excluded = [{ productUnitId: 1, priceTier: "RETAIL" as const }];
    const res = await withTx((tx) =>
      applyPriceWave(
        tx,
        {
          name: "باستثناء",
          filters: ALL,
          ...RULE,
          expectedFingerprint: pre.fingerprint,
          excluded,
        },
        1,
      ),
    );

    expect(res.totalRows).toBe(pre.rows.length - 1);
    expect(res.excludedRows).toBe(1);
    const pen = await db()
      .select()
      .from(s.productPrices)
      .where(
        and(
          eq(s.productPrices.productUnitId, 1),
          eq(s.productPrices.priceTier, "RETAIL"),
        ),
      );
    expect(String(pen[0].price)).toBe("10.00"); // لم يتغيّر
    const dozen = await db()
      .select()
      .from(s.productPrices)
      .where(
        and(
          eq(s.productPrices.productUnitId, 2),
          eq(s.productPrices.priceTier, "RETAIL"),
        ),
      );
    expect(String(dozen[0].price)).toBe("110.00"); // تغيّر
  });

  it("زوجٌ مكرّر في قائمة الاستثناء لا يُنتج تعارضاً كاذباً (القياس على المجموعة لا على الطول)", async () => {
    const pre = await withTx((tx) =>
      previewPriceWave(tx, { filters: ALL, ...RULE }),
    );
    const dup = [
      { productUnitId: 1, priceTier: "RETAIL" as const },
      { productUnitId: 1, priceTier: "RETAIL" as const },
    ];
    const res = await withTx((tx) =>
      applyPriceWave(
        tx,
        {
          name: "استثناء مكرّر",
          filters: ALL,
          ...RULE,
          expectedFingerprint: pre.fingerprint,
          excluded: dup,
        },
        1,
      ),
    );
    expect(res.excludedRows).toBe(1);
    expect(res.totalRows).toBe(pre.rows.length - 1);
  });

  it("استثناء صفٍّ ليس ضمن النتيجة ⇒ CONFLICT (لا تجاهلٌ صامت)", async () => {
    await expect(
      withTx((tx) =>
        applyPriceWave(
          tx,
          {
            name: "استثناء شبح",
            filters: { scope: "SELECTED", productIds: [1] },
            ...RULE,
            excluded: [{ productUnitId: 4, priceTier: "RETAIL" }],
          },
          1,
        ),
      ),
    ).rejects.toThrow(/لم يعد ضمن نتيجة الموجة/);
  });
});

// ════════════════════ التراجع ════════════════════
describe("revertPriceWave — استعادةٌ دقيقة لا «موجة عكسية»", () => {
  async function applyWave(name = "موجة") {
    return withTx((tx) =>
      applyPriceWave(tx, { name, filters: ALL, ...RULE }, 1),
    );
  }

  it("⭐ يستعيد الأسعار السابقة بالضبط (عكس ‎+10٪ ليس ‎−10٪)", async () => {
    const before = new Map(
      (await db().select().from(s.productPrices)).map((r) => [
        `${r.productUnitId}-${r.priceTier}`,
        String(r.price),
      ]),
    );
    const wave = await applyWave();
    const rev = await withTx((tx) => revertPriceWave(tx, wave.waveId, 1));

    expect(rev.restoredRows).toBe(wave.totalRows);
    expect(rev.conflicts.length).toBe(0);
    for (const r of await db().select().from(s.productPrices)) {
      expect(String(r.price)).toBe(
        before.get(`${r.productUnitId}-${r.priceTier}`),
      );
    }
  });

  it("التراجع حدثٌ موثَّق: رأس REVERT مربوطٌ بالأصل + سجلٌّ لكل صفّ (لا محوَ تاريخ)", async () => {
    const wave = await applyWave();
    const rev = await withTx((tx) => revertPriceWave(tx, wave.waveId, 1));

    const [head] = await db()
      .select()
      .from(s.priceUpdateWaves)
      .where(eq(s.priceUpdateWaves.id, rev.waveId));
    expect(head.changeType).toBe("REVERT");
    expect(Number(head.revertsWaveId)).toBe(wave.waveId);
    expect(head.totalRows).toBe(rev.restoredRows);

    // سجلّ الموجة الأصلية باقٍ كما هو + سجلّ جديد للتراجع.
    expect(
      (
        await db()
          .select()
          .from(s.priceChangeLog)
          .where(eq(s.priceChangeLog.waveId, wave.waveId))
      ).length,
    ).toBe(wave.totalRows);
    expect(
      (
        await db()
          .select()
          .from(s.priceChangeLog)
          .where(eq(s.priceChangeLog.waveId, rev.waveId))
      ).length,
    ).toBe(rev.restoredRows);
  });

  it("صفٌّ تغيّر بعد الموجة ⇒ CONFLICT ولا يُلمَس أيّ صفّ (بلا force)", async () => {
    const wave = await applyWave();
    await db()
      .update(s.productPrices)
      .set({ price: "777.00" })
      .where(
        and(
          eq(s.productPrices.productUnitId, 1),
          eq(s.productPrices.priceTier, "RETAIL"),
        ),
      );

    await expect(
      withTx((tx) => revertPriceWave(tx, wave.waveId, 1)),
    ).rejects.toThrow(/تغيّر سعره بعد هذه الموجة/);

    const pen = await db()
      .select()
      .from(s.productPrices)
      .where(
        and(
          eq(s.productPrices.productUnitId, 1),
          eq(s.productPrices.priceTier, "RETAIL"),
        ),
      );
    expect(String(pen[0].price)).toBe("777.00"); // التغيير الأحدث محفوظ
    expect((await db().select().from(s.priceUpdateWaves)).length).toBe(1); // لا موجة تراجع
  });

  it("force ⇒ يستعيد غير المتعارض ويترك المتعارض ويُبلّغ عنه", async () => {
    const wave = await applyWave();
    await db()
      .update(s.productPrices)
      .set({ price: "777.00" })
      .where(
        and(
          eq(s.productPrices.productUnitId, 1),
          eq(s.productPrices.priceTier, "RETAIL"),
        ),
      );

    const rev = await withTx((tx) =>
      revertPriceWave(tx, wave.waveId, 1, { force: true }),
    );
    expect(rev.conflicts.length).toBe(1);
    expect(rev.restoredRows).toBe(wave.totalRows - 1);

    const pen = await db()
      .select()
      .from(s.productPrices)
      .where(
        and(
          eq(s.productPrices.productUnitId, 1),
          eq(s.productPrices.priceTier, "RETAIL"),
        ),
      );
    expect(String(pen[0].price)).toBe("777.00"); // المتعارض لم يُمَسّ
    const dozen = await db()
      .select()
      .from(s.productPrices)
      .where(
        and(
          eq(s.productPrices.productUnitId, 2),
          eq(s.productPrices.priceTier, "RETAIL"),
        ),
      );
    expect(String(dozen[0].price)).toBe("100.00"); // استُعيد
  });

  it("لا يُتراجَع عن موجةٍ مرّتين، ولا عن موجة تراجعٍ نفسها", async () => {
    const wave = await applyWave();
    const rev = await withTx((tx) => revertPriceWave(tx, wave.waveId, 1));

    await expect(
      withTx((tx) => revertPriceWave(tx, wave.waveId, 1)),
    ).rejects.toThrow(/سبق التراجع/);
    await expect(
      withTx((tx) => revertPriceWave(tx, rev.waveId, 1)),
    ).rejects.toThrow(/لا يُتراجَع عن موجة تراجع/);
  });

  it("موجةٌ غير موجودة ⇒ NOT_FOUND", async () => {
    await expect(withTx((tx) => revertPriceWave(tx, 9999, 1))).rejects.toThrow(
      /غير موجودة/,
    );
  });
});

describe("listPriceWaves + getPriceUnitHistory", () => {
  it("قائمة الموجات: الأحدث أوّلاً", async () => {
    await withTx((tx) =>
      applyPriceWave(tx, { name: "موجة ١", filters: ALL, ...RULE }, 1),
    );
    await withTx((tx) =>
      applyPriceWave(
        tx,
        {
          name: "موجة ٢",
          filters: ALL,
          changeType: "DECREASE_PERCENT",
          changeValue: "2",
          roundToDenom: 0,
        },
        1,
      ),
    );
    const rows = await withTx((tx) => listPriceWaves(tx));
    expect(rows.length).toBe(2);
    expect(rows[0].name).toBe("موجة ٢");
  });

  it("تاريخ سعر وحدة: يحصر السجلّ على productUnit واحد", async () => {
    await withTx((tx) =>
      applyPriceWave(tx, { name: "رفع", filters: ALL, ...RULE }, 1),
    );
    await withTx((tx) =>
      applyPriceWave(
        tx,
        {
          name: "خفض",
          filters: filtered({ productSearch: "قلم" }),
          changeType: "DECREASE_PERCENT",
          changeValue: "5",
          roundToDenom: 0,
        },
        1,
      ),
    );
    // القلم (وحدة ١) تأثّر بالموجتين ⇒ ٤ سجلات (RETAIL + WHOLESALE لكل موجة).
    expect((await withTx((tx) => getPriceUnitHistory(tx, 1))).length).toBe(4);
    // اللعبة تأثّرت بالموجة الأولى فقط.
    expect((await withTx((tx) => getPriceUnitHistory(tx, 4))).length).toBe(1);
  });
});
