// خدمة تسليم وردية → خزينة (treasury-stage2).
// نمط: نقل بين دلوَي DRAWER → TREASURY داخل نفس الفرع. لا يَمسّ AR/AP.
// تُستدعى من داخل withTx لـcloseShift (لا nested tx).
// القيد المحاسبي CASH_HANDOVER لا يَدخل تقارير الإيراد (revenue=cost=0).

import { TRPCError } from "@trpc/server";
import { desc, eq, like, sql } from "drizzle-orm";
import { receipts, shifts, users } from "../../drizzle/schema";
import type { Tx } from "../db";
import { extractInsertId } from "../lib/insertId";
import { postEntry } from "./ledgerService";
import { money, toDateStr, toDbMoney } from "./money";
import type { Actor } from "./tx";

export interface HandoverInput {
  shiftId: number;
  amount: string; // > 0
  handoverTo: number; // userId المستلِم (admin/manager)
  notes?: string | null;
}

export interface HandoverResult {
  handoverNumber: string;
  outReceiptId: number;
  inReceiptId: number;
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
    const rows = await tx
      .select({ n: receipts.referenceNumber })
      .from(receipts)
      .where(like(receipts.referenceNumber, `${prefix}%`))
      .orderBy(desc(receipts.id))
      .limit(1);
    const last = rows[0]?.n;
    const seq = last ? parseInt(String(last).slice(prefix.length), 10) + 1 : 1;
    return prefix + String(seq).padStart(4, "0");
  } finally {
    await tx.execute(sql`SELECT RELEASE_LOCK(${lockName})`);
  }
}

/**
 * إنشاء سند تسليم نقد من الكاشير إلى الخزينة الإدارية داخل نفس الفرع.
 * يَستهلك tx مُمرَّرة من closeShift (نفس المعاملة لضمان الذرّية الكاملة).
 */
export async function createHandover(
  tx: Tx,
  input: HandoverInput,
  actor: Actor,
): Promise<HandoverResult> {
  // 1. تحقّق من الوردية (OPEN + ضمن المعاملة).
  const sh = (await tx.select().from(shifts).where(eq(shifts.id, input.shiftId)).limit(1))[0];
  if (!sh) throw new TRPCError({ code: "NOT_FOUND", message: "الوردية غير موجودة" });
  if (sh.status !== "OPEN") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الوردية مغلقة بالفعل — لا يمكن تسليم نقد منها" });
  }

  // 2. تحقّق من المستلِم: موجود + نشط + دوره admin/manager.
  const recipient = (
    await tx.select().from(users).where(eq(users.id, input.handoverTo)).limit(1)
  )[0];
  if (!recipient || !recipient.isActive) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "المستلِم غير موجود أو معطّل" });
  }
  if (recipient.role !== "admin" && recipient.role !== "manager") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "مستلِم النقد يَجب أن يَكون مديراً أو إدارياً (admin/manager) — لا كاشير",
    });
  }

  // 3. الفاعل: الكاشير صاحب الوردية، أو admin/manager في نفس الفرع.
  const branchId = Number(sh.branchId);
  if (actor.role !== "admin") {
    if (actor.role === "manager") {
      if (Number(actor.branchId) !== branchId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكنك تسليم نقد من وردية فرع آخر" });
      }
    } else {
      if (Number(sh.userId) !== actor.userId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكنك تسليم نقد من وردية موظّف آخر" });
      }
    }
  }

  // 4. المبلغ موجب.
  const amount = money(input.amount);
  if (amount.isZero() || amount.isNegative()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "المبلغ يَجب أن يَكون موجباً" });
  }

  // 5. توليد رقم السند CH-... (idempotent على مستوى الفرع/اليوم).
  const handoverNumber = await nextHandoverNumber(tx, branchId);

  // 6. receipt #1: OUT من DRAWER (الوردية).
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
    description: `تسليم وردية #${input.shiftId} للخزينة (المستلِم: ${recipient.name ?? recipient.id})${input.notes ? " — " + input.notes : ""}`,
    createdBy: actor.userId,
  });
  const outReceiptId = extractInsertId(outRes);

  // 7. receipt #2: IN إلى TREASURY (شيء بلا shiftId — لا يَدخل Z-report).
  const inRes = await tx.insert(receipts).values({
    branchId,
    shiftId: null,
    direction: "IN",
    amount: toDbMoney(amount),
    paymentMethod: "CASH",
    cashBucket: "TREASURY",
    referenceNumber: handoverNumber,
    status: "COMPLETED",
    partyType: "OTHER",
    description: `استلام من وردية #${input.shiftId} (المُسلِّم: ${actor.userId})${input.notes ? " — " + input.notes : ""}`,
    createdBy: input.handoverTo, // المستلِم هو من ينسب إليه إيصال الاستلام
  });
  const inReceiptId = extractInsertId(inRes);

  // 8. قيد محاسبي CASH_HANDOVER واحد (لا يَمسّ revenue/cost).
  await postEntry(tx, {
    entryType: "CASH_HANDOVER",
    branchId,
    receiptId: outReceiptId,
    amount,
    dedupeKey: `CASH_HANDOVER:${handoverNumber}`,
    notes: input.notes ?? undefined,
  });

  return { handoverNumber, outReceiptId, inReceiptId };
}
