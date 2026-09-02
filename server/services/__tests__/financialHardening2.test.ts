// تحصين مالي صارم (٧ بنود) — اختبارات تمرّ عبر **الراوتر الفعلي** (لا تتجاوزه) + السلوك الجديد.
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { createSale } from "../saleService";
import { createPurchaseOrder, receivePurchase } from "../purchaseService";
import { createWorkOrder, startWorkOrder, markWorkOrderReady, deliverWorkOrder,
} from "../workOrderService";
import { openShift } from "../shiftService";
import { reconcileSupplierBalances } from "../reconcileService";
import { money } from "../money";
import { approveVoucher } from "../voucher/approval";
import {
  confirmExternalPaymentAttempt,
  initiateExternalPaymentAttempt,
} from "../posExternalPayment";
import {
  decidePurchaseOrderControl,
  submitPurchaseOrderForApproval,
} from "../purchase/controls";
import { createGoodsReceipt } from "../purchase/goodsReceipts";
import {
  createSupplierInvoice,
  decideSupplierInvoiceApproval,
  requestSupplierInvoiceApproval,
} from "../purchase/supplierInvoices";
import { runThreeWayMatch } from "../purchase/threeWayMatch";
import {
  approveWorkOrderControlRequest,
  requestWorkOrderControl,
} from "../workOrder/controlRequests";
import {
  decideWorkOrderDesignApproval,
  requestWorkOrderDesignApproval,
} from "../workOrder/designApproval";

const actor = { userId: 1, branchId: 1 };
const owner = { userId: 2, branchId: 1, role: "manager" as const };
const warehouse = { userId: 3, branchId: 1, role: "warehouse" as const };
const adminCtx = { req: { headers: {}, ip: "127.0.0.1" } as any, res: { cookie() {}, clearCookie() {} } as any, user: { id: 1, role: "admin", branchId: 1 } as any,
};
const caller = () => appRouter.createCaller(adminCtx);
const warehouseCaller = () => appRouter.createCaller({
  req: { headers: {}, ip: "127.0.0.1" } as any,
  res: { cookie() {}, clearCookie() {} } as any,
  user: { id: 3, role: "warehouse", branchId: 1 } as any,
});
const ownerCaller = () => appRouter.createCaller({
  req: { headers: {}, ip: "127.0.0.1" } as any,
  res: { cookie() {}, clearCookie() {} } as any,
  user: { id: 2, role: "manager", branchId: 1 } as any,
});

const TABLES = [
  "voucherCategories", "journalLines", "journalEntries",
  "purchaseReturnItems", "purchaseReturns", "purchaseReturnRequestItems", "purchaseReturnRequests",
  "supplierInvoiceApprovalRequests", "supplierInvoiceMatchAllocations", "supplierInvoiceMatchRuns",
  "supplierInvoiceLines", "supplierInvoices", "goodsReceiptAccountingLinks", "goodsReceiptItems", "goodsReceipts",
  "externalPaymentAttempts",
  "purchaseOrderEvents", "purchaseOrderControlRequests", "purchaseOrderRequisitionAllocations", "purchaseOrderRevisionItems", "purchaseOrderRevisions",
  "workOrderEvents", "workOrderControlRequests", "workOrderDesignApprovals", "workOrderDesignRevisions", "taskEvents", "tasks", "serviceTypes",
  "salesExchangeCommands", "salesControlRequests", "returnRequests", "idempotencyKeys", "auditLogs",
  "accountingEntries", "receipts", "expenses", "inventoryMovements", "invoiceItems", "invoices",
  "purchaseOrderItems", "purchaseOrders", "branchStock", "productPrices", "productUnits", "productVariants", "products",
  "shifts", "workOrderImages", "workOrderItems", "workOrderMaterials", "workOrders", "customers", "suppliers", "branches", "users",
];
function db() { const d = getDb(); if (!d) throw new Error("no DB"); return d; }
async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}
async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الفرع", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([
    { id: 1, openId: "local_test", name: "admin", role: "admin", loginMethod: "local", branchId: 1, isOwner: false,
    },
    { id: 2, openId: "local_owner", name: "owner", role: "manager", loginMethod: "local", branchId: 1, isOwner: true,
    },
    { id: 3, openId: "local_warehouse", name: "warehouse", role: "warehouse", loginMethod: "local", branchId: 1, isOwner: false,
    },
  ]);
  await d.insert(s.serviceTypes).values({
    name: "موافقة تصميم",
    defaultKind: "SERVICE_REQUEST",
    defaultPriority: "HIGH",
    slaHours: 24,
    blocksExecution: true,
    isActive: true,
  });
  await d.insert(s.voucherCategories).values({ id: 10, name: "إيجار اختباري", direction: "OUT", postingRole: "RENT",
  });
  await d.insert(s.products).values({ id: 1, name: "قلم" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "PEN-1", costPrice: "4.00" });
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true,
    },
  ]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "10.00" }]);
}
const setStock = (variantId: number, branchId: number, qty: number) => db().insert(s.branchStock).values({ variantId, branchId, quantity: qty });
const count = async (where?: any) => (await db().select().from(s.accountingEntries)).length;

