import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { createGoodsReceipt } from "../purchase/goodsReceipts";
import {
  decidePurchaseReturnReversal,
  requestPurchaseReturnReversal,
} from "../purchase/returnGovernance";
import {
  createSupplierInvoice,
  decideSupplierInvoiceApproval,
  requestSupplierInvoiceApproval,
} from "../purchase/supplierInvoices";
import { runThreeWayMatch } from "../purchase/threeWayMatch";
import { createPurchaseOrder } from "../purchaseService";
import { truncateTables } from "./__testUtils__";
import {
  decidePurchaseOrderControl,
  submitPurchaseOrderForApproval,
} from "../purchase/controls";

const PURCHASING = {
  userId: 1,
  branchId: 1,
  role: "purchasing" as const,
};
const WAREHOUSE = {
  userId: 2,
  branchId: 1,
  role: "warehouse" as const,
};
const APPROVER = {
  userId: 3,
  branchId: 1,
  role: "manager" as const,
};

const TABLES = [
  "documentPrintEvents",
  "journalLines",
  "journalEntries",
  "doubleEntrySettings",
  "purchaseReturnReversalItems",
  "purchaseReturnReversals",
  "purchaseReturnReversalRequestItems",
  "purchaseReturnReversalRequests",
  "purchaseReturnItems",
  "purchaseReturns",
  "purchaseReturnRequestItems",
  "purchaseReturnRequests",
  "supplierInvoiceApprovalRequests",
  "supplierInvoiceMatchAllocations",
  "supplierInvoiceMatchRuns",
  "supplierInvoiceLines",
  "supplierInvoices",
  "goodsReceiptAccountingLinks",
  "goodsReceiptItems",
  "goodsReceipts",
  "idempotencyKeys",
  "auditLogs",
  "accountingEntries",
  "receipts",
  "inventoryMovements",
  "branchStock",
  "purchaseOrderEvents",
  "purchaseOrderControlRequests",
  "purchaseOrderRequisitionAllocations",
  "purchaseOrderRevisionItems",
  "purchaseOrderRevisions",
  "purchaseControlSettings",
  "purchaseOrderItems",
  "purchaseOrders",
  "productUnits",
  "productVariants",
  "products",
  "shifts",
  "suppliers",
  "branches",
  "users",
] as const;

const FINALIZE_FAULT_TRIGGER = "trg_test_purchase_return_finalize_fault";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

function purchasingCaller() {
  return appRouter.createCaller({
    req: { headers: {}, ip: "127.0.0.1" },
    res: { cookie() {}, clearCookie() {} },
    user: {
      id: PURCHASING.userId,
      role: PURCHASING.role,
      branchId: PURCHASING.branchId,
      permissionsOverride: { purchases: "FULL" },
    },
  } as any);
}

function approverCaller() {
  return appRouter.createCaller({
    req: { headers: {}, ip: "127.0.0.1" },
    res: { cookie() {}, clearCookie() {} },
    user: {
      id: APPROVER.userId,
      role: APPROVER.role,
      branchId: APPROVER.branchId,
    },
  } as any);
}

async function seedBase() {
  await db().insert(s.branches).values({
    id: 1,
    name: "الرئيسي",
    code: "MAIN",
    type: "MAIN",
  });
  await db()
    .insert(s.users)
    .values([
      {
        id: 1,
        openId: "return-closure-purchasing",
        name: "مسؤول المشتريات",
        role: "purchasing",
        loginMethod: "local",
        branchId: 1,
        permissionsOverride: { purchases: "FULL" },
      },
      {
        id: 2,
        openId: "return-closure-warehouse",
        name: "أمين المخزن",
        role: "warehouse",
        loginMethod: "local",
        branchId: 1,
      },
      {
        id: 3,
        openId: "return-closure-approver",
        name: "مالك معتمد",
        role: "manager",
        loginMethod: "local",
        branchId: 1,
        isOwner: true,
      },
    ]);
  await db().insert(s.suppliers).values({
    id: 1,
    name: "مورد إغلاق المرتجعات",
    currentBalance: "0.00",
  });
  await db().insert(s.doubleEntrySettings).values({
    id: 1,
    mode: "SHADOW",
    shadowCycleId: "purchase-return-forensic-closure",
  });
  await db().insert(s.products).values({ id: 1, name: "ورق تصوير" });
  await db().insert(s.productVariants).values({
    id: 1,
    productId: 1,
    sku: "RETURN-CLOSURE-1",
    costPrice: "0.00",
  });
  await db().insert(s.productUnits).values({
    id: 1,
    variantId: 1,
    unitName: "قطعة",
    conversionFactor: "1",
    isBaseUnit: true,
  });
}

async function dropFinalizeFaultTrigger() {
  await db().execute(
    sql.raw(`DROP TRIGGER IF EXISTS \`${FINALIZE_FAULT_TRIGGER}\``),
  );
}

async function installFinalizeFaultTrigger() {
  await dropFinalizeFaultTrigger();
  await db().execute(
    sql.raw(`
    CREATE TRIGGER \`${FINALIZE_FAULT_TRIGGER}\`
    BEFORE UPDATE ON \`purchaseReturns\`
    FOR EACH ROW
    BEGIN
      IF OLD.cashRefundReceiptId IS NULL
         AND NEW.cashRefundReceiptId IS NOT NULL
         AND NEW.evidenceReference LIKE 'fault-injection:%' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'purchase return finalize fault';
      END IF;
    END
  `),
  );
}

// يفحص هذا الملفّ فصل المهام تحت سياسة الاعتماد **القديمة** (OFF) — ثبّته صراحةً بدل
// افتراض بيئة التشغيل، مطابقةً لنمط ownerGate.test.ts (مراجعة Codex).
const ROLLOUT_FLAG = "ROLLOUT_OWNER_ONLY_APPROVAL";
let savedRolloutFlag: string | undefined;
beforeEach(() => {
  savedRolloutFlag = process.env[ROLLOUT_FLAG];
  delete process.env[ROLLOUT_FLAG];
});
afterEach(() => {
  if (savedRolloutFlag === undefined) delete process.env[ROLLOUT_FLAG];
  else process.env[ROLLOUT_FLAG] = savedRolloutFlag;
});

beforeEach(async () => {
  await dropFinalizeFaultTrigger();
  await truncateTables(TABLES);
  await seedBase();
});

