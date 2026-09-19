import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, getTableColumns, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import {
  auditLogs,
  invoices,
  externalPaymentAttempts,
  idempotencyKeys,
  returnRequests,
  salesControlRequests,
  salesExchangeCommands,
  shifts,
  users,
} from "../../../drizzle/schema";
import { isDeadInvoice, invoiceRemaining } from "@shared/predicates";
import { appErrorMessage } from "@shared/errors";
import type { SalesControlType } from "@shared/salesControl";
import type { Tx } from "../../db";
import { isDupEntry } from "@shared/errorMap.ar";
import { extractAffectedRows, extractInsertId } from "../../lib/insertId";
import { idempotencyHash, payloadHashMatches } from "../idempotency";
import { money, round2 } from "../money";
import { assertPeriodOpen } from "../periodLockService";
import type { ReturnSaleInput } from "../returnService";
import { returnSaleInTx } from "../returnService";
import { requireDb, type Actor, withTx } from "../tx";
import { autoDecideForActiveOwner } from "../approval/ownerAutoDecision";
import { cancelSaleInTx, type CancelSaleInput } from "./cancel";
import {
  correctSaleInTx,
  type CorrectSaleInput,
  type CorrectSaleResult,
} from "./correct";
import {
  loadInvoiceControlSnapshotTx,
  assertLockedInvoiceControlSnapshotTx,
  type InvoiceControlHeader,
  type InvoiceControlSnapshot,
} from "./controlSnapshot";
import { createConfirmedExternalPaymentAttemptTx } from "../posExternalPayment";
import { correctionRequestBlockReasonTx } from "./correctionLookup";

export type SalesReturnControlPayload = Omit<
  ReturnSaleInput,
  "invoiceId" | "clientRequestId" | "internalCorrectionReversal" | "controlExpectedSnapshot"
>;
export type SalesCancelControlPayload = Omit<
  CancelSaleInput,
  "invoiceId" | "clientRequestId" | "controlExpectedSnapshot"
>;
export type SalesReissueControlPayload = Omit<
  CorrectSaleInput,
  | "originalInvoiceId"
  | "clientRequestId"
  | "creditApproved"
  | "creditApprovalId"
  | "managerOverrideByUserId"
  | "priceOverrideApproved"
  | "controlExpectedSnapshot"
>;
export interface SalesDueDateChangeControlPayload {
  dueDate: string | null;
}
export type SalesControlPayload =
  | SalesReturnControlPayload
  | SalesCancelControlPayload
  | SalesReissueControlPayload
  | SalesDueDateChangeControlPayload;

export interface RequestSalesControlInput {
  requestKey: string;
  invoiceId: number;
  requestType: SalesControlType;
  reason: string;
  payload: SalesControlPayload;
}

type RequestSalesControlActor = Actor & {
  scopedOwnerId?: number | null;
  invoiceScope?: "sales" | "reception";
};

const invoiceCreator = alias(users, "salesControlInvoiceCreator");
const controlReviewer = alias(users, "salesControlReviewer");
const resultInvoice = alias(invoices, "salesControlResultInvoice");
const CORRECTION_PAYMENT_CLAIM_OPERATION = "sales.correct.payment-claim";
const CORRECTION_PAYMENT_REVIEWER_LOCK_OPERATION = "sales.correct.payment-reviewer-lock";

function correctionPaymentAttemptRequestId(requestId: number): string {
  return `sales-control-${requestId}-additional`;
}

async function loadCorrectionPaymentClaimTx(tx: Tx, requestId: number) {
  return (
    await tx.select().from(idempotencyKeys).where(and(
      eq(idempotencyKeys.operation, CORRECTION_PAYMENT_CLAIM_OPERATION),
      eq(idempotencyKeys.clientRequestId, String(requestId)),
    )).for("update").limit(1)
  )[0] ?? null;
}

async function loadCorrectionPaymentReviewerLockTx(tx: Tx, reviewerId: number) {
  return (
    await tx.select().from(idempotencyKeys).where(and(
      eq(idempotencyKeys.operation, CORRECTION_PAYMENT_REVIEWER_LOCK_OPERATION),
      eq(idempotencyKeys.clientRequestId, String(reviewerId)),
    )).for("update").limit(1)
  )[0] ?? null;
}

async function clearCorrectionPaymentClaimsTx(tx: Tx, requestId: number, reviewerId: number) {
  await tx.delete(idempotencyKeys).where(and(
    eq(idempotencyKeys.operation, CORRECTION_PAYMENT_CLAIM_OPERATION),
    eq(idempotencyKeys.clientRequestId, String(requestId)),
    eq(idempotencyKeys.refId, reviewerId),
  ));
  await tx.delete(idempotencyKeys).where(and(
    eq(idempotencyKeys.operation, CORRECTION_PAYMENT_REVIEWER_LOCK_OPERATION),
    eq(idempotencyKeys.clientRequestId, String(reviewerId)),
    eq(idempotencyKeys.refId, requestId),
  ));
}

async function assertCorrectionPaymentNotClaimedTx(
  tx: Tx,
  requestId: number,
  action: string,
) {
  const claim = await loadCorrectionPaymentClaimTx(tx, requestId);
  if (!claim) return;
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message: appErrorMessage({
      what: `تعذّر ${action} طلب تعديل الفاتورة`,
      why: `المراجع رقم ${Number(claim.refId)} حجز عملية دفع الفرق وقد يكون بدأ تنفيذها على الجهاز`,
      doThis: "يحرّر المراجع الحجز من شاشة الاعتماد قبل الدفع؛ وبعد ثبوت القبض لا يُرفض الطلب ولا يُسحب بل يُستكمل بالمرجع نفسه",
    }),
  });
}

async function hasDurableCorrectionPaymentTx(tx: Tx, requestId: number): Promise<boolean> {
  const row = (
    await tx.select({ id: externalPaymentAttempts.id }).from(externalPaymentAttempts).where(and(
      eq(externalPaymentAttempts.requestId, correctionPaymentAttemptRequestId(requestId)),
      eq(externalPaymentAttempts.state, "CONFIRMED"),
      sql`${externalPaymentAttempts.invoiceId} IS NULL`,
      sql`${externalPaymentAttempts.receiptId} IS NULL`,
    )).limit(1)
  )[0];
  return row != null;
}

function normalizeReason(reason: string, label = "الإجراء"): string {
  const normalized = reason.trim().replace(/\s+/g, " ");
  if (normalized.length < 3 || normalized.length > 500) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `سبب ${label} مطلوب (3-500 محرف)`,
    });
  }
  return normalized;
}

function normalizeRequestKey(value: string): string {
  const key = value.trim();
  if (!key || key.length > 120) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "مفتاح الطلب مطلوب وبحد أقصى 120 محرفاً" });
  }
  return key;
}

