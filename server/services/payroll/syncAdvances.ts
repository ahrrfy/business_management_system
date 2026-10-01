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
    .select({ id: payrollRuns.id, status: payrollRuns.status })
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
  const advanceMap = await suggestDeductionsTx(tx, employeeIds);

  let hasChanges = false;

  for (const item of items) {
    const empId = Number(item.employeeId);
    const suggestedAdvance = advanceMap.get(empId)?.suggested ?? new Decimal(0);

    const statutoryDeduction = round2(
      money(item.socialSecurityEmployee).plus(money(item.incomeTax)),
    );
    const wageReduction = money(item.wageReduction);
    const grossEarned = round2(
      money(item.gross).plus(money(item.overtime)).plus(money(item.commission)),
    );
    const absorbableWage = Decimal.max(
      0,
      round2(grossEarned.minus(wageReduction).minus(statutoryDeduction)),
    );

    const newAdvanceDeduction = round2(Decimal.min(suggestedAdvance, absorbableWage));

    // مزامنة بالزيادة فقط: التقاط السلف النشطة المضافة/غير المشمولة تلقائياً
    // وإن نقص الرصيد (إلغاء سلفة) يُترك ليرمي CONFLICT صريحاً عند الاعتماد منعاً للتعديل الصامت
    if (newAdvanceDeduction.gt(money(item.advanceDeduction))) {
      const newDeductions = round2(
        newAdvanceDeduction.plus(statutoryDeduction).plus(wageReduction),
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
): Promise<void> {
  const draftItems = await tx
    .select({
      itemId: payrollItems.id,
      runId: payrollItems.runId,
      gross: payrollItems.gross,
      overtime: payrollItems.overtime,
      commission: payrollItems.commission,
      wageReduction: payrollItems.wageReduction,
      advanceDeduction: payrollItems.advanceDeduction,
      socialSecurityEmployee: payrollItems.socialSecurityEmployee,
      incomeTax: payrollItems.incomeTax,
    })
    .from(payrollItems)
    .innerJoin(payrollRuns, eq(payrollItems.runId, payrollRuns.id))
    .where(and(eq(payrollItems.employeeId, employeeId), eq(payrollRuns.status, "draft")))
    .for("update");

  if (draftItems.length === 0) return;

  const advanceMap = await suggestDeductionsTx(tx, [employeeId]);
  const suggestedAdvance = advanceMap.get(employeeId)?.suggested ?? new Decimal(0);

  const affectedRuns = new Set<number>();

  for (const item of draftItems) {
    const statutoryDeduction = round2(
      money(item.socialSecurityEmployee).plus(money(item.incomeTax)),
    );
    const wageReduction = money(item.wageReduction);
    const grossEarned = round2(
      money(item.gross).plus(money(item.overtime)).plus(money(item.commission)),
    );
    const absorbableWage = Decimal.max(
      0,
      round2(grossEarned.minus(wageReduction).minus(statutoryDeduction)),
    );

    const newAdvanceDeduction = round2(Decimal.min(suggestedAdvance, absorbableWage));

    if (newAdvanceDeduction.gt(money(item.advanceDeduction))) {
      const newDeductions = round2(
        newAdvanceDeduction.plus(statutoryDeduction).plus(wageReduction),
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
