/* ============================================================================
 * موجّه tRPC للحضور والانصراف — وحدة الموارد البشرية (server/routers/attendanceRouter.ts)
 * القراءة بصلاحية hr/READ والكتابة بـ hr/FULL (requireModule). كل كتابة تُدقَّق (logAudit).
 * يُركَّب من قبل قائد التكامل تحت المسار trpc.attendance.
 * ========================================================================== */
import { z } from "zod";
import { logAudit } from "../services/auditService";
import * as svc from "../services/attendanceService";
import { getAttendanceReport } from "../services/reportsHrService";
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
        })
        .optional(),
    )
    .query(({ input }) => svc.listAttendance(input)),

  formOptions: hrRead.query(() => svc.formOptions()),

  monthSummary: hrRead.input(z.object({ period: periodStr })).query(({ input }) => svc.monthSummary(input.period)),

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
        source: z.enum(["fingerprint", "manual"]).optional(),
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
        source: input.source ?? "manual",
        notes: input.notes ?? null,
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
          source: input.source ?? "manual",
        },
      });
      return row;
    }),
});