function normalizeDueDatePayload(payload: SalesDueDateChangeControlPayload): string | null {
  if (payload.dueDate === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.dueDate)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "تاريخ الاستحقاق غير صالح (YYYY-MM-DD)" });
  }
  const parsed = new Date(`${payload.dueDate}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== payload.dueDate) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "تاريخ الاستحقاق غير موجود في التقويم" });
  }
  return payload.dueDate;
}

function assertManager(actor: Actor): void {
  if (actor.role !== "manager" && actor.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "مراجعة عمليات البيع الحرجة محصورة بمدير أو أدمن" });
  }
}

function assertBranch(branchId: number, actor: Actor): void {
  if (actor.role !== "admin" && Number(actor.branchId) !== Number(branchId)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "طلب التحكم لا يخص فرعك" });
  }
}

function assertReviewerSeparation(
  request: typeof salesControlRequests.$inferSelect,
  invoiceCreatedBy: number | null,
  actor: Actor,
): void {
  if (actor.isOwner) return;
  if (Number(request.requestedBy) === Number(actor.userId)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا تراجع طلبك بنفسك — يلزم مراجع مستقل" });
  }
  if (invoiceCreatedBy != null && Number(invoiceCreatedBy) === Number(actor.userId)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "منشئ الفاتورة لا يراجع إلغاءها أو إرجاعها أو استبدالها",
    });
  }
}

async function loadByKey(tx: Tx, requestKey: string) {
  return (
    await tx
      .select()
      .from(salesControlRequests)
      .where(eq(salesControlRequests.requestKey, requestKey))
      .for("update")
      .limit(1)
  )[0];
}

function exactReplay(
  row: typeof salesControlRequests.$inferSelect,
  input: RequestSalesControlInput,
  reason: string,
  payloadHash: string,
  actor: Actor,
): boolean {
  return Number(row.invoiceId) === Number(input.invoiceId)
    && row.requestType === input.requestType
    && row.reason === reason
    && payloadHashMatches(payloadHash, row.payloadHash)
    && Number(row.requestedBy) === Number(actor.userId);
}

/** ينشئ مستند نيّة فقط: لا قيد ولا إيصال ولا حركة مخزون ولا تغيير فاتورة. */
export async function requestSalesControl(
  input: RequestSalesControlInput,
  actor: RequestSalesControlActor,
) {
  const requestKey = normalizeRequestKey(input.requestKey);
  const reason = normalizeReason(input.reason);
  const payloadHash = idempotencyHash(input.payload);
  const result = await withTx(async (tx) => {
    const replay = await loadByKey(tx, requestKey);
    if (replay) {
      assertBranch(Number(replay.branchId), actor);
      if (!exactReplay(replay, input, reason, payloadHash, actor)) {
        throw new TRPCError({ code: "CONFLICT", message: "مفتاح الطلب مستخدم لعملية أو حمولة مختلفة" });
      }
      return { ...replay, replayed: true as const };
    }

    const { invoice, snapshot, hash: snapshotHash } = await loadInvoiceControlSnapshotTx(
      tx,
      input.invoiceId,
    );
    assertBranch(Number(invoice.branchId), actor);
    if (actor.scopedOwnerId != null && Number(invoice.createdBy ?? -1) !== Number(actor.scopedOwnerId)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "تعذّر إنشاء طلب تعديل الفاتورة",
          why: "الفاتورة أنشأها موظف آخر ولا تسمح صلاحيتك بتعديلها",
          doThis: "امسح فاتورة أنشأتها أنت أو اطلب من المدير إنشاء التعديل",
        }),
      });
    }
    if (actor.invoiceScope === "reception") {
      const invoiceShift = invoice.shiftId == null ? null : (
        await tx
          .select({ shiftType: shifts.shiftType })
          .from(shifts)
          .where(eq(shifts.id, Number(invoice.shiftId)))
          .limit(1)
      )[0];
      if (invoiceShift?.shiftType !== "RECEPTION") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: appErrorMessage({
            what: "تعذّر إنشاء طلب تعديل الفاتورة",
            why: "موظف الاستقبال يعدّل فواتير وردية الاستقبال فقط",
            doThis: "امسح فاتورة صادرة من الاستقبال أو أحلها إلى مدير المبيعات",
          }),
        });
      }
    }
    if (invoice.sourceType === "WORKORDER") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "فاتورة أمر الشغل تُعالج من مسار عكس التسليم الخاص بأمر الشغل",
      });
    }
    if (isDeadInvoice(invoice)) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "الفاتورة نهائية ولا تقبل طلب تحكم جديداً" });
    }
    if (["SALES_REISSUE", "SALES_EXCHANGE"].includes(input.requestType)) {
      const correctionPayload = input.payload as SalesReissueControlPayload;
      const targetCustomerId = correctionPayload.customerId === undefined
        ? invoice.customerId == null ? null : Number(invoice.customerId)
        : correctionPayload.customerId == null ? null : Number(correctionPayload.customerId);
      const originalCustomerId = invoice.customerId == null ? null : Number(invoice.customerId);
      if (money(invoice.paidAmount ?? "0").gt(0) && targetCustomerId !== originalCustomerId) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: appErrorMessage({
            what: "تعذّر إنشاء طلب تعديل الفاتورة",
            why: "الفاتورة تحمل مقبوضات مرتبطة بعميلها الأصلي ولا يمكن نقلها إلى عميل آخر",
            doThis: "أبقِ العميل الأصلي في التعديل، أو عالج المقبوضات بمسار مالي مستقل قبل إنشاء الطلب",
          }),
        });
      }
      const blockReason = await correctionRequestBlockReasonTx(tx, invoice);
      if (blockReason) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: appErrorMessage({
            what: "تعذّر إنشاء طلب تعديل الفاتورة",
            why: blockReason,
            doThis: "نفّذ الإجراء المذكور ثم امسح الفاتورة من جديد قبل إرسال الطلب",
          }),
        });
      }
    }
    if (input.requestType === "SALES_DUE_DATE_CHANGE") {
      const dueDate = normalizeDueDatePayload(input.payload as SalesDueDateChangeControlPayload);
      if (dueDate === snapshot.header.dueDate) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "تاريخ الاستحقاق المطلوب مطابق للتاريخ الحالي" });
      }
    }
    const legacyPending = (
      await tx
        .select({ id: returnRequests.id })
        .from(returnRequests)
        .where(and(
          eq(returnRequests.invoiceId, input.invoiceId),
          eq(returnRequests.status, "PENDING_APPROVAL"),
        ))
        .limit(1)
    )[0];
    if (legacyPending) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `للفاتورة طلب إرجاع قديم معلّق (#${legacyPending.id})؛ احسمه قبل طلب جديد`,
      });
    }

    let id: number;
    try {
      const inserted = await tx.insert(salesControlRequests).values({
        requestKey,
        invoiceId: input.invoiceId,
        branchId: Number(invoice.branchId),
        requestType: input.requestType,
        status: "PENDING",
        payload: input.payload as never,
        payloadHash,
        invoiceSnapshot: snapshot as never,
        snapshotHash,
        reason,
        requestedBy: actor.userId,
      });
      id = extractInsertId(inserted);
    } catch (error) {
      if (!isDupEntry(error)) throw error;
      const raced = await loadByKey(tx, requestKey);
      if (raced && exactReplay(raced, input, reason, payloadHash, actor)) {
        assertBranch(Number(raced.branchId), actor);
        return { ...raced, replayed: true as const };
      }
      throw new TRPCError({
        code: "CONFLICT",
        message: "يوجد طلب معلّق لهذه الفاتورة أو استُهلك المفتاح بحمولة أخرى",
      });
    }
    return {
      id,
      requestKey,
      invoiceId: input.invoiceId,
      branchId: Number(invoice.branchId),
      requestType: input.requestType,
      status: "PENDING" as const,
      payloadHash,
      snapshotHash,
      reason,
      requestedBy: actor.userId,
      replayed: false as const,
    };
  }, { gate: "NONE" });
  // التصحيح والاستبدال يمران دائماً بشاشة «كان/أصبح»: قد يلزم اختيار درج مفتوح أو
  // تنفيذ بطاقة وإدخال مرجعها وقت الاعتماد، فلا يصح حسمهما تلقائياً بلا تلك المدخلات.
  const needsCorrectionReview = input.requestType === "SALES_REISSUE"
    || input.requestType === "SALES_EXCHANGE";
  const approved = needsCorrectionReview ? false : await autoDecideForActiveOwner(actor, {
    kind: "sales.control.approve",
    id: Number(result.id),
    reason,
  });
  return approved ? { ...result, status: "APPROVED" as const } : result;
}

