/**
 * **إلزام سعر القائمة** — H7 (تدقيق ٢٧/٧)، قرار المالك ١٨/٨/٢٦.
 *
 * التقرير وصف العَرَض: «بندٌ تكلفته صفر يُباع بأيّ سعرٍ حتى الصفر». والجذرُ أعمق: بوّابتا
 * الانحراف (H6) تقيسان **نسبة** التنازل عن مرجع، فبندٌ بلا سعر قائمةٍ مقامُه صفر ⇒ ترجعان
 * `false` مهما كان السعر، وبوّابةُ تحت-التكلفة صامتةٌ عند `costPrice = 0`. النتيجة: بندٌ
 * **بلا حارسٍ إطلاقاً** — لا اعتماد ولا وسم تدقيق.
 *
 * عُرِض على المالك خياران: (أ) إلزام سعر قائمةٍ لكل صنفٍ يُباع، أو (ب) اعتبار «بلا مرجع»
 * موجِباً لموافقة مدير. **اختار (أ)**، فالإصلاح عند المنبع لا عند العَرَض.
 *
 * تُغطّي هذه الحزمة الطبقات الثلاث معاً — وهو المقصود: كلٌّ منها وحدها تترك ثغرة.
 *   ١) **بوّابة البيع** (النواة): لا سطر بلا مرجعٍ موجب، ولو حمل سعراً يدوياً.
 *   ٢) **المنبع** (محرّر المنتج): لا يُحفَظ صنفٌ نشطٌ بلا سعر مفرد لوحدته الأساس.
 *   ٣) **الكشف الرجعيّ** (العدسة L7): ما فسد قبل الحارس يُرى في تقريرٍ لا في طابور الكاشير.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { detectL7 } from "../catalogAnomalies/detectors";
import { assertBaseRetailPricePresent } from "../productEditService";
import { createPrintSale } from "../printSaleService";
import { createSale } from "../sale/create";
import { truncateTables } from "./__testUtils__";

const TABLES = [
  "idempotencyKeys",
  "accountingEntries",
  "receipts",
  "inventoryMovements",
  "invoiceItems",
  "invoices",
  "branchStock",
  "customerContractPrices",
  "productPrices",
  "productUnits",
  "productVariants",
  "products",
  "shifts",
  "customers",
  "branches",
  "users",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

const cashier = { userId: 1, branchId: 1, role: "cashier" } as const;

/**
 * أربعةُ أصناف تُغطّي محاور الحارس:
 *   ١ = مسعَّر (١٠٠٠) — خطُّ الأساس السليم.
 *   ٢ = **بلا صفّ سعرٍ إطلاقاً** — الحالة التي وصفها التدقيق.
 *   ٣ = **بصفّ سعرٍ قيمتُه صفر** — الحالة الأخطر: تبدو «مسعَّرة» وهي ليست كذلك (نمطُ العنصر
 *       النائب الذي تكتبه البطاقات الرقمية)، ولا تفرّق القسمةُ بينها وبين الغياب.
 *   ٤ = خدمةُ طباعةٍ بلا سعر — لإثبات أنّ القناة الثانية تحمل السياسة نفسها.
 */
async function seed() {
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values({ id: 1, openId: "c1", name: "كاشير", role: "cashier", loginMethod: "local", branchId: 1 });
  await d.insert(s.products).values([
    { id: 1, name: "دفتر" },
    { id: 2, name: "قلم بلا سعر" },
    { id: 3, name: "ممحاة بسعر صفر" },
    { id: 4, name: "خدمة تصميم", productType: "PRINT_SERVICE" },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "NB-1", costPrice: "100.00" },
    { id: 2, productId: 2, sku: "PEN-0", costPrice: "0.00" },
    { id: 3, productId: 3, sku: "ER-0", costPrice: "0.00" },
    { id: 4, productId: 4, sku: "DSG-0", costPrice: "0.00" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 2, variantId: 2, unitName: "حبة", conversionFactor: "1", isBaseUnit: true },
    { id: 3, variantId: 3, unitName: "حبة", conversionFactor: "1", isBaseUnit: true },
    { id: 4, variantId: 4, unitName: "تصميم", conversionFactor: "1", isBaseUnit: true },
  ]);
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "1000.00" },
    { productUnitId: 3, priceTier: "RETAIL", price: "0.00" },
  ]);
  await d.insert(s.customers).values({ id: 1, name: "عميل آجل", defaultPriceTier: "RETAIL", currentBalance: "0", creditLimit: "1000000" });
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 100 },
    { variantId: 2, branchId: 1, quantity: 100 },
    { variantId: 3, branchId: 1, quantity: 100 },
  ]);
  await d.insert(s.shifts).values([
    { id: 1, userId: 1, branchId: 1, status: "OPEN", shiftType: "RETAIL", openingBalance: "0", openGuard: "1:1:RETAIL" },
    { id: 2, userId: 1, branchId: 1, status: "OPEN", shiftType: "PRINT_SERVICES", openingBalance: "0", openGuard: "1:1:PRINT_SERVICES" },
  ]);
}

