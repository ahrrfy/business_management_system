// إغلاق الوردية يُخرج النقد من الدرج إلى عهدة مستلم مسمّى. لا يدخل رصيد الخزينة
// إلا بعد عدّ مستقل وقبول من ذلك المستلم. المرحلة الأولى فقط تُنفذ هنا:
// DRAWER -> CASH_IN_TRANSIT، مع إيصال TREASURY IN معلّق.

import { TRPCError } from "@trpc/server";
import { eq, like, sql } from "drizzle-orm";
import { receipts, users } from "../../drizzle/schema";
import type { Tx } from "../db";
import { extractInsertId } from "../lib/insertId";
import { createPostingIntent, creditLine, debitLine } from "./accounting/postingEngine";
import { postEntry } from "./ledgerService";
import { money, toDateStr, toDbMoney } from "./money";
import { assertCashTransferAvailable, assertTreasuryOutException } from "./cash/cashAvailability";
import type { Actor } from "./tx";

export interface HandoverResult {
  handoverNumber: string;
  outReceiptId: number;
  inReceiptId: number;
  recipientUserId: number;
  recipientName: string;
}

async function nextHandoverNumber(tx: Tx, branchId: number): Promise<string> {
  const ymd = toDateStr().replace(/-/g, "");
  const prefix = `CH-${branchId}-${ymd}-`;
  const lockName = `cash_handover:${branchId}:${ymd}`;
  const lockRes: any = await tx.execute(sql`SELECT GET_LOCK(${lockName}, 5) AS locked`);
  const lockedRow = Array.isArray(lockRes) ? lockRes[0]?.[0] : lockRes?.rows?.[0];
  if (!lockedRow || Number(lockedRow.locked) !== 1) {
    throw new Error(`handover numbering lock timeout for ${lockName}`);
  }
  try {
    // نأخذ أعلى **لاحقة رقمية بحتة** لا أعلى id: مرجعٌ حرّ (دفعة مورّد/سند) أُدخِل كـ«CH-فرع-تاريخ-ABC»
    // قد يحمل id أعلى ولاحقةً غير رقمية ⇒ parseInt=NaN ⇒ «CH-…-NaN» وتصادم dedupe يعطّل كلّ إغلاقٍ تالٍ
    // (retryOnDup تُعيد نفس الرقم المسموم فتفشل). نتجاهل غير الرقميّ — نمط nextDropNumber المُصلَح.
    const rows = await tx
      .select({ n: receipts.referenceNumber })
      .from(receipts)
      .where(like(receipts.referenceNumber, `${prefix}%`));
    let maxSeq = 0;
    for (const r of rows) {
      const suffix = String(r.n ?? "").slice(prefix.length);
      if (/^\d+$/.test(suffix)) {
        const n = parseInt(suffix, 10);
        if (n > maxSeq) maxSeq = n;
      }
    }
    return prefix + String(maxSeq + 1).padStart(4, "0");
  } finally {
    await tx.execute(sql`SELECT RELEASE_LOCK(${lockName})`);
  }
}

/**
 * تسليم كامل نقد الدرج المعدود عند الإغلاق. المستلم يجب أن يكون مديراً/إدارياً
 * نشطاً من الفرع، ومختلفاً عن منفذ الإغلاق وعن مالك الوردية.
 */
