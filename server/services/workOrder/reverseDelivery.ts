/**
 * العكسُ الوحيد لتسليم أمر الشغل، سواء كانت فاتورته صفريّة البنود أم ذات بنود.
 * الطلب غير المعتمد صفر الأثر، والحقيقة النقدية مشتقة من أدلة IN/OUT لا من رأس الفاتورة.
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, isNull, like, notLike, or, sql } from "drizzle-orm";
import {
  accountingEntries,
  deliveryConsignments,
  deliveryRemittanceLines,
  deliveryRemittances,
  invoiceItems,
  invoices,
  receipts,
  shifts,
  users,
  workOrders,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { createPostingIntent, creditLine, debitLine } from "../accounting/postingEngine";
import { logAuditTx } from "../auditService";
import {
  assertCashOutAvailable,
  assertNonPhysicalOutReceipt,
  lockMaterializedCashReceiptSourceForWrite,
} from "../cash/cashAvailability";
import { appendDeliveryEvent } from "../delivery/lifecycle";
import { checkIdempotency, idempotencyHash, recordIdempotencyKey } from "../idempotency";
import { adjustCustomerBalance, postEntry } from "../ledgerService";
import { money, round2, toDbMoney } from "../money";
import { assertPeriodOpen } from "../periodLockService";
import { appliedCollectionsForWorkOrder } from "../deposits";
import { paymentAssetRole } from "../sale/paymentPosting";
import { type Actor, withTx } from "../tx";
import { recordWorkOrderEvent } from "../workOrderEvents";
import { assertWorkOrderBranch, loadWorkOrder } from "./helpers";

type ReceiptMethod = typeof receipts.$inferSelect["paymentMethod"];
type RefundMethod = Exclude<ReceiptMethod, "EXCHANGE" | "TELECOM">;
export type WorkOrderRefundCounterRole = "OTHER_LIABILITY" | "AR";

export interface WorkOrderRefundSourcePlan {
  sourceReceiptId: number;
  amount: string;
  collectedMethod: ReceiptMethod;
  refundMethod: RefundMethod;
  counterRole: WorkOrderRefundCounterRole;
}

export interface ReverseWorkOrderDeliveryInput {
  workOrderId: number;
  expectedVersion: number;
  reason: string;
  reopen?: boolean;
  refundShiftId?: number | null;
  refundSources: WorkOrderRefundSourcePlan[];
  clientRequestId: string;
}

export interface ApprovedReverseDeliveryControl {
  approvedControlRequestId: number;
}

interface CollectionSource {
  receiptId: number;
  amount: ReturnType<typeof money>;
  method: ReceiptMethod;
}

interface OutgoingEvidence {
  receiptId: number;
  amount: ReturnType<typeof money>;
  status: "COMPLETED" | "PENDING";
  sourceReceiptId: number | null;
  counterRole: WorkOrderRefundCounterRole | null;
}

interface ReverseEvidence {
  sources: CollectionSource[];
  completedOut: ReturnType<typeof money>;
  pendingOut: ReturnType<typeof money>;
  netPaid: ReturnType<typeof money>;
  plans: WorkOrderRefundSourcePlan[];
  unsupportedMethods: ReceiptMethod[];
}

export interface ReverseDeliveryApprovalLocks {
  workOrder: typeof workOrders.$inferSelect;
  cashShiftId: number | null;
}

const auditCtx = (actor: Actor, branchId: number) =>
  ({ user: { id: actor.userId, branchId }, req: undefined }) as unknown as Parameters<typeof logAuditTx>[1];

function normalizedPlan(plan: WorkOrderRefundSourcePlan): WorkOrderRefundSourcePlan {
  const amount = round2(money(plan.amount));
  if (!Number.isInteger(plan.sourceReceiptId) || plan.sourceReceiptId <= 0 || amount.lte(0)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "خطة مصدر الرد غير صالحة" });
  }
  if (String(plan.refundMethod) === "EXCHANGE" || String(plan.refundMethod) === "TELECOM") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "طريقة الرد المطلوبة غير مدعومة تشغيلياً" });
  }
  return {
    sourceReceiptId: Number(plan.sourceReceiptId),
    amount: amount.toFixed(2),
    collectedMethod: plan.collectedMethod,
    refundMethod: plan.refundMethod,
    counterRole: plan.counterRole,
  };
}

function normalizedPlans(plans: readonly WorkOrderRefundSourcePlan[]): WorkOrderRefundSourcePlan[] {
  return plans.map(normalizedPlan).sort((a, b) =>
    a.sourceReceiptId - b.sourceReceiptId
    || a.counterRole.localeCompare(b.counterRole)
    || a.refundMethod.localeCompare(b.refundMethod),
  );
}

function parseOutgoingSource(internalNote: string | null): {
  sourceReceiptId: number | null;
  counterRole: WorkOrderRefundCounterRole | null;
} {
  if (!internalNote?.startsWith("WORK_ORDER_CUSTOMER_REFUND:")) {
    return { sourceReceiptId: null, counterRole: null };
  }
  const parts = internalNote.split(":");
  const sourceReceiptId = Number(parts[3] ?? 0);
  return {
    sourceReceiptId: sourceReceiptId > 0 ? sourceReceiptId : null,
    counterRole: parts[1] === "REVERSE_AR" ? "AR" : "OTHER_LIABILITY",
  };
}

async function collectionSources(
  tx: Tx,
  workOrderId: number,
  invoiceId: number,
  lock: boolean,
): Promise<CollectionSource[]> {
  const directQuery = tx
    .select({ id: receipts.id, amount: receipts.amount, method: receipts.paymentMethod })
    .from(receipts)
    .where(and(
      or(eq(receipts.invoiceId, invoiceId), eq(receipts.workOrderId, workOrderId)),
      eq(receipts.direction, "IN"),
      eq(receipts.status, "COMPLETED"),
      eq(receipts.approvalStatus, "APPROVED"),
      or(isNull(receipts.referenceNumber), notLike(receipts.referenceNumber, "DLV-FEE-%")),
    ));
  const directRows = lock ? await directQuery.for("update") : await directQuery;

  // إيصال توريد المندوب قد يجمع عدة إرساليات ولا يحمل invoiceId؛ مبلغ الفاتورة مخصص في القيد.
  const postingQuery = tx
    .select({ id: receipts.id, amount: accountingEntries.amount, method: receipts.paymentMethod })
    .from(accountingEntries)
    .innerJoin(receipts, eq(receipts.id, accountingEntries.receiptId))
    .where(and(
      eq(accountingEntries.invoiceId, invoiceId),
      eq(accountingEntries.entryType, "PAYMENT_IN"),
      eq(receipts.direction, "IN"),
      eq(receipts.status, "COMPLETED"),
      eq(receipts.approvalStatus, "APPROVED"),
    ));
  const postingRows = lock ? await postingQuery.for("update") : await postingQuery;

  // التوريد النقدي للجهة قد يكون إيصالاً تجميعياً بلا invoiceId، وقد لا ينشئ PAYMENT_IN
  // مخصّصاً إذا كانت الفاتورة قد قُيّدت عند تأكيد التسليم. تخصيص كشف التوريد immutable هو
  // الدليل الوحيد عندئذٍ؛ cashReceived لا grossApplied كي لا نردّ عجزاً لم يدخل الخزينة.
  const remittanceQuery = tx
    .select({
      id: receipts.id,
      amount: deliveryRemittanceLines.cashReceived,
      method: receipts.paymentMethod,
    })
    .from(deliveryRemittanceLines)
    .innerJoin(deliveryConsignments, eq(deliveryConsignments.id, deliveryRemittanceLines.consignmentId))
    .innerJoin(deliveryRemittances, eq(deliveryRemittances.id, deliveryRemittanceLines.remittanceId))
    .innerJoin(receipts, eq(receipts.id, deliveryRemittances.receiptInId))
    .where(and(
      eq(deliveryConsignments.invoiceId, invoiceId),
      eq(receipts.direction, "IN"),
      eq(receipts.status, "COMPLETED"),
      eq(receipts.approvalStatus, "APPROVED"),
    ));
  const remittanceRows = lock ? await remittanceQuery.for("update") : await remittanceQuery;

  const applied = await appliedCollectionsForWorkOrder(tx, workOrderId);
  if (applied.some((part) => part.receiptId == null)) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "عربون أمر الشغل يحتوي حصة قبض بلا إيصال مصدر؛ أوقف العكس وراجع سجل القبض",
    });
  }
  const byReceipt = new Map<number, CollectionSource>();
  const appliedIds = new Set<number>();
  const directIds = new Set<number>();
  for (const part of applied) {
    const receiptId = Number(part.receiptId);
    appliedIds.add(receiptId);
    const prior = byReceipt.get(receiptId);
    byReceipt.set(receiptId, {
      receiptId,
      amount: round2((prior?.amount ?? money(0)).plus(money(part.amount))),
      method: part.method,
    });
  }
  for (const row of directRows) {
    const receiptId = Number(row.id);
    if (appliedIds.has(receiptId)) continue;
    directIds.add(receiptId);
    byReceipt.set(receiptId, { receiptId, amount: round2(money(row.amount)), method: row.method });
  }
  for (const row of postingRows) {
    const receiptId = Number(row.id);
    if (appliedIds.has(receiptId) || directIds.has(receiptId)) continue;
    const amount = round2(money(row.amount ?? "0"));
    if (amount.lte(0)) continue;
    const prior = byReceipt.get(receiptId);
    byReceipt.set(receiptId, {
      receiptId,
      amount: round2((prior?.amount ?? money(0)).plus(amount)),
      method: row.method,
    });
  }
  for (const row of remittanceRows) {
    const receiptId = Number(row.id);
    // إن كان لنفس الإيصال تخصيص PAYMENT_IN صريح، فهو الأدق ويمنع العدّ المزدوج.
    if (byReceipt.has(receiptId)) continue;
    const amount = round2(money(row.amount ?? "0"));
    if (amount.lte(0)) continue;
    byReceipt.set(receiptId, { receiptId, amount, method: row.method });
  }
  return Array.from(byReceipt.values()).filter((source) => source.amount.gt(0)).sort((a, b) => a.receiptId - b.receiptId);
}

async function outgoingEvidence(
  tx: Tx,
  workOrderId: number,
  invoiceId: number,
  lock: boolean,
): Promise<OutgoingEvidence[]> {
  const query = tx
    .select({
      id: receipts.id,
      amount: receipts.amount,
      status: receipts.status,
      internalNote: receipts.internalNote,
    })
    .from(receipts)
    .where(and(
      or(eq(receipts.invoiceId, invoiceId), eq(receipts.workOrderId, workOrderId)),
      eq(receipts.direction, "OUT"),
      inArray(receipts.status, ["COMPLETED", "PENDING"]),
      or(
        and(eq(receipts.status, "COMPLETED"), eq(receipts.approvalStatus, "APPROVED")),
        and(eq(receipts.status, "PENDING"), eq(receipts.approvalStatus, "PENDING_APPROVAL")),
      ),
      or(isNull(receipts.referenceNumber), notLike(receipts.referenceNumber, "DLV-FEE-%")),
    ));
  const rows = lock ? await query.for("update") : await query;
  return rows.map((row) => ({
    receiptId: Number(row.id),
    amount: round2(money(row.amount)),
    status: row.status as "COMPLETED" | "PENDING",
    ...parseOutgoingSource(row.internalNote),
  }));
}

async function reverseEvidence(
  tx: Tx,
  args: { workOrderId: number; invoiceId: number; deposit: string | null; lock: boolean },
): Promise<ReverseEvidence> {
  const sources = await collectionSources(tx, args.workOrderId, args.invoiceId, args.lock);
  const outs = await outgoingEvidence(tx, args.workOrderId, args.invoiceId, args.lock);
  const totalIn = round2(sources.reduce((sum, source) => sum.plus(source.amount), money(0)));
  const completedOut = round2(outs.filter((row) => row.status === "COMPLETED")
    .reduce((sum, row) => sum.plus(row.amount), money(0)));
  const pendingOut = round2(outs.filter((row) => row.status === "PENDING")
    .reduce((sum, row) => sum.plus(row.amount), money(0)));
  const committedOut = round2(completedOut.plus(pendingOut));
  if (committedOut.gt(totalIn)) {
    throw new TRPCError({ code: "CONFLICT", message: "إيصالات الرد المرتبطة تتجاوز المقبوض المثبت لأمر الشغل" });
  }

  const usedBySource = new Map<number, ReturnType<typeof money>>();
  let unmatched = money(0);
  let liabilityAlreadyCommitted = money(0);
  for (const out of outs) {
    if (out.counterRole === "OTHER_LIABILITY") liabilityAlreadyCommitted = liabilityAlreadyCommitted.plus(out.amount);
    if (out.sourceReceiptId != null && sources.some((source) => source.receiptId === out.sourceReceiptId)) {
      usedBySource.set(out.sourceReceiptId, round2((usedBySource.get(out.sourceReceiptId) ?? money(0)).plus(out.amount)));
    } else {
      unmatched = unmatched.plus(out.amount);
    }
  }
  const remaining: CollectionSource[] = [];
  for (const source of sources) {
    let amount = round2(source.amount.minus(usedBySource.get(source.receiptId) ?? money(0)));
    if (amount.lt(0)) throw new TRPCError({ code: "CONFLICT", message: `ردود المصدر #${source.receiptId} تتجاوز قبضه` });
    if (unmatched.gt(0) && amount.gt(0)) {
      const take = amount.lte(unmatched) ? amount : unmatched;
      amount = round2(amount.minus(take));
      unmatched = round2(unmatched.minus(take));
    }
    if (amount.gt(0)) remaining.push({ ...source, amount });
  }
  if (unmatched.gt(0)) throw new TRPCError({ code: "CONFLICT", message: "تعذّر إسناد رد سابق إلى مصدر قبض مثبت" });

  const rawDeposit = money(args.deposit ?? "0");
  const depositClosed = round2(rawDeposit.lt(totalIn) ? rawDeposit : totalIn);
  let liabilityLeft = round2(depositClosed.minus(liabilityAlreadyCommitted));
  if (liabilityLeft.lt(0)) liabilityLeft = money(0);
  const plans: WorkOrderRefundSourcePlan[] = [];
  const unsupportedMethods = Array.from(new Set(
    remaining.filter((source) => source.method === "EXCHANGE").map((source) => source.method),
  ));
  for (const source of remaining) {
    // EXCHANGE تسوية صيرفة لا تمثل قناة رد عميل ولا يجوز تحويلها افتراضياً إلى نقد.
    if (source.method === "EXCHANGE") continue;
    const refundMethod: RefundMethod = source.method === "TELECOM" ? "CASH" : source.method;
    const liabilityPart = source.amount.lte(liabilityLeft) ? source.amount : liabilityLeft;
    const arPart = round2(source.amount.minus(liabilityPart));
    if (liabilityPart.gt(0)) {
      plans.push({ sourceReceiptId: source.receiptId, amount: liabilityPart.toFixed(2), collectedMethod: source.method, refundMethod, counterRole: "OTHER_LIABILITY" });
      liabilityLeft = round2(liabilityLeft.minus(liabilityPart));
    }
    if (arPart.gt(0)) {
      plans.push({ sourceReceiptId: source.receiptId, amount: arPart.toFixed(2), collectedMethod: source.method, refundMethod, counterRole: "AR" });
    }
  }
  return {
    sources,
    completedOut,
    pendingOut,
    netPaid: round2(totalIn.minus(completedOut)),
    plans: normalizedPlans(plans),
    unsupportedMethods,
  };
}

export async function getWorkOrderReverseDeliveryPreflightInTx(
  tx: Tx,
  workOrderId: number,
  actor: Actor & { role?: string },
) {
  const wo = (await tx.select().from(workOrders).where(eq(workOrders.id, workOrderId)).limit(1))[0];
  if (!wo) throw new TRPCError({ code: "NOT_FOUND", message: "طلب الخدمة غير موجود" });
  assertWorkOrderBranch(wo, actor);
  if (wo.status !== "DELIVERED" || wo.invoiceId == null) {
    return {
      eligible: false as const,
      workOrderId,
      branchId: Number(wo.branchId),
      status: wo.status,
      version: Number(wo.version),
      invoiceId: wo.invoiceId == null ? null : Number(wo.invoiceId),
      ineligibleReason: "أمر الشغل ليس في حالة تسليم قابلة للعكس",
      netPaid: "0.00",
      priorCompletedOut: "0.00",
      priorPendingOut: "0.00",
      refundSources: [] as WorkOrderRefundSourcePlan[],
      openReceptionShifts: [],
      consignment: null,
    };
  }
  const invoiceId = Number(wo.invoiceId);
  const evidence = await reverseEvidence(tx, { workOrderId, invoiceId, deposit: wo.deposit, lock: false });
  const openReceptionShifts = await tx
    .select({ id: shifts.id, userId: shifts.userId, userName: users.name, expectedCash: shifts.expectedCash })
    .from(shifts)
    .innerJoin(users, eq(users.id, shifts.userId))
    .where(and(eq(shifts.branchId, Number(wo.branchId)), eq(shifts.status, "OPEN"), eq(shifts.shiftType, "RECEPTION")));
  const consignmentRows = await tx.select({
    id: deliveryConsignments.id,
    number: deliveryConsignments.consignmentNumber,
    status: deliveryConsignments.status,
    parcelStatus: deliveryConsignments.parcelStatus,
    moneyStatus: deliveryConsignments.moneyStatus,
    invoiceId: deliveryConsignments.invoiceId,
  }).from(deliveryConsignments)
    .where(eq(deliveryConsignments.workOrderId, workOrderId))
    .orderBy(desc(deliveryConsignments.id))
    .limit(1);
  const consignment = consignmentRows.length > 0 ? consignmentRows[0]! : null;
  const mappedShifts = openReceptionShifts.map((shift) => ({
    id: Number(shift.id), userId: Number(shift.userId), userName: shift.userName,
    expectedCash: shift.expectedCash == null ? null : round2(money(shift.expectedCash)).toFixed(2),
  }));
  const mappedConsignment = consignment ? {
    id: Number(consignment.id), number: consignment.number, status: consignment.status,
    parcelStatus: consignment.parcelStatus, moneyStatus: consignment.moneyStatus,
    invoiceId: Number(consignment.invoiceId),
  } : null;
  if (evidence.unsupportedMethods.length > 0) {
    return {
      eligible: false as const,
      workOrderId,
      branchId: Number(wo.branchId),
      status: wo.status,
      version: Number(wo.version),
      invoiceId,
      ineligibleReason: "يتضمن المقبوض سند صيرفة EXCHANGE لا يملك قناة رد عميل موثقة؛ سوِّ السند أولاً",
      netPaid: evidence.netPaid.toFixed(2),
      priorCompletedOut: evidence.completedOut.toFixed(2),
      priorPendingOut: evidence.pendingOut.toFixed(2),
      refundSources: [] as WorkOrderRefundSourcePlan[],
      openReceptionShifts: mappedShifts,
      consignment: mappedConsignment,
    };
  }
  return {
    eligible: true as const,
    workOrderId,
    branchId: Number(wo.branchId),
    status: wo.status,
    version: Number(wo.version),
    invoiceId,
    netPaid: evidence.netPaid.toFixed(2),
    priorCompletedOut: evidence.completedOut.toFixed(2),
    priorPendingOut: evidence.pendingOut.toFixed(2),
    refundSources: evidence.plans,
    openReceptionShifts: mappedShifts,
    consignment: mappedConsignment,
  };
}

export async function getWorkOrderReverseDeliveryPreflight(workOrderId: number, actor: Actor & { role?: string }) {
  return withTx((tx) => getWorkOrderReverseDeliveryPreflightInTx(tx, workOrderId, actor), { gate: "NONE" });
}

export async function computeWorkOrderInvoiceNetPaidInTx(
  tx: Tx,
  workOrderId: number,
  invoiceId: number,
  deposit: string | null,
): Promise<string> {
  return (await reverseEvidence(tx, { workOrderId, invoiceId, deposit, lock: true })).netPaid.toFixed(2);
}

async function resolveLockedReceptionCashShift(tx: Tx, branchId: number, explicitShiftId: number | null): Promise<number> {
  const open = await tx.select({ id: shifts.id }).from(shifts)
    .where(and(eq(shifts.branchId, branchId), eq(shifts.status, "OPEN"), eq(shifts.shiftType, "RECEPTION")));
  const chosen = explicitShiftId != null
    ? open.find((row) => Number(row.id) === explicitShiftId)
    : open.length === 1 ? open[0] : null;
  if (!chosen) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: open.length > 1
        ? "توجد عدة ورديات RECEPTION مفتوحة؛ حدّد درج الاسترداد النقدي صراحةً"
        : "لا توجد وردية RECEPTION مفتوحة لهذا الاسترداد النقدي",
    });
  }
  const shiftId = Number(chosen.id);
  await lockMaterializedCashReceiptSourceForWrite(tx, {
    branchId, shiftId, cashBucket: "DRAWER", paymentMethod: "CASH",
    status: "COMPLETED", approvalStatus: "APPROVED",
  });
  return shiftId;
}

/**
 * طورُ أقفال الاعتماد بلا أي أثر مالي: مصدر النقد/الإيصالات أولاً ثم أمر الشغل.
 * يسبق قفل workOrderControlRequests كي لا ينشأ اتجاه request → cash المقابل لمسارات النقد.
 */
