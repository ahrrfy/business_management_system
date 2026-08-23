/**
 * storefrontRouter — واجهة المتجر العلنية للزبون (B2C) على الجوال.
 *
 * كل النقاط `publicProcedure` (بلا مصادقة — الزبون مجهول على الإنترنت) لكنها:
 *  ① **آمنة**: تُعيد حقولاً تسويقية فقط (storefrontService لا يكشف تكلفة/مخزون/جملة).
 *  ② **محدودة المعدّل** على مستوى المسار في server/index.ts (المسار يحوي `storefront.`)
 *     ⇒ حماية من الكشط/الإغراق. هذا نقيض نقطة Antigravity العارية (publicProcedure = t.procedure
 *     بلا حدّ) التي حُذفت.
 *  ③ **قراءة فقط**: لا كتابة هنا (الطلب/الدفع عند الاستلام في شريحة لاحقة عبر نموذج طلب مُجهّز
 *     بهوية الزبون — لا انتحال مدير).
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  middleware,
  publicProcedure,
  router,
  storefrontPublicReadProcedure,
  storefrontPublicWriteProcedure,
} from "../trpc";
import { storefrontCatalog, storefrontCategories, storefrontOffers, storefrontProduct, storefrontRelated, storefrontCartRecommendations } from "../services/storefrontService";
import { createOnlineOrder, findOwnedOnlineOrderReplay, quoteOnlineOrder, readOnlineOrderLabel, trackOnlineOrder } from "../services/onlineOrderService";
import { listActiveBanners } from "../services/storeAdmin/bannerService";
import { getPublicStoreSettings } from "../services/storeAdmin/storeSettingsService";
import { recordBannerMetric } from "../services/storeAdmin/bannerMetricsService";
import { recordStoreConversionMetric, recordStoreRecommendationClick } from "../services/storeAdmin/storeConversionMetricsService";
import { verifyStorefrontTurnstile } from "../services/storefrontTurnstile";
import { createVerifiedStorefrontOrder } from "../services/storefrontOrderGate";
import { STOREFRONT_TURNSTILE_TOKEN_MAX_LENGTH } from "@shared/storefrontTurnstile";
import { registerStorefrontPushDevice, trackStorefrontPushInteraction } from "../services/storeAdmin/storefrontPushCampaignService";
import { claimFirebaseStorefrontCustomer, storefrontCustomerBenefits, verifyStorefrontCustomerSession } from "../services/storefrontCustomerIdentityService";
import { listStorefrontProductReviews, submitStorefrontProductReview } from "../services/storefrontProductReviewService";
import { createStorefrontWishlistShare, resolveStorefrontWishlistShare } from "../services/storefrontWishlistShareService";

const labelSummaryInput = z.object({
  orderNumber: z.string().trim().min(1).max(50),
  token: z.string().trim().min(12).max(32),
});

/**
 * بوابة QR العامة: لا تعتمد على جلسة مستخدم، بل على توقيع HMAC فريد للملصق.
 * نتحقق من الرمز قبل وصول المعالج إلى البيانات كي لا يصبح رقم الطلب وحده وسيلة وصول.
 */
const requireOnlineOrderLabel = middleware(async ({ next, getRawInput }) => {
  const parsed = labelSummaryInput.safeParse(await getRawInput());
  if (!parsed.success) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "رابط الملصق غير صالح" });
  }

  const labelSummary = await readOnlineOrderLabel(parsed.data.orderNumber, parsed.data.token);
  return next({ ctx: { labelSummary } });
});

const labelSummaryProcedure = publicProcedure.use(requireOnlineOrderLabel);

