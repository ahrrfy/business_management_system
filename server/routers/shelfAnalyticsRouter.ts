/**
 * shelfAnalyticsRouter — راوتر لوحة تحليلات وإحصائيات المستفيدين من خدمة استعلام أسعار الرفوف.
 *
 * مخصص لإدارة المعرض والفروع (managerProcedure):
 *  - استخراج مؤشرات الأداء الحيوية وأعداد المستفيدين الحقيقيين.
 *  - توزيع النشاط حسب الفروع والأجهزة وأكثر المنتجات بحثاً.
 *  - تصفير ومسح سجل الاستعلامات والبيانات الوهمية والبدء من الصفر.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { appErrorMessage } from "@shared/errors";
import { canCrossBranches } from "../lib/branchAuthority";
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
    .query(async ({ input, ctx }) => {
      const canCross =
        (ctx as { canCrossBranches?: boolean }).canCrossBranches ?? canCrossBranches(ctx.user);
      const userBranchId =
        (ctx as { scopedBranchId?: number | null }).scopedBranchId ??
        (ctx.user.branchId != null ? Number(ctx.user.branchId) : undefined);
      if (!canCross) {
        if (userBranchId == null) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: appErrorMessage({
              what: "تعذر استعراض إحصائيات الرفوف لعدم وجود فرع مسند",
              why: "حسابك غير مرتبط بفرع تشغيلي محدد.",
              doThis: "تواصل مع مدير النظام لإسناد الفرع لحسابك.",
            }),
          });
        }
        if (input?.branchId !== undefined && Number(input.branchId) !== Number(userBranchId)) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: appErrorMessage({
              what: "لا يمكن قراءة تحليلات فرع آخر",
              why: "صلاحيتك مقيّدة بفرعك المسند.",
              doThis: "استعرض إحصائيات فرعك فقط.",
            }),
          });
        }
      }
      const effectiveBranchId = canCross ? input?.branchId : userBranchId;
      return getShelfBeneficiariesStats({
        branchId: effectiveBranchId,
        range: input?.range as ShelfDateRange | undefined,
      });
    }),

  /**
   * مسح وتصفير كافة سجلات استعلامات الرفوف والبيانات الوهمية والبدء من الصفر.
   */
  purgeLogs: storeManagerProcedure.mutation(async ({ ctx }) => {
    const canCross =
      (ctx as { canCrossBranches?: boolean }).canCrossBranches ?? canCrossBranches(ctx.user);
    const userBranchId =
      (ctx as { scopedBranchId?: number | null }).scopedBranchId ??
      (ctx.user.branchId != null ? Number(ctx.user.branchId) : undefined);
    if (!canCross && !userBranchId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "تعذر مسح سجلات استعلامات الرفوف",
          why: "لا يوجد فرع مسند لحسابك لتحديد نطاق التصفير.",
          doThis: "تواصل مع مدير النظام لإسناد الفرع لحسابك.",
        }),
      });
    }
    const deletedCount = await purgeShelfLookupLogs({
      branchId: canCross ? undefined : userBranchId,
    });
    return { success: true, count: deletedCount };
  }),
});
