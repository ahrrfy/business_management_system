import { TRPCError } from "@trpc/server";
import type Decimal from "decimal.js";
import { appErrorMessage } from "@shared/errors";

/** A commission replaces the whole fee; it cannot be split to fit remaining COD. */
export function assertFeeWithholdingCapacity(
  due: Decimal,
  quotedCash: Decimal,
  capacity: Decimal,
): void {
  if (quotedCash.lt(due) && quotedCash.gt(capacity)) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: "تعذر حسم عمولة التوصيل",
        why: "المبلغ المورد لا يغطي عمولة الإرسالية كاملة",
        doThis:
          "ورّد مبلغاً يغطي العمولة أو سوّ الأجرة بسندها المستقل قبل التوريد",
      }),
    });
  }
}
