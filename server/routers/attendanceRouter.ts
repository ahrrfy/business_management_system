/* ============================================================================
 * موجّه tRPC للحضور والانصراف — وحدة الموارد البشرية (server/routers/attendanceRouter.ts)
 * القراءة بصلاحية hr/READ والكتابة بـ hr/FULL (requireModule). كل كتابة تُدقَّق (logAudit).
 * يُركَّب من قبل قائد التكامل تحت المسار trpc.attendance.
 * ========================================================================== */
import { z } from "zod";
import { logAudit } from "../services/auditService";
import * as svc from "../services/attendanceService";
import { getAttendanceReport } from "../services/reportsHrService";
import { getEmployeeStatement } from "../services/hr/employeeStatement";
import { protectedProcedure, requireModule, router } from "../trpc";

const hrRead = protectedProcedure.use(requireModule("hr", "READ"));
const hrWrite = protectedProcedure.use(requireModule("hr", "FULL"));

const periodStr = z.string().regex(/^\d{4}-\d{2}$/, "صيغة الشهر يجب أن تكون YYYY-MM");
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "صيغة التاريخ يجب أن تكون YYYY-MM-DD");
const timeStr = z.string().regex(/^\d{1,2}:\d{2}$/, "صيغة الوقت يجب أن تكون HH:MM");

export const attendanceRouter = router({
  list: hrRead
    .input(
      z
        .object({
          employeeId: z.number().int().positive().optional(),
          period: periodStr.optional(),
          source: z.enum(["fingerprint", "manual"]).optional(),
          // بحث خادميّ (اسم/تاريخ/يوم) — كان محلّياً على الصفوف المُحمَّلة وحدها.
          q: z.string().trim().min(1).optional(),
          // طابور التصحيح: أيام ينقصها إغلاق (بصمة خروج مفقودة) — تُصحَّح قبل إغلاق الشهر.
          needsReviewOnly: z.boolean().optional(),
          // ترقيم خادميّ: كانت تُحمَّل كل السجلّات المطابقة دفعةً (وبلا شهر = كل التاريخ).
          limit: z.number().int().positive().max(500).default(50),
          offset: z.number().int().min(0).default(0),
        })
        .optional(),
    )
    .query(({ input }) => svc.listAttendance(input)),

  /** إعدادات احتساب الحضور (الوردية الليلية) — قراءة بـhr/READ. */
  settings: hrRead.query(() => svc.getAttendanceSettings()),

  updateSettings: hrWrite
    .input(
      z.object({
        attendancePayEnabled: z.boolean().optional(),
        attendancePayFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
        maxDailyHours: z.number().min(1).max(24).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const row = await svc.updateAttendanceSettings(input, ctx.user.id);
      await logAudit(ctx, {
        action: "attendance.updateSettings",
        entityType: "hrAttendanceSettings",
        entityId: 1,
        newValue: { attendancePayEnabled: input.attendancePayEnabled, attendancePayFrom: input.attendancePayFrom, maxDailyHours: input.maxDailyHours },
      });
      return row;
    }),

  /** مؤشّرات الشاشة — مجاميع كل المطابق للفلتر (لا الصفحة). تُستدعى بلا q: البطاقات مؤشّر
   *  الشهر/الفلتر، والبحث يُصفّي الجدول وتذييله فقط (سلوك محفوظ). */
  summary: hrRead
    .input(
      z
        .object({
          employeeId: z.number().int().positive().optional(),
          period: periodStr.optional(),
          source: z.enum(["fingerprint", "manual"]).optional(),
        })
        .optional(),
    )
    .query(({ input }) => svc.attendanceSummary(input)),

  formOptions: hrRead.query(() => svc.formOptions()),

  monthSummary: hrRead.input(z.object({ period: periodStr })).query(({ input }) => svc.monthSummary(input.period)),

  /**
   * كشف حضور موظف — صفٌّ لكل يوم (من ← إلى، الساعات، سعر الساعة، أجر اليوم) + المجاميع.
   * يبني على نواة المسيّر نفسها فلا ينحرف المعروض عن المدفوع. قراءة صرفة.
   */
  employeeStatement: hrRead
    .input(z.object({ employeeId: z.number().int().positive(), period: periodStr }))
    .query(({ input }) => getEmployeeStatement(input)),

  /** تقرير الحضور — سجلّات الحضور في نطاق تاريخ + ملخّص (بفلتر موظف اختياري). hr/READ. */
  report: hrRead
    .input(z.object({ from: dateStr, to: dateStr, employeeId: z.number().int().positive().optional() }))
    .query(({ input }) => getAttendanceReport(input)),

  record: hrWrite
    .input(
      z.object({
        employeeId: z.number().int().positive(),
        attendanceDate: dateStr,
        hours: z.number().min(0).max(24),
        checkIn: timeStr.nullish(),
        checkOut: timeStr.nullish(),
        status: z.enum(["PRESENT", "ABSENT", "LATE", "LEAVE"]).optional(),
        // الإدخال العام يدوي حصراً؛ "fingerprint" لا يأتي إلا من تكامل الجهاز الخادمي.
        source: z.literal("manual").optional(),
        notes: z.string().trim().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const row = await svc.recordAttendance({
        employeeId: input.employeeId,
        attendanceDate: input.attendanceDate,
        hours: input.hours,
        checkIn: input.checkIn ?? null,
        checkOut: input.checkOut ?? null,
        status: input.status,
        source: "manual",
        notes: input.notes ?? null,
        // فصل مهام: الساعات تتحوّل أجراً مباشرةً ⇒ لا يسجّل أحدٌ ساعات نفسه.
        actor: { userId: ctx.user.id, role: ctx.user.role },
      });
      await logAudit(ctx, {
        action: "attendance.record",
        entityType: "attendance",
        entityId: row?.id,
        newValue: {
          employeeId: input.employeeId,
          date: input.attendanceDate,
          hours: input.hours,
          amount: row?.amount,
          source: "manual",
        },
      });
      return row;
    }),
});
