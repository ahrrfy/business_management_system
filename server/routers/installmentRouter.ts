// بند 12أ (٧/٧): راوتر الأقساط. الصكوك أُزيلت من الإنشاء/السداد (٤/٨، قرار مالك «لا استثناء») —
// bounceCheck يبقى لارتجاع صكوكٍ قديمة مجدولة قبل هذا القرار فقط (لا مسار حيّ ينشئ صكاً جديداً).
//
// الصلاحيات — مرآة voucherRouter عمداً: سداد القسط يُنشئ **سند قبض حقيقياً** (createVoucher)
// فيَحمل نفس بوّابته (treasuryManagerProcedure = manager/accountant + منح صريح، **لا كاشير**
// — الكاشير ممنوع من إنشاء السندات في voucherRouter فلا نفتح له باباً خلفياً هنا). القراءة
// treasuryManagerReadProcedure. عزل الفروع بنمط voucherRouter حرفياً: غير الأدمن المُسنَد
// لفرع يُقيَّد بفرعه قراءةً وكتابةً؛ admin (أو مدير بلا فرع) يعبُر.
import { TRPCError } from "@trpc/server";
import { like } from "drizzle-orm";
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
import { installmentLines } from "../../drizzle/schema";
import { requireDb } from "../services/tx";
import { escLike } from "../lib/sqlLike";
import { router, treasuryManagerProcedure, treasuryManagerReadProcedure } from "../trpc";

const moneyStr = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, "مبلغ غير صالح (موجب، منزلتان عشريتان كحدّ أقصى)");
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح (YYYY-MM-DD)");
const planStatus = z.enum(["ACTIVE", "COMPLETED", "CANCELLED"]);
// الصكوك أُزيلت من الإنشاء والسداد (قرار مالك ٤/٨: «لا استثناء» — مطابقةً لسياسة النظام العامة
// «لا تعامل بالصكوك»). القيمة تبقى في installmentService/DB لقراءة السجلات القديمة وارتجاعها
// (bounceCheck) فقط — لا مسار حيّ ينشئ خطّاً أو سنداً جديداً بصك بعد اليوم.
const payMethod = z.enum(["CASH", "CARD", "TRANSFER", "WALLET"]);

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
      // كل الأقساط الجديدة نقدية (لا صكوك — راجع تعليق payMethod أعلاه).
      const lines = input.lines.map((l) => ({ ...l, kind: "CASH" as const }));
      const res = await createPlan({ ...input, lines, enforceFinancialIntegrity: true }, {
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

  /** قائمة الخطط بفلاتر — عزل فرع بنمط voucherRouter.list.
   *  `q` (رقم خطة/رقم صك) و`from`/`to` (مدى تاريخ الإنشاء) غير مدعومَين في listPlans (خدمة
   *  installmentService.ts خارج نطاق هذه الشريحة) — عند طلبهما نجلب صفحة واسعة (٢٠٠ = سقف الخدمة
   *  الأقصى) بنفس فلاتر الفرع/العميل/الحالة القائمة، نُصفّي فوقها هنا، ثم نُرقّم يدوياً. أثرٌ جانبيّ
   *  مقصود: بحثٌ محدود بأوّل ٢٠٠ خطة مطابقة للفلاتر الأساسية (كافٍ لحجم العمل الحاليّ؛ يتطلّب امتداد
   *  listPlans لحجمٍ أكبر). بلا q/from/to السلوك مطابق تماماً للسابق (تفويض مباشر لـlistPlans). */
  list: treasuryManagerReadProcedure
    .input(
      z
        .object({
          branchId: z.number().int().positive().optional(),
          customerId: z.number().int().positive().optional(),
          status: planStatus.optional(),
          q: z.string().max(120).optional(),
          from: ymd.optional(),
          to: ymd.optional(),
          limit: z.number().int().positive().max(200).default(50),
          offset: z.number().int().min(0).default(0),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      const restrict = restrictionFor(ctx.user);
      const branchId = restrict ?? input?.branchId;
      const customerId = input?.customerId;
      const status = input?.status;
      const q = input?.q?.trim();
      const from = input?.from;
      const to = input?.to;
      const limit = input?.limit ?? 50;
      const offset = input?.offset ?? 0;

      if (!q && !from && !to) {
        return listPlans({ branchId, customerId, status, limit, offset });
      }

      const superset = await listPlans({ branchId, customerId, status, limit: 200, offset: 0 });
      let rows = superset.rows;

      if (q) {
        const db = requireDb();
        const lineMatches = await db
          .select({ planId: installmentLines.planId })
          .from(installmentLines)
          .where(like(installmentLines.checkNumber, `%${escLike(q)}%`))
          .limit(500);
        const matchedPlanIds = new Set(lineMatches.map((l) => Number(l.planId)));
        const qLower = q.toLowerCase();
        rows = rows.filter(
          (r) =>
            matchedPlanIds.has(r.id) ||
            String(r.id).includes(q) ||
            r.customerName?.toLowerCase().includes(qLower),
        );
      }
      if (from) rows = rows.filter((r) => new Date(r.createdAt).toISOString().slice(0, 10) >= from);
      if (to) rows = rows.filter((r) => new Date(r.createdAt).toISOString().slice(0, 10) <= to);

      const page = rows.slice(offset, offset + limit);
      return { rows: page, hasMore: offset + limit < rows.length };
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
