// خدمة التحويل النقدي بين الفروع (treasury-stage2).
// تدفّق ثنائي: send (IN_TRANSIT) ⇒ receive (RECEIVED) ⇒ مكتمل. الإلغاء ممكن قبل الاستلام فقط.
// الأمان: قفل ثنائي على cashTransfers بـ.for("update") + IDOR (الـreceiver في toBranchId).

import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, like, lte, or, sql } from "drizzle-orm";
import { branches, cashTransfers, receipts } from "../../drizzle/schema";
import { getDb, type Tx } from "../db";
import { extractInsertId } from "../lib/insertId";
import { findIdempotentRefId, recordIdempotencyKey } from "./idempotency";
import { postEntry } from "./ledgerService";
import { money, toDateStr, toDbMoney } from "./money";
import { withTx, type Actor } from "./tx";

export interface SendTransferInput {
  fromBranchId: number;
  toBranchId: number;
  amount: string;
  notes?: string | null;
  clientRequestId?: string | null;
  /** Q1 (المالك ٢١/٦): تمكين الإرسال بمبلغ يَتجاوز الرصيد المتاح بعد عرض تحذير لين. */
  confirmNegative?: boolean;
}

export interface SendTransferResult {
  transferId: number;
  transferNumber: string;
  sentReceiptId: number;
}

async function nextTransferNumber(tx: Tx, fromBranchId: number): Promise<string> {
  const ymd = toDateStr().replace(/-/g, "");
  const prefix = `CT-${fromBranchId}-${ymd}-`;
  const lockName = `cash_transfer:${fromBranchId}:${ymd}`;
  const lockRes: any = await tx.execute(sql`SELECT GET_LOCK(${lockName}, 5) AS locked`);
  const lockedRow = Array.isArray(lockRes) ? lockRes[0]?.[0] : lockRes?.rows?.[0];
  if (!lockedRow || Number(lockedRow.locked) !== 1) {
    throw new Error(`transfer numbering lock timeout for ${lockName}`);
  }
  try {
    const rows = await tx
      .select({ n: cashTransfers.transferNumber })
      .from(cashTransfers)
      .where(like(cashTransfers.transferNumber, `${prefix}%`))
      .orderBy(desc(cashTransfers.id))
      .limit(1);
    const last = rows[0]?.n;
    const seq = last ? parseInt(String(last).slice(prefix.length), 10) + 1 : 1;
    return prefix + String(seq).padStart(5, "0");
  } finally {
    await tx.execute(sql`SELECT RELEASE_LOCK(${lockName})`);
  }
}

/** يَحسب رصيد TREASURY الحالي لفرع معيّن. تَكلفة استعلام واحد. */
async function getTreasuryBalance(tx: Tx, branchId: number): Promise<ReturnType<typeof money>> {
  const rows: any = await tx.execute(sql`
    SELECT CAST(COALESCE(SUM(CASE WHEN direction = 'IN' THEN amount ELSE -amount END), 0) AS CHAR) AS balance
    FROM receipts
    WHERE branchId = ${branchId}
      AND cashBucket = 'TREASURY'
      AND receiptStatus = 'COMPLETED'
  `);
  const r = Array.isArray(rows) ? rows[0]?.[0] : rows?.rows?.[0];
  return money(r?.balance ?? 0);
}

