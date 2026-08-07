// سجل مبيعات الاشتراكات التعليمية — لا يتتبّع المدة أو الانتهاء؛ تلك مسؤولية المنصة التعليمية.
import { z } from "zod";
import { subscriptionService } from "../../services/digitalCards";
import { digitalCardsAdminReadProcedure, router } from "../../trpc";
import { requireDb, scopedBranchOf } from "./shared";

/** تطبيع عربي بسيط للبحث المحلي بالاسم أو الهاتف أو رقم الاشتراك. */
function normalizeArName(s: string): string {
  return s
    .replace(/[ً-ٰٟ]/g, "")
    .replace(/[إأآا]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .toLowerCase()
    .trim();
}

export const subscriptionsRouter = router({
  list: digitalCardsAdminReadProcedure
    .input(
      z
        .object({
          branchId: z.number().int().positive().optional(),
          /** بحث باسم الطالب أو رقم الاشتراك أو الهاتف. */
          q: z.string().max(120).optional(),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      const rows = await subscriptionService.listSubscriptionSales(requireDb(), {
        branchId: scopedBranchOf(ctx) ?? input?.branchId ?? null,
      });
      const q = input?.q?.trim() ? normalizeArName(input.q) : null;
      return rows.filter((r) => {
        if (!q) return true;
        return normalizeArName(r.studentName ?? "").includes(q)
          || normalizeArName(r.providerReference ?? "").includes(q)
          || normalizeArName(r.studentPhone ?? "").includes(q);
      });
    }),
});
