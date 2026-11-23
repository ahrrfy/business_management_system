import { TRPCError } from "@trpc/server";
import type Decimal from "decimal.js";
import { appErrorMessage } from "@shared/errors";

/**
 * مصادر الإرساليات المؤهّلة لحسم أجرة «التوصيل على المكتبة» (`SHOP`) تلقائياً عند التوريد.
 * يشمل فواتير البيع وأوامر الشغل والمتجر الإلكتروني، ويُبقي معالجات النقص/التجهيز المستقل
 * (`AFTERCARE_EXECUTION`, `FULFILLMENT_REQUEST`) على مسار الصرف المعتمد مستقلاً.
 */
const WITHHOLDABLE_SHOP_FEE_SOURCES = new Set([
  "ONLINE_ORDER",
  "INVOICE",
  "WORK_ORDER",
]);

export function isWithholdableShopFeeSource(
  sourceType: string | null | undefined,
): boolean {
  return sourceType != null && WITHHOLDABLE_SHOP_FEE_SOURCES.has(sourceType);
}

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
