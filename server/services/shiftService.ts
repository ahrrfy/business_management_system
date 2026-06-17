import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";
import { invoices, receipts, shifts } from "../../drizzle/schema";
import { getDb } from "../db";
import { money, toDbMoney } from "./money";
import type { Tx } from "../db";
import { withTx, type Actor } from "./tx";
import { extractInsertId } from "../lib/insertId";

/** Open a cashier shift. One open shift per user per branch. */
export async function openShift(input: { branchId: number; openingBalance: string }, actor: Actor) {
  return withTx(async (tx) => {
    const existing = await tx
      .select({ id: shifts.id })
      .from(shifts)
      .where(and(eq(shifts.userId, actor.userId), eq(shifts.branchId, input.branchId), eq(shifts.status, "OPEN")))
      .limit(1);
    if (existing[0]) {
      throw new TRPCError({ code: "CONFLICT", message: "لديك وردية مفتوحة بالفعل في هذا الفرع" });
    }
    try {
      const res = await tx.insert(shifts).values({
        branchId: input.branchId,
        userId: actor.userId,
        openingBalance: toDbMoney(input.openingBalance),
        status: "OPEN",
        openGuard: `${actor.userId}:${input.branchId}`, // حارس ذرّي ضدّ الفتح المزدوج المتزامن
      });
      const shiftId = extractInsertId(res);
      return { shiftId };
    } catch (e: any) {
      if (e?.code === "ER_DUP_ENTRY") {
        throw new TRPCError({ code: "CONFLICT", message: "لديك وردية مفتوحة بالفعل في هذا الفرع" });
      }
      throw e;
    }
  });
}

/** Expected cash = opening balance + cash received − cash refunded during the shift. */
async function computeExpectedCash(tx: Tx, shiftId: number, openingBalance: string) {
  const rows = await tx
    .select({
      cashIn: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'IN' AND ${receipts.paymentMethod} = 'CASH' THEN ${receipts.amount} ELSE 0 END), 0)`,
      cashOut: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'OUT' AND ${receipts.paymentMethod} = 'CASH' THEN ${receipts.amount} ELSE 0 END), 0)`,
    })
    .from(receipts)
    .where(eq(receipts.shiftId, shiftId));
  const cashIn = money(rows[0]?.cashIn ?? "0");
  const cashOut = money(rows[0]?.cashOut ?? "0");
  return money(openingBalance).plus(cashIn).minus(cashOut);
}

/**
 * Close a shift: compute expected cash, record counted cash + variance.
 * سياسة #14 — ملكية/فرع: الكاشير يُغلق ورديته نفسها فقط؛ المدير يُغلق أي وردية في فرعه
 * (لمعالجة الوردية المنسيّة)؛ admin مرور حر.
 */
export async function closeShift(
  input: { shiftId: number; countedCash: string },
  actor: Actor & { role?: string },
) {
  return withTx(async (tx) => {
    const rows = await tx.select().from(shifts).where(eq(shifts.id, input.shiftId)).for("update").limit(1);
    const sh = rows[0];
    if (!sh) throw new TRPCError({ code: "NOT_FOUND", message: "الوردية غير موجودة" });
    if (sh.status !== "OPEN") throw new TRPCError({ code: "BAD_REQUEST", message: "الوردية مغلقة بالفعل" });

    const role = actor.role ?? "cashier";
    if (role === "admin") {
      // مرور حر — للمعالجة العابرة للفروع.
    } else if (role === "manager") {
      if (Number(sh.branchId) !== actor.branchId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكنك إغلاق وردية فرع آخر" });
      }
    } else {
      if (Number(sh.userId) !== actor.userId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكنك إغلاق وردية موظّف آخر" });
      }
      if (Number(sh.branchId) !== actor.branchId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكنك إغلاق وردية فرع آخر" });
      }
    }

    const expected = await computeExpectedCash(tx, input.shiftId, sh.openingBalance);
    const counted = money(input.countedCash);
    const variance = counted.minus(expected);

    await tx
      .update(shifts)
      .set({
        status: "CLOSED",
        closedAt: new Date(),
        openGuard: null, // يحرّر الحارس ⇒ يسمح بفتح وردية جديدة لنفس الموظّف/الفرع
        expectedCash: toDbMoney(expected),
        countedCash: toDbMoney(counted),
        variance: toDbMoney(variance),
      })
      .where(eq(shifts.id, input.shiftId));

    return {
      shiftId: input.shiftId,
      openingBalance: toDbMoney(sh.openingBalance),
      expectedCash: toDbMoney(expected),
      countedCash: toDbMoney(counted),
      variance: toDbMoney(variance),
    };
  });
}

