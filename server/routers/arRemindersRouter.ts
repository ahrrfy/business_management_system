// تذكيرات الذمم الآجلة — راوتر tRPC. حماية بـcustomersManagerProcedure (مدير + عزل فرع + وحدة العملاء).
// كل الكتابات مُدقَّقة عبر logAudit. لا مبالغ فعلية تتحرّك — سجلّ فعلٍ يوميّ فقط (لا يمسّ الدفتر).
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

export const arRemindersRouter = router({
  /** قائمة اليوم: عملاء بذمّة >٠ متأخّرة ≥٧ أيام، لم يُذكَّروا آخر ٧ أيام. */
  queue: customersManagerProcedure.query(({ ctx }) =>
    getReminderQueue({ branchId: ctx.user.branchId ?? 1 }),
  ),

  /** سجلّ آخر ٣٠ يوماً من التذكيرات في فرع المستخدم. */
  history: customersManagerProcedure
    .input(z.object({ limit: z.number().int().positive().max(1000).optional() }).optional())
    .query(({ ctx, input }) =>
      getReminderHistory({ branchId: ctx.user.branchId ?? 1, limit: input?.limit }),
    ),

  /** تسجيل تذكير أُرسِل — يستدعيه الزبون فور عودة المستخدم من فتح wa.me وتأكيده الإرسال. */
  logSent: customersManagerProcedure
    .input(
      z.object({
        customerId: z.number().int().positive(),
        totalUnpaidSnapshot: moneyStr,
        oldestInvoiceDate: ymd,
        daysOverdue: z.number().int().nonnegative(),
        messageBody: z.string().min(1).max(4000),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const r = await logReminderSent(input, {
        userId: ctx.user.id,
        branchId: ctx.user.branchId ?? 1,
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
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const r = await logReminderSkipped(input, {
        userId: ctx.user.id,
        branchId: ctx.user.branchId ?? 1,
      });
      await logAudit(ctx, {
        action: "arReminder.skipped",
        entityType: "arReminder",
        entityId: r.id,
        newValue: {
          customerId: input.customerId,
          skipReason: input.skipReason,
        },
      });
      return r;
    }),
});
