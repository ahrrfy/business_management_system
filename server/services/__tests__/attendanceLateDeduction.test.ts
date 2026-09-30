/**
 * اختبارات استقطاع دقائق التأخير الصباحي (GAP-21).
 *
 * يتحقق هذا الاختبار من:
 * 1. تسجيل حضور متأخر (09:45 مع وردية 09:00 وفترة سماح 15 دقيقة):
 *    - تحول الحالة إلى LATE
 *    - استقطاع دقائق التأخير (45 دقيقة = 0.75 ساعة) من الساعات الفعلية والأجر
 *    - توثيق تفاصيل التأخير والخصم في الملاحظات notes
 * 2. تسجيل حضور في الوقت المحدد (08:55):
 *    - بقاء الحالة PRESENT
 *    - أجر كامل دون أي استقطاع
 * 3. فترة السماح (09:10 مع وردية 09:00):
 *    - عدم احتساب تأخير وبقاء الحالة PRESENT
 * 4. وردية مخصصة في جدول الدوام workSchedule (مثلاً 10:00):
 *    - مطابقة التأخير مع موعد الوردية المخصص
 * 5. تمرير lateDeductionMinutes مخصص اختيارياً للتجاوز الإداري.
 */
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createEmployee } from "../employeeService";
import { recordAttendance } from "../attendanceService";

const TABLES = [
  "accountingEntries",
  "payrollItems",
  "payrollRuns",
  "attendance",
  "leaveRequests",
  "employees",
  "auditLogs",
  "branches",
  "users",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([{ id: 1, openId: "test-admin", name: "مدير", role: "admin", branchId: 1 }]);
}

