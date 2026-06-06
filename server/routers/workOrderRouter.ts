import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  customers,
  productVariants,
  products,
  workOrderMaterials,
  workOrders,
} from "../../drizzle/schema";
import { getDb } from "../db";
import {
  cancelWorkOrder,
  createWorkOrder,
  deliverWorkOrder,
  markWorkOrderReady,
  startWorkOrder,
} from "../services/workOrderService";
import { protectedProcedure, router } from "../trpc";

const method = z.enum(["CASH", "CARD", "CHECK", "TRANSFER", "WALLET"]);

export const workOrderRouter = router({
  list: protectedProcedure
    .input(z.object({ limit: z.number().default(100), branchId: z.number().int().positive().optional() }).optional())
    .query(async ({ input }) => {
      const db = getDb();
      if (!db) return [];
      const q = db
        .select({
          id: workOrders.id,
          orderNumber: workOrders.orderNumber,
          title: workOrders.title,
          quantity: workOrders.quantity,
          status: workOrders.status,
          salePrice: workOrders.salePrice,
          dueDate: workOrders.dueDate,
          createdAt: workOrders.createdAt,
          customerName: customers.name,
        })
        .from(workOrders)
        .leftJoin(customers, eq(workOrders.customerId, customers.id))
        .orderBy(desc(workOrders.id))
        .limit(input?.limit ?? 100);
      return q;
    }),

  get: protectedProcedure.input(z.object({ workOrderId: z.number().int().positive() })).query(async ({ input }) => {
    const db = getDb();
    if (!db) return null;
    const wo = (
      await db
        .select({
          id: workOrders.id,
          orderNumber: workOrders.orderNumber,
          title: workOrders.title,
          customizationText: workOrders.customizationText,
          quantity: workOrders.quantity,
          status: workOrders.status,
          branchId: workOrders.branchId,
          customerId: workOrders.customerId,
          customerName: customers.name,
          baseVariantId: workOrders.baseVariantId,
          materialsCost: workOrders.materialsCost,
          laborCost: workOrders.laborCost,
          salePrice: workOrders.salePrice,
          dueDate: workOrders.dueDate,
          invoiceId: workOrders.invoiceId,
          deliveredAt: workOrders.deliveredAt,
          createdAt: workOrders.createdAt,
        })
        .from(workOrders)
        .leftJoin(customers, eq(workOrders.customerId, customers.id))
        .where(eq(workOrders.id, input.workOrderId))
        .limit(1)
    )[0];
    if (!wo) return null;
    const materials = await db
      .select({
        id: workOrderMaterials.id,
        variantId: workOrderMaterials.variantId,
        baseQuantity: workOrderMaterials.baseQuantity,
        unitCost: workOrderMaterials.unitCost,
        productName: products.name,
        sku: productVariants.sku,
        variantName: productVariants.variantName,
      })
      .from(workOrderMaterials)
      .leftJoin(productVariants, eq(workOrderMaterials.variantId, productVariants.id))
      .leftJoin(products, eq(productVariants.productId, products.id))
      .where(eq(workOrderMaterials.workOrderId, input.workOrderId));
    return { ...wo, materials };
  }),

  create: protectedProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        customerId: z.number().int().positive().nullish(),
        baseVariantId: z.number().int().positive(),
        title: z.string().min(1),
        customizationText: z.string().nullish(),
        quantity: z.number().int().positive().default(1),
        materials: z
          .array(z.object({ variantId: z.number().int().positive(), baseQuantity: z.number().int().positive() }))
          .default([]),
        laborCost: z.string().default("0"),
        salePrice: z.string(),
        dueDate: z.string().nullish(), // YYYY-MM-DD
        notes: z.string().nullish(),
      })
    )
    .mutation(({ input, ctx }) => createWorkOrder(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? input.branchId })),

  start: protectedProcedure
    .input(z.object({ workOrderId: z.number().int().positive() }))
    .mutation(({ input, ctx }) => startWorkOrder(input.workOrderId, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 })),

  markReady: protectedProcedure
    .input(z.object({ workOrderId: z.number().int().positive() }))
    .mutation(({ input }) => markWorkOrderReady(input.workOrderId)),

  deliver: protectedProcedure
    .input(
      z.object({
        workOrderId: z.number().int().positive(),
        payment: z.object({ amount: z.string(), method }).optional(),
      })
    )
    .mutation(({ input, ctx }) => deliverWorkOrder(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 })),

  cancel: protectedProcedure
    .input(z.object({ workOrderId: z.number().int().positive() }))
    .mutation(({ input, ctx }) => cancelWorkOrder(input.workOrderId, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 })),
});
