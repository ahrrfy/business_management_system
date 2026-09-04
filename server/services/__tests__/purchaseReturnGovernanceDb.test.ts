import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createGoodsReceipt } from "../purchase/goodsReceipts";
import {
  createSupplierInvoice,
  decideSupplierInvoiceApproval,
  requestSupplierInvoiceApproval,
} from "../purchase/supplierInvoices";
import { runThreeWayMatch } from "../purchase/threeWayMatch";
import { createPurchaseOrder } from "../purchaseService";
import {
  decidePurchaseOrderControl,
  submitPurchaseOrderForApproval,
} from "../purchase/controls";
import {
  decidePurchaseReturn,
  decidePurchaseReturnReversal,
  requestPurchaseReturn,
  requestPurchaseReturnReversal,
} from "../purchase/returnGovernance";
import { truncateTables } from "./__testUtils__";

/**
 * مرتجعُ الشراء وعكسُه محوُ أثرٍ حقيقيّان (حركةُ مخزونٍ + قيدٌ + ذمّةُ مورّد) خلف بوّابة فصل
 * مهامٍ (decidePurchaseReturn/decidePurchaseReturnReversal) — الملفّ القائم
 * purchaseReturnGovernanceS5.test.ts يفحص دوالّ نقيّةً معزولة بلا معاملة ولا مخزون ولا قيد. هذا
 * الملفّ يسدّ الفجوة على قاعدةٍ حقيقية، ويثبت أنّ تجاوز المالك (٣/٩، 3227ce5b) يعمل فعلياً على
 * `purchaseReturnRequests`/`purchaseReturnReversalRequests` بعد إسقاط
 * `chk_purchase_return_request_maker_checker`/`chk_purchase_return_reversal_maker_checker`
 * في الهجرة 0333 (PR #982) — قبلها كانت محاولة المالك اعتماد طلبه تسقط بخطأ DB خامّ
 * (ER_CHECK_CONSTRAINT_VIOLATED). راجع ذاكرة [[owner-decision-no-second-approval-2026-09-03]].
 *
 * سلسلة التجهيز (أمر شراء معتمد ← إذن استلام ← فاتورة مورّد مطابَقة ومرحَّلة) منقولةٌ عن
 * makeGovernedReturnSource في purchaseReturnsForensicClosure.test.ts — الطريق الوحيد المُثبَت
 * لبناء مصدر مرتجعٍ محكوم صالح.
 */

const PURCHASING = { userId: 1, branchId: 1, role: "purchasing" as const };
const WAREHOUSE = { userId: 2, branchId: 1, role: "warehouse" as const };
/** owner نشطٌ — يُستعمَل هنا اختباراً لمساري الاعتماد الذاتي (طلبٌ + قرارٌ بنفس الهويّة). */
const OWNER = { userId: 3, branchId: 1, role: "manager" as const };

const TABLES = [
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
  "goodsReceiptItems",
  "goodsReceipts",
  "accountingEntries",
  "receipts",
  "inventoryMovements",
  "branchStock",
  "purchaseOrderControlRequests",
  "purchaseOrderRevisionItems",
  "purchaseOrderRevisions",
  "purchaseOrderItems",
  "purchaseOrders",
  "productUnits",
  "productVariants",
  "products",
  "suppliers",
  "branches",
  "users",
] as const;

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function seedBase() {
  await db().insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await db()
    .insert(s.users)
    .values([
      { id: 1, openId: "pr-gov-purchasing", name: "مسؤول المشتريات", role: "purchasing", loginMethod: "local", branchId: 1 },
      { id: 2, openId: "pr-gov-warehouse", name: "أمين المخزن", role: "warehouse", loginMethod: "local", branchId: 1 },
      { id: 3, openId: "pr-gov-owner", name: "المالك", role: "manager", loginMethod: "local", branchId: 1, isOwner: true },
    ]);
  await db().insert(s.suppliers).values({ id: 1, name: "مورد اختبار حوكمة المرتجع", currentBalance: "0.00" });
  await db().insert(s.products).values({ id: 1, name: "ورق تصوير" });
  await db().insert(s.productVariants).values({ id: 1, productId: 1, sku: "PR-GOV-1", costPrice: "0.00" });
  await db().insert(s.productUnits).values({ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true });
}

beforeEach(async () => {
  await truncateTables(TABLES);
  await seedBase();
});

