import { TRPCError } from "@trpc/server";
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
import { logAudit } from "../services/auditService";
import { branchScopedProcedure, canSeeCost, cashierProcedure, managerProcedure, protectedProcedure, router } from "../trpc";
import { workOrderBarcodeSet } from "../services/barcodeService";

const method = z.enum(["CASH", "CARD", "CHECK", "TRANSFER", "WALLET"]);

export const workOrderRouter = router({
  // §٧ IDOR: الكاشير لا يجب أن يرى أوامر فروع أخرى. branchScopedProcedure يحقن
  // scopedBranchId=null للمدير/admin، ورقم الفرع لغيرهما.
  list: branchScopedProcedure
    .input(z.object({ limit: z.number().default(100), branchId: z.number().int().positive().optional() }).optional())
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) return [];
      const conds = [];
      // إن كان للمستخدم نطاق فرع ⇒ نُجبره ولا نسمح بالمرور حوله. للمرتفعين يطبَّق الفلتر إن أُعطي.
      const effectiveBranchId = ctx.scopedBranchId ?? input?.branchId;
      if (effectiveBranchId != null) conds.push(eq(workOrders.branchId, effectiveBranchId));
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
        .where(conds.length ? conds[0] : undefined)
        .orderBy(desc(workOrders.id))
        .limit(input?.limit ?? 100);
      return q;
    }),

  get: branchScopedProcedure.input(z.object({ workOrderId: z.number().int().positive() })).query(async ({ input, ctx }) => {
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
    // §٧ IDOR: لا تكشف وجود أمر فرع آخر لغير المدير.
    if (ctx.scopedBranchId != null && Number(wo.branchId) !== ctx.scopedBranchId) return null;
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
    const qrPayload = workOrderBarcodeSet({
      orderNumber: wo.orderNumber,
      createdAt: wo.createdAt instanceof Date ? wo.createdAt : new Date(wo.createdAt),
      branchId: wo.branchId,
    }).qrPayload;
    // §٧ تكلفة: نُخفي materialsCost/laborCost/unitCost عن غير المرتفعين (defense-in-depth).
    // نُبقي شكل الـtype ثابتاً (null بدلاً من حذف الحقول) لئلا تنكسر شاشة التفاصيل.
    if (!canSeeCost(ctx.user.role)) {
      const safeMaterials = materials.map((m) => ({ ...m, unitCost: null as unknown as string }));
      return {
        ...wo,
        materialsCost: null as unknown as string,
        laborCost: null as unknown as string,
        materials: safeMaterials,
        qrPayload,
      };
    }
    return { ...wo, materials, qrPayload };
  }),

  create: cashierProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        customerId: z.number().int().positive().nullish(),
        // v3-add-screens(100%): اختياري لخدمة تخصيص خالصة بلا منتج خام.
        baseVariantId: z.number().int().positive().nullish(),
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
        // v3-add-screens(100%): قنوات استلام.
        receptionChannel: z.enum(["WALK_IN", "WHATSAPP", "INSTAGRAM", "TIKTOK", "PHONE", "OTHER"]).nullish(),
        channelHandle: z.string().max(120).nullish(),
        // v3-add-screens(100%): أولوية + دفع + توصيل.
        priority: z.enum(["LOW", "NORMAL", "URGENT"]).nullish(),
        deposit: z.string().nullish(),
        paymentMethod: z.enum(["CASH", "CARD"]).nullish(),
        paymentReference: z.string().max(100).nullish(),
        paymentReceiptUrl: z.string().nullish(),
        hasDelivery: z.boolean().nullish(),
        deliveryAddress: z.string().nullish(),
        deliveryCost: z.string().nullish(),
        // v3-add-screens(100%): أصناف نقطة البيع المصغّرة.
        items: z.array(z.object({
          variantId: z.number().int().positive(),
          productUnitId: z.number().int().positive().nullish(),
          quantity: z.string(),
          baseQuantity: z.number().int().positive(),
          unitPrice: z.string(),
          discountAmount: z.string().nullish(),
          total: z.string(),
        })).default([]),
        // v3-add-screens(100%): صور نموذج العمل.
        designImages: z.array(z.object({
          url: z.string().min(1),
          caption: z.string().max(255).nullish(),
          sortOrder: z.number().int().min(0).nullish(),
        })).max(10).default([]),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const res = await createWorkOrder(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? input.branchId });
      await logAudit(ctx, {
        action: "workOrder.create",
        entityType: "workOrder",
        entityId: (res as { workOrderId?: number })?.workOrderId,
        newValue: {
          title: input.title, qty: input.quantity,
          channel: input.receptionChannel ?? null,
          priority: input.priority ?? null,
          paymentMethod: input.paymentMethod ?? null,
          hasDelivery: !!input.hasDelivery,
          itemsCount: input.items?.length ?? 0,
          imagesCount: input.designImages?.length ?? 0,
        },
      });
      return res;
    }),

  start: cashierProcedure
    .input(z.object({ workOrderId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const res = await startWorkOrder(input.workOrderId, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1, role: ctx.user.role });
      await logAudit(ctx, { action: "workOrder.start", entityType: "workOrder", entityId: input.workOrderId });
      return res;
    }),

  markReady: cashierProcedure
    .input(z.object({ workOrderId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const res = await markWorkOrderReady(input.workOrderId, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1, role: ctx.user.role });
      await logAudit(ctx, { action: "workOrder.markReady", entityType: "workOrder", entityId: input.workOrderId });
      return res;
    }),

  deliver: cashierProcedure
    .input(
      z.object({
        workOrderId: z.number().int().positive(),
        payment: z.object({ amount: z.string(), method }).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // ER_DUP_ENTRY على invoiceNumber ممكن تحت تزامن POS+WO ⇒ أعد المحاولة ٣ مرات كـsaleRouter.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await deliverWorkOrder(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1, role: ctx.user.role });
          await logAudit(ctx, { action: "workOrder.deliver", entityType: "workOrder", entityId: input.workOrderId });
          return res;
        } catch (e: any) {
          if (e?.code === "ER_DUP_ENTRY" && attempt < 2) continue;
          if (e instanceof TRPCError) throw e;
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر تسليم أمر الشغل" });
        }
      }
      throw new TRPCError({ code: "CONFLICT", message: "تعذّر توليد رقم فاتورة فريد" });
    }),

  // الإلغاء يعكس مخزوناً/قيوداً ⇒ مدير فأعلى.
  cancel: managerProcedure
    .input(z.object({ workOrderId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const res = await cancelWorkOrder(input.workOrderId, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1, role: ctx.user.role });
      await logAudit(ctx, { action: "workOrder.cancel", entityType: "workOrder", entityId: input.workOrderId });
      return res;
    }),
});
