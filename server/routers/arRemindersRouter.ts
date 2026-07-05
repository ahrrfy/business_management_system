// تذكيرات الذمم الآجلة — راوتر tRPC. حماية بـcustomersManagerProcedure (مدير + عزل فرع + وحدة العملاء).
// كل الكتابات مُدقَّقة عبر logAudit. لا مبالغ فعلية تتحرّك — سجلّ فعلٍ يوميّ فقط (لا يمسّ الدفتر).
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  getReminderHistory,
  getReminderQueue,
  logReminderSent,
  logReminderSkipped,
} from "../services/arRemindersService";
import { logAudit } from "../services/auditService";
import { customersManagerProcedure, router } from "../trpc";

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح");
const moneyStr = z.string().min(1);
/** فرع اختياري في المدخلات — للأدمن حصراً (عبور الفروع)؛ غير الأدمن يُرفَض عند طلب فرع آخر. */
const optionalBranch = z.number().int().positive().optional();

/**
 * عزل الفرع — قاعدة واحدة للقراءات والكتابات معاً (سدّ عودة نمط `?? 1`، سابقة G3):
 *  - admin: يعبُر الفروع بطلب صريح فقط — input.branchId إن حُدِّد، وإلا فرعه المُسنَد؛ غيابهما
 *    معاً ⇒ FORBIDDEN صريح (كان `?? 1` يقرأ/يكتب صامتاً على الفرع ١).
 *  - غيره: فرعه المُسنَد حصراً؛ طلبُ فرعٍ آخر ⇒ FORBIDDEN forensic، وبلا فرع مُسنَد ⇒ FORBIDDEN.
 *
 * ⚠️ نطاق القراءة = نطاق الكتابة **عمداً** (تحقّق عدائي ٥/٧): قراءةٌ مجمَّعة (null=كل الفروع) مع
 * كتابةٍ مثبَّتة على فرع واحد تجعل صفوف الفروع الأخرى في القائمة غير قابلة للتنفيذ — واتساب يُفتح
 * فعلياً ثم يفشل التسجيل (لا تبريد ⇒ إغراق العميل بمطالبات يومية) أو يُنسَب لفرع خاطئ يخترق تبريد
 * الفرع الصحيح. التجميع عبر الفروع متاح على مستوى الخدمة (branchId=null — تستهلكه لوحة التحكم
 * قراءةً فقط)، ولا يُعرَض من هذا الراوتر إلا حين تملك الشاشة تمرير فرعٍ لكل صفّ (قرار مالك معلَّق).
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

/** فرع كتابة تذكير مدين افتتاحي (نطاق «الرصيد الافتتاحي») — **للأدمن حصراً** (مطابقٌ لقراءة النطاق).
 *  الفرع هنا لتجميع التبريد فقط لا للعزل: التحقّق الأمني = `assertOpeningBalanceDebtor` (قيد OPENING)،
 *  والقراءة تجمع كل الفروع ⇒ لا IDOR فرعيّ. لذا نقبل فرع الطلب ← فرع المستخدم، وإلا FORBIDDEN صريح.
 *  ⚠️ لا تُسقِط هذا إلى `?? 1` (سابقة G3 — عودة النمط المحظور بالضبط): معرّفات الفروع ليست مضمونة
 *  ١/٢ (تنجرف مع auto_increment في أي قاعدة حيّة/اختبار)، فأيّ رقم حرفيّ ثابت هنا قد يشير لفرع غير
 *  موجود فيَفشل الإدراج بخرق قيد FK بدل رسالة واضحة — أو أسوأ، يشير صدفةً لفرع خاطئ فعلاً. */
function openingWriteBranch(
  ctx: { user: { role: string; branchId?: number | null } },
  inputBranchId?: number,
): number {
  if (ctx.user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "مدينو الرصيد الافتتاحي متاحون للأدمن فقط." });
  }
  const resolved = inputBranchId ?? (ctx.user.branchId != null ? Number(ctx.user.branchId) : null);
  if (resolved == null) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "حدّد الفرع (branchId) — لا فرع مُسنَد لحسابك.",
    });
  }
  return resolved;
}

