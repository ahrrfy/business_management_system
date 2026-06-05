import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { biometricService } from "../services/biometricService";
import { TRPCError } from "@trpc/server";

/**
 * ====================================
 * API البصمة والحضور والانصراف
 * ====================================
 */

const BiometricDataSchema = z.object({
  employeeId: z.number().min(1),
  fingerprint: z.string(),
  deviceId: z.string(),
});

export const biometricRouter = router({
  /**
   * تسجيل البصمة (حضور/انصراف)
   */
  recordBiometric: protectedProcedure
    .input(BiometricDataSchema)
    .mutation(async ({ input }) => {
      try {
        const result = await biometricService.processBiometricData({
          ...input,
          timestamp: new Date(),
        });

        return {
          success: result.success,
          message: result.message,
          attendanceId: result.attendanceId,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message,
        });
      }
    }),

  /**
   * الحصول على سجل الحضور لموظف
   */
  getAttendanceRecord: protectedProcedure
    .input(
      z.object({
        employeeId: z.number().min(1),
        date: z.date().optional(),
      })
    )
    .query(async ({ input }) => {
      try {
        const date = input.date || new Date();
        const record = await biometricService.getAttendanceRecord(
          input.employeeId,
          date
        );

        return {
          success: true,
          data: record,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message,
        });
      }
    }),

  /**
   * تقرير الحضور الشهري
   */
  getMonthlyReport: protectedProcedure
    .input(
      z.object({
        employeeId: z.number().min(1),
        year: z.number().min(2020),
        month: z.number().min(1).max(12),
      })
    )
    .query(async ({ input }) => {
      try {
        const report = await biometricService.getMonthlyAttendanceReport(
          input.employeeId,
          input.year,
          input.month
        );

        return {
          success: true,
          data: report,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message,
        });
      }
    }),

  /**
   * التحقق من التأخر
   */
  checkLateArrival: protectedProcedure
    .input(
      z.object({
        employeeId: z.number().min(1),
        workStartTime: z.string().optional(),
      })
    )
    .query(async ({ input }) => {
      try {
        const result = await biometricService.checkLateArrival(
          input.employeeId,
          input.workStartTime
        );

        return {
          success: true,
          data: result,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message,
        });
      }
    }),

  /**
   * حساب الراتب من ساعات العمل
   */
  calculateSalary: protectedProcedure
    .input(
      z.object({
        totalWorkHours: z.number().min(0),
        hourlyRate: z.number().min(0),
        overtimeMultiplier: z.number().min(1).optional(),
      })
    )
    .query(async ({ input }) => {
      try {
        const salary = biometricService.calculateSalaryFromWorkHours(
          input.totalWorkHours,
          input.hourlyRate,
          input.overtimeMultiplier
        );

        return {
          success: true,
          data: salary,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message,
        });
      }
    }),

  /**
   * تصدير تقرير الحضور
   */
  exportReport: protectedProcedure
    .input(
      z.object({
        employeeId: z.number().min(1),
        year: z.number().min(2020),
        month: z.number().min(1).max(12),
      })
    )
    .query(async ({ input }) => {
      try {
        const csv = await biometricService.exportAttendanceReport(
          input.employeeId,
          input.year,
          input.month
        );

        return {
          success: true,
          data: csv,
          filename: `attendance_${input.employeeId}_${input.year}_${input.month}.csv`,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message,
        });
      }
    }),
});
