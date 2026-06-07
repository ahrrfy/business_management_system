import { and, asc, desc, eq, like, or, sql } from "drizzle-orm";
import { z } from "zod";
import { branchStock, inventoryMovements, productVariants, products } from "../../drizzle/schema";
import { getDb } from "../db";
import { logAudit } from "../services/auditService";
import { setStock, transferBetweenBranches } from "../services/inventoryService";
import { withTx } from "../services/tx";
import { branchScopedProcedure, protectedProcedure, router, warehouseProcedure } from "../trpc";

export const inventoryRouter = router({
  transfer: warehouseProcedure
    .input(
      z.object({
        variantId: z.number().int().positive(),
        fromBranchId: z.number().int().positive(),
        toBranchId: z.number().int().positive(),
        baseQuantity: z.number().int().positive(),
        notes: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const res = await withTx((tx) => transferBetweenBranches(tx, { ...input, createdBy: ctx.user.id }));
      await logAudit(ctx, { action: "inventory.transfer", entityType: "stock", entityId: input.variantId, newValue: { from: input.fromBranchId, to: input.toBranchId, qty: input.baseQuantity } });
      return res;
    }),

  adjust: warehouseProcedure
    .input(
      z.object({
        variantId: z.number().int().positive(),
        branchId: z.number().int().positive(),
        targetQuantity: z.number().int().min(0),
        notes: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const res = await withTx((tx) => setStock(tx, { ...input, createdBy: ctx.user.id }));
      await logAudit(ctx, { action: "inventory.adjust", entityType: "stock", entityId: input.variantId, newValue: { branchId: input.branchId, target: input.targetQuantity } });
      return res;
    }),

  /**
   * الأرصدة الحالية لكل متغيّر في فرع، بالأسماء + علم «تحت الحد الأدنى».
   * عزل الفرع: الكاشير/المخزن يُقيَّدان بفرعهما؛ المدير/الأدمن يختاران (افتراضي فرعهما).
   * لا تُعاد التكلفة (لا تسريب هامش الربح).
   */
  onHand: branchScopedProcedure
    .input(
      z
        .object({
          branchId: z.number().int().positive().optional(),
          q: z.string().optional(),
          lowOnly: z.boolean().default(false),
          limit: z.number().int().positive().max(1000).default(300),
        })
        .optional()
    )
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) return [];
      const branchId = ctx.scopedBranchId ?? input?.branchId ?? ctx.user.branchId ?? 1;

      const conds: any[] = [eq(branchStock.branchId, branchId)];
      const search = input?.q?.trim();
      if (search) {
        const pat = `%${search}%`;
        conds.push(
          or(like(products.name, pat), like(productVariants.sku, pat), like(productVariants.variantName, pat))
        );
      }
      if (input?.lowOnly) {
        conds.push(sql`${productVariants.minStock} > 0 AND ${branchStock.quantity} <= ${productVariants.minStock}`);
      }

      const rows = await db
        .select({
          variantId: branchStock.variantId,
          branchId: branchStock.branchId,
          quantity: branchStock.quantity,
          sku: productVariants.sku,
          variantName: productVariants.variantName,
          color: productVariants.color,
          size: productVariants.size,
          minStock: productVariants.minStock,
          reorderPoint: productVariants.reorderPoint,
          productName: products.name,
        })
        .from(branchStock)
        .innerJoin(productVariants, eq(productVariants.id, branchStock.variantId))
        .innerJoin(products, eq(products.id, productVariants.productId))
        .where(and(...conds))
        .orderBy(asc(products.name), asc(productVariants.sku))
        .limit(input?.limit ?? 300);

      return rows.map((r) => ({
        ...r,
        isLow: (r.minStock ?? 0) > 0 && r.quantity <= (r.minStock ?? 0),
      }));
    }),

  stockByBranch: protectedProcedure
    .input(z.object({ branchId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const db = getDb();
      if (!db) return [];
      return db.select().from(branchStock).where(eq(branchStock.branchId, input.branchId));
    }),

  movements: protectedProcedure
    .input(z.object({ variantId: z.number().int().positive().optional(), branchId: z.number().int().positive().optional(), limit: z.number().default(100) }))
    .query(async ({ input }) => {
      const db = getDb();
      if (!db) return [];
      const conds = [];
      if (input.variantId) conds.push(eq(inventoryMovements.variantId, input.variantId));
      if (input.branchId) conds.push(eq(inventoryMovements.branchId, input.branchId));
      const q = db.select().from(inventoryMovements);
      return (conds.length ? q.where(and(...conds)) : q).orderBy(desc(inventoryMovements.id)).limit(input.limit);
    }),
});
