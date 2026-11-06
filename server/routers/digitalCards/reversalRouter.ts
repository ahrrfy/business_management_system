import { routeOperationAuthority } from "../../services/authorization/operationAuthority";
// العكس والاستثناءات (ش١٢) — راوتر البطاقات الرقمية والاشتراكات.
// المسار الوحيد لإرجاع كرتٍ رقميّ — المرتجع العام يرفضه (حارس في returnService).
// قرارٌ مديريّ بحالتين: عكسٌ مؤكَّد (المزوّد أعاد الحصة) أو ردّ خسارة (لم يُعِدها).
import { z } from "zod";
import { reversalService } from "../../services/digitalCards";
import { withTx } from "../../services/tx";
import { digitalCardsAdminReadProcedure, digitalCardsManagerProcedure, router } from "../../trpc";
import { actorOf, digitalRefundActionFields, digitalRefundControl, digitalRefundTender, requireDb, scopedBranchOf } from "./shared";

export const reversalRouter = router({
  reversible: digitalCardsAdminReadProcedure
    .input(z.object({ invoiceId: z.number().int().positive(), detailIds: z.array(z.number().int().positive()).min(1).max(50).optional(),
      kind: z.enum(["REVERSED", "LOSS_REFUND"]).default("REVERSED") }))
    .query(async ({ input, ctx }) =>
      reversalService.reversibleDetails(requireDb(), input.invoiceId, scopedBranchOf(ctx), input.detailIds ? { detailIds: input.detailIds, kind: input.kind, actor: actorOf(ctx) } : undefined)),

  approve: digitalCardsManagerProcedure
    .input(
      z.object({
        invoiceId: z.number().int().positive(),
        detailIds: z.array(z.number().int().positive()).min(1).max(50),
        reason: z.string().min(3).max(300),
        ...digitalRefundActionFields,
      }),
    )
    .mutation(async ({ input, ctx }) => withTx(async (tx) => {
      const actor = { ...actorOf(ctx), operationAuthority: routeOperationAuthority(ctx.user, "digitalCards.reversal.approve") };
      if (input.stage !== "EXECUTE") return { stage: input.stage, ...await reversalService.controlRefund(tx, input, digitalRefundControl(input), "REVERSED", actor) };
      return { stage: "EXECUTE" as const, ...await reversalService.approveReversal(tx, { ...input, refund: digitalRefundTender(input.refund) }, actor) };
    })),

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
      withTx((tx) => reversalService.requestLossRefund(tx, input, { ...actorOf(ctx), operationAuthority: routeOperationAuthority(ctx.user, "digitalCards.reversal.requestLossRefund") })),
    ),

  lossRefund: digitalCardsManagerProcedure
    .input(
      z.object({
        invoiceId: z.number().int().positive(),
        detailIds: z.array(z.number().int().positive()).min(1).max(50),
        ...digitalRefundActionFields,
      }),
    )
    .mutation(async ({ input, ctx }) => withTx(async (tx) => {
      const actor = { ...actorOf(ctx), operationAuthority: routeOperationAuthority(ctx.user, "digitalCards.reversal.lossRefund") };
      if (input.stage !== "EXECUTE") return { stage: input.stage, ...await reversalService.controlRefund(tx, input, digitalRefundControl(input), "LOSS_REFUND", actor) };
      return { stage: "EXECUTE" as const, ...await reversalService.lossRefund(tx, { ...input, refund: digitalRefundTender(input.refund) }, actor) };
    })),

  rejectLossRefund: digitalCardsManagerProcedure
    .input(
      z.object({
        invoiceId: z.number().int().positive(),
        detailIds: z.array(z.number().int().positive()).min(1).max(50),
        reason: z.string().max(300).nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => reversalService.rejectLossRefund(tx, input, { ...actorOf(ctx), operationAuthority: routeOperationAuthority(ctx.user, "digitalCards.reversal.rejectLossRefund") })),
    ),
});