async function makeOrder(args: {
  status: "DRAFT" | "SENT" | "CONFIRMED" | "RECEIVED" | "CANCELLED";
  unitPrice?: string;
  currency?: "IQD" | "USD";
  agreedRate?: string;
  usdTotal?: string;
}) {
  const currency = args.currency ?? "IQD";
  const created = await createPurchaseOrder(
    {
      supplierId: 1,
      branchId: 1,
      status: "DRAFT",
      settlementType: "CREDIT",
      agreedCurrency: currency,
      agreedRate: currency === "USD" ? args.agreedRate : undefined,
      usdTotal: currency === "USD" ? args.usdTotal : undefined,
      items: [
        {
          variantId: 1,
          productUnitId: 1,
          quantity: "2",
          unitPrice: args.unitPrice ?? "100.00",
        },
      ],
    },
    PURCHASING,
  );
  const [item] = await db()
    .select()
    .from(s.purchaseOrderItems)
    .where(eq(s.purchaseOrderItems.purchaseOrderId, created.purchaseOrderId));

  if (args.status !== "DRAFT" && args.status !== "CANCELLED") {
    const submitted = await submitPurchaseOrderForApproval(
      {
        purchaseOrderId: created.purchaseOrderId,
        expectedVersion: created.version,
        reason: "إرسال أمر اختبار الإغلاق الجنائي للمراجعة المستقلة",
        requestKey: `return-closure-submit:${randomUUID()}`,
      },
      PURCHASING,
    );
    if (args.status !== "SENT") {
      await decidePurchaseOrderControl(
        {
          requestId: submitted.requestId,
          decisionKey: `return-closure-approve:${randomUUID()}`,
          approve: true,
          reason: "راجعت المورد والكميات والأسعار واعتمدت أمر الاختبار",
        },
        APPROVER,
        { legacyConfirmOnly: true },
      );
    }
  }

  if (args.status === "CANCELLED" || args.status === "RECEIVED") {
    await db()
      .update(s.purchaseOrders)
      .set({ status: args.status })
      .where(eq(s.purchaseOrders.id, created.purchaseOrderId));
  }
  return {
    purchaseOrderId: created.purchaseOrderId,
    poNumber: created.poNumber,
    purchaseOrderItemId: Number(item.id),
  };
}

async function makeGovernedReturnSource(args: {
  acceptedBaseQuantity: 1 | 2;
  unitPrice?: string;
  currency?: "IQD" | "USD";
  agreedRate?: string;
  usdTotal?: string;
  taxAmount?: string;
  discountAmount?: string;
  expectedMatchOutcome?: "EXACT" | "WITHIN_TOLERANCE";
}) {
  const order = await makeOrder({
    status: "CONFIRMED",
    unitPrice: args.unitPrice,
    currency: args.currency,
    agreedRate: args.agreedRate,
    usdTotal: args.usdTotal,
  });
  const [approvedOrder] = await db()
    .select()
    .from(s.purchaseOrders)
    .where(eq(s.purchaseOrders.id, order.purchaseOrderId));
  if (!approvedOrder?.approvedRevisionId) {
    throw new Error("approved purchase-order revision is missing");
  }

  const receipt = await createGoodsReceipt(
    {
      purchaseOrderId: order.purchaseOrderId,
      purchaseOrderRevisionId: Number(approvedOrder.approvedRevisionId),
      expectedOrderVersion: Number(approvedOrder.version),
      clientRequestId: `return-closure-grn:${randomUUID()}`,
      supplierDeliveryNote: `DN-${randomUUID()}`,
      lines: [
        {
          purchaseOrderItemId: order.purchaseOrderItemId,
          acceptedBaseQuantity: args.acceptedBaseQuantity,
        },
      ],
    },
    WAREHOUSE,
  );
  const [goodsReceiptItem] = await db()
    .select()
    .from(s.goodsReceiptItems)
    .where(
      eq(s.goodsReceiptItems.goodsReceiptId, Number(receipt.goodsReceiptId)),
    );
  if (!goodsReceiptItem?.purchaseOrderRevisionItemId) {
    throw new Error("goods-receipt revision source is missing");
  }

  const invoice = await createSupplierInvoice(
    {
      supplierId: 1,
      branchId: 1,
      clientRequestId: `return-closure-invoice:${randomUUID()}`,
      externalInvoiceNumber: `EXT-${randomUUID()}`,
      invoiceDate: new Date().toISOString().slice(0, 10),
      currency: args.currency ?? "IQD",
      agreedRate: args.currency === "USD" ? args.agreedRate : undefined,
      taxAmount: args.taxAmount,
      discountAmount: args.discountAmount,
      evidenceType: "PDF",
      evidenceReference: `invoice-evidence:${randomUUID()}`,
      lines: [
        {
          purchaseOrderRevisionItemId: Number(
            goodsReceiptItem.purchaseOrderRevisionItemId,
          ),
          description: "ورق تصوير مطابق لمصدر الاستلام",
          invoicedBaseQuantity: args.acceptedBaseQuantity,
          unitPrice: args.unitPrice ?? "100.00",
        },
      ],
    },
    PURCHASING,
  );
  const [invoiceRow, invoiceLine] = await Promise.all([
    db()
      .select()
      .from(s.supplierInvoices)
      .where(eq(s.supplierInvoices.id, Number(invoice.supplierInvoiceId)))
      .then((rows) => rows[0]),
    db()
      .select()
      .from(s.supplierInvoiceLines)
      .where(
        eq(
          s.supplierInvoiceLines.supplierInvoiceId,
          Number(invoice.supplierInvoiceId),
        ),
      )
      .then((rows) => rows[0]),
  ]);
  if (!invoiceRow || !invoiceLine) {
    throw new Error("supplier-invoice source is missing");
  }

  const match = await runThreeWayMatch(
    {
      supplierInvoiceId: Number(invoice.supplierInvoiceId),
      expectedInvoiceVersion: Number(invoiceRow.version),
      matchKey: `return-closure-match:${randomUUID()}`,
      allocations: [
        {
          supplierInvoiceLineId: Number(invoiceLine.id),
          goodsReceiptItemId: Number(goodsReceiptItem.id),
          matchedBaseQuantity: args.acceptedBaseQuantity,
        },
      ],
    },
    PURCHASING,
  );
  expect(match.outcome).toBe(args.expectedMatchOutcome ?? "EXACT");

  const [matchedInvoice] = await db()
    .select()
    .from(s.supplierInvoices)
    .where(eq(s.supplierInvoices.id, Number(invoice.supplierInvoiceId)));
  const approval = await requestSupplierInvoiceApproval(
    {
      supplierInvoiceId: Number(invoice.supplierInvoiceId),
      expectedInvoiceVersion: Number(matchedInvoice.version),
      requestKey: `return-closure-invoice-approval:${randomUUID()}`,
      kind: "POST_INVOICE",
      matchRunId: Number(match.matchRunId),
      reason: "مطابقة الفاتورة وإذن الاستلام وأمر الشراء مكتملة",
    },
    PURCHASING,
  );
  await decideSupplierInvoiceApproval(
    {
      requestId: Number(approval.requestId),
      decisionKey: `return-closure-invoice-decision:${randomUUID()}`,
      action: "APPROVE",
      reviewReason: "راجعت أدلة المطابقة الثلاثية واعتمدت ترحيل الفاتورة",
    },
    APPROVER,
  );

  const [[postedInvoice], [allocation], [currentOrder]] = await Promise.all([
    db()
      .select()
      .from(s.supplierInvoices)
      .where(eq(s.supplierInvoices.id, Number(invoice.supplierInvoiceId))),
    db()
      .select()
      .from(s.supplierInvoiceMatchAllocations)
      .where(
        eq(
          s.supplierInvoiceMatchAllocations.matchRunId,
          Number(match.matchRunId),
        ),
      ),
    db()
      .select()
      .from(s.purchaseOrders)
      .where(eq(s.purchaseOrders.id, order.purchaseOrderId)),
  ]);
  if (!postedInvoice || !allocation || !currentOrder) {
    throw new Error("governed return source is incomplete");
  }
  expect(postedInvoice.status).toBe("POSTED");

  return {
    ...order,
    purchaseOrderStatus: currentOrder.status,
    supplierInvoiceId: Number(postedInvoice.id),
    supplierInvoiceVersion: Number(postedInvoice.version),
    matchRunId: Number(match.matchRunId),
    matchAllocationId: Number(allocation.id),
    goodsReceiptItemId: Number(goodsReceiptItem.id),
  };
}