async function fundCash(cashBucket: "DRAWER" | "TREASURY", amount: string, shiftId: number | null = null,
) {
  await db().insert(s.receipts).values({
    branchId: 1,
    shiftId,
    direction: "IN",
    amount,
    paymentMethod: "CASH",
    cashBucket,
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    referenceNumber: `TEST-${cashBucket}-FUND`,
    createdBy: 2,
  });
}

async function createApprovedPurchaseOrder(unitPrice: string) {
  const po = await createPurchaseOrder({
    supplierId: 1,
    branchId: 1,
    taxRatePercent: "0",
    status: "DRAFT",
    items: [{ variantId: 1, productUnitId: 1, quantity: "10", unitPrice }],
  }, actor);
  const submitted = await submitPurchaseOrderForApproval({
    purchaseOrderId: po.purchaseOrderId,
    expectedVersion: po.version,
    reason: "إرسال أمر اختبار التحصين المالي للمراجعة",
    requestKey: `hardening2-po-submit:${randomUUID()}`,
  }, actor);
  await decidePurchaseOrderControl({
    requestId: submitted.requestId,
    decisionKey: `hardening2-po-approve:${randomUUID()}`,
    approve: true,
    reason: "راجعت المورد والكميات والأسعار واعتمدت الأمر",
  }, owner, { legacyConfirmOnly: true });
  return po;
}

