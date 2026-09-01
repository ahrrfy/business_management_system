import { TRPCError } from "@trpc/server";
import { IQD_DENOMINATIONS } from "../../../shared/cashDailyReconciliation";
import { money, toDbMoney } from "../money";

export type CashBreakdown = Record<string, number>;

export function validateCashBreakdown(
  breakdown: CashBreakdown | null | undefined,
  countedCash: ReturnType<typeof money>,
  options: { requiredWhenPositive?: boolean } = {},
): CashBreakdown | null {
  if (!breakdown || Object.keys(breakdown).length === 0) {
    if (options.requiredWhenPositive && countedCash.gt(0)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "تفصيل فئات النقد مطلوب عند استلام مبلغ موجب",
      });
    }
    return null;
  }

  const allowed = new Set(IQD_DENOMINATIONS.map(String));
  let total = money(0);
  for (const [denomination, count] of Object.entries(breakdown)) {
    if (!allowed.has(denomination) || !Number.isInteger(count) || count < 0 || count > 10_000) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "تفصيل فئات النقد غير صالح" });
    }
    total = total.plus(money(denomination).times(count));
  }
  if (!total.eq(countedCash)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `مجموع عدّ الفئات (${toDbMoney(total)}) لا يساوي النقد المعدود (${toDbMoney(countedCash)}). أعد العد.`,
    });
  }
  return breakdown;
}
