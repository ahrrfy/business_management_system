/**
 * P0 — مرتجع الزبون العابر لا يحرّك مخزوناً/إيراداً قبل تسوية نقدية كاملة وصريحة.
 * يغطي المبلغ بعد تقريب IQD، ذرية الرفض، درج الوردية، وidempotency.
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { returnSale, type ReturnSaleInput } from "../returnService";
import { createSale } from "../saleService";
import { getShiftReport } from "../shiftService";

const actor = { userId: 1, branchId: 1, role: "manager" };
const TABLES = [
  "idempotencyKeys", "accountingEntries", "receipts", "inventoryMovements",
  "invoiceItems", "invoices", "branchStock", "productPrices", "productUnits",
  "productVariants", "products", "shifts", "customers", "branches", "users",
];

function db() {
  const current = getDb();
  if (!current) throw new Error("DATABASE_URL not set for tests");
  return current;
}

async function reset() {
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of TABLES) await db().execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed() {
  await db().insert(s.branches).values({ id: 1, name: "الفرع", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values({
    id: 1, openId: "walkin-manager", name: "مدير المرتجعات", role: "manager",
    loginMethod: "local", branchId: 1,
  });
  await db().insert(s.products).values({ id: 1, name: "دفتر" });
  await db().insert(s.productVariants).values({ id: 1, productId: 1, sku: "NB-1", costPrice: "400.00" });
  await db().insert(s.productUnits).values({
    id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true,
  });
  await db().insert(s.productPrices).values({ productUnitId: 1, priceTier: "RETAIL", price: "1300.00" });
  await db().insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 10 });
  await db().insert(s.shifts).values({
    id: 1, userId: 1, branchId: 1, status: "OPEN", openedAt: new Date(),
    openGuard: "1:1", openingBalance: "0.00",
  });
}

async function sellRoundedWalkIn() {
  const sale = await createSale({
    branchId: 1,
    shiftId: 1,
    sourceType: "POS",
    priceTier: "RETAIL",
    lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
    payment: { amount: "1300.00", method: "CASH" },
    cashRoundIQD: true,
  }, actor);
  const invoice = (await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0];
  const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId)))[0];
  expect(invoice.customerId).toBeNull();
  expect(invoice.total).toBe("1250.00");
  return { invoiceId: sale.invoiceId, itemId: Number(item.id) };
}

function exactResolution(invoiceId: number, itemId: number): ReturnSaleInput {
  return {
    invoiceId,
    lines: [{ invoiceItemId: itemId, baseQuantity: 1 }],
    resolution: {
      kind: "IMMEDIATE_REFUND",
      method: "CASH",
      amount: "1250.00",
      shiftId: 1,
      reason: "المنتج غير مطابق",
      disposition: "RESTOCK",
    },
    clientRequestId: "walkin-return-exact-1",
  };
}

async function assertNoReturnEffect(invoiceId: number, itemId: number) {
  const invoice = (await db().select().from(s.invoices).where(eq(s.invoices.id, invoiceId)))[0];
  const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.id, itemId)))[0];
  const stock = (await db().select().from(s.branchStock).where(and(
    eq(s.branchStock.branchId, 1), eq(s.branchStock.variantId, 1),
  )))[0];
  expect(invoice.returnedTotal).toBe("0.00");
  expect(item.returnedBaseQuantity).toBe(0);
  expect(stock.quantity).toBe(9);
  expect(await db().select().from(s.receipts).where(eq(s.receipts.direction, "OUT"))).toHaveLength(0);
  expect(await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "RETURN"))).toHaveLength(0);
  expect((await getShiftReport(1))?.expectedCash).toBe("1250.00");
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe("returnSale — resolution الزبون العابر", () => {
  it("يرفض غياب resolution حتى لو أُرسل refund نقدي قديم، ولا يترك أثراً", async () => {
    const { invoiceId, itemId } = await sellRoundedWalkIn();
    await expect(returnSale({
      invoiceId,
      lines: [{ invoiceItemId: itemId, baseQuantity: 1 }],
      refund: { amount: "1250.00", method: "CASH", shiftId: 1 },
    }, actor)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringMatching(/resolution.*CASH.*كامل/),
    });
    await assertNoReturnEffect(invoiceId, itemId);
  });

  it("يرفض الرد الجزئي وطريقة CARD برسالة توجيهية، وتبقى المحاولة ذرية", async () => {
    const { invoiceId, itemId } = await sellRoundedWalkIn();
    const partial = exactResolution(invoiceId, itemId);
    partial.clientRequestId = "walkin-partial";
    partial.resolution!.amount = "1000.00";
    await expect(returnSale(partial, actor)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/1250\.00.*1000\.00.*جزئي/),
    });
    await assertNoReturnEffect(invoiceId, itemId);

    const card = exactResolution(invoiceId, itemId);
    card.clientRequestId = "walkin-card";
    card.resolution!.method = "CARD";
    await expect(returnSale(card, actor)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringMatching(/CASH.*كامل فقط/),
    });
    await assertNoReturnEffect(invoiceId, itemId);
  });

  it("ينفّذ الرد الدقيق من الدرج نفسه، ثم يعيد الطلب idempotently بلا صرف أو مخزون مزدوج", async () => {
    const { invoiceId, itemId } = await sellRoundedWalkIn();
    const input = exactResolution(invoiceId, itemId);
    const first = await returnSale(input, actor);
    const replay = await returnSale(input, actor);

    expect(first.returnedTotal).toBe("1250.00");
    expect((replay as { idempotentReplay?: boolean }).idempotentReplay).toBe(true);
    const invoice = (await db().select().from(s.invoices).where(eq(s.invoices.id, invoiceId)))[0];
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.id, itemId)))[0];
    const stock = (await db().select().from(s.branchStock).where(eq(s.branchStock.variantId, 1)))[0];
    expect(invoice.returnedTotal).toBe("1250.00");
    expect(invoice.paidAmount).toBe("0.00");
    expect(item.returnedBaseQuantity).toBe(1);
    expect(stock.quantity).toBe(10);

    const outs = await db().select().from(s.receipts).where(eq(s.receipts.direction, "OUT"));
    expect(outs).toHaveLength(1);
    expect(outs[0]).toMatchObject({ amount: "1250.00", paymentMethod: "CASH", shiftId: 1 });
    expect(await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "RETURN"))).toHaveLength(1);
    expect(await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "PAYMENT_OUT"))).toHaveLength(1);
    expect((await getShiftReport(1))?.expectedCash).toBe("0.00");
  });

  it("يبقي مسار العميل المسجّل القديم: مرتجع آجل بلا refund ولا resolution يسقط الذمّة", async () => {
    await db().insert(s.customers).values({ id: 1, name: "عميل مسجّل", currentBalance: "0.00" });
    const sale = await createSale({
      branchId: 1, shiftId: 1, sourceType: "ORDER", customerId: 1,
      lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
    }, actor);
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId)))[0];
    const result = await returnSale({
      invoiceId: sale.invoiceId,
      lines: [{ invoiceItemId: Number(item.id), baseQuantity: 1 }],
      restock: true,
    }, actor);
    expect(result.fullyReturned).toBe(true);
    expect((await db().select().from(s.receipts).where(and(
      eq(s.receipts.invoiceId, sale.invoiceId), eq(s.receipts.direction, "OUT"),
    )))).toHaveLength(0);
    expect((await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0].currentBalance).toBe("0.00");
  });
});
