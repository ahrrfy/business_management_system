import { TRPCError } from "@trpc/server";
import { and, desc, eq, getTableColumns } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import {
  invoices,
  returnRequests,
  salesControlRequests,
  salesExchangeCommands,
  users,
} from "../../../drizzle/schema";
import { isDeadInvoiceStatus } from "@shared/invoiceStatus";
import type { SalesControlType } from "@shared/salesControl";
import type { Tx } from "../../db";
import { isDupEntry } from "@shared/errorMap.ar";
import { extractAffectedRows, extractInsertId } from "../../lib/insertId";
import { idempotencyHash } from "../idempotency";
import { money, round2 } from "../money";
import { assertPeriodOpen } from "../periodLockService";
import type { ReturnSaleInput } from "../returnService";
import { returnSaleInTx } from "../returnService";
import { requireDb, type Actor, withTx } from "../tx";
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

const invoiceCreator = alias(users, "salesControlInvoiceCreator");

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
    && row.payloadHash === payloadHash
    && Number(row.requestedBy) === Number(actor.userId);
}

/** ينشئ مستند نيّة فقط: لا قيد ولا إيصال ولا حركة مخزون ولا تغيير فاتورة. */
export async function requestSalesControl(
  input: RequestSalesControlInput,
  actor: Actor & { role?: string },
) {
  const requestKey = normalizeRequestKey(input.requestKey);
  const reason = normalizeReason(input.reason);
  const payloadHash = idempotencyHash(input.payload);
  return withTx(async (tx) => {
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
    if (invoice.sourceType === "WORKORDER") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "فاتورة أمر الشغل تُعالج من مسار عكس التسليم الخاص بأمر الشغل",
      });
    }
    if (isDeadInvoiceStatus(invoice.status)) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "الفاتورة نهائية ولا تقبل طلب تحكم جديداً" });
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
  const outstanding = round2(
    money(replacement.total).minus(money(replacement.paidAmount)).minus(money(replacement.returnedTotal ?? "0")),
  );
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
export async function approveSalesControlRequest(
  requestId: number,
  actor: Actor & { role?: string },
  reviewNote?: string | null,
) {
  assertManager(actor);
  const note = reviewNote?.trim() || null;
  if (note && note.length > 500) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "ملاحظة الاعتماد أطول من 500 محرف" });
  }
  const result = await withTx(async (tx) => {
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
        ...(request.payload as unknown as SalesReturnControlPayload),
        invoiceId: Number(request.invoiceId),
        clientRequestId: `sales-control-${requestId}`,
        controlExpectedSnapshot: storedSnapshot,
      }, effectiveActor);
      resultInvoiceId = Number(request.invoiceId);
    } else if (request.requestType === "SALES_CANCEL") {
      effect = await cancelSaleInTx(tx, {
        ...(request.payload as unknown as SalesCancelControlPayload),
        invoiceId: Number(request.invoiceId),
        reason: request.reason,
        clientRequestId: `sales-control-${requestId}`,
        controlExpectedSnapshot: storedSnapshot,
      }, effectiveActor);
      resultInvoiceId = Number(request.invoiceId);
    } else {
      const payload = request.payload as unknown as SalesReissueControlPayload;
      const corrected = await correctSaleInTx(tx, {
        ...payload,
        originalInvoiceId: Number(request.invoiceId),
        clientRequestId: `sales-control-${requestId}`,
        creditApproved: true,
        managerOverrideByUserId: actor.userId,
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
          payload,
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
    return {
      request: { ...request, status: "APPROVED" as const, resultInvoiceId },
      effect,
      exchangeCommandId,
      replayed: false as const,
    };
  });
  if ("stale" in result) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "تغيّرت الفاتورة منذ الطلب؛ وُسم الطلب قديماً وافتح طلباً جديداً",
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

export async function listSalesControlRequests(
  actor: Actor & { role?: string },
  options?: { status?: "PENDING" | "APPROVED" | "REJECTED" | "STALE"; mine?: boolean },
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
  }).from(salesControlRequests)
    .innerJoin(invoices, eq(invoices.id, salesControlRequests.invoiceId))
    .innerJoin(users, eq(users.id, salesControlRequests.requestedBy))
    .leftJoin(invoiceCreator, eq(invoiceCreator.id, invoices.createdBy))
    .where(where)
    .orderBy(desc(salesControlRequests.id))
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
