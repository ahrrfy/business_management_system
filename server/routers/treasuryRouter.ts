// راوتر لوحة الخزينة (قراءة). branchScopedProcedure (يَتيح الكاشير لرؤية دَرْجه فقط، ويَحجب TREASURY عنه).
// التمييز عن /reports/treasury الموجود: هذا داشبورد لحظي (آخر تحديث + sparklines + breakdowns) ،
// والآخر تقرير فترة. لذا لا تداخل وظيفي.

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  getCashFlowSeries,
  getDashboard,
  getKpiTrends,
  getOpenShifts,
  getPaymentMethodBreakdown,
  getRecentMovements,
} from "../services/treasuryService";
import { branchScopedProcedure, router } from "../trpc";

const periodEnum = z.enum(["today", "yesterday", "week", "month"]);

export const treasuryRouter = router({
  /** لوحة قيادة كاملة: drawer/treasury per branch + KPIs اليوم + عدد الورديات المفتوحة. */
  getDashboard: branchScopedProcedure
    .input(
      z
        .object({
          branchId: z.number().int().positive().optional(),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      // F1 نمط: ctx.scopedBranchId مفعّل (admin/manager = null، غيرهم = branchId).
      return getDashboard(input ?? {}, {
        scopedBranchId: (ctx as { scopedBranchId: number | null }).scopedBranchId,
        role: ctx.user.role,
      });
    }),

  /** آخر N حركة موحَّدة (receipts + expenses) لجدول الداشبورد. */
  getRecentMovements: branchScopedProcedure
    .input(
      z
        .object({
          branchId: z.number().int().positive().optional(),
          limit: z.number().int().min(1).max(100).default(20),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      return getRecentMovements(input ?? {}, {
        scopedBranchId: (ctx as { scopedBranchId: number | null }).scopedBranchId,
        role: ctx.user.role,
      });
    }),

  /** سلسلة تدفّق نقدي يومية — تَملأ الأيام الفارغة بأصفار للـchart. */
  getCashFlowSeries: branchScopedProcedure
    .input(
      z
        .object({
          days: z.number().int().min(7).max(90).default(30),
          branchId: z.number().int().positive().optional(),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      return getCashFlowSeries(input ?? {}, {
        scopedBranchId: (ctx as { scopedBranchId: number | null }).scopedBranchId,
        role: ctx.user.role,
      });
    }),

  /** توزيع المقبوضات والمدفوعات حسب طريقة الدفع (للدونات). */
  getPaymentMethodBreakdown: branchScopedProcedure
    .input(
      z
        .object({
          period: periodEnum.default("today"),
          branchId: z.number().int().positive().optional(),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      return getPaymentMethodBreakdown(input ?? {}, {
        scopedBranchId: (ctx as { scopedBranchId: number | null }).scopedBranchId,
        role: ctx.user.role,
      });
    }),

  /** اتجاهات الـKPIs (قيمة اليوم/الأمس/delta٪/sparkline). */
  getKpiTrends: branchScopedProcedure
    .input(
      z
        .object({
          branchId: z.number().int().positive().optional(),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      return getKpiTrends(input ?? {}, {
        scopedBranchId: (ctx as { scopedBranchId: number | null }).scopedBranchId,
        role: ctx.user.role,
      });
    }),

  /** بطاقات الورديات المفتوحة الآن (للوحة جانبية في الداشبورد). */
  getOpenShifts: branchScopedProcedure
    .input(
      z
        .object({
          branchId: z.number().int().positive().optional(),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      const scopedBranchId = (ctx as { scopedBranchId: number | null }).scopedBranchId;
      if (scopedBranchId == null && ctx.user.role !== "admin" && ctx.user.role !== "manager") {
        // دفاع متعمّق: إن وصلنا هنا بدون فرع لغير الإداريين فالـmiddleware سَمَح (لا يجب أن يَحدث).
        throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد" });
      }
      return getOpenShifts(input ?? {}, {
        scopedBranchId,
        role: ctx.user.role,
      });
    }),
});
