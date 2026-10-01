/**
 * الاختبارات العكسية والعدائية لاستقطاع دقائق التأخير الصباحي والأثر المالي (GAP-21).
 * Adversarial & Empirical Stress Test Suite for GAP-21 Attendance Late Deduction.
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

import { ensureFinancialPostingGate } from "../reports/monthCloseGate";

async function seedBase() {
  const d = db();
  await ensureFinancialPostingGate(d);
  await d.insert(s.branches).values([{ id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([{ id: 1, openId: "test-admin", name: "مدير", role: "admin", branchId: 1 }]);
}

async function createTestEmployee(opts: {
  salary?: string;
  payType?: "monthly" | "hourly";
  workSchedule?: Record<string, any>;
  dayRates?: Record<string, number>;
} = {}) {
  const e = await createEmployee({
    firstName: "علي",
    lastName: "العراقي",
    payType: opts.payType ?? "monthly",
    salary: opts.salary ?? "900000",
    allowances: "0",
    branchId: 1,
    workSchedule: opts.workSchedule ?? null,
    dayRates: opts.dayRates ?? null,
  });
  return e!;
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe.sequential("Adversarial Verification of GAP-21: Attendance Late Deduction & Monetary Impact", () => {
  // --------------------------------------------------------------------------
  // Requirement 1: Late check-in beyond grace period (09:30 for 09:00 shift with 15m grace)
  // --------------------------------------------------------------------------
  it("R1: late check-in at 09:30 (09:00 shift, 15m grace) -> status=LATE, 30m deduction, proportional amount, notes tag", async () => {
    // موظف شهري براتب 900,000 د.ع
    const emp = await createTestEmployee({ salary: "900000" });

    const res = await recordAttendance({
      employeeId: emp.id,
      attendanceDate: "2026-08-03", // الاثنين (يوم عمل اعتيادي 8 ساعات)
      hours: "8",
      checkIn: "09:30",
      checkOut: "17:30",
    });

    // 1. الحالة LATE
    expect(res.status).toBe("LATE");

    // 2. خصم 30 دقيقة = 0.5 ساعة من الساعات المؤداة (8 - 0.5 = 7.5)
    expect(res.lateMinutes).toBe(30);
    expect(res.lateDeductionMinutes).toBe(30);
    expect(Number(res.hours)).toBe(7.5);
    expect(res.effectiveHours).toBe(7.5);

    // 3. تخفيض الأجر تناسبياً وبلا أخطاء فاصلة عائمة
    const hourlyRate = Number(res.hourlyRate);
    expect(hourlyRate).toBeGreaterThan(0);
    const expectedAmount = Math.round(7.5 * hourlyRate);
    expect(Number(res.amount)).toBe(expectedAmount);

    // 4. توثيق الملاحظات بالعلامة الدقيقة
    expect(res.notes).toContain("[تأخير: 30 دقيقة - خصم 30 دقيقة]");
  });

  // --------------------------------------------------------------------------
  // Requirement 2: On-time check-in (08:50 or 09:10 within grace period)
  // --------------------------------------------------------------------------
  it("R2a: on-time check-in before shift start (08:50) -> status=PRESENT, 0 deduction, full amount", async () => {
    const emp = await createTestEmployee({ salary: "900000" });

    const res = await recordAttendance({
      employeeId: emp.id,
      attendanceDate: "2026-08-03",
      hours: "8",
      checkIn: "08:50",
      checkOut: "17:00",
    });

    expect(res.status).toBe("PRESENT");
    expect(res.lateMinutes).toBeNull();
    expect(res.lateDeductionMinutes).toBeNull();
    expect(Number(res.hours)).toBe(8);
    expect(res.effectiveHours).toBe(8);
    expect(Number(res.amount)).toBe(Math.round(8 * Number(res.hourlyRate)));
    expect(res.notes).toBeNull();
  });

  it("R2b: on-time check-in within grace period (09:10 for 09:00 shift) -> status=PRESENT, 0 deduction", async () => {
    const emp = await createTestEmployee({ salary: "900000" });

    const res = await recordAttendance({
      employeeId: emp.id,
      attendanceDate: "2026-08-03",
      hours: "8",
      checkIn: "09:10",
      checkOut: "17:15",
    });

    expect(res.status).toBe("PRESENT");
    expect(res.lateMinutes).toBeNull();
    expect(res.lateDeductionMinutes).toBeNull();
    expect(Number(res.hours)).toBe(8);
    expect(res.notes).toBeNull();
  });

  it("R2c: boundary test at exactly 15m grace limit (09:15) vs 1m past (09:16)", async () => {
    const emp = await createTestEmployee({ salary: "900000" });

    // الساعة 09:15 تماماً: ضمن فترة السماح (15 دقيقة) -> PRESENT
    const resOnLimit = await recordAttendance({
      employeeId: emp.id,
      attendanceDate: "2026-08-03",
      hours: "8",
      checkIn: "09:15",
      checkOut: "17:15",
    });
    expect(resOnLimit.status).toBe("PRESENT");
    expect(resOnLimit.lateMinutes).toBeNull();
    expect(Number(resOnLimit.hours)).toBe(8);

    // الساعة 09:16 (دقيقة واحدة بعد السماح) -> LATE مع خصم 16 دقيقة
    const resOverLimit = await recordAttendance({
      employeeId: emp.id,
      attendanceDate: "2026-08-04",
      hours: "8",
      checkIn: "09:16",
      checkOut: "17:16",
    });
    expect(resOverLimit.status).toBe("LATE");
    expect(resOverLimit.lateMinutes).toBe(16);
    expect(resOverLimit.lateDeductionMinutes).toBe(16);
    // 8 - (16 / 60) = 8 - 0.26666... = 7.733333333333333
    expect(Number(resOverLimit.hours)).toBeCloseTo(7.73, 2);
    expect(resOverLimit.notes).toContain("[تأخير: 16 دقيقة - خصم 16 دقيقة]");
  });

  // --------------------------------------------------------------------------
  // Requirement 3: Edge case - workSchedule starting at 10:00 vs default 09:00
  // --------------------------------------------------------------------------
  it("R3: custom workSchedule starting at 10:00 vs default 09:00", async () => {
    const customSchedule = {
      الاثنين: { hours: 8, start: "10:00" },
      الثلاثاء: { hours: 8, startTime: "10:30" }, // دعم صيغة startTime أيضاً
    };
    const emp = await createTestEmployee({ salary: "900000", workSchedule: customSchedule });

    // يوم الاثنين: الحضور 09:55 (قبل 10:00) -> PRESENT
    const earlyRes = await recordAttendance({
      employeeId: emp.id,
      attendanceDate: "2026-08-03", // الاثنين
      hours: "8",
      checkIn: "09:55",
      checkOut: "18:00",
    });
    expect(earlyRes.status).toBe("PRESENT");
    expect(Number(earlyRes.hours)).toBe(8);

    // يوم الاثنين: الحضور 10:12 (ضمن سماح 15 دقيقة بعد 10:00) -> PRESENT
    const graceRes = await recordAttendance({
      employeeId: emp.id,
      attendanceDate: "2026-08-10", // الاثنين التالي
      hours: "8",
      checkIn: "10:12",
      checkOut: "18:15",
    });
    expect(graceRes.status).toBe("PRESENT");
    expect(Number(graceRes.hours)).toBe(8);

    // يوم الاثنين: الحضور 10:35 (تأخير 35 دقيقة عن 10:00) -> LATE
    const lateRes = await recordAttendance({
      employeeId: emp.id,
      attendanceDate: "2026-08-17", // الاثنين
      hours: "8",
      checkIn: "10:35",
      checkOut: "18:35",
    });
    expect(lateRes.status).toBe("LATE");
    expect(lateRes.lateMinutes).toBe(35);
    expect(lateRes.lateDeductionMinutes).toBe(35);
    expect(Number(lateRes.hours)).toBeCloseTo(8 - 35 / 60, 2);
    expect(lateRes.notes).toContain("[تأخير: 35 دقيقة - خصم 35 دقيقة]");

    // يوم الثلاثاء (وردية 10:30 عبر startTime): الحضور 11:00 (تأخير 30 دقيقة)
    const tuesdayRes = await recordAttendance({
      employeeId: emp.id,
      attendanceDate: "2026-08-04", // الثلاثاء
      hours: "8",
      checkIn: "11:00",
      checkOut: "19:00",
    });
    expect(tuesdayRes.status).toBe("LATE");
    expect(tuesdayRes.lateMinutes).toBe(30);
    expect(tuesdayRes.lateDeductionMinutes).toBe(30);
    expect(Number(tuesdayRes.hours)).toBe(7.5);
    expect(tuesdayRes.notes).toContain("[تأخير: 30 دقيقة - خصم 30 دقيقة]");
  });

  // --------------------------------------------------------------------------
  // Requirement 4: Manual override - passing explicit lateDeductionMinutes
  // --------------------------------------------------------------------------
  it("R4a: manual override reducing deduction (45m late, admin deducts only 15m)", async () => {
    const emp = await createTestEmployee({ salary: "900000" });

    const res = await recordAttendance({
      employeeId: emp.id,
      attendanceDate: "2026-08-03",
      hours: "8",
      checkIn: "09:45",
      checkOut: "17:45",
      lateDeductionMinutes: 15,
    });

    expect(res.status).toBe("LATE");
    expect(res.lateMinutes).toBe(45);
    expect(res.lateDeductionMinutes).toBe(15);
    // 8 - (15 / 60) = 7.75
    expect(Number(res.hours)).toBe(7.75);
    expect(res.notes).toContain("[تأخير: 45 دقيقة - خصم 15 دقيقة]");
  });

  it("R4b: admin waives deduction entirely (lateDeductionMinutes = 0)", async () => {
    const emp = await createTestEmployee({ salary: "900000" });

    const res = await recordAttendance({
      employeeId: emp.id,
      attendanceDate: "2026-08-03",
      hours: "8",
      checkIn: "09:30",
      checkOut: "17:30",
      lateDeductionMinutes: 0,
    });

    expect(res.status).toBe("LATE");
    expect(res.lateMinutes).toBe(30);
    expect(res.lateDeductionMinutes).toBe(0);
    // الساعات تبقى كاملة 8 دون أي خصم
    expect(Number(res.hours)).toBe(8);
    expect(res.effectiveHours).toBe(8);
    expect(res.notes).toContain("[تأخير: 30 دقيقة - خصم 0 دقيقة]");
  });

  // --------------------------------------------------------------------------
  // Stress & Edge Cases: Hourly worker, Excessive deduction, Notes preservation, UPSERT
  // --------------------------------------------------------------------------
  it("Stress 1: Hourly employee - exact monetary arithmetic without float errors", async () => {
    // موظف بأجر ساعي قدره 10,000 د.ع لكل ساعة
    const emp = await createTestEmployee({
      payType: "hourly",
      dayRates: { الاثنين: 10000 },
    });

    // تأخر 30 دقيقة (09:30): الساعات 8 -> تصبح 7.5
    // الأجر الأصلي 8 * 10,000 = 80,000
    // الأجر المستحق 7.5 * 10,000 = 75,000 د.ع بالضبط دون أي كسور أو خطأ فاصلة عائمة
    const res = await recordAttendance({
      employeeId: emp.id,
      attendanceDate: "2026-08-03",
      hours: "8",
      checkIn: "09:30",
      checkOut: "17:30",
    });

    expect(res.status).toBe("LATE");
    expect(Number(res.hourlyRate)).toBe(10000);
    expect(Number(res.hours)).toBe(7.5);
    expect(Number(res.amount)).toBe(75000); // 75,000 د.ع دقيق
  });

  it("Stress 2: Excessive late deduction exceeds total hours -> clamps to 0 cleanly without negative values", async () => {
    const emp = await createTestEmployee({ salary: "900000" });

    // ساعات العمل 4 ساعات، لكن التأخير أو الخصم المحدد 300 دقيقة (5 ساعات)
    const res = await recordAttendance({
      employeeId: emp.id,
      attendanceDate: "2026-08-03",
      hours: "4",
      checkIn: "14:00", // متأخر 5 ساعات عن 09:00
      checkOut: "18:00",
      lateDeductionMinutes: 300,
    });

    expect(res.status).toBe("LATE");
    // الساعات لا تكون سالبة أبداً: Decimal.max(0, ...) -> 0
    expect(Number(res.hours)).toBe(0);
    expect(res.effectiveHours).toBe(0);
    expect(Number(res.amount)).toBe(0);
  });

  it("Stress 3: Preserves existing notes and avoids duplicate tags", async () => {
    const emp = await createTestEmployee({ salary: "900000" });

    const res = await recordAttendance({
      employeeId: emp.id,
      attendanceDate: "2026-08-03",
      hours: "8",
      checkIn: "09:30",
      checkOut: "17:30",
      notes: "إذن مسبق من المشرف",
    });

    expect(res.notes).toBe("إذن مسبق من المشرف [تأخير: 30 دقيقة - خصم 30 دقيقة]");

    // تعديل السجل وتمرير نفس الملاحظات لا يكرر الوسم
    const res2 = await recordAttendance({
      employeeId: emp.id,
      attendanceDate: "2026-08-03",
      hours: "8",
      checkIn: "09:30",
      checkOut: "17:30",
      notes: res.notes!,
    });

    const matches = res2.notes?.match(/\[تأخير:/g);
    expect(matches?.length).toBe(1);
  });

  it("Stress 4: UPSERT correction - converting LATE record to PRESENT clears late deduction", async () => {
    const emp = await createTestEmployee({ salary: "900000" });

    // إدخال أول كمتأخر 09:30
    const res1 = await recordAttendance({
      employeeId: emp.id,
      attendanceDate: "2026-08-03",
      hours: "8",
      checkIn: "09:30",
      checkOut: "17:30",
    });
    expect(res1.status).toBe("LATE");
    expect(Number(res1.hours)).toBe(7.5);

    // تصحيح السجل بنفس التاريخ إلى 08:55 (حضور في الموعد)
    const res2 = await recordAttendance({
      employeeId: emp.id,
      attendanceDate: "2026-08-03",
      hours: "8",
      checkIn: "08:55",
      checkOut: "17:00",
      status: "PRESENT",
      notes: null,
    });

    expect(res2.status).toBe("PRESENT");
    expect(res2.lateMinutes).toBeNull();
    expect(res2.lateDeductionMinutes).toBeNull();
    expect(Number(res2.hours)).toBe(8);
    expect(res2.effectiveHours).toBe(8);
    expect(res2.notes).toBeNull();
  });
});
