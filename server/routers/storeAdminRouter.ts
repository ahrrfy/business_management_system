/**
 * storeAdminRouter — الجهة الإدارية للمتجر الإلكتروني (متجر `/store` العلني منفصل).
 * الحالي: orders (تثبيت الطلبات + طباعة الملصق). لاحقاً: banners + settings (لوحة hPanel).
 *
 * الأدوار: قراءة الطلبات = storeReadProcedure (مقيّد فرعاً)؛ تغيير الحالة = storeFulfillProcedure
 * (مدير/كاشير/مندوب مبيعات). عزل الفرع في setStatus مشتقٌّ من دور الفاعل (مرتفع ⇒ بلا قيد).
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
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
import { retryOnDeadlock } from "../lib/retryDeadlock";
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
import { getStoreCustomers } from "../services/storeAdmin/storeCustomerService";
import { resolveStorefrontBranchId } from "../services/storefrontService";
import { withTx } from "../services/tx";
import { assertValidImageDataUrl } from "../lib/imageValidation";
import { assertSafeBannerCtaUrl } from "../lib/bannerSafety";
import { listLoyaltyPrograms, loyaltyOverview, saveLoyaltyProgram } from "../services/storeAdmin/loyaltyService";
import {
  approveStorefrontPushCampaign,
  cancelStorefrontPushCampaign,
  createStorefrontPushCampaign,
  listStorefrontPushCampaigns,
  scheduleStorefrontPushCampaign,
} from "../services/storeAdmin/storefrontPushCampaignService";
import { listStorefrontProductReviewsForAdmin, moderateStorefrontProductReview } from "../services/storeAdmin/storefrontProductReviewAdminService";

const statusEnum = z.enum(["PENDING", "CONFIRMED", "PROCESSING", "SHIPPED", "DELIVERED", "CANCELLED"]);

/** الفرع المُسنَد للفاعل (قرار المالك ١٢/٨: عزل مدير الفرع): المالك/الأدمن فقط ⇒ null بلا قيد
 *  (owner مُطبَّع ⇒ admin)؛ مدير الفرع وغيره ⇒ فرعهم المُسنَد. */
function actorScopedBranch(user: { role: string; branchId: number | null }): number | null {
  const elevated = user.role === "admin";
  return elevated ? null : (user.branchId != null ? Number(user.branchId) : null);
}

function assertCatalogBranchAccess(scopedBranchId: number | null, fulfillmentBranchId: number): void {
  if (scopedBranchId != null && Number(scopedBranchId) !== Number(fulfillmentBranchId)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكنك قراءة أو تسوية مخزون فرع تنفيذ المتجر من فرعٍ آخر" });
  }
}

/** مخزون فرع التنفيذ: مدير الفرع نفسه يمر، ولا يستطيع عبور فرعه. */
const storeFulfillmentManagerProcedure = storeManagerProcedure.use(async ({ ctx, next }) => {
  const fulfillmentBranchId = await resolveStorefrontBranchId(undefined);
  assertCatalogBranchAccess(actorScopedBranch(ctx.user), fulfillmentBranchId);
  return next({ ctx: { ...ctx, fulfillmentBranchId } });
});

/**
 * سطح المتجر العام (الإعدادات والبنرات والفئات وظهور/صور المنتجات والعروض) ليس مورداً
 * فرعياً قابلاً للتفويض بل إعداد شركة واحد. نجعله للمالك/الأدمن فقط: هذا يلغي جذرياً
 * TOCTOU «مدير A اجتاز التفويض ثم غيّر المالك fulfillment إلى B قبل كتابة الخدمة»؛
 * لا تعتمد السلطة هنا على لقطة DB قابلة للتغيّر إطلاقاً.
 */
const storeGlobalAdminProcedure = storeManagerProcedure.use(async ({ ctx, next }) => {
  if (actorScopedBranch(ctx.user) != null) {
    throw new TRPCError({ code: "FORBIDDEN", message: "إدارة إعدادات ومحتوى المتجر العام للمالك أو الأدمن فقط" });
  }
  return next({ ctx });
});