async function markStaleTx(
  tx: Tx,
  requestId: number,
  actorUserId: number,
  note: string,
): Promise<void> {
  await tx.update(salesControlRequests).set({
    status: "STALE",
    reviewedBy: actorUserId,
    reviewedAt: new Date(),
    reviewNote: note,
  }).where(eq(salesControlRequests.id, requestId));
}

async function recordExchangeTx(
  tx: Tx,
  request: typeof salesControlRequests.$inferSelect,
  snapshot: InvoiceControlSnapshot,
  result: CorrectSaleResult,
  payload: SalesReissueControlPayload,
  actor: Actor,
) {
  const replacement = (
    await tx.select({ total: invoices.total, paidAmount: invoices.paidAmount, returnedTotal: invoices.returnedTotal })
      .from(invoices).where(eq(invoices.id, result.correctedInvoiceId)).limit(1)
  )[0];
  if (!replacement) throw new TRPCError({ code: "CONFLICT", message: "فاتورة الاستبدال لم تُحفظ" });
  const overpay = round2(money(result.overpay ?? "0"));
  const outstanding = round2(invoiceRemaining(replacement));
  const additional = payload.additionalPayment;
  const settlementKind = additional
    ? "COLLECT"
    : overpay.gt(0)
      ? result.overpayHandled === "CASH_REFUND" ? "CASH_REFUND" : "CUSTOMER_CREDIT"
      : outstanding.gt(0) ? "OUTSTANDING" : "NONE";
  // فرق الاستبدال حقيقة سعرية ثابتة بين المستندين، لا مبلغ القبض فقط؛ حالة التسوية
  // تشرح هل جُمع/رُد/رُصّد أو بقي مستحقاً، والفاتورة البديلة تحمل تفاصيل القبض.
  const deltaAmount = round2(money(replacement.total).minus(money(snapshot.header.total)).abs());
  const inserted = await tx.insert(salesExchangeCommands).values({
    controlRequestId: Number(request.id),
    commandKey: request.requestKey,
    branchId: Number(request.branchId),
    originalInvoiceId: Number(request.invoiceId),
    replacementInvoiceId: result.correctedInvoiceId,
    payloadHash: request.payloadHash,
    snapshotHash: request.snapshotHash,
    originalTotal: snapshot.header.total,
    replacementTotal: result.total,
    deltaAmount: deltaAmount.toFixed(2),
    settlementKind,
    settlementMethod: additional?.method ?? null,
    requestedBy: Number(request.requestedBy),
    approvedBy: actor.userId,
  });
  return extractInsertId(inserted);
}

/** الاعتماد هو نقطة الأثر الوحيدة، وكل الأثر وختم الطلب في معاملة واحدة. */
/**
 * ⭐ توجيهُ النقد قرارُ **لحظة الاعتماد** لا لحظة الطلب (تدقيق ١/٩/٢٦).
 *
 * كان `refund.shiftId` يُجمَّد داخل حمولة الطلب ويُمرَّر حرفياً إلى `returnSaleInTx` عند
 * الاعتماد، بينما `resolveBranchCashShiftTx` يشترط أن تكون الوردية **مفتوحةً الآن**. فكلّ
 * مرتجعٍ يُطلَب في نهاية الدوام ويُعتمَد في اليوم التالي كان يفشل حتماً بـ«الوردية المحدَّدة
 * غير مفتوحة»، **ولا حقلَ في شاشة الاعتماد لتبديل الدرج** — ومع حجب الرفض (فصل المهام) تصير
 * الفاتورة مقفلةً بلا مخرج. المسار القديم `returns.approveRequest` كان محقّاً: يستقبل الرافد
 * والدرج والمرجع من المُعتمِد لحظة الاعتماد.
 *
 * ⛔ **المبلغ والطريقة لا يُمَسّان**: هما جوهر ما أقرّه المراجع، وتغييرُهما هنا يجعل الاعتماد
 * موافقةً على غير ما عُرِض. المسموح توجيهُ **مسار** الخروج فقط: أيّ درجٍ مفتوح، وأيّ مرجع جهاز.
 */
export interface SalesControlCashRouting {
  /** الدرج الذي سيخرج منه النقد فعلاً وقت التنفيذ — يُصحّح درجاً أُقفل بعد الطلب. */
  shiftId?: number | null;
  /**
   * **مسحُ الدرج المُجمَّد صراحةً** ليُعاد اشتقاق المصدر لحظة التنفيذ (درجٌ مفتوح، وإلّا
   * خزينةُ الفرع للإداريّ). كان `shiftId: null` يُقرأ «بلا توجيه» فيبقى الرقمُ القديم
   * المُقفَل نافذاً ويفشل الاعتماد خارج ساعات الوردية بلا مخرج (Codex، P2). الحذفُ والمسح
   * نيّتان مختلفتان، فلا تُمثَّلان بقيمةٍ واحدة.
   */
  clearShift?: boolean;
  /** مرجع عملية الاسترداد على جهاز الدفع — يُنفَّذ لحظة الاعتماد لا لحظة الطلب. */
  reference?: string | null;
  /** جهاز تنفيذ قبض الفرق غير النقدي وقت الاعتماد. */
  deviceId?: string | null;
}

