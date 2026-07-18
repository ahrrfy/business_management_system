// راوتر العمل دون اتصال — الشريحة ٢ من خطة الأوفلاين: نقاط جلب النموذج المحلي (لقطات
// الكتالوج/المخزون/العملاء + النسخ). القراءة فقط هنا؛ إعادة تشغيل المبيعات (replaySale)
// تأتي في الشريحة ٣.
//
// البوّابات مرآة catalogRouter/customerRouter: الكتالوج والأسعار خلف products READ،
// والعملاء خلف crm READ — نفس ما يصل إليه الكاشير أونلاين، لا أوسع (اللقطة ليست تصديراً
// أوسع من الشاشة). المخزون مقيَّد بفرع المستخدم غير المرتفع (نفس حارس IDOR في posList).

import { z } from "zod";
import {
  buildCatalogSnapshot,
  buildCustomersSnapshot,
  buildOfflineVersions,
  buildStockSnapshot,
} from "../services/offline/catalogSnapshot";
import { customersReadProcedure, productsReadProcedure, router } from "../trpc";

/** نفس حارس IDOR في catalogRouter: غير المرتفعين محصورون بفرعهم المُسنَد. */
function scopeBranch(ctx: { user: { role: string; branchId?: number | null } }, requested: number): number {
  const elevated = ctx.user.role === "admin" || ctx.user.role === "manager";
  if (elevated) return requested;
  return ctx.user.branchId != null ? Number(ctx.user.branchId) : requested;
}

export const offlineRouter = router({
  /** نسخ رخيصة تُقارَن كل مزامنة — تغيّر نسخة ⇒ جلب اللقطة الموافقة كاملة. */
  versions: productsReadProcedure.query(() => buildOfflineVersions()),

  catalogSnapshot: productsReadProcedure.query(() => buildCatalogSnapshot()),

  stockSnapshot: productsReadProcedure
    .input(z.object({ branchId: z.number().int().positive() }))
    .query(({ input, ctx }) => buildStockSnapshot(scopeBranch(ctx, input.branchId))),

  customersSnapshot: customersReadProcedure.query(() => buildCustomersSnapshot()),
});
