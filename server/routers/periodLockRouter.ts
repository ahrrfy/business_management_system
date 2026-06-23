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
    // M (تدقيق ٢٣/٦/٢٦): فتح الفترة المالية المغلقة كان يُسجَّل «unlocked: true» فقط —
    // بلا cutoffDate ولا entityId. القيد المالي بعد الفتح يَدخل بفترة كانت مقفلة، والمراجع
    // اللاحق لا يَستطيع معرفة أيّ تاريخ فُتِح. الآن: نَلتقط lock.cutoffDate + entityId قبل
    // الفتح ⇒ سجلٌّ كاشف يَربط الفتح بتاريخ القفل المُلغى.
    const { lock, result } = await withTx(async (tx) => {
      const lock = await getActiveLock(tx);
      const result = await unlockLatestPeriod(tx);
      return { lock, result };
    });
    await logAudit(ctx, {
      action: "period.unlock",
      entityType: "financialPeriod",
      oldValue: lock
        ? { cutoffDate: lock.cutoffDate, notes: lock.notes ?? null, lockedBy: lock.lockedBy, lockedAt: lock.lockedAt }
        : null,
      newValue: { unlocked: result.unlocked },
    });
    return result;
  }),
});