/** يدمج توجيه النقد فوق حمولة المرتجع المخزَّنة بلا مساسٍ بالمبلغ أو الطريقة أو الأسطر. */
function applyCashRouting(
  payload: SalesReturnControlPayload,
  routing: SalesControlCashRouting | null | undefined,
): SalesReturnControlPayload {
  if (!routing || (routing.shiftId == null && routing.reference == null && !routing.clearShift)) {
    return payload;
  }
  // المسحُ يغلب: `clearShift` يعني «أعِد اشتقاق المصدر الآن» فيُمرَّر `null` صراحةً.
  const nextShiftId = routing.clearShift ? null : routing.shiftId ?? undefined;
  const next: SalesReturnControlPayload = { ...payload };
  if (next.refund) {
    next.refund = {
      ...next.refund,
      ...(nextShiftId !== undefined ? { shiftId: nextShiftId } : {}),
      ...(routing.reference != null ? { reference: routing.reference } : {}),
    };
  }
  if (next.resolution && nextShiftId !== undefined) {
    next.resolution = { ...next.resolution, shiftId: nextShiftId };
  }
  return next;
}

/** يحدّث درج فرق التصحيح لحظة الاعتماد، مع إبقاء المبلغ والطريقة والحمولة المُبصّمة بلا تغيير. */
function applyCorrectionCashRouting(
  payload: SalesReissueControlPayload,
  routing: SalesControlCashRouting | null | undefined,
): SalesReissueControlPayload {
  if (!routing || (routing.shiftId == null && !routing.clearShift)) return payload;
  const nextShiftId = routing.clearShift ? null : routing.shiftId;
  return {
    ...payload,
    ...(payload.additionalPayment?.method === "CASH"
      ? { additionalPayment: { ...payload.additionalPayment, shiftId: nextShiftId } }
      : {}),
    ...(payload.overpayHandling === "CASH_REFUND"
      ? { overpayRefundShiftId: nextShiftId }
      : {}),
  };
}

/**
 * ⭐ مرجع استرداد البطاقة **قرار المُعتمِد لحظة الاعتماد**، لا التزامٌ يُقفَل عند الطالب
 * (مراجعة Codex على PR #988). `cancelSaleInTx` يفرض المرجع إلزامياً لـCARD وحدها؛ دون هذا
 * الدمج يبقى الطالبُ مضطراً لتنفيذ الاسترداد الفعليّ على الجهاز **قبل** أن يبتّ أيّ مراجعٍ في
 * طلب الإلغاء أصلاً — فإن رُفض الطلب أو تعارضت اللقطة، يكون المال قد خرج من حساب المكتبة
 * البنكيّ بلا أثرٍ في الفاتورة أو الدفتر. نظير `applyCashRouting` تماماً؛ لا مساسٍ بطريقة
 * الاسترداد ولا المبلغ — المتغيّر مرجع الجهاز وحده.
 */
function applyCancelCashRouting(
  payload: SalesCancelControlPayload,
  routing: SalesControlCashRouting | null | undefined,
): SalesCancelControlPayload {
  // ⛔ `undefined` (المفتاح غائب) = لم يمسّه المُعتمِد، يبقى مرجع الطلب كما أُرسل. `null` صراحةً
  // = مسحه المُعتمِد عمداً (لا يطابق قسيمة الجهاز) — يُفرَض غيابه فعلياً فيرفضه cancelSaleInTx
  // حتماً لـCARD، لا رجوعٌ صامتٌ لِما أرسله الطالب (مراجعة Codex P1 على PR #997).
  if (!routing || routing.reference === undefined) return payload;
  return { ...payload, reference: routing.reference };
}

/**
 * يحجز قبض فرق التصحيح لمراجعٍ واحد قبل أن يطلب منه النظام تمرير البطاقة. لا قبض هنا ولا
 * إيصال؛ الغرض أن يفشل stale/الصلاحيات أولاً وألا ينفذ مديران العملية الخارجية نفسها.
 */
export async function claimSalesCorrectionPayment(
  requestId: number,
  actor: Actor & { role?: string },
) {
  assertManager(actor);
  return withTx(async (tx) => {
    const request = (
      await tx.select().from(salesControlRequests)
        .where(eq(salesControlRequests.id, requestId)).for("update").limit(1)
    )[0];
    if (!request) throw new TRPCError({ code: "NOT_FOUND", message: appErrorMessage({ what: "تعذّر حجز دفع فرق التعديل", why: "طلب التحكم غير موجود", doThis: "حدّث شاشة الاعتماد واختر طلباً ما زال ظاهراً" }) });
    assertBranch(Number(request.branchId), actor);
    const invoice = (
      await tx.select({ createdBy: invoices.createdBy, invoiceDate: invoices.invoiceDate })
        .from(invoices).where(eq(invoices.id, Number(request.invoiceId))).limit(1)
    )[0];
    if (!invoice) throw new TRPCError({ code: "NOT_FOUND", message: appErrorMessage({ what: "تعذّر حجز دفع فرق التعديل", why: "الفاتورة المرتبطة بالطلب غير موجودة", doThis: "حدّث الشاشة وأبلغ مسؤول النظام برقم الطلب" }) });
    assertReviewerSeparation(
      request,
      invoice.createdBy == null ? null : Number(invoice.createdBy),
      actor,
    );
    if (request.status !== "PENDING") {
      throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({ what: "تعذّر حجز دفع فرق التعديل", why: `الطلب محسوم بالحالة ${request.status}`, doThis: "حدّث شاشة الاعتماد ولا تنفّذ أي عملية على جهاز الدفع" }) });
    }
    if (!["SALES_REISSUE", "SALES_EXCHANGE"].includes(request.requestType)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({ what: "تعذّر حجز عملية الدفع", why: "الطلب ليس تعديل فاتورة أو استبدالاً", doThis: "استخدم زر الاعتماد العادي لهذا النوع من الطلبات" }) });
    }
    if (idempotencyHash(request.payload) !== request.payloadHash) {
      throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({ what: "تعذّر حجز دفع فرق التعديل", why: "بيانات الطلب تغيّرت عن النسخة المحفوظة", doThis: "لا تنفّذ الدفع؛ أعد تحميل الشاشة وأنشئ طلباً جديداً" }) });
    }
    const payload = request.payload as unknown as SalesReissueControlPayload;
    if (!payload.additionalPayment || payload.additionalPayment.method === "CASH") {
      throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({ what: "تعذّر حجز عملية الدفع", why: "طلب التعديل لا يحمل فرقاً غير نقدي", doThis: "اعتمد الطلب مباشرةً، أو صحّح طريقة دفع الفرق في طلب التعديل" }) });
    }
    const live = await loadInvoiceControlSnapshotTx(tx, Number(request.invoiceId));
    if (live.hash !== request.snapshotHash) {
      await markStaleTx(tx, requestId, actor.userId, "تغيّرت الفاتورة قبل حجز عملية الدفع");
      return { claimed: false as const, stale: true as const };
    }
    await assertPeriodOpen(tx, invoice.invoiceDate);
    await tx.insert(idempotencyKeys).values({
      operation: CORRECTION_PAYMENT_REVIEWER_LOCK_OPERATION,
      clientRequestId: String(actor.userId),
      refId: requestId,
      payloadHash: request.payloadHash,
    }).onDuplicateKeyUpdate({ set: { id: sql`${idempotencyKeys.id}` } });
    const reviewerLock = await loadCorrectionPaymentReviewerLockTx(tx, actor.userId);
    if (
      !reviewerLock
      || Number(reviewerLock.refId) !== requestId
      || reviewerLock.payloadHash !== request.payloadHash
    ) {
      return {
        claimed: false as const,
        stale: false as const,
        blockedByRequestId: Number(reviewerLock?.refId ?? 0),
      };
    }
    const existing = await loadCorrectionPaymentClaimTx(tx, requestId);
    if (existing) {
      if (Number(existing.refId) !== Number(actor.userId) || existing.payloadHash !== request.payloadHash) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر حجز عملية دفع فرق التعديل",
            why: `الطلب محجوز لمراجع آخر (رقم ${Number(existing.refId)}) كي لا تُمرّر البطاقة مرتين`,
            doThis: "اترك الطلب للمراجع الذي حجزه، أو اطلب منه تحرير الحجز قبل تنفيذ أي عملية على الجهاز",
          }),
        });
      }
      return { claimed: true as const, replayed: true as const };
    }
    await tx.insert(idempotencyKeys).values({
      operation: CORRECTION_PAYMENT_CLAIM_OPERATION,
      clientRequestId: String(requestId),
      refId: actor.userId,
      payloadHash: request.payloadHash,
    });
    return { claimed: true as const, replayed: false as const };
  }, { gate: "NONE" });
}

