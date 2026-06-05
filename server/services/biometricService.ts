import { getDb } from "../db";
import { attendance, employees } from "../../drizzle/schema";
import { eq } from "drizzle-orm";

/**
 * ====================================
 * خدمة تكامل أجهزة البصمة
 * ====================================
 * 
 * هذه الخدمة توفر:
 * - تسجيل الحضور والانصراف بالبصمة
 * - معالجة بيانات البصمة من الأجهزة
 * - حساب ساعات العمل
 * - تقارير الحضور والغياب
 * - التكامل مع أجهزة البصمة المختلفة
 */

export interface BiometricData {
  employeeId: number;
  fingerprint: string;
  timestamp: Date;
  deviceId: string;
}

export interface AttendanceRecord {
  employeeId: number;
  date: Date;
  checkInTime: Date;
  checkOutTime?: Date;
  workHours?: number;
  status: "PRESENT" | "ABSENT" | "LATE" | "LEAVE";
}

export class BiometricService {
  /**
   * معالجة بيانات البصمة من الجهاز
   */
  async processBiometricData(data: BiometricData): Promise<{
    success: boolean;
    message: string;
    attendanceId?: number;
  }> {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    try {
      // التحقق من وجود الموظف
      const employee = await db
        .select()
        .from(employees)
        .where(eq(employees.id, data.employeeId))
        .limit(1);

      if (!employee.length) {
        return {
          success: false,
          message: `الموظف ${data.employeeId} غير موجود`,
        };
      }

      const today = new Date(data.timestamp);
      today.setHours(0, 0, 0, 0);

      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      // البحث عن سجل الحضور لليوم
      const existingAttendance = await db
        .select()
        .from(attendance)
        .where(
          eq(attendance.employeeId, data.employeeId)
        )
        .limit(1);

      let attendanceRecord;

      if (existingAttendance.length > 0) {
        // تحديث وقت الانصراف
        const record = existingAttendance[0];

        if (!record.checkOut) {
          // حساب ساعات العمل
          const checkInTime = new Date(record.checkIn!);
          const checkOutTime = new Date(data.timestamp);
          const workHours =
            (checkOutTime.getTime() - checkInTime.getTime()) / (1000 * 60 * 60);

          // تحديد الحالة
          let status = "PRESENT";
          if (workHours < 8) {
            status = "LATE"; // إذا كان أقل من 8 ساعات
          }

          await db
            .update(attendance)
            .set({
              checkOut: data.timestamp,
              status: status as any,
            })
            .where(eq(attendance.id, record.id));

          attendanceRecord = {
            ...record,
            checkOut: data.timestamp,
            status: status as any,
            workHours,
          };

          return {
            success: true,
            message: `تم تسجيل الانصراف - ساعات العمل: ${workHours.toFixed(2)} ساعة`,
            attendanceId: record.id as any,
          };
        } else {
          return {
            success: false,
            message: "تم تسجيل الانصراف بالفعل لهذا اليوم",
          };
        }
      } else {
        // إنشاء سجل حضور جديد
        const result = await db.insert(attendance).values({
          employeeId: data.employeeId,
          attendanceDate: today,
          checkIn: data.timestamp,
          status: "PRESENT",
        });

        return {
          success: true,
          message: `تم تسجيل الحضور في ${data.timestamp.toLocaleTimeString("ar-SA")}`,
          attendanceId: result[0].insertId as any,
        };
      }
    } catch (error) {
      console.error("[BiometricService] Error processing biometric data:", error);
      throw error;
    }
  }

  /**
   * الحصول على سجل الحضور لموظف في يوم معين
   */
  async getAttendanceRecord(
    employeeId: number,
    date: Date
  ): Promise<AttendanceRecord | null> {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    try {
      const startOfDay = new Date(date);
      startOfDay.setHours(0, 0, 0, 0);

      const record = await db
        .select()
        .from(attendance)
        .where(eq(attendance.employeeId, employeeId))
        .limit(1);

      if (!record.length) {
        return null;
      }

      const att = record[0];
      let workHours = 0;

      if (att.checkIn && att.checkOut) {
        workHours =
          (new Date(att.checkOut).getTime() -
            new Date(att.checkIn).getTime()) /
          (1000 * 60 * 60);
      }

      return {
        employeeId,
        date: new Date(att.attendanceDate),
        checkInTime: new Date(att.checkIn!),
        checkOutTime: att.checkOut ? new Date(att.checkOut) : undefined,
        workHours,
        status: att.status as any,
      };
    } catch (error) {
      console.error("[BiometricService] Error getting attendance record:", error);
      throw error;
    }
  }

