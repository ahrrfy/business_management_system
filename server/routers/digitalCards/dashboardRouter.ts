// الداشبورد (ش١١) — راوتر البطاقات الرقمية والاشتراكات.
// كل النقاط: فترة **نصف مفتوحة** [from, to)، عزل فرع مفروض خادمياً، تجميع في القاعدة،
// وحجب الحصة/الربح عمّن لا يملك رؤية التكلفة (`canSeeCostForUser`) — حجبٌ في الخدمة لا في العرض.
import { z } from "zod";
import { dashboardService } from "../../services/digitalCards";
import { canSeeCostForUser, digitalCardsAdminReadProcedure, router } from "../../trpc";
import { requireDb, scopedBranchOf, type Ctx } from "./shared";

const periodInput = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح (YYYY-MM-DD)"),
  /** النهاية **حصرية** — يومٌ واحد = from=D, to=D+1. */
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح (YYYY-MM-DD)"),
  branchId: z.number().int().positive().optional(),
});

function scopeOf(ctx: Ctx & { user: { permissionsOverride?: unknown } }, input: z.infer<typeof periodInput>) {
  const scoped = scopedBranchOf(ctx);
  return {
    from: input.from,
    to: input.to,
    branchId: scoped ?? input.branchId ?? null,
    includeCost: canSeeCostForUser(ctx.user),
  };
}

export const dashboardRouter = router({
  summary: digitalCardsAdminReadProcedure
    .input(periodInput)
    .query(async ({ input, ctx }) => dashboardService.summary(requireDb(), scopeOf(ctx, input))),

  providerBalances: digitalCardsAdminReadProcedure.query(async ({ ctx }) =>
    dashboardService.providerBalances(requireDb(), scopedBranchOf(ctx)),
  ),

  postpaidDues: digitalCardsAdminReadProcedure.query(async () => dashboardService.postpaidDues(requireDb())),

  priceHealth: digitalCardsAdminReadProcedure.query(async ({ ctx }) =>
    dashboardService.priceHealth(requireDb(), scopedBranchOf(ctx)),
  ),

  pendingExecutions: digitalCardsAdminReadProcedure.query(async ({ ctx }) =>
    dashboardService.pendingExecutions(requireDb(), scopedBranchOf(ctx)),
  ),

  topOfferings: digitalCardsAdminReadProcedure
    .input(periodInput.extend({ limit: z.number().int().positive().max(50).optional() }))
    .query(async ({ input, ctx }) =>
      dashboardService.topOfferings(requireDb(), scopeOf(ctx, input), input.limit ?? 10),
    ),

  reconciliationStatus: digitalCardsAdminReadProcedure
    .input(periodInput)
    .query(async ({ input, ctx }) => dashboardService.reconciliationStatus(requireDb(), scopeOf(ctx, input))),
});
