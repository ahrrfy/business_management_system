import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  auditLogs,
  customers,
  productVariants,
  products,
  users,
  workOrderImages,
  workOrderMaterials,
  workOrders,
} from "../../drizzle/schema";
import { getDb } from "../db";
import {
  cancelWorkOrder,
  claimWorkOrder,
  createWorkOrder,
  deliverWorkOrder,
  markWorkOrderReady,
  startWorkOrder,
} from "../services/workOrderService";
import { logAudit } from "../services/auditService";
import { branchScopedProcedure, canSeeCost, cashierProcedure, managerProcedure, protectedProcedure, router, workOrderExecProcedure } from "../trpc";
import { workOrderBarcodeSet } from "../services/barcodeService";
import { positiveMoneyString } from "../lib/schemas";
import { assertValidImageDataUrl } from "../lib/imageValidation";

const method = z.enum(["CASH", "CARD", "CHECK", "TRANSFER", "WALLET"]);

export const workOrderRouter = router({
  // §٧ IDOR: الكاشير لا يجب أن يرى أوامر فروع أخرى. branchScopedProcedure يحقن
  // scopedBranchId=null للمدير/admin، ورقم الفرع لغيرهما.
  list: branchScopedProcedure
    .input(z.object({ limit: z.number().default(100), branchId: z.number().int().positive().optional() }).optional())
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) return [];
      // إن كان للمستخدم نطاق فرع ⇒ نُجبره ولا نسمح بالمرور حوله. للمرتفعين يطبَّق الفلتر إن أُعطي.
      const effectiveBranchId = ctx.scopedBranchId ?? input?.branchId;
      const whereCond = effectiveBranchId != null ? eq(workOrders.branchId, effectiveBranchId) : undefined;
      // لوحة الكانبان: نُرجع كل ما تحتاجه البطاقة (أولوية/قناة/مسؤول/هاتف العميل/عربون).
      const rows = await db
        .select({
          id: workOrders.id,
          orderNumber: workOrders.orderNumber,
          title: workOrders.title,
          quantity: workOrders.quantity,
          status: workOrders.status,
          priority: workOrders.priority,
          receptionChannel: workOrders.receptionChannel,
          salePrice: workOrders.salePrice,
          deposit: workOrders.deposit,
          dueDate: workOrders.dueDate,
          createdAt: workOrders.createdAt,
          assignedTo: workOrders.assignedTo,
          assigneeName: users.name,
          customerName: customers.name,
          customerPhone: customers.phone,
        })
        .from(workOrders)
        .leftJoin(customers, eq(workOrders.customerId, customers.id))
        .leftJoin(users, eq(workOrders.assignedTo, users.id))
        .where(whereCond)
        .orderBy(desc(workOrders.id))
        .limit(input?.limit ?? 100);

      // صورة مصغّرة لكل أمر = أوّل صورة (حسب sortOrder) — استعلام واحد لكل الصفحة.
      const ids = rows.map((r) => Number(r.id));
      const thumbs = new Map<number, string>();
      if (ids.length) {
        const imgs = await db
          .select({ workOrderId: workOrderImages.workOrderId, url: workOrderImages.url })
          .from(workOrderImages)
          .where(inArray(workOrderImages.workOrderId, ids))
          .orderBy(asc(workOrderImages.workOrderId), asc(workOrderImages.sortOrder), asc(workOrderImages.id));
        for (const im of imgs) {
          const k = Number(im.workOrderId);
          if (!thumbs.has(k)) thumbs.set(k, im.url);
        }
      }
      return rows.map((r) => ({ ...r, thumbnailUrl: thumbs.get(Number(r.id)) ?? null }));
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
          priority: workOrders.priority,
          receptionChannel: workOrders.receptionChannel,
          channelHandle: workOrders.channelHandle,
          branchId: workOrders.branchId,
          customerId: workOrders.customerId,
          customerName: customers.name,
          customerPhone: customers.phone,
          baseVariantId: workOrders.baseVariantId,
          materialsCost: workOrders.materialsCost,
          laborCost: workOrders.laborCost,
          salePrice: workOrders.salePrice,
          deposit: workOrders.deposit,
          dueDate: workOrders.dueDate,
          invoiceId: workOrders.invoiceId,
          assignedTo: workOrders.assignedTo,
          assigneeName: users.name,
          deliveredAt: workOrders.deliveredAt,
          createdAt: workOrders.createdAt,
          updatedAt: workOrders.updatedAt,
        })
        .from(workOrders)
        .leftJoin(customers, eq(workOrders.customerId, customers.id))
        .leftJoin(users, eq(workOrders.assignedTo, users.id))
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
    // صور نموذج العمل (مرفقات) — للوحة التفاصيل.
    const images = await db
      .select({ id: workOrderImages.id, url: workOrderImages.url, caption: workOrderImages.caption })
      .from(workOrderImages)
      .where(eq(workOrderImages.workOrderId, input.workOrderId))
      .orderBy(asc(workOrderImages.sortOrder), asc(workOrderImages.id));
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
        images,
        qrPayload,
      };
    }
    return { ...wo, materials, images, qrPayload };
  }),

  /**
   * الموظفون المتاحون للإسناد (أسماء+أدوار فقط) — لاختيار المنفّذ عند إنشاء الأمر وللوحة التفاصيل.
   * cashierProcedure: الكاشير ينشئ أوامر الشغل ويحتاج اختيار المنفّذ؛ القائمة أسماء فقط (لا بيانات حسّاسة).
   * إعادة الإسناد نفسها (mutation `assign`) تبقى managerProcedure — قرار إشرافي.
   */
  assignableStaff: cashierProcedure.query(async () => {
    const db = getDb();
    if (!db) return [];
    return db
      .select({ id: users.id, name: users.name, role: users.role })
      .from(users)
      .where(eq(users.isActive, true))
      .orderBy(asc(users.name));
  }),

  /** إسناد/إعادة إسناد المنفّذ المسؤول عن أمر الشغل (null = إلغاء الإسناد). مدير فأعلى + تدقيق. */
  assign: managerProcedure
    .input(z.object({ workOrderId: z.number().int().positive(), assignedTo: z.number().int().positive().nullable() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
      const wo = (
        await db.select({ id: workOrders.id }).from(workOrders).where(eq(workOrders.id, input.workOrderId)).limit(1)
      )[0];
      if (!wo) throw new TRPCError({ code: "NOT_FOUND", message: "أمر الشغل غير موجود" });
      if (input.assignedTo != null) {
        const u = (
          await db.select({ id: users.id, isActive: users.isActive }).from(users).where(eq(users.id, input.assignedTo)).limit(1)
        )[0];
        if (!u || !u.isActive) throw new TRPCError({ code: "BAD_REQUEST", message: "الموظف غير موجود أو معطّل" });
      }
      await db.update(workOrders).set({ assignedTo: input.assignedTo }).where(eq(workOrders.id, input.workOrderId));
      await logAudit(ctx, {
        action: "workOrder.assign",
        entityType: "workOrder",
        entityId: input.workOrderId,
        newValue: { assignedTo: input.assignedTo },
      });
      return { ok: true };
    }),

  /**
   * الخط الزمني للأمر — أحداث حقيقية من سجلّ التدقيق (استلام/بدء/جاهز/تسليم/إلغاء/إسناد).
   * شفافية: من فعل ماذا ومتى. branch-scoped (IDOR) كـget.
   */
  timeline: branchScopedProcedure.input(z.object({ workOrderId: z.number().int().positive() })).query(async ({ input, ctx }) => {
    const db = getDb();
    if (!db) return [];
    const wo = (
      await db.select({ branchId: workOrders.branchId }).from(workOrders).where(eq(workOrders.id, input.workOrderId)).limit(1)
    )[0];
    if (!wo) return [];
    if (ctx.scopedBranchId != null && Number(wo.branchId) !== ctx.scopedBranchId) return [];
    const rows = await db
      .select({
        id: auditLogs.id,
        action: auditLogs.action,
        createdAt: auditLogs.createdAt,
        userName: users.name,
        newValue: auditLogs.newValue,
      })
      .from(auditLogs)
      .leftJoin(users, eq(auditLogs.userId, users.id))
      .where(and(eq(auditLogs.entityType, "workOrder"), eq(auditLogs.entityId, String(input.workOrderId))))
      .orderBy(asc(auditLogs.id));
    return rows;
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
        // المنفّذ المسؤول عند الإنشاء (workOrders.assignedTo).
        assignedTo: z.number().int().positive().nullish(),
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
        // ملاحظة سلامة (٢١/٦/٢٦): أُزيل `items` (أصناف البيع المصغّرة) — كانت تُخزَّن بلا خصم
        // مخزون ولا COGS. الأصناف الجاهزة تُباع الآن بفاتورة مستقلّة عبر saleRouter (القرار أ).
        // v3-add-screens(100%): صور نموذج العمل.
        designImages: z.array(z.object({
          url: z.string().min(1),
          caption: z.string().max(255).nullish(),
          sortOrder: z.number().int().min(0).nullish(),
        })).max(10).default([]),
        // idempotency: نقرة مزدوجة عند الإنشاء (عربون نقدي) ⇒ أمر شغل واحد.
        clientRequestId: z.string().min(1).max(80).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      for (const img of input.designImages ?? []) assertValidImageDataUrl(img.url);
      if (input.paymentReceiptUrl) assertValidImageDataUrl(input.paymentReceiptUrl);
      // أعد المحاولة على سباق idempotency (طلبان متزامنان بنفس المفتاح ⇒ الثاني يُعيد الأول).
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await createWorkOrder(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? input.branchId });
          if (!(res as { idempotent?: boolean }).idempotent) {
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
                imagesCount: input.designImages?.length ?? 0,
              },
            });
          }
          return res;
        } catch (e: any) {
          if (e?.code === "ER_DUP_ENTRY" && attempt < 2) continue;
          if (e instanceof TRPCError) throw e;
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر إنشاء أمر الشغل" });
        }
      }
      throw new TRPCError({ code: "CONFLICT", message: "تعذّر إنشاء أمر الشغل" });
    }),

  /**
   * السحب الذاتي للفني (محطة التنفيذ): يُسنِد الأمر الوارد لنفسه ليظهر في «أوامري».
   * workOrderExecProcedure = كاشير/مدير/فني مطبعة + فرع مُسنَد. الخدمة تمنع سحب أمر زميل.
   */
  claim: workOrderExecProcedure
    .input(z.object({ workOrderId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const res = await claimWorkOrder(input.workOrderId, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1, role: ctx.user.role });
      await logAudit(ctx, {
        action: "workOrder.claim",
        entityType: "workOrder",
        entityId: input.workOrderId,
        newValue: { assignedTo: ctx.user.id },
      });
      return res;
    }),

  // التنفيذ (بدء/تجهيز) متاح لفني المطبعة على أوامره المسحوبة + الكاشير/المدير. التسليم/الفوترة
  // يبقيان cashierProcedure (مالٌ ونقد) — لا يُسلّم الفني ولا يُصدر فاتورة.
  start: workOrderExecProcedure
    .input(z.object({ workOrderId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const res = await startWorkOrder(input.workOrderId, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1, role: ctx.user.role });
      await logAudit(ctx, { action: "workOrder.start", entityType: "workOrder", entityId: input.workOrderId });
      return res;
    }),

  markReady: workOrderExecProcedure
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
        payment: z.object({ amount: positiveMoneyString, method }).optional(),
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
