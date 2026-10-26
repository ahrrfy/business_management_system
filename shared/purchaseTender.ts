import { z } from "zod";

const previousReceiptId = z.number().int().positive().optional();

/** Payment intent captured in the immutable purchase revision; never proof of payment. */
export const purchaseTenderSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("DRAWER"),
      shiftId: z.number().int().positive().optional(),
      previousReceiptId,
    })
    .strict(),
  z.object({ mode: z.literal("TREASURY"), previousReceiptId }).strict(),
  z
    .object({
      mode: z.literal("CARD"),
      accountId: z.number().int().positive(),
      referenceNumber: z.string().trim().min(1).max(160),
      cardLastFour: z.string().regex(/^\d{4}$/),
      previousReceiptId,
    })
    .strict(),
]);

export type PurchaseTenderInput = z.infer<typeof purchaseTenderSchema>;

export function purchaseTenderLabel(tender: PurchaseTenderInput): string {
  if (tender.mode === "CARD") return `بطاقة الشركة •••• ${tender.cardLastFour}`;
  return tender.mode === "TREASURY"
    ? "نقد من خزنة الفرع"
    : `نقد من الوردية${tender.shiftId ? ` #${tender.shiftId}` : ""}`;
}
