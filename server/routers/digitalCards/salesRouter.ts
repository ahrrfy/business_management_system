// نيّة البيع والتنفيذ الخارجيّ (ش٧) + التثبيت المالي (ش٨) — راوتر البطاقات الرقمية والاشتراكات.
// `prepare` يحجز رصيد المحفظة ويسجّل النيّة **قبل** لمس جهاز المزوّد — بلا فاتورة ولا خصم رصيد.
// `markExecution` يسجّل نجاح كل كرت لحظةَ إصداره، فيبقى أثره حتى لو أُغلق المتصفّح بعدها.
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { nonNegMoneyString } from "../../lib/schemas";
import { finalizeService, intentService, reviewResolutionService, writeoffService } from "../../services/digitalCards";
import { withTx } from "../../services/tx";
import {
  digitalCardsAdminReadProcedure,
  digitalCardsManagerProcedure,
  digitalCardsPosProcedure,
  router,
} from "../../trpc";
import { actorOf, requireDb, scopedBranchOf } from "./shared";

const studentSnapshotSchema = z.object({
  studentName: z.string().min(1).max(200),
  studentPhone: z.string().min(1).max(25),
  // Backward-compatible optional fields from the retired student-profile flow.
  customerId: z.number().int().positive().nullish(),
  guardianPhone: z.string().max(25).nullish(),
  address: z.string().max(500).nullish(),
  mode: z.enum(["UPDATE_PROFILE", "INVOICE_ONLY"]).optional(),
});

