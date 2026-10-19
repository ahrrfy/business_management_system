import { z } from "zod";
import { saleInput, collectionInput } from "../credit/http-input";
import { cashHttpInput } from "../cash/http-input";
const id = z.number().int().positive(),
  money = z.string().regex(/^\d{1,13}(\.\d{1,2})?$/),
  reason = z.string().trim().min(3).max(500);
export const returnInput = z
  .object({
    commandType: z.literal("RETURN"),
    branchId: id,
    shiftId: id,
    invoiceId: id,
    clientRequestId: z.string().regex(/^\w[\w:-]{7,49}$/),
    operatorReason: reason,
    lines: z
      .array(z.object({ invoiceItemId: id, baseQuantity: id }).strict())
      .min(1)
      .max(2),
    restock: z.boolean(),
    refund: z
      .object({ method: z.literal("CASH"), amount: money, shiftId: id })
      .strict()
      .nullable()
      .optional(),
    resolution: z
      .object({
        kind: z.literal("IMMEDIATE_REFUND"),
        method: z.literal("CASH"),
        amount: money,
        shiftId: id.nullable().optional(),
        reason,
        disposition: z.enum(["RESTOCK", "DAMAGED"]),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();
export const cashSaleInput = cashHttpInput
  .extend({ commandType: z.literal("CASH_SALE"), customerId: id.optional() })
  .strict();
export const creditHttpInput = z.discriminatedUnion("commandType", [
  saleInput,
  collectionInput,
  cashSaleInput,
  returnInput,
]);
