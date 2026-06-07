import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { branchStock, inventoryMovements } from "../../drizzle/schema";
import { getDb } from "../db";
import { logAudit } from "../services/auditService";
import { setStock, transferBetweenBranches } from "../services/inventoryService";
import { withTx } from "../services/tx";
import { protectedProcedure, router, warehouseProcedure } from "../trpc";

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