async function createGovernedPurchaseReturnSource(unitPrice: string) {
  const po = await createApprovedPurchaseOrder(unitPrice);
  const [[approvedOrder], [poItem]] = await Promise.all([
    db().select().from(s.purchaseOrders)
      .where(eq(s.purchaseOrders.id, po.purchaseOrderId)),
    db().select().from(s.purchaseOrderItems)
      .where(eq(s.purchaseOrderItems.purchaseOrderId, po.purchaseOrderId)),
  ]);
  if (!approvedOrder?.approvedRevisionId || !poItem) {
    throw new Error("approved purchase-order source is incomplete");
  }

  const receipt = await createGoodsReceipt({
    purchaseOrderId: po.purchaseOrderId,
    purchaseOrderRevisionId: Number(approvedOrder.approvedRevisionId),
    expectedOrderVersion: Number(approvedOrder.version),
    clientRequestId: `hardening2-grn:${randomUUID()}`,
    supplierDeliveryNote: `DN-${randomUUID()}`,
    lines: [{
      purchaseOrderItemId: Number(poItem.id),
      acceptedBaseQuantity: 10,
    }],
  }, warehouse);
  const [goodsReceiptItem] = await db().select().from(s.goodsReceiptItems)
    .where(eq(s.goodsReceiptItems.goodsReceiptId, Number(receipt.goodsReceiptId)));
  if (!goodsReceiptItem?.purchaseOrderRevisionItemId) {
    throw new Error("goods-receipt source is incomplete");
  }

  const invoice = await createSupplierInvoice({
    supplierId: 1,
    branchId: 1,
    clientRequestId: `hardening2-supplier-invoice:${randomUUID()}`,
    externalInvoiceNumber: `EXT-${randomUUID()}`,
    invoiceDate: new Date().toISOString().slice(0, 10),
    currency: "IQD",
    evidenceType: "PDF",
    evidenceReference: `invoice-evidence:${randomUUID()}`,
    lines: [{
      purchaseOrderRevisionItemId: Number(goodsReceiptItem.purchaseOrderRevisionItemId),
      description: "بند فاتورة مورد مطابق للاستلام",
      invoicedBaseQuantity: 10,
      unitPrice,
    }],
  }, { ...actor, role: "admin" });
  const [[invoiceRow], [invoiceLine]] = await Promise.all([
    db().select().from(s.supplierInvoices)
      .where(eq(s.supplierInvoices.id, Number(invoice.supplierInvoiceId))),
    db().select().from(s.supplierInvoiceLines)
      .where(eq(s.supplierInvoiceLines.supplierInvoiceId, Number(invoice.supplierInvoiceId))),
  ]);
  if (!invoiceRow || !invoiceLine) throw new Error("supplier-invoice source is incomplete");

  const match = await runThreeWayMatch({
    supplierInvoiceId: Number(invoice.supplierInvoiceId),
    expectedInvoiceVersion: Number(invoiceRow.version),
    matchKey: `hardening2-match:${randomUUID()}`,
    allocations: [{
      supplierInvoiceLineId: Number(invoiceLine.id),
      goodsReceiptItemId: Number(goodsReceiptItem.id),
      matchedBaseQuantity: 10,
    }],
  }, { ...actor, role: "admin" });
  expect(match.outcome).toBe("EXACT");

  const [matchedInvoice] = await db().select().from(s.supplierInvoices)
    .where(eq(s.supplierInvoices.id, Number(invoice.supplierInvoiceId)));
  const approval = await requestSupplierInvoiceApproval({
    supplierInvoiceId: Number(invoice.supplierInvoiceId),
    expectedInvoiceVersion: Number(matchedInvoice.version),
    requestKey: `hardening2-invoice-approval:${randomUUID()}`,
    kind: "POST_INVOICE",
    matchRunId: Number(match.matchRunId),
    reason: "اكتملت المطابقة الثلاثية لفاتورة مورد الاختبار",
  }, { ...actor, role: "admin" });
  await decideSupplierInvoiceApproval({
    requestId: Number(approval.requestId),
    decisionKey: `hardening2-invoice-decision:${randomUUID()}`,
    action: "APPROVE",
    reviewReason: "راجعت المطابقة والأدلة واعتمدت ترحيل الفاتورة",
  }, owner);

  const [[postedInvoice], [allocation]] = await Promise.all([
    db().select().from(s.supplierInvoices)
      .where(eq(s.supplierInvoices.id, Number(invoice.supplierInvoiceId))),
    db().select().from(s.supplierInvoiceMatchAllocations)
      .where(eq(s.supplierInvoiceMatchAllocations.matchRunId, Number(match.matchRunId))),
  ]);
  if (!postedInvoice || !allocation) throw new Error("posted return source is incomplete");
  return {
    purchaseOrderId: po.purchaseOrderId,
    supplierInvoiceId: Number(postedInvoice.id),
    supplierInvoiceVersion: Number(postedInvoice.version),
    matchRunId: Number(match.matchRunId),
    matchAllocationId: Number(allocation.id),
  };
}

async function approveCurrentDesign(workOrderId: number) {
  const requested = await requestWorkOrderDesignApproval({
    workOrderId,
    requestKey: `hardening2-design-request:${randomUUID()}`,
    note: "اعتماد التصميم قبل بدء التنفيذ",
  }, { ...actor, role: "admin" });
  await decideWorkOrderDesignApproval({
    approvalId: Number(requested.approval.id),
    decisionKey: `hardening2-design-approve:${randomUUID()}`,
    decision: "APPROVED",
    reason: "وافق العميل على التصميم النهائي",
    evidence: {
      type: "WHATSAPP_MESSAGE",
      reference: `wamid.hardening2.${randomUUID()}`,
    },
  }, owner);
}

beforeEach(async () => { await reset(); await seedBase(); });

