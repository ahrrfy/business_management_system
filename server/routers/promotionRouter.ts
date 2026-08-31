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

function promotionActor(user: {
  id: number;
  branchId: number | null;
  role: string;
  isOwner?: boolean | null;
}): svc.PromotionActor {
  return {
    userId: user.id,
    // لا نستخدم ?? 1 هنا: غير الأدمن بلا فرع يجب أن يفشل مغلقاً، لا أن يرث الرئيسي.
    branchId: user.branchId,
    role: user.role,
    isOwner: user.isOwner === true,
  };
}

const moneyStrOpt = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,2})?$/, "قيمة مالية غير صالحة")
  .optional();
const paymentMethod = z.enum(["CASH", "CARD", "TRANSFER", "WALLET"]);
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
    .record(
      z.string(),
      z.object({
        hours: z.number().min(0).max(24),
        rate: z.number().min(0).nullish(),
      }),
    )
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
    .input(
      z.object({ from: dateStr.optional(), to: dateStr.optional() }).optional(),
    )
    .query(async ({ input, ctx }) => {
      const actor = promotionActor(ctx.user);
      const [promos, terms] = await Promise.all([
        svc.listPromotions(actor),
        svc.listTerminations(actor),
      ]);
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
  listPromotions: hrRead.query(({ ctx }) =>
    svc.listPromotions(promotionActor(ctx.user)),
  ),

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
      const p = await svc.createPromotion(
        input as svc.PromotionInput,
        promotionActor(ctx.user),
      );
      await logAudit(ctx, {
        action: "promotion.create",
        entityType: "employeePromotion",
        entityId: p?.id,
        // البصمة الهدف كاملةً في السجلّ: «ترقية بلا راتب» قد تكون رفعَ سعر ساعةٍ صامتاً.
        newValue: {
          employeeId: input.employeeId,
          toTitle: p?.toTitle ?? null,
          toSalary: p?.toSalary ?? null,
          toWage: p?.toWage ?? null,
        },
      });
      return p;
    }),

  approvePromotion: hrWrite
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const id = await svc.approvePromotion(input.id, promotionActor(ctx.user));
      await logAudit(ctx, {
        action: "promotion.approve",
        entityType: "employeePromotion",
        entityId: id,
      });
      return { id };
    }),

  /* ===== إنهاء الخدمات ===== */
  listTerminations: hrRead.query(({ ctx }) =>
    svc.listTerminations(promotionActor(ctx.user)),
  ),

  createTermination: hrWrite
    .input(
      z.object({
        employeeId: z.number().int().positive(),
        terminationType: z.enum(TERMINATION_TYPES),
        lastDay: dateStr,
        settlement: moneyStrOpt,
        breakdown: z.object({
          earnedGrossWages: moneyStrOpt,
          wageReductions: moneyStrOpt,
          advanceRecovery: moneyStrOpt,
          incomeTax: moneyStrOpt,
          employeeSocialSecurity: moneyStrOpt,
          employerSocialSecurity: moneyStrOpt,
          leaveCompensation: moneyStrOpt,
          noticeCompensation: moneyStrOpt,
          eosBenefit: moneyStrOpt,
          otherSettlement: moneyStrOpt,
          otherSettlementLabel: z.string().trim().max(120).optional(),
        }),
        paymentMethod: paymentMethod.default("CASH"),
        paymentReference: z.string().trim().max(120).optional(),
        settlementEvidenceNote: z.string().trim().min(10).max(500),
        zeroAmountsAttested: z.literal(true),
        reason: z.string().trim().optional(),
        // سببُ انحراف الأجر عن اشتقاق سجلّ الحضور — يطلبه الخادم عند تجاوز العتبة (بند ٤٣).
        wageDivergenceReason: z.string().trim().min(10).max(300).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const t = await svc.createTermination(
        input as svc.TerminationInput,
        promotionActor(ctx.user),
      );
      await logAudit(ctx, {
        action: "termination.create",
        entityType: "employeeTermination",
        entityId: t?.id,
        newValue: {
          employeeId: input.employeeId,
          terminationType: input.terminationType,
          lastDay: input.lastDay,
          breakdown: input.breakdown,
          paymentMethod: input.paymentMethod,
        },
      });
      return t;
    }),

  completeTermination: hrWrite
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const res = await svc.completeTermination(
        input.id,
        promotionActor(ctx.user),
      );
      await logAudit(ctx, {
        action: "termination.complete",
        entityType: "employeeTermination",
        entityId: res.terminationId,
        newValue: {
          userDisabled: res.userDisabled,
          deviceLinksReleased: res.deviceLinksReleased,
          settlementVoucherCreated: res.settlementVoucher != null,
        },
      });
      // settlementVoucher != null ⇒ صُدِّر سند صرف مُعلَّق للتسوية ينتظر اعتماد مديرٍ آخر (فصل مهام #٦).
      // والأثران الأمنيّان يُعادان للشاشة لا للتدقيق وحده: تعطيلُ حساب الدخول وحدُّ ربط جهاز
      // الحضور فعلان يقعان بلا طلبٍ صريح من المُنفِّذ، فمرورهما صامتَين يترك مديراً يظنّ
      // الحساب حيّاً وقد عُطِّل — وهما مسجَّلان في التدقيق أعلاه أصلاً، فلا كشفَ جديد.
      return {
        id: res.terminationId,
        settlementVoucher: res.settlementVoucher,
        recognition: res.recognition,
        userDisabled: res.userDisabled,
        deviceLinksReleased: res.deviceLinksReleased,
      };
    }),

  reverseTerminationPayment: hrWrite
    .input(
      z.object({
        id: z.number().int().positive(),
        reason: z.string().trim().min(5).max(255),
        paymentMethod: paymentMethod,
        referenceNumber: z.string().trim().max(120).optional(),
        reversalDate: dateStr.optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const result = await svc.reverseTerminationPayment(
        input.id,
        promotionActor(ctx.user),
        input,
      );
      if (!result.replayed) await logAudit(ctx, {
        action: "termination.payment.reverse",
        entityType: "employeeTermination",
        entityId: input.id,
        newValue: {
          reason: input.reason,
          paymentMethod: input.paymentMethod,
          reversalDate: input.reversalDate ?? null,
          receiptId: result.receiptId,
        },
      });
      return result;
    }),

  reissueTerminationPayment: hrWrite
    .input(
      z.object({
        id: z.number().int().positive(),
        reason: z.string().trim().min(5).max(255),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const result = await svc.reissueTerminationPayment(
        input.id,
        promotionActor(ctx.user),
        input.reason,
      );
      if (!result.replayed) await logAudit(ctx, {
        action: "termination.payment.reissue",
        entityType: "employeeTermination",
        entityId: input.id,
        newValue: {
          reason: input.reason,
          receiptId: result.receiptId,
          attempt: result.attempt,
          replayed: result.replayed,
        },
      });
      return result;
    }),

  reverseTerminationRecognition: hrWrite
    .input(
      z.object({
        id: z.number().int().positive(),
        reason: z.string().trim().min(5).max(255),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const result = await svc.reverseTerminationRecognition(
        input.id,
        promotionActor(ctx.user),
        input.reason,
      );
      if (!result.replayed) await logAudit(ctx, {
        action: "termination.accrual.reverse",
        entityType: "employeeTermination",
        entityId: input.id,
        newValue: { reason: input.reason, eventId: result.eventId },
      });
      return result;
    }),
});
