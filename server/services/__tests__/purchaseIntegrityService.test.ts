import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { money, toDbMoney } from "../money";
import {
  MAX_PURCHASE_INTEGRITY_LIMIT,
  getPurchaseIntegrityReport,
} from "../purchaseIntegrityService";
import { runPurchaseIntegrityMonitorOnce } from "../purchase/purchaseIntegrityMonitor";
import { truncateTables } from "./__testUtils__";

const AS_OF = new Date("2026-08-21T12:00:00.000Z");
const TABLES = [
  "idempotencyKeys",
  "supplierPaymentRefundItems",
  "supplierPaymentRefunds",
  "supplierPaymentRefundRequests",
  "supplierPaymentAllocations",
  "supplierPaymentRequestAllocations",
  "supplierPayments",
  "supplierPaymentRequests",
  "supplierInvoices",
  "accountingEntries",
  "receipts",
  "purchaseOrders",
  "suppliers",
  "branches",
  "users",
] as const;

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

function daysAgo(days: number): Date {
  return new Date(AS_OF.getTime() - days * 86_400_000);
}

function purchaseRequestNote(args: {
  purchaseOrderId: number;
  token: string;
  amount: string;
  sourceTotal: string;
}): string {
  return `@SYSTEM_PAYMENT_REQUEST:${JSON.stringify({
    kind: "PURCHASE_SUPPLIER",
    purchaseOrderId: args.purchaseOrderId,
    requestToken: args.token,
    expectedAmount: args.amount,
    sourceTotal: args.sourceTotal,
  })}`;
}