describe("#1 idempotency عبر الراوتر الفعلي (النقر المزدوج ⇒ معاملة واحدة)", () => {
  it("returns.create: نفس clientRequestId ⇒ طلب واحد صفري الأثر", async () => {
    await setStock(1, 1, 10);
    await db().insert(s.customers).values({ id: 1, name: "عميل", defaultPriceTier: "RETAIL", currentBalance: "0",
    });
    // M8: البيع النقدي يَستوجب وردية مفتوحة.
    const { shiftId } = await openShift({ branchId: 1, openingBalance: "0" }, actor,
    );
    const sale = await createSale({ branchId: 1, shiftId, customerId: 1, sourceType: "ORDER", lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }], payment: { amount: "20.00", method: "CASH" },
      }, actor,
    );
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId)))[0];
    const input = { invoiceId: sale.invoiceId, lines: [{ invoiceItemId: Number(item.id), baseQuantity: 1 }], refund: { amount: "10.00", method: "CASH" as const }, reason: "مرتجع بطلب رقابي", clientRequestId: "ret-key-1",
    };
    await caller().returns.create(input);
    await caller().returns.create(input); // نقرة مزدوجة بنفس المفتاح
    const outReceipts = (await db().select().from(s.receipts)).filter((r) => r.direction === "OUT",
    );
    expect(outReceipts).toHaveLength(0); // الطلب لا يخرج مالاً قبل اعتماد مراجع مستقل
    const returnEntries = (await db().select().from(s.accountingEntries)).filter((e) => e.entryType === "RETURN");
    expect(returnEntries).toHaveLength(0);
    expect(await db().select().from(s.salesControlRequests)).toHaveLength(1);
  });

  it("sales.pay: نفس clientRequestId ⇒ دفعة واحدة", async () => {
    await setStock(1, 1, 10);
    await db().insert(s.customers).values({ id: 1, name: "عميل", defaultPriceTier: "RETAIL", currentBalance: "0",
    });
    const sale = await createSale({ branchId: 1, customerId: 1, sourceType: "ORDER", lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }],
      }, actor,
    );
    // M5/M8: الدفع النقدي يَستوجب وردية مفتوحة.
    await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, actor,
    );
    const input = { invoiceId: sale.invoiceId, amount: "10.00", method: "CASH" as const, clientRequestId: "pay-key-1",
    };
    await caller().sales.pay(input);
    await caller().sales.pay(input);
    expect(await db().select().from(s.receipts)).toHaveLength(1);
    expect((await db().select().from(s.accountingEntries)).filter((e) => e.entryType === "PAYMENT_IN",
      ),
    ).toHaveLength(1);
  });

  it("sales.pay غير النقدي: محاولة مؤكدة تُستهلك مرة واحدة وreplay يطابق المحاولة نفسها", async () => {
    await setStock(1, 1, 10);
    await db().insert(s.customers).values({
      id: 1,
      name: "عميل",
      defaultPriceTier: "RETAIL",
      currentBalance: "0",
    });
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }],
      },
      actor,
    );
    const deviceId = "SALES-PAY-DEVICE";
    const confirmed = await initiateExternalPaymentAttempt(
      {
        branchId: 1,
        channel: "SALES_COLLECTION",
        method: "TRANSFER",
        amount: "10.00",
        reference: "BANK-PAY-1001",
        requestId: "pay-attempt-1001",
        deviceId,
      },
      { ...actor, role: "admin" },
    );
    await confirmExternalPaymentAttempt(
      {
        attemptId: confirmed.attemptId,
        branchId: 1,
        channel: "SALES_COLLECTION",
        deviceId,
      },
      { ...actor, role: "admin" },
    );
    const input = {
      invoiceId: sale.invoiceId,
      amount: "10.00",
      method: "TRANSFER" as const,
      reference: "BANK-PAY-1001",
      externalPaymentAttemptId: confirmed.attemptId,
      externalPaymentDeviceId: deviceId,
      clientRequestId: "pay-external-key-1",
    };

    await caller().sales.pay(input);
    await caller().sales.pay(input);
    const receipts = await db().select().from(s.receipts);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      paymentMethod: "TRANSFER",
      referenceNumber: "BANK-PAY-1001",
      cashBucket: null,
    });
    const consumed = (
      await db()
        .select()
        .from(s.externalPaymentAttempts)
        .where(eq(s.externalPaymentAttempts.id, confirmed.attemptId))
    )[0];
    expect(Number(consumed.receiptId)).toBe(Number(receipts[0].id));
    expect(Number(consumed.invoiceId)).toBe(sale.invoiceId);
    expect(consumed.consumedAt).not.toBeNull();

    const other = await initiateExternalPaymentAttempt(
      {
        branchId: 1,
        channel: "SALES_COLLECTION",
        method: "TRANSFER",
        amount: "10.00",
        reference: "BANK-PAY-1002",
        requestId: "pay-attempt-1002",
        deviceId,
      },
      { ...actor, role: "admin" },
    );
    await confirmExternalPaymentAttempt(
      {
        attemptId: other.attemptId,
        branchId: 1,
        channel: "SALES_COLLECTION",
        deviceId,
      },
      { ...actor, role: "admin" },
    );
    await expect(
      caller().sales.pay({
        ...input,
        externalPaymentAttemptId: other.attemptId,
        reference: "BANK-PAY-1002",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const unconsumed = (
      await db()
        .select()
        .from(s.externalPaymentAttempts)
        .where(eq(s.externalPaymentAttempts.id, other.attemptId))
    )[0];
    expect(unconsumed.consumedAt).toBeNull();
  });

  it("purchases.receive مغلق وgoodsReceipts.create يعيد نفس الاستلام لنفس clientRequestId", async () => {
    await db().insert(s.suppliers).values({ id: 1, name: "مورد", currentBalance: "0" });
    const po = await createApprovedPurchaseOrder("5.00");
    const poItem = (await db().select().from(s.purchaseOrderItems).where(eq(s.purchaseOrderItems.purchaseOrderId, po.purchaseOrderId)))[0];
    await expect(caller().purchases.receive({
      purchaseOrderId: po.purchaseOrderId,
      lines: [{ purchaseOrderItemId: Number(poItem.id), receivedBaseQuantity: 5 }],
      clientRequestId: "legacy-recv-key-1",
    })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    const [approvedOrder] = await db().select().from(s.purchaseOrders)
      .where(eq(s.purchaseOrders.id, po.purchaseOrderId));
    const input = {
      purchaseOrderId: po.purchaseOrderId,
      purchaseOrderRevisionId: Number(approvedOrder.approvedRevisionId),
      expectedOrderVersion: Number(approvedOrder.version),
      lines: [{ purchaseOrderItemId: Number(poItem.id), acceptedBaseQuantity: 5 }],
      clientRequestId: "recv-key-1",
    };
    const first = await warehouseCaller().goodsReceipts.create(input);
    const replay = await warehouseCaller().goodsReceipts.create(input);
    expect(Number(replay.id)).toBe(first.goodsReceiptId);
    expect(replay.idempotentReplay).toBe(true);
    expect(await db().select().from(s.goodsReceipts)).toHaveLength(1);
    expect(await db().select().from(s.goodsReceiptItems)).toHaveLength(1);
    expect((await db().select().from(s.inventoryMovements)).filter((m) => m.movementType === "IN",
      ),
    ).toHaveLength(1);
    expect((await db().select().from(s.accountingEntries)).filter((e) =>
      e.entryType === "ADJUST" && e.dedupeKey === `GRNI:RECEIPT:${first.goodsReceiptId}`,
      ),
    ).toHaveLength(1);
    const sup = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0];
    expect(sup.currentBalance).toBe("0.00"); // GRNI لا ينشئ AP قبل فاتورة المورد.
  });

  it("vouchers.create: نفس clientRequestId ⇒ سند واحد", async () => {
    await openShift({ branchId: 1, openingBalance: "0" }, actor); // shift-gate-cash: السند النقدي يَستوجب وردية.
    await fundCash("TREASURY", "100.00");
    const input = { voucherType: "PAYMENT" as const, branchId: 1, amount: "30.00", paymentMethod: "CASH" as const, partyType: "OTHER" as const, voucherCategoryId: 10, counterpartyName: "المؤجر", description: "إيجار", clientRequestId: "vch-key-1",
    };
    const r1 = await caller().vouchers.create(input);
    const r2 = await caller().vouchers.create(input);
    expect(r2.receiptId).toBe(r1.receiptId); // نفس السند (replay)
    const [pending] = await db().select().from(s.receipts).where(eq(s.receipts.id, Number(r1.receiptId)));
    expect(pending).toMatchObject({ status: "PENDING", approvalStatus: "PENDING_APPROVAL", cashBucket: null,
    });
    expect((await db().select().from(s.receipts)).filter((r) => r.direction === "OUT",
      ),
    ).toHaveLength(1);
    expect((await db().select().from(s.accountingEntries)).filter((e) => e.entryType === "PAYMENT_OUT",
      ),
    ).toHaveLength(0);
    await approveVoucher(Number(r1.receiptId), { userId: 2, branchId: 1, role: "manager",
    });
    expect((await db().select().from(s.accountingEntries)).filter((e) => e.entryType === "PAYMENT_OUT",
      ),
    ).toHaveLength(1);
  });
});

