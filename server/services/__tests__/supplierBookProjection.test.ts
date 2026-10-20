import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import {
  loadSupplierBookInvoiceTotals,
  loadSupplierBookSourceClaims,
  supplierBookInvoiceTotalsSql,
} from "../purchase/supplierBookProjection";
import {
  invoiceReservations,
  listSupplierPaymentSources,
  requestSupplierPayment,
} from "../purchase/supplierPayments";
import { loadPurchaseSettlements } from "../purchase/settlementProjection";
import { assertNoNativeSupplierDebtForGenericPaymentTx } from "../voucher/supplierNativePaymentGuard";
import { getAPAging, getSupplierStatement } from "../reports/apAging";
import { supplierVoucherCurrencyAmount } from "../purchase/supplierVoucherCurrency";
import { getVoucher } from "../voucher/queries";
import { previewHistoricalSupplierSettlements } from "../purchase/historicalSupplierSettlement";
import { assertAttestedPaymentEvidenceTx } from "../purchase/attestedPaymentEvidence";

const db = () => getDb()!;
const owner = { userId: 9, branchId: 1, role: "manager" };
beforeEach(async () => {
  await db()
    .insert(s.branches)
    .values({ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values({
    id: 9,
    openId: "book-owner",
    name: "مالك",
    role: "manager",
    isOwner: true,
    branchId: 1,
  });
  await db().insert(s.users).values({
    id: 7,
    openId: "book-maker",
    name: "محاسب",
    role: "accountant",
    branchId: 1,
  });
  await db()
    .insert(s.suppliers)
    .values({ id: 1, name: "مورد", currentBalance: "100000.00" });
  await db().insert(s.products).values({ id: 1, name: "صنف" });
  await db()
    .insert(s.productVariants)
    .values({ id: 1, productId: 1, variantName: "صنف", sku: "BOOK-TEST" });
  for (const [id, amount] of [
    [1, "60000.00"],
    [2, "40000.00"],
  ] as const) {
    await db()
      .insert(s.purchaseOrders)
      .values({
        id,
        poNumber: `PO-${id}`,
        supplierId: 1,
        branchId: 1,
        subtotal: amount,
        total: amount,
        paidAmount: "0.00",
        status: "RECEIVED",
      });
    const entry = extractInsertId(
      await db().insert(s.accountingEntries).values({
        entryType: "PURCHASE",
        entryDate: "2026-10-01",
        amount,
        branchId: 1,
        supplierId: 1,
        purchaseOrderId: id,
      }),
    );
    await db()
      .insert(s.purchaseOrderRevisions)
      .values({
        id,
        purchaseOrderId: id,
        revisionNo: 1,
        origin: "NATIVE",
        supplierId: 1,
        branchId: 1,
        agreedCurrency: "IQD",
        settlementType: "CREDIT",
        subtotal: amount,
        total: amount,
        taxAmount: "0.00",
        shippingCost: "0.00",
        customsCost: "0.00",
        invoiceDiscount: "0.00",
        payloadCanonical: "{}",
        payloadHash: "0".repeat(64),
        revisionReason: "اختبار",
        createdBy: 9,
      });
    await db().insert(s.purchaseOrderRevisionItems).values({
      id,
      revisionId: id,
      lineNo: 1,
      variantId: 1,
      quantity: "1.000",
      baseQuantity: 1,
      listUnitPrice: amount,
      unitPrice: amount,
      lineTotal: amount,
      productNameSnapshot: "صنف",
    });
    await db()
      .insert(s.supplierInvoices)
      .values({
        id,
        invoiceNumber: `SI-${id}`,
        clientRequestId: `book-invoice-${id}`,
        supplierId: 1,
        branchId: 1,
        status: "POSTED",
        liabilityClass: "NATIVE_AP",
        paymentGate: "OPEN",
        invoiceDate: "2026-10-01",
        currency: "IQD",
        subtotal: amount,
        totalAmount: amount,
        payloadCanonical: "{}",
        payloadHash: "0".repeat(64),
        externalInvoiceNumber: `EXT-${id}`,
        externalNumberNorm: `EXT${id}`,
        evidenceType: "OTHER",
        evidenceReference: "invoice",
        createdBy: 9,
        postingEntryId: entry,
        postedBy: 9,
        postedAt: new Date(),
      });
    await db().insert(s.supplierInvoiceLines).values({
      supplierInvoiceId: id,
      lineNo: 1,
      purchaseOrderRevisionItemId: id,
      variantId: 1,
      description: "صنف",
      invoicedBaseQuantity: 1,
      unitPriceIqd: amount,
      netAmount: amount,
      totalAmount: amount,
    });
  }
});

async function source(
  kind: "PAYMENT" | "CREDIT",
  amount: string,
  status: "APPLIED" | "PARTIALLY_REVERSED" | "REVERSED" = "APPLIED",
  reversedAmount = "0.00",
) {
  const receiptId =
    kind === "PAYMENT"
      ? extractInsertId(
          await db()
            .insert(s.receipts)
            .values({
              receiptNumber: `BOOK-${Math.random()}`,
              branchId: 1,
              direction: "OUT",
              partyType: "SUPPLIER",
              partyId: 1,
              amount,
              paymentMethod: "TRANSFER",
              status: "COMPLETED",
              approvalStatus: "APPROVED",
              createdBy: 9,
            }),
        )
      : null;
  const entryId = extractInsertId(
    await db()
      .insert(s.accountingEntries)
      .values({
        entryType: kind === "PAYMENT" ? "PAYMENT_OUT" : "RETURN",
        entryDate: "2026-10-10",
        amount: kind === "PAYMENT" ? amount : `-${amount}`,
        branchId: 1,
        supplierId: 1,
        receiptId,
      }),
  );
  const id = extractInsertId(
    await db()
      .insert(s.supplierBookSettlementSources)
      .values({
        supplierId: 1,
        branchId: 1,
        sourceAccountingEntryId: entryId,
        sourceReceiptId: receiptId,
        kind,
        amount,
        status,
        reversedAmount,
        sourceSnapshot: "{}",
        sourceHash: "0".repeat(64),
        planHash: "0".repeat(64),
        adoptionKey: `book-${entryId}`,
        adoptedBy: 9,
        reversalHistory: "[]",
      }),
  );
  return { id, entryId };
}
async function allocate(
  sourceId: number,
  supplierInvoiceId: number | null,
  amount: string,
  currencyAmount = amount,
  extra: Record<string, unknown> = {},
) {
  await db()
    .insert(s.supplierBookSettlementAllocations)
    .values({
      sourceId,
      supplierInvoiceId,
      allocatedAmount: amount,
      allocatedCurrencyAmount: currencyAmount,
      targetSnapshot: "{}",
      targetHash: "0".repeat(64),
      ...extra,
    });
}

describe("canonical supplier BOOK projection", () => {
  it("reads original BOOK payment/opening targets and independent credits without manufacturing native IDs", async () => {
    const payment = await source("PAYMENT", "60000.00");
    const openingId = extractInsertId(
      await db()
        .insert(s.accountingEntries)
        .values({
          entryType: "OPENING",
          entryDate: "2026-01-01",
          amount: "10000.00",
          branchId: 1,
          supplierId: 1,
        }),
    );
    await allocate(payment.id, 1, "50000.00");
    await allocate(payment.id, null, "10000.00", "0.00", {
      openingEntryId: openingId,
    });
    const credit = await source("CREDIT", "10000.00");
    await allocate(credit.id, 1, "10000.00");
    const [entry] = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.id, payment.entryId));
    await db()
      .update(s.receipts)
      .set({ voucherNumber: "BOOK-ORIGINAL" })
      .where(eq(s.receipts.id, entry.receiptId!));
    const voucher = (await getVoucher(entry.receiptId!))!;
    expect(voucher.supplierSettlement).toBeNull();
    expect(voucher.bookSettlement).toMatchObject({
      kind: "BOOK",
      sourceKind: "PAYMENT",
      accountingEntryId: payment.entryId,
    });
    expect(voucher.bookSettlement).not.toHaveProperty("requestId");
    expect(
      voucher.bookSettlement?.allocations.map((row) => row.targetKind),
    ).toEqual(["INVOICE", "OPENING"]);
    expect(voucher.bookSettlement?.allocations[1]).toMatchObject({
      openingEntryId: openingId,
      amount: "10000.00",
      currencyAmount: "0.00",
    });
    expect(voucher.bookSettlement?.credits[0]).toMatchObject({
      accountingEntryId: credit.entryId,
      amount: "10000.00",
    });
    expect(await db().select().from(s.supplierPayments)).toHaveLength(0);
  });
  it("separates net payment and credit, excludes opening targets, preserves permanent reversed source ownership", async () => {
    const payment = await source(
      "PAYMENT",
      "10000.00",
      "PARTIALLY_REVERSED",
      "2000.00",
    );
    const openingId = extractInsertId(
      await db().insert(s.accountingEntries).values({
        entryType: "OPENING",
        entryDate: "2026-01-01",
        amount: "4000.00",
        branchId: 1,
        supplierId: 1,
      }),
    );
    await allocate(payment.id, 1, "6000.00", "6.00", {
      reversedAmount: "1000.00",
      reversedCurrencyAmount: "1.00",
    });
    await allocate(payment.id, null, "4000.00", "0.00", {
      openingEntryId: openingId,
      reversedAmount: "1000.00",
    });
    const credit = await source("CREDIT", "0.01");
    await allocate(credit.id, 1, "0.01", "0.00");
    const reversed = await source("PAYMENT", "500.00", "REVERSED", "500.00");
    await allocate(reversed.id, 2, "500.00", "500.00", {
      reversedAmount: "500.00",
      reversedCurrencyAmount: "500.00",
    });
    const totals = await loadSupplierBookInvoiceTotals(db(), [1, 2]);
    expect(totals.get(1)).toEqual({
      paidAmount: "5000.00",
      paidCurrencyAmount: "5.00",
      creditedAmount: "0.01",
      creditedCurrencyAmount: "0.00",
    });
    expect(totals.get(2)?.paidAmount).toBe("0.00");
    const [sqlTotals] = await db()
      .select(supplierBookInvoiceTotalsSql(s.supplierInvoices.id))
      .from(s.supplierInvoices)
      .where(eq(s.supplierInvoices.id, 1));
    expect(
      Object.fromEntries(
        Object.entries(sqlTotals).map(([key, value]) => [
          key,
          Number(value).toFixed(2),
        ]),
      ),
    ).toEqual(totals.get(1));
    const claims = await loadSupplierBookSourceClaims(db(), [
      payment.entryId,
      reversed.entryId,
    ]);
    expect(claims.get(payment.entryId)?.amount).toBe("10000.00");
    expect(claims.has(reversed.entryId)).toBe(true);
  });

  it("uses BOOK in reservations, SQL source pagination and the generic native debt guard", async () => {
    const payment = await source("PAYMENT", "100000.00");
    await allocate(payment.id, 1, "60000.00");
    await allocate(payment.id, 2, "40000.00");
    const used = await invoiceReservations(db() as never, [1, 2], false);
    expect(used.posted.get(1)?.amount.toFixed(2)).toBe("60000.00");
    const page = await listSupplierPaymentSources(
      { branchId: 1, supplierId: 1, limit: 1 },
      owner,
    );
    expect(page.total).toBe(0);
    expect(page.rows).toHaveLength(0);
    await expect(
      assertNoNativeSupplierDebtForGenericPaymentTx(db() as never, 1, {
        currentRead: false,
      }),
    ).resolves.toBeUndefined();
    await db()
      .update(s.supplierBookSettlementAllocations)
      .set({ reversedAmount: "1.00", reversedCurrencyAmount: "1.00" })
      .where(eq(s.supplierBookSettlementAllocations.supplierInvoiceId, 2));
    await db()
      .update(s.supplierBookSettlementSources)
      .set({ status: "PARTIALLY_REVERSED", reversedAmount: "1.00" })
      .where(eq(s.supplierBookSettlementSources.id, payment.id));
    await expect(
      assertNoNativeSupplierDebtForGenericPaymentTx(db() as never, 1, {
        currentRead: false,
      }),
    ).rejects.toThrow(/مبلغ مستحق/);
  });

  it("keeps zero-currency documentary credit distinct from paid USD book quantity", async () => {
    await db()
      .update(s.supplierInvoices)
      .set({ currency: "USD", agreedRate: "1000.00", usdTotal: "60.00" })
      .where(eq(s.supplierInvoices.id, 1));
    await db()
      .update(s.purchaseOrders)
      .set({
        agreedCurrency: "USD",
        agreedRate: "1000.00",
        usdTotal: "60.00",
        paidAmount: "59999.99",
      })
      .where(eq(s.purchaseOrders.id, 1));
    const payment = await source("PAYMENT", "59999.99");
    await allocate(payment.id, 1, "59999.99", "60.00");
    const credit = await source("CREDIT", "0.01");
    await allocate(credit.id, 1, "0.01", "0.00");
    const orders = await db()
      .select()
      .from(s.purchaseOrders)
      .where(eq(s.purchaseOrders.id, 1));
    const result = (await loadPurchaseSettlements(db(), orders)).get(1)!;
    expect(result).toMatchObject({
      paidAmountIqd: "59999.99",
      returnedAmountIqd: "0.01",
      paidAmountCurrency: "60.00",
      returnedAmountCurrency: "0.00",
      remainingAmountIqd: "0.00",
      remainingAmountCurrency: "0.00",
      status: "CREDITED",
    });
    const reservations = await invoiceReservations(db() as never, [1], false);
    expect(reservations.creditCurrencyAmounts.get(1)?.toFixed(2)).toBe("0.00");
    expect(
      supplierVoucherCurrencyAmount(
        {
          currency: "USD",
          totalAmount: "60000.00",
          usdTotal: "60.00",
          agreedRate: "1000.00",
          legacySettledAmount: "0.00",
        },
        "59999.99",
        { amount: "0.00", currencyAmount: "0.00" },
        "0.01",
        "0.00",
      ),
    ).toBe("60.00");
  });

  it("consumes the whole mixed opening source without inflating PO paid or changing financial rows", async () => {
    const openingId = extractInsertId(
      await db().insert(s.accountingEntries).values({
        entryType: "OPENING",
        entryDate: "2026-01-01",
        amount: "10000.00",
        branchId: 1,
        supplierId: 1,
      }),
    );
    const payment = await source("PAYMENT", "100000.00");
    await allocate(payment.id, 1, "60000.00");
    await allocate(payment.id, 2, "30000.00");
    await allocate(payment.id, null, "10000.00", "0.00", {
      openingEntryId: openingId,
    });
    await db()
      .update(s.suppliers)
      .set({ currentBalance: "10000.00" })
      .where(eq(s.suppliers.id, 1));
    const before = await db().select().from(s.accountingEntries);
    const statement = await getSupplierStatement(1, { branchId: 1 });
    expect(
      statement!.purchaseOrders.map((p) => p.settlement.paidAmountIqd),
    ).toEqual(expect.arrayContaining(["60000.00", "30000.00"]));
    expect(statement!.summary.unallocatedPayments).toBe("0.00");
    expect(await db().select().from(s.accountingEntries)).toEqual(before);
    const period = await getSupplierStatement(1, {
      branchId: 1,
      from: "2026-10-10",
      to: "2026-10-10",
    });
    expect(period!.summary.unallocatedPayments).toBe("0.00");
  });

  it("keeps legacy target capacity exact after BOOK credit and full reversal despite stale PO caches", async () => {
    await db()
      .update(s.supplierInvoices)
      .set({
        origin: "LEGACY",
        liabilityClass: "LEGACY_AP",
        legacyPurchaseOrderId: 1,
        legacySettlementEvidenceHash: "1".repeat(64),
      })
      .where(eq(s.supplierInvoices.id, 1));
    await db()
      .update(s.purchaseOrders)
      .set({ paidAmount: "60000.00" })
      .where(eq(s.purchaseOrders.id, 1));
    const credit = await source("CREDIT", "60000.00");
    await allocate(credit.id, 1, "60000.00");
    const orders = await db()
      .select()
      .from(s.purchaseOrders)
      .where(eq(s.purchaseOrders.id, 1));
    expect((await loadPurchaseSettlements(db(), orders)).get(1)).toMatchObject({
      paidAmountIqd: "0.00",
      returnedAmountIqd: "60000.00",
      remainingAmountIqd: "0.00",
      status: "CREDITED",
    });
    await db()
      .update(s.supplierBookSettlementSources)
      .set({ status: "REVERSED", reversedAmount: "60000.00" })
      .where(eq(s.supplierBookSettlementSources.id, credit.id));
    await db()
      .update(s.supplierBookSettlementAllocations)
      .set({ reversedAmount: "60000.00", reversedCurrencyAmount: "60000.00" })
      .where(eq(s.supplierBookSettlementAllocations.sourceId, credit.id));
    expect((await loadPurchaseSettlements(db(), orders)).get(1)).toMatchObject({
      paidAmountIqd: "0.00",
      returnedAmountIqd: "0.00",
      remainingAmountIqd: "60000.00",
      status: "UNPAID",
    });
  });

  it("ages exact BOOK invoice targets rather than applying a second supplier FIFO estimate", async () => {
    await db()
      .update(s.accountingEntries)
      .set({ entryDate: "2020-01-01" })
      .where(eq(s.accountingEntries.purchaseOrderId, 1));
    const payment = await source("PAYMENT", "40000.00");
    await allocate(payment.id, 2, "40000.00");
    await db()
      .update(s.suppliers)
      .set({ currentBalance: "60000.00" })
      .where(eq(s.suppliers.id, 1));
    const [aging] = await getAPAging({ branchId: 1 });
    expect(aging).toMatchObject({
      unpaidTotal: "60000.00",
      d91p: "60000.00",
      d0_30: "0.00",
    });
  });

  it("blocks native over-allocation against BOOK capacity without creating financial or request rows", async () => {
    const payment = await source("PAYMENT", "50000.00");
    await allocate(payment.id, 1, "50000.00");
    const before = {
      ledger: await db().select().from(s.accountingEntries),
      receipts: await db().select().from(s.receipts),
      suppliers: await db().select().from(s.suppliers),
    };
    await expect(
      requestSupplierPayment(
        {
          supplierId: 1,
          branchId: 1,
          requestKey: "book-overcapacity",
          currency: "IQD",
          amount: "11000.00",
          currencyAmount: "11000.00",
          paymentMethod: "TRANSFER",
          externalReference: "BANK-OVER",
          evidenceType: "BANK_ADVICE",
          evidenceReference: "BANK",
          reason: "اختبار حدود التسوية",
          allocations: [
            {
              supplierInvoiceId: 1,
              invoiceVersion: 1,
              amount: "11000.00",
              currencyAmount: "11000.00",
            },
          ],
        },
        { userId: 7, branchId: 1, role: "accountant" },
      ),
    ).rejects.toThrow(/يتجاوز المتبقي/);
    expect(await db().select().from(s.supplierPaymentRequests)).toHaveLength(0);
    expect({
      ledger: await db().select().from(s.accountingEntries),
      receipts: await db().select().from(s.receipts),
      suppliers: await db().select().from(s.suppliers),
    }).toEqual(before);
  });

  it("continues a proven BOOK USD cumulative balance with the exact remaining IQD rather than inventing rate rounding", async () => {
    await db()
      .update(s.supplierInvoices)
      .set({ currency: "USD", agreedRate: "1000.00", usdTotal: "60.00" })
      .where(eq(s.supplierInvoices.id, 1));
    await db()
      .update(s.purchaseOrders)
      .set({
        agreedCurrency: "USD",
        agreedRate: "1000.00",
        usdTotal: "60.00",
        paidAmount: "33333.33",
      })
      .where(eq(s.purchaseOrders.id, 1));
    const payment = await source("PAYMENT", "33333.33");
    await allocate(payment.id, 1, "33333.33", "33.33");
    const [invoice] = await db()
      .select()
      .from(s.supplierInvoices)
      .where(eq(s.supplierInvoices.id, 1));
    const request = await requestSupplierPayment(
      {
        supplierId: 1,
        branchId: 1,
        requestKey: "book-continuation",
        currency: "USD",
        exchangeRate: "1000.0000",
        amount: "26666.67",
        currencyAmount: "26.67",
        paymentMethod: "TRANSFER",
        externalReference: "BANK-EXACT",
        evidenceType: "BANK_ADVICE",
        evidenceReference: "BANK",
        reason: "إكمال الرصيد المثبت",
        allocations: [
          {
            supplierInvoiceId: 1,
            invoiceVersion: invoice.version,
            amount: "26666.67",
            currencyAmount: "26.67",
          },
        ],
      },
      { userId: 7, branchId: 1, role: "accountant" },
    );
    expect(request.status).toBe("PENDING");
    const [stored] = await db()
      .select()
      .from(s.supplierPaymentRequests)
      .where(eq(s.supplierPaymentRequests.id, request.requestId));
    expect(JSON.parse(stored.payloadCanonical).continuedInvoiceIds).toEqual([
      1,
    ]);
    const remaining = await listSupplierPaymentSources(
      { branchId: 1, supplierId: 1 },
      owner,
    );
    expect(remaining.rows.some((row) => row.id === 1)).toBe(false);
  });

  it("prevents historical and attested paths from reusing even fully reversed BOOK source evidence", async () => {
    const payment = await source(
      "PAYMENT",
      "100000.00",
      "REVERSED",
      "100000.00",
    );
    await allocate(payment.id, 1, "60000.00", "60000.00", {
      reversedAmount: "60000.00",
      reversedCurrencyAmount: "60000.00",
    });
    await allocate(payment.id, 2, "40000.00", "40000.00", {
      reversedAmount: "40000.00",
      reversedCurrencyAmount: "40000.00",
    });
    await db()
      .update(s.suppliers)
      .set({ currentBalance: "0.00" })
      .where(eq(s.suppliers.id, 1));
    const preview = await previewHistoricalSupplierSettlements({
      supplierId: 1,
    });
    expect(preview.episodes).toHaveLength(0);
    expect(JSON.stringify(preview.excluded)).toContain(
      "PAYMENT_SOURCE_ALREADY_CLAIMED",
    );
    const [invoice] = await db()
      .select()
      .from(s.supplierInvoices)
      .where(eq(s.supplierInvoices.id, 1));
    await expect(
      assertAttestedPaymentEvidenceTx(
        db() as never,
        1,
        1,
        invoice.postingEntryId!,
        [1],
      ),
    ).rejects.toThrow(/BOOK/);
  });

  it("uses current locking BOOK reads after an earlier transaction snapshot", async () => {
    await db().transaction(async (tx) => {
      await tx.select().from(s.suppliers); // Establish REPEATABLE READ snapshot.
      const payment = await source("PAYMENT", "1000.00");
      await allocate(payment.id, 1, "1000.00");
      expect((await loadSupplierBookInvoiceTotals(tx, [1])).has(1)).toBe(false);
      expect(
        (
          await loadSupplierBookInvoiceTotals(tx, [1], { currentRead: true })
        ).get(1)?.paidAmount,
      ).toBe("1000.00");
    });
  });
});