/** يحرر حجزاً لم يبدأ قبضه بعد؛ وجود دليل CONFIRMED يجعل التحرير محظوراً منعاً لضياع المال. */
export async function releaseSalesCorrectionPaymentClaim(
  requestId: number,
  actor: Actor & { role?: string },
  confirmation: "NO_EXTERNAL_PAYMENT_EXECUTED",
) {
  assertManager(actor);
  return withTx(async (tx) => {
    const request = (
      await tx.select().from(salesControlRequests)
        .where(eq(salesControlRequests.id, requestId)).for("update").limit(1)
    )[0];
    if (!request) throw new TRPCError({ code: "NOT_FOUND", message: appErrorMessage({ what: "تعذّر تحرير حجز الدفع", why: "طلب التحكم غير موجود", doThis: "حدّث شاشة الاعتماد" }) });
    assertBranch(Number(request.branchId), actor);
    const claim = await loadCorrectionPaymentClaimTx(tx, requestId);
    if (!claim) return { released: true as const, replayed: true as const };
    if (Number(claim.refId) !== Number(actor.userId)) {
      throw new TRPCError({ code: "FORBIDDEN", message: appErrorMessage({ what: "تعذّر تحرير حجز الدفع", why: "الحجز باسم مراجع آخر", doThis: "اطلب من المراجع الظاهر في الطلب تحريره من حسابه" }) });
    }
    if (confirmation !== "NO_EXTERNAL_PAYMENT_EXECUTED") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "تعذّر تحرير حجز دفع فرق التعديل",
          why: "لم يصل إقرار صريح بأن العملية لم تُنفذ على جهاز الدفع",
          doThis: "تحقق من الجهاز أولاً؛ إن لم تُنفذ العملية فأعد التحرير مع الإقرار الظاهر",
        }),
      });
    }
    if (await hasDurableCorrectionPaymentTx(tx, requestId)) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "تعذّر تحرير حجز دفع فرق التعديل",
          why: "للعملية دليل قبض مؤكد لم يُربط بعد بفاتورة وإيصال",
          doThis: "لا تمرّر البطاقة ثانيةً؛ أعد اعتماد الطلب بالمرجع نفسه أو عالج الإثبات مع المدير المالي",
        }),
      });
    }
    await clearCorrectionPaymentClaimsTx(tx, requestId, Number(claim.refId));
    await tx.insert(auditLogs).values({
      userId: actor.userId,
      branchId: Number(request.branchId),
      action: "sales.correctionPaymentClaim.released",
      entityType: "salesControlRequest",
      entityId: String(requestId),
      oldValue: { reviewerId: Number(claim.refId), state: "CLAIMED" },
      newValue: { state: "RELEASED", confirmation },
    });
    return { released: true as const, replayed: false as const };
  }, { gate: "NONE" });
}

/**
 * يثبت دليل قبض فرق البطاقة في التزام مستقل قبل معاملة التصحيح. هذا ليس أثراً دفترياً:
 * الإيصال والقيد والفاتورة لا تُنشأ إلا في المعاملة التالية، لكن الدليل يبقى CONFIRMED عند
 * فشلها لأن العملية على جهاز الدفع الخارجي لا يستطيع ROLLBACK إلغاءها. requestId الحتمي
 * يعيد الدليل نفسه في المحاولة التالية بدلاً من تمرير البطاقة مرتين.
 */
async function prepareCorrectionExternalPaymentAttempt(
  requestId: number,
  actor: Actor & { role?: string },
  cashRouting?: SalesControlCashRouting | null,
) {
  return withTx(async (tx) => {
    const request = (
      await tx.select().from(salesControlRequests)
        .where(eq(salesControlRequests.id, requestId)).for("update").limit(1)
    )[0];
    if (!request) throw new TRPCError({ code: "NOT_FOUND", message: appErrorMessage({ what: "تعذّر حفظ إثبات دفع فرق التعديل", why: "طلب التحكم غير موجود", doThis: "لا تمرّر البطاقة؛ حدّث شاشة الاعتماد" }) });
    assertBranch(Number(request.branchId), actor);
    const currentInvoice = (
      await tx.select({ createdBy: invoices.createdBy })
        .from(invoices).where(eq(invoices.id, Number(request.invoiceId))).limit(1)
    )[0];
    if (!currentInvoice) throw new TRPCError({ code: "NOT_FOUND", message: appErrorMessage({ what: "تعذّر حفظ إثبات دفع فرق التعديل", why: "الفاتورة المرتبطة بالطلب غير موجودة", doThis: "لا تمرّر البطاقة وأبلغ مسؤول النظام برقم الطلب" }) });
    assertReviewerSeparation(
      request,
      currentInvoice.createdBy == null ? null : Number(currentInvoice.createdBy),
      actor,
    );
    if (request.status === "APPROVED") return null;
    if (request.status !== "PENDING") {
      throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({ what: "تعذّر حفظ إثبات دفع فرق التعديل", why: `الطلب محسوم بالحالة ${request.status}`, doThis: "لا تمرّر البطاقة وحدّث شاشة الاعتماد" }) });
    }
    if (!["SALES_REISSUE", "SALES_EXCHANGE"].includes(request.requestType)) return null;
    if (idempotencyHash(request.payload) !== request.payloadHash) {
      throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({ what: "تعذّر حفظ إثبات دفع فرق التعديل", why: "بيانات الطلب لا تطابق بصمتها المحفوظة", doThis: "لا تمرّر البطاقة؛ حدّث الشاشة وأنشئ طلباً جديداً" }) });
    }
    const payload = request.payload as unknown as SalesReissueControlPayload;
    const additional = payload.additionalPayment;
    if (!additional || additional.method === "CASH") return null;
    const claim = await loadCorrectionPaymentClaimTx(tx, requestId);
    if (!claim || Number(claim.refId) !== Number(actor.userId) || claim.payloadHash !== request.payloadHash) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "تعذّر اعتماد دفع فرق التعديل",
          why: "عملية الدفع لم تُحجز لهذا المراجع قبل تنفيذها على الجهاز",
          doThis: "لا تمرّر البطاقة الآن؛ اضغط حقل مرجع الدفع لحجز الطلب أولاً ثم اتبع التعليمات",
        }),
      });
    }
    const reference = cashRouting?.reference?.trim() ?? "";
    const deviceId = cashRouting?.deviceId?.trim() ?? "";
    if (!reference || !deviceId) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "تعذّر اعتماد تعديل الفاتورة",
          why: "فرق التعديل غير نقدي ولم يُرفق بمرجع العملية وهوية جهاز المراجع",
          doThis: "نفّذ المبلغ الظاهر على جهاز الدفع، ثم أدخل مرجع القسيمة واضغط اعتماد مرة واحدة",
        }),
      });
    }
    return createConfirmedExternalPaymentAttemptTx(tx, {
      branchId: Number(request.branchId),
      channel: "SALES_COLLECTION",
      method: additional.method,
      amount: additional.amount,
      reference,
      requestId: correctionPaymentAttemptRequestId(requestId),
      deviceId,
    }, { ...actor, branchId: Number(request.branchId) });
  });
}

