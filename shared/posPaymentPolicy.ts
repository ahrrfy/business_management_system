import {
  INBOUND_NON_CASH_PAYMENT_METHODS,
  INBOUND_PAYMENT_DISABLED_MESSAGE,
  isInboundPaymentMethodEnabled,
} from "./inboundPaymentPolicy";

/** أسماء توافق لواجهات نقاط البيع؛ المصدر الحاكم هو سياسة القبض العامة. */
export const POS_EXTERNAL_PAYMENT_METHODS = INBOUND_NON_CASH_PAYMENT_METHODS;

export type PosExternalPaymentPolicyMethod = (typeof POS_EXTERNAL_PAYMENT_METHODS)[number];

export const POS_EXTERNAL_PAYMENT_DISABLED_MESSAGE = INBOUND_PAYMENT_DISABLED_MESSAGE;

export function isPosExternalPaymentMethod(method: string | null | undefined): method is PosExternalPaymentPolicyMethod {
  return POS_EXTERNAL_PAYMENT_METHODS.includes(method as PosExternalPaymentPolicyMethod);
}

/** المصدر الحاكم: النقد وحده مفعّل؛ القيمة المجهولة تُرفض أيضاً (fail-closed). */
export function isPosPaymentMethodEnabled(method: string | null | undefined): method is "CASH" {
  return isInboundPaymentMethodEnabled(method);
}
