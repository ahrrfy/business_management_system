/* ============================================================================
 * موجّه tRPC للترقيات وإنهاء الخدمات — وحدة الموارد البشرية (server/routers/promotionRouter.ts)
 * القراءة بصلاحية hr/READ والكتابة بـ hr/FULL (requireModule). كل كتابة تُدقَّق (logAudit).
 * يُركَّب من قِبل قائد التكامل تحت النطاق: trpc.promotions
 * ========================================================================== */
import { z } from "zod";
import { PAY_TYPE_KEYS, TERMINATION_TYPES } from "@shared/hr";
import { logAudit } from "../services/auditService";
import * as svc from "../services/promotionService";
import { protectedProcedure, requireModule, router } from "../trpc";

const hrRead = protectedProcedure.use(requireModule("hr", "READ"));
const hrWrite = protectedProcedure.use(requireModule("hr", "FULL"));

const moneyStrOpt = z.string().trim().regex(/^\d+(\.\d{1,2})?$/, "قيمة مالية غير صالحة").optional();
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح");

/**
 * حزمة الأجر (0143) — نفس مخطّط حقول الأجر في `employeeRouter` حرفياً: الترقية هي
 * المسار المزدوج الاعتماد لتغييرها بعد أن صار الحارس في `updateEmployee` يشمل البصمة
 * الأجرية كاملةً (جدول الدوام وأسعار الأيام والإعفاء)، لا الراتب وحده.
 */
const wagePatch = z.object({
  payType: z.enum(PAY_TYPE_KEYS).optional(),
  salary: moneyStrOpt.nullish(),
  allowances: moneyStrOpt.nullish(),
  attendanceExempt: z.boolean().optional(),
  dayRates: z.record(z.string(), z.number()).nullish(),
  workSchedule: z
    .record(z.string(), z.object({ hours: z.number().min(0).max(24), rate: z.number().min(0).nullish() }))
    .nullish(),
});

export const promotionRouter = router({
  /**
   * تقرير التغييرات الوظيفية — الترقيات وإنهاء الخدمات. hr/READ.
   * مصدره `promotionService.listPromotions/listTerminations` (لا `reportsHrService.getHrChanges`
   * — خارج ملكية هذه الشريحة وسطرها الخام يفتقد employeeId اللازم لربط كل صفٍّ ببطاقة الموظف)؛
   * هاتان الدالتان تحملانه أصلاً فضلاً عن مدى تاريخ اختياري (effectiveDate/lastDay) يُطبَّق هنا.
   */
  report: hrRead
    .input(z.object({ from: dateStr.optional(), to: dateStr.optional() }).optional())
    .query(async ({ input }) => {
      const [promos, terms] = await Promise.all([svc.listPromotions(), svc.listTerminations()]);
      const from = input?.from;
      const to = input?.to;
      const inRange = (d: string) => (!from || d >= from) && (!to || d <= to);
      return {
        promotions: promos
          .filter((p) => inRange(p.effectiveDate))
          .map((p) => ({
            employeeId: p.employeeId,
            employeeName: p.employeeName,
            fromTitle: p.fromTitle,
            toTitle: p.toTitle,
            effectiveDate: p.effectiveDate,
            status: p.status,
          })),
        terminations: terms
          .filter((t) => inRange(t.lastDay))
          .map((t) => ({
            employeeId: t.employeeId,
            employeeName: t.employeeName,
            type: t.terminationType,
            lastDay: t.lastDay,
            settlement: t.settlement,
            status: t.status,
          })),
      };
    }),

  /* ===== الترقيات ===== */
  listPromotions: hrRead.query(() => svc.listPromotions()),

  createPromotion: hrWrite
    .input(
      z
        .object({
          employeeId: z.number().int().positive(),
          /** اختياريّ: تغييرٌ أجريٌّ بحت (جدول/أسعار) لا يحمل مسمّى جديداً ⇒ يبقى الحاليّ. */
          toTitle: z.string().trim().optional(),
          fromTitle: z.string().trim().optional(),
          fromSalary: moneyStrOpt,
          toSalary: moneyStrOpt,
          effectiveDate: dateStr,
          reason: z.string().trim().optional(),
          wage: wagePatch.nullish(),
        })
        // طلبٌ بلا مسمّى ولا حزمة أجرٍ ولا راتبٍ لا يغيّر شيئاً — يُرفض بدل أن يدخل
        // طابور الاعتماد فارغاً فيُستهلك اعتمادُ مديرٍ ثانٍ على لا شيء.
        .refine((v) => !!v.toTitle || !!v.wage || !!v.toSalary, {
          message: "حدّد مسمّى جديداً أو تغييراً في حزمة الأجر",
          path: ["toTitle"],
        }),
    )
    .mutation(async ({ input, ctx }) => {
      const p = await svc.createPromotion(input as svc.PromotionInput, {
        userId: ctx.user.id,
        branchId: ctx.user.branchId ?? 1,
        role: ctx.user.role,
      });
      await logAudit(ctx, {
        action: "promotion.create",
        entityType: "employeePromotion",
        entityId: p?.id,
        // البصمة الهدف كاملةً في السجلّ: «ترقية بلا راتب» قد تكون رفعَ سعر ساعةٍ صامتاً.
        newValue: { employeeId: input.employeeId, toTitle: p?.toTitle ?? null, toSalary: p?.toSalary ?? null, toWage: p?.toWage ?? null },
      });
      return p;
    }),

  approvePromotion: hrWrite
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const id = await svc.approvePromotion(input.id, {
        userId: ctx.user.id,
        branchId: ctx.user.branchId ?? 1,
        role: ctx.user.role,
      });
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
      const res = await svc.completeTermination(input.id, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, { action: "termination.complete", entityType: "employeeTermination", entityId: res.terminationId });
      // settlementVoucher != null ⇒ صُدِّر سند صرف مُعلَّق للتسوية ينتظر اعتماد مديرٍ آخر (فصل مهام #٦).
      return { id: res.terminationId, settlementVoucher: res.settlementVoucher };
    }),
});