async function createTestEmployee(opts: {
  salary?: string;
  payType?: "monthly" | "hourly";
  workSchedule?: Record<string, any>;
} = {}) {
  const e = await createEmployee({
    firstName: "كرار",
    lastName: "الحسيني",
    payType: opts.payType ?? "monthly",
    salary: opts.salary ?? "900000",
    allowances: "0",
    branchId: 1,
    workSchedule: opts.workSchedule ?? null,
  });
  return e!;
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("GAP-21: احتساب دقائق التأخير وخصمها من أجر الحضور", () => {
  it("يحسب التأخير ويخصم الساعات والأجر عند تسجيل حضور متأخر (09:45 مع وردية 09:00)", async () => {
    const emp = await createTestEmployee({ salary: "900000" });

    // دوام 8 ساعات، الدخول 09:45 والانصراف 18:00 (الفترة تغطي 8.25 ساعة)
    const res = await recordAttendance({
      employeeId: emp.id,
      attendanceDate: "2026-08-03", // يوم اثنين (يوم عمل اعتيادي)
      hours: "8",
      checkIn: "09:45",
      checkOut: "18:00",
      status: "PRESENT", // لم تُحدد LATE مسبقاً، يجب أن تُكتشف تلقائياً
    });

    // 1. تحول الحالة إلى LATE
    expect(res.status).toBe("LATE");

    // 2. احتساب دقائق التأخير: 45 دقيقة (09:45 - 09:00)
    expect(res.lateMinutes).toBe(45);
    expect(res.lateDeductionMinutes).toBe(45);

    // 3. الساعات الفعلية بعد الخصم: 8 - (45 / 60) = 7.25 ساعة
    expect(Number(res.hours)).toBe(7.25);
    expect(res.effectiveHours).toBe(7.25);

    // 4. احتساب الأجر: السعر اليومي المشتق من الراتب ضرب الساعات الفعلية 7.25
    const hourlyRate = Number(res.hourlyRate);
    expect(hourlyRate).toBeGreaterThan(0);
    const expectedAmount = Math.round(7.25 * hourlyRate);
    expect(Number(res.amount)).toBe(expectedAmount);

    // 5. توثيق الملاحظات بالعلامة النصية
    expect(res.notes).toContain("[تأخير: 45 دقيقة - خصم 45 دقيقة]");
  });

  it("يمنح الأجر كاملاً دون أي خصم عند تسجيل الحضور في الموعد (08:55)", async () => {
    const emp = await createTestEmployee({ salary: "900000" });

    const res = await recordAttendance({
      employeeId: emp.id,
      attendanceDate: "2026-08-03",
      hours: "8",
      checkIn: "08:55",
      checkOut: "17:00",
      status: "PRESENT",
    });

    // الحالة تبقى PRESENT
    expect(res.status).toBe("PRESENT");
    expect(res.lateMinutes).toBeNull();
    expect(res.lateDeductionMinutes).toBeNull();

    // الساعات كاملة 8 دون أي اقتطاع
    expect(Number(res.hours)).toBe(8);
    expect(res.effectiveHours).toBe(8);

    const hourlyRate = Number(res.hourlyRate);
    expect(Number(res.amount)).toBe(Math.round(8 * hourlyRate));

    // لا يوجد أي وسم تأخير في الملاحظات
    expect(res.notes).toBeNull();
  });

  it("لا يحتسب تأخيراً إذا كان الحضور ضمن فترة السماح (09:10 مع وردية 09:00 وفترة سماح 15 دقيقة)", async () => {
    const emp = await createTestEmployee({ salary: "900000" });

    const res = await recordAttendance({
      employeeId: emp.id,
      attendanceDate: "2026-08-03",
      hours: "8",
      checkIn: "09:10",
      checkOut: "17:15",
      status: "PRESENT",
    });

    expect(res.status).toBe("PRESENT");
    expect(res.lateMinutes).toBeNull();
    expect(Number(res.hours)).toBe(8);
    expect(res.notes).toBeNull();
  });

  it("يعتمد موعد الوردية المخصص من جدول دوام الموظف (workSchedule)", async () => {
    // موظف ورديته تبدأ في الساعة 10:00 صباحاً
    const customSchedule = {
      الاثنين: { hours: 8, start: "10:00" },
    };
    const emp = await createTestEmployee({ salary: "900000", workSchedule: customSchedule });

    // حضور الساعة 10:10 (ضمن فترة السماح 15 دقيقة للوردية 10:00) -> غير متأخر
    const onTimeRes = await recordAttendance({
      employeeId: emp.id,
      attendanceDate: "2026-08-03", // الاثنين
      hours: "8",
      checkIn: "10:10",
      checkOut: "18:15",
    });
    expect(onTimeRes.status).toBe("PRESENT");
    expect(Number(onTimeRes.hours)).toBe(8);

    // حضور الساعة 10:40 (متأخر 40 دقيقة عن 10:00) -> متأخر ويُخصم 40 دقيقة
    const lateRes = await recordAttendance({
      employeeId: emp.id,
      attendanceDate: "2026-08-10", // الاثنين التالي
      hours: "8",
      checkIn: "10:40",
      checkOut: "18:45",
    });
    expect(lateRes.status).toBe("LATE");
    expect(lateRes.lateMinutes).toBe(40);
    expect(lateRes.lateDeductionMinutes).toBe(40);
    // 8 - (40 / 60) = 8 - 0.6666... = 7.33
    expect(Number(lateRes.hours)).toBeCloseTo(7.33, 2);
    expect(lateRes.notes).toContain("[تأخير: 40 دقيقة - خصم 40 دقيقة]");
  });

  it("يدعم التجاوز الإداري لدقائق الاستقطاع عبر lateDeductionMinutes", async () => {
    const emp = await createTestEmployee({ salary: "900000" });

    // الموظف تأخر 60 دقيقة (حضر 10:00 بدلاً من 09:00)، لكن الإدارة قررت خصم 20 دقيقة فقط
    const res = await recordAttendance({
      employeeId: emp.id,
      attendanceDate: "2026-08-03",
      hours: "8",
      checkIn: "10:00",
      checkOut: "18:00",
      lateDeductionMinutes: 20,
    });

    expect(res.status).toBe("LATE");
    expect(res.lateMinutes).toBe(60);
    expect(res.lateDeductionMinutes).toBe(20);

    // الخصم المحسوب يكون 20 دقيقة فقط: 8 - (20 / 60) = 7.67 ساعة
    expect(Number(res.hours)).toBeCloseTo(7.67, 2);
    expect(res.notes).toContain("[تأخير: 60 دقيقة - خصم 20 دقيقة]");
  });
});
