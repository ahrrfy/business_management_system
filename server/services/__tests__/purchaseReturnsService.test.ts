import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createPurchaseOrder, receivePurchase } from "../purchaseService";
import { createPurchaseReturn, resolveReturnablePurchaseOrder } from "../purchaseReturnsService";

const actor = { userId: 1, branchId: 1, role: "admin" as const };
const TABLES = [
  "documentPrintEvents", "purchaseReturnItems", "purchaseReturns", "accountingEntries", "receipts",
  "idempotencyKeys", "inventoryMovements", "branchStock", "purchaseOrderItems", "purchaseOrders",
  "productPrices", "productUnits", "productVariants", "products", "auditLogs", "suppliers", "branches", "users",
];

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function reset() {
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of TABLES) await db().execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seedBase() {
  await db().insert(s.branches).values({ id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values({ id: 1, openId: "return_admin", name: "مدير المشتريات", role: "admin", loginMethod: "local", isOwner: false });
  await db().insert(s.products).values({ id: 1, name: "قلم" });
  await db().insert(s.productVariants).values({ id: 1, productId: 1, sku: "PEN-1", costPrice: "5.00" });
  await db().insert(s.productUnits).values({ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true });
  await db().insert(s.suppliers).values({ id: 1, name: "مورد الاختبار", currentBalance: "0" });
}

async function receivedOrder(quantity = 100, taxRatePercent = "0") {
  const po = await createPurchaseOrder({
    supplierId: 1,
    branchId: 1,
    status: "CONFIRMED",
    taxRatePercent,
    items: [{ variantId: 1, productUnitId: 1, quantity: String(quantity), unitPrice: "5.00" }],
  }, actor);
  const item = (await db().select().from(s.purchaseOrderItems).where(eq(s.purchaseOrderItems.purchaseOrderId, po.purchaseOrderId)))[0];
  await receivePurchase({
    purchaseOrderId: po.purchaseOrderId,
    lines: [{ purchaseOrderItemId: Number(item.id), receivedBaseQuantity: quantity }],
  }, actor);
  return { poId: po.purchaseOrderId, poNumber: po.poNumber, itemId: Number(item.id) };
}

async function stock() {
  return (await db().select({ quantity: s.branchStock.quantity }).from(s.branchStock).where(and(eq(s.branchStock.branchId, 1), eq(s.branchStock.variantId, 1))))[0]?.quantity ?? 0;
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("مرتجع المشتريات المرجعي", () => {
  it("يحل الرقم المرئي كاملاً ولا يفسر رقم الفرع كمعرّف الأمر", async () => {
    const po = await receivedOrder();
    const resolved = await resolveReturnablePurchaseOrder({ branchId: 1, reference: po.poNumber });
    expect(resolved.id).toBe(po.poId);
    expect(resolved.items[0].purchaseOrderItemId).toBe(po.itemId);
    expect(resolved.items[0].remainingBaseQuantity).toBe(100);
  });

  it("ينشئ مستنداً مفصلاً ويرث سعر وضريبة أمر الشراء ويسجل المنفذ", async () => {
    const po = await receivedOrder(100, "10");
    const result = await createPurchaseReturn({
      clientRequestId: "return-tax-source-001",
      supplierId: 1,
      branchId: 1,
      purchaseOrderRefId: po.poId,
      items: [{ purchaseOrderItemId: po.itemId, quantity: "10" }],
      settlement: "CREDIT",
    }, actor);
    expect(result.returnedTotal).toBe("55.00");
    const header = (await db().select().from(s.purchaseReturns).where(eq(s.purchaseReturns.id, result.purchaseReturnId)))[0];
    expect(header.createdByNameSnapshot).toBe("مدير المشتريات");
    expect(header.creditOffsetAmount).toBe("55.00");
    expect(await db().select().from(s.purchaseReturnItems)).toHaveLength(1);
    const entry = (await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "RETURN")))[0];
    expect(entry.amount).toBe("-55.00");
    expect(entry.createdByNameSnapshot).toBe("مدير المشتريات");
    expect(await stock()).toBe(90);
  });

  it("يعيد المستند نفسه عند replay بالمفتاح والحمولة نفسيهما", async () => {
    const po = await receivedOrder();
    const input = {
      clientRequestId: "return-idempotent-001",
      supplierId: 1,
      branchId: 1,
      purchaseOrderRefId: po.poId,
      items: [{ purchaseOrderItemId: po.itemId, quantity: "7" }],
      settlement: "CREDIT" as const,
    };
    const [first, second] = await Promise.all([createPurchaseReturn(input, actor), createPurchaseReturn(input, actor)]);
    expect(second.purchaseReturnId).toBe(first.purchaseReturnId);
    expect((await db().select().from(s.purchaseReturns))).toHaveLength(1);
    expect((await db().select().from(s.inventoryMovements).where(eq(s.inventoryMovements.referenceType, "PURCHASE_RETURN")))).toHaveLength(1);
  });

  it("يمنع over-return متزامناً حتى مع وجود مخزون إضافي من مصدر آخر", async () => {
    const po = await receivedOrder();
    await db().update(s.branchStock).set({ quantity: sql`${s.branchStock.quantity} + 100` }).where(and(eq(s.branchStock.branchId, 1), eq(s.branchStock.variantId, 1)));
    const outcomes = await Promise.allSettled([
      createPurchaseReturn({ clientRequestId: "return-race-a", supplierId: 1, branchId: 1, purchaseOrderRefId: po.poId, items: [{ purchaseOrderItemId: po.itemId, quantity: "60" }], settlement: "CREDIT" }, actor),
      createPurchaseReturn({ clientRequestId: "return-race-b", supplierId: 1, branchId: 1, purchaseOrderRefId: po.poId, items: [{ purchaseOrderItemId: po.itemId, quantity: "60" }], settlement: "CREDIT" }, actor),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const item = (await db().select().from(s.purchaseOrderItems).where(eq(s.purchaseOrderItems.id, po.itemId)))[0];
    expect(item.returnedBaseQuantity).toBe(60);
  });

  it("يرفض بنداً لا ينتمي إلى أمر الشراء بلا أي أثر", async () => {
    const first = await receivedOrder();
    const second = await receivedOrder();
    await expect(createPurchaseReturn({
      clientRequestId: "return-wrong-line",
      supplierId: 1,
      branchId: 1,
      purchaseOrderRefId: first.poId,
      items: [{ purchaseOrderItemId: second.itemId, quantity: "1" }],
      settlement: "CREDIT",
    }, actor)).rejects.toThrow(/لا ينتمي/);
    expect(await db().select().from(s.purchaseReturns)).toHaveLength(0);
  });
});