let req = 0;
const nextReq = () => `lpr-${++req}`;

function saleInput(over: Partial<Parameters<typeof createSale>[0]> = {}) {
  return {
    branchId: 1,
    shiftId: 1,
    sourceType: "ORDER" as const,
    customerId: 1,
    clientRequestId: nextReq(),
    lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
    ...over,
  } as Parameters<typeof createSale>[0];
}

beforeEach(async () => {
  await truncateTables(TABLES);
  await seed();
  req = 0;
});

describe("١) بوّابة البيع — لا بيعَ بلا مرجعٍ موجب", () => {
  it("بلا صفّ سعرٍ + سعرٌ يدويّ ⇒ رفضٌ (وكان يمرّ: `unitPriceOverride` يتخطّى `getUnitPrice`)", async () => {
    await expect(
      createSale(saleInput({ lines: [{ variantId: 2, productUnitId: 2, quantity: "1", unitPriceOverride: "1500.00" }] }), cashier),
    ).rejects.toThrow(/سعر قائمة/);
  });

  it("الرفضُ يسمّي الصنف والوحدة والفئة ويدلّ على موضع الإصلاح — لا رسالةٌ عمياء", async () => {
    // رسالةٌ عمياء توقف الكاشير أمام الزبون بلا مخرج؛ وهي بعينها ما عطّل ضابط مطابقة فاتورة
    // المورّد قبل #640 (امتنعت الشاشتان عن إرسال القيمة هرباً من «لا يطابق مجموع البنود»).
    const err = await createSale(
      saleInput({ lines: [{ variantId: 2, productUnitId: 2, quantity: "1", unitPriceOverride: "1500.00" }] }),
      cashier,
    ).catch((e: unknown) => e as Error);
    expect(err.message).toContain("قلم بلا سعر");
    expect(err.message).toContain("حبة");
    expect(err.message).toContain("مفرد");
    expect(err.message).toContain("المنتجات ← تعديل الصنف");
  });

  it("**صفٌّ بسعر صفر يُرفض كالغياب** — الصفر ليس سعراً أمام القسمة", async () => {
    await expect(
      createSale(saleInput({ lines: [{ variantId: 3, productUnitId: 3, quantity: "1", unitPriceOverride: "750.00" }] }), cashier),
    ).rejects.toThrow(/سعر قائمة/);
  });

  it("وبلا سعرٍ يدويّ أيضاً ⇒ رفض (السلوك القديم محفوظ، بالرسالة الجديدة)", async () => {
    await expect(
      createSale(saleInput({ lines: [{ variantId: 2, productUnitId: 2, quantity: "1" }] }), cashier),
    ).rejects.toThrow(/سعر قائمة/);
  });

  it("الصنف المسعَّر يمرّ كما كان — الحارس لا يمسّ المسار السليم", async () => {
    const res = await createSale(saleInput(), cashier);
    expect(res.invoiceId).toBeGreaterThan(0);
  });

  it("سعرُ عقدٍ للعميل مرجعٌ كافٍ ولو غاب سعر القائمة (العقد مستندٌ صريح لا غياب)", async () => {
    await db().insert(s.customerContractPrices).values({ customerId: 1, productUnitId: 2, price: "900.00" });
    const res = await createSale(
      saleInput({ lines: [{ variantId: 2, productUnitId: 2, quantity: "1", unitPriceOverride: "900.00" }] }),
      cashier,
    );
    expect(res.invoiceId).toBeGreaterThan(0);
  });

  it("مرجعٌ خادميّ مفروض (نمط البطاقات الرقمية) يمرّ — ولا يُقبَل من أيّ راوتر", async () => {
    // العرضُ الرقميّ يكتب صفّاً نائباً بصفرٍ عمداً وسعرُه الحقيقيّ في جداول تسعيره؛ بلا هذا
    // المنفذ كان بيعُ البطاقات كلّه يسقط على الحارس بحجّةٍ كاذبة. والحقلُ داخليٌّ بحت
    // (`unitPriceReference` ليس في مخطّط أيّ راوتر — نفس نمط `unitCostOverride`).
    const res = await createSale(
      saleInput({
        lines: [{ variantId: 3, productUnitId: 3, quantity: "1", unitPriceOverride: "5000.00", unitPriceReference: "5000.00" }],
      }),
      cashier,
    );
    expect(res.invoiceId).toBeGreaterThan(0);
    // الانحرافُ صفرٌ (بيعٌ بالمرجع نفسه) ⇒ لا بوّابةَ تُزعج بلا سبب.
    expect(res.priceOverride).toBe(false);
  });

  it("والمرجعُ الخادميّ يبقى **مقياساً**: بيعٌ تحته بكثيرٍ يُمسَك", async () => {
    await expect(
      createSale(
        saleInput({
          lines: [{ variantId: 3, productUnitId: 3, quantity: "1", unitPriceOverride: "100.00", unitPriceReference: "5000.00" }],
        }),
        cashier,
      ),
    ).rejects.toThrow(/موافقة مدير/);
  });

  it("قناة الطباعة تحمل السياسة نفسها (لا تنجرف سياسةُ قناتين على نفس القرار الماليّ)", async () => {
    await expect(
      createPrintSale(
        {
          branchId: 1,
          shiftId: 2,
          clientRequestId: nextReq(),
          lines: [{ variantId: 4, productUnitId: 4, quantity: "1", unitPriceOverride: "25000.00" }],
          payment: { amount: "25000.00", method: "CASH" },
        } as Parameters<typeof createPrintSale>[0],
        cashier,
      ),
    ).rejects.toThrow(/سعر قائمة/);
  });
});

