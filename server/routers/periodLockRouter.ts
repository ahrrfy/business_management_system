/**
 * راوتر إقفال الفترات المالية — عمليات حاكمة لا تنجح بلا سجل تدقيق ذري.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { verifyPassword } from "../auth/password";
import { logAuditTx } from "../services/auditService";
import { getActiveLock, lockPeriod, unlockLatestPeriod } from "../services/periodLockService";
import { withTx } from "../services/tx";
import { adminProcedure, router } from "../trpc";

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح (YYYY-MM-DD)");

export const periodLockRouter = router({
  status: adminProcedure.query(async () => {
    const lock = await withTx(async (tx) => getActiveLock(tx));
    return { lock };
  }),

  lock: adminProcedure
    .input(z.object({ cutoffDate: ymd, notes: z.string().max(255).optional() }))
    .mutation(async ({ input, ctx }) =>
      withTx(async (tx) => {
        const result = await lockPeriod(tx, {
          cutoffDate: input.cutoffDate,
          lockedBy: ctx.user.id,
          notes: input.notes ?? null,
        });
        await logAuditTx(tx, ctx, {
          action: "period.lock",
          entityType: "financialPeriod",
          entityId: result.id,
          newValue: { cutoffDate: input.cutoffDate, notes: input.notes ?? null },
        });
        return result;
      }),
    ),

  unlock: adminProcedure
    .input(z.object({
      reason: z.string().trim().min(10, "سبب فتح الفترة إلزامي (10 أحرف على الأقل)").max(500),
      password: z.string().min(1),
    }))
    .mutation(async ({ input, ctx }) => {
      if (!verifyPassword(input.password, ctx.user.passwordHash)) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "كلمة مرور المدير غير صحيحة" });
      }

      // فتح الفترة وتسجيل مَن فتحها ولماذا ينجحان أو يتراجعان معاً.
      return withTx(async (tx) => {
        const lock = await getActiveLock(tx);
        const result = await unlockLatestPeriod(tx);
        await logAuditTx(tx, ctx, {
          action: "period.unlock",
          entityType: "financialPeriod",
          entityId: lock?.id,
          oldValue: lock
            ? {
                cutoffDate: lock.cutoffDate,
                notes: lock.notes ?? null,
                lockedBy: lock.lockedBy,
                lockedAt: lock.lockedAt,
              }
            : null,
          newValue: { unlocked: result.unlocked, reason: input.reason },
        });
        return result;
      });
    }),
});