export async function lockReverseDeliveryApprovalResourcesInTx(
  tx: Tx,
  input: ReverseWorkOrderDeliveryInput,
  actor: Actor & { role?: string },
): Promise<ReverseDeliveryApprovalLocks> {
  const requestedPlans = normalizedPlans(input.refundSources);
  const hint = (await tx.select({ branchId: workOrders.branchId, invoiceId: workOrders.invoiceId })
    .from(workOrders).where(eq(workOrders.id, Number(input.workOrderId))).limit(1))[0];
  if (!hint) throw new TRPCError({ code: "NOT_FOUND", message: "طلب الخدمة غير موجود" });
  const cashShiftId = requestedPlans.some((plan) => plan.refundMethod === "CASH")
    ? await resolveLockedReceptionCashShift(tx, Number(hint.branchId), input.refundShiftId ?? null)
    : null;
  if (hint.invoiceId != null) {
    await reverseEvidence(tx, {
      workOrderId: Number(input.workOrderId),
      invoiceId: Number(hint.invoiceId),
      deposit: null,
      lock: true,
    });
  }
  const workOrder = await loadWorkOrder(tx, Number(input.workOrderId));
  assertWorkOrderBranch(workOrder, actor);
  return { workOrder, cashShiftId };
}

function assertSettledConsignmentOrNone(consignment: typeof deliveryConsignments.$inferSelect | undefined): void {
  if (!consignment) return;
  const settled = consignment.status === "DELIVERED"
    && consignment.parcelStatus === "DELIVERED"
    && (consignment.moneyStatus === "SETTLED" || consignment.moneyStatus === "NOT_APPLICABLE");
  if (!settled) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `الإرسالية ${consignment.consignmentNumber} ما زالت حيّة (${consignment.parcelStatus}/${consignment.moneyStatus})؛ أكمل التسليم والتسوية أو الاسترجاع التشغيلي أولاً`,
    });
  }
}

