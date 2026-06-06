import { z } from "zod";
import { createProduct, listForPos, lookupByBarcode } from "../services/catalogService";
import { protectedProcedure, router } from "../trpc";

const tier = z.enum(["RETAIL", "WHOLESALE", "GOVERNMENT"]).default("RETAIL");

const priceSchema = z.object({ priceTier: z.enum(["RETAIL", "WHOLESALE", "GOVERNMENT"]), price: z.string() });
const unitSchema = z.object({
  unitName: z.string().min(1),
  conversionFactor: z.string(),
  barcode: z.string().optional(),
  isBaseUnit: z.boolean().optional(),
  prices: z.array(priceSchema).optional(),
});
const variantSchema = z.object({
  sku: z.string().min(1),
  variantName: z.string().optional(),
  color: z.string().optional(),
  size: z.string().optional(),
  costPrice: z.string(),
  units: z.array(unitSchema).min(1),
});

export const catalogRouter = router({
  posList: protectedProcedure
    .input(z.object({ branchId: z.number().int().positive(), tier, query: z.string().optional(), limit: z.number().default(200) }))
    .query(({ input }) => listForPos(input.branchId, input.tier, input.query, input.limit)),

  byBarcode: protectedProcedure
    .input(z.object({ barcode: z.string().min(1), branchId: z.number().int().positive(), tier }))
    .query(({ input }) => lookupByBarcode(input.barcode, input.branchId, input.tier)),

  createProduct: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1),
        categoryId: z.number().int().positive().optional(),
        isCustomizable: z.boolean().optional(),
        variants: z.array(variantSchema).min(1),
      })
    )
    .mutation(({ input, ctx }) => createProduct(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 })),
});
