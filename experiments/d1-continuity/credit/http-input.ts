import { z } from "zod";
import { cashHttpInput } from "../cash/http-input";
const key = z.string().regex(/^\w[\w:-]{7,49}$/),
  money = z.string().regex(/^\d{1,13}(\.\d{1,2})?$/),
  id = z.number().int().positive();
export const saleInput = cashHttpInput
  .omit({ payment: true })
  .extend({
    commandType: z.literal("SALE"),
    clientRequestId: key,
    customerId: id,
    payment: z
      .object({ method: z.literal("CASH"), amount: money })
      .strict()
      .optional(),
  })
  .strict();
export const collectionInput = z
  .object({
    commandType: z.literal("COLLECT"),
    branchId: id,
    shiftId: id,
    invoiceId: id,
    clientRequestId: key,
    method: z.literal("CASH"),
    amount: money,
    reference: z.string().max(100).nullable().optional(),
  })
  .strict();
export const creditHttpInput = z.discriminatedUnion("commandType", [
  saleInput,
  collectionInput,
]);