/** Z-report data: payment breakdown + sales totals for the shift. */
export async function getShiftReport(shiftId: number) {
  const db = getDb();
  if (!db) return null;
  const sh = (await db.select().from(shifts).where(eq(shifts.id, shiftId)).limit(1))[0];
  if (!sh) return null;

  const payments = await db
    .select({
      method: receipts.paymentMethod,
      direction: receipts.direction,
      total: sql<string>`COALESCE(SUM(${receipts.amount}), 0)`,
      count: sql<number>`COUNT(*)`,
    })
    .from(receipts)
    .where(eq(receipts.shiftId, shiftId))
    .groupBy(receipts.paymentMethod, receipts.direction);

  const inv = (
    await db
      .select({ count: sql<number>`COUNT(*)`, total: sql<string>`COALESCE(SUM(${invoices.total}), 0)` })
      .from(invoices)
      .where(eq(invoices.shiftId, shiftId))
  )[0];

  return {
    shift: sh,
    payments,
    invoiceCount: Number(inv?.count ?? 0),
    salesTotal: inv?.total ?? "0.00",
  };
}

/** The user's currently open shift in a branch, if any. */
export async function getOpenShift(userId: number, branchId: number) {
  const db = getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(shifts)
    .where(and(eq(shifts.userId, userId), eq(shifts.branchId, branchId), eq(shifts.status, "OPEN")))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * معرّف وردية الموظّف المفتوحة في فرعٍ ما، مرتبط بالمعاملة — لنسب إيصالات الصندوق (نقد داخل/خارج)
 * إلى الوردية فيتوازن الـZ-report. يُرجع null إن لم تكن للموظّف وردية مفتوحة (لا شيء يُنسَب).
 */
export async function openShiftIdTx(tx: Tx, userId: number, branchId: number): Promise<number | null> {
  const rows = await tx
    .select({ id: shifts.id })
    .from(shifts)
    .where(and(eq(shifts.userId, userId), eq(shifts.branchId, branchId), eq(shifts.status, "OPEN")))
    .limit(1);
  return rows[0] ? Number(rows[0].id) : null;
}

/**
 * مرآة صارمة لـopenShiftIdTx: ترمي PRECONDITION_FAILED بدل الإرجاع null حين تكون الوردية مغلقة.
 *
 * تُستعمل قبل كل معاملة نقدية تَلمس صندوق الكاشير (مصاريف/سندات بـpaymentMethod='CASH')
 * كي لا تُكتب receipts بـshiftId=null تختفي من Z-report (computeExpectedCash يفلتر
 * بـeq(receipts.shiftId, shiftId)) ⇒ خسارة نقد صامتة + فروقات ظالمة عند الإقفال.
 *
 * المعاملات غير النقدية (BANK/CARD/CHEQUE/TRANSFER/WALLET) لا تَستعملها — لأنها لا تَمسّ الصندوق
 * فيمكن أن تُحفَظ بـshiftId=null مشروعاً (مثل سند بنكي للمورد بلا فتح وردية).
 */
export async function requireOpenShiftIdTx(
  tx: Tx,
  userId: number,
  branchId: number,
  label: string = "معاملة نقدية",
): Promise<number> {
  const id = await openShiftIdTx(tx, userId, branchId);
  if (id == null) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `افتح وردية في هذا الفرع قبل تسجيل ${label} (وإلا تختفي المعاملة من تسوية الصندوق).`,
    });
  }
  return id;
}
