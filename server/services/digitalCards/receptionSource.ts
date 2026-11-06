import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { appErrorMessage } from "../../../shared/errors";
import { roundCashIQD, toDbMoney } from "../money";

const receptionSourceSchema = z.object({
  version: z.literal(1),
  contactName: z.string().trim().max(200).nullish(),
  contactPhone: z.string().trim().max(25).nullish(),
  cashRoundIQD: z.boolean().default(false),
}).strict();

export type ReceptionDigitalSource = z.infer<typeof receptionSourceSchema>;

export function isCapturedReceptionCash(paymentMethod: string, checkout: { sourceType?: string; sourcePayload?: unknown } | null) {
  const source = checkout?.sourcePayload;
  return paymentMethod === "CASH" && checkout?.sourceType === "RECEPTION" && source != null && typeof source === "object"
    && "version" in source && source.version === 1;
}

export function parseReceptionSource(value: unknown, paymentMethod: string): ReceptionDigitalSource {
  const parsed = receptionSourceSchema.safeParse(value);
  if (!parsed.success || !["CASH", "CARD"].includes(paymentMethod) || (paymentMethod !== "CASH" && parsed.data?.cashRoundIQD)) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: appErrorMessage({
      what: "تعذّر إعداد بيع الكروت من الاستقبال",
      why: "عقد الاستقبال غير صالح أو يحمل طريقة دفع أو تقريباً غير متوافقين",
      doThis: "حدّث الشاشة وأعد إعداد البيع نقداً أو ببطاقة؛ إن صدرت الكروت فاستعمل المراجعة دون إعادة إصدارها",
    }) });
  }
  return parsed.data;
}

/** Channel is selected from the validated business source, never from an arbitrary client value. */
export function digitalPaymentChannel(sourceType?: string | null): "POS" | "PRINT_POS" {
  return sourceType === "RECEPTION" ? "PRINT_POS" : "POS";
}

export function receptionIntentTotal(rawTotal: string, source: ReceptionDigitalSource | null): string {
  return toDbMoney(source?.cashRoundIQD ? roundCashIQD(rawTotal) : rawTotal);
}

type PublicIntentInput = {
  id: number; branchId: number; shiftId: number; createdBy: number; status: string;
  paymentMethod: string; expectedTotal: string; clientRequestId: string; expiresAt: Date;
  invoiceId: number | null; externalPaymentAttemptId?: number | null; externalPaymentDeviceId?: string | null;
  checkoutSnapshot?: { customerId?: number | null; priceTier?: string; sourceType?: string } | null;
};

/** Cost/approval/capability snapshots remain server-only, including when the caller owns the intent. */
export function publicDigitalIntent<T extends PublicIntentInput>(intent: T) {
  return {
    id: intent.id, branchId: intent.branchId, shiftId: intent.shiftId, createdBy: intent.createdBy,
    status: intent.status, paymentMethod: intent.paymentMethod, expectedTotal: intent.expectedTotal,
    clientRequestId: intent.clientRequestId, expiresAt: intent.expiresAt, invoiceId: intent.invoiceId,
    externalPaymentAttemptId: intent.externalPaymentAttemptId ?? null,
    externalPaymentDeviceId: intent.externalPaymentDeviceId ?? null,
    customerId: intent.checkoutSnapshot?.customerId ?? null,
    priceTier: intent.checkoutSnapshot?.priceTier ?? null,
    sourceType: intent.checkoutSnapshot?.sourceType ?? "POS",
  };
}
