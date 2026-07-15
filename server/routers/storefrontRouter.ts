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
import { publicProcedure, router } from "../trpc";
import { storefrontCatalog, storefrontCategories, storefrontOffers, storefrontProduct, storefrontRelated } from "../services/storefrontService";
import { createOnlineOrder, trackOnlineOrder } from "../services/onlineOrderService";
import { retryOnDup } from "../lib/retryDup";
import { listActiveBanners } from "../services/storeAdmin/bannerService";
import { getStoreSettings } from "../services/storeAdmin/storeSettingsService";
import { recordBannerMetric } from "../services/storeAdmin/bannerMetricsService";
import { recordStoreConversionMetric } from "../services/storeAdmin/storeConversionMetricsService";

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

  /** إعدادات المتجر العامة (فتح/إغلاق + إعلان + واتساب) — آمنة للعرض. */
  settings: publicProcedure.query(() => getStoreSettings()),

  /** كتالوج المتجر: فلترة فئة + بحث نصّي + سقف. يعيد التوفّر وسعر العرض. */
  catalog: publicProcedure
    .input(
      z.object({
        categoryId: z.number().int().positive().nullish(),
        search: z.string().max(64).optional(),
        limit: z.number().int().min(1).max(120).default(60),
      })
    )
    .query(({ input }) =>
      storefrontCatalog({
        categoryId: input.categoryId ?? null,
        search: input.search,
        limit: input.limit,
      })
    ),

  /** صفحة منتج واحد (تشمل محتويات البكج إن كان بكجاً). */
  product: publicProcedure
    .input(z.object({ productId: z.number().int().positive() }))
    .query(({ input }) => storefrontProduct(input.productId)),

  /** منتجات ذات صلة (cross-sell «يُشترى معه») — نفس الفئة، متوفّرة. */
  related: publicProcedure
    .input(z.object({ productId: z.number().int().positive() }))
    .query(({ input }) => storefrontRelated(input.productId)),

  /**
   * إنشاء طلب (الدفع عند الاستلام). **كتابة علنية** ⇒ محدودة معدّلاً بصرامة في index.ts.
   * السعر خادمي بالكامل (المدخل لا يحوي أسعاراً — فقط productUnitId + الكمية). المحافظة يتحقّق
   * منها الخادم. clientRequestId (اختياري) يمنع الطلب المكرّر.
   */
  createOrder: publicProcedure
    .input(
      z.object({
        customerName: z.string().trim().min(1).max(255),
        customerPhone: z.string().trim().min(5).max(20),
        governorate: z.string().trim().min(1).max(40),
        addressText: z.string().trim().min(3).max(1000),
        latitude: z.number().min(-90).max(90).nullish(),
        longitude: z.number().min(-180).max(180).nullish(),
        notes: z.string().max(500).optional(),
        lines: z
          .array(z.object({ productUnitId: z.number().int().positive(), quantity: z.number().int().positive().max(999) }))
          .min(1)
          .max(100),
        clientRequestId: z.string().max(80).optional(),
      })
    )
    // retryOnDup: نقرة مزدوجة متزامنة بنفس clientRequestId قد يمرّ فحصُها الاستباقي معاً قبل الالتزام،
    // فيصطدم الإدراج الثاني بقيد uq_online_order_client_req (ER_DUP_ENTRY). إعادة المحاولة تلتقط الطلب
    // المُلتزَم فتُعيد replay بدل 500 (مراجعة عدائية ١٢/٧).
    .mutation(async ({ input }) => {
      const result = await retryOnDup(() =>
        createOnlineOrder({
          ...input,
          latitude: input.latitude ?? null,
          longitude: input.longitude ?? null,
        })
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
});
