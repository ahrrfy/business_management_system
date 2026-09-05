import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { truncateTables } from "./__testUtils__";
import { createWorkOrder } from "../workOrder/create";
import { deliverWorkOrder } from "../workOrder/deliver";
import { markWorkOrderReady, startWorkOrder } from "../workOrder/lifecycle";
import {
  approveWorkOrderControlRequest,
  requestWorkOrderControl,
} from "../workOrder/controlRequests";
import {
  getWorkOrderReverseDeliveryPreflight,
  reverseWorkOrderDelivery,
} from "../workOrder/reverseDelivery";
import { approveWorkOrderCancellationRefund } from "../workOrder/cancel";
import {
  decideWorkOrderDesignApproval,
  requestWorkOrderDesignApproval,
} from "../workOrder/designApproval";
import { dispatchToDelivery } from "../delivery/dispatch";
import { money, round2 } from "../money";

const TABLES = [
  "documentEffects",
  "deliveryOutbox", "deliveryEvents", "deliveryLedgerEntries", "deliveryRemittanceLines",
  "deliveryRemittances", "deliveryConsignments", "deliveryParties",
  "workOrderControlRequests", "workOrderDesignApprovals", "workOrderDesignRevisions",
  "taskEvents", "tasks", "workOrderEvents", "idempotencyKeys", "auditLogs", "accountingEntries",
  "receipts", "inventoryMovements", "workOrderMaterials", "workOrderImages", "workOrders",
  "invoiceItems", "invoices", "branchStock", "productPrices", "productUnits", "productVariants",
  "products", "serviceTypes", "shifts", "customers", "branches", "users",
];

function db() {
  const database = getDb();
  if (!database) throw new Error("DATABASE_URL not set");
  return database;
}

const CASHIER = { userId: 2, branchId: 1, role: "cashier" };
const REQUESTER = { userId: 3, branchId: 1, role: "manager" };
const REVIEWER = { userId: 1, branchId: 1, role: "manager" };
const OWNER = { userId: 4, branchId: 0, role: "admin", isOwner: true };

beforeEach(async () => {
  await truncateTables(TABLES);
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "الثاني", code: "B2", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "m", name: "مراجع", email: "m@t.test", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "c", name: "منشئ", email: "c@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "r", name: "طالب", email: "r@t.test", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 4, openId: "o", name: "مالك", email: "o@t.test", role: "admin", loginMethod: "local", branchId: null, isOwner: true },
    { id: 5, openId: "c2", name: "كاشير الثاني", email: "c2@t.test", role: "cashier", loginMethod: "local", branchId: 2 },
    { id: 6, openId: "r2", name: "طالب الثاني", email: "r2@t.test", role: "manager", loginMethod: "local", branchId: 2 },
  ]);
  await d.insert(s.serviceTypes).values({
    name: "موافقة تصميم",
    defaultKind: "SERVICE_REQUEST",
    defaultPriority: "HIGH",
    slaHours: 24,
    blocksExecution: true,
    isActive: true,
  });
  await d.insert(s.customers).values([{ id: 1, name: "عميل", currentBalance: "0.00", creditLimit: null }]);
  await d.insert(s.products).values([{ id: 1, name: "ورق" }]);
  await d.insert(s.productVariants).values([{ id: 1, productId: 1, sku: "P-1", costPrice: "500.00" }]);
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true }]);
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 100 },
    { variantId: 1, branchId: 2, quantity: 100 },
  ]);
  await d.insert(s.shifts).values([
    { id: 1, branchId: 1, userId: 2, shiftType: "RECEPTION", status: "OPEN", openingCash: "500000.00" },
    { id: 20, branchId: 2, userId: 5, shiftType: "RECEPTION", status: "OPEN", openingCash: "500000.00" },
  ] as never);
});

