// عقود الاشتراكات (تتبّع الاشتراكات التعليمية) — راوتر البطاقات الرقمية والاشتراكات.
import { z } from "zod";
import { subscriptionService } from "../../services/digitalCards";
import { digitalCardsAdminReadProcedure, router } from "../../trpc";
import { requireDb, scopedBranchOf } from "./shared";

/** طيّ تطبيع عربي بسيط للبحث المحلي — `studentNameSnapshot` بلا عمود searchNorm مخزَّن،
 *  فالبحث هنا post-filter داخل الراوتر لا استعلاماً؛ يكفي إزالة التشكيل وتوحيد الألف/التاء
 *  المربوطة (لا حاجة لطيّ الأرقام الهندية — اسم طالب لا رقماً). */
function normalizeArName(s: string): string {
  return s
    .replace(/[ً-ٰٟ]/g, "")
    .replace(/[إأآا]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .toLowerCase()
    .trim();
}

/** نافذة «تنتهي قريباً» — أسبوعٌ من الآن (§الاشتراكات، لا سياسة مالك موثَّقة تفرض قيمة أخرى). */
const EXPIRING_SOON_MS = 7 * 24 * 60 * 60 * 1000;

export const subscriptionsRouter = router({
  list: digitalCardsAdminReadProcedure
    .input(
      z
        .object({
          branchId: z.number().int().positive().optional(),
          activeOnly: z.boolean().optional(),
          /** بحث باسم الطالب — post-filter محلّي (انظر normalizeArName أعلاه). */
          q: z.string().max(120).optional(),
          /** تنتهي خلال أسبوع ولم تُلغَ ولم تنتهِ فعلاً بعد. */
          expiring: z.boolean().optional(),
          /** الحالة المحسوبة الكاملة (وليس activeOnly الثنائي فقط) — تتجاوزه إن مُرِّرت معاً. */
          status: z.enum(["ACTIVE", "EXPIRED", "CANCELLED"]).optional(),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      const rows = await subscriptionService.listContracts(requireDb(), {
        branchId: scopedBranchOf(ctx) ?? input?.branchId ?? null,
        activeOnly: input?.activeOnly,
      });
      const q = input?.q?.trim() ? normalizeArName(input.q) : null;
      const now = Date.now();
      return rows.filter((r) => {
        if (q && !normalizeArName(r.studentName).includes(q)) return false;
        if (input?.status && r.status !== input.status) return false;
        if (input?.expiring) {
          const msLeft = r.expiresAt.getTime() - now;
          if (r.status !== "ACTIVE" || msLeft < 0 || msLeft > EXPIRING_SOON_MS) return false;
        }
        return true;
      });
    }),
});
