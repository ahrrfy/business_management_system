/**
 * سياسة القبض العامّة خارج نقاط البيع.
 *
 * الرقم المرجعي الذي يدخله الموظف ليس دليلاً مستقلاً على وصول المال. لذلك لا
 * يُنشأ أي أثر قبض غير نقدي قبل وجود تكامل مزوّد موثوق وتسوية قابلة للمطابقة.
 * القيمة المجهولة تُرفض أيضاً: الإغلاق افتراضي (fail-closed).
 */
export const INBOUND_NON_CASH_PAYMENT_METHODS = [
  "CARD",
  "CHECK",
  "TRANSFER",
  "WALLET",
  "TELECOM",
] as const;

export type InboundNonCashPaymentMethod = (typeof INBOUND_NON_CASH_PAYMENT_METHODS)[number];

export const INBOUND_PAYMENT_DISABLED_MESSAGE =
  "القبض غير النقدي غير مفعّل حالياً لعدم وجود إثبات مستقل من المزوّد وتسوية مصرفية موثوقة؛ استخدم النقد فقط.";

/** المصدر الحاكم: النقد وحده مسموح، وأي قيمة مستقبلية مجهولة تُرفض. */
export function isInboundPaymentMethodEnabled(method: string | null | undefined): method is "CASH" {
  return method === "CASH";
}
