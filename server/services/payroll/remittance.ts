import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  branches,
  payrollAccountingEvents,
  payrollObligationAllocations,
  payrollObligations,
  payrollRemittanceRequests,
  receipts,
  users,
} from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { assertValidImageDataUrl, parseImageDimensions } from "../../lib/imageValidation";
import { isDupEntry } from "@shared/errorMap.ar";
import {
  assertApprovedTreasuryOutAvailable,
  authorizeExternalTreasuryDisbursement,
} from "../cash/cashAvailability";
import { baghdadToday } from "../businessDay";
import { money, round2, toDateStr, toDbMoney } from "../money";
import { requireDb, type Actor, withTx } from "../tx";
import {
  payrollSettlementPosting,
  postPayrollAccountingEvent,
} from "./accounting";
import { payrollHash } from "./helpers";
import type {
  CreatePayrollRemittanceInput,
  PayrollPaymentMethod,
  PayrollRemittanceKind,
  PayrollRemittancePaymentInput,
} from "./types";

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function obligationKind(kind: PayrollRemittanceKind) {
  return kind === "INCOME_TAX" ? "INCOME_TAX" : "SOCIAL_SECURITY";
}

export function assertValidRemittanceDocument(value: string): void {
  // Evidence is stored inline today, so accept only raster image data URLs with
  // canonical base64, a matching magic signature, bounded bytes and dimensions.
  // This excludes javascript:, HTML/SVG payloads and remote mutable documents.
  assertValidImageDataUrl(value.trim(), 2_000_000, true);
  const normalized = value.trim();
  const comma = normalized.indexOf(",");
  const mime = normalized.slice(5, normalized.indexOf(";"));
  const dimensions = parseImageDimensions(Buffer.from(normalized.slice(comma + 1), "base64"), mime);
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "The remittance evidence is not a complete readable image." });
  }
}

function paymentDate(value?: string | null): string {
  const ymd = value?.trim() || baghdadToday();
  const parsed = Date.parse(`${ymd}T00:00:00Z`);
  if (
    !YMD_RE.test(ymd) ||
    Number.isNaN(parsed) ||
    new Date(parsed).toISOString().slice(0, 10) !== ymd
  ) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "تاريخ التحويل غير صالح." });
  }
  if (ymd > baghdadToday()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "تاريخ التحويل لا يكون مستقبلياً." });
  }
  return ymd;
}

export function payrollRemittancePaymentReference(
  method: PayrollPaymentMethod,
  reference: string | null | undefined,
): string | null {
  const normalized = reference?.trim() || null;
  if (method === "CASH") return null;
  if (method === "CARD" && !/^\d{4}$/.test(normalized ?? "")) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Card evidence must be exactly the last four digits.",
    });
  }
  if ((method === "TRANSFER" || method === "WALLET") && !normalized) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "رقم مرجع التحويل/البطاقة/المحفظة مطلوب.",
    });
  }
  return normalized;
}

async function assertOwner(
  tx: Parameters<Parameters<typeof withTx>[0]>[0],
  actor: Actor,
  forbidden: Array<number | null | undefined>,
  operation: string,
): Promise<void> {
  const [owner] = await tx
    .select({ id: users.id, isOwner: users.isOwner, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, actor.userId))
    .for("share")
    .limit(1);
  if (!owner?.isActive || !owner.isOwner) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `${operation}: الاعتماد محصور بمالك نشط.`,
    });
  }
  if (
    forbidden
      .filter((value): value is number => value != null)
      .map(Number)
      .includes(Number(owner.id))
  ) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `${operation}: لا يجوز لصانع الطلب اعتماد تنفيذه.`,
    });
  }
}

function sameRequest(
  row: typeof payrollRemittanceRequests.$inferSelect,
  input: CreatePayrollRemittanceInput,
): boolean {
  return (
    row.kind === input.kind &&
    Number(row.payingBranchId) === input.payingBranchId &&
    money(row.requestedAmount).eq(money(input.amount)) &&
    row.authorityName === input.authorityName.trim() &&
    row.referenceNumber === input.referenceNumber.trim() &&
    row.supportingDocumentUrl === input.supportingDocumentUrl
  );
}