/** إرسال تحويل نقدي من فرع إلى آخر (IN_TRANSIT). */
export async function sendTransfer(
  input: SendTransferInput,
  actor: Actor,
): Promise<SendTransferResult> {
  return withTx(async (tx) => {
    // 1. Idempotency
    if (input.clientRequestId) {
      const existing = await findIdempotentRefId(tx, "cashTransfer.send", input.clientRequestId);
      if (existing != null) {
        const t = (
          await tx.select().from(cashTransfers).where(eq(cashTransfers.id, existing)).limit(1)
        )[0];
        if (!t) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "tarnsfer idempotency missing" });
        }
        return {
          transferId: existing,
          transferNumber: t.transferNumber,
          sentReceiptId: t.sentReceiptId ? Number(t.sentReceiptId) : 0,
        };
      }
    }

    // 2. Validate
    if (input.fromBranchId === input.toBranchId) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن التحويل لنفس الفرع" });
    }
    const amount = money(input.amount);
    if (amount.isZero() || amount.isNegative()) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "المبلغ يَجب أن يَكون موجباً" });
    }
    const fromBranch = (
      await tx.select().from(branches).where(eq(branches.id, input.fromBranchId)).limit(1)
    )[0];
    const toBranch = (
      await tx.select().from(branches).where(eq(branches.id, input.toBranchId)).limit(1)
    )[0];
    if (!fromBranch || !toBranch) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "فرع غير موجود" });
    }

    // 3. الصلاحية: admin/manager فقط + admin له صلاحية cross-branch.
    if (actor.role !== "admin") {
      if (actor.role !== "manager") {
        throw new TRPCError({ code: "FORBIDDEN", message: "إرسال التحويل النقدي للمدير فأعلى" });
      }
      if (Number(actor.branchId) !== input.fromBranchId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "لا يمكنك إرسال تحويل من فرع غير فرعك",
        });
      }
    }

    // 4. Q1: فحص رصيد TREASURY للمُرسِل. إن تجاوز ⇒ رفض ناعم تَطلب confirmNegative.
    const available = await getTreasuryBalance(tx, input.fromBranchId);
    if (amount.gt(available) && !input.confirmNegative) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `الرصيد المتاح ${available.toFixed(2)} د.ع أقلّ من المطلوب ${amount.toFixed(2)} د.ع. أرسل confirmNegative=true لتجاوز التحذير.`,
        cause: {
          balanceWarning: { available: available.toFixed(2), requested: amount.toFixed(2) },
        } as never,
      });
    }

    // 5. توليد رقم التحويل.
    const transferNumber = await nextTransferNumber(tx, input.fromBranchId);

    // 6. إدراج صف cashTransfers.
    const xferRes = await tx.insert(cashTransfers).values({
      transferNumber,
      fromBranchId: input.fromBranchId,
      toBranchId: input.toBranchId,
      amount: toDbMoney(amount),
      status: "IN_TRANSIT",
      sentBy: actor.userId,
      notes: input.notes ?? null,
    });
    const transferId = extractInsertId(xferRes);

    // 7. receipt OUT في فرع المُرسل (TREASURY).
    const sentRes = await tx.insert(receipts).values({
      branchId: input.fromBranchId,
      shiftId: null,
      direction: "OUT",
      amount: toDbMoney(amount),
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      referenceNumber: transferNumber,
      status: "COMPLETED",
      partyType: "OTHER",
      description: `تحويل نقدي إلى فرع «${toBranch.name}» (${transferNumber})${input.notes ? " — " + input.notes : ""}`,
      createdBy: actor.userId,
    });
    const sentReceiptId = extractInsertId(sentRes);

    // 8. ربط الـreceipt بالتحويل.
    await tx
      .update(cashTransfers)
      .set({ sentReceiptId })
      .where(eq(cashTransfers.id, transferId));

    // 9. قيد محاسبي CASH_TRANSFER_OUT.
    await postEntry(tx, {
      entryType: "CASH_TRANSFER_OUT",
      branchId: input.fromBranchId,
      receiptId: sentReceiptId,
      amount,
      dedupeKey: `CT_OUT:${transferNumber}`,
      notes: input.notes ?? undefined,
    });

    // 10. تَسجيل idempotency.
    if (input.clientRequestId) {
      await recordIdempotencyKey(tx, "cashTransfer.send", input.clientRequestId, transferId);
    }

    return { transferId, transferNumber, sentReceiptId };
  });
}

