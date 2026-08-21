import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import {
  customers,
  documentPrintEvents,
  exchangeTransactions,
  purchaseReturns,
  receipts,
  suppliers,
  users,
} from "../../drizzle/schema";
import {
  sanitizePrintFailureCode,
  type PrintChannel,
  type PrintDocumentType,
  type PrintOutcome,
} from "@shared/printAudit";
import { getDb } from "../db";
import { isDupEntry } from "@shared/errorMap.ar";
import { extractInsertId } from "../lib/insertId";

type PrintActor = { userId: number; branchId: number | null };

async function actorSnapshot(userId: number) {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
  const row = (await db.select({ name: users.name, username: users.username }).from(users).where(eq(users.id, userId)).limit(1))[0];
  if (!row) throw new TRPCError({ code: "UNAUTHORIZED", message: "المستخدم غير موجود" });
  return row.name?.trim() || row.username?.trim() || `مستخدم #${userId}`;
}

async function assertDocumentScope(type: PrintDocumentType, documentId: number, branchId: number | null) {
  const db = getDb()!;
  let foundBranch: number | null | undefined;
  if (type === "PURCHASE_RETURN") {
    foundBranch = (await db.select({ branchId: purchaseReturns.branchId }).from(purchaseReturns).where(eq(purchaseReturns.id, documentId)).limit(1))[0]?.branchId;
  } else if (type === "EXCHANGE_TRANSACTION") {
    foundBranch = (await db.select({ branchId: exchangeTransactions.branchId }).from(exchangeTransactions).where(eq(exchangeTransactions.id, documentId)).limit(1))[0]?.branchId;
  } else if (type === "VOUCHER") {
    const voucher = (await db.select({
      branchId: receipts.branchId,
      status: receipts.status,
      approvalStatus: receipts.approvalStatus,
    }).from(receipts).where(eq(receipts.id, documentId)).limit(1))[0];
    if (!voucher) throw new TRPCError({ code: "NOT_FOUND", message: "السند غير موجود" });
    if (voucher.status !== "COMPLETED" || voucher.approvalStatus !== "APPROVED") {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا تُطبع وثيقة رسمية لسند غير نافذ أو معكوس" });
    }
    foundBranch = voucher.branchId;
  } else if (type === "CUSTOMER_STATEMENT") {
    const exists = (await db.select({ id: customers.id }).from(customers).where(eq(customers.id, documentId)).limit(1))[0];
    if (!exists) throw new TRPCError({ code: "NOT_FOUND", message: "العميل غير موجود" });
    foundBranch = branchId;
  } else {
    const exists = (await db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.id, documentId)).limit(1))[0];
    if (!exists) throw new TRPCError({ code: "NOT_FOUND", message: "المورد غير موجود" });
    foundBranch = branchId;
  }
  if (foundBranch === undefined) throw new TRPCError({ code: "NOT_FOUND", message: "المستند غير موجود" });
  if (branchId != null && foundBranch != null && Number(foundBranch) !== branchId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "المستند لا يخص الفرع المسموح" });
  }
  return foundBranch == null ? branchId : Number(foundBranch);
}

async function insertEvent(values: typeof documentPrintEvents.$inferInsert) {
  const db = getDb()!;
  try {
    const inserted = await db.insert(documentPrintEvents).values(values);
    const id = extractInsertId(inserted);
    return (await db.select().from(documentPrintEvents).where(eq(documentPrintEvents.id, id)).limit(1))[0];
  } catch (error) {
    if (!isDupEntry(error)) throw error;
    return (await db.select().from(documentPrintEvents).where(and(
      eq(documentPrintEvents.requestId, values.requestId),
      eq(documentPrintEvents.outcome, values.outcome),
    )).limit(1))[0];
  }
}

type RequestedEvent = typeof documentPrintEvents.$inferSelect;

function requestResponse(event: RequestedEvent) {
  return {
    id: Number(event.id),
    requestId: event.requestId,
    actorName: event.actorNameSnapshot,
    requestedAt: event.eventAt,
    reprint: event.reprintOfRequestId != null,
  };
}

