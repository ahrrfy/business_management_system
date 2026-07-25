import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { replayOfflineSale } from "../offline/replaySale";
import { createPrintSale } from "../printSaleService";
import { createSale } from "../sale/create";
import { processPayment } from "../sale/payment";
import { openShift } from "../shiftService";
import { truncateTables } from "./__testUtils__";

const TABLES = [
  "idempotencyKeys",
  "accountingEntries",
  "receipts",
  "inventoryMovements",
  "invoiceItemBundleComponents",
  "invoiceItems",
  "invoices",
  "branchStock",
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
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function reset() {
  await truncateTables(TABLES);
}

async function seedBase() {
  const d = db();
  await d
    .insert(s.branches)
    .values({ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values([
    {
      id: 1,
      openId: "cashier-1",
      name: "Cashier 1",
      role: "cashier",
      loginMethod: "local",
      branchId: 1,
    },
    {
      id: 2,
      openId: "cashier-2",
      name: "Cashier 2",
      role: "cashier",
      loginMethod: "local",
      branchId: 1,
    },
  ]);
  await d.insert(s.customers).values({
    id: 1,
    name: "Credit customer",
    defaultPriceTier: "RETAIL",
    currentBalance: "0",
    creditLimit: "1000",
  });
  await d.insert(s.products).values([
    { id: 1, name: "Stock item" },
    { id: 2, name: "Print service", productType: "PRINT_SERVICE" },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "STOCK-1", costPrice: "10" },
    { id: 2, productId: 2, sku: "PRINT-1", costPrice: "0" },
  ]);
  await d.insert(s.productUnits).values([
    {
      id: 1,
      variantId: 1,
      unitName: "piece",
      conversionFactor: "1",
      isBaseUnit: true,
    },
    {
      id: 2,
      variantId: 2,
      unitName: "service",
      conversionFactor: "1",
      isBaseUnit: true,
    },
  ]);
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "100" },
    { productUnitId: 2, priceTier: "RETAIL", price: "100" },
  ]);
  await d
    .insert(s.branchStock)
    .values({ variantId: 1, branchId: 1, quantity: 100 });
}

async function insertShift(opts: {
  id?: number;
  userId?: number;
  status?: "OPEN" | "CLOSED";
  shiftType?: "RETAIL" | "PRINT_SERVICES";
  opening?: string;
  closing?: string | null;
}) {
  const id = opts.id ?? 1;
  const userId = opts.userId ?? 1;
  const status = opts.status ?? "OPEN";
  const shiftType = opts.shiftType ?? "RETAIL";
  await db()
    .insert(s.shifts)
    .values({
      id,
      userId,
      branchId: 1,
      status,
      shiftType,
      openingBalance: opts.opening ?? "0",
      openGuard: status === "OPEN" ? `${userId}:1:${shiftType}` : null,
      closedAt: status === "CLOSED" ? new Date() : null,
      closingDrawerCash: opts.closing ?? null,
    });
}

const cashier = { userId: 1, branchId: 1, role: "cashier" } as const;

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("P0 cash-source integrity", () => {
  it("stores only the invoice due as paid/receipt when cash tendered is larger", async () => {
    await insertShift({});
    const result = await createSale(
      {
        branchId: 1,
        shiftId: 1,
        sourceType: "POS",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
        payment: { amount: "750000", method: "CASH" },
      },
      cashier,
    );

    const invoice = (
      await db()
        .select()
        .from(s.invoices)
        .where(eq(s.invoices.id, result.invoiceId))
    )[0];
    const receipt = (
      await db()
        .select()
        .from(s.receipts)
        .where(eq(s.receipts.invoiceId, result.invoiceId))
    )[0];
    expect(invoice.total).toBe("100.00");
    expect(invoice.paidAmount).toBe("100.00");
    expect(receipt.amount).toBe("100.00");
  });

  it("applies the same cash-change cap to print-service sales", async () => {
    await insertShift({ shiftType: "PRINT_SERVICES" });
    const result = await createPrintSale(
      {
        branchId: 1,
        shiftId: 1,
        lines: [{ variantId: 2, productUnitId: 2, quantity: "1" }],
        payment: { amount: "750000", method: "CASH" },
      },
      cashier,
    );
    const invoice = (
      await db()
        .select()
        .from(s.invoices)
        .where(eq(s.invoices.id, result.invoiceId))
    )[0];
    const receipt = (
      await db()
        .select()
        .from(s.receipts)
        .where(eq(s.receipts.invoiceId, result.invoiceId))
    )[0];
    expect(invoice.paidAmount).toBe("100.00");
    expect(receipt.amount).toBe("100.00");
  });

  it("rejects a later payment above the true remaining amount", async () => {
    await insertShift({});
    const sale = await createSale(
      {
        branchId: 1,
        shiftId: 1,
        customerId: 1,
        sourceType: "POS",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
        payment: { amount: "20", method: "CASH" },
      },
      cashier,
    );

    await expect(
      processPayment(
        { invoiceId: sale.invoiceId, amount: "81", method: "CASH", shiftId: 1 },
        cashier,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const invoice = (
      await db()
        .select()
        .from(s.invoices)
        .where(eq(s.invoices.id, sale.invoiceId))
    )[0];
    expect(invoice.paidAmount).toBe("20.00");
    const receipts = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.invoiceId, sale.invoiceId));
    expect(receipts).toHaveLength(1);
  });

  it("never replays an offline sale into a CLOSED shift", async () => {
    await insertShift({ status: "CLOSED", closing: "0" });
    await expect(
      replayOfflineSale(
        {
          branchId: 1,
          shiftId: 1,
          lines: [
            {
              variantId: 1,
              productUnitId: 1,
              quantity: "1",
              unitPriceOverride: "100",
            },
          ],
          payment: { amount: "100", method: "CASH" },
          clientRequestId: "offline-closed-exploit",
          capturedAt: new Date(Date.now() - 60_000).toISOString(),
          offlineReceiptNumber: "OFF-EXPLOIT-1",
        },
        cashier,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await db().select().from(s.invoices)).toHaveLength(0);
    expect(await db().select().from(s.receipts)).toHaveLength(0);
  });

  it("allows an arbitrary opening only for the first shift, then requires exact continuity", async () => {
    const first = await openShift(
      { branchId: 1, openingBalance: "123" },
      cashier,
    );
    expect(first.expectedOpening).toBeNull();
    await db()
      .update(s.shifts)
      .set({
        status: "CLOSED",
        openGuard: null,
        closedAt: new Date(),
        closingDrawerCash: "300",
      })
      .where(eq(s.shifts.id, first.shiftId));

    await expect(
      openShift(
        {
          branchId: 1,
          openingBalance: "500",
          openingDiscrepancyReason: "cash appeared without a recorded source",
        },
        { userId: 2, branchId: 1, role: "cashier" },
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await db().select().from(s.shifts)).toHaveLength(1);
  });
});