async function existingBySourceKey(sourceKey: string) {
  const [row] = await requireDb()
    .select()
    .from(payrollRemittanceRequests)
    .where(eq(payrollRemittanceRequests.sourceKey, sourceKey))
    .limit(1);
  return row ?? null;
}

export async function createRemittanceRequest(
  input: CreatePayrollRemittanceInput,
  actor: Actor,
) {
  assertValidRemittanceDocument(input.supportingDocumentUrl);
  if (!actor.isOwner && actor.role !== "admin" && Number(actor.branchId) !== input.payingBranchId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "لا يجوز إنشاء تحويل قانوني على فرع آخر.",
    });
  }
  const amount = round2(money(input.amount));
  if (amount.lte(0)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "مبلغ التحويل يجب أن يكون موجباً." });
  }
  const authorityName = input.authorityName.trim();
  const referenceNumber = input.referenceNumber.trim();
  if (!authorityName || !referenceNumber || !input.supportingDocumentUrl.trim()) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "الجهة والمرجع والمستند المؤيد مطلوبة للتحويل القانوني.",
    });
  }
  const sourceKey = `PAYROLL:REMIT-REQ:${input.clientRequestId.trim()}`;
  const replay = await existingBySourceKey(sourceKey);
  if (replay) {
    if (!sameRequest(replay, input)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "مفتاح الطلب مستعمل لتحويل قانوني مختلف.",
      });
    }
    return { ...replay, replayed: true };
  }
  try {
    return await withTx(async (tx) => {
      const [branch] = await tx
        .select({ id: branches.id })
        .from(branches)
        .where(eq(branches.id, input.payingBranchId))
        .for("update")
        .limit(1);
      if (!branch) throw new TRPCError({ code: "NOT_FOUND", message: "الفرع غير موجود." });
      // The branch lock serializes all reservations for this liability grain.
      // Re-read the idempotency key as a current locking read after waiting: a
      // concurrent first request may have committed while this transaction was
      // queued, and reservation arithmetic must not turn that retry into an error.
      const [lockedReplay] = await tx
        .select()
        .from(payrollRemittanceRequests)
        .where(eq(payrollRemittanceRequests.sourceKey, sourceKey))
        .for("update")
        .limit(1);
      if (lockedReplay) {
        if (!sameRequest(lockedReplay, input)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "مفتاح الطلب مستعمل لتحويل قانوني مختلف.",
          });
        }
        return { ...lockedReplay, replayed: true };
      }
      // Global lock order for remittances is request rows, then obligation rows.
      // payRemittanceRequest uses the same order; reversing it here deadlocked a
      // concurrent create (obligation -> request) against pay (request -> obligation).
      const reservations = await tx
        .select({ amount: payrollRemittanceRequests.requestedAmount })
        .from(payrollRemittanceRequests)
        .where(
          and(
            eq(payrollRemittanceRequests.payingBranchId, input.payingBranchId),
            eq(payrollRemittanceRequests.kind, input.kind),
            inArray(payrollRemittanceRequests.status, ["PENDING", "APPROVED"]),
          ),
        )
        .for("update");
      const reserved = reservations.reduce(
        (sum, row) => sum.plus(money(row.amount)),
        money(0),
      );
      const obligations = await tx
        .select({ remaining: payrollObligations.remainingAmount })
        .from(payrollObligations)
        .where(
          and(
            eq(payrollObligations.branchIdSnapshot, input.payingBranchId),
            eq(payrollObligations.kind, obligationKind(input.kind)),
            inArray(payrollObligations.status, ["OPEN", "PARTIAL"]),
          ),
        )
        .for("update");
      const outstanding = obligations.reduce(
        (sum, row) => sum.plus(money(row.remaining)),
        money(0),
      );
      if (amount.gt(round2(outstanding.minus(reserved)))) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "مبلغ الطلب يتجاوز الالتزام المفتوح غير المحجوز لهذا الفرع.",
        });
      }
      const result = await tx.insert(payrollRemittanceRequests).values({
        kind: input.kind,
        payingBranchId: input.payingBranchId,
        requestedAmount: toDbMoney(amount),
        authorityName,
        referenceNumber,
        supportingDocumentUrl: input.supportingDocumentUrl,
        status: "PENDING",
        sourceKey,
        createdBy: actor.userId,
      });
      const id = extractInsertId(result);
      const [created] = await tx
        .select()
        .from(payrollRemittanceRequests)
        .where(eq(payrollRemittanceRequests.id, id))
        .limit(1);
      return { ...created!, replayed: false };
    });
  } catch (error) {
    if (!isDupEntry(error)) throw error;
    const concurrent = await existingBySourceKey(sourceKey);
    if (concurrent && sameRequest(concurrent, input)) {
      return { ...concurrent, replayed: true };
    }
    throw new TRPCError({
      code: "CONFLICT",
      message: "تعارض مفتاح طلب التحويل القانوني.",
    });
  }
}

