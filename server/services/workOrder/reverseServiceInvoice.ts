/**
 * اسمٌ توافقي قديم فقط. لا يملك حساباً ولا قيداً ولا مساراً خاصاً لفاتورة الخدمة.
 * كل فواتير WORKORDER، ذات البنود وصفريتها، تُحوّل إلى طلب REVERSE_DELIVERY نفسه.
 */
import { TRPCError } from "@trpc/server";
import type { Actor } from "../tx";
import { requestWorkOrderControl } from "./controlRequests";
import { getWorkOrderReverseDeliveryPreflight } from "./reverseDelivery";

export interface ReverseServiceInvoiceInput {
  workOrderId: number;
  expectedVersion: number;
  reason: string;
  refundShiftId?: number | null;
  clientRequestId: string;
}

export async function reverseServiceInvoice(
  input: ReverseServiceInvoiceInput,
  actor: Actor & { role?: string },
) {
  const key = input.clientRequestId.trim();
  if (!key) throw new TRPCError({ code: "BAD_REQUEST", message: "مفتاح طلب العكس مطلوب" });
  const preflight = await getWorkOrderReverseDeliveryPreflight(input.workOrderId, actor);
  if (!preflight.eligible) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: preflight.ineligibleReason });
  }
  if (Number(preflight.version) !== Number(input.expectedVersion)) {
    throw new TRPCError({ code: "CONFLICT", message: "تغيّرت نسخة أمر الشغل؛ حدّث الصفحة" });
  }
  return requestWorkOrderControl({
    requestType: "REVERSE_DELIVERY",
    requestKey: key,
    workOrderId: input.workOrderId,
    baseVersion: input.expectedVersion,
    reason: input.reason,
    payload: {
      expectedVersion: input.expectedVersion,
      reopen: false,
      refundShiftId: input.refundShiftId ?? null,
      refundSources: preflight.refundSources,
    },
  }, actor);
}
