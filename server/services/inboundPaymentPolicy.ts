import { TRPCError } from "@trpc/server";
import {
  inboundPaymentRejectionMessage,
  isInboundPaymentMethodEnabled,
  type InboundEnabledPaymentMethod,
} from "@shared/inboundPaymentPolicy";

/**
 * الحارس العام لكل مسار يثبت قبضاً. يرفض المجهول ورصيد زين؛ أمّا إثبات وصول المال
 * للطرق غير النقدية في نقاط البيع فبوّابته `externalPaymentAttempts` المؤكَّدة، لا هذا الحارس.
 */
export function assertInboundPaymentMethodEnabled(
  method: string | null | undefined,
): asserts method is InboundEnabledPaymentMethod {
  if (!isInboundPaymentMethodEnabled(method)) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: inboundPaymentRejectionMessage(method),
    });
  }
}