/** استلام التحويل في فرع المستلم. */
export async function receiveTransfer(
  transferId: number,
  actor: Actor,
): Promise<{ transferId: number; receivedReceiptId: number }> {
  return withTx(async (tx) => {
    // 1. قفل الصف ضدّ سباق استلامين متزامنَين.
    const rows = await tx
      .select()
      .from(cashTransfers)
      .where(eq(cashTransfers.id, transferId))
      .for("update")
      .limit(1);
    const t = rows[0];
    if (!t) throw new TRPCError({ code: "NOT_FOUND", message: "التحويل غير موجود" });
    if (t.status !== "IN_TRANSIT") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `الحالة الحالية «${t.status}» لا تَسمح بالاستلام`,
      });
    }

    // 2. الصلاحية + IDOR.
    if (actor.role !== "admin") {
      if (actor.role !== "manager") {
        throw new TRPCError({ code: "FORBIDDEN", message: "الاستلام للمدير فأعلى" });
      }
      if (Number(actor.branchId) !== Number(t.toBranchId)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكنك استلام تحويل لفرع غير فرعك" });
      }
    }

    // 3. SOD: المستلِم ≠ المُرسِل إلا للأدمن.
    if (actor.role !== "admin" && actor.userId === Number(t.sentBy)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "لا يمكن استلام تحويل أرسلته بنفسك (فصل المسؤوليات)",
      });
    }

    const amount = money(t.amount);
    const toBranchId = Number(t.toBranchId);

    // 4. receipt IN في فرع المستلم.
    const recRes = await tx.insert(receipts).values({
      branchId: toBranchId,
      shiftId: null,
      direction: "IN",
      amount: toDbMoney(amount),
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      referenceNumber: t.transferNumber,
      status: "COMPLETED",
      partyType: "OTHER",
      description: `استلام تحويل ${t.transferNumber} من فرع #${t.fromBranchId}`,
      createdBy: actor.userId,
    });
    const receivedReceiptId = extractInsertId(recRes);

    // 5. تحديث الحالة.
    await tx
      .update(cashTransfers)
      .set({
        status: "RECEIVED",
        receivedBy: actor.userId,
        receivedAt: new Date(),
        receivedReceiptId,
      })
      .where(eq(cashTransfers.id, transferId));

    // 6. قيد CASH_TRANSFER_IN.
    await postEntry(tx, {
      entryType: "CASH_TRANSFER_IN",
      branchId: toBranchId,
      receiptId: receivedReceiptId,
      amount,
      dedupeKey: `CT_IN:${t.transferNumber}`,
    });

    return { transferId, receivedReceiptId };
  });
}

/** إلغاء تحويل قبل الاستلام (IN_TRANSIT) — يَكتب receipt تعويضي + قيد معاكس. */
export async function cancelTransfer(
  transferId: number,
  reason: string,
  actor: Actor,
): Promise<{ transferId: number; reversalReceiptId: number }> {
  return withTx(async (tx) => {
    const rows = await tx
      .select()
      .from(cashTransfers)
      .where(eq(cashTransfers.id, transferId))
      .for("update")
      .limit(1);
    const t = rows[0];
    if (!t) throw new TRPCError({ code: "NOT_FOUND", message: "التحويل غير موجود" });
    if (t.status === "RECEIVED") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "لا يمكن إلغاء تحويل مستلَم — أنشئ تحويلاً عكسياً بدلاً من ذلك",
      });
    }
    if (t.status === "CANCELLED") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "التحويل مُلغى مسبقاً" });
    }

    // الصلاحية: المُرسِل نفسه أو admin، أو manager في فرع الإرسال.
    if (actor.role !== "admin") {
      const isManagerOfSource = actor.role === "manager" && Number(actor.branchId) === Number(t.fromBranchId);
      const isSender = actor.userId === Number(t.sentBy);
      if (!isManagerOfSource && !isSender) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكنك إلغاء هذا التحويل" });
      }
    }

    const amount = money(t.amount);
    const fromBranchId = Number(t.fromBranchId);

    // receipt تعويضي IN في فرع الإرسال (يُعيد النقد للخزينة).
    const revRes = await tx.insert(receipts).values({
      branchId: fromBranchId,
      shiftId: null,
      direction: "IN",
      amount: toDbMoney(amount),
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      referenceNumber: `CANCEL-${t.transferNumber}`,
      status: "COMPLETED",
      partyType: "OTHER",
      description: `إلغاء تحويل ${t.transferNumber}${reason ? " — " + reason : ""}`,
      createdBy: actor.userId,
    });
    const reversalReceiptId = extractInsertId(revRes);

    // تحديث الحالة.
    await tx
      .update(cashTransfers)
      .set({
        status: "CANCELLED",
        cancelledBy: actor.userId,
        cancelledAt: new Date(),
        cancellationReason: reason,
        reversalReceiptId,
      })
      .where(eq(cashTransfers.id, transferId));

    // قيد معاكس (يُحيّد CT_OUT الأصلي عبر CT_IN معاكس بـdedupeKey مختلف).
    await postEntry(tx, {
      entryType: "CASH_TRANSFER_IN",
      branchId: fromBranchId,
      receiptId: reversalReceiptId,
      amount,
      dedupeKey: `CT_OUT_REV:${t.transferNumber}`,
      notes: `إلغاء — ${reason}`,
    });

    return { transferId, reversalReceiptId };
  });
}

