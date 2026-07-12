/**
 * storeAdminRouter — الجهة الإدارية للمتجر الإلكتروني (متجر `/store` العلني منفصل).
 * الحالي: orders (تثبيت الطلبات + طباعة الملصق). لاحقاً: banners + settings (لوحة hPanel).
 *
 * الأدوار: قراءة الطلبات = storeReadProcedure (مقيّد فرعاً)؛ تغيير الحالة = storeFulfillProcedure
 * (مدير/كاشير/مندوب مبيعات). عزل الفرع في setStatus مشتقٌّ من دور الفاعل (مرتفع ⇒ بلا قيد).
 */
import { z } from "zod";
import { logAudit } from "../services/auditService";
import { router, storeFulfillProcedure, storeManagerProcedure, storeReadProcedure } from "../trpc";
import {
  getOnlineOrder,
  listOnlineOrders,
  onlineOrderStatusCounts,
  setOnlineOrderStatus,
} from "../services/storeAdmin/orderFulfillmentService";
import { dispatchOnlineOrder } from "../services/storeAdmin/dispatchOnlineOrder";
import { listDeliveryParties } from "../services/deliveryService";
import { isDupEntry } from "@shared/errorMap.ar";
import {
  createBanner,
  deleteBanner,
  listBanners,
  updateBanner,
} from "../services/storeAdmin/bannerService";
import { getStoreSettings, updateStoreSettings } from "../services/storeAdmin/storeSettingsService";
import {
  createCategory,
  deleteCategory,
  listCategoriesAdmin,
  listProductsForAssign,
  reassignProducts,
  reorderCategories,
  setCategoryStoreVisibility,
  updateCategory,
} from "../services/categoryService";
import {
  listStoreCatalog,
  setProductFeatured,
  setProductPrimaryImage,
  setProductStoreVisible,
  setStoreProductStock,
} from "../services/storeAdmin/storeCatalogService";
import {
  createStorePromotion,
  deactivateStorePromotion,
  listStorePromotions,
} from "../services/storeAdmin/storePromotionService";
import { getStoreAnalytics } from "../services/storeAdmin/storeAnalyticsService";
import { resolveStorefrontBranchId } from "../services/storefrontService";
import { withTx } from "../services/tx";

const statusEnum = z.enum(["PENDING", "CONFIRMED", "PROCESSING", "SHIPPED", "DELIVERED", "CANCELLED"]);

/** الفرع المُسنَد للفاعل (مرتفع admin/manager ⇒ null بلا قيد؛ غيره ⇒ فرعه). */
function actorScopedBranch(user: { role: string; branchId: number | null }): number | null {
  const elevated = user.role === "admin" || user.role === "manager";
  return elevated ? null : (user.branchId != null ? Number(user.branchId) : null);
}

