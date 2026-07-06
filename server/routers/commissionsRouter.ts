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
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { isDupEntry } from "@shared/errorMap.ar";
import { logAudit } from "../services/auditService";
import { computeCommissionRun } from "../services/commissions/engine";
import * as perfSvc from "../services/commissions/performance";
import * as plansSvc from "../services/commissions/plans";
import * as runsSvc from "../services/commissions/runs";
import * as targetsSvc from "../services/commissions/targets";
import { commissionsManagerProcedure, commissionsReadProcedure, protectedProcedure, reportViewerProcedure, router } from "../trpc";
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

const targetsRouter = router({
  /** شبكة أهداف الشهر: الموظفون المؤهَّلون + الهدف الحالي + فعليّ الشهر السابق. */
  grid: commissionsReadProcedure
    .input(z.object({ period }))
    .query(({ input }) => targetsSvc.getTargetsGrid(input.period)),

  saveAll: commissionsManagerProcedure
    .input(
      z.object({
        period,
        rows: z
          .array(z.object({ employeeId: z.number().int().positive(), target: moneyStr.nullable() }))
          .min(1)
          .max(500),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const res = await targetsSvc.saveTargets(input, actorOf(ctx));
      await logAudit(ctx, {
        action: "commissions.targetsSave",
        entityType: "salesTarget",
        entityId: input.period,
        newValue: { period: input.period, rows: input.rows.length, saved: res.saved, removed: res.removed },
      });
      return res;
    }),

  copyFromPrevious: commissionsManagerProcedure
    .input(z.object({ period, overwrite: z.boolean().default(false) }))
    .mutation(async ({ input, ctx }) => {
      const res = await targetsSvc.copyTargetsFromPrevious(input, actorOf(ctx));
      await logAudit(ctx, {
        action: "commissions.targetsCopy",
        entityType: "salesTarget",
        entityId: input.period,
        newValue: { period: input.period, overwrite: input.overwrite, copied: res.copied },
      });
      return res;
    }),
});

const runsRouter = router({
  list: commissionsReadProcedure.query(() => runsSvc.listRuns()),

  get: commissionsReadProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(({ input }) => runsSvc.getRun(input.id)),

  /** احتساب (أو إعادة احتساب مسودة) تشغيلة الشهر — ذرّي، بحارس تسلسل الأشهر. */
  compute: commissionsManagerProcedure.input(z.object({ period })).mutation(async ({ input, ctx }) => {
    try {
      const res = await computeCommissionRun(input.period, actorOf(ctx));
      await logAudit(ctx, {
        action: "commissions.runCompute",
        entityType: "commissionRun",
        entityId: res.runId,
        newValue: { period: res.period, employeeCount: res.employeeCount, totalCommission: res.totalCommission, recomputed: res.recomputed },
      });
      return res;
    } catch (err) {
      // uq_commission_period يحسم سباق إنشاء مزدوج — نعيده CONFLICT برسالة عربية.
      if (isDupEntry(err)) throw new TRPCError({ code: "CONFLICT", message: `توجد تشغيلة لشهر ${input.period} بالفعل — أعد المحاولة.` });
      throw err;
    }
  }),

  approve: commissionsManagerProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const res = await runsSvc.approveRun(input.id, actorOf(ctx));
      await logAudit(ctx, {
        action: "commissions.runApprove",
        entityType: "commissionRun",
        entityId: input.id,
        newValue: { period: res.period, approvedBy: ctx.user.id, requiresPayrollRegeneration: res.requiresPayrollRegeneration },
      });
      return res;
    }),

  unapprove: commissionsManagerProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const res = await runsSvc.unapproveRun(input.id, actorOf(ctx));
      await logAudit(ctx, { action: "commissions.runUnapprove", entityType: "commissionRun", entityId: input.id, newValue: { status: res.status } });
      return res;
    }),

  remove: commissionsManagerProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const res = await runsSvc.deleteDraft(input.id);
      await logAudit(ctx, { action: "commissions.runDelete", entityType: "commissionRun", entityId: input.id, newValue: { period: res.period } });
      return res;
    }),
});

const performanceRouter = router({
  /**
   * لوحة الإنجاز الحيّة — تقرير قراءة: بوّابة التقارير الموحّدة (manager/accountant/auditor
   * قالبياً + منح صريح) — ⚠ خط أحمر §٦: تبقى requireModuleGate بقائمة الأدوار، لا requireModule عارٍ.
   */
  leaderboard: reportViewerProcedure
    .input(z.object({ period }))
    .query(({ input }) => perfSvc.getLeaderboard(input.period)),

  /** «أدائي» — ذاتي بحت: الهوية من ctx.user.id حصراً، لا يقبل employeeId إطلاقاً. */
  myStatus: protectedProcedure
    .input(z.object({ period: period.optional() }).optional())
    .query(({ input, ctx }) => perfSvc.getMyStatus(ctx.user.id, input?.period)),
});

export const commissionsRouter = router({
  plans: plansRouter,
  targets: targetsRouter,
  runs: runsRouter,
  performance: performanceRouter,
});