describe("٢) المنبع — محرّر المنتج لا يُنشئ الحالة الفاسدة", () => {
  const tpl = (retail: string) => [
    { unitName: "حبة", conversionFactor: "1", isBaseUnit: true, prices: retail ? [{ priceTier: "RETAIL" as const, price: retail }] : [] },
  ];
  const variant = (over: Record<string, unknown> = {}) => ({ sku: "SKU-1", costPrice: "100", unitBarcodes: {}, ...over });

  it("سعرُ أساسٍ فارغ ⇒ رفضُ الحفظ (كان `if (price.trim())` يتخطّاه بصمت)", () => {
    expect(() =>
      assertBaseRetailPricePresent({ unitTemplate: tpl(""), variants: [variant()], isActive: true }, null),
    ).toThrow(/سعر مفرد/);
  });

  it("سعرُ أساسٍ صفر ⇒ رفضٌ كذلك (نفس معيار البيع، قاموسٌ واحد)", () => {
    expect(() =>
      assertBaseRetailPricePresent({ unitTemplate: tpl("0"), variants: [variant()], isActive: true }, null),
    ).toThrow(/سعر مفرد/);
  });

  it("سعرُ القالب الموجب يكفي — والتجاوزُ الخاصّ بالمتغيّر يكفي وحده أيضاً", () => {
    expect(() =>
      assertBaseRetailPricePresent({ unitTemplate: tpl("500"), variants: [variant()], isActive: true }, null),
    ).not.toThrow();
    expect(() =>
      assertBaseRetailPricePresent({ unitTemplate: tpl(""), variants: [variant({ baseRetail: "750" })], isActive: true }, null),
    ).not.toThrow();
  });

  it("الرسالة تسمّي المتغيّر المخالف بعينه لا «أحد المتغيّرات»", () => {
    const err = (() => {
      try {
        assertBaseRetailPricePresent(
          { unitTemplate: tpl("500"), variants: [variant(), variant({ sku: "SKU-2", baseRetail: "0" })], isActive: true },
          null,
        );
        return null;
      } catch (e) { return e as Error; }
    })();
    // ملاحظة: `baseRetail = "0"` تجاوزٌ صريحٌ بصفر ⇒ يسقط رغم صلاح سعر القالب.
    expect(err?.message).toContain("SKU-2");
    expect(err?.message).not.toContain("SKU-1");
  });

  it("المنتج المعطَّل والمتغيّر المعطَّل يُستثنيان — ما لا يُباع لا يلزمه سعر", () => {
    expect(() =>
      assertBaseRetailPricePresent({ unitTemplate: tpl(""), variants: [variant()], isActive: false }, null),
    ).not.toThrow();
    expect(() =>
      assertBaseRetailPricePresent({ unitTemplate: tpl(""), variants: [variant({ isActive: false })], isActive: true }, null),
    ).not.toThrow();
  });

  it("البطاقات الرقمية مستثناة — سعرُها في جداول تسعيرها لا في productPrices", () => {
    expect(() =>
      assertBaseRetailPricePresent({ unitTemplate: tpl(""), variants: [variant()], isActive: true }, "DIGITAL_CARD"),
    ).not.toThrow();
  });
});

