import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, lt } from "drizzle-orm";
import { z } from "zod";
import { productUnits, productVariants, products, purchaseOrderItems, purchaseOrders, suppliers } from "../../drizzle/schema";
import { getDb } from "../db";
import { logAudit } from "../services/auditService";
import { createPurchaseOrder, receivePurchase } from "../services/purchaseService";
import { managerProcedure, router, warehouseProcedure } from "../trpc";

const method = z.enum(["CASH", "CARD", "CHECK", "TRANSFER", "WALLET"]);
// تاريخ فلترة YYYY-MM-DD (فلتر الفترة الخادمي على orderDate).
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح (YYYY-MM-DD)");
/** orderDate عمود timestamp ⇒ «إلى تاريخ» شاملاً = أقل من اليوم التالي (لا تسقط أوامر بقية اليوم). */
function nextDay(d: string): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + 1);
  return x;
}

// المشتريات تحمل التكلفة (unitPrice = سعر الشراء) ⇒ مدير فأعلى للإنشاء والعرض، والمخزن للاستلام.
export const purchaseRouter = router({
  createOrder: managerProcedure
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
    .mutation(async ({ input, ctx }) => {
      const res = await createPurchaseOrder(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? input.branchId });
      await logAudit(ctx, { action: "purchase.createOrder", entityType: "purchaseOrder", entityId: (res as { purchaseOrderId?: number })?.purchaseOrderId, newValue: { supplierId: input.supplierId, items: input.items.length } });
      return res;
    }),

  receive: warehouseProcedure
    .input(
      z.object({
        purchaseOrderId: z.number().int().positive(),
        lines: z.array(z.object({ purchaseOrderItemId: z.number().int().positive(), receivedBaseQuantity: z.number().int().positive() })).min(1),
        payment: z.object({ amount: z.string(), method }).optional(),
        // idempotency: نفس المفتاح ⇒ استلام واحد (لا مخزون/AP/قيد/دفعة مزدوجة عند النقر المزدوج/إعادة الشبكة).
        clientRequestId: z.string().min(1).max(80).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await receivePurchase(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
          await logAudit(ctx, { action: "purchase.receive", entityType: "purchaseOrder", entityId: input.purchaseOrderId, newValue: { lines: input.lines.length } });
          return res;
        } catch (e: any) {
          if (e?.code === "ER_DUP_ENTRY" && attempt < 2) continue;
          if (e instanceof TRPCError) throw e;
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر إتمام الاستلام" });
        }
      }
      throw new TRPCError({ code: "CONFLICT", message: "تعذّر إتمام الاستلام (تكرار)" });
    }),

  list: managerProcedure
    .input(
      z
        .object({
          limit: z.number().default(50),
          offset: z.number().default(0),
          // فلترة خادمية بالفترة (orderDate) والمورد والحالة.
          from: ymd.optional(),
          to: ymd.optional(),
          supplierId: z.number().int().positive().optional(),
          status: z.enum(["DRAFT", "SENT", "CONFIRMED", "RECEIVED", "CANCELLED"]).optional(),
        })
        .optional()
    )
    .query(async ({ input }) => {
      const db = getDb();
      if (!db) return [];
      const conds = [];
      if (input?.from) conds.push(gte(purchaseOrders.orderDate, new Date(input.from)));
      if (input?.to) conds.push(lt(purchaseOrders.orderDate, nextDay(input.to)));
      if (input?.supplierId) conds.push(eq(purchaseOrders.supplierId, input.supplierId));
      if (input?.status) conds.push(eq(purchaseOrders.status, input.status));
      return db
        .select({
          id: purchaseOrders.id,
          poNumber: purchaseOrders.poNumber,
          orderDate: purchaseOrders.orderDate,
          // supplierId مطلوب لإجراءات الصف (كشف حساب المورد) في شاشة المشتريات.
          supplierId: purchaseOrders.supplierId,
          total: purchaseOrders.total,
          paidAmount: purchaseOrders.paidAmount,
          status: purchaseOrders.status,
          supplierName: suppliers.name,
        })
        .from(purchaseOrders)
        .leftJoin(suppliers, eq(purchaseOrders.supplierId, suppliers.id))
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(purchaseOrders.id))
        .limit(input?.limit ?? 50)
        .offset(input?.offset ?? 0);
    }),

  get: managerProcedure.input(z.object({ purchaseOrderId: z.number().int().positive() })).query(async ({ input }) => {
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
