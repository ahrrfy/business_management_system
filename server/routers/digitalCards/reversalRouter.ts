// العكس والاستثناءات (ش١٢) — راوتر البطاقات الرقمية والاشتراكات.
// المسار الوحيد لإرجاع كرتٍ رقميّ — المرتجع العام يرفضه (حارس في returnService).
// قرارٌ مديريّ بحالتين: عكسٌ مؤكَّد (المزوّد أعاد الحصة) أو ردّ خسارة (لم يُعِدها).
import { z } from "zod";
import { reversalService } from "../../services/digitalCards";
import { withTx } from "../../services/tx";
import { digitalCardsAdminReadProcedure, digitalCardsManagerProcedure, router } from "../../trpc";
import { actorOf, requireDb, scopedBranchOf } from "./shared";

export const reversalRouter = router({
  reversible: digitalCardsAdminReadProcedure
    .input(z.object({ invoiceId: z.number().int().positive() }))
    .query(async ({ input, ctx }) =>
      reversalService.reversibleDetails(requireDb(), input.invoiceId, scopedBranchOf(ctx))),

  approve: digitalCardsManagerProcedure
    .input(
      z.object({
        invoiceId: z.number().int().positive(),
        detailIds: z.array(z.number().int().positive()).min(1).max(50),
        reason: z.string().min(3).max(300),
      }),
    )
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => reversalService.approveReversal(tx, input, actorOf(ctx))),
    ),

  /* ردّ الخسارة باعتمادٍ ثانٍ (قرار المالك ٣٠/٧): الطلب بلا أثرٍ ماليّ، وكلّ الأثر في
   * الاعتماد الذي يفرض SOD. العكس المؤكَّد يبقى فعلاً واحداً — صافيه صفر ولا خسارة فيه. */
  requestLossRefund: digitalCardsManagerProcedure
    .input(
      z.object({
        invoiceId: z.number().int().positive(),
        detailIds: z.array(z.number().int().positive()).min(1).max(50),
        reason: z.string().min(3).max(300),
      }),
    )
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => reversalService.requestLossRefund(tx, input, actorOf(ctx))),
    ),

  lossRefund: digitalCardsManagerProcedure
    .input(
      z.object({
        invoiceId: z.number().int().positive(),
        detailIds: z.array(z.number().int().positive()).min(1).max(50),
      }),
    )
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => reversalService.lossRefund(tx, input, actorOf(ctx))),
    ),

  rejectLossRefund: digitalCardsManagerProcedure
    .input(
      z.object({
        invoiceId: z.number().int().positive(),
        detailIds: z.array(z.number().int().positive()).min(1).max(50),
        reason: z.string().max(300).nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => reversalService.rejectLossRefund(tx, input, actorOf(ctx))),
    ),
});
