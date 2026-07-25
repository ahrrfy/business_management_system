/**
 * سياسة حوكمة فروقات درج النقد.
 *
 * الرقم المعدود ليس مصدراً مالياً بحد ذاته. أي فرق عن الرصيد الدفتري يحتاج
 * دليلاً (عدّ الفئات) وتفسيراً، والفروق الجوهرية تحتاج فصلاً للواجبات.
 */
export const IQD_DENOMINATIONS = [50_000, 25_000, 10_000, 5_000, 1_000, 500, 250] as const;

export const SHIFT_VARIANCE_CODES = [
  "COUNT_ERROR",
  "UNRECORDED_SALE",
  "UNRECORDED_CASH_IN",
  "UNRECORDED_CASH_OUT",
  "CHANGE_FUND_TRANSFER",
  "OFFLINE_SALE",
  "REFUND_ERROR",
  "OTHER",
] as const;

export type ShiftVarianceCode = (typeof SHIFT_VARIANCE_CODES)[number];

export const SHIFT_VARIANCE_LABELS: Record<ShiftVarianceCode, string> = {
  COUNT_ERROR: "خطأ في العد أو الفئات",
  UNRECORDED_SALE: "بيع لم يُسجّل",
  UNRECORDED_CASH_IN: "نقد وارد غير مسجّل",
  UNRECORDED_CASH_OUT: "نقد صادر غير مسجّل",
  CHANGE_FUND_TRANSFER: "فكّة/عهدة من الخزينة",
  OFFLINE_SALE: "بيع دون اتصال لم يُزامن",
  REFUND_ERROR: "خطأ في مرتجع أو استرداد",
  OTHER: "سبب آخر موثّق",
};

/**
 * حد تشغيلي أولي بالدينار العراقي. تجاوزه لا يعني اختلاساً، بل يعني أن
 * الكاشير لا يعتمد فرق عهدته بنفسه ويجب أن يغلقها مدير/أدمن بعد التحقيق.
 */
export const MATERIAL_SHIFT_VARIANCE_IQD = 5_000;