async function makeOrder() {
  const created = await createPurchaseOrder(
    {
      supplierId: 1,
      branchId: 1,
      status: "DRAFT",
      settlementType: "CREDIT",
      items: [{ variantId: 1, productUnitId: 1, quantity: "2", unitPrice: "100.00" }],
    },
    PURCHASING,
  );
  const [item] = await db().select().from(s.purchaseOrderItems).where(eq(s.purchaseOrderItems.purchaseOrderId, created.purchaseOrderId));
  const submitted = await submitPurchaseOrderForApproval(
    {
      purchaseOrderId: created.purchaseOrderId,
      expectedVersion: created.version,
      reason: "إرسال أمر اختبار حوكمة المرتجع للمراجعة المستقلة",
      requestKey: `pr-gov-submit:${randomUUID()}`,
    },
    PURCHASING,
  );
  await decidePurchaseOrderControl(
    {
      requestId: submitted.requestId,
      decisionKey: `pr-gov-po-approve:${randomUUID()}`,
      approve: true,
      reason: "راجعت المورد والكميات والأسعار واعتمدت أمر الاختبار",
    },
    OWNER,
    { legacyConfirmOnly: true },
  );
  return { purchaseOrderId: created.purchaseOrderId, purchaseOrderItemId: Number(item.id) };
}

/** يبني مصدر مرتجعٍ محكوماً كاملاً: استلامٌ + فاتورةُ موردٍ مطابَقة ومرحَّلة. */
async function makeGovernedReturnSource() {
  const order = await makeOrder();
  const [approvedOrder] = await db().select().from(s.purchaseOrders).where(eq(s.purchaseOrders.id, order.purchaseOrderId));
  if (!approvedOrder?.approvedRevisionId) throw new Error("approved purchase-order revision is missing");

  const receipt = await createGoodsReceipt(
    {
      purchaseOrderId: order.purchaseOrderId,
      purchaseOrderRevisionId: Number(approvedOrder.approvedRevisionId),
      expectedOrderVersion: Number(approvedOrder.version),
      clientRequestId: `pr-gov-grn:${randomUUID()}`,
      supplierDeliveryNote: `DN-${randomUUID()}`,
      lines: [{ purchaseOrderItemId: order.purchaseOrderItemId, acceptedBaseQuantity: 2 }],
    },
    WAREHOUSE,
  );
  const [goodsReceiptItem] = await db().select().from(s.goodsReceiptItems).where(eq(s.goodsReceiptItems.goodsReceiptId, Number(receipt.goodsReceiptId)));
  if (!goodsReceiptItem?.purchaseOrderRevisionItemId) throw new Error("goods-receipt revision source is missing");

  const invoice = await createSupplierInvoice(
    {
      supplierId: 1,
      branchId: 1,
      clientRequestId: `pr-gov-invoice:${randomUUID()}`,
      externalInvoiceNumber: `EXT-${randomUUID()}`,
      invoiceDate: new Date().toISOString().slice(0, 10),
      currency: "IQD",
      evidenceType: "PDF",
      evidenceReference: `invoice-evidence:${randomUUID()}`,
      lines: [
        {
          purchaseOrderRevisionItemId: Number(goodsReceiptItem.purchaseOrderRevisionItemId),
          description: "ورق تصوير مطابق لمصدر الاستلام",
          invoicedBaseQuantity: 2,
          unitPrice: "100.00",
        },
      ],
    },
    PURCHASING,
  );
  const [invoiceRow, invoiceLine] = await Promise.all([
    db().select().from(s.supplierInvoices).where(eq(s.supplierInvoices.id, Number(invoice.supplierInvoiceId))).then((rows) => rows[0]),
    db().select().from(s.supplierInvoiceLines).where(eq(s.supplierInvoiceLines.supplierInvoiceId, Number(invoice.supplierInvoiceId))).then((rows) => rows[0]),
  ]);
  if (!invoiceRow || !invoiceLine) throw new Error("supplier-invoice source is missing");

  const match = await runThreeWayMatch(
    {
      supplierInvoiceId: Number(invoice.supplierInvoiceId),
      expectedInvoiceVersion: Number(invoiceRow.version),
      matchKey: `pr-gov-match:${randomUUID()}`,
      allocations: [{ supplierInvoiceLineId: Number(invoiceLine.id), goodsReceiptItemId: Number(goodsReceiptItem.id), matchedBaseQuantity: 2 }],
    },
    PURCHASING,
  );
  expect(match.outcome).toBe("EXACT");

  const [matchedInvoice] = await db().select().from(s.supplierInvoices).where(eq(s.supplierInvoices.id, Number(invoice.supplierInvoiceId)));
  const approval = await requestSupplierInvoiceApproval(
    {
      supplierInvoiceId: Number(invoice.supplierInvoiceId),
      expectedInvoiceVersion: Number(matchedInvoice.version),
      requestKey: `pr-gov-invoice-approval:${randomUUID()}`,
      kind: "POST_INVOICE",
      matchRunId: Number(match.matchRunId),
      reason: "مطابقة الفاتورة وإذن الاستلام وأمر الشراء مكتملة",
    },
    PURCHASING,
  );
  await decideSupplierInvoiceApproval(
    {
      requestId: Number(approval.requestId),
      decisionKey: `pr-gov-invoice-decision:${randomUUID()}`,
      action: "APPROVE",
      reviewReason: "راجعت أدلة المطابقة الثلاثية واعتمدت ترحيل الفاتورة",
    },
    OWNER,
  );

  const [[postedInvoice], [allocation]] = await Promise.all([
    db().select().from(s.supplierInvoices).where(eq(s.supplierInvoices.id, Number(invoice.supplierInvoiceId))),
    db().select().from(s.supplierInvoiceMatchAllocations).where(eq(s.supplierInvoiceMatchAllocations.matchRunId, Number(match.matchRunId))),
  ]);
  if (!postedInvoice || !allocation) throw new Error("governed return source is incomplete");
  expect(postedInvoice.status).toBe("POSTED");

  return {
    supplierInvoiceId: Number(postedInvoice.id),
    supplierInvoiceVersion: Number(postedInvoice.version),
    matchRunId: Number(match.matchRunId),
    matchAllocationId: Number(allocation.id),
  };
}

