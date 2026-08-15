import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createPrintSale } from "../printSaleService";
import {
  confirmExternalPaymentAttempt,
  createConfirmedPosSale,
  initiateExternalPaymentAttempt,
  type PosExternalPaymentChannel,
  type PosExternalPaymentMethod,
} from "../posExternalPayment";
import { truncateTables } from "./__testUtils__";

const actor = { userId: 1, branchId: 1, role: "cashier" } as const;
const otherActor = { userId: 2, branchId: 1, role: "cashier" } as const;
const TABLES = [
  "externalPaymentAttempts",
  "accountingEntries", "receipts", "inventoryMovements", "invoiceItems", "invoices",
  "productionRecipeLines", "productionRecipes", "branchStock", "productPrices", "productUnits",
  "productVariants", "products", "shifts", "customers", "branches", "users", "idempotencyKeys",
];

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function seed() {
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values({
    id: 1,
    openId: "external-payment-cashier",
    name: "Cashier",
    role: "cashier",
    loginMethod: "local",
    branchId: 1,
  });
  await d.insert(s.users).values({
    id: 2,
    openId: "external-payment-other-cashier",
    name: "Other Cashier",
    role: "cashier",
    loginMethod: "local",
    branchId: 1,
  });
  await d.insert(s.products).values([
    { id: 1, name: "Stock item" },
    { id: 2, name: "Print service", productType: "PRINT_SERVICE" },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "STOCK-EXT", costPrice: "10.00" },
    { id: 2, productId: 2, sku: "PRINT-EXT", costPrice: "0.00" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "piece", conversionFactor: "1", isBaseUnit: true },
    { id: 2, variantId: 2, unitName: "service", conversionFactor: "1", isBaseUnit: true },
  ]);
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "100.00" },
    { productUnitId: 2, priceTier: "RETAIL", price: "250.00" },
  ]);
  await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 10 });
  await d.insert(s.shifts).values([
    { id: 1, branchId: 1, userId: 1, shiftType: "RETAIL", openingBalance: "1000", status: "OPEN", openGuard: "1:1:RETAIL" },
    { id: 2, branchId: 1, userId: 1, shiftType: "PRINT_SERVICES", openingBalance: "1000", status: "OPEN", openGuard: "1:1:PRINT_SERVICES" },
  ]);
}

beforeEach(async () => {
  await truncateTables(TABLES);
  await seed();
});

let sequence = 0;
function unique(prefix: string) {
  sequence += 1;
  return `${prefix}-${Date.now()}-${sequence}`;
}

async function attempt(params: {
  channel: PosExternalPaymentChannel;
  method?: PosExternalPaymentMethod;
  amount: string;
  reference?: string;
  confirm?: boolean;
  deviceId?: string;
}) {
  const deviceId = params.deviceId ?? "TEST-POS-DEVICE";
  const initiated = await initiateExternalPaymentAttempt({
    branchId: 1,
    channel: params.channel,
    method: params.method ?? "CARD",
    amount: params.amount,
    reference: params.reference ?? unique("REF"),
    requestId: unique("REQ"),
    deviceId,
  }, actor);
  if (params.confirm === false) return initiated;
  return confirmExternalPaymentAttempt({ attemptId: initiated.attemptId, branchId: 1, channel: params.channel, deviceId }, actor);
}

const stockSale = (payment: { amount: string; method: "CASH" | PosExternalPaymentMethod; externalPaymentAttemptId?: number }, clientRequestId = unique("SALE")) =>
  createConfirmedPosSale({
    branchId: 1,
    shiftId: 1,
    deviceId: "TEST-POS-DEVICE",
    sourceType: "POS",
    clientRequestId,
    requireExternalPaymentAttempt: true,
    lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
    payment,
  }, actor);

const printSale = (payment: { amount: string; method: "CASH" | PosExternalPaymentMethod; externalPaymentAttemptId?: number }, clientRequestId = unique("PRINT")) =>
  createPrintSale({
    branchId: 1,
    shiftId: 2,
    deviceId: "TEST-POS-DEVICE",
    clientRequestId,
    requireExternalPaymentAttempt: true,
    lines: [{ variantId: 2, productUnitId: 2, quantity: "1" }],
    payment,
  }, actor);

