// راوتر بوابة العدّ الخارجية (العقد §٥ — يُركَّب كـ `count`).
//
// كل الإجراءات publicProcedure: الهوية ليست جلسة النظام بل كوكي `count_token`
// (JWT يُصدَر بعد PIN صحيح) أو مستخدم نظام مسجَّل بتكليف method=USER — تُحلّ في
// countPortalService.resolvePortalIdentity. الرسائل عربية مهذبة لعامل خارجي،
// وكل عدّ وتسليم يُسجَّل في auditLogs (user قد يكون null ⇒ countedByName في newValue).
//
// ملاحظة أمنية: rate-limit على `count.auth` يضيفه القائد في server/index.ts
// (بنمط auth.login) — انظر العقد §٧.

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getSessionCookieOptions } from "../cookies";
import { logAudit } from "../services/auditService";
import {
  authenticatePin,
  COUNT_COOKIE_NAME,
  COUNT_TOKEN_TTL_MS,
  finishAssignment,
  getPortalState,
  resolvePortalIdentity,
  submitCount,
} from "../services/countPortalService";
import { publicProcedure, router } from "../trpc";

/** رمز الجلسة من الرابط (مثل CNT-2026-0008) — يُطبَّع داخل الخدمة (trim/uppercase). */
const sessionCode = z
  .string()
  .trim()
  .min(4, "رمز الجلسة غير صالح")
  .max(40, "رمز الجلسة غير صالح")
  .regex(/^[A-Za-z0-9-]+$/, "رمز الجلسة غير صالح");

export const countPortalRouter = router({
  /**
   * دخول البوابة: PIN (٤ أرقام) ⇒ توكن JWT في كوكي count_token،
   * أو بلا PIN لمستخدم نظام مسجَّل له تكليف USER في الجلسة.
   */
  auth: publicProcedure
    .input(
      z.object({
        sessionCode,
        pin: z
          .string()
          .regex(/^\d{4}$/, "رمز الدخول مكوّن من 4 أرقام")
          .optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        const r = await authenticatePin(ctx.user, input);
        // وضع PIN فقط يُصدر توكناً — يوضع في كوكي بنفس خيارات كوكي الجلسة (httpOnly/strict/secure).
        if (r.token) {
          ctx.res.cookie(COUNT_COOKIE_NAME, r.token, {
            ...getSessionCookieOptions(ctx.req),
            maxAge: COUNT_TOKEN_TTL_MS,
          });
        }
        await logAudit(ctx, {
          action: "stocktake.portalAuth",
          entityType: "stocktake",
          entityId: r.session.id,
          newValue: {
            assignmentId: r.assignment.id,
            countedByName: r.assignment.name,
            zone: r.assignment.zone ?? null,
            mode: r.mode,
          },
        });
        return {
          ok: true as const,
          assignmentName: r.assignment.name,
          zone: r.assignment.zone,
          mode: r.mode,
        };
      } catch (e) {
        // فشل الدخول يُسجَّل للتدقيق — هجمات تخمين PIN/رموز الجلسات تُرى في السجل.
        if (e instanceof TRPCError) {
          await logAudit(ctx, {
            action: "stocktake.portalAuth.failed",
            entityType: "stocktake",
            entityId: null,
            newValue: { sessionCode: input.sessionCode, reason: e.code },
          });
        }
        throw e;
      }
    }),

  /**
   * حالة البوابة (جرد أعمى): أصنافي + أصناف الزملاء (للبحث/العدّ التحقّقي) +
   * مهام إعادة العدّ + التقدّم — بلا أرصدة دفترية ولا أسعار ولا كميات زملاء.
   */
  state: publicProcedure.input(z.object({ sessionCode })).query(async ({ input, ctx }) => {
    const identity = await resolvePortalIdentity(ctx, input.sessionCode);
    return getPortalState(identity);
  }),

  /** تسجيل عدّة (idempotent عبر clientRequestId — آمن لمزامنة طابور الأوفلاين). */
  submit: publicProcedure
    .input(
      z.object({
        sessionCode,
        variantId: z.number().int().positive(),
        // الكمية بالوحدة الأساس (التحويل من كرتون/درزن يتم في الواجهة قبل الإرسال).
        qty: z
          .number()
          .int("الكمية بالوحدة الأساس يجب أن تكون عدداً صحيحاً")
          .min(0, "الكمية لا تكون سالبة")
          .max(99_999_999, "الكمية أكبر من المعقول — راجع الإدخال"),
        unitBreakdown: z.string().max(500).optional(),
        clientRequestId: z.string().uuid(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const identity = await resolvePortalIdentity(ctx, input.sessionCode);
      const res = await submitCount(identity, {
        variantId: input.variantId,
        qty: input.qty,
        unitBreakdown: input.unitBreakdown ?? null,
        clientRequestId: input.clientRequestId,
      });
      // لا نكرّر سطر التدقيق عند إعادة مزامنة نفس العدّة (idempotent replay).
      if (!res.idempotent) {
        await logAudit(ctx, {
          action: "stocktake.count",
          entityType: "stocktake",
          entityId: identity.session.id,
          newValue: {
            variantId: input.variantId,
            qty: input.qty,
            kind: res.kind,
            verifyMatch: res.verifyMatch,
            countedByName: identity.countedByName,
            assignmentId: identity.assignment.id,
            clientRequestId: input.clientRequestId,
          },
        });
      }
      return res;
    }),

  /** تسليم العدّ: التكليف ⇒ SUBMITTED؛ آخر تكليف ⇒ الجلسة REVIEW آلياً. */
  finish: publicProcedure.input(z.object({ sessionCode })).mutation(async ({ input, ctx }) => {
    const identity = await resolvePortalIdentity(ctx, input.sessionCode);
    const res = await finishAssignment(identity);
    if (!res.alreadySubmitted) {
      await logAudit(ctx, {
        action: "stocktake.submitAssignment",
        entityType: "stocktake",
        entityId: identity.session.id,
        newValue: {
          assignmentId: identity.assignment.id,
          countedByName: identity.countedByName,
          zone: identity.assignment.zone ?? null,
          sessionMovedToReview: res.sessionMovedToReview,
        },
      });
    }
    return { ok: res.ok, sessionMovedToReview: res.sessionMovedToReview };
  }),

  /** خروج: مسح كوكي البوابة (لا يمسّ كوكي جلسة النظام). */
  logout: publicProcedure.mutation(async ({ ctx }) => {
    ctx.res.clearCookie(COUNT_COOKIE_NAME, { ...getSessionCookieOptions(ctx.req), maxAge: -1 });
    return { ok: true } as const;
  }),
});