describe("#2 عربون أمر الشغل يدخل الصندوق/الدفتر ويُحتسَب عند التسليم", () => {
  it("العربون ⇒ receipt(IN)+shiftId+PAYMENT_IN عند الإنشاء، ويُضمّ لمدفوع الفاتورة عند التسليم", async () => {
    await db().insert(s.customers).values({ id: 1, name: "عميل", defaultPriceTier: "RETAIL", currentBalance: "0",
    });
    await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, actor,
    );
    const wo = await createWorkOrder({ branchId: 1, customerId: 1, baseVariantId: 1, title: "لوحة", salePrice: "20.00", deposit: "5.00", paymentMethod: "CASH",
      }, actor,
    );
    // إيصال العربون + قيد PAYMENT_IN موجودان وبشيفت.
    const depRcpt = (await db().select().from(s.receipts)).find((r) => Number(r.workOrderId) === wo.workOrderId && r.direction === "IN",
    );
    expect(depRcpt).toBeTruthy();
    expect(depRcpt!.amount).toBe("5.00");
    expect(depRcpt!.shiftId).toBeTruthy();
    expect((await db().select().from(s.accountingEntries)).filter((e) => e.entryType === "PAYMENT_IN",
      ),
    ).toHaveLength(1);
    // التسليم: دفعة 15 ⇒ مدفوع الفاتورة = 5 (عربون) + 15 = 20، PAID، AR=0.
    await approveCurrentDesign(wo.workOrderId);
    await startWorkOrder(wo.workOrderId, { ...actor, role: "admin" });
    await markWorkOrderReady(wo.workOrderId, { ...actor, role: "admin" });
    await deliverWorkOrder({ workOrderId: wo.workOrderId, payment: { amount: "15.00", method: "CASH" },
      } as any, { ...actor, role: "admin" },
    );
    const inv = (await db().select().from(s.invoices)).find((row) =>
      row.sourceId?.startsWith(`WO-${wo.workOrderId}`),
    )!;
    expect(inv.paidAmount).toBe("20.00");
    expect(inv.status).toBe("PAID");
    const cust = (await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0];
    expect(cust.currentBalance).toBe("0.00"); // لا مطالبة مزدوجة بالعربون
  });
});

