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
  posCardsService,
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

async function seedRecipeBackedService(options: {
  active?: boolean;
  withLine?: boolean;
  qtyPerOutputBase?: string;
  materialCost?: string;
} = {}) {
  await db()
    .insert(s.products)
    .values({ id: 5, name: "خدمة اختبار", productType: "PRINT_SERVICE", isService: true });
  await db()
    .insert(s.productVariants)
    .values({ id: 5, productId: 5, sku: "SVC-TEST", costPrice: "0" });
  await db().insert(s.productUnits).values({
    id: 5,
    variantId: 5,
    unitName: "خدمة",
    conversionFactor: "1",
    isBaseUnit: true,
  });
  await db()
    .insert(s.productPrices)
    .values({ productUnitId: 5, priceTier: "RETAIL", price: "500" });
  await db().insert(s.products).values({ id: 6, name: "مادة اختبار" });
  await db()
    .insert(s.productVariants)
    .values({ id: 6, productId: 6, sku: "MAT-TEST", costPrice: options.materialCost ?? "30000" });
  await db()
    .insert(s.branchStock)
    .values({ variantId: 6, branchId: 1, quantity: 100 });
  await db().insert(s.productionRecipes).values({
    id: 1,
    name: "[خدمة اختبار]",
    outputVariantId: 5,
    outputProductUnitId: 5,
    laborPerOutputBase: "0",
    wasteStdPct: "0",
    isActive: options.active ?? true,
  });
  if (options.withLine !== false) {
    await db()
      .insert(s.productionRecipeLines)
      .values({
        recipeId: 1,
        inputVariantId: 6,
        qtyPerOutputBase: options.qtyPerOutputBase ?? "1.0000",
      });
  }
  return ordinary({ variantId: 5, productUnitId: 5, quantity: "1" });
}