  /**
   * الحصول على تقرير الحضور الشهري
   */
  async getMonthlyAttendanceReport(
    employeeId: number,
    year: number,
    month: number
  ) {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    try {
      const startDate = new Date(year, month - 1, 1);
      const endDate = new Date(year, month, 0);

      const records = await db
        .select()
        .from(attendance)
        .where(eq(attendance.employeeId, employeeId));

      const presentDays = records.filter((r) => r.status === "PRESENT").length;
      const absentDays = records.filter((r) => r.status === "ABSENT").length;
      const lateDays = records.filter((r) => r.status === "LATE").length;
      const leaveDays = records.filter((r) => r.status === "LEAVE").length;

      const totalWorkHours = records.reduce((sum, record) => {
        if (record.checkIn && record.checkOut) {
          const hours =
            (new Date(record.checkOut).getTime() -
              new Date(record.checkIn).getTime()) /
            (1000 * 60 * 60);
          return sum + hours;
        }
        return sum;
      }, 0);

      return {
        employeeId,
        year,
        month,
        presentDays,
        absentDays,
        lateDays,
        leaveDays,
        totalWorkHours: totalWorkHours.toFixed(2),
        workingDays: presentDays + lateDays,
        attendanceRate:
          ((presentDays + lateDays) / (presentDays + absentDays + lateDays)) *
          100,
      };
    } catch (error) {
      console.error(
        "[BiometricService] Error getting monthly attendance report:",
        error
      );
      throw error;
    }
  }

  /**
   * التحقق من تأخر الموظف
   */
  async checkLateArrival(employeeId: number, workStartTime: string = "08:00") {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const record = await db
        .select()
        .from(attendance)
        .where(eq(attendance.employeeId, employeeId))
        .limit(1);

      if (!record.length || !record[0].checkIn) {
        return { isLate: false };
      }

      const checkInTime = new Date(record[0].checkIn);
      const [hours, minutes] = workStartTime.split(":").map(Number);
      const expectedStartTime = new Date(today);
      expectedStartTime.setHours(hours, minutes, 0, 0);

      const isLate = checkInTime > expectedStartTime;
      const lateMinutes = isLate
        ? Math.floor(
            (checkInTime.getTime() - expectedStartTime.getTime()) / (1000 * 60)
          )
        : 0;

      return {
        isLate,
        lateMinutes,
        checkInTime,
        expectedStartTime,
      };
    } catch (error) {
      console.error("[BiometricService] Error checking late arrival:", error);
      throw error;
    }
  }

  /**
   * حساب الراتب بناءً على ساعات العمل
   */
  calculateSalaryFromWorkHours(
    totalWorkHours: number,
    hourlyRate: number,
    overtimeMultiplier: number = 1.5
  ) {
    const standardHours = 8 * 22; // 8 ساعات × 22 يوم عمل
    const baseSalary = standardHours * hourlyRate;

    if (totalWorkHours > standardHours) {
      const overtimeHours = totalWorkHours - standardHours;
      const overtimePay = overtimeHours * hourlyRate * overtimeMultiplier;
      return {
        baseSalary,
        overtimePay,
        totalSalary: baseSalary + overtimePay,
      };
    }

    return {
      baseSalary,
      overtimePay: 0,
      totalSalary: baseSalary,
    };
  }

  /**
   * تصدير تقرير الحضور إلى CSV
   */
  async exportAttendanceReport(
    employeeId: number,
    year: number,
    month: number
  ): Promise<string> {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    try {
      const records = await db
        .select()
        .from(attendance)
        .where(eq(attendance.employeeId, employeeId));

      let csv = "التاريخ,الحضور,الانصراف,ساعات العمل,الحالة\n";

      for (const record of records) {
        const date = new Date(record.attendanceDate).toLocaleDateString("ar-SA");
        const checkIn = record.checkIn
          ? new Date(record.checkIn).toLocaleTimeString("ar-SA")
          : "-";
        const checkOut = record.checkOut
          ? new Date(record.checkOut).toLocaleTimeString("ar-SA")
          : "-";

        let workHours = "-";
        if (record.checkIn && record.checkOut) {
          const hours =
            (new Date(record.checkOut).getTime() -
              new Date(record.checkIn).getTime()) /
            (1000 * 60 * 60);
          workHours = hours.toFixed(2);
        }

        csv += `${date},${checkIn},${checkOut},${workHours},${record.status}\n`;
      }

      return csv;
    } catch (error) {
      console.error("[BiometricService] Error exporting attendance report:", error);
      throw error;
    }
  }
}

export const biometricService = new BiometricService();