/** قراءة قائمة التحويلات للفرع (مع فلاتر). */
export interface ListTransfersInput {
  branchId?: number;
  direction?: "INCOMING" | "OUTGOING" | "ALL";
  status?: "IN_TRANSIT" | "RECEIVED" | "CANCELLED";
  from?: string; // YYYY-MM-DD
  to?: string;
  limit?: number;
  offset?: number;
}

export async function listTransfers(
  input: ListTransfersInput,
  scopedBranchId: number | null,
) {
  const db = getDb();
  if (!db) return [];

  const effectiveBranch = scopedBranchId ?? input.branchId ?? null;
  const direction = input.direction ?? "ALL";
  const limit = input.limit && input.limit > 0 && input.limit <= 200 ? input.limit : 50;
  const offset = input.offset && input.offset >= 0 ? input.offset : 0;

  const conds = [];
  if (effectiveBranch != null) {
    if (direction === "INCOMING") {
      conds.push(eq(cashTransfers.toBranchId, effectiveBranch));
    } else if (direction === "OUTGOING") {
      conds.push(eq(cashTransfers.fromBranchId, effectiveBranch));
    } else {
      conds.push(
        or(
          eq(cashTransfers.fromBranchId, effectiveBranch),
          eq(cashTransfers.toBranchId, effectiveBranch),
        ),
      );
    }
  }
  if (input.status) conds.push(eq(cashTransfers.status, input.status));
  if (input.from) conds.push(gte(cashTransfers.sentAt, new Date(input.from + "T00:00:00Z")));
  if (input.to) conds.push(lte(cashTransfers.sentAt, new Date(input.to + "T23:59:59Z")));

  const where = conds.length > 0 ? and(...conds) : undefined;

  const rows = await db
    .select()
    .from(cashTransfers)
    .where(where)
    .orderBy(desc(cashTransfers.sentAt))
    .limit(limit)
    .offset(offset);

  // ضمّ أسماء الفروع (cross-join صغير).
  const branchIds = new Set<number>();
  for (const r of rows) {
    branchIds.add(Number(r.fromBranchId));
    branchIds.add(Number(r.toBranchId));
  }
  const branchList =
    branchIds.size > 0
      ? await db.select().from(branches)
      : [];
  const branchMap = new Map(branchList.map((b) => [Number(b.id), b.name] as const));

  return rows.map((r) => ({
    id: Number(r.id),
    transferNumber: r.transferNumber,
    fromBranchId: Number(r.fromBranchId),
    fromBranchName: branchMap.get(Number(r.fromBranchId)) ?? "—",
    toBranchId: Number(r.toBranchId),
    toBranchName: branchMap.get(Number(r.toBranchId)) ?? "—",
    amount: r.amount,
    status: r.status,
    sentBy: Number(r.sentBy),
    sentAt: r.sentAt instanceof Date ? r.sentAt.toISOString() : String(r.sentAt),
    receivedBy: r.receivedBy ? Number(r.receivedBy) : null,
    receivedAt: r.receivedAt instanceof Date ? r.receivedAt.toISOString() : r.receivedAt,
    cancelledAt: r.cancelledAt instanceof Date ? r.cancelledAt.toISOString() : r.cancelledAt,
    notes: r.notes,
    cancellationReason: r.cancellationReason,
  }));
}
