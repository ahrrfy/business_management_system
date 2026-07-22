// خدمة «السحب النقديّ أثناء الوردية» (cash drop) — نقلٌ **مِن درج الكاشير إلى الخزينة** في منتصف
// الوردية لتقليل مخاطرة تكدّس النقد (يوم مبيعاتٍ كبير). البند التالي من «ضبط دورة النقد اليومية»
// (docs/functional-audit-2026-07-17.md §٥).
//
// نمطٌ مطابقٌ لـcashHandoverService.createHandover (نقل DRAWER→TREASURY بلا مسّ AR/AP، القيد
// CASH_HANDOVER محايدٌ للربح) لكن:
//  • قائمٌ بذاته (لا يُستدعى من closeShift) وقابلٌ للتكرار عدّة مرّات في الوردية الواحدة.
//  • على وردية **مفتوحة** فقط.
//  • رقم سند «CD-فرع-تاريخ-تسلسل» (يميّزه عن تسليم الإغلاق CH-…).
//  • **حدّ الدرج:** المبلغ ≤ النقد الحاليّ في الدرج (opening + Σ(IN) − Σ(OUT) نقدُ الدرج، بلا فلتر
//    حالة — مطابقةً لـcomputeExpectedCash) ⇒ لا يمكن سحب أكثر ممّا في الدرج فعلاً.
//
// ⚠️ **أثر المطابقة:** خلافاً لتسليم الإغلاق (يُحسَب expectedCash قبله فيُستثنى)، السحب يقع **أثناء**
//   الوردية فيُدرَج طبيعياً في computeExpectedCash (أيّ إخراج نقديّ من الدرج) ⇒ يُنقِص المتوقَّع، والنقد
//   المعدود عند الإغلاق يُنقِص بالمثل (النقد غادر الدرج فعلاً) ⇒ **الفرق (drift) لا يتأثّر**. تقرير إقفال
//   اليوم يصنّفه في دلو `cashDrops` (ضمن الخارج التشغيليّ الذي يُنقِص المتوقَّع).
import { TRPCError } from "@trpc/server";
import { and, desc, eq, like, sql } from "drizzle-orm";
import { receipts, shifts, users } from "../../drizzle/schema";
import type { Tx } from "../db";
import { extractInsertId } from "../lib/insertId";
import { postEntry } from "./ledgerService";
import { money, toDateStr, toDbMoney } from "./money";
import { withTx, type Actor } from "./tx";

export interface CashDropInput {
  shiftId: number;
  amount: string; // > 0
  /** مستلِمٌ اختياريّ (مدير/إداريّ يتسلّم عهدة النقد للخزينة). بدونه: يُنسَب إيصال الاستلام للفاعل. */
  dropTo?: number | null;
  notes?: string | null;
}

export interface CashDropResult {
  dropNumber: string;
  outReceiptId: number;
  inReceiptId: number;
  drawerBefore: string; // النقد في الدرج قبل السحب
  drawerAfter: string;  // بعده (= before − amount)
}

/** ترقيم سند السحب CD-فرع-تاريخ-تسلسل (idempotent على مستوى الفرع/اليوم عبر GET_LOCK + آخر رقم). */
async function nextDropNumber(tx: Tx, branchId: number): Promise<string> {
  const ymd = toDateStr().replace(/-/g, "");
  const prefix = `CD-${branchId}-${ymd}-`;
  const lockName = `cash_drop:${branchId}:${ymd}`;
  const lockRes: any = await tx.execute(sql`SELECT GET_LOCK(${lockName}, 5) AS locked`);
  const lockedRow = Array.isArray(lockRes) ? lockRes[0]?.[0] : lockRes?.rows?.[0];
  if (!lockedRow || Number(lockedRow.locked) !== 1) {
    throw new Error(`cash drop numbering lock timeout for ${lockName}`);
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
 * النقد الحاليّ في درج الوردية = الرصيد الافتتاحيّ + Σ(IN نقد درج) − Σ(OUT نقد درج).
 * بلا فلتر حالة (مطابقةً لـshiftService.computeExpectedCash — العكوس تُصافَر بإيصالٍ تعويضيّ).
 */
async function currentDrawerCash(tx: Tx, shiftId: number, openingBalance: string) {
  const rows = await tx
    .select({
      cashIn: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'IN' AND ${receipts.paymentMethod} = 'CASH' THEN ${receipts.amount} ELSE 0 END), 0)`,
      cashOut: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'OUT' AND ${receipts.paymentMethod} = 'CASH' THEN ${receipts.amount} ELSE 0 END), 0)`,
    })
    .from(receipts)
    .where(and(eq(receipts.shiftId, shiftId), eq(receipts.cashBucket, "DRAWER")));
  const cashIn = money(rows[0]?.cashIn ?? "0");
  const cashOut = money(rows[0]?.cashOut ?? "0");
  return money(openingBalance).plus(cashIn).minus(cashOut);
}

/**
 * تسجيل سحبٍ نقديّ من درج وردية مفتوحة إلى الخزينة الإدارية. مستقلٌّ (يُنشئ withTx الخاص به)،
 * ويجوز استدعاؤه ضمن tx مُمرَّرة (لإعادة الاستعمال). يطابق حوكمة closeShift/createHandover.
 */
