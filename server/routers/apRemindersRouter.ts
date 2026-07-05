// تذكيرات الذمم الدائنة — راوتر tRPC. حماية بـsuppliersManagerProcedure (مدير + عزل فرع + وحدة الموردين).
// كل الكتابات مُدقَّقة عبر logAudit. لا مبالغ فعلية تتحرّك — سجلّ فعلٍ يوميّ فقط (لا يمسّ الدفتر).
// مرآة arRemindersRouter بالكامل (supplier/PO بدل customer/invoice).
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  getReminderHistory,
  getReminderQueue,
  logReminderSent,
  logReminderSkipped,
} from "../services/apRemindersService";
import { logAudit } from "../services/auditService";
import { router, suppliersManagerProcedure } from "../trpc";

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح");
const moneyStr = z.string().min(1);
/** فرع اختياري في المدخلات — للأدمن حصراً (عبور الفروع)؛ غير الأدمن يُرفَض عند طلب فرع آخر. */
const optionalBranch = z.number().int().positive().optional();

/**
 * عزل الفرع — قاعدة واحدة للقراءات والكتابات معاً (نظير arRemindersRouter، سدّ عودة نمط `?? 1`):
 *  - admin: input.branchId إن حُدِّد وإلا فرعه المُسنَد؛ غيابهما معاً ⇒ FORBIDDEN صريح.
 *  - غيره: فرعه المُسنَد حصراً؛ طلبُ فرعٍ آخر ⇒ FORBIDDEN.
 * ⚠️ نطاق القراءة = نطاق الكتابة عمداً: قراءةٌ مجمَّعة (null) مع كتابةٍ مثبَّتة على فرع واحد تجعل
 * صفوف الفروع الأخرى غير قابلة للتنفيذ. التجميع (branchId=null) متاح على مستوى الخدمة فقط.
 */
function scopedBranch(
  ctx: { user: { role: string; branchId?: number | null } },
  inputBranchId?: number,
): number {
  if (ctx.user.role === "admin") {
    const resolved = inputBranchId ?? (ctx.user.branchId != null ? Number(ctx.user.branchId) : null);
    if (resolved == null) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "حدّد الفرع (branchId) — لا فرع مُسنَد لحسابك.",
      });
    }
    return resolved;
  }
  if (ctx.user.branchId == null) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
  }
  const own = Number(ctx.user.branchId);
  if (inputBranchId !== undefined && inputBranchId !== own) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن قراءة بيانات فرع آخر" });
  }
  return own;
}

export const apRemindersRouter = router({
  /** قائمة اليوم: موردون بذمّة دائنة >٠ متأخّرة ≥٧ أيام، لم يُذكَّروا آخر ٧ أيام. admin يعبُر بـbranchId صريح. */
  queue: suppliersManagerProcedure
    .input(z.object({ branchId: optionalBranch }).optional())
    .query(({ ctx, input }) => getReminderQueue({ branchId: scopedBranch(ctx, input?.branchId) })),

  /** سجلّ آخر ٣٠ يوماً من التذكيرات في فرع المستخدم (admin يعبُر بـbranchId صريح). */
  history: suppliersManagerProcedure
    .input(
      z
        .object({
          limit: z.number().int().positive().max(1000).optional(),
          branchId: optionalBranch,
        })
        .optional(),
    )
    .query(({ ctx, input }) =>
      getReminderHistory({ branchId: scopedBranch(ctx, input?.branchId), limit: input?.limit }),
    ),

  /** تسجيل تذكير أُرسِل — يستدعيه الزبون فور عودة المستخدم من فتح wa.me وتأكيده الإرسال. */
  logSent: suppliersManagerProcedure
    .input(
      z.object({
        supplierId: z.number().int().positive(),
        totalUnpaidSnapshot: moneyStr,
        oldestPoDate: ymd,
        daysOverdue: z.number().int().nonnegative(),
        messageBody: z.string().min(1).max(4000),
        branchId: optionalBranch,
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { branchId: requestedBranchId, ...payload } = input;
      const r = await logReminderSent(payload, {
        userId: ctx.user.id,
        branchId: scopedBranch(ctx, requestedBranchId),
      });
      await logAudit(ctx, {
        action: "apReminder.sent",
        entityType: "apReminder",
        entityId: r.id,
        newValue: {
          supplierId: input.supplierId,
          totalUnpaidSnapshot: input.totalUnpaidSnapshot,
          daysOverdue: input.daysOverdue,
        },
      });
      return r;
    }),

  /** تسجيل تخطٍّ — قرار مؤقّت بعدم الإرسال، أو وعدنا بالسداد يوم كذا. */
  logSkipped: suppliersManagerProcedure
    .input(
      z.object({
        supplierId: z.number().int().positive(),
        totalUnpaidSnapshot: moneyStr,
        oldestPoDate: ymd,
        daysOverdue: z.number().int().nonnegative(),
        skipReason: z.string().min(1).max(255),
        promisedDate: ymd.optional().nullable(),
        branchId: optionalBranch,
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { branchId: requestedBranchId, ...payload } = input;
      const r = await logReminderSkipped(payload, {
        userId: ctx.user.id,
        branchId: scopedBranch(ctx, requestedBranchId),
      });
      await logAudit(ctx, {
        action: "apReminder.skipped",
        entityType: "apReminder",
        entityId: r.id,
        newValue: {
          supplierId: input.supplierId,
          skipReason: input.skipReason,
          promisedDate: input.promisedDate ?? null,
        },
      });
      return r;
    }),
});
