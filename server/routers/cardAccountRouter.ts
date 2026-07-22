// راوتر «حساب البطاقة/البنك» — قراءة الرصيد/الحركات المشتقّة + لقطات المطابقة.
//
// RBAC: reportViewerProcedure (manager/accountant/auditor + منح صريح reports≥READ) — نفس بوّابة
// التقارير المالية (§٦ الخطّ الأحمر): أموال البطاقة بيانٌ ماليّ يُحجَب عن الكاشير/المخزن. البوّابة
// أيضاً تَرفض طلب فرعٍ غير فرع غير-الأدمن (عزل IDOR). الإنشاء يُحجَب عن المدقّق (auditor) — قراءةٌ فقط.
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { reportViewerProcedure, router } from "../trpc";
import { nonNegMoneyString, ymdDate } from "../lib/schemas";
import {
  createCardReconciliation,
  getCardMovements,
  getCardSummary,
  listCardReconciliations,
  type CardScope,
} from "../services/cardAccountService";

function scopeOf(ctx: { user: { role: string; branchId?: number | null } }): CardScope {
  return { role: ctx.user.role, branchId: ctx.user.branchId != null ? Number(ctx.user.branchId) : null };
}

const branchInput = z.number().int().positive().optional();

export const cardAccountRouter = router({
  /** ملخّص الرصيد الجاري + دخل/صرف اليوم + آخر لقطة مطابقة. */
  summary: reportViewerProcedure
    .input(z.object({ branchId: branchInput }).optional())
    .query(({ input, ctx }) => getCardSummary(input ?? {}, scopeOf(ctx))),

  /** حركات حساب البطاقة (دخل/صرف) برصيدٍ جارٍ لكل صفّ (للفرع المحدَّد) + إجماليات النطاق. */
  movements: reportViewerProcedure
    .input(
      z
        .object({
          branchId: branchInput,
          from: ymdDate.optional(),
          to: ymdDate.optional(),
          direction: z.enum(["IN", "OUT"]).optional(),
          limit: z.number().int().min(1).max(500).optional(),
          offset: z.number().int().min(0).optional(),
        })
        .optional(),
    )
    .query(({ input, ctx }) => getCardMovements(input ?? {}, scopeOf(ctx))),

  /** سجلّ لقطات المطابقة السابقة. */
  reconciliations: reportViewerProcedure
    .input(z.object({ branchId: branchInput, limit: z.number().int().min(1).max(200).optional() }).optional())
    .query(({ input, ctx }) => listCardReconciliations(input ?? {}, scopeOf(ctx))),

  /** إنشاء لقطة مطابقة: النظام يحسب الرصيد المتوقَّع، والمستخدم يُدخل رصيد كشف البنك ⇒ الفرق. */
  createReconciliation: reportViewerProcedure
    .input(
      z.object({
        branchId: branchInput,
        asOfDate: ymdDate,
        statementBalance: nonNegMoneyString,
        statementLabel: z.string().max(120).optional(),
        note: z.string().max(1000).optional(),
      }),
    )
    .mutation(({ input, ctx }) => {
      // المدقّق قارئٌ فقط — لا يُنشئ سجلّات مطابقة (الإنشاء للمدير/المحاسب).
      if (ctx.user.role === "auditor") {
        throw new TRPCError({ code: "FORBIDDEN", message: "المدقّق لا يُنشئ سجلّات المطابقة — قراءة فقط." });
      }
      return createCardReconciliation(input, {
        userId: ctx.user.id,
        role: ctx.user.role,
        branchId: ctx.user.branchId != null ? Number(ctx.user.branchId) : null,
      });
    }),
});
