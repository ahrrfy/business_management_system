import { z } from "zod";
import { nonNegMoneyString } from "./moneySchemas";

/** Exact executePurchaseReturnCart transport input; safe for client preflight. */
export const purchaseReturnCartInputSchema = z.object({
      supplierId: z.number().int().positive(), branchId: z.number().int().positive().optional(),
      reference: z.string().trim().min(1).max(500),
      evidenceType: z.enum(["RETURN_NOTE","SUPPLIER_ACKNOWLEDGEMENT","DOCUMENT_IMAGE","PDF","EMAIL","OTHER"]),
      items: z.array(z.object({variantId:z.number().int().positive(),productUnitId:z.number().int().positive().optional(),productName:z.string().min(1),barcode:z.string().nullish(),quantity:z.number().int().positive(),unitCost:nonNegMoneyString})).min(1).max(500),
      settlement:z.object({method:z.enum(["CREDIT_OFFSET","CASH_IN","CARD_TRANSFER"]),totalAmount:nonNegMoneyString,shiftId:z.number().int().positive().nullish(),reference:z.string().trim().max(160).nullish()}),
      reason:z.string().trim().min(3).max(500),clientRequestId:z.string().min(1).max(64),
    });