async function expectServiceRecipeRejected(
  line: ReturnType<typeof ordinary>,
  expected: RegExp,
) {
  await expect(
    withTx((tx) =>
      prepareCheckoutSnapshot(tx, { regularLines: [line] }, cashier),
    ),
  ).rejects.toThrow(expected);
  await expect(
    withTx((tx) =>
      createSaleInTx(
        tx,
        {
          branchId: 1,
          shiftId: 1,
          sourceType: "POS",
          lines: [{
            variantId: line.variantId,
            productUnitId: line.productUnitId,
            quantity: line.quantity,
          }],
          payment: { amount: "500", method: "CASH" },
        },
        cashier,
        DIGITAL_SALE_CAPABILITY,
      ),
    ),
  ).rejects.toThrow(expected);
}

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
  const [offering] = await db()
    .select()
    .from(s.digitalOfferings)
    .where(eq(s.digitalOfferings.id, offeringId));
  const draftSnapshot = await withTx((tx) =>
    prepareCheckoutSnapshot(tx, checkout, cashier),
  );
  const expectedTotal = toDbMoney(
    money("10850").plus(draftSnapshot.expectedSubtotal),
  );
  const clientRequestId = `mixed-cart-${offeringId}`;
  const priceTier = checkout.priceTier ?? (checkout.customerId === 2 ? "WHOLESALE" : "RETAIL");
  const sourceRegularLines = (checkout.regularLines ?? []).map((line) => ({
    variantId: line.variantId,
    productUnitId: line.productUnitId,
    quantity: line.quantity,
    ...(line.unitPriceOverride != null ? { unitPriceOverride: line.unitPriceOverride } : {}),
    ...(line.discountPercent != null ? { discountPercent: line.discountPercent } : {}),
    ...(line.discountAmount != null ? { discountAmount: line.discountAmount } : {}),
    ...(line.isGift === true ? { isGift: true } : {}),
  }));
  const { intentId } = await withTx((tx) =>
    intentService.prepare(
      tx,
      {
        clientRequestId,
        branchId: 1,
        shiftId: 1,
        paymentMethod: "CASH",
        cartFingerprint: `mixed-${offeringId}`,
        customerId: checkout.customerId,
        priceTier,
        dueDate: checkout.dueDate,
        notes: checkout.notes,
        sourceType: "INVOICE",
        sourcePayload: {
          branchId: 1,
          shiftId: 1,
          ...(checkout.customerId != null ? { customerId: checkout.customerId } : {}),
          priceTier,
          clientRequestId,
          ...(checkout.dueDate ? { dueDate: checkout.dueDate } : {}),
          ...(checkout.notes ? { notes: checkout.notes } : {}),
          payment: { amount: expectedTotal, method: "CASH" },
          lines: [
            ...sourceRegularLines,
            {
              variantId: Number(offering.variantId),
              productUnitId: Number(offering.productUnitId),
              quantity: "1",
              unitPriceOverride: "10850",
              internalLineToken: "card-1",
            },
          ],
        },
        regularLines: checkout.regularLines,
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
  const [intent] = await db().select().from(s.digitalSaleIntents)
    .where(eq(s.digitalSaleIntents.id, intentId));
  const snapshot = intent.checkoutSnapshot!;
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
    paymentAmount: intent.expectedTotal,
    paymentMethod: "CASH" as const,
  };
  return { intentId, walletId, offeringId, snapshot, input };
}

async function seedPostpaidDigitalCard() {
  const { supplierId } = await createSupplier(
    { name: "Preflight provider" },
    cashier,
  );
  const { providerId } = await withTx((tx) =>
    providerService.createProvider(
      tx,
      {
        supplierId,
        providerType: "TELECOM",
        settlementMode: "POSTPAID",
        recognitionMode: "PRINCIPAL_GROSS",
        referencePolicy: "OPTIONAL",
        settlementCycle: "ON_DEMAND",
      },
      cashier,
    ),
  );
  const offering = await withTx((tx) =>
    offeringService.createOffering(
      tx,
      {
        providerId,
        offeringType: "TELECOM_CARD",
        name: "Preflight card",
        faceValue: "10000",
        pricingMode: "FIXED_MARGIN",
        fixedMargin: "850",
        roundingStep: "0",
        branches: [{ branchId: 1 }],
      },
      cashier,
    ),
  );
  const { batchId } = await withTx((tx) =>
    pricingService.createOrGetDraft(
      tx,
      { branchId: 1, providerId, businessDate: "2026-09-17" },
      cashier,
    ),
  );
  await withTx((tx) =>
    pricingService.saveDraft(
      tx,
      {
        batchId,
        lines: [{ offeringId: offering.offeringId, providerShare: "10000" }],
      },
      cashier,
    ),
  );
  await withTx((tx) => pricingService.publish(tx, { batchId }, cashier));
  const [current] = await db()
    .select({ priceVersionId: s.digitalCurrentPrices.priceVersionId })
    .from(s.digitalCurrentPrices)
    .where(eq(s.digitalCurrentPrices.offeringId, offering.offeringId));
  return {
    ...offering,
    providerId,
    priceVersionId: Number(current.priceVersionId),
  };
}

function digitalPrepareInput(
  card: Awaited<ReturnType<typeof seedPostpaidDigitalCard>>,
  suffix: string,
) {
  return {
    clientRequestId: `preflight-${suffix}`,
    branchId: 1,
    shiftId: 1,
    paymentMethod: "CASH",
    cartFingerprint: `preflight-${suffix}`,
    lines: [{
      lineKey: "card-1",
      offeringId: card.offeringId,
      priceVersionId: card.priceVersionId,
      expectedSellPrice: "10850",
      providerReference: `PREFLIGHT-${suffix}`,
    }],
  };
}

describe("digital catalog preflight", () => {
  it("rejects linking an offering to a non-DIGITAL_CARD product", async () => {
    const card = await seedPostpaidDigitalCard();
    await expect(
      withTx((tx) =>
        offeringService.createOffering(
          tx,
          {
            providerId: card.providerId,
            productId: 1,
            offeringType: "TELECOM_CARD",
            name: "Wrong catalog type",
            pricingMode: "FIXED_MARGIN",
            branches: [{ branchId: 1 }],
          },
          cashier,
        ),
      ),
    ).rejects.toThrow(/DIGITAL_CARD|بطاقة رقمية/);
  });

  it("hides cards whose product, variant, unit, or branch is disabled", async () => {
    const card = await seedPostpaidDigitalCard();
    await expect(
      posCardsService.listCards(db(), { branchId: 1 }),
    ).resolves.toHaveLength(1);

    await db().update(s.products).set({ isActive: false })
      .where(eq(s.products.id, card.productId));
    await expect(posCardsService.listCards(db(), { branchId: 1 })).resolves.toHaveLength(0);
    await db().update(s.products).set({ isActive: true })
      .where(eq(s.products.id, card.productId));
    await db().update(s.productVariants).set({ isActive: false })
      .where(eq(s.productVariants.id, card.variantId));
    await expect(posCardsService.listCards(db(), { branchId: 1 })).resolves.toHaveLength(0);
    await db().update(s.productVariants).set({ isActive: true })
      .where(eq(s.productVariants.id, card.variantId));
    await db().update(s.productUnits).set({ isActive: false })
      .where(eq(s.productUnits.id, card.productUnitId));
    await expect(posCardsService.listCards(db(), { branchId: 1 })).resolves.toHaveLength(0);
    await db().update(s.productUnits).set({ isActive: true })
      .where(eq(s.productUnits.id, card.productUnitId));
    await db().update(s.branches).set({ isActive: false })
      .where(eq(s.branches.id, 1));
    await expect(posCardsService.listCards(db(), { branchId: 1 })).resolves.toHaveLength(0);
  });

  it("rejects prepare for a disabled or wrongly typed offering catalog", async () => {
    const card = await seedPostpaidDigitalCard();
    await db().update(s.digitalOfferings).set({ isActive: false })
      .where(eq(s.digitalOfferings.id, card.offeringId));
    await expect(
      withTx((tx) => intentService.prepare(tx, digitalPrepareInput(card, "disabled"), cashier)),
    ).rejects.toThrow(/متاحة|معطّل/);

    await db().update(s.digitalOfferings).set({ isActive: true })
      .where(eq(s.digitalOfferings.id, card.offeringId));
    await db().update(s.products).set({ productType: "PRINT_SERVICE" })
      .where(eq(s.products.id, card.productId));
    await expect(
      withTx((tx) => intentService.prepare(tx, digitalPrepareInput(card, "wrong-type"), cashier)),
    ).rejects.toThrow(/الكتالوج|غير صالح/);
  });

  it("rejects issuance when the linked unit is disabled after prepare", async () => {
    const card = await seedPostpaidDigitalCard();
    const prepared = await withTx((tx) =>
      intentService.prepare(tx, digitalPrepareInput(card, "issue"), cashier),
    );
    const [item] = await db()
      .select({ id: s.digitalSaleIntentItems.id })
      .from(s.digitalSaleIntentItems)
      .where(eq(s.digitalSaleIntentItems.intentId, prepared.intentId));
    await db().update(s.productUnits).set({ isActive: false })
      .where(eq(s.productUnits.id, card.productUnitId));

    await expect(
      withTx((tx) =>
        intentService.claimExecution(
          tx,
          {
            intentId: prepared.intentId,
            intentItemId: Number(item.id),
            claimToken: "claim-disabled-unit",
          },
          cashier,
        ),
      ),
    ).rejects.toThrow(/عُطّلت|صالحة|معطّل/);
    const [intent] = await db().select({ status: s.digitalSaleIntents.status })
      .from(s.digitalSaleIntents)
      .where(eq(s.digitalSaleIntents.id, prepared.intentId));
    expect(intent.status).toBe("PREPARED");
  });
});

describe("durable mixed digital/ordinary checkout", () => {
  it("يرفض إنشاء فاتورة رقمية جديدة عبر CARD قبل أي نية أو حجز", async () => {
    const seeded = await fixture();
    const [offering] = await db()
      .select()
      .from(s.digitalOfferings)
      .where(eq(s.digitalOfferings.id, seeded.offeringId));
    const [current] = await db()
      .select()
      .from(s.digitalCurrentPrices)
      .where(eq(s.digitalCurrentPrices.offeringId, seeded.offeringId));
    const requestId = "invoice-card-must-fail-before-reserve";
    const before = await db().select().from(s.digitalSaleIntents);

    await expect(
      withTx((tx) =>
        intentService.prepare(
          tx,
          {
            clientRequestId: requestId,
            branchId: 1,
            shiftId: 1,
            paymentMethod: "CARD",
            cartFingerprint: requestId,
            priceTier: "RETAIL",
            sourceType: "INVOICE",
            sourcePayload: {
              branchId: 1,
              shiftId: 1,
              priceTier: "RETAIL",
              clientRequestId: requestId,
              lines: [
                {
                  variantId: Number(offering.variantId),
                  productUnitId: Number(offering.productUnitId),
                  quantity: "1",
                  unitPriceOverride: "10850.00",
                  internalLineToken: "invoice-card-line",
                },
              ],
            },
            lines: [
              {
                lineKey: "invoice-card-line",
                offeringId: seeded.offeringId,
                priceVersionId: Number(current.priceVersionId),
                expectedSellPrice: "10850.00",
                providerReference: "INVOICE-CARD-BLOCKED",
              },
            ],
          },
          cashier,
        ),
      ),
    ).rejects.toThrow(/الربط الذري|موقوف/);

    await expect(
      withTx((tx) =>
        intentService.prepare(
          tx,
          {
            clientRequestId: "pos-card-must-fail-before-reserve",
            branchId: 1,
            shiftId: 1,
            paymentMethod: "CARD",
            cartFingerprint: "pos-card-must-fail-before-reserve",
            lines: [
              {
                lineKey: "pos-card-line",
                offeringId: seeded.offeringId,
                priceVersionId: Number(current.priceVersionId),
                expectedSellPrice: "10850.00",
                providerReference: "POS-CARD-BLOCKED",
              },
            ],
          },
          cashier,
        ),
      ),
    ).rejects.toThrow(/الربط الذري|موقوف/);

    expect(await db().select().from(s.digitalSaleIntents)).toHaveLength(before.length);
  });

  it("يعيد getIntent صافي السطر الرقمي بعد الخصم لا سعر القائمة", async () => {
    const seeded = await fixture();
    const [offering] = await db()
      .select()
      .from(s.digitalOfferings)
      .where(eq(s.digitalOfferings.id, seeded.offeringId));
    const [current] = await db()
      .select()
      .from(s.digitalCurrentPrices)
      .where(eq(s.digitalCurrentPrices.offeringId, seeded.offeringId));
    const requestId = "invoice-discounted-net-display";
    const preparedInvoice = await withTx((tx) =>
      intentService.prepare(
        tx,
        {
          clientRequestId: requestId,
          branchId: 1,
          shiftId: 1,
          paymentMethod: "CASH",
          cartFingerprint: requestId,
          priceTier: "RETAIL",
          sourceType: "INVOICE",
          sourcePayload: {
            branchId: 1,
            shiftId: 1,
            priceTier: "RETAIL",
            clientRequestId: requestId,
            payment: { amount: "10849.00", method: "CASH" },
            lines: [
              {
                variantId: Number(offering.variantId),
                productUnitId: Number(offering.productUnitId),
                quantity: "1",
                unitPriceOverride: "10850.00",
                discountAmount: "1.00",
                internalLineToken: "discounted-card-line",
              },
            ],
          },
          lines: [
            {
              lineKey: "discounted-card-line",
              offeringId: seeded.offeringId,
              priceVersionId: Number(current.priceVersionId),
              expectedSellPrice: "10850.00",
              providerReference: "DISCOUNTED-NET-DISPLAY",
            },
          ],
        },
        cashier,
      ),
    );

    const read = await intentService.getIntent(db(), preparedInvoice.intentId);
    expect(read?.items[0]).toMatchObject({
      sellPrice: "10850.00",
      chargeAmount: "10849.00",
    });
  });

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

  it("cost changes after issuance do not orphan the card and final COGS uses live cost", async () => {
    const f = await fixture();
    await db()
      .update(s.productVariants)
      .set({ costPrice: "1900" })
      .where(eq(s.productVariants.id, 1));
    await withTx((tx) => finalizeService.finalize(tx, f.input, cashier));
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
    ).rejects.toThrow(/مسار الإصدار المخصّص|لا تُضاف كصنف عادي|لقطة تكلفة وربطاً/);
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
        ),
      ),
    ).rejects.toThrow(/مسار الإصدار المخصّص|لا تُضاف كصنف عادي|لقطة تكلفة وربطاً/);
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
    const [preparedIntent] = await db().select().from(s.digitalSaleIntents)
      .where(eq(s.digitalSaleIntents.id, f.intentId));
    const checkoutSnapshot = preparedIntent.checkoutSnapshot!;
    await db()
      .update(s.digitalSaleIntents)
      .set({
        paymentMethod: "CARD",
        externalPaymentAttemptId: attemptId,
        externalPaymentDeviceId: "mixed-device",
        checkoutSnapshot: {
          ...checkoutSnapshot,
          sourcePayload: {
            ...checkoutSnapshot.sourcePayload,
            deviceId: "mixed-device",
            payment: {
              amount: f.input.paymentAmount,
              method: "CARD",
              externalPaymentAttemptId: attemptId,
            },
          },
        },
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

  it("aggregates an ordinary line with the same variant consumed by a service recipe", async () => {
    const serviceLine = await seedRecipeBackedService({ materialCost: "100" });
    await db()
      .update(s.productionRecipeLines)
      .set({ inputVariantId: 1 })
      .where(eq(s.productionRecipeLines.recipeId, 1));
    await expect(
      withTx((tx) =>
        prepareCheckoutSnapshot(
          tx,
          {
            regularLines: [
              ordinary({ quantity: "6" }),
              {
                ...serviceLine,
                lineKey: "service-1",
                quantity: "5",
              },
            ],
          },
          manager,
        ),
      ),
    ).rejects.toThrow(/المخزون غير كاف/);
  });

  it("includes bundle components in the aggregate and rejects inactive or ineligible components", async () => {
    await db().insert(s.products).values({
      id: 7,
      name: "بكج اختبار",
      isBundle: true,
    });
    await db().insert(s.productVariants).values({
      id: 7,
      productId: 7,
      sku: "BUNDLE-TEST",
      costPrice: "0",
    });
    await db().insert(s.productUnits).values({
      id: 7,
      variantId: 7,
      unitName: "بكج",
      conversionFactor: "1",
      isBaseUnit: true,
    });
    await db().insert(s.productPrices).values({
      productUnitId: 7,
      priceTier: "RETAIL",
      price: "5000",
    });
    await db().insert(s.bundleComponents).values({
      bundleVariantId: 7,
      componentVariantId: 1,
      componentBaseQuantity: 2,
      sortOrder: 0,
    });
    const bundleLine = ordinary({
      lineKey: "bundle-1",
      variantId: 7,
      productUnitId: 7,
      quantity: "5",
    });
    await expect(
      withTx((tx) =>
        prepareCheckoutSnapshot(
          tx,
          { regularLines: [ordinary({ quantity: "1" }), bundleLine] },
          cashier,
        ),
      ),
    ).rejects.toThrow(/المخزون غير كاف/);

    await db().update(s.products).set({ isActive: false })
      .where(eq(s.products.id, 1));
    await expect(
      withTx((tx) =>
        prepareCheckoutSnapshot(
          tx,
          { regularLines: [{ ...bundleLine, quantity: "1" }] },
          cashier,
        ),
      ),
    ).rejects.toThrow(/معطّل/);

    await db().update(s.products).set({ isActive: true, isService: true })
      .where(eq(s.products.id, 1));
    await expect(
      withTx((tx) =>
        prepareCheckoutSnapshot(
          tx,
          { regularLines: [{ ...bundleLine, quantity: "1" }] },
          cashier,
        ),
      ),
    ).rejects.toThrow(/لا تصلح/);
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

  it("rejects a service line priced under its recipe cost — at prepare() and createSaleInTx alike", async () => {
    const line = await seedRecipeBackedService();
    await expect(
      withTx((tx) => prepareCheckoutSnapshot(tx, { regularLines: [line] }, cashier)),
    ).rejects.toThrow(/التكلفة/);

    await expect(
      withTx((tx) =>
        createSaleInTx(
          tx,
          {
            branchId: 1,
            shiftId: 1,
            sourceType: "POS",
            lines: [{ variantId: 5, productUnitId: 5, quantity: "1" }],
            payment: { amount: "500", method: "CASH" },
          },
          cashier,
        ),
      ),
    ).rejects.toThrow(/التكلفة/);
  });

  it("rejects a disabled service recipe instead of treating it as labor-only", async () => {
    const line = await seedRecipeBackedService({ active: false, materialCost: "100" });
    await expectServiceRecipeRejected(line, /وصفة مواد الخدمة.*معطلة/);
  });

  it("rejects insufficient service materials during prepare before reserving digital cards", async () => {
    const line = await seedRecipeBackedService({ materialCost: "100" });
    await db().update(s.branchStock).set({ quantity: 0 })
      .where(eq(s.branchStock.variantId, 6));
    await expectServiceRecipeRejected(line, /مادة الخدمة.*غير كاف|المخزون غير كاف/i);
    expect(await db().select().from(s.invoices)).toHaveLength(0);
    expect(await db().select().from(s.inventoryMovements)).toHaveLength(0);
  });

  it("rejects an active service recipe with no material lines", async () => {
    const line = await seedRecipeBackedService({ withLine: false, materialCost: "100" });
    await expectServiceRecipeRejected(line, /فعالة لكنها بلا مواد/);
  });

  it("rejects fractional recipe consumption instead of rounding inventory quantity", async () => {
    const line = await seedRecipeBackedService({ qtyPerOutputBase: "0.5000", materialCost: "100" });
    await expectServiceRecipeRejected(line, /كمية كسرية/);
  });

  it("accepts exact fractional scaling when 0.5×2 equals one base unit", async () => {
    const line = await seedRecipeBackedService({
      qtyPerOutputBase: "0.5000",
      materialCost: "100",
    });
    line.quantity = "2";
    await expect(
      withTx((tx) =>
        prepareCheckoutSnapshot(tx, { regularLines: [line] }, cashier),
      ),
    ).resolves.toMatchObject({ expectedSubtotal: "1000.00" });
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