const ordersRouter = router({
  /** قائمة طلبات المتجر (اختياري: فلترة حالة/مدى تاريخ + مؤشّر لصفحات إضافية — اليوم كان اقتطاعاً
   *  صامتاً عند limit؛ الشاشة تكشف ذلك بلافتة حقيقية وزرّ «تحميل المزيد» بدل صمت الاقتطاع). */
  list: storeReadProcedure
    .input(z.object({
      status: statusEnum.nullish(),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صحيح").optional(),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صحيح").optional(),
      cursor: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(300).default(100),
    }))
    .query(({ input, ctx }) =>
      listOnlineOrders({ scopedBranchId: ctx.scopedBranchId, status: input.status ?? null, from: input.from, to: input.to, cursor: input.cursor, limit: input.limit })
    ),

  /** عدّاد لكل حالة (بطاقات الإحصاء). */
  counts: storeReadProcedure.query(({ ctx }) => onlineOrderStatusCounts(ctx.scopedBranchId)),

  /** تفاصيل طلب (للملصق/العرض). */
  detail: storeReadProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(({ input, ctx }) => getOnlineOrder(input.id, ctx.scopedBranchId)),

  /** تثبيت/نقل حالة الطلب (بحارس انتقال + تدقيق). */
  setStatus: storeFulfillProcedure
    .input(z.object({ id: z.number().int().positive(), status: statusEnum, cancelReason: z.string().trim().max(500).optional() }))
    .mutation(async ({ input, ctx }) => {
      const scopedBranchId = actorScopedBranch(ctx.user);
      const res = await setOnlineOrderStatus({ id: input.id, status: input.status, scopedBranchId, cancelReason: input.cancelReason }, ctx.user.id);
      await logAudit(ctx, {
        action: "store.order.setStatus",
        entityType: "onlineOrder",
        entityId: input.id,
        oldValue: { status: res.from },
        newValue: { status: res.to, ...(input.status === "CANCELLED" && input.cancelReason ? { cancelReason: input.cancelReason } : {}) },
      });
      return res;
    }),

  /** جهات التوصيل النشطة (لمنتقي الإسناد عند الإرسال). */
  parties: storeReadProcedure.query(({ ctx }) => listDeliveryParties({ branchId: ctx.scopedBranchId, activeOnly: true })),

  /** إرسال طلب مؤكَّد ⇒ فاتورة (خصم مخزون + قيد) + إسناد لجهة توصيل، مع إبقاء حدّ
   *  ائتمان العميل نافذاً ومنع الموافقة الذاتية من مُنفّذ الإرسال. */
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
const bannerImage = z.object({
  url: z.string().max(3_000_000),
  effectiveFrom: dateStr.nullish(),
  effectiveTo: dateStr.nullish(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
}).refine((v) => !v.effectiveFrom || !v.effectiveTo || v.effectiveFrom <= v.effectiveTo, { path: ["effectiveTo"] });
const bannerInputFields = z.object({
  title: z.string().trim().min(1).max(255),
  subtitle: z.string().max(500).nullish(),
  imageUrl: z.string().max(3_000_000).nullish(), // data-URL مضغوط
  images: z.array(bannerImage).max(20).optional(),
  ctaLabel: z.string().max(120).nullish(),
  ctaUrl: z.string().max(500).nullish(),
  mobileImageUrl: z.string().max(3_000_000).nullish(),
  renderMode: z.enum(["SMART_CROP", "PRESERVE_FULL", "LAYERED"]).optional(),
  focusX: z.number().int().min(0).max(100).optional(),
  focusY: z.number().int().min(0).max(100).optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  isActive: z.boolean().optional(),
  effectiveFrom: dateStr.nullish(),
  effectiveTo: dateStr.nullish(),
  branchId: z.number().int().positive().nullish(),
  // موضع العرض (0074): رئيسي/جانبي طولي/فاصل بين المنتجات.
  placement: z.enum(["HERO", "SIDE", "INLINE"]).optional(),
});

const bannerInput = bannerInputFields.refine((v) => !v.effectiveFrom || !v.effectiveTo || v.effectiveFrom <= v.effectiveTo, {
  message: "تاريخ انتهاء البنر أقدم من تاريخ بدايته",
  path: ["effectiveTo"],
});

function assertSafeBannerInput(input: Partial<z.infer<typeof bannerInput>>) {
  assertValidImageDataUrl(input.imageUrl, 2_000_000, true);
  assertValidImageDataUrl(input.mobileImageUrl, 2_000_000, true);
  for (const image of input.images ?? []) assertValidImageDataUrl(image.url, 2_000_000, true);
  assertSafeBannerCtaUrl(input.ctaUrl);
}

/** بنرات المتجر (إدارة — storeManagerProcedure). */
const bannersRouter = router({
  list: storeReadProcedure.query(() => listBanners()),
  create: storeGlobalAdminProcedure.input(bannerInput).mutation(async ({ input, ctx }) => {
    assertSafeBannerInput(input);
    const r = await createBanner(input, ctx.user.id);
    await logAudit(ctx, { action: "store.banner.create", entityType: "storeBanner", entityId: r.id, newValue: { title: input.title } });
    return r;
  }),
  update: storeGlobalAdminProcedure
    .input(z.object({ id: z.number().int().positive() }).and(bannerInputFields.partial()))
    .mutation(async ({ input, ctx }) => {
      const { id, ...rest } = input;
      assertSafeBannerInput(rest);
      const r = await updateBanner(id, rest);
      // ⚠️ `rest` يحمل حقولاً data-URL ضخمة (imageUrl/mobileImageUrl سقف ٣ م.ب لكلٍّ + images
      // حتى ٢٠ × ٢ م.ب). كان تمريره خاماً هنا يكتب ميغابايتات base64 في صفّ تدقيقٍ واحد،
      // فيقتل شاشة سجلّ التدقيق **كلّها** بـ`Out of sort memory` (عطلٌ إنتاجيّ ١٤–١٦/٧).
      // آمنٌ الآن: `logAudit` يُعقّم مركزياً (`redactAuditValue`) فتصير الصور علاماتٍ تصف حجمها.
      // نمرّره كاملاً عمداً — التعقيم يُبقي **أيّ الحقول تغيّرت** وهو جوهر التدقيق، بينما ملخّصٌ
      // يدويّ (نمط `create` أعلاه) يُخفي ذلك ويُكرّر منطق الحجب في موضعٍ ثانٍ يَنحرف لاحقاً.
      await logAudit(ctx, { action: "store.banner.update", entityType: "storeBanner", entityId: id, newValue: rest });
      return r;
    }),
  remove: storeGlobalAdminProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ input, ctx }) => {
    const r = await deleteBanner(input.id);
    await logAudit(ctx, { action: "store.banner.delete", entityType: "storeBanner", entityId: input.id });
    return r;
  }),
});

