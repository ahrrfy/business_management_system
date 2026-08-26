/**
 * listPickerVariants — منتقي MANUAL في معالج إنشاء الجرد.
 *
 * سبب هذا الحارس: بلاغ المالك ٢٤/٨/٢٦ — منتجات يعرضها الكاشير «مخزون 0» (مثال:
 * «ظرف ابيض 110×220 COLDEN 8S8643P-AA1») لا تظهر في اختيار الجرد فلا يستطيع المستخدم
 * تصحيح رصيدها. الجذر: منتقي MANUAL كان يقرأ `inventory.onHand` (INNER JOIN من `branchStock`)
 * فيُخفي كل متغيّر لم يملك صفّ رصيدٍ للفرع. `listPickerVariants` تعالج ذلك بـLEFT JOIN.
 *
 * أيّ انحدارٍ يعيد بدء الاستعلام من `branchStock` بـINNER JOIN يجب أن يُسقط الحالة الأولى.
 */
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { listPickerVariants } from "../stocktake/queries";

const TABLES = [
  "stocktakeItems",
  "stocktakeAssignments",
  "stocktakeSessions",
  "branchStock",
  "productUnitBarcodes",
  "productUnits",
  "productVariants",
  "products",
  "categories",
  "branches",
  "users",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "u_admin", name: "المدير", role: "admin", loginMethod: "local" },
  ]);
  await d.insert(s.categories).values([{ id: 10, name: "قرطاسية" }]);
  await d.insert(s.products).values([
    // منتج «بلاغ المالك» — بلا صفّ branchStock للفرع ١ (لم تُلامَسه حركةٌ بعد)
    {
      id: 1,
      name: "ظرف ابيض 110×220 COLDEN 8S8643P-AA1",
      categoryId: 10,
      isActive: true,
      isBundle: false,
      isConsignment: false,
    },
    // منتج له صفّ رصيدٍ للفرع ١
    { id: 2, name: "قلم جاف أزرق", categoryId: 10, isActive: true, isBundle: false, isConsignment: false },
    // منتج غير نشط ⇒ يُستبعَد
    { id: 3, name: "منتج معطَّل", categoryId: 10, isActive: false, isBundle: false, isConsignment: false },
    // بكج ⇒ يُستبعَد (يُجرَد عبر مكوّناته)
    { id: 4, name: "بكج مدرسي", categoryId: 10, isActive: true, isBundle: true, isConsignment: false },
    // خدمة ⇒ يُستبعَد (بلا رصيد مادّي)
    {
      id: 5,
      name: "كارت زين 5000",
      categoryId: 10,
      isActive: true,
      isService: true,
      isBundle: false,
      isConsignment: false,
    },
  ]);
  await d.insert(s.productVariants).values([
    { id: 100, productId: 1, sku: "ENV-COLDEN-110", costPrice: "500.00", isActive: true },
    { id: 200, productId: 2, sku: "PEN-BLU", costPrice: "250.00", isActive: true },
    { id: 300, productId: 3, sku: "OLD-1", costPrice: "100.00", isActive: true },
    { id: 400, productId: 4, sku: "PKG-1", costPrice: "0.00", isActive: true },
    { id: 500, productId: 5, sku: "DIG-ZAIN-5000", costPrice: "0.00", isActive: true },
    // متغيّر غير نشط لمنتج نشط ⇒ يُستبعَد
    { id: 201, productId: 2, sku: "PEN-BLU-OLD", costPrice: "250.00", isActive: false },
  ]);
  await d.insert(s.productUnits).values([
    {
      id: 1000,
      variantId: 100,
      unitName: "قطعة",
      conversionFactor: "1",
      isBaseUnit: true,
      barcode: "6290000000100",
    },
    {
      id: 1002,
      variantId: 100,
      unitName: "حزمة",
      conversionFactor: "10",
      isBaseUnit: false,
      barcode: "LOT 2026 A",
    },
  ]);
  await d.insert(s.productUnitBarcodes).values([
    { id: 1001, productUnitId: 1000, barcode: "6290000000199" },
    { id: 1003, productUnitId: 1002, barcode: "ALT LOT 2026 A" },
  ]);

  // صفّ رصيدٍ للقلم في الفرع ١ فقط. الظرف بلا صفٍّ في أيّ فرع.
  await d.insert(s.branchStock).values([{ branchId: 1, variantId: 200, quantity: 12 }]);
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("listPickerVariants — بلاغ المالك ٢٤/٨: المنتج بلا صفّ branchStock يظهر", () => {
  it("يُظهر المنتج الذي لا صفّ رصيدٍ له للفرع (رصيد 0) — الحالة الأصلية للبلاغ", async () => {
    const rows = await listPickerVariants({ branchId: 1 });
    const envelope = rows.find((r) => r.sku === "ENV-COLDEN-110");
    expect(envelope).toBeDefined();
    expect(envelope?.productName).toBe("ظرف ابيض 110×220 COLDEN 8S8643P-AA1");
    expect(envelope?.quantity).toBe(0); // لا صفّ ⇒ 0 عبر LEFT JOIN
    expect(envelope?.lastCountedAt).toBeNull();
  });

  it("يُظهر المنتج ذا صفّ الرصيد بكميّته الفعليّة", async () => {
    const rows = await listPickerVariants({ branchId: 1 });
    const pen = rows.find((r) => r.sku === "PEN-BLU");
    expect(pen?.quantity).toBe(12);
  });

  it("يستبعد: المنتج غير النشط + المتغيّر غير النشط + البكج + الخدمة", async () => {
    const rows = await listPickerVariants({ branchId: 1 });
    const skus = rows.map((r) => r.sku);
    expect(skus).not.toContain("OLD-1"); // منتج غير نشط
    expect(skus).not.toContain("PEN-BLU-OLD"); // متغيّر غير نشط
    expect(skus).not.toContain("PKG-1"); // بكج
    expect(skus).not.toContain("DIG-ZAIN-5000"); // خدمة
    // الظاهر: الظرف + القلم فقط
    expect(skus.sort()).toEqual(["ENV-COLDEN-110", "PEN-BLU"]);
  });

  it("البحث بالنصّ يطابق اسم المنتج/SKU/اسم المتغيّر", async () => {
    // البحث باسم المنتج جزئياً (عربي)
    const byName = await listPickerVariants({ branchId: 1, q: "ظرف" });
    expect(byName.map((r) => r.sku)).toEqual(["ENV-COLDEN-110"]);

    // بجزءٍ من SKU
    const bySku = await listPickerVariants({ branchId: 1, q: "COLDEN" });
    expect(bySku.map((r) => r.sku)).toEqual(["ENV-COLDEN-110"]);

    // بلا مطابقة
    const noMatch = await listPickerVariants({ branchId: 1, q: "لا يوجد" });
    expect(noMatch).toEqual([]);
  });

  it("يعثر على الصنف بأي باركود أساسي أو بديل حتى مع حدّ صفحة ضيّق", async () => {
    // مشتّت يطابق LIKE في الاسم ويرتّب قبل المالك: التطابق التام للباركود يجب أن يحصر النتيجة
    // في مالكه، لا أن يدفنه ترتيب الاسم خلف صفٍّ عَرَضيّ.
    await db().insert(s.products).values({
      id: 6,
      name: "000 6290000000100 6290000000199 LOT 2026 A ALT LOT 2026 A",
      categoryId: 10,
      isActive: true,
      isBundle: false,
      isConsignment: false,
    });
    await db().insert(s.productVariants).values({
      id: 600,
      productId: 6,
      sku: "DISTRACTOR",
      costPrice: "0.00",
      isActive: true,
    });

    const byPrimary = await listPickerVariants({ branchId: 1, q: "6290000000100", limit: 1 });
    const byAlias = await listPickerVariants({ branchId: 1, q: "6290000000199", limit: 1 });
    const bySpacedPrimary = await listPickerVariants({ branchId: 1, q: "LOT 2026 A", limit: 1 });
    const bySpacedAlias = await listPickerVariants({ branchId: 1, q: "ALT LOT 2026 A", limit: 1 });

    expect(byPrimary.map((r) => r.variantId)).toEqual([100]);
    expect(byAlias.map((r) => r.variantId)).toEqual([100]);
    expect(bySpacedPrimary.map((r) => r.variantId)).toEqual([100]);
    expect(bySpacedAlias.map((r) => r.variantId)).toEqual([100]);
    expect(byPrimary[0]?.quantity).toBe(0);
    expect(byAlias[0]?.quantity).toBe(0);
  });

  it("يعطي الشكل الخام أولوية ذرّية عند تصادم التطبيع في الأساسي والبديل", async () => {
    await db().insert(s.products).values([
      { id: 9, name: "مالك الأساسي العربي", categoryId: 10 },
      { id: 10, name: "مالك البديل اللاتيني", categoryId: 10 },
      { id: 11, name: "مالك البديل العربي", categoryId: 10 },
      { id: 12, name: "مالك الأساسي اللاتيني", categoryId: 10 },
    ]);
    await db().insert(s.productVariants).values([
      { id: 900, productId: 9, sku: "RAW-PRIMARY", costPrice: "0.00" },
      { id: 901, productId: 10, sku: "NORMALIZED-ALIAS", costPrice: "0.00" },
      { id: 902, productId: 11, sku: "RAW-ALIAS", costPrice: "0.00" },
      { id: 903, productId: 12, sku: "NORMALIZED-PRIMARY", costPrice: "0.00" },
    ]);
    await db().insert(s.productUnits).values([
      { id: 9000, variantId: 900, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, barcode: "١٢٣٤٥٦٧٨" },
      { id: 9001, variantId: 901, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, barcode: "NORMALIZED-ALIAS-UNIT" },
      { id: 9002, variantId: 902, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, barcode: "RAW-ALIAS-UNIT" },
      { id: 9003, variantId: 903, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, barcode: "87654321" },
    ]);
    await db().insert(s.productUnitBarcodes).values([
      { id: 9000, productUnitId: 9001, barcode: "12345678" },
      { id: 9001, productUnitId: 9002, barcode: "٨٧٦٥٤٣٢١" },
    ]);

    expect((await listPickerVariants({ branchId: 1, q: "١٢٣٤٥٦٧٨" })).map((r) => r.variantId)).toEqual([900]);
    expect((await listPickerVariants({ branchId: 1, q: "12345678" })).map((r) => r.variantId)).toEqual([901]);
    expect((await listPickerVariants({ branchId: 1, q: "٨٧٦٥٤٣٢١" })).map((r) => r.variantId)).toEqual([902]);
    expect((await listPickerVariants({ branchId: 1, q: "87654321" })).map((r) => r.variantId)).toEqual([903]);
  });

  it("رصيد فرعٍ آخر لا يُفسِد عدّ الفرع ١", async () => {
    // نضيف صفّ رصيدٍ للظرف في الفرع ٢ فقط — الفرع ١ يجب أن يبقى يعرض 0
    await db().insert(s.branchStock).values([{ branchId: 2, variantId: 100, quantity: 99 }]);
    const rows = await listPickerVariants({ branchId: 1 });
    const envelope = rows.find((r) => r.sku === "ENV-COLDEN-110");
    expect(envelope?.quantity).toBe(0); // ليس 99
  });

  it("الترقيم (limit/offset) يحترم الترتيب باسم المنتج ثم الـSKU", async () => {
    const page1 = await listPickerVariants({ branchId: 1, limit: 1, offset: 0 });
    const page2 = await listPickerVariants({ branchId: 1, limit: 1, offset: 1 });
    expect(page1).toHaveLength(1);
    expect(page2).toHaveLength(1);
    expect(page1[0].sku).not.toBe(page2[0].sku);
  });

  it("الترقيم يملك فاصلاً حتمياً عند تساوي الاسم وSKU", async () => {
    await db().insert(s.products).values([
      { id: 7, name: "منتج متعادل", categoryId: 10 },
      { id: 8, name: "منتج متعادل", categoryId: 10 },
    ]);
    await db().insert(s.productVariants).values([
      { id: 700, productId: 7, sku: "SAME-SKU", costPrice: "0.00" },
      { id: 701, productId: 8, sku: "SAME-SKU", costPrice: "0.00" },
    ]);

    const first = await listPickerVariants({ branchId: 1, q: "منتج متعادل", limit: 1, offset: 0 });
    const second = await listPickerVariants({ branchId: 1, q: "منتج متعادل", limit: 1, offset: 1 });
    expect([first[0]?.variantId, second[0]?.variantId]).toEqual([700, 701]);
  });
});
