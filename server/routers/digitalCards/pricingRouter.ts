// أسعار اليوم (ش٤) — راوتر البطاقات الرقمية والاشتراكات.
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { nonNegMoneyString } from "../../lib/schemas";
import { pricingService } from "../../services/digitalCards";
import { withTx } from "../../services/tx";
import { digitalCardsAdminReadProcedure, digitalCardsManagerProcedure, digitalCardsPosProcedure, router } from "../../trpc";
import { actorOf, requireDb, scopedBranchOf, type Ctx } from "./shared";

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح (YYYY-MM-DD)");

const scopeInput = z.object({
  branchId: z.number().int().positive(),
  providerId: z.number().int().positive(),
  businessDate: ymd,
});

const lineInput = z.object({
  offeringId: z.number().int().positive(),
  providerShare: nonNegMoneyString,
});

/** يفرض فرع المستخدم على أي نطاق قادم من العميل (منع IDOR عبر branchId). */
function assertBranch(ctx: Ctx, branchId: number) {
  const scoped = scopedBranchOf(ctx);
  if (scoped != null && branchId !== scoped) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا صلاحية على فرع آخر" });
  }
}

export const pricingRouter = router({
  getMorningSheet: digitalCardsAdminReadProcedure.input(scopeInput).query(async ({ input, ctx }) => {
    assertBranch(ctx, input.branchId);
    return pricingService.getMorningSheet(requireDb(), input);
  }),

  /** معاينة السعر خادمياً — الواجهة لا تعيد بناء معادلة التقريب (§٧.٣). */
  preview: digitalCardsAdminReadProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        providerId: z.number().int().positive(),
        lines: z.array(lineInput).max(500),
      }),
    )
    .query(async ({ input, ctx }) => {
      assertBranch(ctx, input.branchId);
      return pricingService.previewPrices(requireDb(), input);
    }),

  copyPrevious: digitalCardsManagerProcedure.input(scopeInput).mutation(async ({ input, ctx }) => {
    assertBranch(ctx, input.branchId);
    return withTx((tx) => pricingService.copyPrevious(tx, input, actorOf(ctx)));
  }),

  saveDraft: digitalCardsManagerProcedure
    .input(scopeInput.extend({ lines: z.array(lineInput).min(1).max(500) }))
    .mutation(async ({ input, ctx }) => {
      assertBranch(ctx, input.branchId);
      const actor = actorOf(ctx);
      return withTx(async (tx) => {
        const { batchId } = await pricingService.createOrGetDraft(tx, input, actor);
        return pricingService.saveDraft(tx, { batchId, lines: input.lines }, actor);
      });
    }),

  /** الحفظ والنشر في معاملة واحدة — لا حالة وسطية بين مسودّة مكتوبة ودُفعة منشورة. */
  publish: digitalCardsManagerProcedure
    .input(scopeInput.extend({ lines: z.array(lineInput).min(1).max(500) }))
    .mutation(async ({ input, ctx }) => {
      assertBranch(ctx, input.branchId);
      const actor = actorOf(ctx);
      return withTx(async (tx) => {
        const { batchId } = await pricingService.createOrGetDraft(tx, input, actor);
        await pricingService.saveDraft(tx, { batchId, lines: input.lines }, actor);
        return pricingService.publish(tx, { batchId }, actor);
      });
    }),

  cancelDraft: digitalCardsManagerProcedure
    .input(z.object({ batchId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => pricingService.cancelDraft(tx, input, actorOf(ctx))),
    ),

  /** §٧.١: اعتماد مديرٍ آخر لتغييرٍ ≥٥٠٪ في حصة المزوّد — يُجيز النشر ولا يَنشر. */
  approveBigChange: digitalCardsManagerProcedure
    .input(z.object({ batchId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => pricingService.approveBigChange(tx, input, actorOf(ctx))),
    ),

  /** بلاغ الكاشير «السعر لدى الجهاز مختلف» — لا يغيّر سعراً بذاته (§٧.٥). */
  reportMismatch: digitalCardsPosProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        offeringId: z.number().int().positive(),
        reportedProviderShare: nonNegMoneyString,
        notes: z.string().max(500).nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      assertBranch(ctx, input.branchId);
      return withTx((tx) => pricingService.reportMismatch(tx, input, actorOf(ctx)));
    }),

  mismatchReports: digitalCardsAdminReadProcedure
    .input(
      z.object({
        branchId: z.number().int().positive().optional(),
        status: z.enum(["OPEN", "APPROVED", "REJECTED", "RESOLVED"]).optional(),
      }).optional(),
    )
    .query(async ({ input, ctx }) => {
      const scoped = scopedBranchOf(ctx);
      return pricingService.listMismatchReports(requireDb(), {
        status: input?.status,
        branchId: scoped ?? input?.branchId ?? null,
      });
    }),

  approveMismatch: digitalCardsManagerProcedure
    .input(
      z.object({
        reportId: z.number().int().positive(),
        businessDate: ymd,
        notes: z.string().max(500).nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => pricingService.approveMismatch(tx, input, actorOf(ctx))),
    ),

  rejectMismatch: digitalCardsManagerProcedure
    .input(z.object({ reportId: z.number().int().positive(), notes: z.string().max(500).nullish() }))
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => pricingService.rejectMismatch(tx, input, actorOf(ctx))),
    ),
});