const ordersRouter = router({
  /** قائمة طلبات المتجر (اختياري: فلترة حالة). */
  list: storeReadProcedure
    .input(z.object({ status: statusEnum.nullish(), limit: z.number().int().min(1).max(300).default(100) }))
    .query(({ input, ctx }) =>
      listOnlineOrders({ scopedBranchId: ctx.scopedBranchId, status: input.status ?? null, limit: input.limit })
    ),

  /** عدّاد لكل حالة (بطاقات الإحصاء). */
  counts: storeReadProcedure.query(({ ctx }) => onlineOrderStatusCounts(ctx.scopedBranchId)),

  /** تفاصيل طلب (للملصق/العرض). */
  detail: storeReadProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(({ input, ctx }) => getOnlineOrder(input.id, ctx.scopedBranchId)),

  /** تثبيت/نقل حالة الطلب (بحارس انتقال + تدقيق). */
  setStatus: storeFulfillProcedure
    .input(z.object({ id: z.number().int().positive(), status: statusEnum }))
    .mutation(async ({ input, ctx }) => {
      const scopedBranchId = actorScopedBranch(ctx.user);
      const res = await setOnlineOrderStatus({ id: input.id, status: input.status, scopedBranchId }, ctx.user.id);
      await logAudit(ctx, {
        action: "store.order.setStatus",
        entityType: "onlineOrder",
        entityId: input.id,
        oldValue: { status: res.from },
        newValue: { status: res.to },
      });
      return res;
    }),

  /** جهات التوصيل النشطة (لمنتقي الإسناد عند الإرسال). */
  parties: storeReadProcedure.query(({ ctx }) => listDeliveryParties({ branchId: ctx.scopedBranchId, activeOnly: true })),

  /** إرسال طلب مؤكَّد ⇒ فاتورة (خصم مخزون + قيد) + إسناد لجهة توصيل. مدير فقط: يُقرّ ائتمان COD
   *  المؤقّت للعميل النقدي (managerOverrideByUserId يجب أن يكون مديراً مُتحقَّقاً — الكاشير محجوب). */
  dispatch: storeManagerProcedure
    .input(z.object({ id: z.number().int().positive(), partyId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const actor = { userId: ctx.user.id, branchId: Number(ctx.user.branchId ?? 0), role: ctx.user.role };
      const args = { onlineOrderId: input.id, partyId: input.partyId };
      let res;
      try {
        res = await dispatchOnlineOrder(args, actor);
      } catch (e) {
        // سباق ترقيم الفاتورة (قيد فريد) ⇒ إعادة محاولة واحدة (createSale idempotent).
        if (isDupEntry(e)) res = await dispatchOnlineOrder(args, actor);
        else throw e;
      }
      await logAudit(ctx, {
        action: "store.order.dispatch",
        entityType: "onlineOrder",
        entityId: input.id,
        newValue: { invoiceId: res.invoiceId, partyId: input.partyId, total: res.total },
      });
      return res;
    }),
});

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صحيح");
const bannerInput = z.object({
  title: z.string().trim().min(1).max(255),
  subtitle: z.string().max(500).nullish(),
  imageUrl: z.string().max(3_000_000).nullish(), // data-URL مضغوط
  ctaLabel: z.string().max(120).nullish(),
  ctaUrl: z.string().max(500).nullish(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  isActive: z.boolean().optional(),
  effectiveFrom: dateStr.nullish(),
  effectiveTo: dateStr.nullish(),
  branchId: z.number().int().positive().nullish(),
});

/** بنرات المتجر (إدارة — storeManagerProcedure). */
const bannersRouter = router({
  list: storeReadProcedure.query(() => listBanners()),
  create: storeManagerProcedure.input(bannerInput).mutation(async ({ input, ctx }) => {
    const r = await createBanner(input, ctx.user.id);
    await logAudit(ctx, { action: "store.banner.create", entityType: "storeBanner", entityId: r.id, newValue: { title: input.title } });
    return r;
  }),
  update: storeManagerProcedure
    .input(z.object({ id: z.number().int().positive() }).and(bannerInput.partial()))
    .mutation(async ({ input, ctx }) => {
      const { id, ...rest } = input;
      const r = await updateBanner(id, rest);
      await logAudit(ctx, { action: "store.banner.update", entityType: "storeBanner", entityId: id, newValue: rest });
      return r;
    }),
  remove: storeManagerProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ input, ctx }) => {
    const r = await deleteBanner(input.id);
    await logAudit(ctx, { action: "store.banner.delete", entityType: "storeBanner", entityId: input.id });
    return r;
  }),
});

