import { z } from 'zod';
import {nonNegMoneyString,percentString,positiveMoneyString,positiveQtyString} from '../../../server/lib/schemas';

// The InTx service expects typed input. Keep the admitted HTTP slice strict,
// using the original public API scalar validators before any journal write.
const id=z.number().int().positive();
export const cashHttpInput=z.object({
  branchId:id,shiftId:id.optional(),sourceType:z.literal('POS'),
  clientRequestId:z.string().min(8).max(100),
  lines:z.array(z.object({
    variantId:id,productUnitId:id,
    quantity:positiveQtyString.refine(s=>Number(s)<=1_000_000),
    discountPercent:nonNegMoneyString.optional(),discountAmount:nonNegMoneyString.optional(),
  }).strict()).min(1).max(4),
  payment:z.object({method:z.literal('CASH'),amount:positiveMoneyString}).strict(),
  cashRoundIQD:z.boolean().optional(),
  invoiceDiscount:nonNegMoneyString.optional(),taxRatePercent:percentString.optional(),
  priceTier:z.enum(['RETAIL','WHOLESALE','GOVERNMENT']).optional(),
  notes:z.string().optional(),contactName:z.string().max(255).nullish(),
  contactPhone:z.string().max(32).nullish(),deviceId:z.string().trim().min(1).max(64).optional(),
}).strict();
