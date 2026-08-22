import {
  INBOUND_NON_CASH_PAYMENT_METHODS,
  INBOUND_PAYMENT_DISABLED_MESSAGE,
  inboundPaymentRejectionMessage,
  isInboundPaymentMethodEnabled,
  type InboundEnabledPaymentMethod,
} from "./inboundPaymentPolicy";

/** أسماء توافق لواجهات نقاط البيع؛ المصدر الحاكم هو سياسة القبض العامة. */
export const POS_EXTERNAL_PAYMENT_METHODS = INBOUND_NON_CASH_PAYMENT_METHODS;

export type PosExternalPaymentPolicyMethod = (typeof POS_EXTERNAL_PAYMENT_METHODS)[number];

export const POS_EXTERNAL_PAYMENT_DISABLED_MESSAGE = INBOUND_PAYMENT_DISABLED_MESSAGE;

/** ما يراه الكاشير قبل تثبيت المحاولة: البوّابة الحقيقية للدفع غير النقدي. */
export const POS_EXTERNAL_PAYMENT_PROOF_HINT =
  "الدفع غير النقدي يتطلّب مرجع العملية وتأكيداً خادمياً قبل إتمام البيع.";

export function isPosExternalPaymentMethod(method: string | null | undefined): method is PosExternalPaymentPolicyMethod {
  return POS_EXTERNAL_PAYMENT_METHODS.includes(method as PosExternalPaymentPolicyMethod);
}

/** fail-closed على المجهول: كل ما هو خارج قائمة الطرق المدعومة يُرفض. */
export function isPosPaymentMethodEnabled(method: string | null | undefined): method is InboundEnabledPaymentMethod {
  return isInboundPaymentMethodEnabled(method);
}

export function posPaymentRejectionMessage(method: string | null | undefined): string {
  return inboundPaymentRejectionMessage(method);
}
