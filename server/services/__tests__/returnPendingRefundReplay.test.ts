import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { idempotencyHash } from "../idempotency";
import { returnSale, type ReturnSaleInput } from "../returnService";
import { createSale } from "../saleService";

const manager = { userId: 1, branchId: 1, role: "manager" };
function db() { const value = getDb(); if (!value) throw new Error("Test DB unavailable"); return value; }

beforeEach(async () => {
  await db().insert(s.branches).values({ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values({ id: 1, openId: "return-manager", name: "manager", role: "manager", loginMethod: "local", branchId: 1 });
  await db().insert(s.customers).values({ id: 1, name: "registered customer", currentBalance: "0.00" });
  await db().insert(s.products).values({ id: 1, name: "stocked item" });
  await db().insert(s.productVariants).values({ id: 1, productId: 1, sku: "RETURN-REPLAY", costPrice: "4.00" });
  await db().insert(s.productUnits).values({ id: 1, variantId: 1, unitName: "piece", conversionFactor: "1", isBaseUnit: true });
  await db().insert(s.productPrices).values({ productUnitId: 1, priceTier: "RETAIL", price: "10.00" });
  await db().insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 100 });
});

async function pendingReturn(method: "TRANSFER" | "WALLET") {
  const shift = await db().insert(s.shifts).values({ branchId: 1, userId: 1, openingBalance: "0", status: "OPEN" });
  const sale = await createSale({ branchId: 1, shiftId: extractInsertId(shift), customerId: 1, sourceType: "POS", lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }], payment: { amount: "20.00", method: "CASH" } }, manager);
  // A historical original receipt on the actual refund rail; no new provider payment is invented.
  await db().update(s.receipts).set({ paymentMethod: method, cashBucket: null, referenceNumber: `ORIGINAL-${method}` }).where(and(eq(s.receipts.invoiceId, sale.invoiceId), eq(s.receipts.direction, "IN")));
  await db().update(s.invoices).set({ paymentMethod: method }).where(eq(s.invoices.id, sale.invoiceId));
  const [item] = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId));
  const input: ReturnSaleInput = { invoiceId: sale.invoiceId, lines: [{ invoiceItemId: item.id, baseQuantity: 1 }], refund: { method, amount: "10.00" }, clientRequestId: `RETURN-PENDING-REPLAY-${method}` };
  const result = await returnSale(input, manager);
  const [receipt] = await db().select().from(s.receipts).where(and(eq(s.receipts.invoiceId, sale.invoiceId), eq(s.receipts.direction, "OUT")));
  return { input, result, receipt };
}

async function financialState(invoiceId: number) {
  return {
    invoice: await db().select().from(s.invoices).where(eq(s.invoices.id, invoiceId)),
    items: await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, invoiceId)),
    receipts: await db().select().from(s.receipts).where(eq(s.receipts.invoiceId, invoiceId)),
    entries: await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.invoiceId, invoiceId)),
    movements: await db().select().from(s.inventoryMovements),
    stock: await db().select().from(s.branchStock),
    customer: await db().select().from(s.customers),
  };
}

describe.each(["TRANSFER", "WALLET"] as const)("pending %s return replay", method => {
  it("recovers the indexed pending amount/voucher without another return, refund or stock movement", async () => {
    const { input, result, receipt } = await pendingReturn(method);
    expect(result.pendingRefundAmount).toBe("10.00"); expect(result.pendingRefundVoucherNumber).toBeTruthy();
    expect(receipt.referenceNumber).toBe(`SALE-RETURN-PENDING-${input.invoiceId}-0-${idempotencyHash(input).slice(0, 12)}`);
    const before = await financialState(input.invoiceId);
    const replay = await returnSale(input, manager);
    expect(replay).toMatchObject({ idempotentReplay: true, pendingRefundAmount: "10.00", pendingRefundVoucherNumber: result.pendingRefundVoucherNumber });
    expect(await financialState(input.invoiceId)).toEqual(before);
  });
  it("retains the exact legacy reference and excludes a newer lookalike reference", async () => {
    const { input, result, receipt } = await pendingReturn(method);
    const legacy = `SALE-RETURN-PENDING-${input.invoiceId}-${idempotencyHash(input).slice(0, 12)}`;
    await db().update(s.receipts).set({ referenceNumber: legacy }).where(eq(s.receipts.id, receipt.id));
    const { id: _id, cashDropKey: _cashDropKey, ...lookalike } = receipt;
    await db().insert(s.receipts).values({ ...lookalike, referenceNumber: `${legacy}-OTHER`, amount: "99.00", voucherNumber: `PV-OTHER-${method}` });
    const before = await financialState(input.invoiceId);
    const replay = await returnSale(input, manager);
    expect(replay).toMatchObject({ idempotentReplay: true, pendingRefundAmount: "10.00", pendingRefundVoucherNumber: result.pendingRefundVoucherNumber });
    expect(await financialState(input.invoiceId)).toEqual(before);
  });
});
