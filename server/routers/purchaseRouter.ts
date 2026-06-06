import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { purchaseOrderItems, purchaseOrders } from "../../drizzle/schema";
import { getDb } from "../db";
import { createPurchaseOrder, receivePurchase } from "../services/purchaseService";
import { protectedProcedure, router } from "../trpc";

const method = z.enum(["CASH", "CARD", "CHECK", "TRANSFER", "WALLET"]);

export const purchaseRouter = router({
  createOrder: protectedProcedure
    .input(
      z.object({
        supplierId: z.number().int().positive(),
        branchId: z.number().int().positive(),
        taxRatePercent: z.string().optional(),
        status: z.enum(["DRAFT", "SENT", "CONFIRMED"]).optional(),
        items: z
          .array(
            z.object({
              variantId: z.number().int().positive(),
              productUnitId: z.number().int().positive(),
              quantity: z.string(),
              unitPrice: z.string(),
            })
          )
          .min(1),
        notes: z.string().optional(),
      })
    )
    .mutation(({ input, ctx }) => createPurchaseOrder(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? input.branchId })),

  receive: protectedProcedure
    .input(
      z.object({
        purchaseOrderId: z.number().int().positive(),
        lines: z.array(z.object({ purchaseOrderItemId: z.number().int().positive(), receivedBaseQuantity: z.number().int().positive() })).min(1),
        payment: z.object({ amount: z.string(), method }).optional(),
      })
    )
    .mutation(({ input, ctx }) => receivePurchase(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 })),

  list: protectedProcedure
    .input(z.object({ limit: z.number().default(50), offset: z.number().default(0) }).optional())
    .query(async ({ input }) => {
      const db = getDb();
      if (!db) return [];
      return db.select().from(purchaseOrders).orderBy(desc(purchaseOrders.id)).limit(input?.limit ?? 50).offset(input?.offset ?? 0);
    }),

  get: protectedProcedure.input(z.object({ purchaseOrderId: z.number().int().positive() })).query(async ({ input }) => {
    const db = getDb();
    if (!db) return null;
    const po = (await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, input.purchaseOrderId)).limit(1))[0];
    if (!po) return null;
    const items = await db.select().from(purchaseOrderItems).where(eq(purchaseOrderItems.purchaseOrderId, input.purchaseOrderId));
    return { ...po, items };
  }),
});
