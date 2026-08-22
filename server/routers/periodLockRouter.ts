/**
 * راوتر إقفال الفترات المالية — عمليات حاكمة لا تنجح بلا سجل تدقيق ذري.
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { auditLogs, users } from "../../drizzle/schema";
import { verifyPassword } from "../auth/password";
import { retryOnDeadlock } from "../lib/retryDeadlock";
import { logAuditTx } from "../services/auditService";
import {
  getActiveLock,
  unlockLatestPeriod,
} from "../services/periodLockService";
import {
  approveMonthClose,
  getCompanyCloseActionReadiness,
  listMonthCloseRequests,
  rejectMonthClose,
  requestMonthClose,
} from "../services/reports/monthCloseRequest";
import {
  certificateExportRows,
  getMonthCloseCertificate,
  listMonthCloseCertificates,
  verifyMonthCloseCertificate,
} from "../services/reports/monthCloseCertificate";
import {
  bootstrapMonthCloseSequence,
  getMonthCloseSequence,
  listSequenceEvents,
} from "../services/reports/monthCloseSequence";
import { withGovernanceTx, withTx } from "../services/tx";
import {
  adminProcedure,
  ownerProcedure,
  reportsAdminProcedure,
  reportsManagerProcedure,
  router,
} from "../trpc";

// أفعال إقفال/فتح الفترة كما تُسجَّل في logAuditTx أدناه (period.lock/period.unlock) — نفس القيم حرفياً.
const PERIOD_LOCK_ACTIONS = ["period.lock", "period.unlock"] as const;

export const periodLockRouter = router({
  status: adminProcedure.query(async () => {
    return withTx(async (tx) => ({
      lock: await getActiveLock(tx),
      sequence: await getMonthCloseSequence(tx),
    }));
  }),

  bootstrapSequence: ownerProcedure
    .input(
      z.discriminatedUnion("mode", [
        z.object({
          mode: z.literal("START_FRESH"),
          firstCloseMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
          reason: z.string().trim().min(10).max(500),
          reference: z.string().trim().min(3).max(255),
        }),
        z.object({
          mode: z.literal("ACKNOWLEDGE_LEGACY_LOCK"),
          expectedPeriodId: z.number().int().positive(),
          reason: z.string().trim().min(10).max(500),
          reference: z.string().trim().min(3).max(255),
        }),
      ]),
    )
    .mutation(async ({ input, ctx }) =>
      retryOnDeadlock(() =>
        withGovernanceTx(async (tx) => {
          const sequence = await bootstrapMonthCloseSequence(tx, {
            ...input,
            actorId: ctx.user.id,
          });
          await logAuditTx(tx, ctx, {
            action: "period.sequence_bootstrap",
            entityType: "monthCloseSequence",
            entityId: 1,
            newValue: {
              mode: input.mode,
              sequenceStartMonth: sequence.sequenceStartMonth,
              activeThroughMonth: sequence.activeThroughMonth,
              nextRequiredMonth: sequence.nextRequiredMonth,
              reference: input.reference,
              certificationClaim: "NONE",
            },
          });
          return sequence;
        }),
      ),
    ),

  sequenceEvents: reportsAdminProcedure
    .input(
      z
        .object({ limit: z.number().int().min(1).max(200).default(100) })
        .optional(),
    )
    .query(({ input }) =>
      withTx((tx) => listSequenceEvents(tx, input?.limit ?? 100)),
    ),

  certificates: reportsAdminProcedure
    .input(
      z
        .object({
          month: z
            .string()
            .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
            .optional(),
          beforeId: z.number().int().positive().optional(),
          limit: z.number().int().min(1).max(100).optional(),
        })
        .optional(),
    )
    .query(({ input }) =>
      withTx((tx) => listMonthCloseCertificates(tx, input ?? {})),
    ),

  certificate: reportsAdminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(({ input }) =>
      withTx((tx) => getMonthCloseCertificate(tx, input.id)),
    ),

  verifyCertificate: reportsAdminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(({ input }) =>
      withTx((tx) => verifyMonthCloseCertificate(tx, input.id)),
    ),

  exportCertificate: reportsAdminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(({ input }) =>
      withTx(async (tx) => {
        const { row, evidence } = await getMonthCloseCertificate(tx, input.id);
        const verification = await verifyMonthCloseCertificate(tx, input.id);
        return {
          fileName: `${row.certificateNumber}.csv`,
          rows: certificateExportRows(row, evidence, verification),
        };
      }),
    ),

  /**
   * سجل عمليات القفل/الفتح السابقة — من auditLogs (entityType=financialPeriod)، لا جدول مخصّص.
   * القفل يخزّن cutoffDate/notes في newValue، والفتح يخزّنهما في oldValue (حالة القفل المفتوح) + reason في newValue.
   */
  history: adminProcedure
    .input(
      z
        .object({ limit: z.number().int().positive().max(100).default(50) })
        .optional(),
    )
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
          .where(
            and(
              eq(auditLogs.entityType, "financialPeriod"),
              inArray(auditLogs.action, PERIOD_LOCK_ACTIONS),
            ),
          )
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
            reason: !isLock
              ? ((nv.reason as string | undefined) ?? null)
              : null,
          };
        }),
      };
    }),

  unlock: adminProcedure
    .input(
      z.object({
        expectedPeriodId: z.number().int().positive(),
        reason: z
          .string()
          .trim()
          .min(10, "سبب فتح الفترة إلزامي (10 أحرف على الأقل)")
          .max(500),
        password: z.string().min(1),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      if (!(await verifyPassword(input.password, ctx.user.passwordHash))) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "كلمة مرور المدير غير صحيحة",
        });
      }

      // فتح الفترة وتسجيل مَن فتحها ولماذا ينجحان أو يتراجعان معاً.
      return retryOnDeadlock(() =>
        withGovernanceTx(async (tx) => {
          const lock = await getActiveLock(tx);
          const result = await unlockLatestPeriod(tx, {
            expectedPeriodId: input.expectedPeriodId,
            actorId: ctx.user.id,
            reason: input.reason,
          });
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
        }),
      );
    }),

  // ── ش٥ب: طلب إقفال الشهر واعتماده (Maker-Checker) ────────────────────────────────────────
  // قرار المالك (١١/٨): المدير يطلُب، والأدمن/المالك يُقفل، ولا تجاوز للحاجز إطلاقاً.
  // لماذا هنا لا في reportsRouter: هذا الملف يملك قفل الفترة أصلاً (lock/unlock) — تماسكٌ لا تشتّت.

  /** طابور الطلبات. مديرٌ فأعلى (الطالب يتابع طلبه، والأدمن يعتمد). */
  closeRequests: reportsManagerProcedure
    .input(z.object({ pendingOnly: z.boolean().optional() }).optional())
    .query(async ({ input }) =>
      withTx(async (tx) =>
        listMonthCloseRequests(tx, { pendingOnly: input?.pendingOnly }),
      ),
    ),

  /**
   * حقيقة زرّ الإقفال على مستوى الشركة. لا يعيد تفاصيل فروعٍ أخرى إلى مدير الفرع؛ التفاصيل
   * تبقى في تقرير الجاهزية المعزول بالفرع، أمّا الفعل العام فيحتاج فقط قرار blocked الحاكم.
   */
  closeActionReadiness: reportsManagerProcedure
    .input(
      z.object({
        month: z
          .string()
          .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "صيغة الشهر YYYY-MM"),
      }),
    )
    .query(async ({ input }) =>
      withTx((tx) => getCompanyCloseActionReadiness(tx, input.month)),
    ),

  /** المدير يطلُب إقفال شهر. الجاهزية تُفحَص **خادمياً لكل الفروع** — لا يُصدَّق ادّعاء الواجهة. */
  requestClose: reportsManagerProcedure
    .input(
      z.object({
        month: z
          .string()
          .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "صيغة الشهر YYYY-MM"),
      }),
    )
    .mutation(async ({ input, ctx }) =>
      retryOnDeadlock(() =>
        withGovernanceTx(async (tx) => {
          const result = await requestMonthClose(tx, {
            month: input.month,
            requestedBy: ctx.user.id,
          });
          await logAuditTx(tx, ctx, {
            action: "period.close_request",
            entityType: "monthCloseRequest",
            entityId: result.id,
            newValue: { month: input.month },
          });
          return result;
        }),
      ),
    ),

  /** الأدمن/المالك يعتمد فيُقفل الفترة. الفحص يُعاد **حيّاً**، والطالب ≠ المعتمِد (فصل مهام). */
  approveClose: reportsAdminProcedure
    .input(
      z.object({
        requestId: z.number().int().positive(),
        notes: z.string().max(255).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) =>
      retryOnDeadlock(() =>
        withGovernanceTx(async (tx) => {
          const result = await approveMonthClose(tx, {
            requestId: input.requestId,
            decidedBy: ctx.user.id,
            notes: input.notes ?? null,
          });
          await logAuditTx(tx, ctx, {
            action: "period.close_approve",
            entityType: "monthCloseRequest",
            entityId: input.requestId,
            newValue: {
              month: result.month,
              revision: result.revision,
              periodId: result.periodId,
              certificateId: result.certificateId,
              certificateNumber: result.certificateNumber,
            },
          });
          // يحافظ سجلّ شاشة الفترات على حدث القفل نفسه بعد إلغاء مسار lock المباشر.
          await logAuditTx(tx, ctx, {
            action: "period.lock",
            entityType: "financialPeriod",
            entityId: result.periodId,
            newValue: {
              cutoffDate: result.cutoffDate,
              notes:
                input.notes ??
                `إقفال شهر ${result.month} — اعتماد الطلب #${input.requestId}`,
            },
          });
          return result;
        }),
      ),
    ),

  /** رفض الطلب بسببٍ مكتوب — يحرّر الشهر لطلبٍ جديد. */
  rejectClose: reportsAdminProcedure
    .input(
      z.object({
        requestId: z.number().int().positive(),
        reason: z.string().trim().min(5).max(500),
      }),
    )
    .mutation(async ({ input, ctx }) =>
      retryOnDeadlock(() =>
        withGovernanceTx(async (tx) => {
          await rejectMonthClose(tx, {
            requestId: input.requestId,
            decidedBy: ctx.user.id,
            reason: input.reason,
          });
          await logAuditTx(tx, ctx, {
            action: "period.close_reject",
            entityType: "monthCloseRequest",
            entityId: input.requestId,
            newValue: { reason: input.reason },
          });
          return { ok: true as const };
        }),
      ),
    ),
});
