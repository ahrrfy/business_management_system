// شبكة بطاقات نقطة البيع (ش٥) — راوتر البطاقات الرقمية والاشتراكات.
// البوّابة الوحيدة المتاحة للكاشير على هذه الوحدة. المخرَج بلا تكلفة/هامش/رصيد —
// محجوبةٌ في طبقة الاستعلام نفسها (posCards.ts) لا في العرض.
import { z } from "zod";
import { posCardsService } from "../../services/digitalCards";
import { digitalCardsPosProcedure, router } from "../../trpc";
import { requireDb, scopedBranchOf } from "./shared";

export const posRouter = router({
  listCards: digitalCardsPosProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        category: z.enum(["FAVORITES", "TELECOM", "GLOBAL", "EDUCATIONAL", "ALL"]).optional(),
        providerId: z.number().int().positive().optional(),
        q: z.string().max(120).optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      // الفرع يُفرَض خادمياً: غير المرتفع يقرأ فرعه مهما أرسل (منع IDOR عبر branchId).
      const scoped = scopedBranchOf(ctx);
      return posCardsService.listCards(requireDb(), { ...input, branchId: scoped ?? input.branchId });
    }),

  /** تأكيد السعر قبل إضافة البطاقة للسلة — لا يُنشئ أثراً مالياً، فقط يُثبّت سعر الخادم. */
  confirmCard: digitalCardsPosProcedure
    .input(z.object({ branchId: z.number().int().positive(), offeringId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      const scoped = scopedBranchOf(ctx);
      return posCardsService.confirmCard(requireDb(), {
        branchId: scoped ?? input.branchId,
        offeringId: input.offeringId,
      });
    }),
});
