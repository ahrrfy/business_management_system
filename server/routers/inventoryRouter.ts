import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { branchStock, inventoryMovements } from "../../drizzle/schema";
import { getDb } from "../db";
import { setStock, transferBetweenBranches } from "../services/inventoryService";
import { withTx } from "../services/tx";
import { protectedProcedure, router } from "../trpc";

export const inventoryRouter = router({
  transfer: protectedProcedure
    .input(
      z.object({
        variantId: z.number().int().positive(),
        fromBranchId: z.number().int().positive(),
        toBranchId: z.number().int().positive(),
        baseQuantity: z.number().int().positive(),
        notes: z.string().optional(),
      })
    )
    .mutation(({ input, ctx }) =>
      withTx((tx) => transferBetweenBranches(tx, { ...input, createdBy: ctx.user.id }))
    ),

  adjust: protectedProcedure
    .input(
      z.object({
        variantId: z.number().int().positive(),
        branchId: z.number().int().positive(),
        targetQuantity: z.number().int().min(0),
        notes: z.string().optional(),
      })
    )
    .mutation(({ input, ctx }) => withTx((tx) => setStock(tx, { ...input, createdBy: ctx.user.id }))),

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
