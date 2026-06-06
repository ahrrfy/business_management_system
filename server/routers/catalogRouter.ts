import { z } from "zod";
import { createProduct, getProductForEdit, listForPos, listForPurchase, lookupByBarcode, updateProduct } from "../services/catalogService";
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
  openingStock: z.number().int().min(0).optional(),
  units: z.array(unitSchema).min(1),
});

export const catalogRouter = router({
  posList: protectedProcedure
    .input(z.object({ branchId: z.number().int().positive(), tier, query: z.string().optional(), limit: z.number().default(200) }))
    .query(({ input }) => listForPos(input.branchId, input.tier, input.query, input.limit)),

  byBarcode: protectedProcedure
    .input(z.object({ barcode: z.string().min(1), branchId: z.number().int().positive(), tier }))
    .query(({ input }) => lookupByBarcode(input.barcode, input.branchId, input.tier)),

  // Purchase-side product search: carries COST (not a sell price). Used only by the purchase-order screen.
  forPurchase: protectedProcedure
    .input(z.object({ branchId: z.number().int().positive(), query: z.string().optional(), limit: z.number().default(50) }))
    .query(({ input }) => listForPurchase(input.branchId, input.query, input.limit)),

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

  getForEdit: protectedProcedure
    .input(z.object({ productId: z.number().int().positive() }))
    .query(({ input }) => getProductForEdit(input.productId)),

  updateProduct: protectedProcedure
    .input(
      z.object({
        productId: z.number().int().positive(),
        name: z.string().min(1),
        categoryId: z.number().int().positive().nullish(),
        isCustomizable: z.boolean().optional(),
        isActive: z.boolean().optional(),
        variants: z
          .array(
            z.object({
              id: z.number().int().positive(),
              sku: z.string().min(1),
              variantName: z.string().nullish(),
              color: z.string().nullish(),
              size: z.string().nullish(),
              costPrice: z.string(),
              units: z
                .array(
                  z.object({
                    id: z.number().int().positive().optional(),
                    unitName: z.string().min(1),
                    conversionFactor: z.string(),
                    barcode: z.string().nullish(),
                    isBaseUnit: z.boolean().optional(),
                    prices: z.array(priceSchema).optional(),
                  })
                )
                .min(1),
            })
          )
          .min(1),
      })
    )
    .mutation(({ input, ctx }) => updateProduct(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 })),
});
