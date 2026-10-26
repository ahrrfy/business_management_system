import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { withGovernanceTx } from "../tx";
import { money, toDbMoney } from "../money";
import { sha256 } from "../purchase/grniAccounting";
import {
  applyPurchasePriorPaymentInTx,
  listPurchasePriorPayments,
} from "../purchase/priorPayment";
import { loadSupplierBookInvoiceTotals } from "../purchase/supplierBookProjection";
import { unapplySupplierBookSettlementSourceTx } from "../purchase/supplierBookSettlement";
import { truncateTables } from "./__testUtils__";
import {
  capturePurchaseTenderTx,
  listPurchaseTenderSources,
} from "../purchase/tender";
import { listSupplierAdvanceRefundSources } from "../purchase/advanceRefund";

const db = () => getDb()!;
const actor = { userId: 9, branchId: 1, role: "manager" };
const tables = [
  "auditLogs",
  "supplierBookSettlementAllocations",
  "supplierBookSettlementSources",
  "supplierPaymentAllocations",
  "supplierPayments",
  "supplierPaymentRequestAllocations",
  "supplierPaymentRequests",
  "supplierInvoiceLines",
  "supplierInvoices",
  "accountingEntries",
  "receipts",
  "purchaseOrderRevisionItems",
  "purchaseOrderRevisions",
  "purchaseOrders",
  "productVariants",
  "products",
  "suppliers",
  "users",
  "branches",
] as const;

beforeEach(async () => {
  await truncateTables(tables);
  await db()
    .insert(s.branches)
    .values([
      { id: 1, name: "MAIN", code: "MAIN", type: "MAIN" },
      { id: 2, name: "OTHER", code: "OTHER", type: "SALES" },
    ]);
  await db()
    .insert(s.users)
    .values([
      {
        id: 7,
        openId: "prior-maker",
        name: "Maker",
        role: "purchasing",
        branchId: 1,
      },
      {
        id: 9,
        openId: "prior-owner",
        name: "Owner",
        role: "manager",
        branchId: 1,
        isOwner: true,
      },
    ]);
  await db()
    .insert(s.suppliers)
    .values([
      { id: 1, name: "Advance Supplier", currentBalance: "0.00" },
      { id: 2, name: "Other Supplier", currentBalance: "0.00" },
    ]);
  await db().insert(s.products).values({ id: 1, name: "Paper" });
  await db()
    .insert(s.productVariants)
    .values({ id: 1, productId: 1, sku: "PRIOR-PAPER" });
});

