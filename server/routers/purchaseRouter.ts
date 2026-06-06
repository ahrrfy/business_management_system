import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { productUnits, productVariants, products, purchaseOrderItems, purchaseOrders, suppliers } from "../../drizzle/schema";
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
      return db
        .select({
          id: purchaseOrders.id,
          poNumber: purchaseOrders.poNumber,
          orderDate: purchaseOrders.orderDate,
          total: purchaseOrders.total,
          paidAmount: purchaseOrders.paidAmount,
          status: purchaseOrders.status,
          supplierName: suppliers.name,
        })
        .from(purchaseOrders)
        .leftJoin(suppliers, eq(purchaseOrders.supplierId, suppliers.id))
        .orderBy(desc(purchaseOrders.id))
        .limit(input?.limit ?? 50)
        .offset(input?.offset ?? 0);
    }),

  get: protectedProcedure.input(z.object({ purchaseOrderId: z.number().int().positive() })).query(async ({ input }) => {
    const db = getDb();
    if (!db) return null;
    const po = (
      await db
        .select({
          id: purchaseOrders.id,
          poNumber: purchaseOrders.poNumber,
          supplierId: purchaseOrders.supplierId,
          supplierName: suppliers.name,
          branchId: purchaseOrders.branchId,
          orderDate: purchaseOrders.orderDate,
          subtotal: purchaseOrders.subtotal,
          taxAmount: purchaseOrders.taxAmount,
          total: purchaseOrders.total,
          paidAmount: purchaseOrders.paidAmount,
          status: purchaseOrders.status,
          notes: purchaseOrders.notes,
        })
        .from(purchaseOrders)
        .leftJoin(suppliers, eq(purchaseOrders.supplierId, suppliers.id))
        .where(eq(purchaseOrders.id, input.purchaseOrderId))
        .limit(1)
    )[0];
    if (!po) return null;
    const items = await db
      .select({
        id: purchaseOrderItems.id,
        variantId: purchaseOrderItems.variantId,
        productUnitId: purchaseOrderItems.productUnitId,
        quantity: purchaseOrderItems.quantity,
        baseQuantity: purchaseOrderItems.baseQuantity,
        receivedBaseQuantity: purchaseOrderItems.receivedBaseQuantity,
        unitPrice: purchaseOrderItems.unitPrice,
        total: purchaseOrderItems.total,
        productName: products.name,
        sku: productVariants.sku,
        variantName: productVariants.variantName,
        unitName: productUnits.unitName,
      })
      .from(purchaseOrderItems)
      .leftJoin(productVariants, eq(purchaseOrderItems.variantId, productVariants.id))
      .leftJoin(products, eq(productVariants.productId, products.id))
      .leftJoin(productUnits, eq(purchaseOrderItems.productUnitId, productUnits.id))
      .where(eq(purchaseOrderItems.purchaseOrderId, input.purchaseOrderId));
    return { ...po, items };
  }),
});