export async function approveSalesControlRequest(
  requestId: number,
  actor: Actor & { role?: string },
  reviewNote?: string | null,
  cashRouting?: SalesControlCashRouting | null,
) {
  assertManager(actor);
  const note = reviewNote?.trim() || null;
  if (note && note.length > 500) {
    throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({ what: "تعذّر اعتماد الطلب", why: "ملاحظة الاعتماد أطول من 500 محرف", doThis: "اختصر الملاحظة ثم أعد الاعتماد" }) });
  }
  const preparedExternalAttempt = await prepareCorrectionExternalPaymentAttempt(
    requestId,
    actor,
    cashRouting,
  );
  const executeApproval = () => withTx(async (tx) => {
    const request = (
      await tx.select().from(salesControlRequests)
        .where(eq(salesControlRequests.id, requestId)).for("update").limit(1)
    )[0];
    if (!request) throw new TRPCError({ code: "NOT_FOUND", message: "طلب التحكم غير موجود" });
    assertBranch(Number(request.branchId), actor);
    const currentInvoice = (
      await tx.select({ createdBy: invoices.createdBy })
        .from(invoices).where(eq(invoices.id, Number(request.invoiceId))).limit(1)
    )[0];
    if (!currentInvoice) throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة غير موجودة" });
    assertReviewerSeparation(
      request,
      currentInvoice.createdBy == null ? null : Number(currentInvoice.createdBy),
      actor,
    );
    if (request.status === "APPROVED") {
      return { request, replayed: true as const };
    }
    if (request.status !== "PENDING") {
      throw new TRPCError({ code: "CONFLICT", message: `الطلب محسوم بالحالة ${request.status}` });
    }

    const legacyPending = (
      await tx.select({ id: returnRequests.id }).from(returnRequests).where(and(
        eq(returnRequests.invoiceId, Number(request.invoiceId)),
        eq(returnRequests.status, "PENDING_APPROVAL"),
      )).limit(1)
    )[0];
    if (legacyPending) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `يوجد طلب إرجاع قديم معلّق (#${legacyPending.id}) — احسمه قبل اعتماد هذا الطلب`,
      });
    }

    const live = await loadInvoiceControlSnapshotTx(tx, Number(request.invoiceId));
    if (live.hash !== request.snapshotHash) {
      await markStaleTx(tx, requestId, actor.userId, "تغيّرت الفاتورة بعد فتح الطلب");
      await clearCorrectionPaymentClaimsTx(tx, requestId, actor.userId);
      return { stale: true as const };
    }
    const storedSnapshot = request.invoiceSnapshot as unknown as InvoiceControlSnapshot;
    if (idempotencyHash(storedSnapshot) !== request.snapshotHash) {
      throw new TRPCError({ code: "CONFLICT", message: "لقطة الطلب لا تطابق بصمتها المحفوظة" });
    }
    if (idempotencyHash(request.payload) !== request.payloadHash) {
      throw new TRPCError({ code: "CONFLICT", message: "حمولة الطلب لا تطابق بصمتها المحفوظة" });
    }

    const effectiveActor = { ...actor, branchId: Number(request.branchId) };
    let effect: unknown;
    let resultInvoiceId: number | null = null;
    let exchangeCommandId: number | null = null;
    if (request.requestType === "SALES_DUE_DATE_CHANGE") {
      const payload = request.payload as unknown as SalesDueDateChangeControlPayload;
      const dueDate = normalizeDueDatePayload(payload);
      const lockedInvoice = (
        await tx.select().from(invoices)
          .where(eq(invoices.id, Number(request.invoiceId)))
          .for("update")
          .limit(1)
      )[0];
      if (!lockedInvoice) throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة غير موجودة" });
      await assertLockedInvoiceControlSnapshotTx(tx, lockedInvoice, storedSnapshot);
      await assertPeriodOpen(tx, lockedInvoice.invoiceDate);
      await tx.update(invoices).set({
        dueDate: dueDate ? new Date(`${dueDate}T00:00:00.000Z`) : null,
      }).where(eq(invoices.id, Number(request.invoiceId)));
      effect = {
        invoiceId: Number(request.invoiceId),
        oldDueDate: storedSnapshot.header.dueDate,
        dueDate,
      };
      resultInvoiceId = Number(request.invoiceId);
    } else if (request.requestType === "SALES_RETURN") {
      effect = await returnSaleInTx(tx, {
        // توجيه النقد يُدمَج هنا — بعد التحقّق من `payloadHash` أعلاه (فهو يُطابق الحمولة
        // **المخزَّنة** لا المُنفَّذة) وقبل أوّل أثر. المبلغ والطريقة والأسطر كما أُقرّت.
        ...applyCashRouting(request.payload as unknown as SalesReturnControlPayload, cashRouting),
        invoiceId: Number(request.invoiceId),
        clientRequestId: `sales-control-${requestId}`,
        controlExpectedSnapshot: storedSnapshot,
      }, effectiveActor);
      resultInvoiceId = Number(request.invoiceId);
    } else if (request.requestType === "SALES_CANCEL") {
      effect = await cancelSaleInTx(tx, {
        // توجيه المرجع يُدمَج هنا — بعد التحقّق من `payloadHash` أعلاه وقبل أوّل أثر، تماماً
        // كما يُدمَج توجيه النقد للمرتجع. طريقة الاسترداد والمبلغ كما أُقرّا في الطلب.
        ...applyCancelCashRouting(request.payload as unknown as SalesCancelControlPayload, cashRouting),
        invoiceId: Number(request.invoiceId),
        reason: request.reason,
        clientRequestId: `sales-control-${requestId}`,
        controlExpectedSnapshot: storedSnapshot,
      }, effectiveActor);
      resultInvoiceId = Number(request.invoiceId);
    } else {
      const payload = request.payload as unknown as SalesReissueControlPayload;
      let routedPayload = applyCorrectionCashRouting(payload, cashRouting);
      const additional = routedPayload.additionalPayment;
      if (additional && additional.method !== "CASH") {
        if (!preparedExternalAttempt) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: appErrorMessage({
              what: "تعذّر اعتماد تعديل الفاتورة",
              why: "لم يُعثر على دليل قبض فرق التعديل المؤكد",
              doThis: "لا تمرّر البطاقة ثانيةً؛ حدّث الطلب وأدخل مرجع القسيمة نفسها ثم أعد الاعتماد",
            }),
          });
        }
        routedPayload = {
          ...routedPayload,
          additionalPayment: {
            ...additional,
            reference: preparedExternalAttempt.externalReference,
            externalPaymentAttemptId: Number(preparedExternalAttempt.id),
            externalPaymentDeviceId: preparedExternalAttempt.deviceId,
          },
        };
      }
      const corrected = await correctSaleInTx(tx, {
        ...routedPayload,
        originalInvoiceId: Number(request.invoiceId),
        clientRequestId: `sales-control-${requestId}`,
        creditApproved: true,
        // مُصدر قرار الائتمان = المعتمِد (actor.userId)؛ المستهلك = طالب الطلب (request.requestedBy).
        // `assertReviewerSeparation` فوق تضمن actor ≠ requestedBy — الفصل حقيقيّ لا شكلي.
        managerOverrideByUserId: Number(request.requestedBy),
        priceOverrideApproved: true,
        controlExpectedSnapshot: storedSnapshot,
      }, effectiveActor);
      effect = corrected;
      resultInvoiceId = corrected.correctedInvoiceId;
      if (request.requestType === "SALES_EXCHANGE") {
        exchangeCommandId = await recordExchangeTx(
          tx,
          request,
          storedSnapshot,
          corrected,
          routedPayload,
          actor,
        );
      }
    }

    const reviewedAt = new Date();
    const updated = await tx.update(salesControlRequests).set({
      status: "APPROVED",
      reviewedBy: actor.userId,
      reviewedAt,
      reviewNote: note,
      resultInvoiceId,
      appliedAt: reviewedAt,
    }).where(and(
      eq(salesControlRequests.id, requestId),
      eq(salesControlRequests.status, "PENDING"),
    ));
    if (extractAffectedRows(updated) !== 1) {
      throw new TRPCError({ code: "CONFLICT", message: "تغيّرت حالة الطلب أثناء الاعتماد" });
    }
    await clearCorrectionPaymentClaimsTx(tx, requestId, actor.userId);
    return {
      request: { ...request, status: "APPROVED" as const, resultInvoiceId },
      effect,
      exchangeCommandId,
      replayed: false as const,
    };
  });
  let result: Awaited<ReturnType<typeof executeApproval>>;
  try {
    result = await executeApproval();
  } catch (cause) {
    if (!preparedExternalAttempt) throw cause;
    await withTx(async (tx) => {
      const request = (
        await tx.select().from(salesControlRequests)
          .where(eq(salesControlRequests.id, requestId)).for("update").limit(1)
      )[0];
      if (!request || request.status !== "PENDING") return;
      await markStaleTx(
        tx,
        requestId,
        actor.userId,
        "حُفظ دليل قبض فرق التعديل لكن تعذّر ترحيل التصحيح؛ يلزم طلب بديل بالمرجع نفسه",
      );
      await clearCorrectionPaymentClaimsTx(tx, requestId, actor.userId);
    }, { gate: "NONE" });
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: "حُفظ قبض فرق التعديل ولم تُعدّل الفاتورة",
        why: cause instanceof Error ? cause.message : "فشل أحد حرّاس الترحيل بعد إثبات عملية جهاز الدفع",
        doThis: `لا تمرّر البطاقة ثانيةً؛ افتح طلب تعديل جديداً صالحاً وأدخل المرجع «${preparedExternalAttempt.externalReference}» ليُستهلك الإثبات المحفوظ، وإن تغيّر المبلغ فأحِل المرجع للمدير المالي لمعالجة الاسترداد`,
      }),
      cause,
    });
  }
  if ("stale" in result) {
    throw new TRPCError({
      code: "CONFLICT",
      message: preparedExternalAttempt
        ? appErrorMessage({
            what: "حُفظ قبض فرق التعديل ولم تُعدّل الفاتورة",
            why: "تغيّرت الفاتورة بعد حجز الدفع، فحُفظ إثبات الجهاز وأُغلق الطلب القديم من دون أي ترحيل جزئي",
            doThis: `لا تمرّر البطاقة ثانيةً؛ افتح طلب تعديل جديداً وأدخل المرجع «${preparedExternalAttempt.externalReference}» ليُعاد استعمال الإثبات المحفوظ`,
          })
        : "تغيّرت الفاتورة منذ الطلب؛ وُسم الطلب قديماً وافتح طلباً جديداً",
    });
  }
  return result;
}