export async function approveRemittanceRequest(id: number, actor: Actor) {
  return withTx(async (tx) => {
    const [request] = await tx
      .select()
      .from(payrollRemittanceRequests)
      .where(eq(payrollRemittanceRequests.id, id))
      .for("update")
      .limit(1);
    if (!request) throw new TRPCError({ code: "NOT_FOUND", message: "طلب التحويل غير موجود." });
    await assertOwner(tx, actor, [request.createdBy], "اعتماد تحويل الاستقطاعات");
    if (request.status === "APPROVED" || request.status === "PAID") {
      return { ...request, replayed: true };
    }
    if (request.status !== "PENDING") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يعتمد إلا الطلب المعلّق." });
    }
    await tx
      .update(payrollRemittanceRequests)
      .set({ status: "APPROVED", approvedBy: actor.userId, approvedAt: new Date() })
      .where(eq(payrollRemittanceRequests.id, id));
    return { ...request, status: "APPROVED" as const, approvedBy: actor.userId, replayed: false };
  });
}

export async function rejectRemittanceRequest(
  id: number,
  reason: string,
  actor: Actor,
) {
  const normalizedReason = reason.trim();
  if (normalizedReason.length < 5 || normalizedReason.length > 255) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "The rejection reason must be between 5 and 255 characters." });
  }
  return withTx(async (tx) => {
    const [request] = await tx
      .select()
      .from(payrollRemittanceRequests)
      .where(eq(payrollRemittanceRequests.id, id))
      .for("update")
      .limit(1);
    if (!request) throw new TRPCError({ code: "NOT_FOUND", message: "طلب التحويل غير موجود." });
    await assertOwner(tx, actor, [request.createdBy], "رفض تحويل الاستقطاعات");
    if (request.status === "REJECTED") {
      if (request.rejectionReason !== normalizedReason) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "سبب إعادة محاولة الرفض لا يطابق السبب المحفوظ.",
        });
      }
      return { ...request, replayed: true };
    }
    if (request.status !== "PENDING") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يرفض إلا الطلب المعلّق." });
    }
    await tx
      .update(payrollRemittanceRequests)
      .set({
        status: "REJECTED",
        rejectedBy: actor.userId,
        rejectedAt: new Date(),
        rejectionReason: normalizedReason,
      })
      .where(eq(payrollRemittanceRequests.id, id));
    return { ...request, status: "REJECTED" as const, replayed: false };
  });
}