describe("P0 external payment confirmation", () => {
  it("preserves cash POS and PrintPOS flows without an external attempt", async () => {
    await stockSale({ amount: "100.00", method: "CASH" });
    await printSale({ amount: "250.00", method: "CASH" });

    expect(await db().select().from(s.externalPaymentAttempts)).toHaveLength(0);
    const receipts = await db().select().from(s.receipts);
    expect(receipts).toHaveLength(2);
    expect(receipts.every((row) => row.paymentMethod === "CASH" && row.cashBucket === "DRAWER" && row.referenceNumber == null)).toBe(true);
  });

  it("rejects missing, unconfirmed, failed, and reversed attempts with zero business effects", async () => {
    await expect(stockSale({ amount: "100.00", method: "CARD" })).rejects.toThrow(/أكّد الدفع/);

    const initiated = await attempt({ channel: "POS", amount: "100.00", confirm: false });
    await expect(stockSale({ amount: "100.00", method: "CARD", externalPaymentAttemptId: initiated.attemptId })).rejects.toThrow(/غير مؤكّد/);

    await db().update(s.externalPaymentAttempts).set({ state: "FAILED" }).where(eq(s.externalPaymentAttempts.id, initiated.attemptId));
    await expect(stockSale({ amount: "100.00", method: "CARD", externalPaymentAttemptId: initiated.attemptId })).rejects.toThrow(/غير مؤكّد/);

    await db().update(s.externalPaymentAttempts).set({ state: "REVERSED", confirmedBy: 1, confirmedAt: new Date() }).where(eq(s.externalPaymentAttempts.id, initiated.attemptId));
    await expect(stockSale({ amount: "100.00", method: "CARD", externalPaymentAttemptId: initiated.attemptId })).rejects.toThrow(/غير مؤكّد/);

    expect(await db().select().from(s.invoices)).toHaveLength(0);
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
    expect(await db().select().from(s.inventoryMovements)).toHaveLength(0);
    const stock = (await db().select().from(s.branchStock).where(eq(s.branchStock.variantId, 1)))[0];
    expect(Number(stock.quantity)).toBe(10);
  });

  it("binds a confirmed POS attempt exactly to its invoice and receipt", async () => {
    const confirmed = await attempt({ channel: "POS", amount: "100.00", reference: "  pos-auth-7788  " });
    const result = await stockSale({ amount: "100.00", method: "CARD", externalPaymentAttemptId: confirmed.attemptId });

    const row = (await db().select().from(s.externalPaymentAttempts).where(eq(s.externalPaymentAttempts.id, confirmed.attemptId)))[0];
    const receipt = (await db().select().from(s.receipts).where(eq(s.receipts.invoiceId, result.invoiceId)))[0];
    expect(row.state).toBe("CONFIRMED");
    expect(row.providerCode).toBe("CARD");
    expect(row.accountReference).toBe("BRANCH:1:CARD");
    expect(row.deviceId).toBe("TEST-POS-DEVICE");
    expect(Number(row.invoiceId)).toBe(result.invoiceId);
    expect(Number(row.receiptId)).toBe(Number(receipt.id));
    expect(row.consumedAt).not.toBeNull();
    expect(receipt.referenceNumber).toBe("pos-auth-7788");
    expect(receipt.cashBucket).toBeNull();
    expect(receipt.status).toBe("COMPLETED");
  });

  it.each(["CARD", "CHECK", "TRANSFER", "WALLET"] as const)(
    "enforces the confirmed-attempt contract for %s",
    async (method) => {
      const confirmed = await attempt({ channel: "POS", method, amount: "100.00" });
      const result = await stockSale({ amount: "100.00", method, externalPaymentAttemptId: confirmed.attemptId });
      const receipt = (await db().select().from(s.receipts).where(eq(s.receipts.invoiceId, result.invoiceId)))[0];
      expect(receipt.paymentMethod).toBe(method);
      expect(receipt.referenceNumber).toBeTruthy();
      expect(receipt.cashBucket).toBeNull();
    },
  );

  it("rejects a confirmed attempt from another physical device with zero business effects", async () => {
    const confirmed = await attempt({ channel: "POS", amount: "100.00", deviceId: "OTHER-POS-DEVICE" });
    await expect(stockSale({ amount: "100.00", method: "CARD", externalPaymentAttemptId: confirmed.attemptId })).rejects.toThrow(/جهاز/);

    expect(await db().select().from(s.invoices)).toHaveLength(0);
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
    expect(await db().select().from(s.inventoryMovements)).toHaveLength(0);
    const stock = (await db().select().from(s.branchStock).where(eq(s.branchStock.variantId, 1)))[0];
    expect(Number(stock.quantity)).toBe(10);
  });

  it("enforces normalized reference uniqueness atomically across POS/PrintPOS and payment methods", async () => {
    const reference = unique("SHARED-REF");
    const settled = await Promise.allSettled([
      initiateExternalPaymentAttempt({ branchId: 1, channel: "POS", method: "CARD", amount: "100.00", reference, requestId: unique("REQ"), deviceId: "TEST-POS-DEVICE" }, actor),
      initiateExternalPaymentAttempt({ branchId: 1, channel: "PRINT_POS", method: "WALLET", amount: "250.00", reference: `  ${reference.toLowerCase()}  `, requestId: unique("REQ"), deviceId: "TEST-PRINT-DEVICE" }, actor),
    ]);
    expect(settled.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((row) => row.status === "rejected")).toHaveLength(1);
    expect(await db().select().from(s.externalPaymentAttempts)).toHaveLength(1);
  });

  it("lets exactly one concurrent sale consume a confirmed attempt and rolls the loser back", async () => {
    const confirmed = await attempt({ channel: "POS", amount: "100.00" });
    const settled = await Promise.allSettled([
      stockSale({ amount: "100.00", method: "CARD", externalPaymentAttemptId: confirmed.attemptId }, unique("RACE-A")),
      stockSale({ amount: "100.00", method: "CARD", externalPaymentAttemptId: confirmed.attemptId }, unique("RACE-B")),
    ]);
    expect(settled.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((row) => row.status === "rejected")).toHaveLength(1);
    expect(await db().select().from(s.invoices)).toHaveLength(1);
    expect(await db().select().from(s.receipts)).toHaveLength(1);
    expect((await db().select().from(s.accountingEntries)).filter((row) => row.entryType === "PAYMENT_IN")).toHaveLength(1);
    expect(await db().select().from(s.inventoryMovements)).toHaveLength(1);
    const stock = (await db().select().from(s.branchStock).where(eq(s.branchStock.variantId, 1)))[0];
    expect(Number(stock.quantity)).toBe(9);
  });

  it("replays the same attempt idempotently and rejects the same key with another attempt", async () => {
    const key = unique("IDEMP");
    const firstAttempt = await attempt({ channel: "POS", amount: "100.00" });
    const first = await stockSale({ amount: "100.00", method: "CARD", externalPaymentAttemptId: firstAttempt.attemptId }, key);
    const replay = await stockSale({ amount: "100.00", method: "CARD", externalPaymentAttemptId: firstAttempt.attemptId }, key);
    expect(replay.invoiceId).toBe(first.invoiceId);
    expect(replay.idempotentReplay).toBe(true);

    const secondAttempt = await attempt({ channel: "POS", amount: "100.00" });
    await expect(stockSale({ amount: "100.00", method: "CARD", externalPaymentAttemptId: secondAttempt.attemptId }, key)).rejects.toThrow(/idempotency/);
    expect(await db().select().from(s.invoices)).toHaveLength(1);

    await expect(createConfirmedPosSale({
      branchId: 1,
      shiftId: 1,
      deviceId: "TEST-POS-DEVICE",
      sourceType: "POS",
      clientRequestId: key,
      requireExternalPaymentAttempt: true,
      lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      payment: { amount: "100.00", method: "CARD", externalPaymentAttemptId: firstAttempt.attemptId },
    }, otherActor)).rejects.toThrow(/كاشيراً آخر/);
  });

  it("consumes a confirmed PrintPOS attempt and rejects a mismatched amount without material usage", async () => {
    const wrong = await attempt({ channel: "PRINT_POS", amount: "200.00" });
    await expect(printSale({ amount: "250.00", method: "CARD", externalPaymentAttemptId: wrong.attemptId })).rejects.toThrow(/مبلغ/);
    expect(await db().select().from(s.invoices)).toHaveLength(0);
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    expect(await db().select().from(s.inventoryMovements)).toHaveLength(0);

    const confirmed = await attempt({ channel: "PRINT_POS", amount: "250.00", reference: unique("PRINT-AUTH") });
    const result = await printSale({ amount: "250.00", method: "CARD", externalPaymentAttemptId: confirmed.attemptId });
    const row = (await db().select().from(s.externalPaymentAttempts).where(eq(s.externalPaymentAttempts.id, confirmed.attemptId)))[0];
    expect(Number(row.invoiceId)).toBe(result.invoiceId);
    expect(Number(row.receiptId)).toBeGreaterThan(0);
  });
});
