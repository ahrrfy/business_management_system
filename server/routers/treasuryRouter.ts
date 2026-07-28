// راوتر لوحة الخزينة (قراءة). branchScopedProcedure (يَتيح الكاشير لرؤية دَرْجه فقط، ويَحجب TREASURY عنه).
// التمييز عن /reports/treasury الموجود: هذا داشبورد لحظي (آخر تحديث + sparklines + breakdowns) ،
// والآخر تقرير فترة. لذا لا تداخل وظيفي.

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  acceptPendingTreasuryReceipt,
  getCashFlowSeries,
  getDashboard,
  getKpiTrends,
  getOpenShifts,
  getPaymentMethodBreakdown,
  getRecentMovements,
  listMyPendingTreasuryReceipts,
} from "../services/treasuryService";
import { fundTreasury } from "../services/treasuryFundingService";
import { logAudit } from "../services/auditService";
import { retryOnDup } from "../lib/retryDup";
import { branchScopedProcedure, managerBranchScopedProcedure, requireModule, router } from "../trpc";

const periodEnum = z.enum(["today", "yesterday", "week", "month"]);

// إنفاذ وحدة «الخزينة» (treasury) فَوق عَزل الفرع: قراءة. الكاشير (treasury=READ) يَصل ويَرى
// دَرْجه فقط (getDashboard يُمرّر الدور)؛ أدوار غَير مالية (مخزن/مشتريات…) = NONE ⇒ تُحجَب فِعلياً.
const treasuryRead = branchScopedProcedure.use(requireModule("treasury", "READ"));

export const treasuryRouter = router({
  /** عقود تسليم النقد المعلقة المسندة للمستخدم الحالي وحده. */
  pendingHandoverReceipts: treasuryRead.query(async ({ ctx }) => {
    return listMyPendingTreasuryReceipts({
      userId: ctx.user.id,
      branchId: ctx.user.branchId == null ? -1 : Number(ctx.user.branchId),
      role: ctx.user.role,
    });
  }),

  /** قبول صريح من المستلم نفسه؛ بعده فقط يصبح النقد جزءاً من رصيد الخزينة. */
  acceptHandoverReceipt: treasuryRead
    .input(z.object({ receiptId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      return acceptPendingTreasuryReceipt(
        input.receiptId,
        {
          userId: ctx.user.id,
          branchId: ctx.user.branchId == null ? -1 : Number(ctx.user.branchId),
          role: ctx.user.role,
        },
        ctx,
      );
    }),

  /** لوحة قيادة كاملة: drawer/treasury per branch + KPIs اليوم + عدد الورديات المفتوحة. */
  getDashboard: treasuryRead
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
        userId: ctx.user.id,
      });
    }),

  /** آخر N حركة موحَّدة (receipts + expenses) لجدول الداشبورد. */
  getRecentMovements: treasuryRead
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
        userId: ctx.user.id,
      });
    }),

  /** سلسلة تدفّق نقدي يومية — تَملأ الأيام الفارغة بأصفار للـchart. */
  getCashFlowSeries: treasuryRead
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
  getPaymentMethodBreakdown: treasuryRead
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
  getKpiTrends: treasuryRead
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
        userId: ctx.user.id,
      });
    }),

  /** بطاقات الورديات المفتوحة الآن (للوحة جانبية في الداشبورد). */
  getOpenShifts: treasuryRead
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
        userId: ctx.user.id,
      });
    }),

  /**
   * تمويل الخزينة (إيداع رأس مال / رصيد افتتاحيّ) — العهدة الوسيطة (imprest، ٢٨/٧/٢٦).
   * البوّابة الوحيدة لضخّ نقدٍ خارجيّ في الخزينة كي تُموَّل عهد الورديات. admin (أيّ فرع) أو
   * manager (فرعه فقط). idempotent (نقرٌ مزدوج لا يضاعف).
   * البوّابة الموحّدة: managerBranchScopedProcedure + requireModule("treasury","FULL") ⇒ يحترم منع
   * الوحدة الصريح (permissionsOverride treasury=NONE) كسائر نقاط الخزينة، لا اسم الدور الخام وحده.
   * retryOnDup: ترقيم TF- يحرّر GET_LOCK قبل الالتزام ⇒ تمويلان متزامنان قد يحسبان نفس الرقم؛ القيد
   * الفريد (dedupeKey) يرفض الثاني فنعيد المحاولة (fundTreasury ذرّيّ داخل withTx، والمفتاح المكرّر يعود idempotent).
   */
  fundTreasury: managerBranchScopedProcedure
    .use(requireModule("treasury", "FULL"))
    .input(
      z.object({
        branchId: z.number().int().positive(),
        amount: z.string().regex(/^\d+(\.\d{1,2})?$/, "المبلغ مبلغ غير سالب"),
        description: z.string().min(1, "التبرير مطلوب").max(500),
        notes: z.string().max(500).nullish(),
        clientRequestId: z.string().min(1).max(64),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const res = await retryOnDup(() => fundTreasury(
        {
          branchId: input.branchId,
          amount: input.amount,
          description: input.description,
          notes: input.notes ?? null,
          clientRequestId: input.clientRequestId,
        },
        {
          userId: ctx.user.id,
          branchId: ctx.user.branchId == null ? -1 : Number(ctx.user.branchId),
          role: ctx.user.role,
        },
      ));
      await logAudit(ctx, {
        action: "treasury.fund",
        entityType: "receipt",
        entityId: res.receiptId,
        newValue: {
          referenceNumber: res.referenceNumber,
          amount: input.amount,
          branchId: input.branchId,
          treasuryBalanceAfter: res.treasuryBalanceAfter,
        },
      });
      return res;
    }),
});