export const arRemindersRouter = router({
  /** قائمة اليوم: عملاء بذمّة >٠ متأخّرة ≥٧ أيام، لم يُذكَّروا آخر ٧ أيام. admin يعبُر بـbranchId صريح.
   *  `openingScope` (أدمن حصراً) ⇒ **مدينو الرصيد الافتتاحي فقط** مجمَّعين عبر الفروع (نطاق مستقلّ). */
  queue: customersManagerProcedure
    .input(z.object({ branchId: optionalBranch, openingScope: z.boolean().optional() }).optional())
    .query(({ ctx, input }) => {
      if (input?.openingScope) {
        if (ctx.user.role !== "admin") {
          throw new TRPCError({ code: "FORBIDDEN", message: "مدينو الرصيد الافتتاحي متاحون للأدمن فقط." });
        }
        return getReminderQueue({ branchId: null, openingOnly: true });
      }
      return getReminderQueue({ branchId: scopedBranch(ctx, input?.branchId) });
    }),

  /** سجلّ آخر ٣٠ يوماً من التذكيرات في فرع المستخدم (admin يعبُر بـbranchId صريح).
   *  `openingScope` (أدمن حصراً) ⇒ سجلّ مجمَّع عبر كل الفروع — مرآة queue.openingScope. لا عمود
   *  يُميِّز صفوف الرصيد الافتتاحي في `arReminders` (تُكتَب بفرع حقيقي عبر openingWriteBranch)،
   *  فالتجميع الكامل هو أصدق تمثيل متاح لسياق «مراجعة مدينِي الافتتاحي» دون تضليل بفرع واحد فقط. */
  history: customersManagerProcedure
    .input(
      z
        .object({
          limit: z.number().int().positive().max(1000).optional(),
          branchId: optionalBranch,
          openingScope: z.boolean().optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) => {
      if (input?.openingScope) {
        if (ctx.user.role !== "admin") {
          throw new TRPCError({ code: "FORBIDDEN", message: "مدينو الرصيد الافتتاحي متاحون للأدمن فقط." });
        }
        return getReminderHistory({ branchId: null, limit: input?.limit });
      }
      return getReminderHistory({ branchId: scopedBranch(ctx, input?.branchId), limit: input?.limit });
    }),

  /** تسجيل تذكير أُرسِل — يستدعيه الزبون فور عودة المستخدم من فتح wa.me وتأكيده الإرسال. */
  logSent: customersManagerProcedure
    .input(
      z.object({
        customerId: z.number().int().positive(),
        totalUnpaidSnapshot: moneyStr,
        oldestInvoiceDate: ymd,
        daysOverdue: z.number().int().nonnegative(),
        messageBody: z.string().min(1).max(4000),
        isOpeningBalance: z.boolean().optional(),
        branchId: optionalBranch,
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { branchId: requestedBranchId, ...payload } = input;
      const r = await logReminderSent(payload, {
        userId: ctx.user.id,
        branchId: input.isOpeningBalance
          ? openingWriteBranch(ctx, requestedBranchId)
          : scopedBranch(ctx, requestedBranchId),
      });
      await logAudit(ctx, {
        action: "arReminder.sent",
        entityType: "arReminder",
        entityId: r.id,
        newValue: {
          customerId: input.customerId,
          totalUnpaidSnapshot: input.totalUnpaidSnapshot,
          daysOverdue: input.daysOverdue,
        },
      });
      return r;
    }),

  /** تسجيل تخطٍّ — العميل وعد بالدفع، أو قرار مؤقّت بعدم الإرسال. */
  logSkipped: customersManagerProcedure
    .input(
      z.object({
        customerId: z.number().int().positive(),
        totalUnpaidSnapshot: moneyStr,
        oldestInvoiceDate: ymd,
        daysOverdue: z.number().int().nonnegative(),
        skipReason: z.string().min(1).max(255),
        // اختياري: إن مُلئ ⇒ العميل يعود لقائمة اليوم يوم الوعد (يتخطّى تبريد ٧ أيام).
        promisedDate: ymd.optional().nullable(),
        isOpeningBalance: z.boolean().optional(),
        branchId: optionalBranch,
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { branchId: requestedBranchId, ...payload } = input;
      const r = await logReminderSkipped(payload, {
        userId: ctx.user.id,
        branchId: input.isOpeningBalance
          ? openingWriteBranch(ctx, requestedBranchId)
          : scopedBranch(ctx, requestedBranchId),
      });
      await logAudit(ctx, {
        action: "arReminder.skipped",
        entityType: "arReminder",
        entityId: r.id,
        newValue: {
          customerId: input.customerId,
          skipReason: input.skipReason,
          promisedDate: input.promisedDate ?? null,
        },
      });
      return r;
    }),
});
