import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { withTx } from "../tx";
import {
  requestSupplierPayment,
  requestSupplierPaymentRefund,
} from "../purchase/supplierPayments";
import { assertAttestedPaymentEvidenceTx } from "../purchase/attestedPaymentEvidence";
const db = () => getDb()!;
const owner = { userId: 9, branchId: 1, role: "manager", isOwner: true };
let anchorId: number;
beforeEach(async () => {
  await db()
    .insert(s.branches)
    .values([
      { id: 1, name: "MAIN", code: "MAIN", type: "MAIN" },
      { id: 2, name: "OTHER", code: "OTHER", type: "SALES" },
    ]);
  await db().insert(s.users).values({
    id: 9,
    openId: "attested-evidence-owner",
    name: "مالك",
    role: "manager",
    isOwner: true,
    branchId: 1,
  });
  await db()
    .insert(s.suppliers)
    .values([
      { id: 1, name: "مورد", currentBalance: "100.00" },
      { id: 2, name: "طرف آخر", currentBalance: "0.00" },
    ]);
  await db().insert(s.products).values({ id: 1, name: "صنف" });
  await db().insert(s.productVariants).values({
    id: 1,
    productId: 1,
    variantName: "عادي",
    sku: "PAY-EVIDENCE-ITEM",
  });
  await db().insert(s.receipts).values({
    branchId: 1,
    direction: "IN",
    amount: "100.00",
    paymentMethod: "CASH",
    cashBucket: "TREASURY",
    createdBy: 9,
  });
  for (const [id, total] of [
    [1, "60.00"],
    [2, "40.00"],
  ] as const) {
    await db()
      .insert(s.purchaseOrders)
      .values({
        id,
        poNumber: `EVIDENCE-PO-${id}`,
        supplierId: 1,
        branchId: 1,
        subtotal: total,
        total,
        status: "RECEIVED",
      });
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
        subtotal: total,
        total,
        taxAmount: "0",
        shippingCost: "0",
        customsCost: "0",
        invoiceDiscount: "0",
        payloadCanonical: "{}",
        payloadHash: "0".repeat(64),
        revisionReason: "دليل فاتورة",
        createdBy: 9,
      });
    await db().insert(s.purchaseOrderRevisionItems).values({
      id,
      revisionId: id,
      lineNo: 1,
      variantId: 1,
      quantity: "1",
      baseQuantity: 1,
      listUnitPrice: total,
      unitPrice: total,
      lineTotal: total,
      productNameSnapshot: "صنف",
    });
    const entryId = extractInsertId(
      await db().insert(s.accountingEntries).values({
        entryType: "PURCHASE",
        entryDate: "2026-01-01",
        amount: total,
        supplierId: 1,
        branchId: 1,
        purchaseOrderId: id,
        createdBy: 9,
      }),
    );
    if (id === 1) anchorId = entryId;
    await db()
      .insert(s.supplierInvoices)
      .values({
        id,
        invoiceNumber: `EVIDENCE-SI-${id}`,
        clientRequestId: `EVIDENCE-SI-${id}`,
        supplierId: 1,
        branchId: 1,
        status: "POSTED",
        liabilityClass: "NATIVE_AP",
        paymentGate: "OPEN",
        invoiceDate: "2026-01-01",
        currency: "IQD",
        subtotal: total,
        totalAmount: total,
        payloadCanonical: "{}",
        payloadHash: "0".repeat(64),
        evidenceType: "OTHER",
        externalInvoiceNumber: `EVIDENCE-EXT-${id}`,
        externalNumberNorm: `EVIDENCEEXT${id}`,
        evidenceReference: "دليل أصلي",
        createdBy: 9,
        postingEntryId: entryId,
        postedBy: 9,
        postedAt: new Date(),
      });
    await db().insert(s.supplierInvoiceLines).values({
      supplierInvoiceId: id,
      lineNo: 1,
      purchaseOrderRevisionItemId: id,
      variantId: 1,
      description: "بند",
      invoicedBaseQuantity: 1,
      unitPriceIqd: total,
      netAmount: total,
      totalAmount: total,
    });
  }
});
async function nativePayment(
  method: "TRANSFER" | "CARD" | "CASH" = "TRANSFER",
  mixed = false,
) {
  const request = await requestSupplierPayment(
    {
      requestKey: "EVIDENCE-NATIVE-PAYMENT",
      supplierId: 1,
      branchId: 1,
      currency: "IQD",
      amount: "40.00",
      currencyAmount: "40.00",
      paymentMethod: method,
      cashSource: method === "CASH" ? { mode: "TREASURY" } : null,
      externalReference: "ORIGINAL-NATIVE-REFERENCE",
      evidenceType: "PAYMENT_ORDER",
      evidenceReference: "EVIDENCE-NATIVE-PAYMENT",
      reason: "سداد فاتورة أخرى مثبت",
      allocations: mixed
        ? [
            {
              supplierInvoiceId: 1,
              invoiceVersion: 1,
              amount: "20.00",
              currencyAmount: "20.00",
            },
            {
              supplierInvoiceId: 2,
              invoiceVersion: 1,
              amount: "20.00",
              currencyAmount: "20.00",
            },
          ]
        : [
            {
              supplierInvoiceId: 2,
              invoiceVersion: 1,
              amount: "40.00",
              currencyAmount: "40.00",
            },
          ],
    },
    owner,
  );
  return (
    await db()
      .select()
      .from(s.supplierPayments)
      .where(eq(s.supplierPayments.requestId, request.requestId))
  )[0];
}
const inspect = (targets: readonly number[] = [1]) =>
  withTx((tx) => assertAttestedPaymentEvidenceTx(tx, 1, 1, anchorId, targets), {
    gate: "NONE",
  });
