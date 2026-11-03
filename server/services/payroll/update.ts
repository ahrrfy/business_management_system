// تحرير بند مسيّر رواتب — يعمل فقط أثناء الحالة draft؛ يعيد حساب صافي البند ومجاميع المسيّر.
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { appErrorMessage } from "@shared/errors";
import { employeePenalties, payrollItems, payrollPenaltyAllocations, payrollRuns } from "../../../drizzle/schema";
import { money, round2, toDbMoney } from "../money";
import { type Actor, withTx } from "../tx";
import { capPenaltyDeduction, computeNet, recomputeRunTotals } from "./helpers";
import { getRun } from "./queries";
import { assertRunPenaltyAllocationsTx, readPenaltySourcesTx } from "./penaltyAllocations";
import type { UpdateItemInput } from "./types";

export async function updateItem(itemId: number, input: UpdateItemInput, actor?: Actor) {
  return withTx(async (tx) => {
    const [preview] = await tx
      .select({ runId: payrollItems.runId })
      .from(payrollItems)
      .where(eq(payrollItems.id, itemId))
      .limit(1);
    if (!preview) throw new TRPCError({ code: "NOT_FOUND", message: "بند المسيّر غير موجود" });
    // Global payroll lifecycle order is run -> items. Approval/reopen use this order too,
    // eliminating the item->run / run->item deadlock under a concurrent edit.
    const [run] = await tx
      .select()
      .from(payrollRuns)
      .where(eq(payrollRuns.id, Number(preview.runId)))
      .for("update")
      .limit(1);
    if (!run) throw new TRPCError({ code: "NOT_FOUND", message: "المسيّر غير موجود" });
    const [item] = await tx
      .select()
      .from(payrollItems)
      .where(eq(payrollItems.id, itemId))
      .for("update")
      .limit(1);
    if (!item || Number(item.runId) !== Number(run.id)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "تغيّر بند المسيّر أثناء بدء التعديل — أعد المحاولة.",
      });
    }
    if (run.status !== "draft") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن تعديل البنود إلا والمسيّر مسودة" });
    }

    const allocations = await tx.select({ amount: payrollPenaltyAllocations.amount })
      .from(payrollPenaltyAllocations).where(eq(payrollPenaltyAllocations.itemId, itemId)).for("share");
    const penaltyPart = round2(allocations.reduce((sum, row) => sum.plus(money(row.amount)), money(0)));
    await assertRunPenaltyAllocationsTx(tx, Number(run.id));
    if (!item.penaltySnapshotComplete && (input.overtime != null || input.deductions != null)) {
      const [legacy] = await tx.select({ id: employeePenalties.id }).from(employeePenalties)
        .where(and(eq(employeePenalties.payrollRunId, Number(run.id)), eq(employeePenalties.employeeId, Number(item.employeeId))))
        .for("share").limit(1);
      if (legacy) throw new TRPCError({ code: "PRECONDITION_FAILED", message: appErrorMessage({
        what: "تعذّر تعديل بند الراتب", why: `العقوبة #${legacy.id} مرتبطة بالمسودة دون مقدار تخصيص مثبت`,
        doThis: "احذف المسودة غير المعتمدة وأعد توليدها قبل تعديل المبالغ",
      }) });
    }

    const overtime = input.overtime != null ? money(input.overtime) : money(item.overtime);
    const deductions = input.deductions != null ? money(input.deductions) : money(item.deductions);
    if (overtime.isNegative()) throw new TRPCError({ code: "BAD_REQUEST", message: "العمل الإضافي لا يكون سالباً" });
    if (deductions.isNegative()) throw new TRPCError({ code: "BAD_REQUEST", message: "الاستقطاع لا يكون سالباً" });
    // advances (بند 12ج): استقطاع السلفة المولَّد ثابت في البند — التعديل اليدوي يطال بقية
    // الاستقطاعات (غياب/جزاء) فوقه فقط. السماح بالهبوط دونه يفكّ الاتساق مع تسوية السلف عند
    // الدفع (settleAdvancesOnPayTx تُنقص remaining بمقدار advanceDeduction كما وُلّد).
    const advancePart = money(item.advanceDeduction);
    // المكوّنات القانونية (البند ④): حصّتا الموظف (ضمان+ضريبة) استقطاعاتٌ إلزاميّة لا تُزال يدوياً —
    // تُضاف إلى أرضية السلفة. **معطَّلة ⇒ صفر ⇒ الأرضية = جزء السلفة كما كانت (صفر انحدار، ونفس الرسالة).**
    const statutoryPart = round2(money(item.socialSecurityEmployee).plus(money(item.incomeTax)));
    const floor = round2(advancePart.plus(statutoryPart).plus(penaltyPart));
    if (deductions.lt(floor)) {
      if (penaltyPart.gt(0)) throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({
        what: "لا يمكن تخفيض الاستقطاع دون المبلغ المثبت", why: `يتضمن البند عقوبات مخصصة بمبلغ ${toDbMoney(penaltyPart)} إضافةً للسلفة والاستقطاعات القانونية`,
        doThis: "راجع العقوبة وأعد توليد المسودة قبل تغييرها",
      }) });
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: statutoryPart.gt(0)
          ? `الاستقطاع لا يقلّ عن الاستقطاعات المولَّدة إلزاميّاً (سلفة ${toDbMoney(advancePart)} + قانونية ${toDbMoney(statutoryPart)}) — لتغييرها ألغِ المسودة وعدِّل الإعدادات/السلفة ثم أعد التوليد`
          : `الاستقطاع لا يقلّ عن استقطاع السلفة المولَّد (${toDbMoney(advancePart)}) — لتغييره ألغِ المسودة وعدِّل السلفة ثم أعد التوليد`,
      });
    }
    const wageReduction = round2(deductions.minus(advancePart).minus(statutoryPart));
    const nonPenaltyReduction = round2(wageReduction.minus(penaltyPart));
    const capBase = money(item.gross).plus(overtime).plus(money(item.commission)).minus(statutoryPart).minus(nonPenaltyReduction);
    if (capPenaltyDeduction(capBase, penaltyPart).lt(penaltyPart)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({
        what: "لا يمكن حفظ تغيير الأجر", why: "يصبح استقطاع العقوبة المثبت أعلى من الحد المطبق في النظام",
        doThis: "أعد توليد المسودة بعد تصحيح الأجر والقرار",
      }) });
    }
    if (item.penaltySnapshotComplete && (input.overtime != null || input.deductions != null)) {
      const sources = await readPenaltySourcesTx(tx, [Number(item.employeeId)], run.period, true, Number(run.id));
      const stillDue = sources.reduce((sum, source) => sum.plus(source.remaining).plus(source.futureReserved), money(0));
      const expected = capPenaltyDeduction(capBase, round2(stillDue.plus(penaltyPart)));
      if (!expected.eq(penaltyPart)) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: appErrorMessage({
          what: "تعذّر تعديل بند الراتب", why: "سيغيّر الأجر أو الاستقطاع مقدار العقوبة الواجب التقاطها لهذه الفترة",
          doThis: "احذف المسودة وأعد توليد المسيّر بعد تصحيح مصادر الأجر والعقوبات",
        }) });
      }
    }
    // العمولة قراءة فقط هنا — تعديلها = إعادة احتساب تشغيلة العمولات قبل توليد المسيّر.
    const net = computeNet(money(item.gross), overtime, money(item.commission), deductions);
    if (net.isNegative()) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "لا يمكن أن يكون صافي راتب أي موظف سالباً — خفّض الاستقطاع إلى حد الأجر المستحق.",
      });
    }

    await tx
      .update(payrollItems)
      .set({
        overtime: toDbMoney(overtime),
        deductions: toDbMoney(deductions),
        wageReduction: toDbMoney(wageReduction),
        net: toDbMoney(net),
        note: input.note !== undefined ? (input.note?.trim() || null) : item.note,
      })
      .where(eq(payrollItems.id, itemId));

    await recomputeRunTotals(tx, Number(item.runId));
    if (actor) {
      // The last person who changes a financial amount becomes the maker for SOD purposes.
      // The original generator remains preserved in the immutable audit log.
      await tx.update(payrollRuns).set({ createdBy: actor.userId }).where(eq(payrollRuns.id, Number(item.runId)));
    }
    return Number(item.runId);
  }).then((runId) => getRun(runId));
}
