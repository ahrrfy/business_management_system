import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { commissionRuns } from "../../../drizzle/schema";
import type { DB, Tx } from "../../db";
import { loadEligible } from "./engine";

export interface CommissionPayrollReadiness {
  required: boolean;
  eligibleEmployeeCount: number;
  runId: number | null;
  status: "draft" | "approved" | null;
  ready: boolean;
}

async function commissionPayrollReadiness(
  runner: DB | Tx,
  period: string,
  lock: boolean,
): Promise<CommissionPayrollReadiness> {
  let query = runner
    .select({ id: commissionRuns.id, status: commissionRuns.status })
    .from(commissionRuns)
    .where(eq(commissionRuns.period, period))
    .limit(1);
  const rows = lock ? await query.for("update") : await query;
  const run = rows[0] ?? null;
  const eligible = await loadEligible(runner, period);
  const required = eligible.length > 0;
  return {
    required,
    eligibleEmployeeCount: eligible.length,
    runId: run == null ? null : Number(run.id),
    status: run?.status ?? null,
    ready: !required || run?.status === "approved",
  };
}

/** قراءة بلا قفل لتقرير جاهزية إقفال الشهر. */
export function getCommissionPayrollReadiness(runner: DB | Tx, period: string) {
  return commissionPayrollReadiness(runner, period, false);
}

/**
 * يُستدعى بعد قفل payrollRuns وقبل اعتماد/دفع المسيّر. قفل period الفريد يمنع سباق
 * إنشاء تشغيلة عمولة بعد عبور الحارس، ويحافظ على payroll → commission كترتيب ثابت.
 */
export async function assertCommissionArtifactReadyForPayrollTx(tx: Tx, period: string) {
  const readiness = await commissionPayrollReadiness(tx, period, true);
  if (!readiness.ready) {
    const state = readiness.status == null ? "مفقودة" : "مسودة غير معتمدة";
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        `تشغيلة عمولات ${period} ${state} مع وجود ${readiness.eligibleEmployeeCount} موظف ذي خطة فعالة؛ ` +
        "احتسبها وأنشئ طلب اعتماد الشركة ثم أعد توليد مسيّر الرواتب قبل الاعتماد/الدفع.",
    });
  }
  return readiness;
}