async function returnEffectCounts() {
  const [documents, items, movements, entries, receipts, idempotency] =
    await Promise.all([
      db()
        .select({ count: sql<number>`COUNT(*)` })
        .from(s.purchaseReturns),
      db()
        .select({ count: sql<number>`COUNT(*)` })
        .from(s.purchaseReturnItems),
      db()
        .select({ count: sql<number>`COUNT(*)` })
        .from(s.inventoryMovements)
        .where(eq(s.inventoryMovements.referenceType, "PURCHASE_RETURN")),
      db()
        .select({ count: sql<number>`COUNT(*)` })
        .from(s.accountingEntries)
        .where(eq(s.accountingEntries.entryType, "RETURN")),
      db()
        .select({ count: sql<number>`COUNT(*)` })
        .from(s.receipts),
      db()
        .select({ count: sql<number>`COUNT(*)` })
        .from(s.idempotencyKeys),
    ]);
  return {
    documents: Number(documents[0]?.count ?? 0),
    items: Number(items[0]?.count ?? 0),
    movements: Number(movements[0]?.count ?? 0),
    entries: Number(entries[0]?.count ?? 0),
    receipts: Number(receipts[0]?.count ?? 0),
    idempotency: Number(idempotency[0]?.count ?? 0),
  };
}