describe("#3 تقريب IQD النقدي على الخادم", () => {
  it("بيع نقدي كامل بإجمالي غير مضاعف لـ250 ⇒ يُقرَّب + قيد ADJUST + النقد=المقرّب", async () => {
    await setStock(1, 1, 10);
    await db().insert(s.productPrices).values([{ productUnitId: 1, priceTier: "WHOLESALE", price: "1240.00" }]);
    // M8: البيع النقدي يَستوجب وردية مفتوحة.
    const { shiftId } = await openShift({ branchId: 1, openingBalance: "0" }, actor,
    );
    const sale = await createSale({ branchId: 1, shiftId, sourceType: "POS", priceTier: "WHOLESALE", lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }], payment: { amount: "1250.00", method: "CASH" }, cashRoundIQD: true,
      }, actor,
    );
    expect(sale.total).toBe("1250.00"); // 1240 → 1250 (أقرب 250)
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0];
    expect(inv.total).toBe("1250.00");
    expect(inv.cashRoundingAdjustment).toBe("10.00");
    expect(inv.paidAmount).toBe("1250.00");
    expect(inv.status).toBe("PAID");
    const adj = (await db().select().from(s.accountingEntries)).filter((e) => e.entryType === "ADJUST",
    );
    expect(adj).toHaveLength(1);
    expect(adj[0].amount).toBe("10.00");
    // النقد المستلم (PAYMENT_IN) = الإجمالي المقرّب.
    const pin = (await db().select().from(s.accountingEntries)).filter((e) => e.entryType === "PAYMENT_IN",
    );
    expect(pin[0].amount).toBe("1250.00");
  });
});

describe("#4 سعر مرتجع الشراء مشتق من مصدر المطابقة المحكوم", () => {
  it("لا يقبل سعراً من المستدعي ويعيد بالسعر المثبت في تخصيص المطابقة", async () => {
    await db().insert(s.suppliers).values({ id: 1, name: "مورد", currentBalance: "0.00" });
    const source = await createGovernedPurchaseReturnSource("4.00");
    const requested = await caller().purchaseReturnGovernance.requestReturn({
      supplierInvoiceId: source.supplierInvoiceId,
      matchRunId: source.matchRunId,
      expectedInvoiceVersion: source.supplierInvoiceVersion,
      requestKey: "purchase-return-price-source",
      settlement: "CREDIT",
      paymentMethod: "TRANSFER",
      evidenceType: "RETURN_NOTE",
      evidenceReference: "return-note:hardening2-price-source",
      reason: "إرجاع وحدة معيبة بعد مطابقة أمر الشراء والاستلام والفاتورة",
      lines: [{
        matchAllocationId: source.matchAllocationId,
        baseQuantity: 1,
        unitPrice: "10.00", // تُزال من Zod؛ السعر لا يأتي من المستدعي.
        reason: "وحدة معيبة موثقة بمحضر الفحص",
      }],
    } as any);
    const result = await ownerCaller().purchaseReturnGovernance.decideReturn({
      requestId: Number(requested.requestId),
      decisionKey: `purchase-return-price-decision:${randomUUID()}`,
      action: "APPROVE",
      reviewReason: "راجعت مصدر المطابقة والكمية والدليل واعتمدت المرتجع",
    });

    const [document] = await db().select().from(s.purchaseReturns)
      .where(eq(s.purchaseReturns.id, Number(result.purchaseReturnId)));
    expect(document.totalAmount).toBe("4.00");
    expect(document).toMatchObject({
      origin: "NATIVE",
      supplierInvoiceId: source.supplierInvoiceId,
      matchRunId: source.matchRunId,
      purchaseOrderId: source.purchaseOrderId,
      settlement: "CREDIT",
    });
  });
});

