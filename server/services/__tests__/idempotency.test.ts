import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createPurchaseOrder, receivePurchase } from "../purchaseService";
import { returnSale } from "../returnService";
import { createSale, processPayment } from "../saleService";
import { truncateTables } from "./__testUtils__";

const actor = { userId: 1, branchId: 1 };

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

async function reset() {
  const d = db();
  await truncateTables(TABLES);
}

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الفرع", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values({ id: 1, openId: "local_test", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.products).values({ id: 1, name: "قلم" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "PEN-1", costPrice: "4.00" });
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true }]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "10.00" }]);
  // M5/M8: العمليات النقدية (createSale CASH / processPayment CASH) تَستوجب وردية مفتوحة.
  await d.insert(s.shifts).values({
    id: 1, userId: 1, branchId: 1, status: "OPEN",
    openedAt: new Date(), openGuard: "1:1", openingBalance: "0",
  });
}

async function setStock(variantId: number, branchId: number, qty: number) {
  await db().insert(s.branchStock).values({ variantId, branchId, quantity: qty });
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("Idempotency — النقر المزدوج لا يُنشئ عمليات مالية مكرّرة", () => {
  it("processPayment: نفس clientRequestId لا يُنشئ دفعة مكرّرة (يُعاد تشغيل النتيجة)", async () => {
    await setStock(1, 1, 10);
    await db().insert(s.customers).values({ id: 1, name: "تاجر", defaultPriceTier: "RETAIL", currentBalance: "0" });
    const sale = await createSale(
      { branchId: 1, customerId: 1, sourceType: "ORDER", lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }] },
      actor,
    );
    const reqId = "pay-req-001";
    const r1 = await processPayment({ invoiceId: sale.invoiceId, amount: "10.00", method: "CASH", clientRequestId: reqId }, actor);
    const r2 = await processPayment({ invoiceId: sale.invoiceId, amount: "10.00", method: "CASH", clientRequestId: reqId }, actor);
    expect((r2 as any).idempotentReplay).toBe(true);

    // إيصال واحد فقط (لا تكرار).
    const receipts = await db().select().from(s.receipts);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].amount).toBe("10.00");

    // الذمة انخفضت مرّة واحدة (20 − 10 = 10).
    const cust = (await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0];
    expect(cust.currentBalance).toBe("10.00");

    // قيد PAYMENT_IN واحد فقط.
    const ents = await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "PAYMENT_IN"));
    expect(ents).toHaveLength(1);
    expect(r1.paidAmount).toBe("10.00");
  });

  it("returnSale: نفس clientRequestId لا يُنشئ استرداداً مكرّراً", async () => {
    await setStock(1, 1, 10);
    const sale = await createSale(
      { branchId: 1, shiftId: 1, priceTier: "RETAIL", sourceType: "POS", lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }], payment: { amount: "20.00", method: "CASH" } },
      actor,
    );
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId)))[0];
    const reqId = "ret-req-001";
    await returnSale(
      { invoiceId: sale.invoiceId, lines: [{ invoiceItemId: Number(item.id), baseQuantity: 1 }], refund: { amount: "10.00", method: "CASH" }, clientRequestId: reqId },
      actor,
    );
    const r2 = await returnSale(
      { invoiceId: sale.invoiceId, lines: [{ invoiceItemId: Number(item.id), baseQuantity: 1 }], refund: { amount: "10.00", method: "CASH" }, clientRequestId: reqId },
      actor,
    );
    expect((r2 as any).idempotentReplay).toBe(true);

    // إيصال OUT واحد فقط.
    const out = await db().select().from(s.receipts).where(eq(s.receipts.direction, "OUT"));
    expect(out).toHaveLength(1);

    // قيد RETURN واحد فقط.
    const ents = await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "RETURN"));
    expect(ents).toHaveLength(1);

    // المخزون عاد بقطعة واحدة (٨ + ١ = ٩، لا تكرار).
    const stock = (await db().select().from(s.branchStock).where(eq(s.branchStock.variantId, 1)))[0];
    expect(stock.quantity).toBe(9);
  });

  it("receivePurchase: نفس clientRequestId لا يُكرّر استلام المخزون ولا AP", async () => {
    await db().insert(s.suppliers).values({ id: 1, name: "مورّد", currentBalance: "0" });
    const po = await createPurchaseOrder(
      { supplierId: 1, branchId: 1, items: [{ variantId: 1, productUnitId: 1, quantity: "5", unitPrice: "2.00" }] },
      actor,
    );
    const it = (await db().select().from(s.purchaseOrderItems).where(eq(s.purchaseOrderItems.purchaseOrderId, po.purchaseOrderId)))[0];
    const reqId = "rcv-req-001";
    await receivePurchase(
      { purchaseOrderId: po.purchaseOrderId, lines: [{ purchaseOrderItemId: Number(it.id), receivedBaseQuantity: 5 }], clientRequestId: reqId },
      actor,
    );
    const r2 = await receivePurchase(
      { purchaseOrderId: po.purchaseOrderId, lines: [{ purchaseOrderItemId: Number(it.id), receivedBaseQuantity: 5 }], clientRequestId: reqId },
      actor,
    );
    expect((r2 as any).idempotentReplay).toBe(true);

    // المخزون 5 (لا 10).
    const stock = (await db().select().from(s.branchStock).where(eq(s.branchStock.variantId, 1)))[0];
    expect(stock.quantity).toBe(5);

    // AP المورد 10 فقط (لا 20).
    const sup = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0];
    expect(sup.currentBalance).toBe("10.00");

    // قيد PURCHASE واحد فقط.
    const ents = await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "PURCHASE"));
    expect(ents).toHaveLength(1);
  });

  it("مفاتيح مختلفة على نفس العملية تُنشئ كتابات منفصلة (تأكيد عدم الإفراط في التطبيق)", async () => {
    await setStock(1, 1, 10);
    await db().insert(s.customers).values({ id: 1, name: "ت", defaultPriceTier: "RETAIL", currentBalance: "0" });
    const sale = await createSale(
      { branchId: 1, customerId: 1, sourceType: "ORDER", lines: [{ variantId: 1, productUnitId: 1, quantity: "3" }] },
      actor,
    );
    await processPayment({ invoiceId: sale.invoiceId, amount: "10.00", method: "CASH", clientRequestId: "key-A" }, actor);
    await processPayment({ invoiceId: sale.invoiceId, amount: "5.00", method: "CASH", clientRequestId: "key-B" }, actor);
    const receipts = await db().select().from(s.receipts);
    expect(receipts).toHaveLength(2);
    const cust = (await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0];
    expect(cust.currentBalance).toBe("15.00"); // 30 − 10 − 5
  });
});