describe("إغلاق جنائي لمرتجع الشراء", () => {
  it.each(["DRAFT", "SENT", "CANCELLED", "CONFIRMED", "RECEIVED"] as const)(
    "يبقي purchaseReturns.create القديم مغلقاً للأمر %s بلا أي أثر",
    async (status) => {
      const order = await makeOrder({ status });
      const before = await returnEffectCounts();

      await expect(
        purchasingCaller().purchaseReturns.create({
          clientRequestId: `return-closure-rejected-${status}`,
          supplierId: 1,
          branchId: 1,
          purchaseOrderRefId: order.purchaseOrderId,
          items: [
            { purchaseOrderItemId: order.purchaseOrderItemId, quantity: "1" },
          ],
          settlement: "CREDIT",
        }),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

      expect(await returnEffectCounts()).toEqual(before);
    },
  );

  it.each([
    ["CONFIRMED", 1],
    ["RECEIVED", 2],
  ] as const)(
    "ينشئ مرتجع CREDIT محكوماً للأمر %s المستلم بعد اعتماد مستقل فقط",
    async (status, receivedBaseQuantity) => {
      const source = await makeGovernedReturnSource({
        acceptedBaseQuantity: receivedBaseQuantity,
      });
      expect(source.purchaseOrderStatus).toBe(status);
      const before = await returnEffectCounts();

      const requested =
        await purchasingCaller().purchaseReturnGovernance.requestReturn({
          supplierInvoiceId: source.supplierInvoiceId,
          matchRunId: source.matchRunId,
          expectedInvoiceVersion: source.supplierInvoiceVersion,
          requestKey: `return-closure-credit-request:${randomUUID()}`,
          settlement: "CREDIT",
          paymentMethod: "TRANSFER",
          evidenceType: "RETURN_NOTE",
          evidenceReference: `credit-return-note:${randomUUID()}`,
          reason: "إرجاع وحدة معيبة إلى المورد بعد المطابقة الثلاثية",
          lines: [
            {
              matchAllocationId: source.matchAllocationId,
              baseQuantity: 1,
              reason: "وحدة تالفة مثبتة بمحضر الفحص",
            },
          ],
        });
      expect(requested).toMatchObject({ status: "PENDING", idempotent: false });
      expect(await returnEffectCounts()).toEqual(before);

      const [pendingRequest] = await db()
        .select()
        .from(s.purchaseReturnRequests)
        .where(eq(s.purchaseReturnRequests.id, Number(requested.requestId)));
      expect(pendingRequest).toMatchObject({
        status: "PENDING",
        requestedBy: PURCHASING.userId,
        reviewedBy: null,
        baseInvoiceVersion: source.supplierInvoiceVersion,
      });

      await expect(
        purchasingCaller().purchaseReturnGovernance.decideReturn({
          requestId: Number(requested.requestId),
          decisionKey: `return-closure-maker-decision:${randomUUID()}`,
          action: "APPROVE",
          reviewReason: "محاولة منشئ الطلب اعتماد طلبه نفسه مرفوضة",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(await returnEffectCounts()).toEqual(before);

      const approved =
        await approverCaller().purchaseReturnGovernance.decideReturn({
          requestId: Number(requested.requestId),
          decisionKey: `return-closure-credit-decision:${randomUUID()}`,
          action: "APPROVE",
          reviewReason: "راجعت المطابقة والكمية والدليل واعتمدت المرتجع",
        });

      expect(approved).toMatchObject({ status: "APPROVED", idempotent: false });
      expect(await returnEffectCounts()).toEqual({
        documents: before.documents + 1,
        items: before.items + 1,
        movements: before.movements + 1,
        entries: before.entries + 1,
        receipts: before.receipts,
        idempotency: before.idempotency,
      });

      const [[document], [item], [decidedRequest]] = await Promise.all([
        db()
          .select()
          .from(s.purchaseReturns)
          .where(eq(s.purchaseReturns.id, Number(approved.purchaseReturnId))),
        db()
          .select()
          .from(s.purchaseReturnItems)
          .where(
            eq(
              s.purchaseReturnItems.purchaseReturnId,
              Number(approved.purchaseReturnId),
            ),
          ),
        db()
          .select()
          .from(s.purchaseReturnRequests)
          .where(eq(s.purchaseReturnRequests.id, Number(requested.requestId))),
      ]);
      expect(document).toMatchObject({
        origin: "NATIVE",
        status: "POSTED",
        requestId: Number(requested.requestId),
        supplierInvoiceId: source.supplierInvoiceId,
        matchRunId: source.matchRunId,
        purchaseOrderId: source.purchaseOrderId,
        settlement: "CREDIT",
        totalAmount: "100.00",
        cashRefundAmount: "0.00",
        creditOffsetAmount: "100.00",
      });
      expect(item).toMatchObject({
        goodsReceiptItemId: source.goodsReceiptItemId,
        matchAllocationId: source.matchAllocationId,
        baseQuantity: 1,
        lineTotal: "100.00",
      });
      expect(decidedRequest).toMatchObject({
        status: "APPROVED",
        requestedBy: PURCHASING.userId,
        reviewedBy: APPROVER.userId,
      });
    },
  );

  it("يعتمد مديرٌ آخر (غير مالكٍ ومستقلٌّ عن مُنشئ الطلب) مرتجعاً بنجاح", async () => {
    await db()
      .insert(s.users)
      .values({
        id: 4,
        openId: "return-closure-independent-manager",
        name: "مديرٌ مستقلٌّ غير مالك",
        role: "manager",
        loginMethod: "local",
        branchId: 1,
      });
    const independentManagerCaller = () =>
      appRouter.createCaller({
        req: { headers: {}, ip: "127.0.0.1" },
        res: { cookie() {}, clearCookie() {} },
        user: { id: 4, role: "manager", branchId: 1 },
      } as any);

    const source = await makeGovernedReturnSource({ acceptedBaseQuantity: 1 });
    const requested =
      await purchasingCaller().purchaseReturnGovernance.requestReturn({
        supplierInvoiceId: source.supplierInvoiceId,
        matchRunId: source.matchRunId,
        expectedInvoiceVersion: source.supplierInvoiceVersion,
        requestKey: `return-closure-independent-request:${randomUUID()}`,
        settlement: "CREDIT",
        paymentMethod: "TRANSFER",
        evidenceType: "RETURN_NOTE",
        evidenceReference: `independent-return-note:${randomUUID()}`,
        reason: "إرجاع وحدة معيبة إلى المورد بعد المطابقة الثلاثية",
        lines: [
          {
            matchAllocationId: source.matchAllocationId,
            baseQuantity: 1,
            reason: "وحدة تالفة مثبتة بمحضر الفحص",
          },
        ],
      });

    const approved =
      await independentManagerCaller().purchaseReturnGovernance.decideReturn({
        requestId: Number(requested.requestId),
        decisionKey: `return-closure-independent-decision:${randomUUID()}`,
        action: "APPROVE",
        reviewReason: "مديرٌ مستقلٌّ غير مالكٍ راجع الدليل واعتمد المرتجع",
      });

    expect(approved).toMatchObject({ status: "APPROVED", idempotent: false });
    const [decidedRequest] = await db()
      .select()
      .from(s.purchaseReturnRequests)
      .where(eq(s.purchaseReturnRequests.id, Number(requested.requestId)));
    expect(decidedRequest).toMatchObject({
      status: "APPROVED",
      requestedBy: PURCHASING.userId,
      reviewedBy: 4,
    });
  });

  it("يجعل requestKey المتزامن replay واحداً ويرفض الحمولة المختلفة", async () => {
    const source = await makeGovernedReturnSource({ acceptedBaseQuantity: 2 });
    const requestKey = `return-closure-concurrent:${randomUUID()}`;
    const evidenceReference = `concurrent-return-note:${randomUUID()}`;
    const input = {
      supplierInvoiceId: source.supplierInvoiceId,
      matchRunId: source.matchRunId,
      expectedInvoiceVersion: source.supplierInvoiceVersion,
      requestKey,
      settlement: "CREDIT" as const,
      paymentMethod: "TRANSFER" as const,
      evidenceType: "RETURN_NOTE" as const,
      evidenceReference,
      reason: "طلب متزامن واحد يجب ألا يحجز الكمية أو الرأس مرتين",
      lines: [
        {
          matchAllocationId: source.matchAllocationId,
          baseQuantity: 1,
          reason: "وحدة واحدة تالفة",
        },
      ],
    };

    const [first, second] = await Promise.all([
      purchasingCaller().purchaseReturnGovernance.requestReturn(input),
      purchasingCaller().purchaseReturnGovernance.requestReturn(input),
    ]);
    expect(first.requestId).toBe(second.requestId);
    expect([first.idempotent, second.idempotent].sort()).toEqual([false, true]);
    const requests = await db()
      .select()
      .from(s.purchaseReturnRequests)
      .where(eq(s.purchaseReturnRequests.requestKey, requestKey));
    const items = await db()
      .select()
      .from(s.purchaseReturnRequestItems)
      .where(
        eq(s.purchaseReturnRequestItems.requestId, Number(first.requestId)),
      );
    expect(requests).toHaveLength(1);
    expect(items).toHaveLength(1);

    await expect(
      purchasingCaller().purchaseReturnGovernance.requestReturn({
        ...input,
        reason: "حمولة مختلفة تحت المفتاح نفسه يجب رفضها",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("يعكس USD بنسبة لقطة الفاتورة ويمتص آخر جزء باقي التقريب مع الضريبة", async () => {
    await db().insert(s.purchaseControlSettings).values({
      branchId: 1,
      // ضريبة المستند $0.02 × 1200 = 24 IQD، وحد المطابقة يساويها
      // بالضبط؛ أي فلس إضافي يبقى HOLD لأن المقارنة strict >.
      totalToleranceAmount: "24.00",
    });
    const source = await makeGovernedReturnSource({
      acceptedBaseQuantity: 2,
      unitPrice: "0.0250",
      currency: "USD",
      agreedRate: "1200.0000",
      usdTotal: "0.05",
      taxAmount: "0.02",
      expectedMatchOutcome: "WITHIN_TOLERANCE",
    });
    const [postedSupplier] = await db()
      .select()
      .from(s.suppliers)
      .where(eq(s.suppliers.id, 1));
    expect(postedSupplier.currentBalance).toBe("84.00");
    expect(postedSupplier.currentBalanceUsd).toBe("0.07");

    const firstRequest =
      await purchasingCaller().purchaseReturnGovernance.requestReturn({
        supplierInvoiceId: source.supplierInvoiceId,
        matchRunId: source.matchRunId,
        expectedInvoiceVersion: source.supplierInvoiceVersion,
        requestKey: `return-closure-usd-first:${randomUUID()}`,
        settlement: "CREDIT",
        paymentMethod: "TRANSFER",
        evidenceType: "RETURN_NOTE",
        evidenceReference: `usd-return-note-first:${randomUUID()}`,
        reason: "إرجاع أول نصف من فاتورة USD ذات ضريبة بعملة المستند",
        lines: [
          { matchAllocationId: source.matchAllocationId, baseQuantity: 1 },
        ],
      });
    await approverCaller().purchaseReturnGovernance.decideReturn({
      requestId: Number(firstRequest.requestId),
      decisionKey: `return-closure-usd-first-decision:${randomUUID()}`,
      action: "APPROVE",
      reviewReason: "اعتماد النصف الأول واختبار تقريب ثلاثة سنتات",
    });
    const [afterFirst, invoiceAfterFirst] = await Promise.all([
      db()
        .select()
        .from(s.suppliers)
        .where(eq(s.suppliers.id, 1))
        .then((rows) => rows[0]!),
      db()
        .select()
        .from(s.supplierInvoices)
        .where(eq(s.supplierInvoices.id, source.supplierInvoiceId))
        .then((rows) => rows[0]!),
    ]);
    expect(afterFirst.currentBalance).toBe("42.00");
    expect(afterFirst.currentBalanceUsd).toBe("0.03");

    const secondRequest =
      await purchasingCaller().purchaseReturnGovernance.requestReturn({
        supplierInvoiceId: source.supplierInvoiceId,
        matchRunId: source.matchRunId,
        expectedInvoiceVersion: Number(invoiceAfterFirst.version),
        requestKey: `return-closure-usd-final:${randomUUID()}`,
        settlement: "CREDIT",
        paymentMethod: "TRANSFER",
        evidenceType: "RETURN_NOTE",
        evidenceReference: `usd-return-note-final:${randomUUID()}`,
        reason: "إرجاع النصف الأخير وامتصاص باقي السنتين بلا تجاوز",
        lines: [
          { matchAllocationId: source.matchAllocationId, baseQuantity: 1 },
        ],
      });
    await approverCaller().purchaseReturnGovernance.decideReturn({
      requestId: Number(secondRequest.requestId),
      decisionKey: `return-closure-usd-final-decision:${randomUUID()}`,
      action: "APPROVE",
      reviewReason: "اعتماد النصف الأخير وإغلاق الرصيد الأصلي تماماً",
    });
    const [afterFinal] = await db()
      .select()
      .from(s.suppliers)
      .where(eq(s.suppliers.id, 1));
    expect(afterFinal.currentBalance).toBe("0.00");
    expect(afterFinal.currentBalanceUsd).toBe("0.00");
  });

  it("يثبت مسار CASH المحكوم إيصال المورد وقيدي RETURN وPAYMENT_IN", async () => {
    const source = await makeGovernedReturnSource({
      acceptedBaseQuantity: 2,
      unitPrice: "100.00",
    });
    const [supplierBefore] = await db()
      .select()
      .from(s.suppliers)
      .where(eq(s.suppliers.id, 1));
    const before = await returnEffectCounts();
    const requested =
      await purchasingCaller().purchaseReturnGovernance.requestReturn({
        supplierInvoiceId: source.supplierInvoiceId,
        matchRunId: source.matchRunId,
        expectedInvoiceVersion: source.supplierInvoiceVersion,
        requestKey: `return-closure-cash-request:${randomUUID()}`,
        settlement: "CASH",
        paymentMethod: "CASH",
        evidenceType: "RETURN_NOTE",
        evidenceReference: `cash-return-note:${randomUUID()}`,
        reason: "إرجاع كامل الكمية واستلام رد نقدي موثق من المورد",
        lines: [
          {
            matchAllocationId: source.matchAllocationId,
            baseQuantity: 2,
            reason: "رفض كامل الشحنة بعد الفحص",
          },
        ],
      });
    expect(await returnEffectCounts()).toEqual(before);

    const decision = {
      requestId: Number(requested.requestId),
      decisionKey: `return-closure-cash-decision:${randomUUID()}`,
      action: "APPROVE" as const,
      reviewReason: "تحققت من مذكرة المرتجع واستلام الرد النقدي من المورد",
    };
    const approved =
      await approverCaller().purchaseReturnGovernance.decideReturn(decision);

    expect(approved).toMatchObject({ status: "APPROVED" });
    expect(await returnEffectCounts()).toEqual({
      documents: before.documents + 1,
      items: before.items + 1,
      movements: before.movements + 1,
      entries: before.entries + 1,
      receipts: before.receipts + 1,
      idempotency: before.idempotency,
    });
    const applied = await returnEffectCounts();
    const replayed =
      await approverCaller().purchaseReturnGovernance.decideReturn(decision);
    expect(replayed).toMatchObject({
      status: "APPROVED",
      purchaseReturnId: approved.purchaseReturnId,
      idempotent: true,
    });
    expect(await returnEffectCounts()).toEqual(applied);

    const [document] = await db()
      .select()
      .from(s.purchaseReturns)
      .where(eq(s.purchaseReturns.id, Number(approved.purchaseReturnId)));
    expect(document).toMatchObject({
      settlement: "CASH",
      totalAmount: "200.00",
      cashRefundAmount: "200.00",
      creditOffsetAmount: "0.00",
    });

    const linkedEntries = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.purchaseOrderId, source.purchaseOrderId));
    expect(
      linkedEntries.map((entry) => [entry.entryType, entry.amount]),
    ).toEqual(
      expect.arrayContaining([
        ["RETURN", "-200.00"],
        ["PAYMENT_IN", "200.00"],
      ]),
    );
    const refundEntry = linkedEntries.find(
      (entry) => entry.entryType === "PAYMENT_IN",
    );
    expect(refundEntry?.supplierId).toBe(1);
    const [refundReceipt] = await db()
      .select()
      .from(s.receipts)
      .where(
        and(
          eq(s.receipts.id, Number(document.cashRefundReceiptId)),
          eq(s.receipts.direction, "IN"),
        ),
      );
    expect(refundReceipt).toMatchObject({
      amount: "200.00",
      paymentMethod: "CASH",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      shiftId: null,
      cashBucket: "TREASURY",
    });
    expect(refundEntry?.receiptId).toBe(Number(refundReceipt.id));
    const returnEntry = linkedEntries.find(
      (entry) =>
        entry.dedupeKey === `PURCHASE_RETURN:${approved.purchaseReturnId}`,
    );
    expect(returnEntry).toBeDefined();
    const journalLines = await db()
      .select({
        entryId: s.journalEntries.entryId,
        role: s.journalLines.role,
        debit: s.journalLines.debit,
        credit: s.journalLines.credit,
      })
      .from(s.journalLines)
      .innerJoin(
        s.journalEntries,
        eq(s.journalEntries.id, s.journalLines.journalId),
      )
      .where(
        inArray(s.journalEntries.entryId, [
          Number(returnEntry!.id),
          Number(refundEntry!.id),
        ]),
      );
    expect(
      journalLines.map((line) => [
        Number(line.entryId),
        line.role,
        line.debit,
        line.credit,
      ]),
    ).toEqual(
      expect.arrayContaining([
        [Number(returnEntry!.id), "AP", "200.00", "0.00"],
        [Number(refundEntry!.id), "AP", "0.00", "200.00"],
        [Number(refundEntry!.id), "TREASURY_CASH", "200.00", "0.00"],
      ]),
    );
    const [supplierAfter] = await db()
      .select()
      .from(s.suppliers)
      .where(eq(s.suppliers.id, 1));
    expect(supplierAfter.currentBalance).toBe(supplierBefore.currentBalance);
    expect(supplierAfter.currentBalanceUsd).toBe(
      supplierBefore.currentBalanceUsd,
    );
    const [returnMovement] = await db()
      .select()
      .from(s.inventoryMovements)
      .where(
        and(
          eq(s.inventoryMovements.referenceType, "PURCHASE_RETURN"),
          eq(
            s.inventoryMovements.referenceId,
            Number(approved.purchaseReturnId),
          ),
        ),
      );
    expect(returnMovement).toMatchObject({ movementType: "OUT", quantity: 2 });
  });

  it("يردّ الرأس والإيصال والقيد والمخزون والذمم معاً عند فشل التثبيت بعد إنشاء الإيصال", async () => {
    const source = await makeGovernedReturnSource({
      acceptedBaseQuantity: 2,
      unitPrice: "100.00",
    });
    const requested =
      await purchasingCaller().purchaseReturnGovernance.requestReturn({
        supplierInvoiceId: source.supplierInvoiceId,
        matchRunId: source.matchRunId,
        expectedInvoiceVersion: source.supplierInvoiceVersion,
        requestKey: `return-closure-fault-request:${randomUUID()}`,
        settlement: "CASH",
        paymentMethod: "CASH",
        evidenceType: "RETURN_NOTE",
        evidenceReference: `fault-injection:${randomUUID()}`,
        reason: "حقن فشل بعد إنشاء إيصال الاسترداد وقبل تثبيت رأس المرتجع",
        lines: [
          { matchAllocationId: source.matchAllocationId, baseQuantity: 2 },
        ],
      });
    const beforeEffects = await returnEffectCounts();
    const [beforeSupplier] = await db()
      .select()
      .from(s.suppliers)
      .where(eq(s.suppliers.id, 1));

    await installFinalizeFaultTrigger();
    try {
      await expect(
        approverCaller().purchaseReturnGovernance.decideReturn({
          requestId: Number(requested.requestId),
          decisionKey: `return-closure-fault-decision:${randomUUID()}`,
          action: "APPROVE",
          reviewReason: "تشغيل نقطة الفشل بعد الإيصال لاختبار rollback الكامل",
        }),
      ).rejects.toBeDefined();
    } finally {
      await dropFinalizeFaultTrigger();
    }

    expect(await returnEffectCounts()).toEqual(beforeEffects);
    const [[requestAfter], [supplierAfter], stockAfter] = await Promise.all([
      db()
        .select()
        .from(s.purchaseReturnRequests)
        .where(eq(s.purchaseReturnRequests.id, Number(requested.requestId))),
      db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)),
      db()
        .select({ quantity: s.branchStock.quantity })
        .from(s.branchStock)
        .where(
          and(eq(s.branchStock.branchId, 1), eq(s.branchStock.variantId, 1)),
        ),
    ]);
    expect(requestAfter).toMatchObject({
      status: "PENDING",
      reviewedBy: null,
      decisionKey: null,
    });
    expect(supplierAfter.currentBalance).toBe(beforeSupplier.currentBalance);
    expect(supplierAfter.currentBalanceUsd).toBe(
      beforeSupplier.currentBalanceUsd,
    );
    expect(stockAfter[0]?.quantity).toBe(2);
    expect(await db().select().from(s.purchaseReturns)).toHaveLength(0);
  });

  it("يبقي purchases.pay وpurchaseReturns.resolveOrder القديمين مغلقين", async () => {
    const order = await makeOrder({ status: "CONFIRMED" });
    const before = await returnEffectCounts();
    const caller = purchasingCaller();

    await expect(
      caller.purchases.pay({
        purchaseOrderId: order.purchaseOrderId,
        amount: "50.00",
        method: "CASH",
        clientRequestId: `return-closure-legacy-pay:${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(
      (caller.purchaseReturns as any).resolveOrder({
        branchId: 1,
        reference: order.poNumber,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await returnEffectCounts()).toEqual(before);
  });

  it("يمكّن purchasing بصلاحية purchases:FULL من المصدر المحكوم دون كشف السعر في purchases.get", async () => {
    const source = await makeGovernedReturnSource({
      acceptedBaseQuantity: 2,
      unitPrice: "125.00",
    });
    const caller = purchasingCaller();

    const publicOrder = await caller.purchases.get({
      purchaseOrderId: source.purchaseOrderId,
    });
    expect(publicOrder?.items[0]?.unitPrice).toBeNull();

    const sources = await caller.purchaseReturnGovernance.returnSources({
      branchId: 1,
      limit: 20,
    });
    const governedSource = sources.find(
      (row) => row.id === source.supplierInvoiceId,
    );
    expect(governedSource).toMatchObject({
      id: source.supplierInvoiceId,
      version: source.supplierInvoiceVersion,
      matchRun: { id: source.matchRunId, outcome: "EXACT" },
    });
    expect(governedSource?.allocations[0]).toMatchObject({
      id: source.matchAllocationId,
      availableBaseQuantity: 2,
      unitPriceIqd: "125.00",
    });

    const before = await returnEffectCounts();
    const requested = await caller.purchaseReturnGovernance.requestReturn({
      supplierInvoiceId: source.supplierInvoiceId,
      matchRunId: source.matchRunId,
      expectedInvoiceVersion: source.supplierInvoiceVersion,
      requestKey: `return-closure-purchasing-router:${randomUUID()}`,
      settlement: "CREDIT",
      paymentMethod: "TRANSFER",
      evidenceType: "RETURN_NOTE",
      evidenceReference: `purchasing-return-note:${randomUUID()}`,
      reason: "طلب مرتجع من مصدر الفاتورة والمطابقة المحكوم",
      lines: [
        {
          matchAllocationId: source.matchAllocationId,
          baseQuantity: 1,
        },
      ],
    });
    expect(requested).toMatchObject({ status: "PENDING", idempotent: false });
    expect(await returnEffectCounts()).toEqual(before);

    const reservedSources = await caller.purchaseReturnGovernance.returnSources(
      {
        branchId: 1,
        limit: 20,
      },
    );
    expect(
      reservedSources.find((row) => row.id === source.supplierInvoiceId)
        ?.allocations[0]?.availableBaseQuantity,
    ).toBe(1);
  });
});

describe("عكس مرتجع الشراء المحكوم (requestReversal/decideReversal)", () => {
  it("يرفض اعتماد عكس مرتجع CREDIT من مُنشئ طلب العكس نفسه، ويقبله من مراجعٍ مستقل ويعيد الذمّة والمخزون والقيد إلى ما قبل المرتجع", async () => {
    const source = await makeGovernedReturnSource({
      acceptedBaseQuantity: 2,
      unitPrice: "100.00",
    });
    const [supplierBeforeReturn] = await db()
      .select()
      .from(s.suppliers)
      .where(eq(s.suppliers.id, 1));

    const requested =
      await purchasingCaller().purchaseReturnGovernance.requestReturn({
        supplierInvoiceId: source.supplierInvoiceId,
        matchRunId: source.matchRunId,
        expectedInvoiceVersion: source.supplierInvoiceVersion,
        requestKey: `return-reversal-credit-request:${randomUUID()}`,
        settlement: "CREDIT",
        paymentMethod: "TRANSFER",
        evidenceType: "RETURN_NOTE",
        evidenceReference: `return-reversal-credit-note:${randomUUID()}`,
        reason: "إرجاع كامل الكمية لعيبٍ ظهر بعد الفحص",
        lines: [
          {
            matchAllocationId: source.matchAllocationId,
            baseQuantity: 2,
            reason: "وحدتان تالفتان مثبتتان بمحضر الفحص",
          },
        ],
      });
    const approved =
      await approverCaller().purchaseReturnGovernance.decideReturn({
        requestId: Number(requested.requestId),
        decisionKey: `return-reversal-credit-decision:${randomUUID()}`,
        action: "APPROVE",
        reviewReason: "راجعت المطابقة والكمية والدليل واعتمدت المرتجع",
      });
    expect(approved).toMatchObject({ status: "APPROVED" });

    const [returnRow] = await db()
      .select()
      .from(s.purchaseReturns)
      .where(eq(s.purchaseReturns.id, Number(approved.purchaseReturnId)));
    const [returnItem] = await db()
      .select()
      .from(s.purchaseReturnItems)
      .where(
        eq(
          s.purchaseReturnItems.purchaseReturnId,
          Number(approved.purchaseReturnId),
        ),
      );
    expect(returnItem).toMatchObject({ baseQuantity: 2, lineTotal: "200.00" });

    const reversalRequested = await requestPurchaseReturnReversal(
      {
        purchaseReturnId: Number(approved.purchaseReturnId),
        expectedReturnVersion: Number(returnRow.version),
        requestKey: `return-reversal-request:${randomUUID()}`,
        evidenceType: "SUPPLIER_ACKNOWLEDGEMENT",
        evidenceReference: `return-reversal-evidence:${randomUUID()}`,
        reason: "المورد أنكر استلام البضاعة المرتجعة فعلياً وطلب التراجع",
        lines: [
          {
            purchaseReturnItemId: Number(returnItem.id),
            baseQuantity: 2,
            reason: "عكس كامل الكمية المرتجعة",
          },
        ],
      },
      PURCHASING,
    );
    expect(reversalRequested).toMatchObject({
      status: "PENDING",
      idempotent: false,
    });

    await expect(
      decidePurchaseReturnReversal(
        {
          requestId: reversalRequested.requestId,
          decisionKey: `return-reversal-self-decision:${randomUUID()}`,
          action: "APPROVE",
          reviewReason: "محاولة منشئ طلب العكس اعتماد طلبه نفسه مرفوضة",
        },
        PURCHASING,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const [pendingAfterSelfAttempt] = await db()
      .select()
      .from(s.purchaseReturnReversalRequests)
      .where(
        eq(s.purchaseReturnReversalRequests.id, reversalRequested.requestId),
      );
    expect(pendingAfterSelfAttempt).toMatchObject({
      status: "PENDING",
      reviewedBy: null,
    });

    const reversed = await decidePurchaseReturnReversal(
      {
        requestId: reversalRequested.requestId,
        decisionKey: `return-reversal-decision:${randomUUID()}`,
        action: "APPROVE",
        reviewReason: "تحقّقت من إنكار المورد استلام المرتجع واعتمدت العكس",
      },
      // مراجعٌ مستقلٌّ عن الطالب PURCHASING **ومخوَّلٌ فعلياً**: `decideReversal` محصورٌ
      // بـ`purchasesManagerProcedure` (manager/purchasing) — WAREHOUSE لا يبلغه عبر الراوتر
      // أصلاً، فاستعمالُه هنا كان يثبت سيناريو مستحيلاً في الإنتاج (مراجعة Codex).
      APPROVER,
    );
    expect(reversed.status).toBe("APPROVED");
    expect(reversed.reversalId).toBeGreaterThan(0);

    const [
      [returnAfter],
      [poItemAfter],
      [grnItemAfter],
      [reversalRow],
      [reversalItem],
      [movement],
      [entry],
      [supplierAfter],
      [reversalRequestRow],
    ] = await Promise.all([
      db()
        .select()
        .from(s.purchaseReturns)
        .where(eq(s.purchaseReturns.id, Number(approved.purchaseReturnId))),
      db()
        .select()
        .from(s.purchaseOrderItems)
        .where(eq(s.purchaseOrderItems.id, source.purchaseOrderItemId)),
      db()
        .select()
        .from(s.goodsReceiptItems)
        .where(eq(s.goodsReceiptItems.id, source.goodsReceiptItemId)),
      db()
        .select()
        .from(s.purchaseReturnReversals)
        .where(
          eq(
            s.purchaseReturnReversals.purchaseReturnId,
            Number(approved.purchaseReturnId),
          ),
        ),
      db()
        .select()
        .from(s.purchaseReturnReversalItems)
        .where(
          eq(
            s.purchaseReturnReversalItems.reversalId,
            Number(reversed.reversalId),
          ),
        ),
      db()
        .select()
        .from(s.inventoryMovements)
        .where(
          and(
            eq(
              s.inventoryMovements.referenceType,
              "PURCHASE_RETURN_REVERSAL",
            ),
            eq(s.inventoryMovements.referenceId, Number(reversed.reversalId)),
          ),
        ),
      db()
        .select()
        .from(s.accountingEntries)
        .where(
          eq(
            s.accountingEntries.dedupeKey,
            `PURCHASE_RETURN_REVERSAL_REQUEST:${reversalRequested.requestId}`,
          ),
        ),
      db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)),
      db()
        .select()
        .from(s.purchaseReturnReversalRequests)
        .where(
          eq(s.purchaseReturnReversalRequests.id, reversalRequested.requestId),
        ),
    ]);

    expect(returnAfter).toMatchObject({ status: "REVERSED" });
    expect(poItemAfter).toMatchObject({ returnedBaseQuantity: 0 });
    expect(grnItemAfter).toMatchObject({ returnedBaseQuantity: 0 });
    expect(reversalRow).toMatchObject({
      netAmount: "200.00",
      taxAmount: "0.00",
      totalAmount: "200.00",
    });
    expect(reversalItem).toMatchObject({
      baseQuantity: 2,
      totalAmount: "200.00",
    });
    expect(movement).toMatchObject({ movementType: "IN", quantity: 2 });
    expect(entry).toMatchObject({ entryType: "RETURN", amount: "200.00" });
    expect(supplierAfter.currentBalance).toBe(
      supplierBeforeReturn.currentBalance,
    );
    expect(reversalRequestRow).toMatchObject({
      status: "APPROVED",
      requestedBy: PURCHASING.userId,
      reviewedBy: APPROVER.userId,
    });
  });

  it("يثبت مسار CASH لعكس المرتجع: إيصال OUT من الخزينة وقيدا RETURN وPAYMENT_OUT، وبلا أثرٍ صافٍ على ذمّة المورد", async () => {
    const source = await makeGovernedReturnSource({
      acceptedBaseQuantity: 2,
      unitPrice: "100.00",
    });
    const [supplierBeforeReturn] = await db()
      .select()
      .from(s.suppliers)
      .where(eq(s.suppliers.id, 1));

    const requested =
      await purchasingCaller().purchaseReturnGovernance.requestReturn({
        supplierInvoiceId: source.supplierInvoiceId,
        matchRunId: source.matchRunId,
        expectedInvoiceVersion: source.supplierInvoiceVersion,
        requestKey: `return-reversal-cash-request:${randomUUID()}`,
        settlement: "CASH",
        paymentMethod: "CASH",
        evidenceType: "RETURN_NOTE",
        evidenceReference: `return-reversal-cash-note:${randomUUID()}`,
        reason: "إرجاع كامل الكمية واستلام رد نقدي موثق من المورد",
        lines: [
          {
            matchAllocationId: source.matchAllocationId,
            baseQuantity: 2,
            reason: "رفض كامل الشحنة بعد الفحص",
          },
        ],
      });
    const approved =
      await approverCaller().purchaseReturnGovernance.decideReturn({
        requestId: Number(requested.requestId),
        decisionKey: `return-reversal-cash-decision:${randomUUID()}`,
        action: "APPROVE",
        reviewReason: "تحققت من مذكرة المرتجع واستلام الرد النقدي من المورد",
      });
    expect(approved).toMatchObject({ status: "APPROVED" });

    const [returnRow] = await db()
      .select()
      .from(s.purchaseReturns)
      .where(eq(s.purchaseReturns.id, Number(approved.purchaseReturnId)));
    const [returnItem] = await db()
      .select()
      .from(s.purchaseReturnItems)
      .where(
        eq(
          s.purchaseReturnItems.purchaseReturnId,
          Number(approved.purchaseReturnId),
        ),
      );

    const reversalRequested = await requestPurchaseReturnReversal(
      {
        purchaseReturnId: Number(approved.purchaseReturnId),
        expectedReturnVersion: Number(returnRow.version),
        requestKey: `return-reversal-cash-req:${randomUUID()}`,
        evidenceType: "SUPPLIER_ACKNOWLEDGEMENT",
        evidenceReference: `return-reversal-cash-evidence:${randomUUID()}`,
        reason: "الرد النقدي لم يصل فعلياً والمورد يطلب استرجاع البضاعة",
        lines: [
          {
            purchaseReturnItemId: Number(returnItem.id),
            baseQuantity: 2,
            reason: "عكس كامل الكمية المرتجعة",
          },
        ],
      },
      PURCHASING,
    );

    const reversed = await decidePurchaseReturnReversal(
      {
        requestId: reversalRequested.requestId,
        decisionKey: `return-reversal-cash-decision-2:${randomUUID()}`,
        action: "APPROVE",
        reviewReason: "تحقّقت من عدم وصول الرد النقدي واعتمدت عكس المرتجع",
      },
      APPROVER,
    );
    expect(reversed.status).toBe("APPROVED");

    const [reversalReceipt] = await db()
      .select()
      .from(s.receipts)
      .where(
        eq(
          s.receipts.referenceNumber,
          `PURCHASE-RETURN-REV:${reversalRequested.requestId}`,
        ),
      );
    expect(reversalReceipt).toMatchObject({
      direction: "OUT",
      amount: "200.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      partyType: "SUPPLIER",
      partyId: 1,
    });

    const [returnEntry] = await db()
      .select()
      .from(s.accountingEntries)
      .where(
        eq(
          s.accountingEntries.dedupeKey,
          `PURCHASE_RETURN_REVERSAL_REQUEST:${reversalRequested.requestId}`,
        ),
      );
    const [paymentOutEntry] = await db()
      .select()
      .from(s.accountingEntries)
      .where(
        eq(
          s.accountingEntries.dedupeKey,
          `PURCHASE_RETURN_REVERSAL_PAYMENT:${reversalRequested.requestId}`,
        ),
      );
    expect(returnEntry).toMatchObject({ entryType: "RETURN", amount: "200.00" });
    expect(paymentOutEntry).toMatchObject({ entryType: "PAYMENT_OUT" });

    const journalLines = await db()
      .select({
        role: s.journalLines.role,
        debit: s.journalLines.debit,
        credit: s.journalLines.credit,
      })
      .from(s.journalLines)
      .innerJoin(
        s.journalEntries,
        eq(s.journalEntries.id, s.journalLines.journalId),
      )
      .where(eq(s.journalEntries.entryId, Number(paymentOutEntry.id)));
    expect(journalLines.map((line) => [line.role, line.debit, line.credit])).toEqual(
      expect.arrayContaining([
        ["AP", "200.00", "0.00"],
        ["TREASURY_CASH", "0.00", "200.00"],
      ]),
    );

    const [supplierAfter] = await db()
      .select()
      .from(s.suppliers)
      .where(eq(s.suppliers.id, 1));
    expect(supplierAfter.currentBalance).toBe(
      supplierBeforeReturn.currentBalance,
    );
    expect(supplierAfter.currentBalanceUsd).toBe(
      supplierBeforeReturn.currentBalanceUsd,
    );

    const [returnAfter] = await db()
      .select()
      .from(s.purchaseReturns)
      .where(eq(s.purchaseReturns.id, Number(approved.purchaseReturnId)));
    expect(returnAfter).toMatchObject({ status: "REVERSED" });
  });
});
