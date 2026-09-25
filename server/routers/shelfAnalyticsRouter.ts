/**
 * shelfAnalyticsRouter — راوتر لوحة تحليلات وإحصائيات المستفيدين من خدمة استعلام أسعار الرفوف.
 *
 * مخصص لإدارة المعرض والفروع (managerProcedure):
 *  - استخراج مؤشرات الأداء الحيوية وأعداد المستفيدين الحقيقيين.
 *  - توزيع النشاط حسب الفروع والأجهزة وأكثر المنتجات بحثاً.
 *  - إمكانية بذر بيانات استرشادية واقعية لتجربة وفحص مؤشرات المعرض.
 */
import { z } from "zod";
import { router, storeManagerProcedure } from "../trpc";
import {
  getShelfBeneficiariesStats,
  seedShowroomSampleAnalytics,
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
   * بذر بيانات استرشادية واقعية لحركة زوار المعرض (للتدشين والفحص البصري).
   */
  seedDemo: storeManagerProcedure
    .input(
      z
        .object({
          count: z.number().int().min(10).max(150).optional(),
        })
        .optional(),
    )
    .mutation(async ({ input }) => {
      const inserted = await seedShowroomSampleAnalytics(input?.count ?? 45);
      return { success: true, count: inserted };
    }),
});