async function seedBase() {
  await db()
    .insert(s.branches)
    .values([
      { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
      { id: 2, name: "الفرع الثاني", code: "BR2", type: "SALES" },
    ]);
  await db()
    .insert(s.suppliers)
    .values([
      { id: 1, name: "مورد ١", currentBalance: "0.00" },
      { id: 2, name: "مورد ٢", currentBalance: "0.00" },
    ]);
}

async function insertPo(args: {
  id: number;
  branchId?: number;
  supplierId?: number;
  number?: string;
  total?: string;
  paidAmount?: string;
  settlementType?: "CASH" | "CREDIT";
  status?: "DRAFT" | "SENT" | "CONFIRMED" | "RECEIVED" | "CANCELLED";
  createdAt?: Date;
}) {
  const total = args.total ?? "100.00";
  await db()
    .insert(s.purchaseOrders)
    .values({
      id: args.id,
      poNumber: args.number ?? `PO-${args.id}`,
      supplierId: args.supplierId ?? 1,
      branchId: args.branchId ?? 1,
      subtotal: total,
      total,
      paidAmount: args.paidAmount ?? "0.00",
      settlementType: args.settlementType ?? "CASH",
      status: args.status ?? "RECEIVED",
      createdAt: args.createdAt ?? daysAgo(2),
    });
}

async function insertEntry(args: {
  id: number;
  purchaseOrderId: number | null;
  branchId?: number;
  supplierId?: number;
  receiptId?: number;
  type: "PURCHASE" | "RETURN" | "PAYMENT_IN" | "PAYMENT_OUT" | "ADJUST";
  amount: string;
  dedupeKey?: string;
}) {
  await db()
    .insert(s.accountingEntries)
    .values({
      id: args.id,
      entryType: args.type,
      branchId: args.branchId ?? 1,
      purchaseOrderId: args.purchaseOrderId,
      supplierId: args.supplierId ?? 1,
      receiptId: args.receiptId,
      amount: args.amount,
      dedupeKey: args.dedupeKey,
      entryDate: "2026-08-20",
    });
}

/** Persist the same one-GL-row/native-allocation shape produced by approval. */
async function seedNativePayment(singlePo = false, withRefund = false) {
  await db().insert(s.users).values({
    id: 9,
    openId: "integrity-owner",
    role: "manager",
    name: "Owner",
  });
  const shares = singlePo ? ["50.00"] : ["10.00", "40.00"];
  for (const [index, share] of shares.entries()) {
    const id = index + 1;
    await insertPo({
      id,
      total: "100.00",
      settlementType: "CREDIT",
      paidAmount:
        withRefund && id === shares.length
          ? toDbMoney(money(share).minus("5.00"))
          : share,
    });
    await insertEntry({
      id,
      purchaseOrderId: id,
      type: "ADJUST",
      amount: "100.00",
      dedupeKey: `GRNI:SUPPLIER_INVOICE:${id}`,
    });
    await db()
      .insert(s.supplierInvoices)
      .values({
        id,
        invoiceNumber: `SI-${id}`,
        clientRequestId: `invoice-${id}`,
        supplierId: 1,
        branchId: 1,
        status: "POSTED",
        liabilityClass: "NATIVE_AP",
        paymentGate: "OPEN",
        invoiceDate: "2026-08-20",
        currency: "IQD",
        subtotal: "100.00",
        totalAmount: "100.00",
        payloadCanonical: "{}",
        payloadHash: String(id).repeat(64),
        evidenceType: "OTHER",
        externalInvoiceNumber: `EXT-${id}`,
        externalNumberNorm: `EXT${id}`,
        evidenceReference: "invoice-evidence",
        createdBy: 9,
        postingEntryId: id,
        postedBy: 9,
        postedAt: AS_OF,
      });
  }
  await db()
    .insert(s.supplierPaymentRequests)
    .values({
      id: 1,
      requestKey: "integrity-native",
      supplierId: 1,
      branchId: 1,
      currency: "IQD",
      requestedAmount: "50.00",
      requestedCurrencyAmount: "50.00",
      paymentMethod: "CASH",
      payloadCanonical: "{}",
      payloadHash: "a".repeat(64),
      evidenceType: "PAYMENT_ORDER",
      evidenceReference: "native-payment-evidence",
      evidenceHash: "b".repeat(64),
      reason: "payment",
      status: "APPROVED",
      requestedBy: 9,
      reviewedBy: 9,
      reviewedAt: AS_OF,
      decisionKey: "integrity-approved",
      decisionHash: "c".repeat(64),
      appliedAt: AS_OF,
    });
  await db().insert(s.receipts).values({
    id: 10,
    branchId: 1,
    direction: "OUT",
    amount: "50.00",
    paymentMethod: "CASH",
    partyType: "SUPPLIER",
    partyId: 1,
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    referenceNumber: "NATIVE-SUPPLIER-PAYMENT",
  });
  await insertEntry({
    id: 10,
    purchaseOrderId: singlePo ? 1 : null,
    receiptId: 10,
    type: "PAYMENT_OUT",
    amount: "50.00",
    dedupeKey: "SUPPLIER_PAYMENT_REQUEST:1",
  });
  await db()
    .insert(s.supplierPayments)
    .values({
      id: 1,
      paymentNumber: "SP-1",
      requestId: 1,
      supplierId: 1,
      branchId: 1,
      currency: "IQD",
      amount: "50.00",
      currencyAmount: "50.00",
      paymentMethod: "CASH",
      receiptId: 10,
      accountingEntryId: 10,
      payloadCanonical: "{}",
      payloadHash: "d".repeat(64),
      postedBy: 9,
    });
  for (const [index, share] of shares.entries()) {
    const id = index + 1;
    await db()
      .insert(s.supplierPaymentRequestAllocations)
      .values({
        id,
        requestId: 1,
        supplierInvoiceId: id,
        invoiceVersion: 1,
        requestedAmount: share,
        requestedCurrencyAmount: share,
        invoiceSnapshot: "{}",
        invoiceHash: "e".repeat(64),
      });
    await db()
      .insert(s.supplierPaymentAllocations)
      .values({
        id,
        supplierPaymentId: 1,
        requestAllocationId: id,
        supplierInvoiceId: id,
        allocatedAmount: share,
        allocatedCurrencyAmount: share,
        invoiceHash: "e".repeat(64),
      });
  }
  if (!withRefund) return;
  await db()
    .insert(s.supplierPaymentRefundRequests)
    .values({
      id: 1,
      requestKey: "integrity-refund",
      supplierPaymentId: 1,
      branchId: 1,
      basePaymentVersion: 1,
      requestedAmount: "5.00",
      requestedCurrencyAmount: "5.00",
      refundMethod: "CASH",
      payloadCanonical: "{}",
      payloadHash: "f".repeat(64),
      evidenceType: "CASH_RECEIPT",
      evidenceReference: "refund-evidence",
      reason: "refund",
      status: "APPROVED",
      requestedBy: 9,
      reviewedBy: 9,
      reviewedAt: AS_OF,
      decisionKey: "refund-approved",
      decisionHash: "f".repeat(64),
      appliedAt: AS_OF,
    });
  await db().insert(s.receipts).values({
    id: 11,
    branchId: 1,
    direction: "IN",
    amount: "5.00",
    paymentMethod: "CASH",
    partyType: "SUPPLIER",
    partyId: 1,
    status: "COMPLETED",
    approvalStatus: "APPROVED",
  });
  await insertEntry({
    id: 11,
    purchaseOrderId: null,
    receiptId: 11,
    type: "PAYMENT_IN",
    amount: "5.00",
    dedupeKey: "SUPPLIER_PAYMENT_REFUND_REQUEST:1",
  });
  await db()
    .insert(s.supplierPaymentRefunds)
    .values({
      id: 1,
      refundNumber: "SR-1",
      requestId: 1,
      supplierPaymentId: 1,
      supplierId: 1,
      branchId: 1,
      amount: "5.00",
      currencyAmount: "5.00",
      receiptId: 11,
      accountingEntryId: 11,
      payloadCanonical: "{}",
      payloadHash: "f".repeat(64),
      postedBy: 9,
    });
  await db().insert(s.supplierPaymentRefundItems).values({
    refundId: 1,
    supplierPaymentAllocationId: shares.length,
    amount: "5.00",
    currencyAmount: "5.00",
  });
  await db()
    .update(s.supplierPaymentAllocations)
    .set({ refundedAmount: "5.00", refundedCurrencyAmount: "5.00" })
    .where(eq(s.supplierPaymentAllocations.id, shares.length));
  await db()
    .update(s.supplierPayments)
    .set({ status: "PARTIALLY_REFUNDED", version: 2 })
    .where(eq(s.supplierPayments.id, 1));
}

async function insertPoPayReceipt(args: {
  id: number;
  purchaseOrderId: number;
  poNumber?: string;
  token?: string;
  amount: string;
  sourceTotal?: string;
  branchId?: number;
  supplierId?: number;
  status?: "PENDING" | "COMPLETED" | "FAILED" | "REVERSED";
  approvalStatus?: "APPROVED" | "PENDING_APPROVAL" | "REJECTED";
  internalNote?: string | null;
  createdAt?: Date;
}) {
  const token = args.token ?? args.id.toString(16).padStart(16, "0");
  const poNumber = args.poNumber ?? `PO-${args.purchaseOrderId}`;
  await db()
    .insert(s.receipts)
    .values({
      id: args.id,
      branchId: args.branchId ?? 1,
      direction: "OUT",
      amount: args.amount,
      paymentMethod: "CASH",
      referenceNumber: `PO-PAY-${poNumber}-${token}`,
      partyType: "SUPPLIER",
      partyId: args.supplierId ?? 1,
      status: args.status ?? "PENDING",
      approvalStatus: args.approvalStatus ?? "PENDING_APPROVAL",
      internalNote:
        args.internalNote === undefined
          ? purchaseRequestNote({
              purchaseOrderId: args.purchaseOrderId,
              token,
              amount: args.amount,
              sourceTotal: args.sourceTotal ?? "100.00",
            })
          : args.internalNote,
      createdAt: args.createdAt ?? daysAgo(1),
    });
}

async function relevantCounts() {
  const [orders, receipts, entries, keys] = await Promise.all([
    db()
      .select({ count: sql<number>`COUNT(*)` })
      .from(s.purchaseOrders),
    db()
      .select({ count: sql<number>`COUNT(*)` })
      .from(s.receipts),
    db()
      .select({ count: sql<number>`COUNT(*)` })
      .from(s.accountingEntries),
    db()
      .select({ count: sql<number>`COUNT(*)` })
      .from(s.idempotencyKeys),
  ]);
  return {
    orders: Number(orders[0]?.count ?? 0),
    receipts: Number(receipts[0]?.count ?? 0),
    entries: Number(entries[0]?.count ?? 0),
    keys: Number(keys[0]?.count ?? 0),
  };
}

beforeEach(async () => {
  await truncateTables(TABLES);
  await seedBase();
});

describe("getPurchaseIntegrityReport — GL forensic read model", () => {
  it("attributes one native GL payment across two POs, including off-page allocations, without writes", async () => {
    await seedNativePayment();
    const before = await relevantCounts();
    const report = await getPurchaseIntegrityReport({
      branchId: 1,
      asOf: AS_OF,
    });
    expect(report.findings).toEqual([]);
    expect(report.orders).toMatchObject([
      {
        purchaseOrderId: 2,
        approvedPaymentOutGl: "40.00",
        linkedPaidAmountGl: "40.00",
        bookBalance: "60.00",
      },
      {
        purchaseOrderId: 1,
        approvedPaymentOutGl: "10.00",
        linkedPaidAmountGl: "10.00",
        bookBalance: "90.00",
      },
    ]);
    const page = await getPurchaseIntegrityReport({
      branchId: 1,
      limit: 1,
      asOf: AS_OF,
    });
    expect(page.orders).toEqual([report.orders[0]]);
    expect(page.findings).toEqual([]);
    expect(await relevantCounts()).toEqual(before);
  });

  it.each([false, true])(
    "attributes native refunds and does not double count directly linked single-PO payments (%s)",
    async (singlePo) => {
      await seedNativePayment(singlePo, true);
      const before = await relevantCounts();
      const report = await getPurchaseIntegrityReport({
        branchId: 1,
        asOf: AS_OF,
      });
      expect(report.findings).toEqual([]);
      expect(report.orders[0]).toMatchObject({
        approvedPaymentOutGl: singlePo ? "50.00" : "40.00",
        approvedPaymentInGl: "5.00",
        linkedPaidAmountGl: singlePo ? "45.00" : "35.00",
        bookBalance: singlePo ? "55.00" : "65.00",
      });
      expect(await relevantCounts()).toEqual(before);
    },
  );

  it("does not hide drift when the complete native allocation evidence does not match the GL amount", async () => {
    await seedNativePayment();
    await db()
      .update(s.supplierPaymentAllocations)
      .set({ allocatedAmount: "9.00", allocatedCurrencyAmount: "9.00" })
      .where(eq(s.supplierPaymentAllocations.id, 1));
    const report = await getPurchaseIntegrityReport({
      branchId: 1,
      limit: 1,
      asOf: AS_OF,
    });
    expect(report.orders[0].approvedPaymentOutGl).toBe("0.00");
    expect(report.orders[0].findingCodes).toContain("PAID_AMOUNT_GL_DRIFT");
  });

  it("validates the full original receipt amount before accepting a projected PO share", async () => {
    await seedNativePayment();
    await db()
      .update(s.receipts)
      .set({ amount: "40.00" })
      .where(eq(s.receipts.id, 10));
    const report = await getPurchaseIntegrityReport({
      branchId: 1,
      limit: 1,
      asOf: AS_OF,
    });
    expect(report.orders[0].approvedPaymentOutGl).toBe("0.00");
    expect(report.orders[0].findingCodes).toContain(
      "UNAPPROVED_PAYMENT_OUT_LEDGER_ENTRY",
    );
    expect(report.orders[0].findingCodes).toContain("PAID_AMOUNT_GL_DRIFT");
  });

  it("يشغّل المراقب اليومي على الفروع النشطة بلا أي كتابة", async () => {
    await insertPo({ id: 1, total: "100.00", paidAmount: "35.00" });
    await insertEntry({
      id: 11,
      purchaseOrderId: 1,
      type: "PURCHASE",
      amount: "100.00",
    });
    const before = await relevantCounts();

    const summary = await runPurchaseIntegrityMonitorOnce();

    expect(summary).toMatchObject({
      branchCount: 2,
      scannedOrderCount: 1,
      findingCount: 2,
      severityCounts: { CRITICAL: 1, HIGH: 1, MEDIUM: 0, INFO: 0 },
      truncatedBranchIds: [],
    });
    expect(await relevantCounts()).toEqual(before);
  });

  it("يكشف الفاتورة النقدية غير المسددة وانحراف paidAmount والرصيد الدفتري السالب بلا كتابة أو تسريب فرع", async () => {
    await insertPo({ id: 1, total: "100.00", paidAmount: "35.00" });
    await insertEntry({
      id: 11,
      purchaseOrderId: 1,
      type: "PURCHASE",
      amount: "100.00",
    });
    await insertPoPayReceipt({
      id: 21,
      purchaseOrderId: 1,
      amount: "40.00",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
    });
    await insertEntry({
      id: 12,
      purchaseOrderId: 1,
      receiptId: 21,
      type: "PAYMENT_OUT",
      amount: "40.00",
    });
    await insertPoPayReceipt({ id: 22, purchaseOrderId: 1, amount: "20.00" });

    await insertPo({ id: 2, total: "50.00", paidAmount: "70.00" });
    await insertEntry({
      id: 13,
      purchaseOrderId: 2,
      type: "PURCHASE",
      amount: "50.00",
    });
    await insertPoPayReceipt({
      id: 23,
      purchaseOrderId: 2,
      amount: "70.00",
      sourceTotal: "50.00",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
    });
    await insertEntry({
      id: 14,
      purchaseOrderId: 2,
      receiptId: 23,
      type: "PAYMENT_OUT",
      amount: "70.00",
    });

    await insertPo({
      id: 90,
      branchId: 2,
      supplierId: 2,
      number: "PO-FOREIGN",
      total: "999.00",
    });
    await insertEntry({
      id: 90,
      purchaseOrderId: 90,
      branchId: 2,
      supplierId: 2,
      type: "PURCHASE",
      amount: "999.00",
    });

    const before = await relevantCounts();
    const report = await getPurchaseIntegrityReport({
      branchId: 1,
      limit: 20,
      asOf: AS_OF,
    });
    expect(await relevantCounts()).toEqual(before);

    expect(report).toMatchObject({
      mode: "DRY_RUN_READ_ONLY",
      branchId: 1,
      sourceOfTruth: "ACCOUNTING_ENTRIES_GL",
      safeguards: {
        mutationsAvailable: false,
        productionRowsChanged: 0,
      },
    });
    expect(
      report.findings.some((finding) => finding.purchaseOrderId === 90),
    ).toBe(false);

    expect(
      report.findings
        .filter((finding) => finding.purchaseOrderId === 1)
        .map((finding) => finding.code),
    ).toEqual([
      "CASH_RECEIVED_PAYMENT_COVERAGE_GAP",
      "PAID_AMOUNT_GL_DRIFT",
    ]);

    expect(
      report.findings.find(
        (finding) =>
          finding.purchaseOrderId === 1 &&
          finding.code === "CASH_RECEIVED_PAYMENT_COVERAGE_GAP",
      ),
    ).toMatchObject({
      severity: "CRITICAL",
      evidence: {
        recognizedPurchaseGl: "100.00",
        approvedPaymentOutGl: "40.00",
        validPendingPoPay: "20.00",
        netCoveredAmount: "60.00",
        difference: "-40.00",
      },
    });

    expect(
      report.findings.find(
        (finding) =>
          finding.purchaseOrderId === 1 &&
          finding.code === "PAID_AMOUNT_GL_DRIFT",
      )?.evidence,
    ).toMatchObject({
      storedPaidAmount: "35.00",
      linkedPaidAmountGl: "40.00",
      difference: "-5.00",
    });

    expect(
      report.findings.find(
        (finding) =>
          finding.purchaseOrderId === 2 &&
          finding.code === "NEGATIVE_PO_LEDGER_BALANCE",
      )?.evidence,
    ).toMatchObject({ bookBalance: "-20.00", overAllocatedBy: "20.00" });
    expect(
      report.findings.find(
        (finding) =>
          finding.purchaseOrderId === 2 &&
          finding.code === "CASH_RECEIVED_PAYMENT_COVERAGE_GAP",
      ),
    ).toMatchObject({
      severity: "HIGH",
      evidence: {
        recognizedPurchaseGl: "50.00",
        approvedPaymentOutGl: "70.00",
        netCoveredAmount: "70.00",
        difference: "20.00",
      },
    });
  });

  it("لا يحتسب طلب PO-PAY معطوباً، ويعرض أعمار المعلّق/المرفوض وCREDIT التاريخي كمراجعة فقط", async () => {
    await insertPo({ id: 3, total: "100.00", paidAmount: "0.00" });
    await insertEntry({
      id: 31,
      purchaseOrderId: 3,
      type: "PURCHASE",
      amount: "100.00",
    });
    await insertPoPayReceipt({
      id: 32,
      purchaseOrderId: 3,
      amount: "100.00",
      internalNote: purchaseRequestNote({
        purchaseOrderId: 999,
        token: "0000000000000020",
        amount: "100.00",
        sourceTotal: "100.00",
      }),
      token: "0000000000000020",
      createdAt: daysAgo(20),
    });
    await insertPoPayReceipt({
      id: 33,
      purchaseOrderId: 3,
      amount: "25.00",
      status: "FAILED",
      approvalStatus: "REJECTED",
      createdAt: daysAgo(45),
    });

    await insertPo({
      id: 4,
      total: "75.00",
      settlementType: "CREDIT",
      createdAt: daysAgo(120),
    });
    await insertEntry({
      id: 41,
      purchaseOrderId: 4,
      type: "PURCHASE",
      amount: "75.00",
    });

    const report = await getPurchaseIntegrityReport({
      branchId: 1,
      limit: 20,
      staleAfterDays: 7,
      historicalCreditAgeDays: 90,
      asOf: AS_OF,
    });

    const stalePending = report.findings.find(
      (finding) =>
        finding.subjectId === 32 && finding.code === "STALE_PENDING_PO_PAYMENT",
    );
    expect(stalePending).toMatchObject({ ageDays: 20 });
    expect(stalePending?.evidence.invalidReasons).toContain(
      "PURCHASE_ORDER_ID_MISMATCH",
    );

    expect(
      report.findings.find(
        (finding) =>
          finding.subjectId === 33 &&
          finding.code === "STALE_REJECTED_PO_PAYMENT",
      ),
    ).toMatchObject({ ageDays: 45 });

    const credit = report.findings.find(
      (finding) =>
        finding.purchaseOrderId === 4 &&
        finding.code === "HISTORICAL_CREDIT_REVIEW_CANDIDATE",
    );
    expect(credit).toMatchObject({ severity: "INFO", ageDays: 120 });
    expect(credit?.evidence).toMatchObject({
      settlementType: "CREDIT",
      cashClassificationInferred: false,
      recognizedPurchaseGl: "75.00",
    });
    expect(credit?.evidence.reasonCodes).toEqual(
      expect.arrayContaining([
        "SETTLEMENT_TYPE_CREDIT",
        "GL_PURCHASE_RECOGNIZED",
      ]),
    );
  });

  it("يثبت مؤشرات التكرار/تعارض idempotency من المراجع والقيود المرتبطة", async () => {
    await insertPo({ id: 5, total: "100.00", paidAmount: "10.00" });
    await insertEntry({
      id: 51,
      purchaseOrderId: 5,
      type: "PURCHASE",
      amount: "100.00",
    });
    const token = "abcdabcdabcdabcd";
    await insertPoPayReceipt({
      id: 52,
      purchaseOrderId: 5,
      token,
      amount: "10.00",
    });
    await insertPoPayReceipt({
      id: 53,
      purchaseOrderId: 5,
      token,
      amount: "20.00",
    });

    await insertPoPayReceipt({
      id: 54,
      purchaseOrderId: 5,
      token: "eeeeeeeeeeeeeeee",
      amount: "10.00",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
    });
    await insertEntry({
      id: 54,
      purchaseOrderId: 5,
      receiptId: 54,
      type: "PAYMENT_OUT",
      amount: "10.00",
    });
    await insertEntry({
      id: 55,
      purchaseOrderId: 5,
      receiptId: 54,
      type: "PAYMENT_OUT",
      amount: "10.00",
    });
    await db()
      .insert(s.idempotencyKeys)
      .values([
        {
          operation: "voucher.create",
          clientRequestId: "po-pay-a",
          refId: 54,
          payloadHash: "a".repeat(64),
        },
        {
          operation: "voucher.create",
          clientRequestId: "po-pay-b",
          refId: 54,
          payloadHash: "b".repeat(64),
        },
      ]);

    const report = await getPurchaseIntegrityReport({
      branchId: 1,
      limit: 20,
      asOf: AS_OF,
    });
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "IDEMPOTENCY_CONFLICTING_PO_PAY_REFERENCE",
          purchaseOrderId: 5,
          subjectId: `PO-PAY-PO-5-${token}`,
        }),
        expect.objectContaining({
          code: "DUPLICATE_PAYMENT_LEDGER_MATERIALIZATION",
          purchaseOrderId: 5,
          subjectId: 54,
        }),
        expect.objectContaining({
          code: "IDEMPOTENCY_RECEIPT_REF_REUSED",
          purchaseOrderId: 5,
          subjectId: 54,
        }),
      ]),
    );
  });

  it("يميّز عكس دفعة PO عن قبض مرتجع المورد عند اشتقاق paidAmount من القيود", async () => {
    await insertPo({ id: 8, total: "100.00", paidAmount: "60.00" });
    await insertEntry({
      id: 81,
      purchaseOrderId: 8,
      type: "PURCHASE",
      amount: "100.00",
    });
    await insertEntry({
      id: 82,
      purchaseOrderId: 8,
      type: "RETURN",
      amount: "-20.00",
    });

    await insertPoPayReceipt({
      id: 83,
      purchaseOrderId: 8,
      amount: "40.00",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
    });
    await insertEntry({
      id: 83,
      purchaseOrderId: 8,
      receiptId: 83,
      type: "PAYMENT_OUT",
      amount: "40.00",
    });
    await insertPoPayReceipt({
      id: 84,
      purchaseOrderId: 8,
      amount: "60.00",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
    });
    await insertEntry({
      id: 84,
      purchaseOrderId: 8,
      receiptId: 84,
      type: "PAYMENT_OUT",
      amount: "60.00",
    });

    await db()
      .insert(s.receipts)
      .values([
        {
          id: 85,
          branchId: 1,
          direction: "IN",
          amount: "40.00",
          paymentMethod: "CASH",
          partyType: "SUPPLIER",
          partyId: 1,
          status: "COMPLETED",
          approvalStatus: "APPROVED",
          referenceNumber: "CANCEL-VCH-83",
          internalNote: `@SYSTEM_PAYMENT_REQUEST:${JSON.stringify({
            kind: "VOUCHER_CANCELLATION",
            originalReceiptId: 83,
          })}`,
        },
        {
          id: 86,
          branchId: 1,
          direction: "IN",
          amount: "20.00",
          paymentMethod: "CASH",
          partyType: "SUPPLIER",
          partyId: 1,
          status: "COMPLETED",
          approvalStatus: "APPROVED",
          referenceNumber: "PURCHASE-RETURN-8",
        },
      ]);
    await insertEntry({
      id: 85,
      purchaseOrderId: 8,
      receiptId: 85,
      type: "PAYMENT_IN",
      amount: "40.00",
    });
    await insertEntry({
      id: 86,
      purchaseOrderId: 8,
      receiptId: 86,
      type: "PAYMENT_IN",
      amount: "20.00",
    });

    const report = await getPurchaseIntegrityReport({
      branchId: 1,
      limit: 20,
      asOf: AS_OF,
    });
    expect(
      report.findings.some(
        (finding) =>
          finding.purchaseOrderId === 8 &&
          finding.code === "PAID_AMOUNT_GL_DRIFT",
      ),
    ).toBe(false);
    expect(
      report.orders.find((order) => order.purchaseOrderId === 8),
    ).toMatchObject({
      approvedPaymentOutGl: "100.00",
      approvedPaymentInGl: "60.00",
      linkedPaidAmountGl: "60.00",
      storedPaidAmount: "60.00",
      bookBalance: "40.00",
    });
  });

  it("يفهم ترحيل GRNI الحديث واسترداد دفعة المورد المرتبط بالأمر بلا إنذارات كاذبة", async () => {
    await insertPo({
      id: 9,
      total: "100.00",
      paidAmount: "0.00",
      settlementType: "CREDIT",
    });
    await insertEntry({
      id: 91,
      purchaseOrderId: 9,
      type: "ADJUST",
      amount: "100.00",
      dedupeKey: "GRNI:SUPPLIER_INVOICE:901",
    });
    await db()
      .insert(s.receipts)
      .values([
        {
          id: 92,
          branchId: 1,
          direction: "OUT",
          amount: "100.00",
          paymentMethod: "CASH",
          partyType: "SUPPLIER",
          partyId: 1,
          status: "COMPLETED",
          approvalStatus: "APPROVED",
          referenceNumber: "SUPPLIER-PAY-REQ:901",
        },
        {
          id: 93,
          branchId: 1,
          direction: "IN",
          amount: "100.00",
          paymentMethod: "CASH",
          partyType: "SUPPLIER",
          partyId: 1,
          status: "COMPLETED",
          approvalStatus: "APPROVED",
          referenceNumber: "SUPPLIER-REFUND-REQ:901",
        },
      ]);
    await insertEntry({
      id: 92,
      purchaseOrderId: 9,
      receiptId: 92,
      type: "PAYMENT_OUT",
      amount: "100.00",
      dedupeKey: "SUPPLIER_PAYMENT_REQUEST:901",
    });
    await insertEntry({
      id: 93,
      purchaseOrderId: 9,
      receiptId: 93,
      type: "PAYMENT_IN",
      amount: "100.00",
      dedupeKey: "SUPPLIER_PAYMENT_REFUND_REQUEST:901",
    });

    const report = await getPurchaseIntegrityReport({
      branchId: 1,
      limit: 20,
      asOf: AS_OF,
    });

    expect(
      report.findings.filter((finding) => finding.purchaseOrderId === 9),
    ).toHaveLength(0);
    expect(
      report.orders.find((order) => order.purchaseOrderId === 9),
    ).toMatchObject({
      recognizedPurchaseGl: "100.00",
      approvedPaymentOutGl: "100.00",
      approvedPaymentInGl: "100.00",
      linkedPaidAmountGl: "0.00",
      storedPaidAmount: "0.00",
      bookBalance: "100.00",
    });
  });

  it("يحرس limit ويعيد ترقيماً قابلاً للتصدير دون مسح غير محدود", async () => {
    await insertPo({ id: 6 });
    await insertPo({ id: 7 });

    await expect(
      getPurchaseIntegrityReport({
        branchId: 1,
        limit: MAX_PURCHASE_INTEGRITY_LIMIT + 1,
        asOf: AS_OF,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      getPurchaseIntegrityReport({ branchId: 0, limit: 1, asOf: AS_OF }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const first = await getPurchaseIntegrityReport({
      branchId: 1,
      limit: 1,
      offset: 0,
      asOf: AS_OF,
    });
    expect(first.page).toMatchObject({
      limit: 1,
      offset: 0,
      scannedOrderCount: 1,
      hasMore: true,
      nextOffset: 1,
    });
    const second = await getPurchaseIntegrityReport({
      branchId: 1,
      limit: 1,
      offset: 1,
      asOf: AS_OF,
    });
    expect(second.page).toMatchObject({
      limit: 1,
      offset: 1,
      scannedOrderCount: 1,
      hasMore: false,
      nextOffset: null,
    });
  });
});
