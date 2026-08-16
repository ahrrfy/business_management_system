/**
 * ما يراه المستخدم عن البكج في شاشة المنتجات والكاشير.
 *
 * الشكوى الحاكمة (١٦/٨/٢٦): «مكوّنات البكج متوفّرة لكن لا يظهر المتاح للبيع ولا الكلفة ولا الأرصدة».
 * الجذر بندان مستقلّان:
 *   ١) الكلفة: `productVariants.costPrice` للبكج صفرٌ عمداً (تُحسب لحظة البيع) — وشاشات القراءة
 *      كانت تعرض ذلك الصفر بدل اشتقاق Σ(تكلفة المكوّن × كميّته). المصدر الحاكم `computeBundleUnitCosts`.
 *   ٢) سبب الصفر: طاقة البكج مشتقّة من أضعف مكوّن، وحين تكون صفراً لا تُخبر الشاشة **لماذا**
 *      (بلا وصفة؟ مكوّنٌ نافد؟ مكوّنٌ معطَّل؟) فيبدو النظام معطوباً وهو يعمل.
 */
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { listProductsAdmin } from "../catalogService";
import { loadVariantAvailability } from "../catalog/variantAvailability";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of [
    "reservationStock",
    "branchStock",
    "bundleComponents",
    "productPrices",
    "productUnits",
    "productVariants",
    "products",
    "branches",
  ]) {
    await d.execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  }
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

/** مكوّنان بسيطان + بكج «دفتران وقلم» — نموذجٌ مصغَّرٌ من بكجات القرطاسية المدرسية. */
async function seedBundle(opts: { notebookStock: number; penStock: number; penActive?: boolean }) {
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" });

  await d.insert(s.products).values([
    { id: 1, name: "دفتر ٦٠ ورقة", isActive: true },
    { id: 2, name: "قلم جاف أزرق", isActive: true },
    { id: 3, name: "بكج أول ابتدائي", isActive: true, isBundle: true },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "NB-1", costPrice: "250.00" },
    { id: 2, productId: 2, sku: "PEN-1", costPrice: "500.00", isActive: opts.penActive ?? true },
    // البكج بلا تكلفة مخزَّنة — تُشتق من الوصفة (قرار ٧/٧).
    { id: 3, productId: 3, sku: "BDL-1", costPrice: "0.00" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 2, variantId: 2, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 3, variantId: 3, unitName: "بكج", conversionFactor: "1", isBaseUnit: true },
  ]);
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "500.00" },
    { productUnitId: 2, priceTier: "RETAIL", price: "1000.00" },
    { productUnitId: 3, priceTier: "RETAIL", price: "3000.00" },
  ]);
  // الوصفة: دفتران + قلم واحد لكل بكج.
  await d.insert(s.bundleComponents).values([
    { bundleVariantId: 3, componentVariantId: 1, componentBaseQuantity: 2, sortOrder: 0 },
    { bundleVariantId: 3, componentVariantId: 2, componentBaseQuantity: 1, sortOrder: 1 },
  ]);
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: opts.notebookStock },
    { variantId: 2, branchId: 1, quantity: opts.penStock },
  ]);
}

async function bundleRow() {
  const page = await listProductsAdmin(
    { branchId: 1, includeInactive: true, limit: 50, offset: 0 } as never,
    { includeSensitivePrices: true } as never,
  );
  const row = page.rows.find((r) => r.isBundle);
  if (!row) throw new Error("صفّ البكج غير موجود في قائمة المنتجات");
  return row;
}

beforeEach(reset);

describe("ظهور البكج في شاشة المنتجات", () => {
  it("الطاقة = أضعف مكوّن، والكلفة مشتقّة من الوصفة لا صفراً", async () => {
    // ٢٠ دفتراً (⇒ ١٠ بكجات) و٧ أقلام (⇒ ٧ بكجات) ⇒ الطاقة ٧.
    await seedBundle({ notebookStock: 20, penStock: 7 });

    const availability = (await loadVariantAvailability(db(), 1, [3])).get(3)!;
    expect(availability.onHandBase).toBe(7);
    expect(availability.availableBase).toBe(7);

    const row = await bundleRow();
    expect(row.availableBase).toBe(7);
    expect(row.stockBase).toBe(7);
    // Σ(٢×٢٥٠ + ١×٥٠٠) = ١٠٠٠ — الصفر السابق كان يُظهر هامشاً ١٠٠٪ كاذباً.
    expect(row.costPrice).toBe("1000.00");
    expect(row.baseCostPrice).toBe("1000.00");
    expect(row.bundleCapacity).toMatchObject({ status: "OK", limiting: { variantId: 2, requiredPerBundle: 1 } });
  });

  it("مكوّنٌ نافد يُصفّر الطاقة **ويُسمّي سببه** بدل صفرٍ صامت", async () => {
    await seedBundle({ notebookStock: 20, penStock: 0 });

    const row = await bundleRow();
    expect(row.availableBase).toBe(0);
    expect(row.bundleCapacity).toMatchObject({
      status: "COMPONENT_OUT_OF_STOCK",
      limiting: { variantId: 2, requiredPerBundle: 1, componentAvailableBase: 0 },
    });
    expect(row.bundleCapacity?.limiting?.productName).toContain("قلم");
    // الكلفة تبقى مشتقّة ولو كانت الطاقة صفراً — الصفر مخزونٌ لا تسعير.
    expect(row.costPrice).toBe("1000.00");
  });

  it("مكوّنٌ معطَّل يُبلَّغ كسببٍ مستقلّ عن النفاد (البيع يرفضه بحارسٍ آخر)", async () => {
    await seedBundle({ notebookStock: 20, penStock: 9, penActive: false });

    const row = await bundleRow();
    expect(row.availableBase).toBe(0);
    expect(row.bundleCapacity).toMatchObject({ status: "COMPONENT_INACTIVE", limiting: { variantId: 2 } });
  });

  it("بكجٌ بلا وصفة يُبلَّغ صراحةً — بيانات معطوبة لا «نفاد»", async () => {
    await seedBundle({ notebookStock: 20, penStock: 9 });
    await db().execute(sql`DELETE FROM \`bundleComponents\` WHERE \`bundleVariantId\` = 3`);

    const row = await bundleRow();
    expect(row.availableBase).toBe(0);
    expect(row.costPrice).toBe("0.00");
    expect(row.bundleCapacity).toMatchObject({ status: "NO_RECIPE", limiting: null });
  });

  it("حجز مكوّنٍ يخفض طاقة البكج ويُسمّى المكوّن الحاجز", async () => {
    await seedBundle({ notebookStock: 20, penStock: 9 });
    // حجز ٧ أقلام ⇒ المتاح منها ٢ ⇒ طاقة البكج ٢ (الدفاتر تكفي ١٠).
    await db().insert(s.reservationStock).values({ variantId: 2, branchId: 1, reservedBase: 7 });

    const row = await bundleRow();
    expect(row.stockBase).toBe(9);
    expect(row.availableBase).toBe(2);
    expect(row.bundleCapacity).toMatchObject({ status: "OK", limiting: { variantId: 2, componentAvailableBase: 2 } });
  });
});
