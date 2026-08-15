import { TRPCError } from "@trpc/server";
import {
  POS_EXTERNAL_PAYMENT_DISABLED_MESSAGE,
  isPosPaymentMethodEnabled,
} from "@shared/posPaymentPolicy";

/**
 * Server-side fail-closed boundary for every cashier/reception money-in path.
 * A reference typed by an employee is not evidence of provider settlement.
 */
export function assertPosPaymentMethodEnabled(method: string | null | undefined): void {
  if (!isPosPaymentMethodEnabled(method)) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: POS_EXTERNAL_PAYMENT_DISABLED_MESSAGE,
    });
  }
}