async function deliveredOrder(args: {
  key: string;
  branchId?: number;
  actorId?: number;
  deposit?: string;
  depositMethod?: "CASH" | "CARD";
  atDelivery?: string;
  lineInvoice?: boolean;
  customerId?: number | null;
}) {
  const branchId = args.branchId ?? 1;
  const actorId = args.actorId ?? 2;
  const shiftId = branchId === 1 ? 1 : 20;
  const actor = { userId: actorId, branchId, role: "cashier" };
  const deposit = args.deposit ?? "0";
  const depositMethod = args.depositMethod ?? "CASH";
  const created = await createWorkOrder({
    branchId,
    customerId: args.customerId === undefined ? 1 : args.customerId,
    baseVariantId: args.lineInvoice ? 1 : null,
    title: "تصميم وطباعة",
    quantity: 1,
    salePrice: "30000.00",
    deposit,
    ...(deposit !== "0" ? {
      paymentMethod: depositMethod,
      ...(depositMethod === "CASH"
        ? { shiftId }
        : { paymentReference: `CARD-DEPOSIT-${args.key}` }),
    } : {}),
    materials: [{ variantId: 1, baseQuantity: 4 }],
    clientRequestId: args.key,
  } as never, { ...actor, shiftId } as never);
  const workOrderId = Number((created as { workOrderId: number }).workOrderId);
  const approval = await requestWorkOrderDesignApproval({
    workOrderId,
    requestKey: `${args.key}-design-request-${randomUUID()}`,
    note: "اعتماد التصميم قبل بدء التنفيذ",
  }, actor);
  const designReviewer = branchId === 1
    ? REVIEWER
    : { userId: 6, branchId: 2, role: "manager" as const };
  await decideWorkOrderDesignApproval({
    approvalId: Number(approval.approval.id),
    decisionKey: `${args.key}-design-approve-${randomUUID()}`,
    decision: "APPROVED",
    reason: "وافق العميل على التصميم النهائي",
    evidence: {
      type: "WHATSAPP_MESSAGE",
      reference: `wamid.reverse.${randomUUID()}`,
    },
  }, designReviewer);
  await startWorkOrder(workOrderId, actor);
  await markWorkOrderReady(workOrderId, actor);
  const delivered = await deliverWorkOrder({
    workOrderId,
    payment: args.atDelivery ? { amount: args.atDelivery, method: "CASH" } : null,
    clientRequestId: `${args.key}-deliver`,
  } as never, actor as never);
  const workOrder = (await db().select().from(s.workOrders).where(eq(s.workOrders.id, workOrderId)))[0]!;
  return { workOrderId, invoiceId: delivered.invoiceId, version: Number(workOrder.version), actor };
}

async function requestReverse(args: {
  workOrderId: number;
  requester?: typeof REQUESTER;
  key?: string;
  reopen?: boolean;
  refundShiftId?: number | null;
}) {
  const requester = args.requester ?? REQUESTER;
  const preflight = await getWorkOrderReverseDeliveryPreflight(args.workOrderId, requester);
  if (!preflight.eligible) throw new Error("reverse preflight not eligible");
  const request = await requestWorkOrderControl({
    requestType: "REVERSE_DELIVERY",
    requestKey: args.key ?? `reverse-${args.workOrderId}-${preflight.version}`,
    workOrderId: args.workOrderId,
    baseVersion: preflight.version,
    reason: "رفض العميل التسليم المنفذ",
    payload: {
      expectedVersion: preflight.version,
      reopen: args.reopen === true,
      refundShiftId: args.refundShiftId ?? null,
      refundSources: preflight.refundSources,
    },
  }, requester);
  return { preflight, request };
}

/** Σ لكلّ نوعٍ في نطاق `delivery` على مستند أمر الشغل — يجب أن يكون صفراً لما عُكس كاملاً. */
async function deliveryEffectSums(workOrderId: number): Promise<Record<string, { amount: string; rows: number }>> {
  const rows = await db()
    .select({
      kind: s.documentEffects.effectKind,
      amount: sql<string>`SUM(${s.documentEffects.signedAmount})`,
      rows: sql<number>`COUNT(*)`,
    })
    .from(s.documentEffects)
    .where(and(
      eq(s.documentEffects.documentType, "WORK_ORDER"),
      eq(s.documentEffects.documentId, workOrderId),
      eq(s.documentEffects.scope, "delivery"),
    ))
    .groupBy(s.documentEffects.effectKind);
  const out: Record<string, { amount: string; rows: number }> = {};
  for (const r of rows) out[r.kind] = { amount: money(r.amount ?? 0).toFixed(4), rows: Number(r.rows ?? 0) };
  return out;
}