function assertExactRequestReplay(event: RequestedEvent, input: {
  documentType: PrintDocumentType;
  documentId: number;
  branchId: number | null;
  channel: PrintChannel;
  copies: number;
}, actor: PrintActor) {
  if (Number(event.actorUserId) !== actor.userId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن إعادة الطلب بهوية منفذ أخرى" });
  }
  if (actor.branchId != null && event.branchId != null && Number(event.branchId) !== actor.branchId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن إعادة الطلب من فرع آخر" });
  }
  const eventBranchId = event.branchId == null ? null : Number(event.branchId);
  const sameRequest = event.documentType === input.documentType
    && Number(event.documentId) === input.documentId
    && eventBranchId === input.branchId
    && event.channel === input.channel
    && event.copies === input.copies;
  if (!sameRequest) {
    throw new TRPCError({ code: "CONFLICT", message: "إعادة الطلب لا تطابق طلب الطباعة الأصلي" });
  }
}

export async function requestDocumentPrint(input: {
  requestId: string;
  documentType: PrintDocumentType;
  documentId: number;
  branchId: number | null;
  channel: PrintChannel;
  copies: number;
}, actor: PrintActor) {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
  const documentBranchId = await assertDocumentScope(input.documentType, input.documentId, input.branchId);
  // كشف الطرف لا يحمل branchId بنيوياً؛ جلسة موظف الفرع تصبح هي النطاق canonical.
  // يبقى admin بلا فرع قادراً على طلب كشف عام صريحاً بـNULL.
  const branchId = documentBranchId ?? actor.branchId;
  if (actor.branchId != null && branchId != null && actor.branchId !== branchId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن طباعة مستند من فرع آخر" });
  }
  const replay = (await db.select().from(documentPrintEvents).where(and(
    eq(documentPrintEvents.requestId, input.requestId),
    eq(documentPrintEvents.outcome, "REQUESTED"),
  )).limit(1))[0];
  if (replay) {
    assertExactRequestReplay(replay, { ...input, branchId }, actor);
    return requestResponse(replay);
  }
  const actorName = await actorSnapshot(actor.userId);
  const previous = (await db.select({ requestId: documentPrintEvents.requestId })
    .from(documentPrintEvents)
    .where(and(
      eq(documentPrintEvents.documentType, input.documentType),
      eq(documentPrintEvents.documentId, input.documentId),
      eq(documentPrintEvents.outcome, "REQUESTED"),
    ))
    .orderBy(desc(documentPrintEvents.id))
    .limit(1))[0];
  const event = await insertEvent({
    requestId: input.requestId,
    documentType: input.documentType,
    documentId: input.documentId,
    branchId,
    actorUserId: actor.userId,
    actorNameSnapshot: actorName,
    channel: input.channel,
    outcome: "REQUESTED",
    copies: input.copies,
    reprintOfRequestId: previous?.requestId ?? null,
  });
  assertExactRequestReplay(event, { ...input, branchId }, actor);
  return requestResponse(event);
}

export async function recordDocumentPrintOutcome(input: {
  requestId: string;
  outcome: Exclude<PrintOutcome, "REQUESTED">;
  failureCode?: string | null;
}, actor: PrintActor) {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
  const request = (await db.select().from(documentPrintEvents).where(and(
    eq(documentPrintEvents.requestId, input.requestId),
    eq(documentPrintEvents.outcome, "REQUESTED"),
  )).limit(1))[0];
  if (!request) throw new TRPCError({ code: "NOT_FOUND", message: "طلب الطباعة غير موجود" });
  if (Number(request.actorUserId) !== actor.userId) throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكنك إكمال طلب طباعة لمستخدم آخر" });
  if (actor.branchId != null && request.branchId != null && Number(request.branchId) !== actor.branchId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكنك إكمال طلب طباعة من فرع آخر" });
  }
  if (input.outcome === "DISPATCHED" && (request.channel === "BROWSER" || request.channel === "PDF")) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "قناة المتصفح لا تثبت نجاح إرسال مباشر" });
  }
  return insertEvent({
    requestId: request.requestId,
    documentType: request.documentType,
    documentId: request.documentId,
    branchId: request.branchId,
    actorUserId: request.actorUserId,
    actorNameSnapshot: request.actorNameSnapshot,
    channel: request.channel,
    outcome: input.outcome,
    copies: request.copies,
    failureCode: input.outcome === "FAILED" ? sanitizePrintFailureCode(input.failureCode) : null,
    reprintOfRequestId: request.reprintOfRequestId,
  });
}
