/* ============================================================================
 * الأهداف الشهرية للموظفين (salesTargets) — وحدة الأهداف والعمولات (S2).
 *
 * هدف واحد لكل (موظف × شهر) — uq_target_emp_period هو الحارس البنيوي والحفظ upsert عليه.
 * الشبكة تعرض الموظفين المؤهَّلين فقط (مرتبطون بحساب مستخدم + غير منتهي الخدمة) مع
 * «فعليّ الشهر السابق» مرجعاً استرشادياً من كنسة الوعاء المشتركة (base.ts).
 * ========================================================================== */
import { TRPCError } from "@trpc/server";
import { and, asc, eq, sql } from "drizzle-orm";
import { fullEmployeeName } from "@shared/hr";
import { branches, employees, salesTargets } from "../../../drizzle/schema";
import { money, toDbMoney } from "../money";
import { requireDb, withTx, type Actor } from "../tx";
import { computeNetSalesByUser } from "./base";
import { assertPeriod, prevPeriod } from "./period";

export interface TargetGridRow {
  employeeId: number;
  employeeName: string;
  position: string | null;
  branchName: string | null;
  employmentStatus: "active" | "leave" | "terminated";
  /** صافي مبيعات الموظف الفعلي في الشهر السابق (مرجع استرشادي). */
  lastMonthActual: string;
  /** هدف الشهر المطلوب (null = لم يُحدَّد بعد). */
  target: string | null;
}

/** شبكة أهداف الشهر: الموظفون المؤهَّلون + هدفهم الحالي + فعليّ الشهر السابق. */
export async function getTargetsGrid(period: string): Promise<TargetGridRow[]> {
  const p = assertPeriod(period);
  const db = requireDb();

  const rows = await db
    .select({
      employeeId: employees.id,
      userId: employees.userId,
      firstName: employees.firstName,
      fatherName: employees.fatherName,
      grandfatherName: employees.grandfatherName,
      lastName: employees.lastName,
      position: employees.position,
      employmentStatus: employees.employmentStatus,
      branchName: branches.name,
      target: salesTargets.targetAmount,
    })
    .from(employees)
    .leftJoin(branches, eq(branches.id, employees.branchId))
    .leftJoin(salesTargets, and(eq(salesTargets.employeeId, employees.id), eq(salesTargets.period, p)))
    .where(and(sql`${employees.userId} IS NOT NULL`, sql`${employees.employmentStatus} <> 'terminated'`))
    .orderBy(asc(employees.firstName));

  const lastMonth = await computeNetSalesByUser(db, prevPeriod(p));

  return rows.map((r) => {
    const base = r.userId != null ? lastMonth.get(Number(r.userId)) : undefined;
    const actual = base ? base.sales.minus(base.returns) : money(0);
    return {
      employeeId: Number(r.employeeId),
      employeeName: fullEmployeeName(r),
      position: r.position ?? null,
      branchName: r.branchName ?? null,
      employmentStatus: r.employmentStatus,
      lastMonthActual: toDbMoney(actual),
      target: r.target ?? null,
    };
  });
}

export interface SaveTargetsInput {
  period: string;
  /** target=null ⇒ حذف هدف الموظف لهذا الشهر. */
  rows: { employeeId: number; target: string | null }[];
}

/** حفظ أهداف الشهر دفعةً واحدة — upsert على uq_target_emp_period داخل معاملة واحدة. */
export async function saveTargets(input: SaveTargetsInput, actor: Actor): Promise<{ saved: number; removed: number }> {
  const p = assertPeriod(input.period);
  if (!Array.isArray(input.rows) || input.rows.length === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "لا صفوف للحفظ." });
  }
  return withTx(async (tx) => {
    let saved = 0;
    let removed = 0;
    for (const row of input.rows) {
      if (row.target == null || row.target.trim() === "") {
        const res = await tx
          .delete(salesTargets)
          .where(and(eq(salesTargets.employeeId, row.employeeId), eq(salesTargets.period, p)));
        removed += (res as unknown as [{ affectedRows: number }])[0]?.affectedRows ?? 0;
        continue;
      }
      const t = money(row.target);
      if (t.lte(0)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "الهدف يجب أن يكون أكبر من صفر (أو اتركه فارغاً لحذفه)." });
      }
      const [emp] = await tx
        .select({ id: employees.id, userId: employees.userId })
        .from(employees)
        .where(eq(employees.id, row.employeeId))
        .limit(1);
      if (!emp) throw new TRPCError({ code: "NOT_FOUND", message: `موظف غير موجود (${row.employeeId}).` });
      if (emp.userId == null) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "لا هدف لموظف بلا حساب مستخدم — نسبة المبيعات تتبع الحساب." });
      }
      await tx
        .insert(salesTargets)
        .values({ employeeId: row.employeeId, period: p, targetAmount: toDbMoney(t), createdBy: actor.userId })
        .onDuplicateKeyUpdate({ set: { targetAmount: toDbMoney(t) } });
      saved++;
    }
    return { saved, removed };
  });
}

export interface CopyTargetsInput {
  period: string;
  /** false ⇒ يُرفض CONFLICT إن كانت للشهر أهداف قائمة (الواجهة تسأل ثم تعيد بـtrue). */
  overwrite: boolean;
}

/** نسخ أهداف الشهر السابق إلى هذا الشهر (للموظفين الذين ما زالوا مؤهَّلين). */
export async function copyTargetsFromPrevious(input: CopyTargetsInput, actor: Actor): Promise<{ copied: number }> {
  const p = assertPeriod(input.period);
  const prev = prevPeriod(p);
  return withTx(async (tx) => {
    const prevRows = await tx
      .select({ employeeId: salesTargets.employeeId, targetAmount: salesTargets.targetAmount })
      .from(salesTargets)
      .innerJoin(employees, eq(employees.id, salesTargets.employeeId))
      .where(
        and(
          eq(salesTargets.period, prev),
          sql`${employees.userId} IS NOT NULL`,
          sql`${employees.employmentStatus} <> 'terminated'`,
        ),
      );
    if (prevRows.length === 0) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `لا أهداف في الشهر السابق (${prev}) لنسخها.` });
    }
    if (!input.overwrite) {
      const [existing] = await tx
        .select({ cnt: sql<number>`COUNT(*)` })
        .from(salesTargets)
        .where(eq(salesTargets.period, p));
      if (Number(existing?.cnt ?? 0) > 0) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `لهذا الشهر ${existing.cnt} هدفاً قائماً — أكِّد الكتابة فوقها.`,
        });
      }
    }
    for (const r of prevRows) {
      await tx
        .insert(salesTargets)
        .values({ employeeId: Number(r.employeeId), period: p, targetAmount: r.targetAmount, createdBy: actor.userId })
        .onDuplicateKeyUpdate({ set: { targetAmount: r.targetAmount } });
    }
    return { copied: prevRows.length };
  });
}