describe("٣) العدسة L7 — ما فسد قبل الحارس يُرى في تقرير لا في طابور الكاشير", () => {
  it("تمسك الغائب والصفريّ معاً، وتترك المسعَّر", async () => {
    const found = await detectL7(db() as never);
    const skus = found.map((f) => f.sku).sort();
    expect(skus).toContain("PEN-0"); // بلا صفّ سعر
    expect(skus).toContain("ER-0"); // صفٌّ بصفر
    expect(skus).not.toContain("NB-1"); // مسعَّر
    expect(found.every((f) => f.code === "L7" && f.severity === "blocker")).toBe(true);
  });

  it("الملحوظة تذكر الوحدة وعدد البيعات السابقة (حجم الخطر لا وجودُه فقط)", async () => {
    const pen = (await detectL7(db() as never)).find((f) => f.sku === "PEN-0")!;
    expect(pen.note).toContain("حبة");
    expect(pen.note).toContain("لم يُبع بعد");
    expect(pen.metrics.unitName).toBe("حبة");
  });

  it("تستثني البطاقات الرقمية والمعطَّل — وإلّا امتلأ التقرير بضجيجٍ مشروع", async () => {
    const d = db();
    await d.insert(s.products).values([
      { id: 5, name: "بطاقة شحن", productType: "DIGITAL_CARD" },
      { id: 6, name: "صنفٌ معطَّل", isActive: false },
    ]);
    await d.insert(s.productVariants).values([
      { id: 5, productId: 5, sku: "DC-5", costPrice: "0" },
      { id: 6, productId: 6, sku: "OFF-6", costPrice: "0" },
    ]);
    await d.insert(s.productUnits).values([
      { id: 5, variantId: 5, unitName: "بطاقة", conversionFactor: "1", isBaseUnit: true },
      { id: 6, variantId: 6, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    ]);
    await d.insert(s.productPrices).values({ productUnitId: 5, priceTier: "RETAIL", price: "0.00" });
    const skus = (await detectL7(db() as never)).map((f) => f.sku);
    expect(skus).not.toContain("DC-5");
    expect(skus).not.toContain("OFF-6");
  });

  it("تُرتّب الأكثر بيعاً أولاً — الأولوية لما ينزف فعلاً", async () => {
    const d = db();
    await d.insert(s.invoices).values({ id: 1, invoiceNumber: "T-1", branchId: 1, createdBy: 1, subtotal: "0", total: "0", status: "PAID" });
    await d.insert(s.invoiceItems).values(
      [1, 2, 3].map((i) => ({ id: i, invoiceId: 1, variantId: 3, productUnitId: 3, quantity: "1", baseQuantity: 1, unitPrice: "0", unitCost: "0", total: "0" })),
    );
    const found = await detectL7(db() as never);
    expect(found[0]?.sku).toBe("ER-0");
    expect(found[0]?.note).toContain("3 بيعة");
  });
});

describe("سلامة الفهرسة — العدسة لا تُبطئ التقرير", () => {
  it("استعلام L7 يمرّ على قاعدةٍ فارغة بلا خطأ", async () => {
    await db().execute(sql`DELETE FROM productPrices`);
    await db().execute(sql`DELETE FROM productUnits`);
    const found = await detectL7(db() as never);
    expect(Array.isArray(found)).toBe(true);
  });
});

/**
 * حدُّ السياسة — **إلزامٌ واحدٌ لا ثلاثة**.
 *
 * أمسك هذا الحدَّ اختبارُ انحدارٍ قائم («السعر اليدوي يُستعمل مهما كانت الفئة»): صنفٌ مسعَّرٌ
 * بالمفرد يُباع لعميلٍ حكوميّ بسعرٍ يدويّ. صيغةٌ أولى من الحارس رفضته لأنّ فئته بلا سعر — وذلك
 * تشديدٌ لم يطلبه المالك: الصنف **له** سعر قائمة. فصار مرجعُ القياس يسقط على المفرد، مع بقاء
 * **التحصيل** بلا سقوطٍ بين الفئات (سعرُ مفردٍ يُحصَّل من عميل جملةٍ خطأٌ ماليّ).
 */
describe("حدُّ السياسة — سعرُ مفردٍ يكفي، والتحصيل لا يسقط بين الفئات", () => {
  it("فئةٌ بلا سعر + سعرٌ يدويّ ⇒ يمرّ (المفرد مرجعٌ كافٍ)", async () => {
    await db().update(s.customers).set({ defaultPriceTier: "GOVERNMENT" }).where(eq(s.customers.id, 1));
    const res = await createSale(
      saleInput({ lines: [{ variantId: 1, productUnitId: 1, quantity: "1", unitPriceOverride: "950.00" }] }),
      cashier,
    );
    expect(res.invoiceId).toBeGreaterThan(0);
  });

  it("والقياسُ يقع على المفرد فعلاً: بيعٌ تحته بأكثر من العتبة يُمسَك", async () => {
    await db().update(s.customers).set({ defaultPriceTier: "GOVERNMENT" }).where(eq(s.customers.id, 1));
    await expect(
      createSale(saleInput({ lines: [{ variantId: 1, productUnitId: 1, quantity: "1", unitPriceOverride: "500.00" }] }), cashier),
    ).rejects.toThrow(/موافقة مدير/);
  });

  it("بلا سعرٍ يدويّ وفئةٌ بلا سعر ⇒ يبقى مرفوضاً (لا تحصيلَ بسعر فئةٍ أخرى)", async () => {
    await db().update(s.customers).set({ defaultPriceTier: "GOVERNMENT" }).where(eq(s.customers.id, 1));
    await expect(
      createSale(saleInput({ lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }] }), cashier),
    ).rejects.toThrow(/لا يوجد سعر للوحدة/);
  });
});

