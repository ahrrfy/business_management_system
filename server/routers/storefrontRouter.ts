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
import { storefrontCatalog, storefrontCategories, storefrontProduct } from "../services/storefrontService";

export const storefrontRouter = router({
  /** فئات المتجر (لأشرطة الفلترة). */
  categories: publicProcedure.query(() => storefrontCategories()),

  /** كتالوج المتجر: فلترة فئة + بحث نصّي + سقف. */
  catalog: publicProcedure
    .input(
      z.object({
        categoryId: z.number().int().positive().nullish(),
        search: z.string().max(64).optional(),
        limit: z.number().int().min(1).max(120).default(60),
      })
    )
    .query(({ input }) =>
      storefrontCatalog({ categoryId: input.categoryId ?? null, search: input.search, limit: input.limit })
    ),

  /** صفحة منتج واحد. */
  product: publicProcedure
    .input(z.object({ productId: z.number().int().positive() }))
    .query(({ input }) => storefrontProduct(input.productId)),
});
