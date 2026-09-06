import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { decidePurchaseOrderControl } from "../purchase/controls";
import { decideSupplierPayment } from "../purchase/supplierPayments";
import { confirmPurchaseOrder, createPurchaseOrder } from "../purchaseService";
import { truncateTables } from "./__testUtils__";

const creator = { userId: 1, branchId: 1, role: "admin" as const };
const approver = { userId: 2, branchId: 1, role: "manager" as const };
const treasurer = { userId: 3, branchId: 1, role: "manager" as const };

const TABLES = [
  "idempotencyKeys",
  "auditLogs",
  "purchaseOrderEvents",
  "purchaseOrderControlRequests",
  "purchaseOrderRequisitionAllocations",
  "purchaseOrderRevisionItems",
  "purchaseOrderRevisions",
  "supplierInvoiceApprovalRequests",
  "supplierInvoiceMatchAllocations",
  "supplierInvoiceMatchRuns",
  "supplierInvoiceLines",
  "supplierPaymentAllocations",
  "supplierPayments",
  "supplierPaymentRequestAllocations",
  "supplierPaymentRequests",
  "supplierInvoices",
  "goodsReceiptAccountingLinks",
  "goodsReceiptItems",
  "goodsReceipts",
  "journalLines",
  "journalEntries",
  "doubleEntrySettings",
  "accrualObligationEvents",
  "accrualObligations",
  "accountingEntries",
  "expenses",
  "receipts",
  "financialPeriods",
  "inventoryMovements",
  "purchaseOrderItems",
  "purchaseOrders",
  "purchaseControlSettings",
  "branchStock",
  "productUnits",
  "productVariants",
  "products",
  "suppliers",
  "branches",
  "users",
] as const;

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set");
  return value;
}

async function seed() {
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
        openId: "purchase-auto-creator",
        name: "منشئ أمر الشراء",
        role: "admin",
        loginMethod: "local",
        branchId: 1,
      },
      {
        id: 2,
        openId: "purchase-auto-approver",
        name: "معتمد مستقل",
        role: "manager",
        loginMethod: "local",
        branchId: 1,
      },
      {
        id: 3,
        openId: "purchase-auto-treasurer",
        name: "معتمد الصرف",
        role: "manager",
        loginMethod: "local",
        branchId: 1,
        isOwner: true,
      },
    ]);
  await db().insert(s.suppliers).values({
    id: 1,
    name: "مورد",
    currentBalance: "0.00",
  });
  await db().insert(s.products).values({ id: 1, name: "ورق" });
  await db().insert(s.productVariants).values({
    id: 1,
    productId: 1,
    sku: "PAPER-AUTO",
    costPrice: "4.00",
  });
  await db().insert(s.productUnits).values({
    id: 1,
    variantId: 1,
    unitName: "قطعة",
    conversionFactor: "1",
    isBaseUnit: true,
  });
  await db().insert(s.branchStock).values({
    variantId: 1,
    branchId: 1,
    quantity: 10,
  });
}

async function artifactCounts() {
  const [
    goodsReceipts,
    goodsReceiptItems,
    goodsReceiptLinks,
    supplierInvoices,
    supplierInvoiceLines,
    matchRuns,
    matchAllocations,
    movements,
    entries,
  ] = await Promise.all([
    db().select().from(s.goodsReceipts),
    db().select().from(s.goodsReceiptItems),
    db().select().from(s.goodsReceiptAccountingLinks),
    db().select().from(s.supplierInvoices),
    db().select().from(s.supplierInvoiceLines),
    db().select().from(s.supplierInvoiceMatchRuns),
    db().select().from(s.supplierInvoiceMatchAllocations),
    db().select().from(s.inventoryMovements),
    db().select().from(s.accountingEntries),
  ]);
  return {
    goodsReceipts: goodsReceipts.length,
    goodsReceiptItems: goodsReceiptItems.length,
    goodsReceiptLinks: goodsReceiptLinks.length,
    supplierInvoices: supplierInvoices.length,
    supplierInvoiceLines: supplierInvoiceLines.length,
    matchRuns: matchRuns.length,
    matchAllocations: matchAllocations.length,
    movements: movements.length,
    entries: entries.length,
  };
}