export async function createCashDrop(
  input: CashDropInput,
  actor: Actor & { role?: string },
  outerTx?: Tx,
): Promise<CashDropResult> {
  const run = (tx: Tx) => cashDropTx(tx, input, actor);
  return outerTx ? run(outerTx) : withTx(run);
}

async function cashDropTx(tx: Tx, input: CashDropInput, actor: Actor & { role?: string }): Promise<CashDropResult> {
  // 1. الوردية: موجودة + مفتوحة (تحت القفل — يمنع سحباً بالتزامن مع الإغلاق).
  const sh = (await tx.select().from(shifts).where(eq(shifts.id, input.shiftId)).for("update").limit(1))[0];
  if (!sh) throw new TRPCError({ code: "NOT_FOUND", message: "الوردية غير موجودة" });
  if (sh.status !== "OPEN") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الوردية مغلقة — لا يمكن السحب منها" });
  }

  // 2. الحوكمة (مرآة closeShift/createHandover): admin مرور حرّ؛ manager فرعه؛ الكاشير وردية نفسه في فرعه.
  const branchId = Number(sh.branchId);
  const role = actor.role ?? "cashier";
  if (role === "admin") {
    // مرور حرّ
  } else if (role === "manager") {
    if (Number(actor.branchId) !== branchId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكنك السحب من وردية فرع آخر" });
    }
  } else {
    if (Number(sh.userId) !== actor.userId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكنك السحب من وردية موظّف آخر" });
    }
    if (Number(actor.branchId) !== branchId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكنك السحب من وردية فرع آخر" });
    }
  }

  // 3. المبلغ موجب.
  const amount = money(input.amount);
  if (amount.isZero() || amount.isNegative()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "المبلغ يجب أن يكون موجباً" });
  }

  // 4. حدّ الدرج: لا يُسحَب أكثر من النقد الحاليّ فيه.
  const drawer = await currentDrawerCash(tx, input.shiftId, sh.openingBalance);
  if (amount.gt(drawer)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `لا يمكن سحب أكثر من النقد في الدرج (المتاح ${drawer.toFixed(2)} < المطلوب ${amount.toFixed(2)})`,
    });
  }

  // 5. المستلِم الاختياريّ: إن مُرِّر يجب أن يكون مديراً/إدارياً نشطاً (مرآة تحقّق التسليم).
  let recipientId: number | null = null;
  let recipientName: string | null = null;
  if (input.dropTo != null) {
    const recipient = (await tx.select().from(users).where(eq(users.id, input.dropTo)).limit(1))[0];
    if (!recipient || !recipient.isActive) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "المستلِم غير موجود أو معطّل" });
    }
    if (recipient.role !== "admin" && recipient.role !== "manager") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "مستلِم النقد يجب أن يكون مديراً أو إدارياً (admin/manager)" });
    }
    recipientId = Number(recipient.id);
    recipientName = recipient.name ?? `#${recipient.id}`;
  }

  // 6. رقم السند CD-…
  const dropNumber = await nextDropNumber(tx, branchId);
  const noteSuffix = input.notes ? " — " + input.notes : "";

  // 7. receipt #1: OUT من DRAWER (الوردية) — يُنقِص متوقَّع الدرج طبيعياً.
  const outRes = await tx.insert(receipts).values({
    branchId,
    shiftId: input.shiftId,
    direction: "OUT",
    amount: toDbMoney(amount),
    paymentMethod: "CASH",
    cashBucket: "DRAWER",
    referenceNumber: dropNumber,
    status: "COMPLETED",
    partyType: "OTHER",
    description: `سحب نقديّ من وردية #${input.shiftId} للخزينة${recipientName ? ` (المستلِم: ${recipientName})` : ""}${noteSuffix}`,
    createdBy: actor.userId,
  });
  const outReceiptId = extractInsertId(outRes);

  // 8. receipt #2: IN إلى TREASURY (shiftId=null ⇒ خارج Z-report). يُنسَب للمستلِم إن وُجد وإلا للفاعل.
  const inRes = await tx.insert(receipts).values({
    branchId,
    shiftId: null,
    direction: "IN",
    amount: toDbMoney(amount),
    paymentMethod: "CASH",
    cashBucket: "TREASURY",
    referenceNumber: dropNumber,
    status: "COMPLETED",
    partyType: "OTHER",
    description: `استلام سحبٍ نقديّ من وردية #${input.shiftId} (المُسلِّم: ${actor.userId})${noteSuffix}`,
    createdBy: recipientId ?? actor.userId,
  });
  const inReceiptId = extractInsertId(inRes);

  // 9. قيد CASH_HANDOVER (نقلٌ بين دلوَين، revenue/cost=0). dedupeKey بلاحقة CASH_DROP يميّزه عن التسليم.
  await postEntry(tx, {
    entryType: "CASH_HANDOVER",
    branchId,
    receiptId: outReceiptId,
    amount,
    dedupeKey: `CASH_DROP:${dropNumber}`,
    notes: input.notes ?? undefined,
  });

  return {
    dropNumber,
    outReceiptId,
    inReceiptId,
    drawerBefore: toDbMoney(drawer),
    drawerAfter: toDbMoney(drawer.minus(amount)),
  };
}
