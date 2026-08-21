import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  MAX_PURCHASE_INTEGRITY_LIMIT,
  getPurchaseIntegrityReport,
} from "../purchaseIntegrityService";
import { truncateTables } from "./__testUtils__";

const AS_OF = new Date("2026-08-21T12:00:00.000Z");
const TABLES = [
  "idempotencyKeys",
  "accountingEntries",
  "receipts",
  "purchaseOrders",
  "suppliers",
  "branches",
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
  purchaseOrderId: number;
  branchId?: number;
  supplierId?: number;
  receiptId?: number;
  type: "PURCHASE" | "RETURN" | "PAYMENT_IN" | "PAYMENT_OUT";
  amount: string;
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
      entryDate: "2026-08-20",
    });
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
  it("يكشف فجوة CASH وانحراف paidAmount والرصيد الدفتري السالب، بلا كتابة أو تسريب فرع", async () => {
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

    const gap = report.findings.find(
      (finding) =>
        finding.purchaseOrderId === 1 &&
        finding.code === "CASH_RECEIVED_PAYMENT_COVERAGE_GAP",
    );
    expect(gap?.evidence).toMatchObject({
      recognizedPurchaseGl: "100.00",
      approvedPaymentOutGl: "40.00",
      validPendingPoPay: "20.00",
      netCoveredAmount: "60.00",
      difference: "-40.00",
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

    const gap = report.findings.find(
      (finding) =>
        finding.purchaseOrderId === 3 &&
        finding.code === "CASH_RECEIVED_PAYMENT_COVERAGE_GAP",
    );
    expect(gap?.evidence).toMatchObject({
      validPendingPoPay: "0.00",
      difference: "-100.00",
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
