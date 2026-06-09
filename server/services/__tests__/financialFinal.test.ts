import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createPurchaseOrder, receivePurchase } from "../purchaseService";
import { createSale } from "../saleService";
import { closeShift } from "../shiftService";

const actor = { userId: 1, branchId: 1, role: "admin" };

const TABLES = [
  "idempotencyKeys",
  "accountingEntries", "receipts", "inventoryMovements", "invoiceItems", "invoices",
  "purchaseOrderItems", "purchaseOrders",
  "branchStock", "productPrices", "productUnits", "productVariants", "products",
  "shifts", "workOrderMaterials", "workOrders", "customers", "suppliers", "branches", "users",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}
const insertId = (res: any): number => Number(res?.[0]?.insertId ?? res?.insertId);

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values({ id: 1, openId: "admin", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.products).values({ id: 1, name: "قلم" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "PEN-1", costPrice: "0.00" });
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true }]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "10.00" }]);
  await d.insert(s.suppliers).values({ id: 1, name: "مورّد", currentBalance: "0" });
}

async function setStock(variantId: number, branchId: number, qty: number) {
  await db().insert(s.branchStock).values({ variantId, branchId, quantity: qty });
}
async function openShift(branchId = 1, userId = 1): Promise<number> {
  const r = await db().insert(s.shifts).values({ branchId, userId, openingBalance: "0", status: "OPEN" });
  return insertId(r);
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("saleService — قفل صفّ الوردية يَسَلْسِل البيع مع الإغلاق", () => {
  it("createSale يَفشل إن أُغلقت الوردية قبل commit (لا بيع بعد قطع الـZ-report)", async () => {
    await setStock(1, 1, 10);
    const shiftId = await openShift(1, 1);
    // أغلق الوردية يدوياً (محاكاة closeShift المتزامن).
    await closeShift({ shiftId, countedCash: "0" }, actor);
    // الآن أي بيع يحاول الـshift يجب أن يُرفض.
    await expect(
      createSale(
        { branchId: 1, shiftId, priceTier: "RETAIL", sourceType: "POS", lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }], payment: { amount: "10.00", method: "CASH" } },
        actor,
      ),
    ).rejects.toThrow(/الوردية/);
  });

  it("createSale ينجح بينما الوردية مفتوحة، ويُسَلْسِل ضدّ close concurrent", async () => {
    await setStock(1, 1, 10);
    const shiftId = await openShift(1, 1);
    const r = await createSale(
      { branchId: 1, shiftId, priceTier: "RETAIL", sourceType: "POS", lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }], payment: { amount: "10.00", method: "CASH" } },
      actor,
    );
    expect(r.status).toBe("PAID");
    const close = await closeShift({ shiftId, countedCash: "10.00" }, actor);
    expect(close.expectedCash).toBe("10.00"); // البيع محسوب
    expect(close.variance).toBe("0.00");
  });
});

describe("purchaseService — قفل branchStock قبل قراءة SUM (WAVG لا يفسد بسباق)", () => {
  it("استلام شراء يُحسب WAVG بمخزون قائم صحيح", async () => {
    await setStock(1, 1, 10); // ١٠ قطع برصيد قائم
    await db().update(s.productVariants).set({ costPrice: "4.00" }).where(eq(s.productVariants.id, 1));
    const po = await createPurchaseOrder(
      { supplierId: 1, branchId: 1, items: [{ variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "6.00" }] },
      actor,
    );
    const it = (await db().select().from(s.purchaseOrderItems))[0];
    await receivePurchase(
      { purchaseOrderId: po.purchaseOrderId, lines: [{ purchaseOrderItemId: Number(it.id), receivedBaseQuantity: 10 }] },
      actor,
    );
    const v = (await db().select().from(s.productVariants).where(eq(s.productVariants.id, 1)))[0];
    expect(v.costPrice).toBe("5.00"); // (10×4 + 10×6) / 20 = 5
  });
});

// ملاحظة: تصحيح القسط الأخير في purchaseService (low في تدقيق ٨/٦) يتطلّب عمود receivedNet
// جديداً على purchaseOrderItems — مُؤجَّل لشريحة schema. التفسير في الكود.
