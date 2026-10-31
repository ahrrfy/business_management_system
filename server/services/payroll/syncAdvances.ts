import { and, eq } from "drizzle-orm";
import Decimal from "decimal.js";
import { payrollItems, payrollRuns } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { money, round2, toDbMoney } from "../money";
import { computeNet, recomputeRunTotals } from "./helpers";
import { suggestDeductionsTx } from "../advances";

/**
 * مزامنة تلقائية لاستقطاعات السلف لجميع بنود مسيّر الرواتب (حالة draft فقط).
 * يُستدعى داخل معاملة الاعتماد `approveRun` لضمان التقاط أي سلفة مُنحت أو اعتُمدت أو أُلغيت
 * بين وقت توليد المسودة ووقت اعتمادها النهائي — حماية مالية حاسمة تمنع خروج نقد الراتب دون استقطاع السلف.
 */
export async function syncAllAdvancesForDraftRunTx(tx: Tx, runId: number): Promise<boolean> {
  const [run] = await tx
    .select({
      id: payrollRuns.id,
      status: payrollRuns.status,
      period: payrollRuns.period,
    })
    .from(payrollRuns)
    .where(eq(payrollRuns.id, runId))
    .for("update")
    .limit(1);

  if (!run || run.status !== "draft") return false;

  const items = await tx
    .select()
    .from(payrollItems)
    .where(eq(payrollItems.runId, runId))
    .for("update");

  if (items.length === 0) return false;

  const employeeIds = items.map((i) => Number(i.employeeId));
  const advanceMap = await suggestDeductionsTx(tx, employeeIds, run.period);

  let hasChanges = false;

  for (const item of items) {
    const empId = Number(item.employeeId);
    const suggestedAdvance = advanceMap.get(empId)?.suggested ?? new Decimal(0);

    const statutoryDeduction = round2(
      money(item.socialSecurityEmployee).plus(money(item.incomeTax)),
    );
    const wageReduction = money(item.wageReduction);
    const oldAdvance = money(item.advanceDeduction);
    const manualExtraDeduction = Decimal.max(
      0,
      round2(money(item.deductions).minus(oldAdvance).minus(statutoryDeduction).minus(wageReduction)),
    );
    const grossEarned = round2(
      money(item.gross).plus(money(item.overtime)).plus(money(item.commission)),
    );
    const absorbableWage = Decimal.max(
      0,
      round2(grossEarned.minus(wageReduction).minus(statutoryDeduction).minus(manualExtraDeduction)),
    );

    const newAdvanceDeduction = round2(Decimal.min(suggestedAdvance, absorbableWage));

    // المسودة إسقاط قابل لإعادة الحساب؛ يجب أن تعكس المصدر بالزيادة والنقصان معاً.
    if (!newAdvanceDeduction.eq(oldAdvance)) {
      const newDeductions = round2(
        newAdvanceDeduction.plus(statutoryDeduction).plus(wageReduction).plus(manualExtraDeduction),
      );
      const newNet = computeNet(
        money(item.gross),
        money(item.overtime),
        money(item.commission),
        newDeductions,
      );

      await tx
        .update(payrollItems)
        .set({
          advanceDeduction: toDbMoney(newAdvanceDeduction),
          deductions: toDbMoney(newDeductions),
          net: toDbMoney(newNet),
        })
        .where(eq(payrollItems.id, Number(item.id)));

      hasChanges = true;
    }
  }

  if (hasChanges) {
    await recomputeRunTotals(tx, runId);
  }

  return hasChanges;
}

/**
 * مزامنة تلقائية فورية لسلفة موظف في أي مسودة مسيّر رواتب مفتوحة.
 * تُستدعى فور تفعيل السلفة (`activateAdvanceForApprovedVoucherTx`) أو إلغائها (`cancelAdvance`).
 */
export async function autoSyncEmployeeAdvanceToDraftPayrollTx(
  tx: Tx,
  employeeId: number,
  payrollPeriod?: string,
): Promise<void> {
  const draftItems = await tx
    .select({
      itemId: payrollItems.id,
      runId: payrollItems.runId,
      gross: payrollItems.gross,
      overtime: payrollItems.overtime,
      commission: payrollItems.commission,
      deductions: payrollItems.deductions,
      wageReduction: payrollItems.wageReduction,
      advanceDeduction: payrollItems.advanceDeduction,
      socialSecurityEmployee: payrollItems.socialSecurityEmployee,
      incomeTax: payrollItems.incomeTax,
      period: payrollRuns.period,
    })
    .from(payrollItems)
    .innerJoin(payrollRuns, eq(payrollItems.runId, payrollRuns.id))
    .where(
      and(
        eq(payrollItems.employeeId, employeeId),
        eq(payrollRuns.status, "draft"),
        payrollPeriod != null
          ? eq(payrollRuns.period, payrollPeriod)
          : undefined,
      ),
    )
    .for("update");

  if (draftItems.length === 0) return;

  const affectedRuns = new Set<number>();

  for (const item of draftItems) {
    const advanceMap = await suggestDeductionsTx(tx, [employeeId], item.period);
    const suggestedAdvance =
      advanceMap.get(employeeId)?.suggested ?? new Decimal(0);
    const statutoryDeduction = round2(
      money(item.socialSecurityEmployee).plus(money(item.incomeTax)),
    );
    const wageReduction = money(item.wageReduction);
    const oldAdvance = money(item.advanceDeduction);
    const manualExtraDeduction = Decimal.max(
      0,
      round2(money(item.deductions).minus(oldAdvance).minus(statutoryDeduction).minus(wageReduction)),
    );
    const grossEarned = round2(
      money(item.gross).plus(money(item.overtime)).plus(money(item.commission)),
    );
    const absorbableWage = Decimal.max(
      0,
      round2(grossEarned.minus(wageReduction).minus(statutoryDeduction).minus(manualExtraDeduction)),
    );

    const newAdvanceDeduction = round2(Decimal.min(suggestedAdvance, absorbableWage));

    if (!newAdvanceDeduction.eq(oldAdvance)) {
      const newDeductions = round2(
        newAdvanceDeduction.plus(statutoryDeduction).plus(wageReduction).plus(manualExtraDeduction),
      );
      const newNet = computeNet(
        money(item.gross),
        money(item.overtime),
        money(item.commission),
        newDeductions,
      );

      await tx
        .update(payrollItems)
        .set({
          advanceDeduction: toDbMoney(newAdvanceDeduction),
          deductions: toDbMoney(newDeductions),
          net: toDbMoney(newNet),
        })
        .where(eq(payrollItems.id, Number(item.itemId)));

      affectedRuns.add(Number(item.runId));
    }
  }

  for (const rId of Array.from(affectedRuns)) {
    await recomputeRunTotals(tx, rId);
  }
}
