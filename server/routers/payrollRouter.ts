/* ============================================================================
 * موجّه tRPC للرواتب — وحدة الموارد البشرية (server/routers/payrollRouter.ts)
 * القراءة بصلاحية hr/READ والكتابة بـ hr/FULL (requireModule). كل كتابة تُدقَّق (logAudit).
 * يُركَّب من قائد التكامل تحت namespace: trpc.payroll
 * ========================================================================== */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { employees, payrollItems } from "../../drizzle/schema";
import { logAudit } from "../services/auditService";
import { createAppNotification } from "../services/appNotificationService";
import * as adv from "../services/advancesService";
import * as svc from "../services/payrollService";
import * as legal from "../services/payrollLegalService";
import { getPayrollSummary } from "../services/reportsHrService";
import { managerProcedure, ownerProcedure, protectedProcedure, requireModule, router } from "../trpc";
import { nonNegMoneyString, percentString, positiveMoneyString } from "../lib/schemas";
import { isDupEntry } from "@shared/errorMap.ar";
import { requireDb } from "../services/tx";

const hrRead = protectedProcedure.use(requireModule("hr", "READ"));
const hrWrite = protectedProcedure.use(requireModule("hr", "FULL"));
const ownerHrRead = ownerProcedure.use(requireModule("hr", "READ"));
const ownerHrWrite = ownerProcedure.use(requireModule("hr", "FULL"));

const moneyStr = z.string().trim().regex(/^\d+(\.\d{1,2})?$/, "قيمة مالية غير صالحة");
const period = z.string().trim().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "الشهر يجب أن يكون بصيغة YYYY-MM");
const ymd = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "التاريخ يجب أن يكون بصيغة YYYY-MM-DD");
const payrollPaymentMethod = z.enum(["CASH", "CARD", "TRANSFER", "WALLET"]);
const advanceRepaymentEvidence = z.object({
  paymentMethod: payrollPaymentMethod,
  cashBucket: z.enum(["DRAWER", "TREASURY"]).nullish(),
  shiftId: z.number().int().positive().nullish(),
  referenceNumber: z.string().trim().max(100).nullish(),
  cardLastFour: z.string().trim().max(4).nullish(),
  transactionDate: ymd,
  evidenceNote: z.string().trim().min(10).max(500),
  clientRequestId: z.string().trim().min(8).max(80).regex(/^[A-Za-z0-9._:-]+$/),
});

function scopedPayrollBranch(user: {
  isOwner?: boolean | null;
  role: string;
  branchId?: number | null;
}): number | undefined {
  if (user.isOwner || user.role === "admin") return undefined;
  const branchId = Number(user.branchId ?? 0);
  if (!Number.isInteger(branchId) || branchId <= 0) {
    throw new TRPCError({ code: "FORBIDDEN", message: "نطاق الفرع مطلوب." });
  }
  return branchId;
}

async function notifyPayrollUsers(runId: number, periodValue: string, stage: "approved" | "paid") {
  const recipients = await requireDb()
    .select({ employeeId: payrollItems.employeeId, userId: employees.userId })
    .from(payrollItems)
    .innerJoin(employees, eq(payrollItems.employeeId, employees.id))
    .where(eq(payrollItems.runId, runId));
  await Promise.all(recipients.filter((row) => row.userId != null).map((row) =>
    createAppNotification({
      userId: Number(row.userId),
      kind: "PAYROLL_READY",
      title: stage === "paid" ? "تم صرف الراتب" : "كشف الراتب جاهز",
      body: `الفترة ${periodValue}`,
      route: "/mobile#payroll",
      eventKey: `payroll:${runId}:${row.employeeId}:${stage}`,
      entityType: "payrollRun",
      entityId: runId,
    }).catch(() => undefined),
  ));
}