beforeEach(async () => {
  await truncateTables(TABLES);
  await seed();
});

describe("اعتماد أمر الشراء يرحّل الفاتورة والاستلام آلياً", () => {
  it("يمر DRAFT → SENT → RECEIVED ويثبت WAVG وGRN/GRNI وAP مرة واحدة حتى عند replay", async () => {
    const draft = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        status: "DRAFT",
        settlementType: "CREDIT",
        shippingCost: "5.00",
        customsCost: "2.00",
        clientRequestId: "purchase-auto-draft",
        items: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "10",
            unitPrice: "6.00",
          },
        ],
      },
      creator,
    );

    expect(draft.status).toBe("DRAFT");
    expect(await artifactCounts()).toEqual({
      goodsReceipts: 0,
      goodsReceiptItems: 0,
      goodsReceiptLinks: 0,
      supplierInvoices: 0,
      supplierInvoiceLines: 0,
      matchRuns: 0,
      matchAllocations: 0,
      movements: 0,
      entries: 0,
    });

    const request = await confirmPurchaseOrder(
      {
        purchaseOrderId: draft.purchaseOrderId,
        expectedVersion: draft.version,
        reason: "اكتملت مراجعة أمر الشراء وأرسل للاعتماد",
        clientRequestId: "purchase-auto-submit",
      },
      creator,
    );
    expect(request).toMatchObject({ status: "PENDING", idempotent: false });
    expect(
      (
        await db()
          .select({ status: s.purchaseOrders.status })
          .from(s.purchaseOrders)
          .where(eq(s.purchaseOrders.id, draft.purchaseOrderId))
      )[0]?.status,
    ).toBe("SENT");
    expect(await artifactCounts()).toMatchObject({
      goodsReceipts: 0,
      supplierInvoices: 0,
      movements: 0,
      entries: 0,
    });

    const decision = {
      requestId: request.requestId,
      // مفتاحُ القرار بصيغة الشاشة حرفياً (PurchaseApprovalQueue) — ~٨٠ محرفاً. كان عمود
      // idempotencyKeys.clientRequestId ٦٤ فسقط الاعتمادُ على الإنتاج بـ«قيمة أطول من المسموح»
      // بينما تمرّ هذه الحزمة بمفتاحٍ قصير (هجرة 0328، ٣/٩/٢٦).
      decisionKey: `purchase-decision-PURCHASE_ORDER-${request.requestId}-approve-${randomUUID()}`,
      approve: true,
      reason: "تحققت من المورد والأسعار ووصول كامل الكميات",
      confirmedFullReceipt: true,
    } as const;
    expect(decision.decisionKey.length).toBeGreaterThan(64);
    const approved = await decidePurchaseOrderControl(decision, approver);
    expect(approved).toMatchObject({
      status: "APPROVED",
      orderStatus: "RECEIVED",
      idempotent: false,
    });

    const [
      [order],
      [item],
      [stock],
      [variant],
      [movement],
      [receipt],
      [invoice],
      [match],
      entries,
      [supplier],
      [shippingExpense],
      [shippingObligation],
      [shippingPaymentRequest],
    ] = await Promise.all([
      db()
        .select()
        .from(s.purchaseOrders)
        .where(eq(s.purchaseOrders.id, draft.purchaseOrderId)),
      db()
        .select()
        .from(s.purchaseOrderItems)
        .where(eq(s.purchaseOrderItems.purchaseOrderId, draft.purchaseOrderId)),
      db().select().from(s.branchStock).where(eq(s.branchStock.variantId, 1)),
      db().select().from(s.productVariants).where(eq(s.productVariants.id, 1)),
      db().select().from(s.inventoryMovements),
      db().select().from(s.goodsReceipts),
      db().select().from(s.supplierInvoices),
      db().select().from(s.supplierInvoiceMatchRuns),
      db()
        .select()
        .from(s.accountingEntries)
        .where(eq(s.accountingEntries.purchaseOrderId, draft.purchaseOrderId)),
      db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)),
      db().select().from(s.expenses),
      db().select().from(s.accrualObligations),
      db().select().from(s.receipts),
    ]);

    expect(order.status).toBe("RECEIVED");
    expect(item.receivedBaseQuantity).toBe(10);
    expect(stock.quantity).toBe(20);
    expect(variant.costPrice).toBe("5.00");
    expect(movement).toMatchObject({
      movementType: "IN",
      quantity: 10,
      signedDelta: 10,
      referenceType: "GOODS_RECEIPT",
      referenceId: receipt.id,
    });
    expect(receipt).toMatchObject({
      purchaseOrderId: draft.purchaseOrderId,
      status: "POSTED",
      totalAmount: "60.00",
    });
    expect(invoice).toMatchObject({
      status: "POSTED",
      liabilityClass: "NATIVE_AP",
      paymentGate: "OPEN",
      totalAmount: "60.00",
    });
    expect(invoice.postingEntryId).not.toBeNull();
    expect(match).toMatchObject({
      supplierInvoiceId: invoice.id,
      outcome: "EXACT",
      receivedBaseQuantity: 10,
      invoicedBaseQuantity: 10,
    });
    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => entry.dedupeKey)).toEqual(
      expect.arrayContaining([
        `GRNI:RECEIPT:${receipt.id}`,
        `GRNI:SUPPLIER_INVOICE:${invoice.id}`,
        expect.stringMatching(/^PURCHASE_SHIPPING_ACCRUAL:/),
      ]),
    );
    expect(entries.every((entry) => entry.entryType === "ADJUST")).toBe(true);
    expect(supplier.currentBalance).toBe("60.00");
    expect(shippingExpense).toMatchObject({
      amount: "7.00",
      category: "TRANSPORT",
      source: "ACCRUAL",
      status: "ACTIVE",
    });
    expect(shippingObligation).toMatchObject({
      kind: "PURCHASE_SHIPPING",
      purchaseOrderId: draft.purchaseOrderId,
      recognizedAmount: "7.00",
      status: "PAYMENT_PENDING",
    });
    expect(shippingPaymentRequest).toMatchObject({
      direction: "OUT",
      amount: "7.00",
      approvalStatus: "PENDING_APPROVAL",
      status: "PENDING",
    });

    const beforeReplay = await artifactCounts();
    const replay = await decidePurchaseOrderControl(decision, approver);
    expect(replay).toMatchObject({ status: "APPROVED", idempotent: true });
    expect(await artifactCounts()).toEqual(beforeReplay);
    expect((await db().select().from(s.branchStock))[0]?.quantity).toBe(20);
    expect((await db().select().from(s.productVariants))[0]?.costPrice).toBe(
      "5.00",
    );
    expect((await db().select().from(s.suppliers))[0]?.currentBalance).toBe(
      "60.00",
    );
  });
});

