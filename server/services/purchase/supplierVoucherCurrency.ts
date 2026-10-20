import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { money, round2, toDbMoney } from "../money";

export const INVOICE_CURRENCY_SETTLEMENT = "INVOICE_CURRENCY_V1";

export function usesInvoiceCurrencySettlement(source: {
  payloadCanonical: string;
  payloadHash: string;
}) {
  const payload = JSON.parse(source.payloadCanonical);
  if (
    createHash("sha256").update(source.payloadCanonical).digest("hex") !==
    source.payloadHash
  )
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذر التحقق من تخصيص السند",
        why: "بصمة عملة تخصيص سند المورد غير صالحة",
        doThis: "راجع دليل تخصيص السند المحفوظ قبل الاعتماد",
      }),
    });
  return payload.allocationCurrency === INVOICE_CURRENCY_SETTLEMENT;
}

/** Cumulative conversion: repeated partials cannot accumulate rounding, and
 * the final book settlement consumes exactly the original currency balance. */
export function cumulativeCurrencyDelta(
  totalAmount: string,
  totalCurrency: string,
  usedAmount: string,
  usedCurrency: string,
  amount: string,
): string {
  const total = money(totalAmount),
    currency = money(totalCurrency);
  const after = money(usedAmount).plus(amount);
  if (
    !total.gt(0) ||
    !currency.gt(0) ||
    !money(amount).gt(0) ||
    after.gt(total)
  )
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذر تخصيص السداد",
        why: "مبلغ تخصيص العملة يتجاوز الرصيد المثبت",
        doThis: "حدّث رصيد الفاتورة واختر مبلغاً ضمن المتبقي",
      }),
    });
  const target = after.eq(total)
    ? currency
    : round2(currency.times(after).div(total));
  const delta = round2(target.minus(usedCurrency));
  if (!delta.gt(0) || (after.lt(total) && target.gte(currency)))
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذر تقريب تخصيص العملة",
        why: "المبلغ أصغر من دقة عملة الفاتورة",
        doThis: "اجمعه مع دفعة أكبر أو سدد المتبقي كاملاً",
      }),
    });
  return toDbMoney(delta);
}

export function supplierVoucherCurrencyAmount(
  invoice: {
    currency: string;
    totalAmount: string;
    usdTotal: string | null;
    agreedRate: string | null;
    legacySettledAmount: string;
  },
  amount: string,
  used: { amount: string; currencyAmount: string },
  creditReturns: string,
): string {
  if (invoice.currency === "IQD") return toDbMoney(amount);
  const rate = money(invoice.agreedRate);
  if (!rate.gt(0))
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذر حساب سداد الفاتورة",
        why: "فاتورة الدولار بلا سعر صرف مثبت",
        doThis: "راجع سعر الصرف المثبت في فاتورة المورد",
      }),
    });
  return cumulativeCurrencyDelta(
    toDbMoney(money(invoice.totalAmount).minus(creditReturns)),
    toDbMoney(
      money(invoice.usdTotal).minus(round2(money(creditReturns).div(rate))),
    ),
    toDbMoney(money(invoice.legacySettledAmount).plus(used.amount)),
    toDbMoney(
      round2(money(invoice.legacySettledAmount).div(rate)).plus(
        used.currencyAmount,
      ),
    ),
    amount,
  );
}
