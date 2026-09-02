/* ============================================================================
 * دورة حياة تشغيلات العمولة (S3): قراءة + اعتماد نهائي + حذف مسودة لم تدخل الحوكمة.
 *
 * الحالات: draft → approved فقط — «الدفع» ليس هنا: مسيّر الرواتب يلتقط التشغيلة
 * المعتمدة لنفس الشهر (S4) ويثبّت payrollRunId (فكّه التلقائي بحذف مسودة المسيّر
 * عبر ON DELETE SET NULL).
 *
 * SOD (مرآة الرواتب): المعتمِد ≠ المحتسِب (createdBy) — FORBIDDEN وإلا.
 * حارس الرواتب: لا اعتماد وثمة مسيّر معتمد/مدفوع للشهر نفسه (فات قطار الالتقاط —
 * يُعاد المسيّر مسودةً أولاً)؛ مسيّر «مسودة» قائم ⇒ الاعتماد يمرّ مع علم
 * requiresPayrollRegeneration كي تنبّه الواجهة لإعادة توليده.
 * الاعتماد append-only: لا يعود لمسودة، ودليل طلب/قرار الاعتماد يمنع حذف الرأس.
 * ========================================================================== */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { fullEmployeeName } from "@shared/hr";
import {
  commissionPlans,
  commissionRunApprovalRequests,
  commissionRunLines,
  commissionRuns,
  employees,
  payrollRuns,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { requireDb, withTx, type Actor } from "../tx";

export async function listRuns(scopedBranchId: number | null = null) {
  const db = requireDb();
  const runs = await db.select().from(commissionRuns).orderBy(desc(commissionRuns.period), desc(commissionRuns.id));
  if (scopedBranchId == null || runs.length === 0) return runs;
  const scopedTotals = await db
    .select({
      runId: commissionRunLines.runId,
      employeeCount: sql<number>`COUNT(*)`,
      totalBaseSales: sql<string>`CAST(COALESCE(SUM(${commissionRunLines.baseSales}), 0) AS CHAR)`,
      totalBaseReturns: sql<string>`CAST(COALESCE(SUM(${commissionRunLines.baseReturns}), 0) AS CHAR)`,
      totalCommission: sql<string>`CAST(COALESCE(SUM(${commissionRunLines.commissionAmount}), 0) AS CHAR)`,
    })
    .from(commissionRunLines)
    .where(eq(commissionRunLines.branchId, scopedBranchId))
    .groupBy(commissionRunLines.runId);
  const byRun = new Map(scopedTotals.map((row) => [Number(row.runId), row]));
  return runs.flatMap((run) => {
    const totals = byRun.get(Number(run.id));
    return totals
      ? [{
          ...run,
          employeeCount: Number(totals.employeeCount),
          totalBaseSales: totals.totalBaseSales,
          totalBaseReturns: totals.totalBaseReturns,
          totalCommission: totals.totalCommission,
        }]
      : [];
  });
}

export async function getRun(id: number, scopedBranchId: number | null = null) {
  const db = requireDb();
  const [run] = await db.select().from(commissionRuns).where(eq(commissionRuns.id, id)).limit(1);
  if (!run) return null;
  const lines = await db
    .select({
      id: commissionRunLines.id,
      employeeId: commissionRunLines.employeeId,
      userId: commissionRunLines.userId,
      branchId: commissionRunLines.branchId,
      baseSales: commissionRunLines.baseSales,
      baseReturns: commissionRunLines.baseReturns,
      baseConsignDeduction: commissionRunLines.baseConsignDeduction,
      carryIn: commissionRunLines.carryIn,
      effectiveBase: commissionRunLines.effectiveBase,
      carryOut: commissionRunLines.carryOut,
      targetAmount: commissionRunLines.targetAmount,
      achievementPct: commissionRunLines.achievementPct,
      planId: commissionRunLines.planId,
      tierIndex: commissionRunLines.tierIndex,
      ratePct: commissionRunLines.ratePct,
      fixedBonus: commissionRunLines.fixedBonus,
      commissionAmount: commissionRunLines.commissionAmount,
      detail: commissionRunLines.detail,
      firstName: employees.firstName,
      fatherName: employees.fatherName,
      grandfatherName: employees.grandfatherName,
      lastName: employees.lastName,
      position: employees.position,
      colorTag: employees.colorTag,
      photoUrl: employees.photoUrl,
      planName: commissionPlans.name,
    })
    .from(commissionRunLines)
    .leftJoin(employees, eq(employees.id, commissionRunLines.employeeId))
    .leftJoin(commissionPlans, eq(commissionPlans.id, commissionRunLines.planId))
    .where(
      and(
        eq(commissionRunLines.runId, id),
        scopedBranchId == null ? undefined : eq(commissionRunLines.branchId, scopedBranchId),
      ),
    )
    .orderBy(desc(commissionRunLines.commissionAmount), commissionRunLines.id);

  if (scopedBranchId != null && lines.length === 0) return null;
  const scopedTotals = scopedBranchId == null
    ? null
    : (await db
        .select({
          employeeCount: sql<number>`COUNT(*)`,
          totalBaseSales: sql<string>`CAST(COALESCE(SUM(${commissionRunLines.baseSales}), 0) AS CHAR)`,
          totalBaseReturns: sql<string>`CAST(COALESCE(SUM(${commissionRunLines.baseReturns}), 0) AS CHAR)`,
          totalCommission: sql<string>`CAST(COALESCE(SUM(${commissionRunLines.commissionAmount}), 0) AS CHAR)`,
        })
        .from(commissionRunLines)
        .where(and(eq(commissionRunLines.runId, id), eq(commissionRunLines.branchId, scopedBranchId))))[0];

  return {
    ...run,
    ...(scopedTotals
      ? {
          employeeCount: Number(scopedTotals.employeeCount),
          totalBaseSales: scopedTotals.totalBaseSales,
          totalBaseReturns: scopedTotals.totalBaseReturns,
          totalCommission: scopedTotals.totalCommission,
        }
      : {}),
    lines: lines.map((l) => ({ ...l, employeeName: fullEmployeeName(l) })),
  };
}

function assertCompanyScope(scopedBranchId: number | null): void {
  if (scopedBranchId != null) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "تغيير حالة تشغيلة العمولات إجراء مركزي على مستوى الشركة.",
    });
  }
}