async function approveReverse(workOrderId: number, reopen = false, reviewer = REVIEWER) {
  const { preflight, request } = await requestReverse({ workOrderId, reopen });
  const approval = await approveWorkOrderControlRequest(Number(request.id), reviewer, "تمت مراجعة الدليل");
  return { preflight, request, approval };
}

describe("حوكمة عكس تسليم أمر الشغل", () => {
  it("طلب REVERSE_DELIVERY صفري الأثر حتى اعتماد مراجع ثان", async () => {
    const order = await deliveredOrder({ key: "zero-effect", deposit: "10000.00" });
    const before = (await db().select().from(s.invoices).where(eq(s.invoices.id, order.invoiceId)))[0]!;
    const { request } = await requestReverse({ workOrderId: order.workOrderId });
    const after = (await db().select().from(s.invoices).where(eq(s.invoices.id, order.invoiceId)))[0]!;
    expect(request.status).toBe("PENDING");
    expect(after.status).toBe(before.status);
    expect(after.paidAmount).toBe(before.paidAmount);
    expect(await db().select().from(s.receipts).where(eq(s.receipts.direction, "OUT"))).toHaveLength(0);
  });

  it("فاتورة صفرية البنود والمدفوع صفر تُعكسان من المسار الموحد", async () => {
    const order = await deliveredOrder({ key: "zero-lines" });
    expect(await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, order.invoiceId))).toHaveLength(0);
    await approveReverse(order.workOrderId);
    const invoice = (await db().select().from(s.invoices).where(eq(s.invoices.id, order.invoiceId)))[0]!;
    expect(invoice.status).toBe("RETURNED");
    expect(invoice.paidAmount).toBe("0.00");
    expect(invoice.returnedTotal).toBe("30000.00");
  });

  it("فاتورة ذات بند لا تُفوّض للمرتجع العام وتُختم بنودها مرتجعة بلا restock", async () => {
    const order = await deliveredOrder({ key: "line", lineInvoice: true });
    await approveReverse(order.workOrderId);
    const items = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, order.invoiceId));
    expect(items).toHaveLength(1);
    expect(items[0]!.returnedBaseQuantity).toBe(items[0]!.baseQuantity);
    expect(items[0]!.returnedRestockedBaseQuantity).toBe(0);
    const returns = await db().select().from(s.accountingEntries).where(and(
      eq(s.accountingEntries.invoiceId, order.invoiceId),
      eq(s.accountingEntries.entryType, "RETURN"),
    ));
    expect(returns).toHaveLength(1);
    expect(returns[0]!.dedupeKey).toBe(`WO-REVERSE:${order.workOrderId}:${order.invoiceId}`);
  });

  it("reopen يعيد WIP ويمكّن تسليماً ثانياً فعلياً بهوية مصدر revision جديدة", async () => {
    const order = await deliveredOrder({ key: "redeliver" });
    const firstSource = (await db().select().from(s.invoices).where(eq(s.invoices.id, order.invoiceId)))[0]!.sourceId;
    await approveReverse(order.workOrderId, true);
    const reopened = (await db().select().from(s.workOrders).where(eq(s.workOrders.id, order.workOrderId)))[0]!;
    expect(reopened).toMatchObject({ status: "READY", invoiceId: null, cancelReason: null, cancelledAt: null });
    const second = await deliverWorkOrder({ workOrderId: order.workOrderId, payment: null, clientRequestId: "redeliver-2" }, CASHIER as never);
    expect(second.invoiceId).not.toBe(order.invoiceId);
    const secondSource = (await db().select().from(s.invoices).where(eq(s.invoices.id, second.invoiceId)))[0]!.sourceId;
    expect(secondSource).not.toBe(firstSource);
    const current = (await db().select().from(s.workOrders).where(eq(s.workOrders.id, order.workOrderId)))[0]!;
    expect(current.status).toBe("DELIVERED");
  });

  it("إقفال CANCEL يفرغ WIP إلى خسارة ولا يعيد المخزون", async () => {
    const order = await deliveredOrder({ key: "waste" });
    const stockBefore = Number((await db().select().from(s.branchStock).where(and(eq(s.branchStock.branchId, 1), eq(s.branchStock.variantId, 1))))[0]!.quantity);
    await approveReverse(order.workOrderId, false);
    const waste = await db().select().from(s.accountingEntries)
      .where(eq(s.accountingEntries.dedupeKey, `WO-REVERSE-WASTE:${order.workOrderId}:${order.invoiceId}`));
    expect(waste).toHaveLength(1);
    const stockAfter = Number((await db().select().from(s.branchStock).where(and(eq(s.branchStock.branchId, 1), eq(s.branchStock.variantId, 1))))[0]!.quantity);
    expect(stockAfter).toBe(stockBefore);
  });

  it("prior partial OUT يخفض خطة الرد ولا يكرر الصرف وpaidAmount ينتهي صفراً", async () => {
    const order = await deliveredOrder({ key: "partial-out", deposit: "10000.00" });
    const before = await getWorkOrderReverseDeliveryPreflight(order.workOrderId, REQUESTER);
    if (!before.eligible) throw new Error("not eligible");
    const sourceId = before.refundSources[0]!.sourceReceiptId;
    await db().insert(s.receipts).values({
      branchId: 1, shiftId: 1, workOrderId: order.workOrderId, invoiceId: order.invoiceId,
      direction: "OUT", amount: "4000.00", paymentMethod: "CASH", cashBucket: "DRAWER",
      status: "COMPLETED", approvalStatus: "APPROVED", referenceNumber: "PRIOR-PARTIAL",
      internalNote: `WORK_ORDER_CUSTOMER_REFUND:REVERSE_LIABILITY:${order.workOrderId}:${sourceId}:legacy`,
      createdBy: 1,
    });
    const preflight = await getWorkOrderReverseDeliveryPreflight(order.workOrderId, REQUESTER);
    if (!preflight.eligible) throw new Error("not eligible");
    expect(preflight.netPaid).toBe("6000.00");
    expect(preflight.priorCompletedOut).toBe("4000.00");
    expect(preflight.refundSources.reduce((sum, plan) => sum.plus(money(plan.amount)), money(0)).toFixed(2)).toBe("6000.00");
    await approveReverse(order.workOrderId);
    const invoice = (await db().select().from(s.invoices).where(eq(s.invoices.id, order.invoiceId)))[0]!;
    expect(invoice.paidAmount).toBe("0.00");
    expect((await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0]!.currentBalance).toBe("0.00");
    const out = await db().select().from(s.receipts).where(and(eq(s.receipts.invoiceId, order.invoiceId), eq(s.receipts.direction, "OUT"), eq(s.receipts.status, "COMPLETED")));
    expect(round2(out.reduce((sum, row) => sum.plus(money(row.amount)), money(0))).toFixed(2)).toBe("10000.00");
    // ⭐ ق٧: العكسُ مرّ بمحرّك العكس منفِّذاً — سجلُّ الأثر متوازنٌ نوعاً نوعاً (المصدرُ ذو الردّ
    // السابق صُولح بابنِ فرقٍ ثمّ عُكس متبقّيه)، وصفُّ REVERSE للردّ يشير إلى إيصال صرفٍ حقيقيّ.
    const sums = await deliveryEffectSums(order.workOrderId);
    expect(sums.LEDGER_ENTRY!.amount).toBe("0.0000");
    expect(sums.PAID_AMOUNT!.amount).toBe("0.0000");
    expect(sums.PAID_AMOUNT!.rows).toBeGreaterThanOrEqual(2);
    expect(sums.CUSTOMER_BALANCE!.amount).toBe("0.0000");
    const refundReverse = (await db().select().from(s.documentEffects).where(and(
      eq(s.documentEffects.documentType, "WORK_ORDER"), eq(s.documentEffects.documentId, order.workOrderId),
      eq(s.documentEffects.effectKind, "PAID_AMOUNT"), eq(s.documentEffects.phase, "REVERSE"),
      sql`JSON_EXTRACT(${s.documentEffects.payloadJson}, '$.reconciled') IS NULL`,
    )))[0]!;
    expect(refundReverse.effectTable).toBe("receipts");
    expect(out.map((r) => Number(r.id))).toContain(Number(refundReverse.effectRowId));
  });

  it("وردّيتان نقديتان تفرضان اختيار درج صريح", async () => {
    const order = await deliveredOrder({ key: "two-shifts", deposit: "10000.00" });
    await db().insert(s.shifts).values({ id: 2, branchId: 1, userId: 3, shiftType: "RECEPTION", status: "OPEN", openingCash: "500000.00" } as never);
    await expect(requestReverse({ workOrderId: order.workOrderId, refundShiftId: null })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const { request } = await requestReverse({ workOrderId: order.workOrderId, refundShiftId: 1, key: "two-shifts-selected" });
    await approveWorkOrderControlRequest(Number(request.id), REVIEWER);
    const out = (await db().select().from(s.receipts).where(eq(s.receipts.direction, "OUT")))[0]!;
    expect(Number(out.shiftId)).toBe(1);
  });

  it.each([false, true])("رد غير نقدي يبقى معلقاً في %s ثم يخفض paidAmount عند اعتماد مالك آخر", async (reopen) => {
    const order = await deliveredOrder({
      key: `noncash-${reopen}`,
      deposit: "10000.00",
      depositMethod: "CARD",
    });
    await approveReverse(order.workOrderId, reopen);
    let invoice = (await db().select().from(s.invoices).where(eq(s.invoices.id, order.invoiceId)))[0]!;
    expect(invoice.paidAmount).toBe("10000.00");
    // ق٧: المالُ لم يخرج ⇒ أثرُ المقبوض يبقى مفتوحاً **بإعلان** (APPLY بلا REVERSE) لا Σ=0 كاذباً.
    const sumsPending = await deliveryEffectSums(order.workOrderId);
    expect(sumsPending.PAID_AMOUNT!.amount).toBe("10000.0000");
    expect(sumsPending.PAID_AMOUNT!.rows).toBe(1);
    expect(sumsPending.LEDGER_ENTRY!.amount).toBe("0.0000");
    const pending = (await db().select().from(s.receipts).where(and(eq(s.receipts.direction, "OUT"), eq(s.receipts.status, "PENDING"))))[0]!;
    await approveWorkOrderCancellationRefund(Number(pending.id), OWNER, `CARD-${reopen}`, {
      user: { id: OWNER.userId, branchId: null } as never,
      req: undefined as never,
    });
    invoice = (await db().select().from(s.invoices).where(eq(s.invoices.id, order.invoiceId)))[0]!;
    expect(invoice.paidAmount).toBe("0.00");
    const wo = (await db().select().from(s.workOrders).where(eq(s.workOrders.id, order.workOrderId)))[0]!;
    expect(wo.status).toBe(reopen ? "READY" : "CANCELLED");
  });

  // قرار المالك (٣/٩/٢٦): لا اعتماد ثانٍ بعد المالك — المالك يُصدر طلب عكس التسليم بنفسه (بصفته
  // المُراجع الثاني لعكس التسليم) ثمّ يعتمد سند ردّ العربون الناتج بنفسه أيضاً.
  it("المالك مراجعٌ لعكس التسليم ومعتمِدٌ لردّ العربون معاً ⇒ ينفَّذ (لا اعتماد ثانٍ بعد المالك)", async () => {
    const order = await deliveredOrder({ key: "owner-self-approve", deposit: "10000.00", depositMethod: "CARD" });
    await approveReverse(order.workOrderId, false, OWNER);
    const pending = (await db().select().from(s.receipts).where(and(eq(s.receipts.direction, "OUT"), eq(s.receipts.status, "PENDING"))))[0]!;
    expect(pending.createdBy).toBe(OWNER.userId);
    const approved = await approveWorkOrderCancellationRefund(Number(pending.id), OWNER, "CARD-SELF", {
      user: { id: OWNER.userId, branchId: null } as never,
      req: undefined as never,
    });
    expect(approved.status).toBe("COMPLETED");
    const invoice = (await db().select().from(s.invoices).where(eq(s.invoices.id, order.invoiceId)))[0]!;
    expect(invoice.paidAmount).toBe("0.00");
  });

  it("زبون عابر مدفوع نقداً له مسار رد كامل بلا ذمة وهمية", async () => {
    const order = await deliveredOrder({ key: "walk-in", atDelivery: "30000.00", customerId: null });
    await approveReverse(order.workOrderId);
    const out = await db().select().from(s.receipts).where(and(eq(s.receipts.invoiceId, order.invoiceId), eq(s.receipts.direction, "OUT")));
    expect(round2(out.reduce((sum, row) => sum.plus(money(row.amount)), money(0))).toFixed(2)).toBe("30000.00");
    expect(out.every((row) => row.partyId == null && row.status === "COMPLETED")).toBe(true);
  });

  it("إرسالية DELIVERED+SETTLED بتوريد تجميعي تُغلق وترد النقد المخصص، والحالات الحية تُرفض", async () => {
    const settled = await deliveredOrder({ key: "settled" });
    await db().insert(s.deliveryParties).values({ id: 1, name: "شركة", partyType: "COMPANY", branchId: 1 });
    await db().insert(s.receipts).values({
      id: 100, branchId: 1, shiftId: 1, direction: "IN", amount: "30000.00",
      paymentMethod: "CASH", cashBucket: "DRAWER", status: "COMPLETED",
      approvalStatus: "APPROVED", referenceNumber: "DR-AGGREGATE", createdBy: 1,
    });
    await db().insert(s.deliveryRemittances).values({
      id: 10, remittanceNumber: "DR-SETTLED", branchId: 1, partyId: 1, shiftId: 1,
      collectedTotal: "30000.00", netRemitted: "30000.00", status: "BALANCED",
      receiptInId: 100, receivedBy: 1,
    });
    await db().insert(s.deliveryConsignments).values({
      id: 1, consignmentNumber: "CN-SETTLED", branchId: 1, partyId: 1,
      invoiceId: settled.invoiceId, workOrderId: settled.workOrderId,
      sourceType: "WORK_ORDER", sourceId: settled.workOrderId,
      codAmount: "30000.00", collectedAmount: "30000.00", deliveryFee: "0.00",
      remittanceId: 10,
      parcelStatus: "DELIVERED", moneyStatus: "SETTLED", status: "DELIVERED",
    } as never);
    await db().insert(s.deliveryRemittanceLines).values({
      remittanceId: 10, consignmentId: 1, grossApplied: "30000.00", cashReceived: "30000.00",
    });
    await db().update(s.invoices).set({ paidAmount: "30000.00", status: "PAID" }).where(eq(s.invoices.id, settled.invoiceId));
    await db().update(s.customers).set({ currentBalance: "0.00" }).where(eq(s.customers.id, 1));
    const settledPreflight = await getWorkOrderReverseDeliveryPreflight(settled.workOrderId, REQUESTER);
    expect(settledPreflight.eligible && settledPreflight.netPaid).toBe("30000.00");
    await approveReverse(settled.workOrderId, true);
    expect((await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, 1)))[0]).toMatchObject({
      status: "RETURNED", parcelStatus: "RETURNED", moneyStatus: "CANCELLED",
    });
    await db().update(s.workOrders).set({ hasDelivery: true }).where(eq(s.workOrders.id, settled.workOrderId));
    const redispatched = await dispatchToDelivery({
      workOrderId: settled.workOrderId,
      partyId: 1,
      clientRequestId: "settled-redispatch",
    }, CASHIER as never);
    expect(redispatched.consignmentId).not.toBe(1);
    const historical = (await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, 1)))[0]!;
    const current = (await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, redispatched.consignmentId)))[0]!;
    expect(Number(historical.invoiceId)).toBe(settled.invoiceId);
    expect(Number(current.invoiceId)).toBe(redispatched.invoiceId);
    expect(Number(current.sourceId)).toBeLessThan(0);

    const live = await deliveredOrder({ key: "live" });
    const liveConsignmentId = extractInsertId(await db().insert(s.deliveryConsignments).values({
      consignmentNumber: "CN-LIVE", branchId: 1, partyId: 1,
      invoiceId: live.invoiceId, workOrderId: live.workOrderId,
      sourceType: "WORK_ORDER", sourceId: live.workOrderId,
      codAmount: "0.00", collectedAmount: "0.00", deliveryFee: "0.00",
      parcelStatus: "OUT_FOR_DELIVERY", moneyStatus: "UNSETTLED", status: "DISPATCHED",
    } as never));
    expect(liveConsignmentId).not.toBe(redispatched.consignmentId);
    const { request } = await requestReverse({ workOrderId: live.workOrderId });
    await expect(approveWorkOrderControlRequest(Number(request.id), REVIEWER)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("EXCHANGE يظهر كمانع صريح ولا يعيد preflight حمولة لا يقبلها الراوتر", async () => {
    const order = await deliveredOrder({ key: "exchange-source" });
    await db().insert(s.receipts).values({
      branchId: 1, workOrderId: order.workOrderId, invoiceId: order.invoiceId,
      direction: "IN", amount: "1000.00", paymentMethod: "EXCHANGE", cashBucket: null,
      status: "COMPLETED", approvalStatus: "APPROVED", referenceNumber: "FX-SOURCE", createdBy: 1,
    });
    const preflight = await getWorkOrderReverseDeliveryPreflight(order.workOrderId, REQUESTER);
    expect(preflight.eligible).toBe(false);
    if (preflight.eligible) throw new Error("exchange source must not be eligible");
    expect(preflight.ineligibleReason).toMatch(/EXCHANGE/);
    expect(preflight.refundSources).toHaveLength(0);
  });

  it("SOD يمنع requester والمنشئ/المسند حتى admin، والموافقة المتزامنة لا تطبق مرتين", async () => {
    const order = await deliveredOrder({ key: "sod" });
    const { request } = await requestReverse({ workOrderId: order.workOrderId });
    await expect(approveWorkOrderControlRequest(Number(request.id), REQUESTER)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(approveWorkOrderControlRequest(Number(request.id), { ...CASHIER, role: "admin" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const results = await Promise.all([
      approveWorkOrderControlRequest(Number(request.id), REVIEWER),
      approveWorkOrderControlRequest(Number(request.id), REVIEWER),
    ]);
    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(await db().select().from(s.workOrderEvents).where(and(
      eq(s.workOrderEvents.workOrderId, order.workOrderId),
      eq(s.workOrderEvents.eventType, "CONTROL_APPROVED"),
    ))).toHaveLength(1);
    expect(await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.dedupeKey, `WO-REVERSE:${order.workOrderId}:${order.invoiceId}`))).toHaveLength(1);
  });

  it("reverseWorkOrderDelivery المباشر (بلا المرور بـ approveWorkOrderControlRequest) يرفض منشئ الأمر ويكمل فعلياً لمراجع غير مرتبط", async () => {
    const control = { approvedControlRequestId: 999999 };

    // (1) استدعاء مباشر — الحارس الوحيد الذي يمكن أن يرفض هنا هو reverseDelivery.ts:594-596،
    // لأن controlRequests.ts لم يُستدعَ إطلاقاً في هذا المسار.
    const blocked = await deliveredOrder({ key: "reverse-direct-sod-blocked", deposit: "10000.00" });
    const blockedPreflight = await getWorkOrderReverseDeliveryPreflight(blocked.workOrderId, REQUESTER);
    if (!blockedPreflight.eligible) throw new Error("not eligible");
    await expect(reverseWorkOrderDelivery({
      workOrderId: blocked.workOrderId,
      expectedVersion: blockedPreflight.version,
      reason: "اختبار مباشر لحارس SOD في reverseWorkOrderDeliveryInTx",
      reopen: false,
      refundShiftId: null,
      refundSources: blockedPreflight.refundSources,
      clientRequestId: "reverse-direct-sod-blocked-1",
    }, CASHIER, control)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const untouchedInvoice = (await db().select().from(s.invoices).where(eq(s.invoices.id, blocked.invoiceId)))[0]!;
    expect(untouchedInvoice.status).not.toBe("RETURNED");
    expect(await db().select().from(s.receipts).where(eq(s.receipts.direction, "OUT"))).toHaveLength(0);

    // (2) نفس الاستدعاء المباشر بفاعل غير مرتبط — يجب أن يكتمل العكس فعلياً
    const allowed = await deliveredOrder({ key: "reverse-direct-sod-allowed", deposit: "10000.00" });
    const allowedPreflight = await getWorkOrderReverseDeliveryPreflight(allowed.workOrderId, REQUESTER);
    if (!allowedPreflight.eligible) throw new Error("not eligible");
    const result = await reverseWorkOrderDelivery({
      workOrderId: allowed.workOrderId,
      expectedVersion: allowedPreflight.version,
      reason: "اختبار مباشر لاكتمال عكس التسليم بمعزل عن اعتماد طلب التحكم",
      reopen: false,
      refundShiftId: null,
      refundSources: allowedPreflight.refundSources,
      clientRequestId: "reverse-direct-sod-allowed-1",
    }, REVIEWER, control);
    expect(result.status).toBe("CANCELLED");
    const returnedInvoice = (await db().select().from(s.invoices).where(eq(s.invoices.id, allowed.invoiceId)))[0]!;
    expect(returnedInvoice.status).toBe("RETURNED");
    const refundOut = await db().select().from(s.receipts).where(and(
      eq(s.receipts.invoiceId, allowed.invoiceId), eq(s.receipts.direction, "OUT"), eq(s.receipts.status, "COMPLETED"),
    ));
    expect(round2(refundOut.reduce((sum, row) => sum.plus(money(row.amount)), money(0))).toFixed(2)).toBe("10000.00");
  });

  it("مفتاح طلب واحد يرفض payload مختلفاً، وفرع admin يُنسب إلى فرع الأمر الحقيقي", async () => {
    const order = await deliveredOrder({ key: "branch2", branchId: 2, actorId: 5 });
    const requester = { userId: 6, branchId: 2, role: "manager" } as const;
    const first = await requestReverse({ workOrderId: order.workOrderId, requester, key: "same-key" });
    await expect(requestWorkOrderControl({
      requestType: "REVERSE_DELIVERY",
      requestKey: "same-key",
      workOrderId: order.workOrderId,
      baseVersion: first.preflight.version,
      reason: "سبب مختلف لنفس المفتاح",
      payload: {
        expectedVersion: first.preflight.version,
        reopen: true,
        refundShiftId: null,
        refundSources: first.preflight.refundSources,
      },
    }, requester)).rejects.toMatchObject({ code: "CONFLICT" });
    await approveWorkOrderControlRequest(Number(first.request.id), OWNER);
    const audit = (await db().select().from(s.auditLogs).where(eq(s.auditLogs.action, "workOrder.reverseDelivery")))[0]!;
    expect(Number(audit.branchId)).toBe(2);
  });

  it("طلبان متزامنان بالمفتاح نفسه ينشئان صفاً وأثر طلب واحداً ثم يعيدان replay", async () => {
    const order = await deliveredOrder({ key: "request-race" });
    const preflight = await getWorkOrderReverseDeliveryPreflight(order.workOrderId, REQUESTER);
    if (!preflight.eligible) throw new Error("not eligible");
    const input = {
      requestType: "REVERSE_DELIVERY" as const,
      requestKey: "reverse-request-race-same-key",
      workOrderId: order.workOrderId,
      baseVersion: preflight.version,
      reason: "عكس موثق لاختبار سباق إنشاء طلب التحكم",
      payload: {
        expectedVersion: preflight.version,
        reopen: true,
        refundShiftId: null,
        refundSources: preflight.refundSources,
      },
    };

    const results = await Promise.all([
      requestWorkOrderControl(input, REQUESTER),
      requestWorkOrderControl(input, REQUESTER),
    ]);
    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(new Set(results.map((result) => Number(result.id))).size).toBe(1);
    expect(await db().select().from(s.workOrderControlRequests).where(
      eq(s.workOrderControlRequests.requestKey, input.requestKey),
    )).toHaveLength(1);
    expect(await db().select().from(s.workOrderEvents).where(and(
      eq(s.workOrderEvents.workOrderId, order.workOrderId),
      eq(s.workOrderEvents.eventType, "CONTROL_REQUESTED"),
    ))).toHaveLength(1);
  });
});