/**
 * **استثناء التقاط الأوفلاين** — أمسكه CI لا التصميم، وهو أهمّ ما في الشريحة.
 *
 * ثلاثةُ اختباراتٍ في `offlineRecovery.test.ts` سقطت على الحارس: صنفٌ بلا سعرٍ يُرحَّل من طابور
 * الأوفلاين. والعلاجُ ليس ترقيع الثابتة (fixture) بل تصحيح السياسة: البيعُ **وقع فعلاً**
 * والنقدُ قُبض والزبون غادر. رفضُ الترحيل لا يُلغي البيعة — يترك نقداً مقبوضاً بلا فاتورةٍ ولا
 * قيد، وهو «دينارٌ بلا مسارٍ ولا تبويب» (§٥): أسوأُ بكثيرٍ من بيعةٍ بلا مرجع. ولا يكفي أنّ
 * الكاشير لا يبيع اليوم إلّا مسعَّراً — السعر قد يُمحى من المحرّر **بين** الالتقاط والترحيل.
 *
 * وهو الاستثناء نفسه الذي تحمله بوّابة H6 سلفاً (`manualGate && !input.offlineCapture`) —
 * فالسياستان متّسقتان: ما اكتمل يُوسَم للمراجعة لا يُحظر.
 */
describe("استثناء الأوفلاين — ما اكتمل يُوسَم لا يُحظر", () => {
  const offlineCapture = { capturedAt: new Date("2026-08-18T09:00:00Z"), offlineReceiptNumber: "OFF-1", deviceId: "dev-1" };

  it("ترحيلُ بيعٍ ملتقَطٍ لصنفٍ بلا سعر ⇒ يمرّ (لا يُحتجَز نقدٌ مقبوض)", async () => {
    const res = await createSale(
      saleInput({
        lines: [{ variantId: 2, productUnitId: 2, quantity: "1", unitPriceOverride: "1500.00" }],
        offlineCapture,
      }),
      cashier,
    );
    expect(res.invoiceId).toBeGreaterThan(0);
  });

  it("ويُوسَم `priceOverride` للمراجعة — المرورُ ليس تجاهلاً", async () => {
    const res = await createSale(
      saleInput({
        lines: [{ variantId: 2, productUnitId: 2, quantity: "1", unitPriceOverride: "1500.00" }],
        offlineCapture,
      }),
      cashier,
    );
    expect(res.priceOverride).toBe(true);
  });

  it("والاستثناءُ محصورٌ بالأوفلاين: نفسُ السطر أونلاين يُرفض", async () => {
    await expect(
      createSale(saleInput({ lines: [{ variantId: 2, productUnitId: 2, quantity: "1", unitPriceOverride: "1500.00" }] }), cashier),
    ).rejects.toThrow(/سعر قائمة/);
  });
});