export async function payRemittanceRequest(
  input: PayrollRemittancePaymentInput,
  actor: Actor,
) {
  const ymd = paymentDate(input.paymentDate);
  const referenceNumber = payrollRemittancePaymentReference(input.paymentMethod, input.referenceNumber);
  return withTx(async (tx) => {
    const [preview] = await tx
      .select()
      .from(payrollRemittanceRequests)
      .where(eq(payrollRemittanceRequests.id, input.requestId))
      .limit(1);
    if (!preview) throw new TRPCError({ code: "NOT_FOUND", message: "طلب التحويل غير موجود." });
    let approval: Awaited<ReturnType<typeof authorizeExternalTreasuryDisbursement>> | null = null;
    if (input.paymentMethod === "CASH") {
      approval = await authorizeExternalTreasuryDisbursement(tx, {
        actor,
        makerUserIds: [preview.createdBy],
        branchIds: [Number(preview.payingBranchId)],
        operation: "تحويل الاستقطاعات القانونية",
      });
    } else {
      await assertOwner(
        tx,
        actor,
        [preview.createdBy],
        "تحويل الاستقطاعات القانونية",
      );
    }
    const [request] = await tx
      .select()
      .from(payrollRemittanceRequests)
      .where(eq(payrollRemittanceRequests.id, input.requestId))
      .for("update")
      .limit(1);
    if (!request) throw new TRPCError({ code: "NOT_FOUND", message: "طلب التحويل غير موجود." });
    if (request.status === "PAID") {
      const [savedReceipt] = request.receiptId == null
        ? [undefined]
        : await tx
            .select({
              paymentMethod: receipts.paymentMethod,
              referenceNumber: receipts.referenceNumber,
              voucherYmd: sql<string>`DATE_FORMAT(${receipts.voucherDate}, '%Y-%m-%d')`,
              status: receipts.status,
            })
            .from(receipts)
            .where(eq(receipts.id, Number(request.receiptId)))
            .for("update")
            .limit(1);
      if (
        !savedReceipt || savedReceipt.status !== "COMPLETED" ||
        savedReceipt.paymentMethod !== input.paymentMethod ||
        (savedReceipt.referenceNumber?.trim() || null) !== referenceNumber ||
        savedReceipt.voucherYmd !== ymd
      ) {
        throw new TRPCError({ code: "CONFLICT", message: "إعادة محاولة التحويل لا تطابق إيصال الدفع المحفوظ." });
      }
      return { replayed: true, request };
    }
    if (request.status !== "APPROVED") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "يُدفع الطلب بعد اعتماده فقط." });
    }
    if (request.createdBy !== preview.createdBy || request.requestedAmount !== preview.requestedAmount) {
      throw new TRPCError({ code: "CONFLICT", message: "تغيّر طلب التحويل أثناء التنفيذ." });
    }
    const amount = money(request.requestedAmount);
    if (input.paymentMethod === "CASH") {
      if (!approval) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "إثبات اعتماد تحويل الاستقطاعات النقدي مفقود.",
        });
      }
      await assertApprovedTreasuryOutAvailable(
        tx,
        {
          branchId: Number(request.payingBranchId),
          amount,
          operation: "تحويل الاستقطاعات القانونية",
        },
        approval,
      );
    }
    const obligations = await tx
      .select()
      .from(payrollObligations)
      .where(
        and(
          eq(payrollObligations.branchIdSnapshot, Number(request.payingBranchId)),
          eq(payrollObligations.kind, obligationKind(request.kind)),
          inArray(payrollObligations.status, ["OPEN", "PARTIAL"]),
        ),
      )
      .orderBy(asc(payrollObligations.dueDate), asc(payrollObligations.id))
      .for("update");
    const available = obligations.reduce(
      (sum, row) => sum.plus(money(row.remainingAmount)),
      money(0),
    );
    if (available.lt(amount)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "الرصيد المفتوح لا يكفي طلب التحويل المعتمد.",
      });
    }
    const receiptResult = await tx.insert(receipts).values({
      branchId: Number(request.payingBranchId),
      shiftId: null,
      cashBucket: input.paymentMethod === "CASH" ? "TREASURY" : null,
      direction: "OUT",
      amount: toDbMoney(amount),
      paymentMethod: input.paymentMethod,
      referenceNumber,
      cardLastFour: input.paymentMethod === "CARD" ? referenceNumber : null,
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      approvedBy: actor.userId,
      approvedAt: new Date(),
      partyType: "OTHER",
      partyId: null,
      counterpartyName: request.authorityName,
      voucherDate: new Date(`${ymd}T00:00:00.000Z`),
      attachmentUrl: request.supportingDocumentUrl,
      description: `تحويل ${request.kind === "INCOME_TAX" ? "ضريبة الدخل" : "الضمان الاجتماعي"} — ${request.authorityName}`,
      createdBy: actor.userId,
    });
    const receiptId = extractInsertId(receiptResult);
    const occurredAt = new Date(`${ymd}T12:00:00.000Z`);
    const kind = request.kind === "INCOME_TAX" ? "INCOME_TAX" : "SOCIAL_SECURITY";
    const posting = payrollSettlementPosting({
      kind,
      direction: "OUT",
      paymentMethod: input.paymentMethod,
      amount,
    });
    const sourceKey = `STATREMIT:PAY:${Number(request.id)}`;
    const event = await postPayrollAccountingEvent(tx, {
      remittanceRequestId: Number(request.id),
      branchId: Number(request.payingBranchId),
      revisionNo: 0,
      eventKind: request.kind === "INCOME_TAX" ? "TAX_REMITTANCE" : "SOCIAL_SECURITY_REMITTANCE",
      receiptId,
      sourceKey,
      sourceHashPayload: {
        kind: "REMITTANCE",
        requestSourceKey: request.sourceKey,
        amount: amount.toFixed(2),
        paymentMethod: input.paymentMethod,
        referenceNumber,
        ymd,
      },
      occurredAt,
      actorUserId: actor.userId,
      entryType: posting.entryType,
      amount,
      paymentMethod: input.paymentMethod,
      postingIntent: posting.intent,
      postingSourceComponents: posting.source,
      notes: `تحويل استقطاعات — ${request.authorityName} — ${request.referenceNumber}`,
    });
    let left = amount;
    for (const obligation of obligations) {
      if (left.lte(0)) break;
      if (obligation.dueDate != null && ymd < String(obligation.dueDate).slice(0, 10)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "تاريخ التحويل يسبق تاريخ نشوء الالتزام المخصّص له.",
        });
      }
      const before = money(obligation.remainingAmount);
      const applied = round2(Decimal.min(left, before));
      const after = round2(before.minus(applied));
      left = round2(left.minus(applied));
      await tx.insert(payrollObligationAllocations).values({
        obligationId: Number(obligation.id),
        accountingEventId: event.eventId,
        remittanceRequestId: Number(request.id),
        direction: "APPLY",
        amount: toDbMoney(applied),
        sourceKey: `PAYROLL:REMIT-ALLOC:${Number(request.id)}:${Number(obligation.id)}`,
        occurredAt,
        createdBy: actor.userId,
      });
      await tx
        .update(payrollObligations)
        .set({
          remainingAmount: toDbMoney(after),
          status: after.isZero() ? "SETTLED" : "PARTIAL",
        })
        .where(eq(payrollObligations.id, Number(obligation.id)));
    }
    if (!left.isZero()) {
      throw new TRPCError({ code: "CONFLICT", message: "تعذّر تخصيص كامل التحويل." });
    }
    await tx
      .update(payrollRemittanceRequests)
      .set({
        status: "PAID",
        receiptId,
        paidBy: actor.userId,
        paidAt: new Date(),
      })
      .where(eq(payrollRemittanceRequests.id, Number(request.id)));
    return { replayed: false, requestId: Number(request.id), receiptId, eventId: event.eventId };
  });
}