/** يُستدعى حصراً من اعتماد طلب التحكم داخل المعاملة نفسها. */
export async function reverseWorkOrderDeliveryInTx(
  tx: Tx,
  input: ReverseWorkOrderDeliveryInput,
  actor: Actor & { role?: string },
  control: ApprovedReverseDeliveryControl,
  approvalLocks?: ReverseDeliveryApprovalLocks,
) {
  const workOrderId = Number(input.workOrderId);
  const expectedVersion = Number(input.expectedVersion);
  const reason = input.reason.trim();
  const clientRequestId = input.clientRequestId.trim();
  const requestedPlans = normalizedPlans(input.refundSources);
  if (!Number.isInteger(control.approvedControlRequestId) || control.approvedControlRequestId <= 0) {
    throw new TRPCError({ code: "FORBIDDEN", message: "عكس التسليم يتطلب طلب تحكم معتمداً" });
  }
  if (!Number.isInteger(expectedVersion) || expectedVersion <= 0 || reason.length < 3 || reason.length > 500 || !clientRequestId) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "نسخة الأمر وسبب العكس ومفتاحه مطلوبة" });
  }
  const fingerprint = idempotencyHash({
    workOrderId, expectedVersion, reason, reopen: input.reopen === true,
    refundShiftId: input.refundShiftId ?? null, refundSources: requestedPlans,
    approvedControlRequestId: control.approvedControlRequestId,
  });
  const replayInvoiceId = await checkIdempotency(
    tx, "workOrder.reverseDelivery", clientRequestId, fingerprint, { requireStoredHash: true },
  );
  if (replayInvoiceId != null) {
    const replayInvoice = (await tx.select({ total: invoices.total, paidAmount: invoices.paidAmount })
      .from(invoices).where(eq(invoices.id, replayInvoiceId)).limit(1))[0];
    const replayRefunds = await tx.select({ id: receipts.id, amount: receipts.amount, status: receipts.status })
      .from(receipts)
      .where(and(
        eq(receipts.invoiceId, replayInvoiceId),
        eq(receipts.direction, "OUT"),
        like(receipts.internalNote, `%:${control.approvedControlRequestId}`),
      ));
    return {
      workOrderId, invoiceId: replayInvoiceId, replayed: true as const,
      reversedTotal: round2(money(replayInvoice?.total ?? "0")).toFixed(2),
      refundedTotal: round2(replayRefunds.reduce((sum, row) => sum.plus(money(row.amount)), money(0))).toFixed(2),
      paidAmount: round2(money(replayInvoice?.paidAmount ?? "0")).toFixed(2),
      pendingRefundReceiptIds: replayRefunds.filter((row) => row.status === "PENDING").map((row) => Number(row.id)),
      status: input.reopen === true ? "READY" as const : "CANCELLED" as const,
    };
  }

  const locked = approvalLocks ?? await lockReverseDeliveryApprovalResourcesInTx(tx, input, actor);
  const cashShiftId = locked.cashShiftId;
  const wo = locked.workOrder;
  if (Number(wo.version) !== expectedVersion) {
    throw new TRPCError({ code: "CONFLICT", message: "تغيّرت نسخة أمر الشغل قبل اعتماد العكس" });
  }
  if (wo.status !== "DELIVERED" || wo.invoiceId == null) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "العكس لأمرٍ مُسلَّم ذي فاتورة فقط" });
  }
  const invoiceId = Number(wo.invoiceId);
  const inv = (await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for("update").limit(1))[0];
  if (!inv || inv.sourceType !== "WORKORDER") {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "فاتورة أمر الشغل غير موجودة أو ليست من منشأ WORKORDER" });
  }
  // عكس التسليم يغيّر حالة الفاتورة وبنودها وأمر الشغل والإرسالية؛ لذلك لا يكفي أن
  // يكون قيد العكس الجديد في يوم مفتوح. يجب أن تبقى فترة الحقيقة الأصلية نفسها
  // مفتوحة، وإلا صار المستند المقفل يتغير بعد إصدار شهادة الشهر.
  await assertPeriodOpen(tx, inv.invoiceDate);
  if (wo.deliveredAt) await assertPeriodOpen(tx, wo.deliveredAt);
  if (inv.status === "RETURNED" || inv.status === "CANCELLED" || inv.status === "SUPERSEDED") {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "فاتورة أمر الشغل معكوسة أو ملغاة سلفاً" });
  }
  const evidence = await reverseEvidence(tx, { workOrderId, invoiceId, deposit: wo.deposit, lock: true });
  if (evidence.unsupportedMethods.length > 0) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "يتضمن المقبوض سند صيرفة EXCHANGE لا يملك قناة رد عميل موثقة؛ سوِّ السند أولاً",
    });
  }
  if (idempotencyHash(evidence.plans) !== idempotencyHash(requestedPlans)) {
    throw new TRPCError({ code: "CONFLICT", message: "تغيّرت مصادر الرد أو مبالغها بعد الطلب؛ افتح طلب عكس جديداً" });
  }

  const consignment = (await tx.select().from(deliveryConsignments)
    .where(eq(deliveryConsignments.workOrderId, workOrderId))
    .orderBy(desc(deliveryConsignments.id))
    .for("update").limit(1))[0];
  assertSettledConsignmentOrNone(consignment);
  if (consignment && Number(consignment.invoiceId) !== invoiceId) {
    throw new TRPCError({ code: "CONFLICT", message: "الإرسالية المستقرة لا ترتبط بفاتورة أمر الشغل الحالية" });
  }
  if (Number(wo.createdBy ?? 0) === actor.userId || Number(wo.assignedTo ?? 0) === actor.userId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "منشئ الأمر أو الفنّي المسند إليه لا يعتمد عكس تسليمه" });
  }

  const total = round2(money(inv.total));
  const materialsCost = round2(money(wo.materialsCost ?? "0"));
  const rawDeposit = money(wo.deposit ?? "0");
  const depositClosed = round2(rawDeposit.lt(total) ? rawDeposit : total);
  // رصيد العميل المخزّن يعكس أصل المقبوض قبل ردوده، لا paidAmount الصافي بعدها. طرحُ
  // `total - netPaid` كان يطرح OUT السابق مرّةً ثانية ويقلب الرصيد سالباً عند رد جزئي سابق.
  const grossPaidBeforeRefunds = round2(evidence.netPaid.plus(evidence.completedOut));
  const unpaid = round2(total.minus(grossPaidBeforeRefunds));
  const safeUnpaid = unpaid.lt(0) ? money(0) : unpaid;
  const reverseLines = [debitLine("SALES_FLEX", total), creditLine("AR", total)];
  const roleDebits: Record<string, ReturnType<typeof money>> = { SALES_FLEX: total };
  const roleCredits: Record<string, ReturnType<typeof money>> = { AR: total };
  if (materialsCost.gt(0)) {
    reverseLines.push(debitLine("WORK_IN_PROGRESS", materialsCost), creditLine("COGS", materialsCost));
    roleDebits.WORK_IN_PROGRESS = materialsCost;
    roleCredits.COGS = materialsCost;
  }
  if (depositClosed.gt(0)) {
    reverseLines.push(debitLine("AR", depositClosed), creditLine("OTHER_LIABILITY", depositClosed));
    roleDebits.AR = depositClosed;
    roleCredits.OTHER_LIABILITY = depositClosed;
  }
  const reverseSource = { roleDebits, roleCredits };
  await postEntry(tx, {
    entryType: "RETURN",
    dedupeKey: `WO-REVERSE:${workOrderId}:${invoiceId}`,
    branchId: Number(wo.branchId), invoiceId, customerId: wo.customerId ?? null,
    revenue: total.neg(), cost: materialsCost.neg(),
    profit: round2(total.minus(materialsCost)).neg(), amount: total.neg(),
    notes: `عكس تسليم أمر الشغل ${wo.orderNumber} — ${reason}`,
    postingIntent: createPostingIntent("RETURN_SALE_FLEX_WORKORDER", "RETURN", reverseLines, reverseSource),
    postingSourceComponents: reverseSource,
  });
  if (input.reopen !== true && materialsCost.gt(0)) {
    const wasteSource = { roleDebits: { LOSSES: materialsCost }, roleCredits: { WORK_IN_PROGRESS: materialsCost } };
    await postEntry(tx, {
      entryType: "ADJUST", dedupeKey: `WO-REVERSE-WASTE:${workOrderId}:${invoiceId}`,
      branchId: Number(wo.branchId), invoiceId, cost: materialsCost, amount: materialsCost,
      notes: `هدر خامة أمر الشغل المسترجَع ${wo.orderNumber} — ${reason}`,
      postingIntent: createPostingIntent("ADJUST_WIP_WASTE", "ADJUST", [debitLine("LOSSES", materialsCost), creditLine("WORK_IN_PROGRESS", materialsCost)], wasteSource),
      postingSourceComponents: wasteSource,
    });
  }
  if (wo.customerId != null && safeUnpaid.gt(0)) {
    await adjustCustomerBalance(tx, Number(wo.customerId), safeUnpaid.neg());
  }

  const pendingRefundReceiptIds: number[] = [];
  let immediateCashRefund = money(0);
  for (const plan of requestedPlans) {
    const amount = money(plan.amount);
    const cash = plan.refundMethod === "CASH";
    if (cash) {
      if (cashShiftId == null) throw new TRPCError({ code: "CONFLICT", message: "مصدر درج الرد النقدي غير مقفل" });
      await assertCashOutAvailable(tx, {
        branchId: Number(wo.branchId), cashBucket: "DRAWER", shiftId: cashShiftId,
        amount, operation: "رد مقبوضات عكس تسليم أمر شغل",
      });
    } else {
      if (wo.customerId == null) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "الرد غير النقدي يحتاج عميلاً مرتبطاً للاعتماد الخارجي" });
      }
      assertNonPhysicalOutReceipt({
        classification: "DEFERRED_APPROVAL", paymentMethod: plan.refundMethod,
        cashBucket: null, approvalStatus: "PENDING_APPROVAL",
        operation: "طلب رد غير نقدي لعكس تسليم أمر شغل",
      });
    }
    const inserted = await tx.insert(receipts).values({
      branchId: Number(wo.branchId), shiftId: cash ? cashShiftId : null,
      workOrderId, invoiceId, direction: "OUT", amount: toDbMoney(amount),
      paymentMethod: plan.refundMethod, cashBucket: cash ? "DRAWER" : null,
      status: cash ? "COMPLETED" : "PENDING",
      approvalStatus: cash ? "APPROVED" : "PENDING_APPROVAL",
      referenceNumber: cash ? `WO-REV-${invoiceId}-${plan.sourceReceiptId}-${plan.counterRole === "AR" ? "A" : "L"}` : null,
      description: cash ? `رد مقبوض — عكس تسليم ${wo.orderNumber}` : `طلب رد غير نقدي — عكس تسليم ${wo.orderNumber}`,
      partyType: wo.customerId != null ? "CUSTOMER" : "OTHER",
      partyId: wo.customerId ?? null,
      internalNote: `WORK_ORDER_CUSTOMER_REFUND:${plan.counterRole === "AR" ? "REVERSE_AR" : "REVERSE_LIABILITY"}:${workOrderId}:${plan.sourceReceiptId}:${control.approvedControlRequestId}`,
      createdBy: actor.userId,
    });
    const refundReceiptId = extractInsertId(inserted);
    if (!cash) {
      pendingRefundReceiptIds.push(refundReceiptId);
      continue;
    }
    immediateCashRefund = immediateCashRefund.plus(amount);
    const assetRole = paymentAssetRole("CASH", "DRAWER", "OUT");
    const profile = plan.counterRole === "AR" ? "PAYMENT_OUT_CUSTOMER_REFUND" : "PAYMENT_OUT_OTHER";
    const source = { roleDebits: { [plan.counterRole]: amount }, roleCredits: { [assetRole]: amount } };
    await postEntry(tx, {
      entryType: "PAYMENT_OUT", dedupeKey: `WO-REVERSE-REFUND:${invoiceId}:${refundReceiptId}`,
      branchId: Number(wo.branchId), invoiceId, receiptId: refundReceiptId,
      customerId: wo.customerId ?? null, amount, paymentMethod: "CASH",
      notes: `رد عكس تسليم ${wo.orderNumber} — ${plan.counterRole === "AR" ? "حصّة دفعة التسليم" : "حصّة العربون"}`,
      postingIntent: createPostingIntent(profile, "PAYMENT_OUT", [debitLine(plan.counterRole, amount), creditLine(assetRole, amount)], source),
      postingSourceComponents: source,
    });
  }

  const paidAfterImmediate = round2(evidence.netPaid.minus(immediateCashRefund));
  if (paidAfterImmediate.lt(0)) throw new TRPCError({ code: "CONFLICT", message: "الرد النقدي يتجاوز صافي المقبوض المثبت" });
  await tx.update(invoices).set({
    status: "RETURNED", returnedTotal: toDbMoney(total), paidAmount: toDbMoney(paidAfterImmediate),
    notes: `${inv.notes ? `${inv.notes} · ` : ""}عُكس التسليم: ${reason}`,
  }).where(eq(invoices.id, invoiceId));
  await tx.update(invoiceItems).set({
    returnedBaseQuantity: sql`${invoiceItems.baseQuantity}`,
    returnedRestockedBaseQuantity: 0,
  }).where(eq(invoiceItems.invoiceId, invoiceId));

  const reversedAt = new Date();
  if (consignment) {
    await tx.update(deliveryConsignments).set({
      status: "RETURNED", parcelStatus: "RETURNED", moneyStatus: "CANCELLED",
      returnedAt: reversedAt, settledAt: reversedAt,
      returnDeclaredAt: null, returnDeclaredBy: null, returnDeclaredReason: null,
    }).where(eq(deliveryConsignments.id, Number(consignment.id)));
    await appendDeliveryEvent(tx, {
      eventKey: `CN:${Number(consignment.id)}:WO_REVERSED:${invoiceId}`,
      consignmentId: Number(consignment.id), eventType: "RETURNED",
      fromParcelStatus: consignment.parcelStatus, toParcelStatus: "RETURNED",
      fromMoneyStatus: consignment.moneyStatus, toMoneyStatus: "CANCELLED",
      actorUserId: actor.userId,
      payload: { invoiceId, workOrderId, reason, approvedControlRequestId: control.approvedControlRequestId },
    });
  }
  await tx.update(workOrders).set(input.reopen === true ? {
    status: "READY", invoiceId: null, deliveredAt: null,
    cancelReason: null, cancelledAt: null, cancelledBy: null,
    kanbanState: "NORMAL", blockedReason: null,
  } : {
    status: "CANCELLED", deliveredAt: null, cancelReason: reason,
    cancelledAt: reversedAt, cancelledBy: actor.userId,
    kanbanState: "NORMAL", blockedReason: null,
  }).where(eq(workOrders.id, workOrderId));

  await recordWorkOrderEvent(tx, {
    workOrderId, eventType: "REVERSED",
    payload: {
      invoiceId, reason, reopen: input.reopen === true,
      netPaidBefore: evidence.netPaid.toFixed(2), paidAfterImmediate: paidAfterImmediate.toFixed(2),
      pendingRefundReceiptIds, controlRequestId: control.approvedControlRequestId,
    },
    actorUserId: actor.userId, branchId: Number(wo.branchId), seq: invoiceId,
  });
  await logAuditTx(tx, auditCtx(actor, Number(wo.branchId)), {
    action: "workOrder.reverseDelivery", entityType: "workOrder", entityId: workOrderId,
    oldValue: { status: wo.status, invoiceId, paidAmount: evidence.netPaid.toFixed(2) },
    newValue: {
      status: input.reopen === true ? "READY" : "CANCELLED", reason,
      reversedTotal: total.toFixed(2), refundedImmediately: immediateCashRefund.toFixed(2),
      pendingRefundReceiptIds, branchId: Number(wo.branchId),
      controlRequestId: control.approvedControlRequestId,
    },
  });
  await recordIdempotencyKey(tx, "workOrder.reverseDelivery", clientRequestId, invoiceId, fingerprint);
  return {
    workOrderId, invoiceId, replayed: false as const,
    reversedTotal: total.toFixed(2),
    refundedTotal: round2(requestedPlans.reduce((sum, plan) => sum.plus(money(plan.amount)), money(0))).toFixed(2),
    paidAmount: paidAfterImmediate.toFixed(2), pendingRefundReceiptIds,
    status: input.reopen === true ? "READY" as const : "CANCELLED" as const,
  };
}

export async function reverseWorkOrderDelivery(
  input: ReverseWorkOrderDeliveryInput,
  actor: Actor & { role?: string },
  control: ApprovedReverseDeliveryControl,
) {
  return withTx((tx) => reverseWorkOrderDeliveryInTx(tx, input, actor, control));
}
