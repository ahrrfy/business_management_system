import { z } from "zod";
import {
  convertQuotation,
  createQuotation,
  getQuotation,
  listQuotations,
  setQuotationStatus,
} from "../services/quotationService";
import { logAudit } from "../services/auditService";
import { protectedProcedure, router } from "../trpc";

const method = z.enum(["CASH", "CARD", "CHECK", "TRANSFER", "WALLET"]);
const tier = z.enum(["RETAIL", "WHOLESALE", "GOVERNMENT"]);

export const quotationRouter = router({
  list: protectedProcedure
    .input(z.object({ limit: z.number().default(100) }).optional())
    .query(({ input }) => listQuotations(input?.limit ?? 100)),

  get: protectedProcedure
    .input(z.object({ quotationId: z.number().int().positive() }))
    .query(({ input }) => getQuotation(input.quotationId)),

  create: protectedProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        customerId: z.number().int().positive().nullish(),
        priceTier: tier.nullish(),
        validUntil: z.string().nullish(),
        invoiceDiscount: z.string().nullish(),
        taxRatePercent: z.string().nullish(),
        notes: z.string().nullish(),
        lines: z
          .array(
            z.object({
              variantId: z.number().int().positive(),
              productUnitId: z.number().int().positive(),
              quantity: z.string(),
              unitPriceOverride: z.string().nullish(),
              discountPercent: z.string().nullish(),
              discountAmount: z.string().nullish(),
            })
          )
          .min(1),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const res = await createQuotation(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? input.branchId });
      await logAudit(ctx, { action: "quotation.create", entityType: "quotation", entityId: (res as { quotationId?: number })?.quotationId, newValue: { lines: input.lines.length, customerId: input.customerId } });
      return res;
    }),

  setStatus: protectedProcedure
    .input(z.object({ quotationId: z.number().int().positive(), status: z.enum(["DRAFT", "SENT", "ACCEPTED", "REJECTED", "EXPIRED"]) }))
    .mutation(async ({ input, ctx }) => {
      const res = await setQuotationStatus(input.quotationId, input.status);
      await logAudit(ctx, { action: "quotation.setStatus", entityType: "quotation", entityId: input.quotationId, newValue: { status: input.status } });
      return res;
    }),

  convert: protectedProcedure
    .input(
      z.object({
        quotationId: z.number().int().positive(),
        payment: z.object({ amount: z.string(), method }).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const res = await convertQuotation(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, { action: "quotation.convert", entityType: "quotation", entityId: input.quotationId, newValue: { invoiceId: (res as { invoiceId?: number })?.invoiceId } });
      return res;
    }),
});