export async function returnRemittance(
  requestId: number,
  reason: string,
  actor: Actor,
  input?: { returnedAt?: string | null; referenceNumber?: string | null },
) {
  const normalizedReason = reason.trim();
  if (normalizedReason.length < 5 || normalizedReason.length > 255) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "The return reason must be between 5 and 255 characters." });
  }
  const ymd = paymentDate(input?.returnedAt);
  return withTx(async (tx) => {
    const [request] = await tx
      .select()
      .from(payrollRemittanceRequests)
      .where(eq(payrollRemittanceRequests.id, requestId))
      .for("update")
      .limit(1);
    if (!request) throw new TRPCError({ code: "NOT_FOUND", message: "طلب التحويل غير موجود." });
    await assertOwner(tx, actor, [request.createdBy, request.paidBy], "إعادة تحويل قانوني");
    if (request.status === "REVERSED") {
      if (request.reversalReason !== normalizedReason) {
        throw new TRPCError({ code: "CONFLICT", message: "The retry reason does not match the stored return reason." });
      }
      const events = await tx
        .select()
        .from(payrollAccountingEvents)
        .where(eq(payrollAccountingEvents.remittanceRequestId, requestId))
        .orderBy(asc(payrollAccountingEvents.id))
        .for("update");
      const originalEvent = events.find((event) => event.eventKind !== "REMITTANCE_RETURN");
      const returnEvent = events.find((event) => event.eventKind === "REMITTANCE_RETURN");
      if (!originalEvent || !returnEvent?.receiptId) {
        throw new TRPCError({ code: "CONFLICT", message: "Stored remittance return evidence is incomplete." });
      }
      const [returnReceipt] = await tx
        .select()
        .from(receipts)
        .where(eq(receipts.id, Number(returnEvent.receiptId)))
        .for("update")
        .limit(1);
      if (!returnReceipt || returnReceipt.status !== "COMPLETED") {
        throw new TRPCError({ code: "CONFLICT", message: "Stored remittance return receipt is incomplete." });
      }
      const method = returnReceipt.paymentMethod as PayrollPaymentMethod;
      if (!["CASH", "CARD", "TRANSFER", "WALLET"].includes(method)) {
        throw new TRPCError({ code: "CONFLICT", message: "Stored remittance return method is unsupported." });
      }
      const referenceNumber = payrollRemittancePaymentReference(
        method,
        input?.referenceNumber ?? returnReceipt.referenceNumber,
      );
      const expectedHash = payrollHash({
        kind: "REMITTANCE_RETURN",
        originalSourceHash: originalEvent.sourceHash,
        amount: money(request.requestedAmount).toFixed(2),
        method,
        referenceNumber,
        ymd,
        reason: normalizedReason,
      });
      if (returnEvent.sourceHash !== expectedHash) {
        throw new TRPCError({ code: "CONFLICT", message: "The retry does not match the stored remittance return evidence." });
      }
      return { replayed: true, requestId };
    }
    if (request.status !== "PAID" || request.receiptId == null) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يُعاد إلا تحويل مدفوع." });
    }
    const [originalReceipt] = await tx
      .select()
      .from(receipts)
      .where(eq(receipts.id, Number(request.receiptId)))
      .for("update")
      .limit(1);
    const [originalEvent] = await tx
      .select()
      .from(payrollAccountingEvents)
      .where(eq(payrollAccountingEvents.remittanceRequestId, requestId))
      .for("update")
      .limit(1);
    if (!originalReceipt || !originalEvent || originalEvent.eventKind === "REMITTANCE_RETURN") {
      throw new TRPCError({ code: "CONFLICT", message: "دليل التحويل الأصلي ناقص." });
    }
    if (originalReceipt.status !== "COMPLETED") {
      throw new TRPCError({
        code: "CONFLICT",
        message: "إيصال التحويل الأصلي سبق عكسه أو ليس مكتملاً.",
      });
    }
    const originalYmd = originalReceipt.voucherDate
      ? toDateStr(new Date(originalReceipt.voucherDate))
      : toDateStr(new Date(originalReceipt.createdAt));
    if (ymd < originalYmd) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "تاريخ إعادة التحويل لا يسبق تاريخ دفعه.",
      });
    }
    const method = originalReceipt.paymentMethod as PayrollPaymentMethod;
    if (!["CASH", "CARD", "TRANSFER", "WALLET"].includes(method)) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "طريقة التحويل الأصلية غير مدعومة للإعادة." });
    }
    const referenceNumber = payrollRemittancePaymentReference(method, input?.referenceNumber ?? originalReceipt.referenceNumber);
    const amount = money(request.requestedAmount);
    const receiptResult = await tx.insert(receipts).values({
      branchId: Number(request.payingBranchId),
      shiftId: null,
      cashBucket: method === "CASH" ? "TREASURY" : null,
      direction: "IN",
      amount: toDbMoney(amount),
      paymentMethod: method,
      referenceNumber,
      cardLastFour: method === "CARD" ? referenceNumber : null,
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      approvedBy: actor.userId,
      approvedAt: new Date(),
      partyType: "OTHER",
      partyId: null,
      counterpartyName: request.authorityName,
      voucherDate: new Date(`${ymd}T00:00:00.000Z`),
      description: `إعادة تحويل قانوني — ${request.authorityName}`,
      createdBy: actor.userId,
    });
    const receiptId = extractInsertId(receiptResult);
    const occurredAt = new Date(`${ymd}T12:00:00.000Z`);
    const kind = request.kind === "INCOME_TAX" ? "INCOME_TAX" : "SOCIAL_SECURITY";
    const posting = payrollSettlementPosting({ kind, direction: "IN", paymentMethod: method, amount });
    const sourceKey = `STATREMIT:RETURN:${requestId}`;
    const event = await postPayrollAccountingEvent(tx, {
      remittanceRequestId: requestId,
      branchId: Number(request.payingBranchId),
      revisionNo: 0,
      eventKind: "REMITTANCE_RETURN",
      receiptId,
      reversalOfId: Number(originalEvent.id),
      sourceKey,
      sourceHashPayload: {
        kind: "REMITTANCE_RETURN",
        originalSourceHash: originalEvent.sourceHash,
        amount: amount.toFixed(2),
        method,
        referenceNumber,
        ymd,
        reason: normalizedReason,
      },
      occurredAt,
      actorUserId: actor.userId,
      entryType: posting.entryType,
      amount,
      paymentMethod: method,
      postingIntent: posting.intent,
      postingSourceComponents: posting.source,
      notes: `إعادة تحويل استقطاعات — ${request.authorityName} — ${normalizedReason}`,
    });
    const allocations = await tx
      .select()
      .from(payrollObligationAllocations)
      .where(
        and(
          eq(payrollObligationAllocations.remittanceRequestId, requestId),
          eq(payrollObligationAllocations.direction, "APPLY"),
        ),
      )
      .orderBy(asc(payrollObligationAllocations.id))
      .for("update");
    for (const allocation of allocations) {
      const [obligation] = await tx
        .select()
        .from(payrollObligations)
        .where(eq(payrollObligations.id, Number(allocation.obligationId)))
        .for("update")
        .limit(1);
      if (!obligation) throw new TRPCError({ code: "CONFLICT", message: "التزام التحويل مفقود." });
      const after = round2(money(obligation.remainingAmount).plus(money(allocation.amount)));
      if (after.gt(money(obligation.originalAmount))) {
        throw new TRPCError({ code: "CONFLICT", message: "عكس التحويل يتجاوز أصل الالتزام." });
      }
      await tx.insert(payrollObligationAllocations).values({
        obligationId: Number(obligation.id),
        accountingEventId: event.eventId,
        remittanceRequestId: requestId,
        direction: "REVERSE",
        amount: allocation.amount,
        reversalOfId: Number(allocation.id),
        sourceKey: `PAYROLL:REMIT-ALLOC-REV:${requestId}:${Number(allocation.id)}`,
        occurredAt,
        createdBy: actor.userId,
      });
      await tx
        .update(payrollObligations)
        .set({
          remainingAmount: toDbMoney(after),
          status: after.eq(money(obligation.originalAmount)) ? "OPEN" : "PARTIAL",
        })
        .where(eq(payrollObligations.id, Number(obligation.id)));
    }
    await tx.update(receipts).set({ status: "REVERSED" }).where(eq(receipts.id, Number(originalReceipt.id)));
    await tx
      .update(payrollRemittanceRequests)
      .set({
        status: "REVERSED",
        reversedBy: actor.userId,
        reversedAt: new Date(),
        reversalReason: normalizedReason,
      })
      .where(eq(payrollRemittanceRequests.id, requestId));
    return { replayed: false, requestId, receiptId, eventId: event.eventId };
  });
}

