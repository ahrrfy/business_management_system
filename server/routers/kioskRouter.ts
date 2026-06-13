/**
 * kioskRouter — شاشة «قارئ الأسعار» للزبون (الكشك).
 *
 * protectedProcedure (لا public): جهاز الكشك يبقى مسجَّل الدخول داخل المتجر ⇒ لا نفتح
 * نقطة بيانات على الإنترنت بلا مصادقة. والمخرَج آمن للزبون (kioskService): بلا تكلفة
 * ولا كمية مخزون ولا أسعار جملة/حكومي.
 */
import { z } from "zod";
import { protectedProcedure, router } from "../trpc";
import { kioskBanner, kioskLookup } from "../services/kioskService";

export const kioskRouter = router({
  /** منتجات البنر المتوفّرة في الفرع (سعر المفرد + صورة). */
  banner: protectedProcedure
    .input(z.object({ branchId: z.number().int().positive(), limit: z.number().int().min(1).max(60).default(40) }))
    .query(({ input }) => kioskBanner(input.branchId, input.limit)),

  /** بحث سعر بالباركود (المسح). يعيد null إن لم يُعرَف الباركود. */
  lookup: protectedProcedure
    .input(z.object({ branchId: z.number().int().positive(), barcode: z.string().min(1).max(64) }))
    .query(({ input }) => kioskLookup(input.barcode, input.branchId)),
});