describe("#5 ذرّية فتح الوردية", () => {
  it("فتح وردية ثانية لنفس الموظّف/الفرع ⇒ يُرفض", async () => {
    await openShift({ branchId: 1, openingBalance: "0" }, actor);
    await expect(openShift({ branchId: 1, openingBalance: "0" }, actor),
    ).rejects.toThrow();
  });
  it("بعد الإغلاق يُسمح بفتح وردية جديدة", async () => {
    const sh = await openShift({ branchId: 1, openingBalance: "0" }, actor);
    const { closeShift } = await import("../shiftService");
    await closeShift({ shiftId: sh.shiftId, countedCash: "0" }, { ...actor, role: "admin" },
    );
    await expect(openShift({ branchId: 1, openingBalance: "0" }, actor),
    ).resolves.toBeTruthy();
  });
});

describe("#2ب استرداد العربون عند إلغاء أمر الشغل (لا نقد عالق)", () => {
  it("إلغاء أمر بعربون مقبوض ⇒ receipt(OUT)+PAYMENT_OUT يعكس PAYMENT_IN (صافي الدفتر صفر)", async () => {
    await db().insert(s.customers).values({ id: 1, name: "عميل", defaultPriceTier: "RETAIL", currentBalance: "0",
    });
    const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, actor);
    const wo = await createWorkOrder({ branchId: 1, customerId: 1, baseVariantId: 1, title: "لوحة", salePrice: "20.00", deposit: "5.00", paymentMethod: "CASH",
      }, actor,
    );
    const [current] = await db().select({ version: s.workOrders.version })
      .from(s.workOrders).where(eq(s.workOrders.id, wo.workOrderId));
    const request = await requestWorkOrderControl({
      requestKey: `hardening2-wo-cancel:${randomUUID()}`,
      workOrderId: wo.workOrderId,
      requestType: "CANCEL",
      baseVersion: Number(current.version),
      reason: "إلغاء أمر الاختبار ورد العربون للعميل",
      payload: { refundShiftId: shift.shiftId, materials: null },
    }, { ...actor, role: "admin" });
    await approveWorkOrderControlRequest(
      Number(request.id),
      owner,
      "راجعت سبب الإلغاء ومسار رد العربون",
    );
    const rcpts = await db().select().from(s.receipts);
    const inRcpt = rcpts.filter((r) => Number(r.workOrderId) === wo.workOrderId && r.direction === "IN",
    );
    const outRcpt = rcpts.filter((r) => Number(r.workOrderId) === wo.workOrderId && r.direction === "OUT",
    );
    expect(inRcpt).toHaveLength(1);
    expect(outRcpt).toHaveLength(1);
    expect(outRcpt[0].amount).toBe("5.00");
    expect(outRcpt[0].shiftId).toBeTruthy(); // استرداد نقدي على وردية مفتوحة
    const entries = await db().select().from(s.accountingEntries);
    const pin = entries.filter((e) => e.entryType === "PAYMENT_IN");
    const pout = entries.filter((e) => e.entryType === "PAYMENT_OUT");
    expect(pin).toHaveLength(1);
    expect(pout).toHaveLength(1);
    // صافي النقد في الدفتر = PAYMENT_IN − PAYMENT_OUT = 0.
    expect(money(pin[0].amount).minus(money(pout[0].amount)).toFixed(2)).toBe("0.00",
    );
    const wOrder = (await db().select().from(s.workOrders).where(eq(s.workOrders.id, wo.workOrderId)))[0];
    expect(wOrder.status).toBe("CANCELLED");
  });
});

