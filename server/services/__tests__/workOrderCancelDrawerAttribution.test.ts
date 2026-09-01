/**
 * إلغاء أمر شغل — إسناد استرداد العربون للدرج الفعليّ لا وردية الفاعل (بلاغ مالك ٢/٨/٢٦، متابعة
 * تدقيق shiftIdForCashTx — مرآة إصلاح returnService.ts وdelivery/returns.ts).
 *
 * المشكلة: `workOrders.cancel` صلاحية مدير (workordersManagerProcedure — «الإلغاء يعكس مخزوناً/قيوداً»)
 * — مُنفِّذ الإلغاء غالباً شخصٌ مختلف عن الكاشير الذي يُشغّل درج الاستقبال الذي قبض العربون فعلاً. كان
 * الكود القديم يستخدم openShiftIdTx(actor.userId) فقط: يرفض الإلغاء كاملاً إن لم يكن للمدير وردية
 * استقبال خاصّة، أو (لو كانت له) ينسب الاسترداد إليها فيختفي عن Z-report صاحب الدرج الحقيقيّ.
 */
import { randomUUID } from "node:crypto";
import { and, eq, like, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { createWorkOrder } from "../workOrder/create";
import {
  approveWorkOrderControlRequest,
  requestWorkOrderControl,
} from "../workOrder/controlRequests";
import { closeShift, openShift } from "../shiftService";
import { workOrderRouter } from "../../routers/workOrderRouter";

const manager = { userId: 1, branchId: 1, role: "manager" };
const cashier = { userId: 2, branchId: 1 };

function workOrderCaller(user: { id: number; role: string; isOwner: boolean }, branchId = 1) {
  return workOrderRouter.createCaller({
    req: { headers: {} },
    res: {},
    sessionId: null,
    platformAdmin: null,
    user: {
      ...user,
      branchId,
      permissionsOverride: null,
      totpEnabledAt: new Date(),
    },
  } as never);
}

const TABLES = [
  "idempotencyKeys",
  "auditLogs",
  "workOrderControlRequests", "workOrderEvents",
  "accountingEntries", "receipts", "inventoryMovements", "invoiceItems", "invoices",
  "orderPayments", "receptionDrafts", "workOrderMaterials", "workOrderImages", "workOrders",
  "branchStock", "productPrices", "productUnits", "productVariants", "products",
  "shifts", "customers", "branches", "users",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values([
    { id: 1, openId: "mgr", name: "مديرة الفرع", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "reception1", name: "موظف استقبال", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "owner", name: "مالك معتمد", role: "admin", loginMethod: "local", branchId: 1, isOwner: true },
    { id: 4, openId: "refund_owner", name: "مالك اعتماد الرد", role: "admin", loginMethod: "local", branchId: 1, isOwner: true },
  ]);
  await d.insert(s.customers).values({ id: 1, name: "عميل", defaultPriceTier: "RETAIL", currentBalance: "0" });
}

async function openShiftFor(userId: number, shiftType: "RETAIL" | "RECEPTION" | "PRINT_SERVICES", branchId = 1) {
  return openShift({ branchId, openingBalance: "0", shiftType }, { userId, branchId });
}

/** أمر شغل بعربون نقديّ ٢٠٠٠، يُنشئه الكاشير (موظّف الاستقبال). */
async function createWorkOrderWithDeposit() {
  const wo = await createWorkOrder(
    { branchId: 1, customerId: 1, baseVariantId: null, title: "بطاقات تعريفية", salePrice: "5000", deposit: "2000", paymentMethod: "CASH" },
    cashier,
  );
  return (wo as { workOrderId: number }).workOrderId;
}

async function createLegacyCardWorkOrder(suffix: string) {
  const workOrderId = extractInsertId(await db().insert(s.workOrders).values({
    orderNumber: `WO-LEGACY-CARD-${suffix}`,
    branchId: 1,
    customerId: 1,
    title: `أمر قديم ببطاقة ${suffix}`,
    quantity: 1,
    materialsCost: "0.00",
    laborCost: "0.00",
    salePrice: "5000.00",
    status: "RECEIVED",
    deposit: "2000.00",
    paymentMethod: "CARD",
    paymentReference: `CARD-OLD-${suffix}`,
    depositReceiptId: null,
    createdBy: 2,
  }));
  const depositReceiptId = extractInsertId(await db().insert(s.receipts).values({
    branchId: 1,
    workOrderId,
    direction: "IN",
    amount: "2000.00",
    paymentMethod: "CARD",
    cashBucket: null,
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    createdBy: 2,
  }));
  return { workOrderId, depositReceiptId };
}

/**
 * أمرٌ **عابرٌ بلا عميلٍ مسجَّل** (`deposit = 0`) يحمل حصّةَ قبضٍ **غير نقديّة** (تحويل) مطبَّقةً
 * من مسوّدة استقبال. يُثبت أنّ إلغاءه لم يعد يَعلَق: كان الحارسُ يرفض ردّ الحصّة غير النقديّة
 * بلا عميلٍ فيُرجِع المعاملةَ كلَّها ⇒ مالٌ محتجَزٌ بلا مخرج (مراجعة Codex P2 على #930).
 */
async function createAnonymousTransferAppliedWorkOrder(suffix: string) {
  const workOrderId = extractInsertId(await db().insert(s.workOrders).values({
    orderNumber: `WO-ANON-TRANSFER-${suffix}`,
    branchId: 1,
    customerId: null,
    title: `أمر عابر بتحويل ${suffix}`,
    quantity: 1,
    materialsCost: "0.00",
    laborCost: "0.00",
    salePrice: "5000.00",
    status: "RECEIVED",
    deposit: "0.00",
    paymentMethod: "TRANSFER",
    depositReceiptId: null,
    createdBy: 2,
  }));
  const draftId = extractInsertId(await db().insert(s.receptionDrafts).values({
    draftNumber: `D-ANON-${suffix}`,
    branchId: 1,
    commitRequestId: randomUUID(),
    createdBy: 2,
  }));
  const collectionReceiptId = extractInsertId(await db().insert(s.receipts).values({
    branchId: 1,
    direction: "IN",
    amount: "3000.00",
    paymentMethod: "TRANSFER",
    cashBucket: null,
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    partyType: "OTHER",
    createdBy: 2,
  }));
  const collectionId = extractInsertId(await db().insert(s.orderPayments).values({
    draftId,
    branchId: 1,
    kind: "COLLECTION",
    amount: "3000.00",
    method: "TRANSFER",
    receiptId: collectionReceiptId,
    customerId: null,
    status: "APPLIED",
    createdBy: 2,
  }));
  await db().insert(s.orderPayments).values({
    draftId,
    branchId: 1,
    kind: "APPLICATION",
    amount: "3000.00",
    method: "TRANSFER",
    parentPaymentId: collectionId,
    appliedKind: "WORKORDER",
    appliedId: workOrderId,
    createdBy: 2,
  });
  return workOrderId;
}

async function cancelGoverned(
  workOrderId: number,
  opts: { refundShiftId?: number | null; requestKey?: string; baseVersion?: number } = {},
) {
  const [workOrder] = await db().select({ version: s.workOrders.version })
    .from(s.workOrders).where(eq(s.workOrders.id, workOrderId));
  const baseVersion = opts.baseVersion ?? Number(workOrder.version);
  const request = await requestWorkOrderControl({
    requestKey: opts.requestKey ?? `cancel-drawer:${randomUUID()}`,
    workOrderId,
    requestType: "CANCEL",
    baseVersion,
    reason: "إلغاء أمر الاختبار ورد العربون للعميل",
    payload: { refundShiftId: opts.refundShiftId ?? null, materials: null },
  }, manager);
  return approveWorkOrderControlRequest(
    Number(request.id),
    { userId: 3, branchId: 1, role: "admin", isOwner: true },
    "راجعت سبب الإلغاء ومسار رد العربون",
  );
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("cancelWorkOrder — إسناد استرداد العربون لدرج الفرع الفعليّ (لا وردية الفاعل)", () => {
  it("المديرة بلا وردية + وردية الاستقبال (الكاشير) هي الوحيدة المفتوحة ⇒ الاسترداد يُنسَب لها تلقائياً", async () => {
    const shift = await openShiftFor(2, "RECEPTION");
    const workOrderId = await createWorkOrderWithDeposit();

    // قبل الإصلاح: openShiftIdTx(actor=المديرة بلا وردية استقبال) ⇒ null ⇒ CONFLICT.
    await cancelGoverned(workOrderId);

    const refund = (
      await db()
        .select({ shiftId: s.receipts.shiftId, cashBucket: s.receipts.cashBucket, amount: s.receipts.amount })
        .from(s.receipts)
        .where(and(eq(s.receipts.workOrderId, workOrderId), eq(s.receipts.direction, "OUT")))
    )[0];
    expect(refund?.shiftId).toBe(shift.shiftId); // انتسب لدرج الاستقبال الحقيقيّ — لا رفض، لا وردية شبحيّة.
    expect(refund?.cashBucket).toBe("DRAWER");
    expect(refund?.amount).toBe("2000.00");
  });

  it("وردية RETAIL لا تزاحم درج RECEPTION الوحيد في قبض العربون أو ردّه", async () => {
    const receptionShift = await openShiftFor(2, "RECEPTION");
    const retailShift = await openShiftFor(1, "RETAIL");
    const workOrderId = await createWorkOrderWithDeposit();

    const [before] = await db().select({ version: s.workOrders.version })
      .from(s.workOrders).where(eq(s.workOrders.id, workOrderId));
    const baseVersion = Number(before.version);
    const first = await cancelGoverned(workOrderId, {
      requestKey: "wo-cancel-cash-1",
      baseVersion,
    });
    expect(first.replayed).toBe(false);
    await expect(cancelGoverned(workOrderId, {
      requestKey: "wo-cancel-cash-1",
      baseVersion,
    })).resolves.toMatchObject({ replayed: true });
    await expect(cancelGoverned(workOrderId, {
      requestKey: "wo-cancel-cash-1",
      baseVersion,
      refundShiftId: 999,
    })).rejects.toMatchObject({ code: "CONFLICT" });
    const refund = (await db().select({ shiftId: s.receipts.shiftId }).from(s.receipts)
      .where(and(eq(s.receipts.workOrderId, workOrderId), eq(s.receipts.direction, "OUT"))))[0];
    expect(refund?.shiftId).toBe(receptionShift.shiftId);
    expect(refund?.shiftId).not.toBe(retailShift.shiftId);
  });

  it("تعدّد الدرج + refundShiftId صريح لوردية الاستقبال ⇒ ينجح وينتسب لها لا لوردية المديرة", async () => {
    const receptionShift = await openShiftFor(2, "RECEPTION");
    const mgrShift = await openShiftFor(1, "RETAIL");
    const workOrderId = await createWorkOrderWithDeposit();

    await cancelGoverned(workOrderId, { refundShiftId: receptionShift.shiftId });

    const refund = (
      await db()
        .select({ shiftId: s.receipts.shiftId })
        .from(s.receipts)
        .where(and(eq(s.receipts.workOrderId, workOrderId), eq(s.receipts.direction, "OUT")))
    )[0];
    expect(refund?.shiftId).toBe(receptionShift.shiftId);
    expect(refund?.shiftId).not.toBe(mgrShift.shiftId);
  });

  it("الدرج استُنزف بمصروفٍ سابق في نفس الوردية ⇒ استرداد يتجاوز المتاح حالياً يُرفَض", async () => {
    const shift = await openShiftFor(2, "RECEPTION");
    const workOrderId = await createWorkOrderWithDeposit(); // عربون ٢٠٠٠
    // مصروفٌ نقديّ يستنزف الدرج (المتاح بعد العربون = ٢٠٠٠) إلى ٥٠٠ فقط.
    await db().insert(s.receipts).values({
      branchId: 1, shiftId: shift.shiftId, direction: "OUT", amount: "1500.00",
      paymentMethod: "CASH", cashBucket: "DRAWER", status: "COMPLETED", createdBy: 2,
    });

    await expect(cancelGoverned(workOrderId)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("لا وردية مفتوحة بالفرع إطلاقاً (أُغلقت بعد قبض العربون) ⇒ الاسترداد النقدي يُرفَض", async () => {
    const shift = await openShiftFor(2, "RECEPTION"); // يلزم وردية لقبض العربون نفسه عند الإنشاء
    const workOrderId = await createWorkOrderWithDeposit();
    await closeShift({ shiftId: shift.shiftId, countedCash: "2000.00" }, { userId: 2, branchId: 1, role: "cashier" });

    await expect(cancelGoverned(workOrderId)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("قبض عربون CASH مع وردية RETAIL فقط يُرفَض ذرياً بلا DRAWER مجهول", async () => {
    await openShiftFor(2, "RETAIL");

    await expect(createWorkOrderWithDeposit()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await db().select().from(s.workOrders)).toHaveLength(0);
    expect(await db().select().from(s.receipts)).toHaveLength(0);
  });

  it("استرداد CARD القديم يبقى صفري الأثر ثم materializes عبر اعتماد مالك مخصص", async () => {
    const { workOrderId, depositReceiptId } = await createLegacyCardWorkOrder("1");

    await cancelGoverned(workOrderId);

    const pending = (await db().select().from(s.receipts)
      .where(and(eq(s.receipts.workOrderId, workOrderId), eq(s.receipts.direction, "OUT"))))[0]!;
    expect(pending.paymentMethod).toBe("CARD");
    expect(pending.status).toBe("PENDING");
    expect(pending.approvalStatus).toBe("PENDING_APPROVAL");
    expect(pending.cashBucket).toBeNull();
    expect(pending.voucherNumber).toBeNull();
    expect(pending.referenceNumber).toBeNull();
    expect(pending.internalNote).toBe(`WORK_ORDER_CUSTOMER_REFUND:DIRECT:${workOrderId}:${depositReceiptId}`);
    await expect(workOrderCaller({ id: 2, role: "cashier", isOwner: false })
      .cancellationRefundStatus({ workOrderId }))
      .resolves.toEqual({ workOrderId, status: "PENDING", amount: "2000.00" });
    await expect(workOrderCaller({ id: 2, role: "cashier", isOwner: false }, 2)
      .cancellationRefundStatus({ workOrderId }))
      .resolves.toBeNull();
    // Simulate a pending row created by the previous contract: approval must fall
    // back safely when depositReceiptId and the encoded source are both absent.
    await db().update(s.receipts)
      .set({ internalNote: `WORK_ORDER_CUSTOMER_REFUND:DIRECT:${workOrderId}` })
      .where(eq(s.receipts.id, Number(pending.id)));
    expect(await db().select({ id: s.accountingEntries.id }).from(s.accountingEntries)
      .where(eq(s.accountingEntries.entryType, "PAYMENT_OUT"))).toHaveLength(0);

    await expect(workOrderCaller({ id: 1, role: "manager", isOwner: false })
      .approveCancellationRefund({ receiptId: Number(pending.id), confirmationReference: "CARD-REFUND-77" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(workOrderCaller({ id: 3, role: "admin", isOwner: true })
      .approveCancellationRefund({ receiptId: Number(pending.id), confirmationReference: "CARD-REFUND-77" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    const approved = await workOrderCaller({ id: 4, role: "admin", isOwner: true })
      .approveCancellationRefund({ receiptId: Number(pending.id), confirmationReference: "CARD-REFUND-77" });
    expect(approved.replayed).toBe(false);
    await expect(workOrderCaller({ id: 4, role: "admin", isOwner: true })
      .approveCancellationRefund({ receiptId: Number(pending.id), confirmationReference: "CARD-REFUND-77" }))
      .resolves.toMatchObject({ replayed: true });
    const materialized = (await db().select().from(s.receipts)
      .where(eq(s.receipts.id, Number(pending.id))))[0]!;
    expect(materialized.status).toBe("COMPLETED");
    expect(materialized.approvalStatus).toBe("APPROVED");
    expect(materialized.referenceNumber).toBe("CARD-REFUND-77");
    await expect(workOrderCaller({ id: 2, role: "cashier", isOwner: false })
      .cancellationRefundStatus({ workOrderId }))
      .resolves.toEqual({ workOrderId, status: "APPROVED", amount: "2000.00" });
    const audit = (await db().select({
      action: s.auditLogs.action,
      entityId: s.auditLogs.entityId,
      newValue: s.auditLogs.newValue,
    }).from(s.auditLogs).where(and(
      eq(s.auditLogs.action, "workOrder.refund.approve"),
      eq(s.auditLogs.entityId, String(pending.id)),
    )))[0];
    expect(audit?.action).toBe("workOrder.refund.approve");
    expect(JSON.stringify(audit?.newValue)).toContain("CARD-REFUND-77");
    const paymentOut = await db().select({
      id: s.accountingEntries.id,
      receiptId: s.accountingEntries.receiptId,
    }).from(s.accountingEntries)
      .where(eq(s.accountingEntries.entryType, "PAYMENT_OUT"));
    expect(paymentOut).toHaveLength(1);
    expect(paymentOut[0]?.receiptId).toBe(Number(pending.id));
  });

  it("يحجز confirmationReference ذرياً: اعتمادان متزامنان بالطريقة نفسها ينجح أحدهما فقط", async () => {
    const first = await createLegacyCardWorkOrder("RACE-A");
    const second = await createLegacyCardWorkOrder("RACE-B");
    await cancelGoverned(first.workOrderId);
    await cancelGoverned(second.workOrderId);
    const pending = await db().select({ id: s.receipts.id }).from(s.receipts)
      .where(and(eq(s.receipts.direction, "OUT"), eq(s.receipts.status, "PENDING")));
    expect(pending).toHaveLength(2);

    const owner = workOrderCaller({ id: 4, role: "admin", isOwner: true });
    const results = await Promise.allSettled(pending.map((row) =>
      owner.approveCancellationRefund({
        receiptId: Number(row.id),
        confirmationReference: "CARD-RACE-SAME-REF",
      })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected", reason: { code: "CONFLICT" } });

    const materialized = await db().select({ status: s.receipts.status }).from(s.receipts)
      .where(and(eq(s.receipts.direction, "OUT"), eq(s.receipts.workOrderId, first.workOrderId)));
    const materializedSecond = await db().select({ status: s.receipts.status }).from(s.receipts)
      .where(and(eq(s.receipts.direction, "OUT"), eq(s.receipts.workOrderId, second.workOrderId)));
    expect([...materialized, ...materializedSecond].filter((row) => row.status === "COMPLETED")).toHaveLength(1);
    expect([...materialized, ...materializedSecond].filter((row) => row.status === "PENDING")).toHaveLength(1);
  });

  it("⭐ أمرٌ عابرٌ بلا عميلٍ بحصّةٍ مطبَّقةٍ بالتحويل يُلغى ويُنشئ ردّاً معلّقاً طرفاً OTHER — لا يَعلَق (Codex P2)", async () => {
    const workOrderId = await createAnonymousTransferAppliedWorkOrder("A1");

    // قبل الإصلاح كان يُرمى «رد حصة العربون غير النقدية يحتاج عميلاً» فتُرجَع المعاملةُ ⇒ الأمرُ
    // عالقٌ نشطاً بمالٍ محتجَز. الآن يُلغى، وتُنشأ حصّةُ الردّ معلّقةً طرفاً OTHER (مسارُ خروجٍ ممكن).
    await cancelGoverned(workOrderId, { requestKey: `anon-transfer:${randomUUID()}` });

    const [wo] = await db().select({ status: s.workOrders.status })
      .from(s.workOrders).where(eq(s.workOrders.id, workOrderId));
    expect(wo.status).toBe("CANCELLED");

    const refunds = await db().select({
      partyType: s.receipts.partyType,
      partyId: s.receipts.partyId,
      status: s.receipts.status,
      approvalStatus: s.receipts.approvalStatus,
      method: s.receipts.paymentMethod,
      cashBucket: s.receipts.cashBucket,
    }).from(s.receipts).where(and(
      eq(s.receipts.workOrderId, workOrderId),
      eq(s.receipts.direction, "OUT"),
      like(s.receipts.internalNote, "WORK_ORDER_CUSTOMER_REFUND:APPLIED:%"),
    ));
    expect(refunds).toHaveLength(1);
    const refund = refunds[0]!;
    // طرفٌ OTHER بلا عميل — والمالُ لم يعد بلا مالكٍ ولا مخرج (§٥).
    expect(refund.partyType).toBe("OTHER");
    expect(refund.partyId).toBeNull();
    // غيرُ نقديّ ⇒ معلّقٌ باعتماد مالك، بلا دلوِ نقدٍ (لا يمسّ درجاً ولا خزينة حتى يُعتمد).
    expect(refund.status).toBe("PENDING");
    expect(refund.approvalStatus).toBe("PENDING_APPROVAL");
    expect(refund.method).toBe("TRANSFER");
    expect(refund.cashBucket).toBeNull();
  });
});