export async function rejectSalesControlRequest(
  requestId: number,
  reason: string,
  actor: Actor & { role?: string },
) {
  assertManager(actor);
  const note = normalizeReason(reason, "الرفض");
  return withTx(async (tx) => {
    const request = (
      await tx.select().from(salesControlRequests)
        .where(eq(salesControlRequests.id, requestId)).for("update").limit(1)
    )[0];
    if (!request) throw new TRPCError({ code: "NOT_FOUND", message: "طلب التحكم غير موجود" });
    assertBranch(Number(request.branchId), actor);
    const invoice = (
      await tx.select({ createdBy: invoices.createdBy }).from(invoices)
        .where(eq(invoices.id, Number(request.invoiceId))).limit(1)
    )[0];
    if (!invoice) throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة غير موجودة" });
    assertReviewerSeparation(
      request,
      invoice.createdBy == null ? null : Number(invoice.createdBy),
      actor,
    );
    if (request.status === "REJECTED" && request.reviewNote === note) {
      return { request, replayed: true as const };
    }
    if (request.status !== "PENDING") {
      throw new TRPCError({ code: "CONFLICT", message: `الطلب محسوم بالحالة ${request.status}` });
    }
    await assertCorrectionPaymentNotClaimedTx(tx, requestId, "رفض");
    const reviewedAt = new Date();
    await tx.update(salesControlRequests).set({
      status: "REJECTED",
      reviewedBy: actor.userId,
      reviewedAt,
      reviewNote: note,
    }).where(eq(salesControlRequests.id, requestId));
    return {
      request: { ...request, status: "REJECTED" as const, reviewedBy: actor.userId, reviewedAt, reviewNote: note },
      replayed: false as const,
    };
  }, { gate: "NONE" });
}