describe("أمر الشراء النقدي يطلب تسويته تلقائياً عند الاعتماد (بلاغ المالك ٦/٩/٢٦)", () => {
  beforeEach(async () => {
    // تمويل خزينة الفرع — لازمٌ فقط لاختبارَي هذه المجموعة (اعتماد دفعة نقدية فعلية)؛
    // خارج seed() المشتركة كي لا تُغيّر عدد صفوف receipts في اختبار المجموعة الأولى.
    await db().insert(s.receipts).values({
      branchId: 1,
      shiftId: null,
      cashBucket: "TREASURY",
      direction: "IN",
      amount: "5000.00",
      paymentMethod: "CASH",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      referenceNumber: "CASH-PO-TREASURY-FUND",
      createdBy: 1,
    });
  });

  async function approveCashOrder() {
    const draft = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        status: "DRAFT",
        settlementType: "CASH",
        clientRequestId: "cash-settle-draft",
        items: [
          { variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "6.00" },
        ],
      },
      creator,
    );
    const submitted = await confirmPurchaseOrder(
      {
        purchaseOrderId: draft.purchaseOrderId,
        expectedVersion: draft.version,
        reason: "اكتملت مراجعة أمر الشراء وأرسل للاعتماد",
        clientRequestId: "cash-settle-submit",
      },
      creator,
    );
    await decidePurchaseOrderControl(
      {
        requestId: submitted.requestId,
        decisionKey: `purchase-decision-PURCHASE_ORDER-${submitted.requestId}-approve-${randomUUID()}`,
        approve: true,
        reason: "تحققت من المورد والأسعار ووصول كامل الكميات",
        confirmedFullReceipt: true,
      },
      approver,
    );
    return draft.purchaseOrderId;
  }

  it("ينشئ طلب سداد معلَّقاً بكامل قيمة الفاتورة، ولا يعتمده مُنشئ الطلب نفسه", async () => {
    const purchaseOrderId = await approveCashOrder();

    const [invoice] = await db()
      .select()
      .from(s.supplierInvoices)
      .where(eq(s.supplierInvoices.supplierId, 1));
    expect(invoice).toMatchObject({ status: "POSTED", paymentGate: "OPEN" });

    const [request] = await db()
      .select()
      .from(s.supplierPaymentRequests)
      .where(eq(s.supplierPaymentRequests.supplierId, 1));
    expect(request).toMatchObject({
      status: "PENDING",
      paymentMethod: "CASH",
      requestedAmount: "60.00",
      requestedBy: approver.userId,
    });

    const [allocation] = await db()
      .select()
      .from(s.supplierPaymentRequestAllocations)
      .where(eq(s.supplierPaymentRequestAllocations.requestId, request.id));
    expect(allocation).toMatchObject({
      supplierInvoiceId: invoice.id,
      requestedAmount: "60.00",
    });

    // الذمّة لا تزال قائمة — الأمر النقديّ يبقى ذمّةً حقيقية حتى يُعتمَد صرفها فعلاً.
    expect((await db().select().from(s.suppliers))[0]?.currentBalance).toBe(
      "60.00",
    );

    // فصل المهام: مُعتمِد أمر الشراء (وهو من طلب التسوية تلقائياً) لا يعتمد صرفها بنفسه.
    await expect(
      decideSupplierPayment(
        {
          requestId: Number(request.id),
          decisionKey: `cash-settle-self-${randomUUID()}`,
          action: "APPROVE",
          reviewReason: "محاولة اعتماد ذاتي",
        },
        approver,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await db().select().from(s.suppliers))[0]?.currentBalance).toBe(
      "60.00",
    );

    // معتمِدٌ مستقلّ ثانٍ يُطفئ الذمّة فعلاً.
    const decided = await decideSupplierPayment(
      {
        requestId: Number(request.id),
        decisionKey: `cash-settle-approve-${randomUUID()}`,
        action: "APPROVE",
        reviewReason: "سُلِّم النقد للمورد فعلياً",
      },
      treasurer,
    );
    expect(decided.status).toBe("APPROVED");
    expect((await db().select().from(s.suppliers))[0]?.currentBalance).toBe(
      "0.00",
    );
    expect(
      (
        await db()
          .select()
          .from(s.supplierInvoices)
          .where(eq(s.supplierInvoices.id, invoice.id))
      )[0]?.paymentGate,
    ).toBe("SETTLED");
    const [paymentEntry] = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.entryType, "PAYMENT_OUT"));
    expect(paymentEntry).toMatchObject({ supplierId: 1, amount: "60.00" });
  });

  it("لا ينشئ أيّ طلب سداد لأمرٍ آجل", async () => {
    const draft = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        status: "DRAFT",
        settlementType: "CREDIT",
        clientRequestId: "credit-no-autopay-draft",
        items: [
          { variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "6.00" },
        ],
      },
      creator,
    );
    const submitted = await confirmPurchaseOrder(
      {
        purchaseOrderId: draft.purchaseOrderId,
        expectedVersion: draft.version,
        reason: "اكتملت مراجعة أمر الشراء وأرسل للاعتماد",
        clientRequestId: "credit-no-autopay-submit",
      },
      creator,
    );
    await decidePurchaseOrderControl(
      {
        requestId: submitted.requestId,
        decisionKey: `purchase-decision-PURCHASE_ORDER-${submitted.requestId}-approve-${randomUUID()}`,
        approve: true,
        reason: "تحققت من المورد والأسعار ووصول كامل الكميات",
        confirmedFullReceipt: true,
      },
      approver,
    );
    expect(await db().select().from(s.supplierPaymentRequests)).toHaveLength(0);
    expect((await db().select().from(s.suppliers))[0]?.currentBalance).toBe(
      "60.00",
    );
  });
});
