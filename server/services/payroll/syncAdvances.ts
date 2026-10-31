import { and, eq, inArray } from "drizzle-orm";
import Decimal from "decimal.js";
import { payrollItems, payrollRuns } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { money, round2, toDbMoney } from "../money";
import { computeNet } from "./helpers";
import { suggestDeductionsTx } from "../advances";

/**
 * REPEATABLE READ keeps the transaction's first plain snapshot even after a
 * row-lock wait. Totals used by a financial writer must therefore come from a
 * current locking read, including unchanged items committed while it waited.
 */
async function recomputeRunTotalsCurrentTx(tx: Tx, runId: number): Promise<void> {
  const items = await tx
    .select({
      gross: payrollItems.gross,
      overtime: payrollItems.overtime,
      commission: payrollItems.commission,
      deductions: payrollItems.deductions,
      net: payrollItems.net,
      ssEmployee: payrollItems.socialSecurityEmployee,
      incomeTax: payrollItems.incomeTax,
      ssEmployer: payrollItems.socialSecurityEmployer,
      eosAccrual: payrollItems.endOfServiceAccrual,
    })
    .from(payrollItems)
    .where(eq(payrollItems.runId, runId))
    .orderBy(payrollItems.id)
    .for("update");
  let gross = new Decimal(0);
  let overtime = new Decimal(0);
  let commission = new Decimal(0);
  let deductions = new Decimal(0);
  let net = new Decimal(0);
  let socialSecurityEmployee = new Decimal(0);
  let incomeTax = new Decimal(0);
  let socialSecurityEmployer = new Decimal(0);
  let endOfServiceAccrual = new Decimal(0);
  for (const item of items) {
    gross = gross.plus(money(item.gross));
    overtime = overtime.plus(money(item.overtime));
    commission = commission.plus(money(item.commission));
    deductions = deductions.plus(money(item.deductions));
    net = net.plus(money(item.net));
    socialSecurityEmployee = socialSecurityEmployee.plus(
      money(item.ssEmployee),
    );
    incomeTax = incomeTax.plus(money(item.incomeTax));
    socialSecurityEmployer = socialSecurityEmployer.plus(
      money(item.ssEmployer),
    );
    endOfServiceAccrual = endOfServiceAccrual.plus(money(item.eosAccrual));
  }
  await tx
    .update(payrollRuns)
    .set({
      employeeCount: items.length,
      totalGross: toDbMoney(gross),
      totalOvertime: toDbMoney(overtime),
      totalCommission: toDbMoney(commission),
      totalDeductions: toDbMoney(deductions),
      totalNet: toDbMoney(net),
      totalSocialSecurityEmployee: toDbMoney(socialSecurityEmployee),
      totalIncomeTax: toDbMoney(incomeTax),
      totalSocialSecurityEmployer: toDbMoney(socialSecurityEmployer),
      totalEndOfServiceAccrual: toDbMoney(endOfServiceAccrual),
    })
    .where(eq(payrollRuns.id, runId));
}

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
    .orderBy(payrollItems.id)
    .for("update");

  if (items.length === 0) return false;

  const employeeIds = items.map((i) => Number(i.employeeId));
  const advanceMap = await suggestDeductionsTx(
    tx,
    employeeIds,
    run.period,
    { lockCurrent: true },
  );

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
    await recomputeRunTotalsCurrentTx(tx, runId);
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
  // The activating caller owns the employee aggregate. Lock run heads first,
  // then their items, then the advance rows: E → R → item → advances.
  const draftRuns = await tx
    .select({ id: payrollRuns.id, period: payrollRuns.period })
    .from(payrollRuns)
    .where(
      and(
        eq(payrollRuns.status, "draft"),
        payrollPeriod != null
          ? eq(payrollRuns.period, payrollPeriod)
          : undefined,
      ),
    )
    .orderBy(payrollRuns.id)
    .for("update");

  if (draftRuns.length === 0) return;

  const lockedItems = await tx
    .select({
      itemId: payrollItems.id,
      runId: payrollItems.runId,
      employeeId: payrollItems.employeeId,
      gross: payrollItems.gross,
      overtime: payrollItems.overtime,
      commission: payrollItems.commission,
      deductions: payrollItems.deductions,
      wageReduction: payrollItems.wageReduction,
      advanceDeduction: payrollItems.advanceDeduction,
      socialSecurityEmployee: payrollItems.socialSecurityEmployee,
      incomeTax: payrollItems.incomeTax,
    })
    .from(payrollItems)
    .where(
      inArray(
        payrollItems.runId,
        draftRuns.map((run) => Number(run.id)),
      ),
    )
    .orderBy(payrollItems.runId, payrollItems.id)
    .for("update");
  const affectedRuns = new Set<number>();

  for (const run of draftRuns) {
    const draftItems = lockedItems.filter(
      (item) =>
        Number(item.runId) === Number(run.id) &&
        Number(item.employeeId) === employeeId,
    );
    if (draftItems.length === 0) continue;
    const advanceMap = await suggestDeductionsTx(
      tx,
      [employeeId],
      run.period,
      { lockCurrent: true },
    );
    const suggestedAdvance =
      advanceMap.get(employeeId)?.suggested ?? new Decimal(0);
    for (const item of draftItems) {
      const statutoryDeduction = round2(
        money(item.socialSecurityEmployee).plus(money(item.incomeTax)),
      );
      const wageReduction = money(item.wageReduction);
      const oldAdvance = money(item.advanceDeduction);
      const manualExtraDeduction = Decimal.max(
        0,
        round2(
          money(item.deductions)
            .minus(oldAdvance)
            .minus(statutoryDeduction)
            .minus(wageReduction),
        ),
      );
      const grossEarned = round2(
        money(item.gross)
          .plus(money(item.overtime))
          .plus(money(item.commission)),
      );
      const absorbableWage = Decimal.max(
        0,
        round2(
          grossEarned
            .minus(wageReduction)
            .minus(statutoryDeduction)
            .minus(manualExtraDeduction),
        ),
      );

      const newAdvanceDeduction = round2(
        Decimal.min(suggestedAdvance, absorbableWage),
      );

      if (!newAdvanceDeduction.eq(oldAdvance)) {
        const newDeductions = round2(
          newAdvanceDeduction
            .plus(statutoryDeduction)
            .plus(wageReduction)
            .plus(manualExtraDeduction),
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
  }

  for (const rId of Array.from(affectedRuns).sort((left, right) => left - right)) {
    await recomputeRunTotalsCurrentTx(tx, rId);
  }
}