/**
 * ⭐ **سحبُ الطالب لطلبه** — مخرجُ الطريق المسدود (تدقيق ١/٩/٢٦، هجرة 0326).
 *
 * `assertReviewerSeparation` يحجب الطالبَ ومنشئَ الفاتورة عن **الاعتماد والرفض معاً**.
 * فحين يكون الطالبُ هو المديرَ الوحيد (و`returns.create` محصورٌ بمديرٍ فأعلى ⇒ الطالبُ مديرٌ
 * دائماً)، أو حين يبيع المالكُ بحسابه فيصير منشئَ الفاتورة، **لا يبقى في النظام أحدٌ يستطيع
 * حسم الطلب**. ومع الفهرس الفريد على `activeInvoiceId` تُقفَل الفاتورة ضدّ كلّ عمليات التحكّم
 * (مرتجع · إلغاء · تصحيح · استبدال · استحقاق) إلى الأبد — يلزمها تدخّلٌ مباشرٌ في القاعدة.
 *
 * **ولماذا لا يخرق هذا فصل المهام:** Maker-Checker يحرس **حركة المال**. والسحبُ لا يُحرّك
 * ديناراً ولا قطعةً — أثرُه الوحيد إخراجُ `status` من PENDING فيصير `activeInvoiceId` بـNULL
 * وتتحرّر الفاتورة. وهو **تراجعُ صاحب الاقتراح عن اقتراحه**، لا مراجعةٌ له. الاعتماد يبقى
 * محكوماً بمراجعٍ مستقلٍّ كما هو — لم يُمَسّ حرفٌ منه.
 *
 * ⛔ الطالبُ وحده يسحب. مديرٌ آخر يريد الإغلاق مسارُه `reject` بسببٍ موثَّق.
 */
export async function withdrawSalesControlRequest(
  requestId: number,
  reason: string,
  actor: Actor & { role?: string },
) {
  const note = normalizeReason(reason, "السحب");
  return withTx(async (tx) => {
    const request = (
      await tx.select().from(salesControlRequests)
        .where(eq(salesControlRequests.id, requestId)).for("update").limit(1)
    )[0];
    if (!request) throw new TRPCError({ code: "NOT_FOUND", message: "طلب التحكم غير موجود" });
    if (Number(request.requestedBy) !== Number(actor.userId)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "السحب لصاحب الطلب وحده — إغلاقُ طلب غيرك يكون بالرفض من مراجعٍ مؤهَّل",
      });
    }
    // تكرارُ السحب بنفس السبب يُعاد تشغيله بلا خطأ (نمط `reject`).
    if (request.status === "WITHDRAWN" && request.reviewNote === note) {
      return { request, replayed: true as const };
    }
    if (request.status !== "PENDING") {
      throw new TRPCError({ code: "CONFLICT", message: `الطلب محسوم بالحالة ${request.status}` });
    }
    await assertCorrectionPaymentNotClaimedTx(tx, requestId, "سحب");
    const reviewedAt = new Date();
    await tx.update(salesControlRequests).set({
      status: "WITHDRAWN",
      // `reviewedBy` = الساحب = الطالب. يستثنيه `chk_sales_control_maker_checker` للحالة
      // WITHDRAWN وحدها (هجرة 0326)، ويبقى مُلزِماً على APPROVED/REJECTED.
      reviewedBy: actor.userId,
      reviewedAt,
      reviewNote: note,
    }).where(and(
      eq(salesControlRequests.id, requestId),
      eq(salesControlRequests.status, "PENDING"),
    ));
    return {
      request: { ...request, status: "WITHDRAWN" as const, reviewedBy: actor.userId, reviewedAt, reviewNote: note },
      replayed: false as const,
    };
  }, { gate: "NONE" });
}

export async function listSalesControlRequests(
  actor: Actor & { role?: string },
  options?: {
    status?: "PENDING" | "APPROVED" | "REJECTED" | "STALE" | "WITHDRAWN";
    mine?: boolean;
    /**
     * ترتيبُ الإرجاع قبل القصّ (300). الافتراضُ الأحدث أوّلاً (الشاشة)؛ وصندوق القرارات يطلب
     * `ASC` — الأقدم أوّلاً — لأنّ القصّ بالأحدث يُسقط أكثرَ الطلبات تأخّراً بالضبط حين يكثر
     * المعلَّق (Codex على #1004).
     */
    order?: "ASC" | "DESC";
  },
) {
  const db = requireDb();
  const mineOnly = options?.mine === true || (actor.role !== "admin" && actor.role !== "manager");
  const where = and(
    options?.status ? eq(salesControlRequests.status, options.status) : undefined,
    actor.role === "admin" ? undefined : eq(salesControlRequests.branchId, actor.branchId),
    mineOnly ? eq(salesControlRequests.requestedBy, actor.userId) : undefined,
  );
  return db.select({
    ...getTableColumns(salesControlRequests),
    invoiceNumber: invoices.invoiceNumber,
    invoiceStatus: invoices.status,
    invoiceTotal: invoices.total,
    invoiceCreatedBy: invoices.createdBy,
    invoiceCreatedByName: invoiceCreator.name,
    requestedByName: users.name,
    reviewedByName: controlReviewer.name,
    resultInvoiceNumber: resultInvoice.invoiceNumber,
    resultInvoiceDate: resultInvoice.invoiceDate,
  }).from(salesControlRequests)
    .innerJoin(invoices, eq(invoices.id, salesControlRequests.invoiceId))
    .innerJoin(users, eq(users.id, salesControlRequests.requestedBy))
    .leftJoin(invoiceCreator, eq(invoiceCreator.id, invoices.createdBy))
    .leftJoin(controlReviewer, eq(controlReviewer.id, salesControlRequests.reviewedBy))
    .leftJoin(resultInvoice, eq(resultInvoice.id, salesControlRequests.resultInvoiceId))
    .where(where)
    .orderBy(options?.order === "ASC" ? asc(salesControlRequests.id) : desc(salesControlRequests.id))
    .limit(300);
}

export async function getSalesControlRequest(
  requestId: number,
  actor: Actor & { role?: string },
) {
  const db = requireDb();
  const request = (
    await db.select().from(salesControlRequests)
      .where(eq(salesControlRequests.id, requestId)).limit(1)
  )[0];
  if (!request) throw new TRPCError({ code: "NOT_FOUND", message: "طلب التحكم غير موجود" });
  assertBranch(Number(request.branchId), actor);
  if (actor.role !== "admin" && actor.role !== "manager" && Number(request.requestedBy) !== actor.userId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا تملك صلاحية عرض هذا الطلب" });
  }
  return request;
}
