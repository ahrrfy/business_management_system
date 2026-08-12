/**
 * راوتر إقفال الفترات المالية — عمليات حاكمة لا تنجح بلا سجل تدقيق ذري.
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { auditLogs, users } from "../../drizzle/schema";
import { verifyPassword } from "../auth/password";
import { logAuditTx } from "../services/auditService";
import { getActiveLock, lockPeriod, unlockLatestPeriod } from "../services/periodLockService";
import { withTx } from "../services/tx";
import { adminProcedure, router } from "../trpc";

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح (YYYY-MM-DD)");

// أفعال إقفال/فتح الفترة كما تُسجَّل في logAuditTx أدناه (period.lock/period.unlock) — نفس القيم حرفياً.
const PERIOD_LOCK_ACTIONS = ["period.lock", "period.unlock"] as const;

export const periodLockRouter = router({
  status: adminProcedure.query(async () => {
    const lock = await withTx(async (tx) => getActiveLock(tx));
    return { lock };
  }),

  /**
   * سجل عمليات القفل/الفتح السابقة — من auditLogs (entityType=financialPeriod)، لا جدول مخصّص.
   * القفل يخزّن cutoffDate/notes في newValue، والفتح يخزّنهما في oldValue (حالة القفل المفتوح) + reason في newValue.
   */
  history: adminProcedure
    .input(z.object({ limit: z.number().int().positive().max(100).default(50) }).optional())
    .query(async ({ input }) => {
      const limit = input?.limit ?? 50;
      const rows = await withTx(async (tx) =>
        tx
          .select({
            id: auditLogs.id,
            action: auditLogs.action,
            userName: users.name,
            oldValue: auditLogs.oldValue,
            newValue: auditLogs.newValue,
            createdAt: auditLogs.createdAt,
          })
          .from(auditLogs)
          .leftJoin(users, eq(auditLogs.userId, users.id))
          .where(and(eq(auditLogs.entityType, "financialPeriod"), inArray(auditLogs.action, PERIOD_LOCK_ACTIONS)))
          .orderBy(desc(auditLogs.createdAt))
          .limit(limit),
      );
      return {
        rows: rows.map((r) => {
          const isLock = r.action === "period.lock";
          const nv = (r.newValue ?? {}) as Record<string, unknown>;
          const ov = (r.oldValue ?? {}) as Record<string, unknown>;
          const src = isLock ? nv : ov;
          return {
            id: Number(r.id),
            action: r.action as "period.lock" | "period.unlock",
            userName: r.userName ?? "—",
            createdAt: r.createdAt,
            cutoffDate: (src.cutoffDate as string | undefined) ?? null,
            notes: (src.notes as string | undefined) ?? null,
            reason: !isLock ? ((nv.reason as string | undefined) ?? null) : null,
          };
        }),
      };
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