export async function listRemittanceRequests(input?: {
  kind?: PayrollRemittanceKind;
  status?: "PENDING" | "APPROVED" | "PAID" | "REJECTED" | "REVERSED";
  branchId?: number;
}) {
  const filters = [
    input?.kind ? eq(payrollRemittanceRequests.kind, input.kind) : undefined,
    input?.status ? eq(payrollRemittanceRequests.status, input.status) : undefined,
    input?.branchId ? eq(payrollRemittanceRequests.payingBranchId, input.branchId) : undefined,
  ].filter(Boolean) as ReturnType<typeof eq>[];
  return requireDb()
    .select()
    .from(payrollRemittanceRequests)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(payrollRemittanceRequests.id));
}

export async function listPayrollObligations(input?: {
  runId?: number;
  employeeId?: number;
  branchId?: number;
  kind?: "SALARY_NET" | "INCOME_TAX" | "SOCIAL_SECURITY" | "EOS_PROVISION";
  status?: "OPEN" | "PARTIAL" | "SETTLED" | "REVERSED";
}) {
  const filters = [
    input?.runId ? eq(payrollObligations.runId, input.runId) : undefined,
    input?.employeeId ? eq(payrollObligations.employeeId, input.employeeId) : undefined,
    input?.branchId ? eq(payrollObligations.branchIdSnapshot, input.branchId) : undefined,
    input?.kind ? eq(payrollObligations.kind, input.kind) : undefined,
    input?.status ? eq(payrollObligations.status, input.status) : undefined,
  ].filter(Boolean) as ReturnType<typeof eq>[];
  return requireDb()
    .select()
    .from(payrollObligations)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(asc(payrollObligations.dueDate), asc(payrollObligations.id));
}

