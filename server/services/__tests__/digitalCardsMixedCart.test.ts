import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { createSupplier } from "../supplierService";
import { withTx } from "../tx";
import { money, toDbMoney } from "../money";
import { DIGITAL_SALE_CAPABILITY, createSaleInTx } from "../sale/create";
import {
  finalizeService,
  intentService,
  offeringService,
  pricingService,
  providerService,
  walletService,
} from "../digitalCards";
import {
  assertCheckoutReplay,
  checkoutSnapshotToSaleLines,
  prepareCheckoutSnapshot,
  type CheckoutSnapshotInput,
} from "../digitalCards/mixedCartService";
import { truncateAllTables } from "./__testUtils__";

const cashier = { userId: 1, branchId: 1, role: "cashier" };
const manager = { userId: 2, branchId: 1, role: "manager" };
function db() {
  const value = getDb();
  if (!value) throw new Error("Missing test DB");
  return value;
}
const ordinary = (overrides = {}) => ({
  lineKey: "ordinary-1",
  variantId: 1,
  productUnitId: 1,
  quantity: "2",
  ...overrides,
});

beforeEach(async () => {
  await truncateAllTables();
  await db()
    .insert(s.branches)
    .values({ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" });
  await db()
    .insert(s.users)
    .values([
      {
        id: 1,
        openId: "mixed-cashier",
        name: "Cashier",
        role: "cashier",
        branchId: 1,
      },
      {
        id: 2,
        openId: "mixed-manager",
        name: "Manager",
        role: "manager",
        branchId: 1,
      },
    ]);
  await db().insert(s.shifts).values({
    id: 1,
    branchId: 1,
    userId: 1,
    status: "OPEN",
    openingBalance: "0",
  });
  await db()
    .insert(s.customers)
    .values([
      { id: 1, name: "Buyer", defaultPriceTier: "RETAIL" },
      { id: 2, name: "Other buyer", defaultPriceTier: "WHOLESALE" },
    ]);
  await db()
    .insert(s.products)
    .values({ id: 1, name: "دفتر", invoiceLabel: "دفتر مدرسي" });
  await db()
    .insert(s.productVariants)
    .values({ id: 1, productId: 1, sku: "MIXED-BOOK", costPrice: "1000" });
  await db().insert(s.productUnits).values({
    id: 1,
    variantId: 1,
    unitName: "قطعة",
    conversionFactor: "1",
    isBaseUnit: true,
  });
  await db()
    .insert(s.productPrices)
    .values([
      { productUnitId: 1, priceTier: "RETAIL", price: "2000" },
      { productUnitId: 1, priceTier: "WHOLESALE", price: "1800" },
    ]);
  await db()
    .insert(s.branchStock)
    .values({ branchId: 1, variantId: 1, quantity: 10 });
});

/** Save the mixed helper output at its persistence seam; intent grouping has separate tests. */
async function fixture(
  checkout: CheckoutSnapshotInput = {
    customerId: 1,
    regularLines: [ordinary({ discountPercent: "10" })],
  },
) {
  const { supplierId } = await createSupplier(
    { name: "Mixed provider" },
    cashier,
  );
  const { providerId } = await withTx((tx) =>
    providerService.createProvider(
      tx,
      {
        supplierId,
        providerType: "TELECOM",
        settlementMode: "PREPAID",
        recognitionMode: "PRINCIPAL_GROSS",
        referencePolicy: "OPTIONAL",
        settlementCycle: "ON_DEMAND",
      },
      cashier,
    ),
  );
  const { walletId } = await withTx((tx) =>
    walletService.createWallet(
      tx,
      { providerId, branchId: 1, code: "MIXED", name: "Mixed wallet" },
      cashier,
    ),
  );
  await db()
    .update(s.digitalWallets)
    .set({ currentBalance: "100000" })
    .where(eq(s.digitalWallets.id, walletId));
  const { offeringId } = await withTx((tx) =>
    offeringService.createOffering(
      tx,
      {
        providerId,
        offeringType: "TELECOM_CARD",
        name: "Mixed card",
        faceValue: "10000",
        requiresStudentData: false,
        pricingMode: "FIXED_MARGIN",
        fixedMargin: "850",
        roundingStep: "0",
        branches: [{ branchId: 1, walletId }],
      },
      cashier,
    ),
  );
  const { batchId } = await withTx((tx) =>
    pricingService.createOrGetDraft(
      tx,
      { branchId: 1, providerId, businessDate: "2026-09-03" },
      cashier,
    ),
  );
  await withTx((tx) =>
    pricingService.saveDraft(
      tx,
      { batchId, lines: [{ offeringId, providerShare: "10000" }] },
      cashier,
    ),
  );
  await withTx((tx) => pricingService.publish(tx, { batchId }, cashier));
  const [current] = await db()
    .select()
    .from(s.digitalCurrentPrices)
    .where(eq(s.digitalCurrentPrices.offeringId, offeringId));
  const { intentId } = await withTx((tx) =>
    intentService.prepare(
      tx,
      {
        clientRequestId: `mixed-${offeringId}`,
        branchId: 1,
        shiftId: 1,
        paymentMethod: "CASH",
        cartFingerprint: `mixed-${offeringId}`,
        lines: [
          {
            lineKey: "card-1",
            offeringId,
            priceVersionId: Number(current.priceVersionId),
            expectedSellPrice: "10850",
            providerReference: `MIXED-${offeringId}`,
          },
        ],
      },
      cashier,
    ),
  );
  const snapshot = await withTx((tx) =>
    prepareCheckoutSnapshot(tx, checkout, cashier),
  );
  const expectedTotal = toDbMoney(
    money("10850").plus(snapshot.expectedSubtotal),
  );
  await db()
    .update(s.digitalSaleIntents)
    .set({ checkoutSnapshot: snapshot, expectedTotal })
    .where(eq(s.digitalSaleIntents.id, intentId));
  const [item] = await db()
    .select()
    .from(s.digitalSaleIntentItems)
    .where(eq(s.digitalSaleIntentItems.intentId, intentId));
  await withTx(async (tx) => {
    const claimToken = `mixed-claim-${intentId}`;
    await intentService.claimExecution(
      tx,
      { intentId, intentItemId: Number(item.id), claimToken },
      cashier,
    );
    await intentService.markExecution(
      tx,
      {
        intentId,
        intentItemId: Number(item.id),
        claimToken,
        status: "SUCCESS",
        providerReference: item.providerReference,
      },
      cashier,
    );
  });
  const input = {
    intentId,
    clientRequestId: `final-${intentId}`,
    customerId: snapshot.customerId,
    paymentAmount: expectedTotal,
    paymentMethod: "CASH" as const,
  };
  return { intentId, walletId, offeringId, snapshot, input };
}

describe("durable mixed digital/ordinary checkout", () => {
  it("creates one paid invoice, correct stock/COGS/wallet and price-only receipt lines", async () => {
    const f = await fixture();
    const result = await withTx((tx) =>
      finalizeService.finalize(tx, f.input, cashier),
    );
    expect(result.total).toBe("14450.00");
    expect(result.customerId).toBe(1);
    expect(result.receiptLines).toHaveLength(2);
    expect(result.printDetails[0]).toMatchObject({
      invoiceItemId: expect.any(Number),
      offeringType: "TELECOM_CARD",
      faceValue: "10000.00",
    });
    expect(
      result.receiptLines.find((line) => line.name.includes("Mixed card"))
        ?.name,
    ).toContain("القيمة الاسمية: 10000.00");
    expect(
      result.receiptLines.find((line) => line.name === "دفتر مدرسي"),
    ).toMatchObject({
      quantity: "2.000",
      unitPrice: "2000.00",
      discountAmount: "400.00",
      total: "3600.00",
    });
    expect(JSON.stringify(result)).not.toMatch(
      /unitCost|providerShare|profitSnapshot|costPrice/,
    );
    const [invoice] = await db().select().from(s.invoices);
    expect(invoice).toMatchObject({
      total: "14450.00",
      paidAmount: "14450.00",
      costTotal: "12000.00",
      customerId: 1,
    });
    const [stock] = await db()
      .select()
      .from(s.branchStock)
      .where(eq(s.branchStock.variantId, 1));
    expect(stock.quantity).toBe(8);
    const [wallet] = await db()
      .select()
      .from(s.digitalWallets)
      .where(eq(s.digitalWallets.id, f.walletId));
    expect(wallet).toMatchObject({
      currentBalance: "90000.00",
      reservedBalance: "0.00",
    });
    const [receipt] = await db().select().from(s.receipts);
    expect(receipt).toMatchObject({ amount: "14450.00", cashBucket: "DRAWER" });
    const entries = await db().select().from(s.accountingEntries);
    expect(entries.find((entry) => entry.entryType === "SALE")).toMatchObject({
      revenue: "14450.00",
      cost: "12000.00",
      profit: "2450.00",
    });
    expect(await db().select().from(s.digitalSaleDetails)).toHaveLength(1);
    const replay = await withTx((tx) =>
      finalizeService.finalize(tx, f.input, cashier),
    );
    await db()
      .update(s.digitalOfferings)
      .set({ faceValue: "20000" })
      .where(eq(s.digitalOfferings.id, f.offeringId));
    const reprint = await withTx((tx) =>
      finalizeService.finalize(tx, f.input, cashier),
    );
    expect(reprint.receiptLines).toEqual(result.receiptLines);
    expect(replay).toMatchObject({
      invoiceId: result.invoiceId,
      idempotentReplay: true,
      receiptLines: result.receiptLines,
    });
    expect(await db().select().from(s.receipts)).toHaveLength(1);
    expect(await db().select().from(s.digitalWalletTransactions)).toHaveLength(
      1,
    );
  });

  it("stock failure rolls back invoice/payment/wallet and retry commits once", async () => {
    const f = await fixture();
    await db()
      .update(s.branchStock)
      .set({ quantity: 1 })
      .where(eq(s.branchStock.variantId, 1));
    await expect(
      withTx((tx) => finalizeService.finalize(tx, f.input, cashier)),
    ).rejects.toThrow(/المخزون/);
    expect(await db().select().from(s.invoices)).toHaveLength(0);
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    expect(await db().select().from(s.digitalWalletTransactions)).toHaveLength(
      0,
    );
    const [wallet] = await db()
      .select()
      .from(s.digitalWallets)
      .where(eq(s.digitalWallets.id, f.walletId));
    expect(wallet).toMatchObject({
      currentBalance: "100000.00",
      reservedBalance: "10000.00",
    });
    await db()
      .update(s.branchStock)
      .set({ quantity: 5 })
      .where(eq(s.branchStock.variantId, 1));
    await withTx((tx) => finalizeService.finalize(tx, f.input, cashier));
    expect(await db().select().from(s.invoices)).toHaveLength(1);
  });

  it("preserves a full 255-character card identity together with its receipt descriptor", async () => {
    const f = await fixture();
    const longName = "ك".repeat(255);
    const [offering] = await db()
      .select()
      .from(s.digitalOfferings)
      .where(eq(s.digitalOfferings.id, f.offeringId));
    await db()
      .update(s.products)
      .set({ name: longName })
      .where(eq(s.products.id, Number(offering.productId)));
    const result = await withTx((tx) =>
      finalizeService.finalize(tx, f.input, cashier),
    );
    const line = result.receiptLines.find(
      (row) => row.invoiceItemId === result.printDetails[0].invoiceItemId,
    )!;
    expect(line.name.startsWith(`${longName} — `)).toBe(true);
    expect(line.name).toContain("القيمة الاسمية: 10000.00");
    expect(line.name.length).toBeGreaterThan(255);
  });

  it("binds customer and amount both before finalize and on cash replay", async () => {
    const f = await fixture();
    await expect(
      withTx((tx) =>
        finalizeService.finalize(tx, { ...f.input, customerId: 2 }, cashier),
      ),
    ).rejects.toThrow(/العميل/);
    await expect(
      withTx((tx) =>
        finalizeService.finalize(
          tx,
          { ...f.input, paymentAmount: "10850" },
          cashier,
        ),
      ),
    ).rejects.toThrow(/المقبوض/);
    await withTx((tx) => finalizeService.finalize(tx, f.input, cashier));
    await expect(
      withTx((tx) =>
        finalizeService.finalize(tx, { ...f.input, customerId: 2 }, cashier),
      ),
    ).rejects.toThrow(/العميل/);
    await expect(
      withTx((tx) =>
        finalizeService.finalize(
          tx,
          { ...f.input, paymentAmount: "1" },
          cashier,
        ),
      ),
    ).rejects.toThrow(/المقبوض/);
  });

  it("manager recovery retains the original customer and ordinary lines", async () => {
    const f = await fixture();
    await db()
      .update(s.digitalSaleIntents)
      .set({ status: "NEEDS_REVIEW" })
      .where(eq(s.digitalSaleIntents.id, f.intentId));
    const result = await withTx((tx) =>
      finalizeService.recoverNeedsReview(tx, f.intentId, manager),
    );
    expect(result).toMatchObject({ customerId: 1, total: "14450.00" });
    expect(result.receiptLines).toHaveLength(2);
    const [invoice] = await db().select().from(s.invoices);
    expect(invoice.customerId).toBe(1);
  });

  it("native cost authority still rejects cashier regular lines below live cost", async () => {
    const f = await fixture();
    await db()
      .update(s.productVariants)
      .set({ costPrice: "1900" })
      .where(eq(s.productVariants.id, 1));
    await expect(
      withTx((tx) => finalizeService.finalize(tx, f.input, cashier)),
    ).rejects.toThrow(/التكلفة/);
    expect(await db().select().from(s.invoices)).toHaveLength(0);
    await withTx((tx) => finalizeService.finalize(tx, f.input, manager));
    const [invoice] = await db().select().from(s.invoices);
    expect(invoice.costTotal).toBe("13800.00");
  });

  it("rejects an ordinary item reclassified digital after preparation without recording a partial sale", async () => {
    const f = await fixture();
    await db()
      .update(s.products)
      .set({ productType: "DIGITAL_CARD", isService: true })
      .where(eq(s.products.id, 1));
    await expect(
      withTx((tx) => finalizeService.finalize(tx, f.input, cashier)),
    ).rejects.toThrow(/لقطة تكلفة وربطاً/);
    expect(await db().select().from(s.invoices)).toHaveLength(0);
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    expect(await db().select().from(s.digitalWalletTransactions)).toHaveLength(
      0,
    );
    await expect(
      withTx((tx) =>
        createSaleInTx(
          tx,
          {
            branchId: 1,
            shiftId: 1,
            sourceType: "POS",
            lines: [
              {
                variantId: 1,
                productUnitId: 1,
                quantity: "1",
                unitCostOverride: "1000",
              },
            ],
            payment: { amount: "2000", method: "CASH" },
          },
          cashier,
          DIGITAL_SALE_CAPABILITY,
        ),
      ),
    ).rejects.toThrow(/لقطة تكلفة وربطاً/);
  });

  it("CARD evidence must cover the whole basket and consumes only once", async () => {
    const f = await fixture();
    const attemptId = extractInsertId(
      await db()
        .insert(s.externalPaymentAttempts)
        .values({
          branchId: 1,
          channel: "POS",
          paymentMethod: "CARD",
          amount: "10850",
          providerCode: "CARD",
          accountReference: "BRANCH:1:CARD",
          deviceId: "mixed-device",
          externalReference: "MIXED-CARD-PAY",
          normalizedReference: "MIXED-CARD-PAY",
          state: "CONFIRMED",
          requestId: `mixed-proof-${f.intentId}`,
          createdBy: 1,
          confirmedBy: 1,
          confirmedAt: new Date(),
        }),
    );
    await db()
      .update(s.digitalSaleIntents)
      .set({
        paymentMethod: "CARD",
        externalPaymentAttemptId: attemptId,
        externalPaymentDeviceId: "mixed-device",
      })
      .where(eq(s.digitalSaleIntents.id, f.intentId));
    const input = {
      ...f.input,
      paymentMethod: "CARD" as const,
      externalPaymentAttemptId: attemptId,
      deviceId: "mixed-device",
    };
    await expect(
      withTx((tx) => finalizeService.finalize(tx, input, cashier)),
    ).rejects.toThrow(/الإثبات/);
    expect(await db().select().from(s.invoices)).toHaveLength(0);
    await db()
      .update(s.externalPaymentAttempts)
      .set({ amount: f.input.paymentAmount })
      .where(eq(s.externalPaymentAttempts.id, attemptId));
    const result = await withTx((tx) =>
      finalizeService.finalize(tx, input, cashier),
    );
    await withTx((tx) => finalizeService.finalize(tx, input, cashier));
    const [receipt] = await db().select().from(s.receipts);
    expect(receipt).toMatchObject({ amount: "14450.00", cashBucket: null });
    const [attempt] = await db()
      .select()
      .from(s.externalPaymentAttempts)
      .where(eq(s.externalPaymentAttempts.id, attemptId));
    expect(attempt.invoiceId).toBe(result.invoiceId);
    expect(await db().select().from(s.receipts)).toHaveLength(1);
  });
});

describe("ordinary snapshot validation", () => {
  it("rejects known stock shortage before preparation and aggregates duplicate variants", async () => {
    await expect(
      withTx((tx) =>
        prepareCheckoutSnapshot(
          tx,
          {
            regularLines: [
              ordinary({ quantity: "6" }),
              ordinary({ lineKey: "ordinary-2", quantity: "6" }),
            ],
          },
          cashier,
        ),
      ),
    ).rejects.toThrow(/المخزون غير كاف/);
    await db()
      .update(s.branchStock)
      .set({ quantity: 0 })
      .where(eq(s.branchStock.variantId, 1));
    await expect(
      withTx((tx) =>
        prepareCheckoutSnapshot(tx, { regularLines: [ordinary()] }, cashier),
      ),
    ).rejects.toThrow(/المخزون غير كاف/);
    await db()
      .update(s.products)
      .set({ allowBackorder: true })
      .where(eq(s.products.id, 1));
    await expect(
      withTx((tx) =>
        prepareCheckoutSnapshot(tx, { regularLines: [ordinary()] }, cashier),
      ),
    ).resolves.toMatchObject({ expectedSubtotal: "4000.00" });
  });

  it("preflights known cost/gift violations but does not coerce service stock to zero", async () => {
    await db()
      .update(s.productVariants)
      .set({ costPrice: "3000" })
      .where(eq(s.productVariants.id, 1));
    await expect(
      withTx((tx) =>
        prepareCheckoutSnapshot(tx, { regularLines: [ordinary()] }, cashier),
      ),
    ).rejects.toThrow(/التكلفة/);
    await db()
      .update(s.productVariants)
      .set({ costPrice: "30000" })
      .where(eq(s.productVariants.id, 1));
    await expect(
      withTx((tx) =>
        prepareCheckoutSnapshot(
          tx,
          { regularLines: [ordinary({ isGift: true })] },
          cashier,
        ),
      ),
    ).rejects.toThrow(/الهدايا/);
    await db()
      .update(s.products)
      .set({ isService: true })
      .where(eq(s.products.id, 1));
    await db().delete(s.branchStock).where(eq(s.branchStock.variantId, 1));
    await expect(
      withTx((tx) =>
        prepareCheckoutSnapshot(tx, { regularLines: [ordinary()] }, cashier),
      ),
    ).resolves.toMatchObject({ expectedSubtotal: "4000.00" });
  });

  it("uses customer tier and contracts, freezes prices and rejects changed replay payload", async () => {
    await db()
      .insert(s.customerContractPrices)
      .values({ customerId: 2, productUnitId: 1, price: "1600", createdBy: 1 });
    const input = { customerId: 2, regularLines: [ordinary()] };
    const snapshot = await withTx((tx) =>
      prepareCheckoutSnapshot(tx, input, cashier),
    );
    expect(snapshot).toMatchObject({
      priceTier: "WHOLESALE",
      expectedSubtotal: "3200.00",
    });
    expect(snapshot.regularLines[0].unitPrice).toBe("1600.00");
    await db().update(s.productPrices).set({ price: "9999" });
    expect(() => assertCheckoutReplay(snapshot, input)).not.toThrow();
    expect(() =>
      assertCheckoutReplay(snapshot, { ...input, customerId: 1 }),
    ).toThrow(/مختلفة/);
    expect(() =>
      assertCheckoutReplay(snapshot, {
        ...input,
        regularLines: [ordinary({ quantity: "3" })],
      }),
    ).toThrow(/مختلفة/);
    expect(() =>
      assertCheckoutReplay(snapshot, {
        ...input,
        regularLines: [ordinary({ unitPriceOverride: "1" })],
      }),
    ).toThrow(/مختلفة/);
  });

  it("strips cost and internal tokens, refuses digital products in ordinary lines", async () => {
    const snapshot = await withTx((tx) =>
      prepareCheckoutSnapshot(
        tx,
        {
          regularLines: [
            ordinary({ unitCostOverride: "0", internalLineToken: "forged" }),
          ],
        },
        cashier,
      ),
    );
    expect(JSON.stringify(checkoutSnapshotToSaleLines(snapshot))).not.toMatch(
      /unitCostOverride|internalLineToken/,
    );
    await expect(
      withTx((tx) =>
        createSaleInTx(
          tx,
          {
            branchId: 1,
            shiftId: 1,
            sourceType: "POS",
            lines: [
              {
                variantId: 1,
                productUnitId: 1,
                quantity: "1",
                unitCostOverride: "0",
              },
            ],
            payment: { amount: "2000", method: "CASH" },
          },
          cashier,
          DIGITAL_SALE_CAPABILITY,
        ),
      ),
    ).rejects.toThrow(/التكلفة المفروضة/);
    await db()
      .update(s.products)
      .set({ productType: "DIGITAL_CARD", isService: true })
      .where(eq(s.products.id, 1));
    await expect(
      withTx((tx) =>
        prepareCheckoutSnapshot(tx, { regularLines: [ordinary()] }, cashier),
      ),
    ).rejects.toThrow(/الكرت الرقمي/);
  });

  it("rejects duplicate keys, inactive products, invalid quantities and excessive manual discounts", async () => {
    await expect(
      withTx((tx) =>
        prepareCheckoutSnapshot(
          tx,
          { regularLines: [ordinary(), ordinary()] },
          cashier,
        ),
      ),
    ).rejects.toThrow(/مكرر/);
    await expect(
      withTx((tx) =>
        prepareCheckoutSnapshot(
          tx,
          { regularLines: [ordinary({ quantity: "0" })] },
          cashier,
        ),
      ),
    ).rejects.toThrow(/كمية/);
    await expect(
      withTx((tx) =>
        prepareCheckoutSnapshot(
          tx,
          { regularLines: [ordinary({ unitPriceOverride: "1" })] },
          cashier,
        ),
      ),
    ).rejects.toThrow(/موافقة مدير/);
    await db()
      .update(s.products)
      .set({ isActive: false })
      .where(eq(s.products.id, 1));
    await expect(
      withTx((tx) =>
        prepareCheckoutSnapshot(tx, { regularLines: [ordinary()] }, cashier),
      ),
    ).rejects.toThrow(/معطّل/);
  });
});
