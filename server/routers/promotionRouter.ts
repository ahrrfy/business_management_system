/* ============================================================================
 * موجّه tRPC للترقيات وإنهاء الخدمات — وحدة الموارد البشرية (server/routers/promotionRouter.ts)
 * القراءة بصلاحية hr/READ والكتابة بـ hr/FULL (requireModule). كل كتابة تُدقَّق (logAudit).
 * يُركَّب من قِبل قائد التكامل تحت النطاق: trpc.promotions
 * ========================================================================== */
import { z } from "zod";
import { TERMINATION_TYPES } from "@shared/hr";
import { logAudit } from "../services/auditService";
import * as svc from "../services/promotionService";
import { protectedProcedure, requireModule, router } from "../trpc";

const hrRead = protectedProcedure.use(requireModule("hr", "READ"));
const hrWrite = protectedProcedure.use(requireModule("hr", "FULL"));

const moneyStrOpt = z.string().trim().regex(/^\d+(\.\d{1,2})?$/, "قيمة مالية غير صالحة").optional();
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح");

export const promotionRouter = router({
  /* ===== الترقيات ===== */
  listPromotions: hrRead.query(() => svc.listPromotions()),

  createPromotion: hrWrite
    .input(
      z.object({
        employeeId: z.number().int().positive(),
        toTitle: z.string().trim().min(1, "المسمّى الجديد مطلوب"),
        fromTitle: z.string().trim().optional(),
        fromSalary: moneyStrOpt,
        toSalary: moneyStrOpt,
        effectiveDate: dateStr,
        reason: z.string().trim().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const p = await svc.createPromotion(input as svc.PromotionInput);
      await logAudit(ctx, {
        action: "promotion.create",
        entityType: "employeePromotion",
        entityId: p?.id,
        newValue: { employeeId: input.employeeId, toTitle: input.toTitle, toSalary: input.toSalary ?? null },
      });
      return p;
    }),

  approvePromotion: hrWrite
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const id = await svc.approvePromotion(input.id, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, { action: "promotion.approve", entityType: "employeePromotion", entityId: id });
      return { id };
    }),

  /* ===== إنهاء الخدمات ===== */
  listTerminations: hrRead.query(() => svc.listTerminations()),

  createTermination: hrWrite
    .input(
      z.object({
        employeeId: z.number().int().positive(),
        terminationType: z.enum(TERMINATION_TYPES),
        lastDay: dateStr,
        settlement: moneyStrOpt,
        reason: z.string().trim().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const t = await svc.createTermination(input as svc.TerminationInput);
      await logAudit(ctx, {
        action: "termination.create",
        entityType: "employeeTermination",
        entityId: t?.id,
        newValue: { employeeId: input.employeeId, terminationType: input.terminationType, lastDay: input.lastDay },
      });
      return t;
    }),

  completeTermination: hrWrite
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const id = await svc.completeTermination(input.id, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, { action: "termination.complete", entityType: "employeeTermination", entityId: id });
      return { id };
    }),
});