/** إعدادات المتجر (قراءة عامة للمصرَّح، تعديل مديري). */
const settingsRouter = router({
  get: storeReadProcedure.query(() => getStoreSettings()),
  update: storeGlobalAdminProcedure
    .input(
      z.object({
        isOpen: z.boolean().optional(),
        fulfillmentBranchId: z.number().int().positive().nullable().optional(),
        announcement: z.string().max(500).nullish(),
        whatsappNumber: z.string().max(20).nullish(),
        freeShippingThreshold: z.string().regex(/^\d+(\.\d{1,2})?$/, "قيمة غير صحيحة").nullish(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // إعداد واحد يحكم المتجر العام كله. مدير فرع لا يفتح/يغلق أو يعيد توجيه
      // متجر فرع آخر؛ نفحص الفرع الحالي والمستهدف كي لا يلتفّ بنقل التنفيذ إلى فرعه.
      //
      // إعادة محاولة على تنافس القفل (فحص الحمل ٣١/٨/٢٦): الحفظ يأخذ `FOR UPDATE` على صفّ
      // الإعدادات الوحيد الذي تقرأه كلّ طلبات المتجر بقفلٍ مشترك؛ تحت حملٍ كثيف قد تتأخّر
      // ترقيته حتى تنتهي مهلة القفل، فيرى المالك فشلاً عابراً في «حفظ إعدادات المتجر».
      // العملية ذرّية بالكامل (withTx واحد) فإعادتها آمنة حتماً.
      const r = await retryOnDeadlock(() => updateStoreSettings(input, ctx.user.id));
      await logAudit(ctx, { action: "store.settings.update", entityType: "storeSettings", entityId: 1, newValue: r });
      return r;
    }),
});

/** فئات المتجر (إدارة — إنشاء/تعديل/حذف/ترتيب/إظهار + إسناد منتجات). يلفّ categoryService المُختبَر. */
const categoriesRouter = router({
  list: storeReadProcedure.query(() => listCategoriesAdmin()),
  create: storeGlobalAdminProcedure
    .input(z.object({ name: z.string().min(1).max(255), description: z.string().max(1000).nullish() }))
    .mutation(async ({ input, ctx }) => {
      const actor = { userId: ctx.user.id, branchId: ctx.user.branchId ?? 0, role: ctx.user.role };
      const r = await createCategory(input, actor);
      await logAudit(ctx, { action: "store.category.create", entityType: "storeCategory", entityId: r.id, newValue: { name: input.name } });
      return r;
    }),
  update: storeGlobalAdminProcedure
    .input(z.object({ id: z.number().int().positive(), name: z.string().min(1).max(255).optional(), description: z.string().max(1000).nullish(), isActive: z.boolean().optional() }))
    .mutation(async ({ input, ctx }) => {
      const actor = { userId: ctx.user.id, branchId: ctx.user.branchId ?? 0, role: ctx.user.role };
      const r = await updateCategory(input, actor);
      await logAudit(ctx, { action: "store.category.update", entityType: "storeCategory", entityId: input.id, newValue: input });
      return r;
    }),
  remove: storeGlobalAdminProcedure
    .input(z.object({ id: z.number().int().positive(), reassignToId: z.number().int().positive().nullish() }))
    .mutation(async ({ input, ctx }) => {
      const actor = { userId: ctx.user.id, branchId: ctx.user.branchId ?? 0, role: ctx.user.role };
      const r = await deleteCategory(input, actor);
      await logAudit(ctx, { action: "store.category.delete", entityType: "storeCategory", entityId: input.id });
      return r;
    }),
  setVisibility: storeGlobalAdminProcedure
    .input(z.object({ id: z.number().int().positive(), showInStore: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const actor = { userId: ctx.user.id, branchId: ctx.user.branchId ?? 0, role: ctx.user.role };
      const r = await setCategoryStoreVisibility(input, actor);
      await logAudit(ctx, { action: "store.category.visibility", entityType: "storeCategory", entityId: input.id, newValue: { showInStore: input.showInStore } });
      return r;
    }),
  reorder: storeGlobalAdminProcedure
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
  assignProducts: storeGlobalAdminProcedure
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
      // لوحة المتجر والواجهة العامة تقرآن المرجع التشغيلي نفسه حتماً؛ فرع حساب المدير
      // أو branchId قديم في عميل مخزّن لا يغيّران حقيقة الكتالوج العام.
      const branchId = await resolveStorefrontBranchId(undefined);
      assertCatalogBranchAccess(actorScopedBranch(ctx.user), branchId);
      return listStoreCatalog({ ...input, branchId });
    }),
  setFeatured: storeGlobalAdminProcedure
    .input(z.object({ productId: z.number().int().positive(), isFeatured: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const r = await setProductFeatured(input);
      await logAudit(ctx, { action: "store.catalog.featured", entityType: "product", entityId: input.productId, newValue: { isFeatured: input.isFeatured } });
      return r;
    }),
  setVisible: storeGlobalAdminProcedure
    .input(z.object({ productId: z.number().int().positive(), showInStore: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const r = await setProductStoreVisible(input);
      await logAudit(ctx, { action: "store.catalog.visibility", entityType: "product", entityId: input.productId, newValue: { showInStore: input.showInStore } });
      return r;
    }),
  setStock: storeFulfillmentManagerProcedure
    .input(z.object({ variantId: z.number().int().positive(), branchId: z.number().int().positive().nullish(), targetQuantity: z.number().int().min(0), notes: z.string().max(200).optional() }))
    .mutation(async ({ input, ctx }) => {
      const branchId = ctx.fulfillmentBranchId;
      // فصل مهام #٦: يُنشئ طلب تسوية معلَّقاً يعتمده مديرٌ آخر (بدل ضبطٍ فوريّ بفاعلٍ واحد).
      const r = await setStoreProductStock(
        { variantId: input.variantId, branchId, targetQuantity: input.targetQuantity, notes: input.notes },
        { userId: ctx.user.id, branchId: Number(ctx.user.branchId ?? 0), role: ctx.user.role },
      );
      await logAudit(ctx, { action: "store.catalog.stockRequest", entityType: "stockAdjustmentRequest", entityId: r.requestId, newValue: { branchId, target: input.targetQuantity } });
      return { requestId: r.requestId, status: "PENDING_APPROVAL" as const };
    }),
  setImage: storeGlobalAdminProcedure
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
    .query(async ({ input, ctx }) => {
      // فرع المتجر = فرع الواجهة نفسه دائماً (كـcreate/deactivate/storefront) — لا يُشتَقّ من فرع
      // المُشاهِد (scopedBranchId) وإلا لرأى مستخدم READ على فرعٍ آخر عروضاً خاطئة/فارغة (مراجعة ١٣/٧).
      const branchId = await resolveStorefrontBranchId(undefined);
      assertCatalogBranchAccess(actorScopedBranch(ctx.user), branchId);
      return listStorePromotions({ branchId, includeInactive: input.includeInactive, todayYmd: baghdadTodayYmd() });
    }),
  create: storeGlobalAdminProcedure
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
  deactivate: storeGlobalAdminProcedure
    .input(z.object({ promotionId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const branchId = await resolveStorefrontBranchId(undefined);
      await withTx((tx) => deactivateStorePromotion(tx, input.promotionId, branchId));
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

/** عملاء المتجر (لوحة hPanel) — من لهم طلبٌ أونلاين + مؤشّراتهم. بلا تكلفة/ربح (§٦)، عزل فرع. */
const customersRouter = router({
  list: storeReadProcedure
    .input(z.object({
      q: z.string().max(120).optional(),
      sort: z.enum(["spend", "recent", "orders"]).default("spend"),
      limit: z.number().int().positive().max(200).default(30),
      offset: z.number().int().min(0).default(0),
    }))
    .query(async ({ input, ctx }) => {
      return getStoreCustomers({ scopedBranchId: ctx.scopedBranchId ?? null, ...input });
    }),
});

const loyaltyRouter = router({
  programs: storeGlobalAdminProcedure.query(() => listLoyaltyPrograms()),
  overview: storeGlobalAdminProcedure.query(() => loyaltyOverview()),
  saveProgram: storeGlobalAdminProcedure.input(z.object({
    id: z.number().int().positive().optional(),
    name: z.string().trim().min(2).max(120),
    status: z.enum(["DRAFT", "ACTIVE", "PAUSED"]),
    pointsPerIqd: z.string().regex(/^\d{1,10}(?:\.\d{1,6})?$/),
    iqdDiscountPerPoint: z.string().regex(/^\d{1,10}(?:\.\d{1,2})?$/),
    minRedeemPoints: z.number().int().min(0).max(10_000_000),
    maxRedeemPercent: z.number().int().min(0).max(100),
    expiresAfterDays: z.number().int().min(1).max(3650).nullable(),
  })).mutation(async ({ input, ctx }) => saveLoyaltyProgram(input, ctx.user.id)),
});

/** حملات إشعارات العملاء: فصل مسودة/اعتماد/جدولة يمنع إطلاق الإعلان من شاشة التحرير مباشرة. */
const notificationsRouter = router({
  list: storeGlobalAdminProcedure.query(() => listStorefrontPushCampaigns()),
  create: storeGlobalAdminProcedure.input(z.object({
    name: z.string().trim().min(2).max(160),
    kind: z.enum(["MARKETING", "TRANSACTIONAL"]),
    title: z.string().trim().min(2).max(80),
    body: z.string().trim().min(2).max(180),
    destination: z.string().trim().min(1).max(180),
    throttlePerMinute: z.number().int().min(10).max(240).default(120),
  })).mutation(async ({ input, ctx }) => {
    const result = await createStorefrontPushCampaign(input, ctx.user.id);
    await logAudit(ctx, { action: "store.notification_campaign.create", entityType: "storefrontPushCampaign", entityId: result.campaignId, newValue: { name: input.name, kind: input.kind, destination: input.destination } });
    return result;
  }),
  approve: storeGlobalAdminProcedure.input(z.object({ campaignId: z.number().int().positive() })).mutation(async ({ input, ctx }) => {
    const result = await approveStorefrontPushCampaign(input.campaignId, ctx.user.id);
    await logAudit(ctx, { action: "store.notification_campaign.approve", entityType: "storefrontPushCampaign", entityId: input.campaignId });
    return result;
  }),
  schedule: storeGlobalAdminProcedure.input(z.object({ campaignId: z.number().int().positive(), scheduledAt: z.string().trim().min(10).max(40) })).mutation(async ({ input, ctx }) => {
    const scheduledAt = new Date(input.scheduledAt);
    if (Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() < Date.now() - 60_000) throw new TRPCError({ code: "BAD_REQUEST", message: "موعد الحملة يجب أن يكون حالياً أو في المستقبل." });
    const result = await scheduleStorefrontPushCampaign(input.campaignId, scheduledAt);
    await logAudit(ctx, { action: "store.notification_campaign.schedule", entityType: "storefrontPushCampaign", entityId: input.campaignId, newValue: { scheduledAt: scheduledAt.toISOString() } });
    return result;
  }),
  cancel: storeGlobalAdminProcedure.input(z.object({ campaignId: z.number().int().positive() })).mutation(async ({ input, ctx }) => {
    const result = await cancelStorefrontPushCampaign(input.campaignId);
    await logAudit(ctx, { action: "store.notification_campaign.cancel", entityType: "storefrontPushCampaign", entityId: input.campaignId });
    return result;
  }),
});

/** اعتماد المراجعات يسبق ظهورها علناً؛ لا يسمح بتعديل أو نشر تلقائي من العميل. */
const reviewsRouter = router({
  list: storeManagerProcedure.input(z.object({ status: z.enum(["PENDING", "APPROVED", "REJECTED"]).default("PENDING") })).query(({ input }) => listStorefrontProductReviewsForAdmin(input.status)),
  moderate: storeManagerProcedure.input(z.object({ reviewId: z.number().int().positive(), status: z.enum(["APPROVED", "REJECTED"]) })).mutation(async ({ input, ctx }) => {
    const result = await moderateStorefrontProductReview(input);
    await logAudit(ctx, { action: "store.product_review.moderate", entityType: "storefrontProductReview", entityId: input.reviewId, newValue: { status: input.status } });
    return result;
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
  customers: customersRouter,
  loyalty: loyaltyRouter,
  notifications: notificationsRouter,
  reviews: reviewsRouter,
});