function returnRequestInput(source: Awaited<ReturnType<typeof makeGovernedReturnSource>>) {
  return {
    supplierInvoiceId: source.supplierInvoiceId,
    matchRunId: source.matchRunId,
    expectedInvoiceVersion: source.supplierInvoiceVersion,
    requestKey: `pr-gov-return-request:${randomUUID()}`,
    settlement: "CREDIT" as const,
    paymentMethod: "TRANSFER" as const,
    evidenceType: "RETURN_NOTE" as const,
    evidenceReference: `return-note:${randomUUID()}`,
    reason: "إرجاع وحدة معيبة إلى المورد بعد المطابقة الثلاثية",
    lines: [{ matchAllocationId: source.matchAllocationId, baseQuantity: 1, reason: "وحدة تالفة مثبتة بمحضر الفحص" }],
  };
}

describe("حوكمة مرتجع الشراء — فصل المهام على قاعدةٍ حقيقية", () => {
  it("يرفض اعتماد طالب المرتجع لطلبه ذاته", async () => {
    const source = await makeGovernedReturnSource();
    const requested = await requestPurchaseReturn(returnRequestInput(source), PURCHASING);
    expect(requested.status).toBe("PENDING");

    await expect(
      decidePurchaseReturn(
        { requestId: Number(requested.requestId), decisionKey: randomUUID(), action: "APPROVE", reviewReason: "محاولة اعتماد ذاتي" },
        PURCHASING,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(await db().select().from(s.purchaseReturns)).toHaveLength(0);
  });

  it("يعتمد المالكُ طلب مرتجعٍ أنشأه هو بنفسه فيُسجَّل المرتجع فعلياً (لا خطأ DB خامّ بعد الهجرة 0333)", async () => {
    const source = await makeGovernedReturnSource();
    const requested = await requestPurchaseReturn(returnRequestInput(source), OWNER);
    expect(requested.status).toBe("PENDING");

    const approved = await decidePurchaseReturn(
      { requestId: Number(requested.requestId), decisionKey: randomUUID(), action: "APPROVE", reviewReason: "اعتماد ذاتي — قرار المالك ٣/٩/٢٦" },
      OWNER,
    );
    expect(approved.status).toBe("APPROVED");

    const [purchaseReturn] = await db().select().from(s.purchaseReturns).where(eq(s.purchaseReturns.id, Number(approved.purchaseReturnId)));
    expect(purchaseReturn).toMatchObject({ status: "POSTED", settlement: "CREDIT" });

    const [request] = await db().select().from(s.purchaseReturnRequests).where(eq(s.purchaseReturnRequests.id, Number(requested.requestId)));
    expect(request).toMatchObject({ status: "APPROVED", requestedBy: OWNER.userId, reviewedBy: OWNER.userId });

    return { purchaseReturnId: Number(approved.purchaseReturnId) };
  });
});

describe("حوكمة عكس مرتجع الشراء — فصل المهام على قاعدةٍ حقيقية", () => {
  /** يبني مرتجعاً معتمَداً (باعتمادٍ مستقلّ عاديّ) لتجهيز سياق اختبارات العكس. */
  async function approveFreshReturn() {
    const source = await makeGovernedReturnSource();
    const requested = await requestPurchaseReturn(returnRequestInput(source), PURCHASING);
    const approved = await decidePurchaseReturn(
      { requestId: Number(requested.requestId), decisionKey: randomUUID(), action: "APPROVE", reviewReason: "راجعت المطابقة والكمية والدليل واعتمدت المرتجع" },
      OWNER,
    );
    expect(approved.status).toBe("APPROVED");
    const [item] = await db().select().from(s.purchaseReturnItems).where(eq(s.purchaseReturnItems.purchaseReturnId, Number(approved.purchaseReturnId)));
    return { purchaseReturnId: Number(approved.purchaseReturnId), purchaseReturnItemId: Number(item.id) };
  }

  it("يرفض اعتماد طالب العكس لطلبه ذاته", async () => {
    const { purchaseReturnId, purchaseReturnItemId } = await approveFreshReturn();
    const requested = await requestPurchaseReturnReversal(
      {
        purchaseReturnId,
        expectedReturnVersion: 1,
        requestKey: `pr-gov-reversal-request:${randomUUID()}`,
        evidenceType: "SIGNED_APPROVAL",
        evidenceReference: `reversal-evidence:${randomUUID()}`,
        reason: "عكسٌ اختباريّ لمرتجعٍ سجَّلناه بالخطأ",
        lines: [{ purchaseReturnItemId, baseQuantity: 1 }],
      },
      PURCHASING,
    );
    expect(requested.status).toBe("PENDING");

    await expect(
      decidePurchaseReturnReversal(
        { requestId: Number(requested.requestId), decisionKey: randomUUID(), action: "APPROVE", reviewReason: "محاولة اعتماد ذاتي للعكس" },
        PURCHASING,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const [purchaseReturn] = await db().select().from(s.purchaseReturns).where(eq(s.purchaseReturns.id, purchaseReturnId));
    expect(purchaseReturn.status).toBe("POSTED");
  });

  it("يعتمد المالكُ طلب عكسٍ أنشأه هو بنفسه فيُعكَس المرتجع فعلياً (لا خطأ DB خامّ بعد الهجرة 0333)", async () => {
    const { purchaseReturnId, purchaseReturnItemId } = await approveFreshReturn();
    const requested = await requestPurchaseReturnReversal(
      {
        purchaseReturnId,
        expectedReturnVersion: 1,
        requestKey: `pr-gov-reversal-request:${randomUUID()}`,
        evidenceType: "SIGNED_APPROVAL",
        evidenceReference: `reversal-evidence:${randomUUID()}`,
        reason: "عكسٌ ذاتيّ — قرار المالك ٣/٩/٢٦",
        lines: [{ purchaseReturnItemId, baseQuantity: 1 }],
      },
      OWNER,
    );
    expect(requested.status).toBe("PENDING");

    const decided = await decidePurchaseReturnReversal(
      { requestId: Number(requested.requestId), decisionKey: randomUUID(), action: "APPROVE", reviewReason: "اعتماد ذاتي — قرار المالك ٣/٩/٢٦" },
      OWNER,
    );
    expect(decided.status).toBe("APPROVED");

    const [purchaseReturn] = await db().select().from(s.purchaseReturns).where(eq(s.purchaseReturns.id, purchaseReturnId));
    expect(purchaseReturn.status).toBe("REVERSED");

    const [request] = await db().select().from(s.purchaseReturnReversalRequests).where(eq(s.purchaseReturnReversalRequests.id, Number(requested.requestId)));
    expect(request).toMatchObject({ status: "APPROVED", requestedBy: OWNER.userId, reviewedBy: OWNER.userId });
  });
});
