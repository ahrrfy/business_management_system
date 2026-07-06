/* ============================================================================
 * موجّه tRPC لوحدة «الأهداف والعمولات» (server/routers/commissionsRouter.ts)
 *
 * البوّابات (server/trpc.ts):
 *  - الكتابة: commissionsManagerProcedure — بوّابة موحّدة (manager قالبياً + منح صريح
 *    commissions=FULL) مع إلزام فرع لغير admin/manager.
 *  - القراءة: commissionsReadProcedure — بالخريطة المحلولة (accountant/auditor قالباهما READ).
 *  - «أدائي» الذاتي (يُضاف في شريحة لاحقة): protectedProcedure بهوية ctx.user حصراً.
 *
 * كل كتابة تُدقَّق عبر logAudit. يُركَّب من قائد التكامل تحت namespace: trpc.commissions
 * ========================================================================== */
import { z } from "zod";
import { logAudit } from "../services/auditService";
import * as plansSvc from "../services/commissions/plans";
import { commissionsManagerProcedure, commissionsReadProcedure, router } from "../trpc";
import type { TrpcContext } from "../context";

const moneyStr = z.string().trim().regex(/^\d+(\.\d{1,2})?$/, "قيمة مالية غير صالحة");
const ratePctStr = z.string().trim().regex(/^\d+(\.\d{1,4})?$/, "نسبة غير صالحة (حتى ٤ منازل عشرية)");
const period = z.string().trim().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "الشهر يجب أن يكون بصيغة YYYY-MM");

const tierInput = z.object({
  threshold: moneyStr,
  ratePct: ratePctStr,
  fixedBonus: moneyStr,
});

const tierModeEnum = z.enum(["TARGET_PCT", "AMOUNT_SLAB"]);

const planPayload = z.object({
  name: z.string().trim().min(1, "اسم الخطة مطلوب").max(120),
  tierMode: tierModeEnum,
  tiers: z.array(tierInput).min(1, "شريحة واحدة على الأقل").max(12),
  notes: z.string().trim().max(255).nullish(),
});

function actorOf(ctx: { user: NonNullable<TrpcContext["user"]> }) {
  return { userId: ctx.user.id, branchId: ctx.user.branchId ?? 0, role: ctx.user.role };
}

const plansRouter = router({
  list: commissionsReadProcedure.query(() => plansSvc.listPlans()),

  /** لوحة الإسناد: الموظفون المؤهَّلون (مرتبطون بمستخدم، غير منتهي الخدمة) + إسنادهم المفتوح. */
  assignmentBoard: commissionsReadProcedure.query(() => plansSvc.listAssignmentBoard()),

  create: commissionsManagerProcedure.input(planPayload).mutation(async ({ input, ctx }) => {
    const res = await plansSvc.createPlan(
      { name: input.name, tierMode: input.tierMode, tiers: input.tiers, notes: input.notes ?? null },
      actorOf(ctx),
    );
    await logAudit(ctx, {
      action: "commissions.planCreate",
      entityType: "commissionPlan",
      entityId: res.planId,
      newValue: { name: input.name, tierMode: input.tierMode, tiers: input.tiers },
    });
    return res;
  }),

  update: commissionsManagerProcedure
    .input(planPayload.extend({ planId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const res = await plansSvc.updatePlan(
        { planId: input.planId, name: input.name, tierMode: input.tierMode, tiers: input.tiers, notes: input.notes ?? null },
        actorOf(ctx),
      );
      await logAudit(ctx, {
        action: "commissions.planUpdate",
        entityType: "commissionPlan",
        entityId: input.planId,
        newValue: { name: input.name, tierMode: input.tierMode, tiers: input.tiers },
      });
      return res;
    }),

  setActive: commissionsManagerProcedure
    .input(z.object({ planId: z.number().int().positive(), isActive: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      await plansSvc.setPlanActive(input.planId, input.isActive);
      await logAudit(ctx, {
        action: "commissions.planSetActive",
        entityType: "commissionPlan",
        entityId: input.planId,
        newValue: { isActive: input.isActive },
      });
      return { ok: true };
    }),

  assign: commissionsManagerProcedure
    .input(z.object({ employeeId: z.number().int().positive(), planId: z.number().int().positive(), effectiveFrom: period }))
    .mutation(async ({ input, ctx }) => {
      const res = await plansSvc.assignPlan(input, actorOf(ctx));
      await logAudit(ctx, {
        action: "commissions.assign",
        entityType: "commissionAssignment",
        entityId: res.assignmentId,
        newValue: { ...input, closedPrevious: res.closedPrevious },
      });
      return res;
    }),

  endAssignment: commissionsManagerProcedure
    .input(z.object({ assignmentId: z.number().int().positive(), effectiveTo: period }))
    .mutation(async ({ input, ctx }) => {
      await plansSvc.endAssignment(input);
      await logAudit(ctx, {
        action: "commissions.endAssignment",
        entityType: "commissionAssignment",
        entityId: input.assignmentId,
        newValue: { effectiveTo: input.effectiveTo },
      });
      return { ok: true };
    }),
});

export const commissionsRouter = router({
  plans: plansRouter,
});