async function addInvoice(id: number, total = "100.00") {
  await db()
    .insert(s.purchaseOrders)
    .values({
      id,
      poNumber: `PRIOR-PO-${id}`,
      supplierId: 1,
      branchId: 1,
      createdBy: 7,
      status: "RECEIVED",
      settlementType: "CASH",
      subtotal: total,
      total,
      agreedCurrency: "IQD",
      orderDate: new Date("2026-01-02T00:00:00Z"),
    });
  const revisionId = extractInsertId(
    await db()
      .insert(s.purchaseOrderRevisions)
      .values({
        purchaseOrderId: id,
        revisionNo: 1,
        origin: "NATIVE",
        supplierId: 1,
        branchId: 1,
        agreedCurrency: "IQD",
        settlementType: "CASH",
        subtotal: total,
        taxAmount: "0",
        shippingCost: "0",
        customsCost: "0",
        invoiceDiscount: "0",
        total,
        payloadCanonical: "{}",
        payloadHash: String(id).padStart(64, "0"),
        revisionReason: "prior payment fixture",
        createdBy: 7,
      }),
  );
  const revisionItemId = extractInsertId(
    await db().insert(s.purchaseOrderRevisionItems).values({
      revisionId,
      lineNo: 1,
      variantId: 1,
      quantity: "1",
      baseQuantity: 1,
      listUnitPrice: total,
      unitPrice: total,
      lineTotal: total,
      productNameSnapshot: "Paper",
    }),
  );
  const postingEntryId = extractInsertId(
    await db()
      .insert(s.accountingEntries)
      .values({
        entryType: "PURCHASE",
        entryDate: new Date("2026-01-02T00:00:00Z"),
        supplierId: 1,
        branchId: 1,
        purchaseOrderId: id,
        amount: total,
        purchaseLiabilityAccount: "AP",
        createdBy: 7,
      }),
  );
  await db()
    .insert(s.supplierInvoices)
    .values({
      id,
      invoiceNumber: `PRIOR-SI-${id}`,
      clientRequestId: `PRIOR-SI-${id}`,
      origin: "NATIVE",
      liabilityClass: "NATIVE_AP",
      paymentGate: "OPEN",
      supplierId: 1,
      branchId: 1,
      status: "POSTED",
      invoiceDate: "2026-01-02",
      currency: "IQD",
      subtotal: total,
      totalAmount: total,
      payloadCanonical: "{}",
      payloadHash: String(id).padStart(64, "1"),
      evidenceType: "OTHER",
      externalInvoiceNumber: `EXTERNAL-${id}`,
      externalNumberNorm: `EXTERNAL${id}`,
      evidenceReference: `EVIDENCE-${id}`,
      createdBy: 7,
      postingEntryId,
      postedBy: 9,
      postedAt: new Date("2026-01-02T00:00:00Z"),
    });
  await db().insert(s.supplierInvoiceLines).values({
    supplierInvoiceId: id,
    lineNo: 1,
    purchaseOrderRevisionItemId: revisionItemId,
    variantId: 1,
    description: "Paper",
    invoicedBaseQuantity: 1,
    unitPriceIqd: total,
    netAmount: total,
    totalAmount: total,
  });
  await db()
    .update(s.suppliers)
    .set({ currentBalance: sql`${s.suppliers.currentBalance} + ${total}` })
    .where(eq(s.suppliers.id, 1));
}

async function fixture(payment = "150.00", total = "100.00") {
  await addInvoice(1, total);
  const receiptId = extractInsertId(
    await db()
      .insert(s.receipts)
      .values({
        direction: "OUT",
        branchId: 1,
        amount: payment,
        paymentMethod: "CARD",
        partyType: "SUPPLIER",
        partyId: 1,
        voucherNumber: "PRIOR-VOUCHER",
        referenceNumber: "CARD-PRIOR-REFERENCE",
        cardLastFour: "1234",
        voucherDate: new Date("2026-01-01T00:00:00Z"),
        createdBy: 7,
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        approvedBy: 9,
        approvedAt: new Date("2026-01-01T00:00:00Z"),
      }),
  );
  const entryId = extractInsertId(
    await db()
      .insert(s.accountingEntries)
      .values({
        entryType: "PAYMENT_OUT",
        entryDate: new Date("2026-01-01T00:00:00Z"),
        supplierId: 1,
        branchId: 1,
        receiptId,
        amount: payment,
        createdBy: 7,
      }),
  );
  await db()
    .update(s.suppliers)
    .set({ currentBalance: sql`${s.suppliers.currentBalance} - ${payment}` })
    .where(eq(s.suppliers.id, 1));
  return { receiptId, entryId };
}

const apply = (receiptId: number, invoiceId = 1) =>
  withGovernanceTx((tx) =>
    applyPurchasePriorPaymentInTx(tx, {
      receiptId,
      invoiceId,
      purchaseOrderId: invoiceId,
      actor,
    }),
  );

async function paid(invoiceId: number) {
  return (
    (await loadSupplierBookInvoiceTotals(db(), [invoiceId])).get(invoiceId)
      ?.paidAmount ?? "0.00"
  );
}
async function moneyTrail() {
  const [supplier] = await db()
    .select()
    .from(s.suppliers)
    .where(eq(s.suppliers.id, 1));
  return {
    balance: supplier.currentBalance,
    receipts: await db().select().from(s.receipts),
    entries: await db().select().from(s.accountingEntries),
  };
}