export interface ApproveResult {
  id: number;
  period: string;
  status: "approved";
  /** يوجد مسيّر رواتب «مسودة» للشهر نفسه — أعد توليده كي يلتقط العمولة. */
  requiresPayrollRegeneration: boolean;
}

export interface ApproveRunInTxOptions {
  /** يُستدعى بعد قفل payroll(period) ثم commissionRun وقبل أي أثر. */
  beforeApply?: (run: typeof commissionRuns.$inferSelect) => Promise<void>;
}

export async function approveRunInTx(
  tx: Tx,
  id: number,
  actor: Actor,
  scopedBranchId: number | null = null,
  options: ApproveRunInTxOptions = {},
): Promise<ApproveResult> {
  assertCompanyScope(scopedBranchId);
  const [preview] = await tx
    .select({ period: commissionRuns.period })
    .from(commissionRuns)
    .where(eq(commissionRuns.id, id))
    .limit(1);
  if (!preview) throw new TRPCError({ code: "NOT_FOUND", message: "التشغيلة غير موجودة." });
  // Global lock order shared with payroll approval: payroll(period) → commission.
  // The unique payroll period index also gap-locks a missing run.
  const [payroll] = await tx
    .select({ id: payrollRuns.id, status: payrollRuns.status })
    .from(payrollRuns)
    .where(eq(payrollRuns.period, preview.period))
    .for("update")
    .limit(1);
  const [run] = await tx
    .select()
    .from(commissionRuns)
    .where(eq(commissionRuns.id, id))
    .for("update")
    .limit(1);
  if (!run) throw new TRPCError({ code: "NOT_FOUND", message: "التشغيلة غير موجودة." });
  if (run.period !== preview.period) {
    throw new TRPCError({ code: "CONFLICT", message: "تغيّرت فترة تشغيلة العمولات أثناء الاعتماد." });
  }
  if (run.status !== "draft") throw new TRPCError({ code: "CONFLICT", message: "التشغيلة معتمدة فعلاً." });
  if (run.createdBy != null && Number(run.createdBy) === actor.userId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "المعتمِد يجب أن يختلف عن مَن احتسب التشغيلة (فصل مهام)." });
  }
  if (payroll && payroll.status !== "draft") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `مسيّر رواتب ${run.period} ${payroll.status === "paid" ? "مدفوع" : "معتمد"} فعلاً — فات قطار الالتقاط. أعد المسيّر إلى مسودة أولاً ثم أعد توليده بعد اعتماد العمولات.`,
    });
  }

  await options.beforeApply?.(run);
  await tx
    .update(commissionRuns)
    .set({ status: "approved", approvedBy: actor.userId, approvedAt: new Date() })
    .where(eq(commissionRuns.id, id));

  return {
    id,
    period: run.period,
    status: "approved" as const,
    requiresPayrollRegeneration: payroll?.status === "draft",
  };
}

export async function approveRun(
  id: number,
  actor: Actor,
  scopedBranchId: number | null = null,
): Promise<ApproveResult> {
  return withTx((tx) => approveRunInTx(tx, id, actor, scopedBranchId));
}

export async function unapproveRun(
  id: number,
  actor: Actor,
  scopedBranchId: number | null = null,
): Promise<{ id: number; status: "draft" }> {
  assertCompanyScope(scopedBranchId);
  void id;
  void actor;
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message: "اعتماد تشغيلة العمولات سجل نهائي غير قابل للإلغاء؛ يلزم مسار عكس مستقل يحفظ الدليل.",
  });
}

export async function deleteDraft(id: number, scopedBranchId: number | null = null): Promise<{ deleted: true; period: string }> {
  assertCompanyScope(scopedBranchId);
  return withTx(async (tx) => {
    const [run] = await tx.select().from(commissionRuns).where(eq(commissionRuns.id, id)).for("update");
    if (!run) throw new TRPCError({ code: "NOT_FOUND", message: "التشغيلة غير موجودة." });
    if (run.status !== "draft") {
      throw new TRPCError({ code: "CONFLICT", message: "لا تُحذف تشغيلة معتمدة." });
    }
    const [approvalEvidence] = await tx
      .select({ id: commissionRunApprovalRequests.id })
      .from(commissionRunApprovalRequests)
      .where(eq(commissionRunApprovalRequests.runId, id))
      .for("update")
      .limit(1);
    if (approvalEvidence) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "لا تُحذف تشغيلة لها سجل طلب/قرار اعتماد؛ دليل الحوكمة دائم وغير قابل للمحو.",
      });
    }
    await tx.delete(commissionRunLines).where(eq(commissionRunLines.runId, id));
    await tx.delete(commissionRuns).where(eq(commissionRuns.id, id));
    return { deleted: true as const, period: run.period };
  });
}