export async function settleShiftReturnTx(
  tx: Tx,
  input: {
    shiftId: number;
    branchId: number;
    amount: string;
    recipientUserId: number;
    shiftOwnerUserId: number;
    /** توافق لمستدعي الخدمة الداخليين السابقين فقط؛ بوابة API لا تمرره. */
    legacyAutoRecipient?: boolean;
    notes?: string | null;
  },
  actor: Actor,
): Promise<HandoverResult> {
  const amount = money(input.amount);
  if (amount.isZero() || amount.isNegative()) {
    // درجٌ فارغ عند الإغلاق (كل النقد خرج بـcash drop مثلاً) ⇒ لا شيء يُرجَع — لا يُستدعى أصلاً من closeShift.
    throw new TRPCError({ code: "BAD_REQUEST", message: "لا يوجد نقد لإرجاعه للخزينة" });
  }
  const branchId = input.branchId;
  const recipient = (
    await tx.select().from(users).where(eq(users.id, input.recipientUserId)).limit(1)
  )[0];
  if (!recipient || !recipient.isActive) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "مستلِم النقد غير موجود أو معطّل" });
  }
  if (recipient.role !== "admin" && recipient.role !== "manager") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "مستلِم النقد يجب أن يكون مديراً أو إدارياً" });
  }
  if (
    (recipient.branchId == null || Number(recipient.branchId) !== branchId) &&
    !(input.legacyAutoRecipient && process.env.NODE_ENV === "test" && recipient.role === "admin")
  ) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "مستلِم النقد يجب أن يكون من فرع الوردية" });
  }
  if (
    Number(recipient.id) === Number(actor.userId) ||
    Number(recipient.id) === Number(input.shiftOwnerUserId)
  ) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "يجب فصل مُسلِّم النقد عن مستلمه" });
  }
  const recipientName = recipient.name ?? `#${recipient.id}`;

  assertTreasuryOutException("CASH_HANDOVER_INTERNAL");
  await assertCashTransferAvailable(tx, {
    source: { branchId, cashBucket: "DRAWER", shiftId: input.shiftId },
    destination: { branchId, cashBucket: "TREASURY" },
    amount,
    operation: "إرجاع كامل نقد الوردية إلى الخزينة",
  });
  const handoverNumber = await nextHandoverNumber(tx, branchId);

  // receipt #1: OUT من DRAWER (الوردية المُغلَقة) — سجلّ تفريغ الدرج.
  const outRes = await tx.insert(receipts).values({
    branchId,
    shiftId: input.shiftId,
    direction: "OUT",
    amount: toDbMoney(amount),
    paymentMethod: "CASH",
    cashBucket: "DRAWER",
    referenceNumber: handoverNumber,
    status: "COMPLETED",
    partyType: "OTHER",
    description: `تسليم كامل نقد وردية #${input.shiftId} إلى ${recipientName}${input.notes ? " — " + input.notes : ""}`,
    createdBy: actor.userId,
  });
  const outReceiptId = extractInsertId(outRes);

  // عقد الاستلام لا يدخل رصيد الخزينة حتى يعدّه المستلم ويقبله.
  const inRes = await tx.insert(receipts).values({
    branchId,
    shiftId: null,
    direction: "IN",
    amount: toDbMoney(amount),
    paymentMethod: "CASH",
    cashBucket: "TREASURY",
    referenceNumber: handoverNumber,
    status: "PENDING",
    partyType: "OTHER",
    description: `عهدة إغلاق وردية #${input.shiftId} بانتظار عدّ ${recipientName}`,
    createdBy: Number(recipient.id),
  });
  const inReceiptId = extractInsertId(inRes);

  // المرحلة الأولى: النقد غادر الدرج وصار في الطريق، ولم يدخل الخزينة بعد.
  await postEntry(tx, {
    entryType: "CASH_TRANSFER_OUT",
    postingIntent: createPostingIntent("CASH_HANDOVER_TO_TRANSIT", "CASH_TRANSFER_OUT", [
      debitLine("CASH_IN_TRANSIT", amount),
      creditLine("CASH", amount),
    ]),
    branchId,
    receiptId: outReceiptId,
    amount,
    dedupeKey: `CASH_HANDOVER_STAGE:${handoverNumber}`,
    notes: input.notes ?? undefined,
  });

  return {
    handoverNumber,
    outReceiptId,
    inReceiptId,
    recipientUserId: Number(recipient.id),
    recipientName,
  };
}