async function state() {
  return {
    suppliers: await db().select().from(s.suppliers),
    entries: await db().select().from(s.accountingEntries),
    receipts: await db().select().from(s.receipts),
    invoices: await db().select().from(s.supplierInvoices),
    payments: await db().select().from(s.supplierPayments),
    allocations: await db().select().from(s.supplierPaymentAllocations),
    requests: await db().select().from(s.supplierPaymentRequests),
    requestAllocations: await db()
      .select()
      .from(s.supplierPaymentRequestAllocations),
    audit: await db().select().from(s.auditLogs),
  };
}
describe("attested later payment evidence", () => {
  it.each(["EMPTY", "SHORT"])(
    "rejects a native header with %s materialized allocations",
    async (shape) => {
      const payment = await nativePayment();
      if (shape === "EMPTY")
        await db()
          .delete(s.supplierPaymentAllocations)
          .where(
            eq(s.supplierPaymentAllocations.supplierPaymentId, payment.id),
          );
      else
        await db()
          .update(s.supplierPaymentAllocations)
          .set({ allocatedAmount: "39.00", allocatedCurrencyAmount: "39.00" })
          .where(
            eq(s.supplierPaymentAllocations.supplierPaymentId, payment.id),
          );
      await expect(inspect()).rejects.toThrow("بلا تخصيص أصلي كامل");
    },
  );
  it.each(["TRANSFER", "CARD", "CASH"] as const)(
    "accepts a fully allocated unrelated native %s payment without writes or PII",
    async (method) => {
      const payment = await nativePayment(method);
      await db()
        .update(s.receipts)
        .set({
          attachmentUrl: "PRIVATE_IMAGE",
          internalNote: "PRIVATE_NOTE",
          counterpartyName: "PRIVATE_PERSON",
        })
        .where(eq(s.receipts.id, payment.receiptId));
      const before = await state();
      const result = await inspect();
      expect(result.paymentIds).toEqual([payment.id]);
      expect(result.entryIds).toEqual([payment.accountingEntryId]);
      expect(result.receiptIds).toEqual([payment.receiptId]);
      expect(result.invoiceIds).toEqual([2]);
      expect(result.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(result)).not.toMatch(
        /PRIVATE_IMAGE|PRIVATE_NOTE|PRIVATE_PERSON/,
      );
      expect(await inspect()).toEqual(result);
      expect(await state()).toEqual(before);
    },
  );
  it("returns an empty deterministic proof when there is no later payment", async () => {
    const result = await inspect();
    expect(result.paymentIds).toEqual([]);
    expect(result.snapshots).toEqual([]);
    expect(result.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each(["PAYMENT_OUT", "EXCHANGE_SETTLE"] as const)(
    "rejects a generic or FX %s source",
    async (entryType) => {
      await db().insert(s.accountingEntries).values({
        entryType,
        amount: "10.00",
        supplierId: 1,
        branchId: 1,
        entryDate: "2026-01-02",
      });
      await expect(inspect()).rejects.toThrow();
    },
  );
  it("rejects one mixed native payment including any attested target", async () => {
    await nativePayment("TRANSFER", true);
    await expect(inspect()).rejects.toThrow();
  });
  it("checks all targets rather than only the invoice whose posting is the anchor", async () => {
    await nativePayment();
    await expect(inspect([1, 2])).rejects.toThrow();
  });
  it("rejects a genuinely partially refunded native source", async () => {
    const payment = await nativePayment();
    const [allocation] = await db()
      .select()
      .from(s.supplierPaymentAllocations)
      .where(eq(s.supplierPaymentAllocations.supplierPaymentId, payment.id));
    await requestSupplierPaymentRefund(
      {
        supplierPaymentId: payment.id,
        expectedPaymentVersion: payment.version,
        requestKey: "EVIDENCE-REFUND",
        refundMethod: "TRANSFER",
        externalReference: "BANK-REFUND",
        evidenceType: "BANK_ADVICE",
        evidenceReference: "BANK-REFUND",
        reason: "استرداد جزء من الدفعة",
        allocations: [
          {
            supplierPaymentAllocationId: allocation.id,
            amount: "10.00",
            currencyAmount: "10.00",
          },
        ],
      },
      owner,
    );
    await expect(inspect()).rejects.toThrow();
  });
  it("rejects a native source with a pending receipt cancellation", async () => {
    const payment = await nativePayment();
    await db()
      .insert(s.receipts)
      .values({
        branchId: 1,
        direction: "IN",
        amount: "40.00",
        paymentMethod: "TRANSFER",
        referenceNumber: `CANCEL-VCH-${payment.receiptId}`,
        status: "PENDING",
        approvalStatus: "PENDING_APPROVAL",
        createdBy: 9,
      });
    await expect(inspect()).rejects.toThrow();
  });
  it.each([
    "RECEIPT_PARTY",
    "RECEIPT_BRANCH",
    "RECEIPT_AMOUNT",
    "GL_AMOUNT",
    "INVOICE_PARTY",
  ])("rejects %s mismatches even with a native header", async (mismatch) => {
    const payment = await nativePayment();
    if (mismatch === "RECEIPT_PARTY")
      await db()
        .update(s.receipts)
        .set({ partyId: 2 })
        .where(eq(s.receipts.id, payment.receiptId));
    if (mismatch === "RECEIPT_BRANCH")
      await db()
        .update(s.receipts)
        .set({ branchId: 2 })
        .where(eq(s.receipts.id, payment.receiptId));
    if (mismatch === "RECEIPT_AMOUNT")
      await db()
        .update(s.receipts)
        .set({ amount: "41.00" })
        .where(eq(s.receipts.id, payment.receiptId));
    if (mismatch === "GL_AMOUNT")
      await db()
        .update(s.accountingEntries)
        .set({ amount: "41.00" })
        .where(eq(s.accountingEntries.id, payment.accountingEntryId));
    if (mismatch === "INVOICE_PARTY")
      await db()
        .update(s.supplierInvoices)
        .set({ supplierId: 2 })
        .where(eq(s.supplierInvoices.id, 2));
    await expect(inspect()).rejects.toThrow();
  });
});