export async function listStatutoryObligationSummary(input?: { branchId?: number }) {
  const filters = [
    inArray(payrollObligations.kind, ["INCOME_TAX", "SOCIAL_SECURITY"]),
    inArray(payrollObligations.status, ["OPEN", "PARTIAL"]),
    input?.branchId
      ? eq(payrollObligations.branchIdSnapshot, input.branchId)
      : undefined,
  ].filter(Boolean) as ReturnType<typeof eq>[];
  const rows = await requireDb()
    .select({
      kind: payrollObligations.kind,
      branchIdSnapshot: payrollObligations.branchIdSnapshot,
      remainingAmount: sql<string>`COALESCE(SUM(${payrollObligations.remainingAmount}), 0)`,
      openCount: sql<number>`COUNT(*)`,
    })
    .from(payrollObligations)
    .where(and(...filters))
    .groupBy(payrollObligations.kind, payrollObligations.branchIdSnapshot)
    .orderBy(payrollObligations.branchIdSnapshot, payrollObligations.kind);
  return rows.map((row) => ({
    kind: row.kind as "INCOME_TAX" | "SOCIAL_SECURITY",
    branchIdSnapshot: Number(row.branchIdSnapshot),
    remainingAmount: money(row.remainingAmount).toFixed(2),
    openCount: Number(row.openCount),
  }));
}
