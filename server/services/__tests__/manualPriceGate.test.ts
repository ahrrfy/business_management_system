/**
 * بوّابة الخصم/السعر اليدويّ فوق التكلفة (تدقيق ٢٧/٧ — H6/H7).
 *
 * قرار المالك: انحرافُ صافي السطر عن مرجعه (عقد/قائمة) لأسفل بأكثر من ١٥٪ يستوجب اعتماد مدير
 * (نفس آليّة تحت-التكلفة عبر priceOverrideApproved). H7 يُغلق تلقائياً: إهداء صنفٍ مُدرَجٍ بسعر 0
 * = انحراف ١٠٠٪. الأصنافُ بلا سعر قائمةٍ لا مرجع لها ⇒ لا بوّابة (ولا رميٌ رجعيّ من getUnitPrice).
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createSale } from "../saleService";

const actor = { userId: 3, branchId: 1, role: "cashier" };

const TABLES = [
  "idempotencyKeys", "accountingEntries", "receipts", "inventoryMovements",
  "invoiceItems", "invoices", "branchStock", "productPrices", "productUnits",
  "productVariants", "products", "customers", "branches", "users",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

beforeEach(async () => {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);

  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values({ id: 3, openId: "c3", name: "كاشير", role: "cashier", loginMethod: "local", branchId: 1 });
  await d.insert(s.products).values([{ id: 1, name: "قلم" }, { id: 2, name: "خدمة" }, { id: 3, name: "بلا سعر" }]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "V1", costPrice: "4.00" }, // مُدرَج بسعر ١٠
    { id: 2, productId: 2, sku: "V2", costPrice: "0.00" }, // تكلفته صفر + مُدرَج ١٠ (H7)
    { id: 3, productId: 3, sku: "V3", costPrice: "4.00" }, // بلا سعر قائمة (اختبار الانحدار)
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 2, variantId: 2, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 3, variantId: 3, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
  ]);
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "10.00" },
    { productUnitId: 2, priceTier: "RETAIL", price: "10.00" },
    // الوحدة ٣ بلا سعر قائمة عمداً.
  ]);
  await d.insert(s.customers).values({ id: 1, name: "عميل", defaultPriceTier: "RETAIL", currentBalance: "0", creditLimit: "999999" });
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 100 },
    { variantId: 2, branchId: 1, quantity: 100 },
    { variantId: 3, branchId: 1, quantity: 100 },
  ]);
});

function sale(line: { variantId: number; productUnitId: number; quantity: string; unitPriceOverride?: string }, approved?: boolean) {
  return createSale(
    {
      branchId: 1, customerId: 1, sourceType: "ORDER", lines: [line],
      ...(approved ? { priceOverrideApproved: true } : {}),
    } as any,
    actor,
  );
}

describe("H6 — عتبة الخصم اليدويّ فوق التكلفة (١٥٪)", () => {
  it("خصمٌ ٢٠٪ فوق التكلفة بلا اعتماد ⇒ FORBIDDEN («خصم يتجاوز ١٥٪»)", async () => {
    // قائمة ١٠، تكلفة ٤ ⇒ سعر ٨ (٢٠٪ خصم) فوق التكلفة لكن يتجاوز العتبة.
    await expect(sale({ variantId: 1, productUnitId: 1, quantity: "1", unitPriceOverride: "8.00" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("نفس الخصم ٢٠٪ مع اعتماد مدير ⇒ يمرّ ويُرفع وسم priceOverride", async () => {
    const res = await sale({ variantId: 1, productUnitId: 1, quantity: "1", unitPriceOverride: "8.00" }, true);
    expect(res.priceOverride).toBe(true);
  });

  it("خصمٌ ١٠٪ (دون العتبة) بلا اعتماد ⇒ يمرّ بلا وسم", async () => {
    const res = await sale({ variantId: 1, productUnitId: 1, quantity: "1", unitPriceOverride: "9.00" });
    expect(res.priceOverride).toBe(false);
  });
});

describe("H7 — صنفٌ تكلفته صفر لا يُهدى مجاناً بلا اعتماد", () => {
  it("صنفٌ مُدرَجٌ (١٠) تكلفته صفر يُباع بـ0 بلا اعتماد ⇒ FORBIDDEN (انحراف ١٠٠٪)", async () => {
    await expect(sale({ variantId: 2, productUnitId: 2, quantity: "1", unitPriceOverride: "0.00" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("نفسه مع اعتماد مدير ⇒ يمرّ", async () => {
    const res = await sale({ variantId: 2, productUnitId: 2, quantity: "1", unitPriceOverride: "0.00" }, true);
    expect(res.priceOverride).toBe(true);
  });
});

describe("انحدار: صنفٌ بلا سعر قائمة يُباع بسعرٍ يدويّ", () => {
  it("بلا مرجعٍ ⇒ لا بوّابة ولا رميٌ من getUnitPrice (كان يفشل قبل الإصلاح)", async () => {
    const res = await sale({ variantId: 3, productUnitId: 3, quantity: "1", unitPriceOverride: "20.00" });
    expect(res.priceOverride).toBe(false);
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, res.invoiceId)))[0];
    expect(inv).toBeTruthy();
  });
});
