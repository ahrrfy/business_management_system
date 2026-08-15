// تحرير بند مسيّر رواتب — يعمل فقط أثناء الحالة draft؛ يعيد حساب صافي البند ومجاميع المسيّر.
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { payrollItems, payrollRuns } from "../../../drizzle/schema";
import { money, round2, toDbMoney } from "../money";
import { type Actor, withTx } from "../tx";
import { computeNet, recomputeRunTotals } from "./helpers";
import { getRun } from "./queries";
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
    const floor = round2(advancePart.plus(statutoryPart));
    if (deductions.lt(floor)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: statutoryPart.gt(0)
          ? `الاستقطاع لا يقلّ عن الاستقطاعات المولَّدة إلزاميّاً (سلفة ${toDbMoney(advancePart)} + قانونية ${toDbMoney(statutoryPart)}) — لتغييرها ألغِ المسودة وعدِّل الإعدادات/السلفة ثم أعد التوليد`
          : `الاستقطاع لا يقلّ عن استقطاع السلفة المولَّد (${toDbMoney(advancePart)}) — لتغييره ألغِ المسودة وعدِّل السلفة ثم أعد التوليد`,
      });
    }
    const wageReduction = round2(deductions.minus(floor));
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