export const storefrontRouter = router({
  /** فئات المتجر (لأشرطة الفلترة). */
  categories: publicProcedure.query(() => storefrontCategories()),

  /** العروض والخصومات الفعّالة اليوم (بنرات مشتقّة تلقائياً). */
  offers: publicProcedure.query(() => storefrontOffers()),

  /** البنرات الترويجية التي يديرها الموظف (لوحة hPanel) — فعّالة فقط. */
  banners: publicProcedure.query(() => listActiveBanners()),

  /** مؤشرات مجمّعة للبنر فقط؛ لا تحفظ هوية العميل أو عنوانه. */
  trackBanner: publicProcedure
    .input(z.object({
      bannerId: z.number().int().positive(),
      placement: z.enum(["HERO", "SIDE", "INLINE"]),
      event: z.enum(["IMPRESSION", "CLICK"]),
    }))
    .mutation(({ input }) => recordBannerMetric(input)),

  /** قمع التحويل المجمع: حدث بلا IP أو جلسة أو بيانات الطلب/العميل. */
  trackConversion: publicProcedure
    .input(z.object({ event: z.enum(["PRODUCT_VIEW", "ADD_TO_CART", "BEGIN_CHECKOUT"]) }))
    .mutation(({ input }) => recordStoreConversionMetric(input)),

  /** نقرة توصية مجهّلة: تُستدعى من الواجهة بعد موافقة التحليلات، ولا تحفظ جلسة أو IP أو زبوناً. */
  trackRecommendationClick: storefrontPublicWriteProcedure
    .input(z.object({
      sourceProductId: z.number().int().positive(),
      recommendedProductId: z.number().int().positive(),
    }))
    .mutation(({ input }) => recordStoreRecommendationClick(input)),

  /** إعدادات المتجر العامة (فتح/إغلاق + إعلان + واتساب) — آمنة للعرض. */
  settings: publicProcedure.query(() => getPublicStoreSettings()),

  /** يربط Firebase Phone OTP بسجل العميل ويصدر جلسة متجر قصيرة منفصلة عن جلسات الإدارة. */
  claimFirebaseCustomer: storefrontPublicWriteProcedure
    .input(z.object({ firebaseIdToken: z.string().trim().min(100).max(8_000), displayName: z.string().trim().min(2).max(120) }))
    .mutation(({ input }) => claimFirebaseStorefrontCustomer(input)),

  /** رصيد الولاء والقسائم الشخصية بعد تحقق الجلسة الموقعة فقط؛ لا تقبل هاتفاً يرسله التطبيق. */
  customerBenefits: storefrontPublicReadProcedure
    .input(z.object({ customerSessionToken: z.string().trim().min(40).max(4_000) }))
    .query(async ({ input }) => storefrontCustomerBenefits(await verifyStorefrontCustomerSession(input.customerSessionToken))),

  /** كتالوج المتجر: فلترة فئة + بحث نصّي + صفحات متسلسلة بلا اقتطاع صامت. */
  catalog: publicProcedure
    .input(
      z.object({
        categoryId: z.number().int().positive().nullish(),
        search: z.string().max(64).optional(),
        limit: z.number().int().min(1).max(120).default(60),
        // معرّف آخر منتج في الصفحة السابقة؛ يضيفه useInfiniteQuery فقط بعد الصفحة الأولى.
        cursor: z.number().int().positive().nullish(),
        // متوافق للخلف: غياب الحقل يبقي السلوك القديم (المتوفر فقط).
        availability: z.enum(["IN_STOCK", "ALL"]).default("IN_STOCK"),
      })
    )
    .query(({ input }) =>
      storefrontCatalog({
        categoryId: input.categoryId ?? null,
        search: input.search,
        limit: input.limit,
        cursor: input.cursor ?? null,
        availability: input.availability,
      })
    ),

  /** صفحة منتج واحد (تشمل محتويات البكج إن كان بكجاً). */
  product: publicProcedure
    .input(z.object({ productId: z.number().int().positive() }))
    .query(({ input }) => storefrontProduct(input.productId)),

  /** مراجعات معتمدة فقط؛ لا تكشف هوية العملاء أو المراجعات المعلّقة. */
  productReviews: storefrontPublicReadProcedure
    .input(z.object({ productId: z.number().int().positive() }))
    .query(({ input }) => listStorefrontProductReviews(input.productId)),

  /** يكتب مالك جلسة الهاتف مراجعة واحدة للمنتج بعد تسليم طلب اشتراه. */
  submitProductReview: storefrontPublicWriteProcedure
    .input(z.object({
      customerSessionToken: z.string().trim().min(40).max(4_000),
      productId: z.number().int().positive(),
      rating: z.number().int().min(1).max(5),
      comment: z.string().trim().min(8).max(1_000),
    }))
    .mutation(async ({ input }) => submitStorefrontProductReview({
      customerId: (await verifyStorefrontCustomerSession(input.customerSessionToken)).customerId,
      productId: input.productId,
      rating: input.rating,
      comment: input.comment,
    })),

  /** ينشئ رابطاً عشوائياً قصير العمر لمعرّفات منتجات علنية فقط؛ الكتابة محمية بالحدود العامة. */
  createWishlistShare: storefrontPublicWriteProcedure
    .input(z.object({ productIds: z.array(z.number().int().positive()).min(1).max(60) }))
    .mutation(({ input }) => createStorefrontWishlistShare(input.productIds)),

  /** يسترجع قائمة عامة بمفتاح غير قابل للتخمين؛ البيانات تنتهي بعد سبعة أيام. */
  getWishlistShare: storefrontPublicReadProcedure
    .input(z.object({ token: z.string().trim().regex(/^[A-Za-z0-9_-]{20,32}$/) }))
    .query(({ input }) => resolveStorefrontWishlistShare(input.token)),

  /** منتجات ذات صلة (cross-sell «يُشترى معه») — نفس الفئة، متوفّرة. */
  related: publicProcedure
    .input(z.object({ productId: z.number().int().positive() }))
    .query(({ input }) => storefrontRelated(input.productId)),

  /** توصيات السلة التي ضبطها المدير؛ لا تعيد التكلفة أو كمية المخزون. */
  cartRecommendations: storefrontPublicReadProcedure
    .input(z.object({ productIds: z.array(z.number().int().positive()).min(1).max(24) }))
    .query(({ input }) => storefrontCartRecommendations(input.productIds)),

  /** إعادة تسعير السلة بكمياتها الفعلية؛ نفس محرك createOrder، بلا أي كتابة. */
  quoteOrder: storefrontPublicReadProcedure
    .input(z.object({
      couponCode: z.string().trim().max(64).nullish(),
      governorate: z.string().trim().min(1).max(40),
      lines: z.array(z.object({
        productUnitId: z.number().int().positive(),
        quantity: z.number().int().positive().max(999),
      })).min(1).max(100),
    }))
    .query(({ input }) => quoteOnlineOrder(input)),

  /** تسجيل جهاز العميل بعد موافقته الصريحة فقط. الرمز مشفّر خادمياً ولا يرافقه هاتف أو معلومات طلب. */
  registerPushDevice: storefrontPublicWriteProcedure
    .input(z.object({
      expoPushToken: z.string().trim().min(20).max(300),
      marketingOptIn: z.boolean(),
      transactionalOptIn: z.boolean(),
      platform: z.enum(["IOS", "ANDROID"]),
      appVersion: z.string().trim().min(1).max(64),
    }))
    .mutation(({ input }) => registerStorefrontPushDevice(input)),

  /** حدث فتح بلا هوية؛ يُقبل فقط لتسليم موجود من الحملة، ويحافظ على قياس الأداء من الداشبورد. */
  trackPushInteraction: storefrontPublicWriteProcedure
    .input(z.object({ deliveryId: z.number().int().positive(), event: z.enum(["OPEN", "CLICK"]) }))
    .mutation(({ input }) => trackStorefrontPushInteraction(input)),

  /**
   * إنشاء طلب (الدفع عند الاستلام). **كتابة علنية** ⇒ محدودة معدّلاً بصرامة في index.ts.
   * السعر خادمي بالكامل. expectedUnitPrice/expectedGrandTotal عقد موافقة optimistic فقط:
   * لا يُسعّر الخادم منهما، بل يقارن السعر المقفَل بما رآه الزبون ويرفض أي اختلاف.
   * clientRequestId (اختياري) يمنع الطلب المكرّر.
   */
  createOrder: publicProcedure
    .input(
      z.object({
        couponCode: z.string().trim().max(64).nullish(),
        customerName: z.string().trim().min(1).max(255),
        customerPhone: z.string().trim().min(5).max(20),
        governorate: z.string().trim().min(1).max(40),
        addressText: z.string().trim().min(3).max(1000),
        latitude: z.number().min(-90).max(90).nullish(),
        longitude: z.number().min(-180).max(180).nullish(),
        notes: z.string().max(500).optional(),
        lines: z
          .array(z.object({
            productUnitId: z.number().int().positive(),
            quantity: z.number().int().positive().max(999),
            expectedUnitPrice: z.string().regex(/^\d{1,15}(?:\.\d{1,2})?$/),
          }))
          .min(1)
          .max(100),
        expectedGrandTotal: z.string().regex(/^\d{1,18}(?:\.\d{1,2})?$/),
        clientRequestId: z.string().trim().min(8).max(80),
        turnstileToken: z.string().trim().min(1).max(STOREFRONT_TURNSTILE_TOKEN_MAX_LENGTH),
      })
    )
    .mutation(async ({ input }) => {
      const { turnstileToken, ...rawOrderInput } = input;
      const orderInput = {
        ...rawOrderInput,
        latitude: rawOrderInput.latitude ?? null,
        longitude: rawOrderInput.longitude ?? null,
      };
      const result = await createVerifiedStorefrontOrder(
        orderInput,
        turnstileToken,
        {
          // يسبق token كي يستعيد الرد الضائع المملوك بلا استهلاك تحقق جديد.
          findOwnedReplay: findOwnedOnlineOrderReplay,
          verifyTurnstile: verifyStorefrontTurnstile,
          createOrder: createOnlineOrder,
        },
      );
      // نجاح إنشاء الطلب هو المصدر الموثوق لهذا الحدث؛ لا نأخذه من متصفح العميل.
      // الخدمة أفضل-جهد ولا تلمس بيانات الطلب أو العميل.
      if (!result.idempotentReplay) {
        void recordStoreConversionMetric({ event: "ORDER_COMPLETED", branchId: result.branchId });
      }
      return result;
    }),

  /** تتبّع طلب: يتطلّب رقم الطلب + الهاتف معاً (خصوصية). */
  trackOrder: publicProcedure
    .input(z.object({ orderNumber: z.string().trim().min(1).max(50), phone: z.string().trim().min(1).max(20) }))
    .query(({ input }) => trackOnlineOrder(input.orderNumber, input.phone)),

  /** تظهر عند مسح QR الملصق: صفحة عامة محدودة الوصول بتوقيع خاص بالملصق. */
  labelSummary: labelSummaryProcedure
    .input(labelSummaryInput)
    .query(({ ctx }) => ctx.labelSummary),
});
