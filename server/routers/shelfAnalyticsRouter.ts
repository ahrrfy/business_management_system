/**
 * shelfAnalyticsRouter — راوتر لوحة تحليلات وإحصائيات المستفيدين من خدمة استعلام أسعار الرفوف.
 *
 * مخصص لإدارة المعرض والفروع (managerProcedure):
 *  - استخراج مؤشرات الأداء الحيوية وأعداد المستفيدين الحقيقيين.
 *  - توزيع النشاط حسب الفروع والأجهزة وأكثر المنتجات بحثاً.
 *  - تصفير ومسح سجل الاستعلامات والبيانات الوهمية والبدء من الصفر.
 */
import { z } from "zod";
import { router, storeManagerProcedure } from "../trpc";
import {
  getShelfBeneficiariesStats,
  purgeShelfLookupLogs,
  type ShelfDateRange,
} from "../services/shelfAnalyticsService";

export const shelfAnalyticsRouter = router({
  /**
   * جلب إحصائيات المستفيدين من خدمة الرفوف والمسح بالباركود.
   */
  getStats: storeManagerProcedure
    .input(
      z
        .object({
          branchId: z.number().int().positive().optional(),
          range: z.enum(["today", "7d", "30d", "all"] as const).optional(),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      return getShelfBeneficiariesStats({
        branchId: input?.branchId,
        range: input?.range as ShelfDateRange | undefined,
      });
    }),

  /**
   * مسح وتصفير كافة سجلات استعلامات الرفوف والبيانات الوهمية والبدء من الصفر.
   */
  purgeLogs: storeManagerProcedure.mutation(async () => {
    const deletedCount = await purgeShelfLookupLogs();
    return { success: true, count: deletedCount };
  }),
});