export const payrollRouter = router({
  list: ownerHrRead.query(() => svc.listRuns()),

  get: ownerHrRead
    .input(z.object({ id: z.number().int().positive() }))
    .query(({ input }) => svc.getRun(input.id)),

  /** تقرير ملخّص الرواتب — مسيّرات الرواتب بإجمالياتها (بفلتر شهر اختياري). hr/READ. */
  summaryReport: ownerHrRead
    .input(z.object({ period: period.optional() }))
    .query(({ input }) => getPayrollSummary({ period: input.period })),

  financialLedger: ownerHrRead
    .input(z.object({ period: period.optional() }).optional())
    .query(({ input }) => svc.getPayrollFinancialLedger(input)),

  generate: ownerHrWrite
    .input(z.object({ period }))
    .mutation(async ({ input, ctx }) => {
      try {
        const run = await svc.generatePayroll(input.period, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 0 });
        await logAudit(ctx, {
          action: "payroll.generate",
          entityType: "payrollRun",
          entityId: run?.id,
          newValue: { period: input.period, employeeCount: run?.employeeCount, totalNet: run?.totalNet },
        });
        return run;
      } catch (err: any) {
        // القيد الفريد على الشهر يحمي من سباق توليد مزدوج.
        if (isDupEntry(err)) throw new TRPCError({ code: "CONFLICT", message: `يوجد مسيّر رواتب لشهر ${input.period} بالفعل` });
        throw err;
      }
    }),

  updateItem: ownerHrWrite
    .input(
      z.object({
        itemId: z.number().int().positive(),
        overtime: moneyStr.nullish(),
        deductions: moneyStr.nullish(),
        note: z.string().trim().max(255).nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { itemId, ...rest } = input;
      const run = await svc.updateItem(itemId, rest, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 0 });
      await logAudit(ctx, {
        action: "payroll.updateItem",
        entityType: "payrollItem",
        entityId: itemId,
        newValue: { overtime: input.overtime ?? null, deductions: input.deductions ?? null },
      });
      return run;
    }),

  approve: ownerHrWrite
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const run = await svc.approveRun(input.id, {
        userId: ctx.user.id,
        branchId: ctx.user.branchId ?? 0,
        role: ctx.user.role,
        isOwner: !!ctx.user.isOwner,
      });
      if (!run.replayed) await logAudit(ctx, { action: "payroll.approve", entityType: "payrollRun", entityId: input.id, newValue: { period: run?.period, approvedBy: ctx.user.id } });
      if (!run.replayed && run?.period) await notifyPayrollUsers(input.id, run.period, "approved");
      return run;
    }),

  pay: ownerHrWrite
    .input(z.object({
      id: z.number().int().positive(),
      paymentMethod: payrollPaymentMethod.optional(),
      paymentDate: ymd.nullish(),
      referenceNumber: z.string().trim().max(100).nullish(),
    }))
    .mutation(async ({ input, ctx }) => {
      const run = await svc.payRun(input.id, {
        userId: ctx.user.id,
        branchId: ctx.user.branchId ?? 0,
        role: ctx.user.role,
        isOwner: !!ctx.user.isOwner,
      }, {
        paymentMethod: input.paymentMethod,
        paymentDate: input.paymentDate,
        referenceNumber: input.referenceNumber,
      });
      if (!run.replayed) await logAudit(ctx, { action: "payroll.pay", entityType: "payrollRun", entityId: input.id, newValue: { period: run?.period, totalNet: run?.totalNet } });
      if (!run.replayed && run?.period) await notifyPayrollUsers(input.id, run.period, "paid");
      return run;
    }),

  cancel: ownerHrWrite
    .input(z.object({ id: z.number().int().positive(), reason: z.string().trim().min(1).max(255).optional() }))
    .mutation(async ({ input, ctx }) => {
      const res = await svc.cancelRun(input.id, {
        userId: ctx.user.id,
        branchId: ctx.user.branchId ?? 0,
        role: ctx.user.role,
        isOwner: !!ctx.user.isOwner,
        enforceCashReturnEvidence: true,
      }, input.reason);
      await logAudit(ctx, { action: "payroll.cancel", entityType: "payrollRun", entityId: input.id, newValue: { status: res.status } });
      return res;
    }),

  /** إعادة دفعة راتب حدثت فعلاً؛ ينشئ إيصال IN وقيداً معاكساً ولا يفترض رجوع النقد. */
  returnSalaryPayment: ownerHrWrite
    .input(z.object({
      accountingEventId: z.number().int().positive(),
      reason: z.string().trim().min(5).max(255),
      returnedAt: ymd.nullish(),
      referenceNumber: z.string().trim().max(100).nullish(),
    }))
    .mutation(async ({ input, ctx }) => {
      const result = await svc.returnSalaryPayment(input, {
        userId: ctx.user.id,
        branchId: ctx.user.branchId ?? 0,
        role: ctx.user.role,
        isOwner: !!ctx.user.isOwner,
      });
      if (!result.replayed) await logAudit(ctx, {
        action: "payroll.payment.return",
        entityType: "payrollAccountingEvent",
        entityId: result.eventId,
        newValue: { originalEventId: input.accountingEventId, receiptId: result.receiptId ?? null, reason: input.reason },
      });
      return result;
    }),

  obligations: hrRead
    .input(z.object({
      runId: z.number().int().positive().optional(),
      employeeId: z.number().int().positive().optional(),
      branchId: z.number().int().positive().optional(),
      kind: z.enum(["SALARY_NET", "INCOME_TAX", "SOCIAL_SECURITY", "EOS_PROVISION"]).optional(),
      status: z.enum(["OPEN", "PARTIAL", "SETTLED", "REVERSED"]).optional(),
    }).optional())
    .query(({ input, ctx }) => {
      if (!ctx.user.isOwner && ctx.user.role !== "admin") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "تفاصيل التزامات الرواتب متاحة للمالك أو المدير العام فقط.",
        });
      }
      return svc.listPayrollObligations(input);
    }),

  statutoryObligationSummary: hrRead.query(({ ctx }) => {
    const scoped = ctx.user.isOwner || ctx.user.role === "admin" || ctx.user.branchId == null
      ? undefined
      : { branchId: Number(ctx.user.branchId) };
    return svc.listStatutoryObligationSummary(scoped);
  }),

  remittances: hrRead
    .input(z.object({
      kind: z.enum(["INCOME_TAX", "SOCIAL_SECURITY"]).optional(),
      status: z.enum(["PENDING", "APPROVED", "PAID", "REJECTED", "REVERSED"]).optional(),
      branchId: z.number().int().positive().optional(),
    }).optional())
    .query(({ input, ctx }) => {
      const scoped = ctx.user.isOwner || ctx.user.role === "admin" || ctx.user.branchId == null
        ? input
        : { ...(input ?? {}), branchId: Number(ctx.user.branchId) };
      return svc.listRemittanceRequests(scoped);
    }),

  createRemittance: hrWrite
    .input(z.object({
      kind: z.enum(["INCOME_TAX", "SOCIAL_SECURITY"]),
      payingBranchId: z.number().int().positive(),
      amount: positiveMoneyString,
      authorityName: z.string().trim().min(1).max(200),
      referenceNumber: z.string().trim().min(1).max(100),
      supportingDocumentUrl: z.string().trim().min(1).max(4_000_000),
      clientRequestId: z.string().trim().min(1).max(80),
    }))
    .mutation(async ({ input, ctx }) => {
      const payingBranchId = ctx.user.isOwner || ctx.user.role === "admin"
        ? input.payingBranchId
        : Number(ctx.user.branchId ?? 0);
      if (payingBranchId <= 0) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مسند لهذا المستخدم." });
      }
      const result = await svc.createRemittanceRequest({ ...input, payingBranchId }, {
        userId: ctx.user.id,
        branchId: Number(ctx.user.branchId ?? 0),
        role: ctx.user.role,
        isOwner: !!ctx.user.isOwner,
      });
      if (!result.replayed) await logAudit(ctx, {
        action: "payroll.remittance.create",
        entityType: "payrollRemittanceRequest",
        entityId: Number(result.id),
        newValue: { kind: input.kind, amount: input.amount, payingBranchId },
      });
      return result;
    }),

  approveRemittance: hrWrite
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const result = await svc.approveRemittanceRequest(input.id, {
        userId: ctx.user.id,
        branchId: Number(ctx.user.branchId ?? 0),
        role: ctx.user.role,
        isOwner: !!ctx.user.isOwner,
      });
      if (!result.replayed) await logAudit(ctx, { action: "payroll.remittance.approve", entityType: "payrollRemittanceRequest", entityId: input.id });
      return result;
    }),

  rejectRemittance: hrWrite
    .input(z.object({ id: z.number().int().positive(), reason: z.string().trim().min(5).max(255) }))
    .mutation(async ({ input, ctx }) => {
      const result = await svc.rejectRemittanceRequest(input.id, input.reason, {
        userId: ctx.user.id,
        branchId: Number(ctx.user.branchId ?? 0),
        role: ctx.user.role,
        isOwner: !!ctx.user.isOwner,
      });
      if (!result.replayed) await logAudit(ctx, { action: "payroll.remittance.reject", entityType: "payrollRemittanceRequest", entityId: input.id, newValue: { reason: input.reason } });
      return result;
    }),

  payRemittance: hrWrite
    .input(z.object({
      requestId: z.number().int().positive(),
      paymentMethod: payrollPaymentMethod,
      paymentDate: ymd.nullish(),
      referenceNumber: z.string().trim().max(100).nullish(),
    }))
    .mutation(async ({ input, ctx }) => {
      const result = await svc.payRemittanceRequest(input, {
        userId: ctx.user.id,
        branchId: Number(ctx.user.branchId ?? 0),
        role: ctx.user.role,
        isOwner: !!ctx.user.isOwner,
      });
      if (!result.replayed) await logAudit(ctx, { action: "payroll.remittance.pay", entityType: "payrollRemittanceRequest", entityId: input.requestId, newValue: { receiptId: result.receiptId } });
      return result;
    }),

  returnRemittance: hrWrite
    .input(z.object({
      requestId: z.number().int().positive(),
      reason: z.string().trim().min(5).max(255),
      returnedAt: ymd.nullish(),
      referenceNumber: z.string().trim().max(100).nullish(),
    }))
    .mutation(async ({ input, ctx }) => {
      const result = await svc.returnRemittance(input.requestId, input.reason, {
        userId: ctx.user.id,
        branchId: Number(ctx.user.branchId ?? 0),
        role: ctx.user.role,
        isOwner: !!ctx.user.isOwner,
      }, input);
      if (!result.replayed) await logAudit(ctx, { action: "payroll.remittance.return", entityType: "payrollRemittanceRequest", entityId: input.requestId, newValue: { receiptId: result.receiptId, reason: input.reason } });
      return result;
    }),

  /* ───────────── المكوّنات القانونية العراقية (البند ④) — إعدادات معطَّلة افتراضياً ───────────── */

  /** قراءة إعدادات المكوّنات القانونية (ضمان/ضريبة/نهاية خدمة). hr/READ — القيم غير حسّاسة للاطلاع. */
  legalSettings: hrRead.query(() => legal.getPayrollLegalSettings()),

  /** تحديث الإعدادات — محصور بالمدير/الأدمن **و** يلزمه منح وحدة hr=FULL خادمياً (Codex P2):
   *  managerProcedure وحده يتجاهل منع hr الصريح (permissionsOverride=NONE) فيَعبُر مديرٌ حُجِبت عنه
   *  وحدة hr ويغيّر النِّسب القانونية عبر tRPC مباشرةً؛ تركيب requireModule("hr","FULL") يُنفِذ الحجب
   *  الصريح (مثل بقية كتابات hr). كل مكوّن بمفتاح تفعيل مستقلّ. يُدقَّق كامل (logAudit). */
  updateLegalSettings: managerProcedure
    .use(requireModule("hr", "FULL"))
    .input(
      z.object({
        socialSecurityEnabled: z.boolean(),
        socialSecurityEmployeeRate: percentString,
        socialSecurityEmployerRate: percentString,
        socialSecurityBase: z.enum(["basic", "gross"]),
        incomeTaxEnabled: z.boolean(),
        // شرائح تصاعدية: upTo حدّ أعلى موجب (سلسلة مالية) أو null للشريحة المفتوحة العليا، rate نسبة.
        incomeTaxBrackets: z
          .array(z.object({ upTo: positiveMoneyString.nullable(), rate: percentString }))
          .max(20),
        incomeTaxExemption: nonNegMoneyString,
        endOfServiceEnabled: z.boolean(),
        endOfServiceDaysPerYear: z.string().trim().regex(/^\d+(\.\d{1,2})?$/, "عدد أيام غير صالح"),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { before, after } = await legal.updatePayrollLegalSettings(input, {
        userId: ctx.user.id,
        branchId: ctx.user.branchId ?? 0,
      });
      await logAudit(ctx, {
        action: "payroll.updateLegalSettings",
        entityType: "payrollLegalSettings",
        entityId: 1,
        oldValue: {
          socialSecurityEnabled: before.socialSecurityEnabled,
          incomeTaxEnabled: before.incomeTaxEnabled,
          endOfServiceEnabled: before.endOfServiceEnabled,
        },
        newValue: {
          socialSecurityEnabled: after.socialSecurityEnabled,
          socialSecurityEmployeeRate: after.socialSecurityEmployeeRate,
          socialSecurityEmployerRate: after.socialSecurityEmployerRate,
          socialSecurityBase: after.socialSecurityBase,
          incomeTaxEnabled: after.incomeTaxEnabled,
          incomeTaxBrackets: after.incomeTaxBrackets,
          incomeTaxExemption: after.incomeTaxExemption,
          endOfServiceEnabled: after.endOfServiceEnabled,
          endOfServiceDaysPerYear: after.endOfServiceDaysPerYear,
        },
      });
      return after;
    }),

  /* ───────────── سلف الموظفين (بند 12ج) — نفس بوّابات hr ───────────── */

  advancesList: hrRead
    .input(
      z
        .object({
          employeeId: z.number().int().positive().optional(),
          branchId: z.number().int().positive().optional(),
          status: z.enum(["ACTIVE", "SETTLED", "CANCELLED"]).optional(),
        })
        .optional(),
    )
    .query(({ input, ctx }) => {
      const branchId = scopedPayrollBranch(ctx.user);
      return adv.listAdvances(branchId == null ? input : { ...(input ?? {}), branchId });
    }),

  advanceBalance: hrRead
    .input(z.object({ employeeId: z.number().int().positive() }))
    .query(({ input, ctx }) => adv.employeeBalance(input.employeeId, scopedPayrollBranch(ctx.user))),

  /** عَتبة السندات (اعتماد) لواجهة المنح — بوّابة hr (بوّابة الخزينة لا تلزم للاطلاع عليها). */
  advanceThresholds: hrRead.query(() => adv.advanceThresholds()),

  advanceRepaymentRequests: hrRead
    .input(z.object({
      requestKind: z.enum(["REPAYMENT", "RETURN"]).optional(),
      status: z.enum(["PENDING", "APPROVED", "REJECTED"]).optional(),
      employeeId: z.number().int().positive().optional(),
      branchId: z.number().int().positive().optional(),
    }).optional())
    .query(({ input, ctx }) => {
      const branchId = scopedPayrollBranch(ctx.user);
      const scoped = branchId == null ? input : { ...(input ?? {}), branchId };
      return adv.listAdvanceRepaymentRequests(scoped);
    }),

  advanceRepaymentRequest: hrRead
    .input(z.object({ id: z.number().int().positive() }))
    .query(({ input, ctx }) => adv.getAdvanceRepaymentRequest(input.id, scopedPayrollBranch(ctx.user))),

  advanceRepaymentLedger: hrRead
    .input(z.object({
      requestKind: z.enum(["REPAYMENT", "RETURN"]).optional(),
      employeeId: z.number().int().positive().optional(),
      branchId: z.number().int().positive().optional(),
    }).optional())
    .query(({ input, ctx }) => {
      const branchId = scopedPayrollBranch(ctx.user);
      const scoped = branchId == null ? input : { ...(input ?? {}), branchId };
      return adv.listAdvanceRepaymentLedger(scoped);
    }),

  requestAdvanceRepayment: hrWrite
    .input(advanceRepaymentEvidence.extend({
      employeeId: z.number().int().positive(),
      branchId: z.number().int().positive(),
      amount: positiveMoneyString,
    }))
    .mutation(async ({ input, ctx }) => {
      const result = await adv.createAdvanceRepaymentRequest(input, {
        userId: ctx.user.id,
        branchId: ctx.user.branchId ?? 0,
        role: ctx.user.role,
        isOwner: !!ctx.user.isOwner,
      });
      if (!result.replayed) await logAudit(ctx, {
        action: "payroll.advanceRepayment.request",
        entityType: "employeeAdvanceRepaymentRequest",
        entityId: Number(result.id),
        newValue: { employeeId: input.employeeId, branchId: input.branchId, amount: input.amount },
      });
      return result;
    }),

  requestAdvanceRepaymentReturn: hrWrite
    .input(advanceRepaymentEvidence.extend({ originalRequestId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const result = await adv.createAdvanceRepaymentReturnRequest(input, {
        userId: ctx.user.id,
        branchId: ctx.user.branchId ?? 0,
        role: ctx.user.role,
        isOwner: !!ctx.user.isOwner,
      });
      if (!result.replayed) await logAudit(ctx, {
        action: "payroll.advanceRepayment.return.request",
        entityType: "employeeAdvanceRepaymentRequest",
        entityId: Number(result.id),
        newValue: { originalRequestId: input.originalRequestId },
      });
      return result;
    }),

  approveAdvanceRepayment: ownerHrWrite
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const result = await adv.approveAdvanceRepaymentRequest(input.id, {
        userId: ctx.user.id,
        branchId: ctx.user.branchId ?? 0,
        role: ctx.user.role,
        isOwner: !!ctx.user.isOwner,
      });
      if (!result.replayed) await logAudit(ctx, {
        action: "payroll.advanceRepayment.approve",
        entityType: "employeeAdvanceRepaymentRequest",
        entityId: input.id,
        newValue: { receiptId: result.receiptId, accountingEntryId: result.accountingEntryId },
      });
      return result;
    }),

  rejectAdvanceRepayment: ownerHrWrite
    .input(z.object({ id: z.number().int().positive(), reason: z.string().trim().min(5).max(255) }))
    .mutation(async ({ input, ctx }) => {
      const result = await adv.rejectAdvanceRepaymentRequest(input.id, input.reason, {
        userId: ctx.user.id,
        branchId: ctx.user.branchId ?? 0,
        role: ctx.user.role,
        isOwner: !!ctx.user.isOwner,
      });
      if (!result.replayed) await logAudit(ctx, {
        action: "payroll.advanceRepayment.reject",
        entityType: "employeeAdvanceRepaymentRequest",
        entityId: input.id,
        newValue: { reason: input.reason },
      });
      return result;
    }),

  advanceGrant: hrWrite
    .input(
      z.object({
        employeeId: z.number().int().positive(),
        branchId: z.number().int().positive(),
        amount: moneyStr,
        monthlyDeduction: moneyStr.nullish(),
        note: z.string().trim().max(255).nullish(),
        // مُرفق سند الصرف (صورة مضغوطة data URL أو رابط) — اختياريّ، نفس سقف voucherRouter.
        attachmentUrl: z.string().max(4_000_000).nullish(),
        // idempotency (تدقيق ١٧/٧): منع صرف نقدي مزدوج عند إعادة الإرسال.
        clientRequestId: z.string().trim().min(1).max(64),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const res = await adv.grantAdvance(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 0, role: ctx.user.role });
      await logAudit(ctx, {
        action: "payroll.advanceGrant",
        entityType: "employeeAdvance",
        entityId: res?.id != null ? Number(res.id) : undefined,
        newValue: { employeeId: input.employeeId, amount: input.amount, monthlyDeduction: input.monthlyDeduction ?? null, voucherNumber: res?.voucherNumber },
      });
      return res;
    }),

  advanceCancel: hrWrite
    .input(z.object({ advanceId: z.number().int().positive(), reason: z.string().trim().max(200).nullish() }))
    .mutation(async ({ input, ctx }) => {
      const res = await adv.cancelAdvance(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 0, role: ctx.user.role });
      await logAudit(ctx, { action: "payroll.advanceCancel", entityType: "employeeAdvance", entityId: input.advanceId, newValue: { reason: input.reason ?? null } });
      return res;
    }),
});
