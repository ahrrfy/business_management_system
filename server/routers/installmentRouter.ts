// بند 12أ (٧/٧): راوتر الأقساط والشيكات الآجلة.
//
// الصلاحيات — مرآة voucherRouter عمداً: سداد القسط يُنشئ **سند قبض حقيقياً** (createVoucher)
// فيَحمل نفس بوّابته (treasuryManagerProcedure = manager/accountant + منح صريح، **لا كاشير**
// — الكاشير ممنوع من إنشاء السندات في voucherRouter فلا نفتح له باباً خلفياً هنا). القراءة
// treasuryManagerReadProcedure. عزل الفروع بنمط voucherRouter حرفياً: غير الأدمن المُسنَد
// لفرع يُقيَّد بفرعه قراءةً وكتابةً؛ admin (أو مدير بلا فرع) يعبُر.
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { logAudit } from "../services/auditService";
import {
  bounceCheck,
  cancelPlan,
  createPlan,
  dueSoon,
  getPlan,
  listPlans,
  payLine,
} from "../services/installmentService";
import { router, treasuryManagerProcedure, treasuryManagerReadProcedure } from "../trpc";

const moneyStr = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, "مبلغ غير صالح (موجب، منزلتان عشريتان كحدّ أقصى)");
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح (YYYY-MM-DD)");
const lineKind = z.enum(["CASH", "CHECK"]);
const planStatus = z.enum(["ACTIVE", "COMPLETED", "CANCELLED"]);
const payMethod = z.enum(["CASH", "CARD", "CHECK", "TRANSFER", "WALLET"]);

type CtxUser = { id: number; role: string; branchId?: number | null };

/** نمط voucherRouter: غير الأدمن المُسنَد لفرع يُقيَّد بفرعه؛ admin/مدير بلا فرع يعبُر (null). */
function restrictionFor(user: CtxUser): number | null {
  return user.role !== "admin" && user.branchId != null ? Number(user.branchId) : null;
}

export const installmentRouter = router({
  /** إنشاء خطة أقساط — لا قيد محاسبي (جدولة تحصيل فوق الذمّة القائمة). */
  create: treasuryManagerProcedure
    .input(
      z.object({
        customerId: z.number().int().positive(),
        invoiceId: z.number().int().positive().nullish(),
        branchId: z.number().int().positive(),
        totalAmount: moneyStr,
        downPayment: moneyStr.nullish(),
        notes: z.string().max(1000).nullish(),
        lines: z
          .array(
            z.object({
              dueDate: ymd,
              amount: moneyStr,
              kind: lineKind,
              checkNumber: z.string().max(60).nullish(),
              bankName: z.string().max(100).nullish(),
            }),
          )
          .min(1, "قسط واحد على الأقل")
          .max(60, "٦٠ قسطاً كحدّ أقصى"),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const restrict = restrictionFor(ctx.user);
      if (restrict != null && input.branchId !== restrict) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن إنشاء خطة لفرع آخر" });
      }
      if (restrict == null && ctx.user.role !== "admin" && ctx.user.branchId == null) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم — لا يمكن إنشاء خطة" });
      }
      const res = await createPlan(input, {
        userId: ctx.user.id,
        branchId: Number(ctx.user.branchId ?? input.branchId),
        role: ctx.user.role,
      });
      await logAudit(ctx, {
        action: "installment.plan.create",
        entityType: "installmentPlan",
        entityId: res.planId,
        newValue: {
          customerId: input.customerId,
          invoiceId: input.invoiceId ?? null,
          branchId: input.branchId,
          totalAmount: input.totalAmount,
          downPayment: input.downPayment ?? "0",
          linesCount: input.lines.length,
        },
      });
      return res;
    }),

  /** سداد قسط — يُنشئ سند قبض حقيقياً؛ قد يعود PENDING_APPROVAL (Maker-Checker) والقسط يبقى معلَّقاً. */
  pay: treasuryManagerProcedure
    .input(
      z.object({
        lineId: z.number().int().positive(),
        paymentMethod: payMethod.nullish(),
        note: z.string().max(255).nullish(),
        // نفس سقف voucherRouter.create — رسالة الحجم الودودة تأتي من طبقة أدنى.
        attachmentUrl: z.string().max(4_000_000).nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.branchId == null && ctx.user.role !== "admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم — لا يمكن السداد" });
      }
      const res = await payLine(
        input,
        { userId: ctx.user.id, branchId: Number(ctx.user.branchId ?? 0), role: ctx.user.role },
        restrictionFor(ctx.user),
      );
      await logAudit(ctx, {
        action: "installment.line.pay",
        entityType: "installmentLine",
        entityId: input.lineId,
        newValue: {
          status: res.status,
          receiptId: res.receiptId,
          voucherNumber: res.voucherNumber,
          planCompleted: res.planCompleted,
          paymentMethod: input.paymentMethod ?? null,
        },
      });
      return res;
    }),

  /** ارتجاع شيك معلَّق — لا حركة مالية (الشيك لم يُحصَّل أصلاً). */
  bounce: treasuryManagerProcedure
    .input(z.object({ lineId: z.number().int().positive(), note: z.string().max(255).nullish() }))
    .mutation(async ({ input, ctx }) => {
      const res = await bounceCheck(
        input,
        { userId: ctx.user.id, branchId: Number(ctx.user.branchId ?? 0), role: ctx.user.role },
        restrictionFor(ctx.user),
      );
      await logAudit(ctx, {
        action: "installment.line.bounce",
        entityType: "installmentLine",
        entityId: input.lineId,
        newValue: { note: input.note ?? null },
      });
      return res;
    }),

  /** إلغاء خطة بلا أي قسط مسدَّد. */
  cancel: treasuryManagerProcedure
    .input(z.object({ planId: z.number().int().positive(), reason: z.string().max(500).nullish() }))
    .mutation(async ({ input, ctx }) => {
      const res = await cancelPlan(
        input,
        { userId: ctx.user.id, branchId: Number(ctx.user.branchId ?? 0), role: ctx.user.role },
        restrictionFor(ctx.user),
      );
      await logAudit(ctx, {
        action: "installment.plan.cancel",
        entityType: "installmentPlan",
        entityId: input.planId,
        newValue: { reason: input.reason ?? null },
      });
      return res;
    }),

  /** قائمة الخطط بفلاتر — عزل فرع بنمط voucherRouter.list. */
  list: treasuryManagerReadProcedure
    .input(
      z
        .object({
          branchId: z.number().int().positive().optional(),
          customerId: z.number().int().positive().optional(),
          status: planStatus.optional(),
          limit: z.number().int().positive().max(200).default(50),
          offset: z.number().int().min(0).default(0),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      const restrict = restrictionFor(ctx.user);
      const scoped = restrict != null ? { ...(input ?? {}), branchId: restrict } : (input ?? {});
      return listPlans(scoped);
    }),

  /** تفاصيل خطة بأقساطها — عزل فرع بنمط voucherRouter.get (داخل الخدمة). */
  get: treasuryManagerReadProcedure
    .input(z.object({ planId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => getPlan(input.planId, restrictionFor(ctx.user))),

  /** طابور التحصيل: أقساط معلَّقة مستحقّة خلال N أيام أو متأخّرة — الأشد تأخّراً أولاً. */
  dueSoon: treasuryManagerReadProcedure
    .input(
      z
        .object({
          branchId: z.number().int().positive().optional(),
          days: z.number().int().min(0).max(90).default(7),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      const restrict = restrictionFor(ctx.user);
      return dueSoon({
        branchId: restrict != null ? restrict : (input?.branchId ?? null),
        days: input?.days ?? 7,
      });
    }),
});
