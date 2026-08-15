import { TRPCError } from "@trpc/server";
import {
  INBOUND_PAYMENT_DISABLED_MESSAGE,
  isInboundPaymentMethodEnabled,
} from "@shared/inboundPaymentPolicy";

/**
 * الحارس العام لكل مسار يثبت قبضاً اعتماداً على اختيار الموظف وحده.
 * يجب استدعاؤه قبل أي قراءة أو كتابة متى كانت الطريقة معروفة عند حدود العملية.
 */
export function assertInboundPaymentMethodEnabled(method: string | null | undefined): asserts method is "CASH" {
  if (!isInboundPaymentMethodEnabled(method)) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: INBOUND_PAYMENT_DISABLED_MESSAGE,
    });
  }
}
