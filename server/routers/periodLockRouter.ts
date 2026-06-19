/**
 * راوتر إقفال الفترات المالية — adminProcedure (تأثير مالي حاكم على كل القيود).
 *
 * lock(cutoffDate, notes?) ⇒ يمنع كتابة قيود ≤ cutoffDate.
 * unlock() ⇒ يفتح أحدث قفل (admin فقط — لتصحيح خطأ).
 * status() ⇒ يعرض الـlock النشِط حالياً.
 */
import { z } from "zod";
import { adminProcedure, router } from "../trpc";
import { withTx } from "../services/tx";
import { getActiveLock, lockPeriod, unlockLatestPeriod } from "../services/periodLockService";
import { logAudit } from "../services/auditService";

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح (YYYY-MM-DD)");

export const periodLockRouter = router({
  status: adminProcedure.query(async () => {
    const lock = await withTx(async (tx) => getActiveLock(tx));
    return { lock };
  }),

  lock: adminProcedure
    .input(z.object({ cutoffDate: ymd, notes: z.string().max(255).optional() }))
    .mutation(async ({ input, ctx }) => {
      const r = await withTx(async (tx) =>
        lockPeriod(tx, { cutoffDate: input.cutoffDate, lockedBy: ctx.user.id, notes: input.notes ?? null }),
      );
      await logAudit(ctx, {
        action: "period.lock",
        entityType: "financialPeriod",
        entityId: r.id,
        newValue: { cutoffDate: input.cutoffDate, notes: input.notes ?? null },
      });
      return r;
    }),

  unlock: adminProcedure.mutation(async ({ ctx }) => {
    const r = await withTx(async (tx) => unlockLatestPeriod(tx));
    await logAudit(ctx, {
      action: "period.unlock",
      entityType: "financialPeriod",
      newValue: { unlocked: r.unlocked },
    });
    return r;
  }),
});