/** إعدادات المتجر (قراءة عامة للمصرَّح، تعديل مديري). */
const settingsRouter = router({
  get: storeReadProcedure.query(() => getStoreSettings()),
  update: storeManagerProcedure
    .input(
      z.object({
        isOpen: z.boolean().optional(),
        announcement: z.string().max(500).nullish(),
        whatsappNumber: z.string().max(20).nullish(),
        freeShippingThreshold: z.string().regex(/^\d+(\.\d{1,2})?$/, "قيمة غير صحيحة").nullish(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const r = await updateStoreSettings(input, ctx.user.id);
      await logAudit(ctx, { action: "store.settings.update", entityType: "storeSettings", entityId: 1, newValue: r });
      return r;
    }),
});

/** فئات المتجر (إدارة — إنشاء/تعديل/حذف/ترتيب/إظهار + إسناد منتجات). يلفّ categoryService المُختبَر. */
const categoriesRouter = router({
  list: storeReadProcedure.query(() => listCategoriesAdmin()),
  create: storeManagerProcedure
    .input(z.object({ name: z.string().min(1).max(255), description: z.string().max(1000).nullish() }))
    .mutation(async ({ input, ctx }) => {
      const actor = { userId: ctx.user.id, branchId: ctx.user.branchId ?? 0, role: ctx.user.role };
      const r = await createCategory(input, actor);
      await logAudit(ctx, { action: "store.category.create", entityType: "storeCategory", entityId: r.id, newValue: { name: input.name } });
      return r;
    }),
  update: storeManagerProcedure
    .input(z.object({ id: z.number().int().positive(), name: z.string().min(1).max(255).optional(), description: z.string().max(1000).nullish(), isActive: z.boolean().optional() }))
    .mutation(async ({ input, ctx }) => {
      const actor = { userId: ctx.user.id, branchId: ctx.user.branchId ?? 0, role: ctx.user.role };
      const r = await updateCategory(input, actor);
      await logAudit(ctx, { action: "store.category.update", entityType: "storeCategory", entityId: input.id, newValue: input });
      return r;
    }),
  remove: storeManagerProcedure
    .input(z.object({ id: z.number().int().positive(), reassignToId: z.number().int().positive().nullish() }))
    .mutation(async ({ input, ctx }) => {
      const actor = { userId: ctx.user.id, branchId: ctx.user.branchId ?? 0, role: ctx.user.role };
      const r = await deleteCategory(input, actor);
      await logAudit(ctx, { action: "store.category.delete", entityType: "storeCategory", entityId: input.id });
      return r;
    }),
  setVisibility: storeManagerProcedure
    .input(z.object({ id: z.number().int().positive(), showInStore: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const actor = { userId: ctx.user.id, branchId: ctx.user.branchId ?? 0, role: ctx.user.role };
      const r = await setCategoryStoreVisibility(input, actor);
      await logAudit(ctx, { action: "store.category.visibility", entityType: "storeCategory", entityId: input.id, newValue: { showInStore: input.showInStore } });
      return r;
    }),
  reorder: storeManagerProcedure
    .input(z.object({ orderedIds: z.array(z.number().int().positive()).min(1).max(500) }))
    .mutation(async ({ input, ctx }) => {
      const actor = { userId: ctx.user.id, branchId: ctx.user.branchId ?? 0, role: ctx.user.role };
      const r = await reorderCategories(input, actor);
      await logAudit(ctx, { action: "store.category.reorder", entityType: "storeCategory", entityId: 0 });
      return r;
    }),
  listProducts: storeReadProcedure
    .input(z.object({ q: z.string().max(120).optional(), categoryId: z.number().int().min(0).nullish(), limit: z.number().int().positive().max(500).default(100) }))
    .query(({ input }) => listProductsForAssign(input)),
  assignProducts: storeManagerProcedure
    .input(z.object({ productIds: z.array(z.number().int().positive()).min(1).max(2000), categoryId: z.number().int().positive().nullable() }))
    .mutation(async ({ input, ctx }) => {
      const actor = { userId: ctx.user.id, branchId: ctx.user.branchId ?? 0, role: ctx.user.role };
      const r = await reassignProducts(input, actor);
      await logAudit(ctx, { action: "store.category.assignProducts", entityType: "storeCategory", entityId: input.categoryId ?? 0, newValue: { count: input.productIds.length } });
      return r;
    }),
});

/** كتالوج المتجر (عرض/تحكّم — مخزون/صورة/تمييز/إظهار). المخزون عبر قيد ADJUST الذرّي. */
const catalogRouter = router({
  list: storeReadProcedure
    .input(z.object({
      branchId: z.number().int().positive().nullish(),
      q: z.string().max(120).optional(),
      categoryId: z.number().int().min(0).nullish(),
      featuredOnly: z.boolean().optional(),
      hiddenOnly: z.boolean().optional(),
      missingImageOnly: z.boolean().optional(),
      limit: z.number().int().positive().max(200).default(50),
      offset: z.number().int().min(0).default(0),
    }))
    .query(async ({ input, ctx }) => {
      const branchId = await resolveStorefrontBranchId(input.branchId ?? ctx.scopedBranchId ?? undefined);
      return listStoreCatalog({ ...input, branchId });
    }),
  setFeatured: storeManagerProcedure
    .input(z.object({ productId: z.number().int().positive(), isFeatured: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const r = await setProductFeatured(input);
      await logAudit(ctx, { action: "store.catalog.featured", entityType: "product", entityId: input.productId, newValue: { isFeatured: input.isFeatured } });
      return r;
    }),
  setVisible: storeManagerProcedure
    .input(z.object({ productId: z.number().int().positive(), showInStore: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const r = await setProductStoreVisible(input);
      await logAudit(ctx, { action: "store.catalog.visibility", entityType: "product", entityId: input.productId, newValue: { showInStore: input.showInStore } });
      return r;
    }),
  setStock: storeManagerProcedure
    .input(z.object({ variantId: z.number().int().positive(), branchId: z.number().int().positive().nullish(), targetQuantity: z.number().int().min(0), notes: z.string().max(200).optional() }))
    .mutation(async ({ input, ctx }) => {
      const branchId = await resolveStorefrontBranchId(input.branchId ?? undefined);
      const r = await setStoreProductStock({ variantId: input.variantId, branchId, targetQuantity: input.targetQuantity, createdBy: ctx.user.id, notes: input.notes });
      await logAudit(ctx, { action: "store.catalog.stock", entityType: "stock", entityId: input.variantId, newValue: { branchId, target: input.targetQuantity, delta: r.delta } });
      return r;
    }),
  setImage: storeManagerProcedure
    .input(z.object({ productId: z.number().int().positive(), url: z.string().max(5_000_000).nullable() }))
    .mutation(async ({ input, ctx }) => {
      const r = await setProductPrimaryImage(input);
      await logAudit(ctx, { action: "store.catalog.image", entityType: "product", entityId: input.productId, newValue: { hasImage: input.url != null } });
      return r;
    }),
});

/** اليوم بحبيبة بغداد (UTC+3) بصيغة YYYY-MM-DD — نفس نافذة storefrontOffers/resolvePromotionForLine. */
function baghdadTodayYmd(): string {
  const bag = new Date(Date.now() + 3 * 60 * 60 * 1000);
  return bag.toISOString().slice(0, 10);
}

/** عروض/خصومات المتجر (لوحة hPanel). العرض المتجريّ = RETAIL على فرع المتجر ⇒ يظهر تلقائياً في المتجر. */
const promotionsRouter = router({
  list: storeReadProcedure
    .input(z.object({ includeInactive: z.boolean().default(false) }))
    .query(async ({ input }) => {
      // فرع المتجر = فرع الواجهة نفسه دائماً (كـcreate/deactivate/storefront) — لا يُشتَقّ من فرع
      // المُشاهِد (scopedBranchId) وإلا لرأى مستخدم READ على فرعٍ آخر عروضاً خاطئة/فارغة (مراجعة ١٣/٧).
      const branchId = await resolveStorefrontBranchId(undefined);
      return listStorePromotions({ branchId, includeInactive: input.includeInactive, todayYmd: baghdadTodayYmd() });
    }),
  create: storeManagerProcedure
    .input(z.object({
      name: z.string().min(1).max(255),
      description: z.string().max(2000).nullish(),
      type: z.enum(["PERCENT", "AMOUNT"]),
      discountPercent: z.string().regex(/^\d+(\.\d{1,2})?$/, "نسبة غير صالحة").optional(),
      discountAmount: z.string().regex(/^\d+(\.\d{1,2})?$/, "مبلغ غير صالح").optional(),
      scope: z.enum(["ALL", "CATEGORIES", "PRODUCTS"]),
      effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح"),
      effectiveTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح").nullish(),
      minLineAmount: z.string().regex(/^\d+(\.\d{1,2})?$/, "مبلغ غير صالح").optional(),
      priority: z.number().int().min(0).max(999).optional(),
      targets: z.array(z.object({
        categoryId: z.number().int().positive().nullish(),
        productId: z.number().int().positive().nullish(),
        variantId: z.number().int().positive().nullish(),
      })).max(500).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const branchId = await resolveStorefrontBranchId(undefined);
      const promotionId = await withTx((tx) => createStorePromotion(tx, input, ctx.user.id, branchId));
      await logAudit(ctx, {
        action: "store.promotion.create",
        entityType: "promotion",
        entityId: promotionId,
        newValue: { name: input.name, type: input.type, scope: input.scope, branchId },
      });
      return { promotionId };
    }),
  deactivate: storeManagerProcedure
    .input(z.object({ promotionId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      await withTx((tx) => deactivateStorePromotion(tx, input.promotionId));
      await logAudit(ctx, { action: "store.promotion.deactivate", entityType: "promotion", entityId: input.promotionId });
      return { ok: true };
    }),
});

/** تحليلات المتجر (لوحة hPanel) — أداء الطلبات الإلكترونية على مدى فترة (بلا تكلفة/ربح — §٦). */
const analyticsRouter = router({
  summary: storeReadProcedure
    .input(z.object({
      fromYmd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح"),
      toYmd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح"),
    })
      // النطاق محدودٌ بـ٩٢ يوماً (سقف ملء فجوات الاتّجاه في الخدمة) كي يغطّي المخطّطُ اليوميّ نفسَ
      // نافذة المؤشّرات دائماً — وإلا لاقتُطع الاتّجاه صامتاً بينما تشمل المؤشّرات كامل المدى (مراجعة ١٣/٧).
      .refine((v) => v.toYmd >= v.fromYmd, { message: "تاريخ الانتهاء أقدم من البدء" })
      .refine(
        (v) => (Date.parse(`${v.toYmd}T00:00:00Z`) - Date.parse(`${v.fromYmd}T00:00:00Z`)) / 86_400_000 <= 91,
        { message: "النطاق يتجاوز ٩٢ يوماً" },
      ))
    .query(async ({ input, ctx }) => {
      // عزل الفرع كبقيّة راوتر الطلبات: المرتفع (admin/manager) scopedBranchId=null ⇒ كل المتجر.
      return getStoreAnalytics({ scopedBranchId: ctx.scopedBranchId ?? null, fromYmd: input.fromYmd, toYmd: input.toYmd });
    }),
});

export const storeAdminRouter = router({
  orders: ordersRouter,
  banners: bannersRouter,
  settings: settingsRouter,
  categories: categoriesRouter,
  catalog: catalogRouter,
  promotions: promotionsRouter,
  analytics: analyticsRouter,
});
