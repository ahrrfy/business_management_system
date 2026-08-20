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
import type { PrintChannel, PrintDocumentType, PrintOutcome } from "@shared/printAudit";
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
    foundBranch = (await db.select({ branchId: receipts.branchId }).from(receipts).where(eq(receipts.id, documentId)).limit(1))[0]?.branchId;
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

export async function requestDocumentPrint(input: {
  requestId: string;
  documentType: PrintDocumentType;
  documentId: number;
  branchId: number | null;
  channel: PrintChannel;
  copies: number;
}, actor: PrintActor) {
  const branchId = await assertDocumentScope(input.documentType, input.documentId, input.branchId);
  if (actor.branchId != null && branchId != null && actor.branchId !== branchId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن طباعة مستند من فرع آخر" });
  }
  const actorName = await actorSnapshot(actor.userId);
  const db = getDb()!;
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
  return { id: Number(event.id), requestId: event.requestId, actorName: event.actorNameSnapshot, requestedAt: event.eventAt, reprint: event.reprintOfRequestId != null };
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
    failureCode: input.outcome === "FAILED" ? input.failureCode?.slice(0, 80) || "UNKNOWN" : null,
    reprintOfRequestId: request.reprintOfRequestId,
  });
}