describe("purchase prior payment allocation", () => {
  it("filters more than500 native payments before listing an eligible prior/refund source", async () => {
    const { receiptId } = await fixture();
    const base = receiptId + 1000;
    const history = Array.from({ length: 501 }, (_, index) => ({
      id: base + index,
      key: `NATIVE-HISTORY-${index}`,
    }));
    await db()
      .insert(s.receipts)
      .values(
        history.map(({ id, key }) => ({
          id,
          direction: "OUT" as const,
          branchId: 1,
          amount: "1",
          paymentMethod: "CARD" as const,
          partyType: "SUPPLIER" as const,
          partyId: 1,
          voucherNumber: key,
          referenceNumber: key,
          createdBy: 7,
          status: "COMPLETED" as const,
          approvalStatus: "APPROVED" as const,
        })),
      );
    await db()
      .insert(s.accountingEntries)
      .values(
        history.map(({ id }) => ({
          id,
          receiptId: id,
          entryType: "PAYMENT_OUT" as const,
          branchId: 1,
          supplierId: 1,
          amount: "1",
          createdBy: 7,
          entryDate: new Date("2026-01-01T00:00:00Z"),
        })),
      );
    await db()
      .insert(s.supplierPaymentRequests)
      .values(
        history.map(({ id, key }) => ({
          id,
          requestKey: key,
          supplierId: 1,
          branchId: 1,
          currency: "IQD" as const,
          requestedAmount: "1",
          requestedCurrencyAmount: "1",
          paymentMethod: "CARD" as const,
          externalReference: key,
          payloadCanonical: "{}",
          payloadHash: sha256(key),
          evidenceType: "BANK_ADVICE" as const,
          evidenceReference: key,
          evidenceHash: sha256(key),
          reason: "posted native history fixture",
          status: "APPROVED" as const,
          requestedBy: 7,
          reviewedBy: 9,
          reviewedAt: new Date(),
          decisionKey: key,
          decisionHash: sha256(key),
          appliedAt: new Date(),
        })),
      );
    await db()
      .insert(s.supplierPayments)
      .values(
        history.map(({ id, key }) => ({
          id,
          paymentNumber: key,
          requestId: id,
          supplierId: 1,
          branchId: 1,
          currency: "IQD" as const,
          amount: "1",
          currencyAmount: "1",
          paymentMethod: "CARD" as const,
          externalReference: key,
          receiptId: id,
          accountingEntryId: id,
          payloadCanonical: "{}",
          payloadHash: sha256(key),
          postedBy: 9,
        })),
      );
    expect(
      (
        await listPurchaseTenderSources({ supplierId: 1, branchId: 1 }, actor)
      ).previousPayments.map((row) => row.id),
    ).toEqual([receiptId]);
    expect(
      (
        await listSupplierAdvanceRefundSources(
          { supplierId: 1, branchId: 1 },
          actor,
        )
      ).map((row) => row.id),
    ).toEqual([receiptId]);
    await db()
      .update(s.receipts)
      .set({ status: "REVERSED" })
      .where(eq(s.receipts.id, receiptId));
    expect(
      (await listPurchaseTenderSources({ supplierId: 1, branchId: 1 }, actor))
        .previousPayments,
    ).toEqual([]);
    expect(
      await listSupplierAdvanceRefundSources(
        { supplierId: 1, branchId: 1 },
        actor,
      ),
    ).toEqual([]);
  });

  it("keeps fully allocated advances refundable while excluding them from new prior allocations", async () => {
    const { receiptId } = await fixture("100");
    await apply(receiptId);
    expect(
      await listPurchasePriorPayments(db(), { supplierId: 1, branchId: 1 }),
    ).toEqual([]);
    expect(
      await listSupplierAdvanceRefundSources(
        { supplierId: 1, branchId: 1 },
        actor,
      ),
    ).toMatchObject([
      { id: receiptId, remainingAmount: "100.00", unusedAmount: "0.00" },
    ]);
    await expect(
      withGovernanceTx((tx) =>
        capturePurchaseTenderTx(
          tx,
          {
            supplierId: 1,
            branchId: 1,
            settlementType: "CASH",
            tender: { mode: "TREASURY", previousReceiptId: receiptId },
          },
          actor,
        ),
      ),
    ).rejects.toThrow(/غير متاحة/);
  });

  it("validates a selected receipt directly while genuinely eligible listing overflow remains closed", async () => {
    const { receiptId } = await fixture();
    const base = receiptId + 1000;
    const history = Array.from({ length: 501 }, (_, index) => ({
      id: base + index,
      key: `ELIGIBLE-HISTORY-${index}`,
    }));
    await db()
      .insert(s.receipts)
      .values(
        history.map(({ id, key }) => ({
          id,
          direction: "OUT" as const,
          branchId: 1,
          amount: "1",
          paymentMethod: "CARD" as const,
          partyType: "SUPPLIER" as const,
          partyId: 1,
          voucherNumber: key,
          referenceNumber: key,
          createdBy: 7,
          status: "COMPLETED" as const,
          approvalStatus: "APPROVED" as const,
        })),
      );
    await db()
      .insert(s.accountingEntries)
      .values(
        history.map(({ id }) => ({
          id,
          receiptId: id,
          entryType: "PAYMENT_OUT" as const,
          branchId: 1,
          supplierId: 1,
          amount: "1",
          createdBy: 7,
          entryDate: new Date("2026-01-01T00:00:00Z"),
        })),
      );
    await expect(
      listPurchasePriorPayments(db(), { supplierId: 1, branchId: 1 }),
    ).rejects.toThrow(/حد القراءة الآمنة/);
    await expect(
      listSupplierAdvanceRefundSources({ supplierId: 1, branchId: 1 }, actor),
    ).rejects.toThrow(/حد المراجعة الآمنة/);
    const input = {
      supplierId: 1,
      branchId: 1,
      settlementType: "CASH",
      tender: { mode: "TREASURY" as const, previousReceiptId: receiptId },
    };
    expect(
      await withGovernanceTx((tx) => capturePurchaseTenderTx(tx, input, actor)),
    ).toEqual(input.tender);
    await expect(
      withGovernanceTx((tx) =>
        capturePurchaseTenderTx(tx, { ...input, supplierId: 2 }, actor),
      ),
    ).rejects.toThrow(/غير متاحة/);
    await expect(
      withGovernanceTx((tx) =>
        capturePurchaseTenderTx(tx, { ...input, branchId: 2 }, actor),
      ),
    ).rejects.toThrow(/غير متاحة/);
  });
  it("consumes part of a larger prepayment, retains its remainder and replays without money or AP writes", async () => {
    const { receiptId } = await fixture();
    const before = await moneyTrail();
    const first = await apply(receiptId);
    expect(first.allocatedAmount).toBe("100.00");
    expect(await apply(receiptId)).toEqual(first);
    expect(await moneyTrail()).toEqual(before);
    expect(await paid(1)).toBe("100.00");
    expect(
      await db().select().from(s.supplierBookSettlementAllocations),
    ).toHaveLength(1);
    expect(
      await listPurchasePriorPayments(db(), { supplierId: 1, branchId: 1 }),
    ).toMatchObject([
      {
        id: receiptId,
        amount: "150.00",
        availableAmount: "50.00",
        paymentMethod: "CARD",
      },
    ]);
    const [invoice] = await db()
      .select()
      .from(s.supplierInvoices)
      .where(eq(s.supplierInvoices.id, 1));
    const [po] = await db()
      .select()
      .from(s.purchaseOrders)
      .where(eq(s.purchaseOrders.id, 1));
    expect(invoice.paymentGate).toBe("SETTLED");
    expect(po.paidAmount).toBe("100.00");
  });

  it("allocates a smaller prior payment and leaves only the unpaid invoice remainder", async () => {
    const { receiptId } = await fixture("40.00");
    expect((await apply(receiptId)).allocatedAmount).toBe("40.00");
    const [invoice] = await db()
      .select()
      .from(s.supplierInvoices)
      .where(eq(s.supplierInvoices.id, 1));
    expect(invoice.paymentGate).toBe("OPEN");
    expect(
      await listPurchasePriorPayments(db(), { supplierId: 1, branchId: 1 }),
    ).toEqual([]);
  });

  it("returns an existing native same-invoice allocation without creating a BOOK identity", async () => {
    const { receiptId, entryId } = await fixture("100.00");
    const requestId = extractInsertId(
      await db()
        .insert(s.supplierPaymentRequests)
        .values({
          requestKey: "native-prior-request",
          supplierId: 1,
          branchId: 1,
          currency: "IQD",
          requestedAmount: "100.00",
          requestedCurrencyAmount: "100.00",
          paymentMethod: "CARD",
          externalReference: "NATIVE-CARD-REF",
          payloadCanonical: "{}",
          payloadHash: "a".repeat(64),
          evidenceType: "BANK_ADVICE",
          evidenceReference: "NATIVE-CARD-REF",
          evidenceHash: "b".repeat(64),
          reason: "native prior fixture",
          status: "APPROVED",
          requestedBy: 7,
          reviewedBy: 9,
          reviewedAt: new Date(),
          decisionKey: "native-prior-decision",
          decisionHash: "c".repeat(64),
          appliedAt: new Date(),
        }),
    );
    const requestAllocationId = extractInsertId(
      await db()
        .insert(s.supplierPaymentRequestAllocations)
        .values({
          requestId,
          supplierInvoiceId: 1,
          invoiceVersion: 1,
          requestedAmount: "100.00",
          requestedCurrencyAmount: "100.00",
          invoiceSnapshot: "{}",
          invoiceHash: "d".repeat(64),
        }),
    );
    const supplierPaymentId = extractInsertId(
      await db()
        .insert(s.supplierPayments)
        .values({
          paymentNumber: "NATIVE-PRIOR-PAY",
          requestId,
          supplierId: 1,
          branchId: 1,
          currency: "IQD",
          amount: "100.00",
          currencyAmount: "100.00",
          paymentMethod: "CARD",
          externalReference: "NATIVE-CARD-REF",
          receiptId,
          accountingEntryId: entryId,
          payloadCanonical: "{}",
          payloadHash: "a".repeat(64),
          postedBy: 9,
        }),
    );
    await db()
      .insert(s.supplierPaymentAllocations)
      .values({
        supplierPaymentId,
        requestAllocationId,
        supplierInvoiceId: 1,
        allocatedAmount: "100.00",
        allocatedCurrencyAmount: "100.00",
        invoiceHash: "d".repeat(64),
      });
    await db()
      .update(s.accountingEntries)
      .set({ purchaseOrderId: 1 })
      .where(eq(s.accountingEntries.id, entryId));
    const before = await moneyTrail();
    expect(await apply(receiptId)).toEqual({
      allocatedAmount: "100.00",
      sourceId: null,
    });
    expect(
      await db().select().from(s.supplierBookSettlementSources),
    ).toHaveLength(0);
    expect(await moneyTrail()).toEqual(before);
    await addInvoice(2);
    await expect(apply(receiptId, 2)).rejects.toThrow(/فاتورة أخرى/);
    expect(
      await listPurchasePriorPayments(db(), { supplierId: 1, branchId: 1 }),
    ).toEqual([]);
  });

  it("uses the remaining advance on a second invoice exactly once", async () => {
    const { receiptId } = await fixture();
    await apply(receiptId);
    await addInvoice(2, "80.00");
    const before = await moneyTrail();
    const second = await apply(receiptId, 2);
    expect(second.allocatedAmount).toBe("50.00");
    expect(await apply(receiptId, 2)).toEqual(second);
    expect(await paid(2)).toBe("50.00");
    expect(
      await db().select().from(s.supplierBookSettlementSources),
    ).toHaveLength(1);
    expect(await moneyTrail()).toEqual(before);
    expect(
      await listPurchasePriorPayments(db(), { supplierId: 1, branchId: 1 }),
    ).toEqual([]);
  });

  it("serializes concurrent consumers without overallocating the same advance", async () => {
    const { receiptId } = await fixture();
    await addInvoice(2);
    const before = await moneyTrail();
    const results = await Promise.all([
      apply(receiptId, 1),
      apply(receiptId, 2),
    ]);
    expect(results.map((row) => row.allocatedAmount).sort()).toEqual([
      "100.00",
      "50.00",
    ]);
    expect(toDbMoney(money(await paid(1)).plus(await paid(2)))).toBe("150.00");
    expect(await moneyTrail()).toEqual(before);
  });

  it("reverses unused money first, then allocated money, preserving source ownership", async () => {
    const { receiptId } = await fixture();
    await apply(receiptId);
    const before = await moneyTrail();
    const reverse = (amount: string | undefined, reversalKey: string) =>
      withGovernanceTx((tx) =>
        unapplySupplierBookSettlementSourceTx(
          tx,
          { sourceReceiptId: receiptId, amount, reversalKey },
          actor,
        ),
      );
    await reverse("20.00", "prior-reverse-unused");
    expect(await paid(1)).toBe("100.00");
    expect(
      await listPurchasePriorPayments(db(), { supplierId: 1, branchId: 1 }),
    ).toMatchObject([{ availableAmount: "30.00" }]);
    await reverse("60.00", "prior-reverse-allocated");
    expect(await paid(1)).toBe("70.00");
    await reverse("60.00", "prior-reverse-allocated");
    expect(await paid(1)).toBe("70.00");
    await reverse(undefined, "prior-reverse-rest");
    expect(await paid(1)).toBe("0.00");
    const [source] = await db().select().from(s.supplierBookSettlementSources);
    expect(source).toMatchObject({
      status: "REVERSED",
      amount: "150.00",
      reversedAmount: "150.00",
    });
    expect(
      await listPurchasePriorPayments(db(), { supplierId: 1, branchId: 1 }),
    ).toEqual([]);
    await expect(apply(receiptId)).rejects.toThrow();
    expect(await moneyTrail()).toEqual(before);
  });

  it("reverses allocations newest first after consuming the entire advance", async () => {
    const { receiptId } = await fixture();
    await apply(receiptId);
    await addInvoice(2);
    await apply(receiptId, 2);
    await withGovernanceTx((tx) =>
      unapplySupplierBookSettlementSourceTx(
        tx,
        {
          sourceReceiptId: receiptId,
          amount: "60.00",
          reversalKey: "latest-first",
        },
        actor,
      ),
    );
    expect(await paid(1)).toBe("90.00");
    expect(await paid(2)).toBe("0.00");
  });

  it("keeps historical BOOK sources subject to full allocation invariants", async () => {
    const { receiptId } = await fixture();
    await apply(receiptId);
    const [source] = await db().select().from(s.supplierBookSettlementSources);
    const snapshot = JSON.parse(source.sourceSnapshot);
    delete snapshot.purpose;
    const sourceSnapshot = JSON.stringify(snapshot);
    await db()
      .update(s.supplierBookSettlementSources)
      .set({ sourceSnapshot, sourceHash: sha256(sourceSnapshot) })
      .where(eq(s.supplierBookSettlementSources.id, source.id));
    await expect(
      withGovernanceTx((tx) =>
        unapplySupplierBookSettlementSourceTx(
          tx,
          { sourceReceiptId: receiptId, reversalKey: "historical-invalid" },
          actor,
        ),
      ),
    ).rejects.toThrow(/تعارض مجموع/);
  });

  it("rolls back the allocation and invoice caches if later settlement fails", async () => {
    const { receiptId } = await fixture();
    await expect(
      withGovernanceTx(async (tx) => {
        await applyPurchasePriorPaymentInTx(tx, {
          receiptId,
          invoiceId: 1,
          purchaseOrderId: 1,
          actor,
        });
        throw new Error("remainder settlement failed");
      }),
    ).rejects.toThrow("remainder settlement failed");
    expect(
      await db().select().from(s.supplierBookSettlementSources),
    ).toHaveLength(0);
    expect(await paid(1)).toBe("0.00");
    const [invoice] = await db()
      .select()
      .from(s.supplierInvoices)
      .where(eq(s.supplierInvoices.id, 1));
    expect(invoice).toMatchObject({ version: 1, paymentGate: "OPEN" });
  });

  it.each([
    "supplier",
    "branch",
    "unapproved",
    "clearing",
    "duplicate-entry",
    "pending-cancel",
    "future",
    "exchange",
    "fulfillment-owned",
  ])("rejects %s source evidence", async (kind) => {
    const { receiptId, entryId } = await fixture();
    if (kind === "supplier")
      await db()
        .update(s.receipts)
        .set({ partyId: 2 })
        .where(eq(s.receipts.id, receiptId));
    if (kind === "branch")
      await db()
        .update(s.receipts)
        .set({ branchId: 2 })
        .where(eq(s.receipts.id, receiptId));
    if (kind === "unapproved")
      await db()
        .update(s.receipts)
        .set({ status: "PENDING", approvalStatus: "PENDING_APPROVAL" })
        .where(eq(s.receipts.id, receiptId));
    if (kind === "clearing")
      await db()
        .update(s.accountingEntries)
        .set({ purchaseLiabilityAccount: "CASH_CLEARING" })
        .where(eq(s.accountingEntries.id, entryId));
    if (kind === "duplicate-entry")
      await db()
        .insert(s.accountingEntries)
        .values({
          entryType: "PAYMENT_OUT",
          supplierId: 1,
          branchId: 1,
          receiptId,
          amount: "150",
          entryDate: new Date("2026-01-01T00:00:00Z"),
        });
    if (kind === "pending-cancel")
      await db()
        .insert(s.receipts)
        .values({
          direction: "IN",
          branchId: 1,
          amount: "150",
          paymentMethod: "CARD",
          partyType: "SUPPLIER",
          partyId: 1,
          createdBy: 7,
          status: "PENDING",
          approvalStatus: "PENDING_APPROVAL",
          referenceNumber: `CANCEL-VCH-${receiptId}`,
        });
    if (kind === "future")
      await db()
        .update(s.receipts)
        .set({ voucherDate: new Date("2099-01-01T00:00:00Z") })
        .where(eq(s.receipts.id, receiptId));
    if (kind === "exchange")
      await db()
        .update(s.accountingEntries)
        .set({ entryType: "EXCHANGE_SETTLE" })
        .where(eq(s.accountingEntries.id, entryId));
    if (kind === "fulfillment-owned")
      await db()
        .update(s.accountingEntries)
        .set({
          dedupeKey: `FULFILLMENT_CHARGE_PAYEE:R:${receiptId}`,
        })
        .where(eq(s.accountingEntries.id, entryId));
    await expect(apply(receiptId)).rejects.toThrow();
    expect(
      await db().select().from(s.supplierBookSettlementSources),
    ).toHaveLength(0);
    expect(
      await listPurchasePriorPayments(db(), { supplierId: 1, branchId: 1 }),
    ).toEqual([]);
  });
});