describe("#2ج حارس وردية لعربون نقدي عند الإنشاء", () => {
  it("عربون نقدي بلا وردية مفتوحة ⇒ يُرفض (CONFLICT)", async () => {
    await db().insert(s.customers).values({ id: 1, name: "عميل", defaultPriceTier: "RETAIL", currentBalance: "0",
    });
    // لا وردية مفتوحة.
    await expect(
      createWorkOrder({ branchId: 1, customerId: 1, baseVariantId: 1, title: "لوحة", salePrice: "20.00", deposit: "5.00", paymentMethod: "CASH",
        }, actor,
      ),
    ).rejects.toThrow();
    // لا أمر شغل أُنشئ (ROLLBACK كامل).
    expect(await db().select().from(s.workOrders)).toHaveLength(0);
  });
  it("بلا عربون ⇒ لا يلزم وردية", async () => {
    await db().insert(s.customers).values({ id: 1, name: "عميل", defaultPriceTier: "RETAIL", currentBalance: "0",
    });
    await expect(
      createWorkOrder({ branchId: 1, customerId: 1, baseVariantId: 1, title: "لوحة", salePrice: "20.00", deposit: "0", paymentMethod: "CASH",
        }, actor,
      ),
    ).resolves.toBeTruthy();
  });
});

describe("#1ب idempotency للمصروف وإنشاء أمر الشغل (النقر المزدوج)", () => {
  it("expenses.create: نفس clientRequestId ⇒ مصروف/صرف واحد", async () => {
    const { shiftId } = await openShift({ branchId: 1, openingBalance: "0" }, actor,
    ); // shift-gate-cash: المصروف النقدي يَستوجب وردية.
    await fundCash("DRAWER", "100.00", shiftId);
    const input = { branchId: 1, category: "RENT" as const, amount: "30.00", paymentMethod: "CASH" as const, shiftId: null, clientRequestId: "exp-key-1",
    };
    await caller().expenses.create(input);
    await caller().expenses.create(input);
    expect(await db().select().from(s.expenses)).toHaveLength(1);
    expect((await db().select().from(s.receipts)).filter((r) => r.direction === "OUT",
      ),
    ).toHaveLength(1);
    expect((await db().select().from(s.accountingEntries)).filter((e) => e.entryType === "PAYMENT_OUT",
      ),
    ).toHaveLength(1);
  });
  it("workOrders.create: نفس clientRequestId ⇒ أمر/عربون واحد", async () => {
    await db().insert(s.customers).values({ id: 1, name: "عميل", phone: "+9647700000001", defaultPriceTier: "RETAIL", currentBalance: "0",
    });
    await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, actor,
    );
    const input = { branchId: 1, customerId: 1, baseVariantId: 1, title: "لوحة", salePrice: "20.00", deposit: "5.00", paymentMethod: "CASH" as const, clientRequestId: "wo-key-1",
    };
    const r1 = await caller().workOrders.create(input as any);
    const r2 = await caller().workOrders.create(input as any);
    expect((r2 as any).workOrderId).toBe((r1 as any).workOrderId); // replay
    expect(await db().select().from(s.workOrders)).toHaveLength(1);
    expect((await db().select().from(s.receipts)).filter((r) => r.direction === "IN",
      ),
    ).toHaveLength(1); // عربون واحد
    expect((await db().select().from(s.accountingEntries)).filter((e) => e.entryType === "PAYMENT_IN",
      ),
    ).toHaveLength(1);
  });
});

describe("#6 تدقيق تطابق ذمم الموردين (AP)", () => {
  it("يكشف انحراف currentBalance عن المُشتقّ من قيود المورد", async () => {
    await db().insert(s.suppliers).values({ id: 1, name: "مورد", currentBalance: "0" });
    const po = await createApprovedPurchaseOrder("5.00");
    const poItem = (await db().select().from(s.purchaseOrderItems).where(eq(s.purchaseOrderItems.purchaseOrderId, po.purchaseOrderId)))[0];
    await receivePurchase({ purchaseOrderId: po.purchaseOrderId, lines: [{ purchaseOrderItemId: Number(poItem.id), receivedBaseQuantity: 10 },
        ],
      }, actor,
    );
    // سليم الآن (AP=50 من القيود = الرصيد) ⇒ لا انحراف.
    expect(await reconcileSupplierBalances()).toHaveLength(0);
    // أفسد الرصيد يدوياً ⇒ يُكتشَف.
    await db().update(s.suppliers).set({ currentBalance: "999.00" }).where(eq(s.suppliers.id, 1));
    const issues = await reconcileSupplierBalances();
    expect(issues).toHaveLength(1);
    expect(issues[0].entity).toBe("supplier");
  });
});
