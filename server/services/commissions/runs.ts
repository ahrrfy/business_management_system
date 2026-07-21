/* ============================================================================
 * دورة حياة تشغيلات العمولة (S3): قراءة + اعتماد/إلغاء اعتماد/حذف مسودة.
 *
 * الحالات: draft → approved فقط — «الدفع» ليس هنا: مسيّر الرواتب يلتقط التشغيلة
 * المعتمدة لنفس الشهر (S4) ويثبّت payrollRunId (فكّه التلقائي بحذف مسودة المسيّر
 * عبر ON DELETE SET NULL).
 *
 * SOD (مرآة الرواتب): المعتمِد ≠ المحتسِب (createdBy) — FORBIDDEN وإلا.
 * حارس الرواتب: لا اعتماد وثمة مسيّر معتمد/مدفوع للشهر نفسه (فات قطار الالتقاط —
 * يُعاد المسيّر مسودةً أولاً)؛ مسيّر «مسودة» قائم ⇒ الاعتماد يمرّ مع علم
 * requiresPayrollRegeneration كي تنبّه الواجهة لإعادة توليده.
 * حارس السلسلة: لا إلغاء اعتماد وثمة تشغيلة لشهر أحدث (ترحيلها بُني على هذا الشهر).
 * ========================================================================== */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { fullEmployeeName } from "@shared/hr";
import {
  commissionPlans,
  commissionRunLines,
  commissionRuns,
  employees,
  payrollRuns,
} from "../../../drizzle/schema";
import { requireDb, withTx, type Actor } from "../tx";

export async function listRuns() {
  const db = requireDb();
  return db.select().from(commissionRuns).orderBy(desc(commissionRuns.period), desc(commissionRuns.id));
}

export async function getRun(id: number) {
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
    .where(eq(commissionRunLines.runId, id))
    .orderBy(desc(commissionRunLines.commissionAmount), commissionRunLines.id);

  return {
    ...run,
    lines: lines.map((l) => ({ ...l, employeeName: fullEmployeeName(l) })),
  };
}

export interface ApproveResult {
  id: number;
  period: string;
  status: "approved";
  /** يوجد مسيّر رواتب «مسودة» للشهر نفسه — أعد توليده كي يلتقط العمولة. */
  requiresPayrollRegeneration: boolean;
}

export async function approveRun(id: number, actor: Actor): Promise<ApproveResult> {
  return withTx(async (tx) => {
    const [run] = await tx.select().from(commissionRuns).where(eq(commissionRuns.id, id)).for("update");
    if (!run) throw new TRPCError({ code: "NOT_FOUND", message: "التشغيلة غير موجودة." });
    if (run.status !== "draft") throw new TRPCError({ code: "CONFLICT", message: "التشغيلة معتمدة فعلاً." });
    if (run.createdBy != null && Number(run.createdBy) === actor.userId) {
      // SOD-03 (مرآة الرواتب): فصل مهام حقيقي — من احتسب لا يعتمد.
      throw new TRPCError({ code: "FORBIDDEN", message: "المعتمِد يجب أن يختلف عن مَن احتسب التشغيلة (فصل مهام)." });
    }

    const [payroll] = await tx
      .select({ id: payrollRuns.id, status: payrollRuns.status })
      .from(payrollRuns)
      .where(eq(payrollRuns.period, run.period))
      .limit(1);
    if (payroll && payroll.status !== "draft") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `مسيّر رواتب ${run.period} ${payroll.status === "paid" ? "مدفوع" : "معتمد"} فعلاً — فات قطار الالتقاط. أعد المسيّر إلى مسودة أولاً ثم أعد توليده بعد اعتماد العمولات.`,
      });
    }

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
  });
}

export async function unapproveRun(id: number, actor: Actor): Promise<{ id: number; status: "draft" }> {
  void actor; // الهوية تُدقَّق في الراوتر (logAudit) — أي مدير/أدمن مخوَّل.
  return withTx(async (tx) => {
    const [run] = await tx.select().from(commissionRuns).where(eq(commissionRuns.id, id)).for("update");
    if (!run) throw new TRPCError({ code: "NOT_FOUND", message: "التشغيلة غير موجودة." });
    if (run.status !== "approved") throw new TRPCError({ code: "CONFLICT", message: "التشغيلة ليست معتمدة." });
    if (run.payrollRunId != null) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "التقطها مسيّر الرواتب — احذف مسودة المسيّر (أو اعكس مساره) أولاً فيُفكّ الربط تلقائياً.",
      });
    }
    const [later] = await tx
      .select({ id: commissionRuns.id, period: commissionRuns.period })
      .from(commissionRuns)
      .where(gt(commissionRuns.period, run.period))
      .limit(1);
    if (later) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `توجد تشغيلة لشهر أحدث (${later.period}) ترحيلُها مبنيّ على هذا الشهر — احذفها/ألغِ اعتمادها أولاً.`,
      });
    }
    await tx
      .update(commissionRuns)
      .set({ status: "draft", approvedBy: null, approvedAt: null })
      .where(eq(commissionRuns.id, id));
    return { id, status: "draft" as const };
  });
}

export async function deleteDraft(id: number): Promise<{ deleted: true; period: string }> {
  return withTx(async (tx) => {
    const [run] = await tx.select().from(commissionRuns).where(eq(commissionRuns.id, id)).for("update");
    if (!run) throw new TRPCError({ code: "NOT_FOUND", message: "التشغيلة غير موجودة." });
    if (run.status !== "draft") {
      throw new TRPCError({ code: "CONFLICT", message: "لا تُحذف تشغيلة معتمدة — ألغِ اعتمادها أولاً." });
    }
    await tx.delete(commissionRunLines).where(eq(commissionRunLines.runId, id));
    await tx.delete(commissionRuns).where(eq(commissionRuns.id, id));
    return { deleted: true as const, period: run.period };
  });
}
