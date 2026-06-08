import { z } from "zod";
import { assignBarcode, createProduct, getProductForEdit, listForPos, listForPurchase, lookupByBarcode, updateProduct } from "../services/catalogService";
import { logAudit } from "../services/auditService";
import { managerProcedure, protectedProcedure, router } from "../trpc";

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

  // Purchase-side product search: carries COST (not a sell price). مدير فأعلى (يكشف التكلفة).
  forPurchase: managerProcedure
    .input(z.object({ branchId: z.number().int().positive(), query: z.string().optional(), limit: z.number().default(50) }))
    .query(({ input }) => listForPurchase(input.branchId, input.query, input.limit)),

  createProduct: managerProcedure
    .input(
      z.object({
        name: z.string().min(1),
        categoryId: z.number().int().positive().optional(),
        isCustomizable: z.boolean().optional(),
        variants: z.array(variantSchema).min(1),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const res = await createProduct(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, { action: "product.create", entityType: "product", entityId: (res as { productId?: number })?.productId, newValue: { name: input.name } });
      return res;
    }),

  // شاشة التعديل تكشف costPrice ⇒ مدير فأعلى.
  getForEdit: managerProcedure
    .input(z.object({ productId: z.number().int().positive() }))
    .query(({ input }) => getProductForEdit(input.productId)),

  // §٧ (RBAC): updateProduct يكشف costPrice ويعدّل أسعاراً ⇒ مدير فأعلى (كان protectedProcedure
  // وسمح للكاشير بتعديل التكاليف).
  updateProduct: managerProcedure
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
    .mutation(async ({ input, ctx }) => {
      // §٧ audit oldValue: لقطة سريعة قبل التحديث (للتدقيق الفروقات).
      const before = await getProductForEdit(input.productId);
      const oldVariantsSummary = before?.variants.map((v) => ({
        id: v.id,
        sku: v.sku,
        costPrice: v.costPrice,
      })) ?? [];
      const res = await updateProduct(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, {
        action: "product.update",
        entityType: "product",
        entityId: input.productId,
        oldValue: { name: before?.name, isActive: before?.isActive, variants: oldVariantsSummary },
        newValue: {
          name: input.name,
          isActive: input.isActive,
          variants: input.variants.map((v) => ({ id: v.id, sku: v.sku, costPrice: v.costPrice })),
        },
      });
      return res;
    }),

  assignBarcode: managerProcedure
    .input(z.object({ productUnitId: z.number().int().positive(), barcode: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      const res = await assignBarcode(input.productUnitId, input.barcode);
      await logAudit(ctx, { action: "product.assignBarcode", entityType: "productUnit", entityId: input.productUnitId, newValue: { barcode: input.barcode } });
      return res;
    }),
});
