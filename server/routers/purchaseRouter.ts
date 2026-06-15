import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, lt } from "drizzle-orm";
import { z } from "zod";
import { productUnits, productVariants, products, purchaseOrderItems, purchaseOrders, suppliers } from "../../drizzle/schema";
import { getDb } from "../db";
import { maskCostFields } from "../lib/redact";
import { positiveMoneyString } from "../lib/schemas";
import { logAudit } from "../services/auditService";
import { localDayStart, localNextDayStart } from "../services/dateRange";
import { cancelPurchaseOrder, createPurchaseOrder, receivePurchase } from "../services/purchaseService";
import { branchScopedProcedure, canSeeCost, managerProcedure, router, warehouseProcedure } from "../trpc";

const method = z.enum(["CASH", "CARD", "CHECK", "TRANSFER", "WALLET"]);
// تاريخ فلترة YYYY-MM-DD (فلتر الفترة الخادمي على orderDate).
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح (YYYY-MM-DD)");

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
      const res = await createPurchaseOrder(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, { action: "purchase.createOrder", entityType: "purchaseOrder", entityId: (res as { purchaseOrderId?: number })?.purchaseOrderId, newValue: { supplierId: input.supplierId, items: input.items.length } });
      return res;
    }),

  receive: warehouseProcedure
    .input(
      z.object({
        purchaseOrderId: z.number().int().positive(),
        lines: z.array(z.object({ purchaseOrderItemId: z.number().int().positive(), receivedBaseQuantity: z.number().int().positive() })).min(1),
        payment: z.object({ amount: positiveMoneyString, method }).optional(),
        // idempotency: نفس المفتاح ⇒ استلام واحد (لا مخزون/AP/قيد/دفعة مزدوجة عند النقر المزدوج/إعادة الشبكة).
        clientRequestId: z.string().min(1).max(80).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await receivePurchase(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1, role: ctx.user.role });
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

  // إلغاء أمر شراء لم يُستلم منه شيء (قلب حالة خالص — الحارس المالي/المخزني في الخدمة).
  cancel: managerProcedure
    .input(z.object({ purchaseOrderId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const res = await cancelPurchaseOrder(input.purchaseOrderId, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1, role: ctx.user.role });
      await logAudit(ctx, {
        action: "purchase.cancelOrder",
        entityType: "purchaseOrder",
        entityId: input.purchaseOrderId,
        newValue: { status: "CANCELLED" },
      });
      return res;
    }),

  // F3 (تدقيق ١٤/٦/٢٦): list/get تحوّلتا إلى branchScopedProcedure — قبل ذلك كان مدير
  // فرع SALES يستطيع قراءة أوامر شراء فرع MAIN عبر استدعاء API مباشر (IDOR قراءة).
  list: branchScopedProcedure
    .input(
      z
        .object({
          limit: z.number().default(50),
          offset: z.number().default(0),
          // فلترة خادمية بالفترة (orderDate) والمورد والحالة.
          from: ymd.optional(),
          to: ymd.optional(),
          supplierId: z.number().int().positive().optional(),
          branchId: z.number().int().positive().optional(),
          status: z.enum(["DRAFT", "SENT", "CONFIRMED", "RECEIVED", "CANCELLED"]).optional(),
        })
        .optional()
    )
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) return [];
      const conds = [];
      // نصف مفتوح [from, to+يوم) بمنتصف ليلٍ محلي (Date("YYYY-MM-DD") = UTC ⇒ انزياح +03:00).
      if (input?.from) conds.push(gte(purchaseOrders.orderDate, localDayStart(input.from)));
      if (input?.to) conds.push(lt(purchaseOrders.orderDate, localNextDayStart(input.to)));
      if (input?.supplierId) conds.push(eq(purchaseOrders.supplierId, input.supplierId));
      if (input?.status) conds.push(eq(purchaseOrders.status, input.status));
      // عزل الفرع: غير المرتفعين يُقتصرون على فرعهم (يُغلَب على input.branchId).
      // admin/manager يحترمان input.branchId إن مُرِّر (تقارير عبر-الفروع).
      const branchId = ctx.scopedBranchId != null ? ctx.scopedBranchId : input?.branchId;
      if (branchId != null) conds.push(eq(purchaseOrders.branchId, branchId));
      const rows = await db
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
      // حجب التكلفة (total/paidAmount) عن غير المدير — نمط saleRouter.get:371.
      if (!canSeeCost(ctx.user.role)) {
        return rows.map((row) => ({ ...row, total: null, paidAmount: null }));
      }
      return rows;
    }),

  get: branchScopedProcedure.input(z.object({ purchaseOrderId: z.number().int().positive() })).query(async ({ input, ctx }) => {
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
    // عزل الفرع: لا يُكشَف وجود أمر شراء فرع آخر للأدوار غير المرتفعة (نمط sales.get / voucher.get).
    if (ctx.scopedBranchId != null && Number(po.branchId) !== ctx.scopedBranchId) return null;
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
    // حجب التكلفة عن غير المدير — نمط saleRouter.get:371.
    if (!canSeeCost(ctx.user.role)) {
      const poMasked = { ...po, subtotal: null, taxAmount: null, total: null, paidAmount: null };
      const itemsMasked = items.map((row) => maskCostFields(row, ctx.user.role));
      return { ...poMasked, items: itemsMasked };
    }
    return { ...po, items };
  }),
});
