/**
 * سياسة الدفع في نقطتَي البيع خلال مرحلة التشغيل الحالية.
 *
 * لا يكفي وجود رقم مرجع يكتبه الموظف لإثبات قبضٍ خارجي. تفعيل أي طريقة غير
 * نقدية يتطلّب تكاملاً موثوقاً مع المزوّد ومسار تسوية ومطابقة مستقل؛ لذلك تبقى
 * كل الطرق الخارجية مغلقة افتراضياً في الخادم والواجهة معاً.
 */
export const POS_EXTERNAL_PAYMENT_METHODS = [
  "CARD",
  "CHECK",
  "TRANSFER",
  "WALLET",
  "TELECOM",
] as const;

export type PosExternalPaymentPolicyMethod = (typeof POS_EXTERNAL_PAYMENT_METHODS)[number];

export const POS_EXTERNAL_PAYMENT_DISABLED_MESSAGE =
  "طريقة الدفع غير النقدي غير مفعّلة في نقطة البيع لعدم وجود تكامل مزوّد وتسوية موثوقين.";

export function isPosExternalPaymentMethod(method: string | null | undefined): method is PosExternalPaymentPolicyMethod {
  return POS_EXTERNAL_PAYMENT_METHODS.includes(method as PosExternalPaymentPolicyMethod);
}

/** المصدر الحاكم: النقد وحده مفعّل؛ القيمة المجهولة تُرفض أيضاً (fail-closed). */
export function isPosPaymentMethodEnabled(method: string | null | undefined): method is "CASH" {
  return method === "CASH";
}