export const salesRouter = router({
  prepare: digitalCardsPosProcedure
    .input(
      z.object({
        clientRequestId: z.string().min(8).max(80),
        branchId: z.number().int().positive(),
        shiftId: z.number().int().positive(),
        paymentMethod: z.string().min(1).max(20),
        cartFingerprint: z.string().min(1).max(64),
        lines: z
          .array(
            z.object({
              lineKey: z.string().min(1).max(64),
              offeringId: z.number().int().positive(),
              priceVersionId: z.number().int().positive(),
              expectedSellPrice: nonNegMoneyString,
              providerReference: z.string().min(1).max(120),
              student: studentSnapshotSchema.nullish(),
            }),
          )
          .min(1)
          .max(50),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const scoped = scopedBranchOf(ctx);
      if (scoped != null && input.branchId !== scoped) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا صلاحية على فرع آخر" });
      }
      return withTx((tx) => intentService.prepare(tx, input, actorOf(ctx)));
    }),

  claimExecution: digitalCardsPosProcedure
    .input(
      z.object({
        intentId: z.number().int().positive(),
        intentItemId: z.number().int().positive(),
        claimToken: z.string().min(8).max(80),
      }),
    )
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => intentService.claimExecution(tx, input, actorOf(ctx))),
    ),

  markExecution: digitalCardsPosProcedure
    .input(
      z.object({
        intentId: z.number().int().positive(),
        intentItemId: z.number().int().positive(),
        claimToken: z.string().min(8).max(80),
        status: z.enum(["SUCCESS", "FAILED", "UNKNOWN"]),
        providerReference: z.string().max(120).nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => intentService.markExecution(tx, input, actorOf(ctx))),
    ),

  getIntent: digitalCardsPosProcedure
    .input(z.object({ intentId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      const res = await intentService.getIntent(requireDb(), input.intentId);
      if (!res) throw new TRPCError({ code: "NOT_FOUND", message: "النيّة غير موجودة" });
      const scoped = scopedBranchOf(ctx);
      if (scoped != null && Number(res.intent.branchId) !== scoped) {
        throw new TRPCError({ code: "FORBIDDEN", message: "النيّة تخصّ فرعاً آخر" });
      }
      return res;
    }),

  cancelIntent: digitalCardsPosProcedure
    .input(z.object({ intentId: z.number().int().positive(), reason: z.string().max(300).nullish() }))
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => intentService.cancelIntent(tx, input, actorOf(ctx))),
    ),

  /** طابور المراجعة — إشرافيّ: كروتٌ صدرت ولم تُثبَّت بفاتورة. */
  needsReview: digitalCardsAdminReadProcedure
    .input(z.object({ branchId: z.number().int().positive().optional() }).optional())
    .query(async ({ input, ctx }) => {
      const scoped = scopedBranchOf(ctx);
      return intentService.listNeedsReview(requireDb(), { branchId: scoped ?? input?.branchId ?? null });
    }),

  /** تفاصيل السبب وطلب المعالجة الآمن لعملية واحدة. */
  reviewDetails: digitalCardsAdminReadProcedure
    .input(z.object({ intentId: z.number().int().positive() }))
    .query(async ({ input, ctx }) =>
      reviewResolutionService.getReviewDetails(requireDb(), input.intentId, scopedBranchOf(ctx))),

  /** طلب قرار فقط؛ لا فاتورة ولا حركة رصيد حتى يعتمد مدير آخر. */
  requestReviewResolution: digitalCardsManagerProcedure
    .input(z.object({
      intentId: z.number().int().positive(),
      decision: z.enum(["CANCEL_NO_ISSUE", "FINALIZE_SALE", "WRITEOFF_LOSS"]),
      reason: z.string().min(5).max(500),
      items: z.array(z.object({
        intentItemId: z.number().int().positive(),
        outcome: z.enum(["ISSUED", "NOT_ISSUED"]),
        providerReference: z.string().max(120).nullish(),
      })).min(1).max(50),
    }))
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => reviewResolutionService.requestResolution(tx, input, actorOf(ctx)))),

  approveReviewResolution: digitalCardsManagerProcedure
    .input(z.object({ intentId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => reviewResolutionService.approveResolution(tx, input, actorOf(ctx)))),

  rejectReviewResolution: digitalCardsManagerProcedure
    .input(z.object({ intentId: z.number().int().positive(), reason: z.string().min(3).max(500) }))
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => reviewResolutionService.rejectResolution(tx, input, actorOf(ctx)))),

  /** كنّاس النيّات المهجورة — يُشغّله المدير يدوياً حتى تُجدوَل مهمّة دورية. */
  expireStale: digitalCardsManagerProcedure.mutation(async () =>
    withTx((tx) => intentService.expireStaleIntents(tx)),
  ),

  /* شطب النيّة العالقة (هجرة 0129): الطلب بلا أثرٍ ماليّ، وكلّ الأثر في الاعتماد
   * الذي يفرض SOD (طالب ≠ معتمِد). الثلاثة مديريّة. */
  requestWriteoff: digitalCardsManagerProcedure
    .input(z.object({ intentId: z.number().int().positive(), reason: z.string().min(3).max(300) }))
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => writeoffService.requestWriteoff(tx, input, actorOf(ctx))),
    ),

  approveWriteoff: digitalCardsManagerProcedure
    .input(z.object({ intentId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => writeoffService.approveWriteoff(tx, input, actorOf(ctx))),
    ),

  rejectWriteoff: digitalCardsManagerProcedure
    .input(z.object({ intentId: z.number().int().positive(), reason: z.string().max(300).nullish() }))
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => writeoffService.rejectWriteoff(tx, input, actorOf(ctx))),
    ),

  /** التثبيت المالي (ش٨): الفاتورة والقبض والتسوية والتفاصيل في معاملة واحدة — أو لا شيء. */
  finalize: digitalCardsPosProcedure
    .input(
      z.object({
        intentId: z.number().int().positive(),
        clientRequestId: z.string().min(8).max(80),
        paymentAmount: nonNegMoneyString,
        paymentMethod: z.enum(["CASH", "CARD"]),
        customerId: z.number().int().positive().nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => finalizeService.finalize(tx, input, actorOf(ctx))),
    ),

  /** Complete an all-success NEEDS_REVIEW intent from its locked snapshots. */
  recover: digitalCardsManagerProcedure
    .input(z.object({ intentId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => finalizeService.recoverNeedsReview(tx, input.intentId, actorOf(ctx))),
    ),

  saleDetails: digitalCardsAdminReadProcedure
    .input(z.object({ invoiceId: z.number().int().positive() }))
    .query(async ({ input, ctx }) =>
      finalizeService.getSaleDetails(requireDb(), input.invoiceId, scopedBranchOf(ctx))),

  /** إعادة طباعة (§١٢.١-٤): لقطات الكرت من الخادم — بلا حصة مزوّد ولا ربح، فالكاشير يراها. */
  printDetails: digitalCardsPosProcedure
    .input(z.object({ invoiceId: z.number().int().positive() }))
    .query(async ({ input, ctx }) =>
      finalizeService.reprintDetails(requireDb(), input.invoiceId, scopedBranchOf(ctx))),
});
