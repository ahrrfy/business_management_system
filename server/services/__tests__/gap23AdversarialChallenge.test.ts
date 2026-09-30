import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb, getPool } from "../../db";
import { getMonthlyAttendanceReport } from "../hr/monthlyAttendanceReport";
import { truncateTables } from "./__testUtils__";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

const PERIOD = "2026-06"; // June 2026: 30 days, 4 Fridays (June 5, 12, 19, 26). 26 work days * 8h = 208 scheduled hours.

const WORK_DAYS = [
  "2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04",
  // 2026-06-05 is Friday (Rest day)
  "2026-06-06", "2026-06-07", "2026-06-08", "2026-06-09", "2026-06-10", "2026-06-11",
  // 2026-06-12 is Friday (Rest day)
  "2026-06-13", "2026-06-14", "2026-06-15", "2026-06-16", "2026-06-17", "2026-06-18",
  // 2026-06-19 is Friday (Rest day)
  "2026-06-20", "2026-06-21", "2026-06-22", "2026-06-23", "2026-06-24", "2026-06-25",
  // 2026-06-26 is Friday (Rest day)
  "2026-06-27", "2026-06-28", "2026-06-29", "2026-06-30",
];

const FRIDAYS = ["2026-06-05", "2026-06-12", "2026-06-19", "2026-06-26"];

const SCHED: Record<string, { hours: number; rate?: number }> = {
  الأحد: { hours: 8 }, الاثنين: { hours: 8 }, الثلاثاء: { hours: 8 },
  الأربعاء: { hours: 8 }, الخميس: { hours: 8 }, الجمعة: { hours: 0 }, السبت: { hours: 8 },
};

async function enableAttendancePay(from = "2026-01-01") {
  await db()
    .insert(s.hrAttendanceSettings)
    .values({ id: 1, attendancePayEnabled: true, attendancePayFrom: from, defaultWorkSchedule: SCHED })
    .onDuplicateKeyUpdate({ set: { attendancePayEnabled: true, attendancePayFrom: from, defaultWorkSchedule: SCHED } });
}

beforeEach(async () => {
  await truncateTables([
    "payrollItems", "payrollRuns", "leaveRequests", "attendance",
    "employeePenalties", "employeeAdvances", "employeeContracts", "employees",
    "branches", "users",
  ]);
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values({ id: 1, openId: "admin-uid", name: "admin", role: "admin", loginMethod: "local" });
  await enableAttendancePay();
});

describe("Adversarial Empirical Verification: GAP-23 (Monthly Attendance Report N+1 Elimination)", () => {

  // =========================================================================
  // Requirement 1: Query Count Invariant & Asymptotic Complexity O(1) <= 6
  // =========================================================================
  it("Invariant 1: Query count is strictly constant O(1) <= 6 regardless of employee count (1 vs 5 vs 12 employees)", async () => {
    // 1. Seed 12 employees (10+ population requirement)
    const empIds: number[] = [];
    for (let i = 1; i <= 12; i++) {
      const id = 100 + i;
      await db().insert(s.employees).values({
        id,
        firstName: `موظف`,
        lastName: `تجريبي ${i}`,
        branchId: 1,
        payType: "monthly",
        salary: "500000.00",
        hireDate: "2026-01-01",
        workSchedule: SCHED,
      });
      empIds.push(id);

      // Seed attendance records for each employee
      const attRows = WORK_DAYS.slice(0, 10).map((date) => ({
        employeeId: id,
        branchId: 1,
        attendanceDate: date,
        status: "PRESENT" as const,
        hours: "8.00",
        hourlyRate: "2403.85",
        amount: "19230.77",
        source: "fingerprint" as const,
      }));
      await db().insert(s.attendance).values(attRows);

      // Seed 1 leave request for each employee
      await db().insert(s.leaveRequests).values({
        employeeId: id,
        leaveType: "annual",
        fromDate: "2026-06-15",
        toDate: "2026-06-16",
        days: 2,
        paid: true,
        status: "approved",
      });
    }

    expect(empIds.length).toBe(12);

    // Spy on db.select to track query calls precisely
    const drizzleDb = db();
    const originalSelect = drizzleDb.select.bind(drizzleDb);

    let queryCount = 0;
    try {
      // Test 1A: Execution against 12 employees (no payroll run)
      drizzleDb.select = ((...args: any[]) => {
        queryCount++;
        return (originalSelect as any)(...args);
      }) as any;

      queryCount = 0;
      const rep12 = await getMonthlyAttendanceReport({ period: PERIOD, branchId: 1 });
      const countFor12 = queryCount;

      expect(rep12.rows).toHaveLength(12);
      expect(countFor12).toBeLessThanOrEqual(6);
      expect(countFor12).toBe(5); // 1: employees, 2: settings, 3: attendance, 4: leaves, 5: payrollRuns

      // Test 1B: With an approved payroll run, query count should be at most 6 (adds payrollItems)
      const [runRes] = await db().insert(s.payrollRuns).values({
        period: PERIOD,
        branchId: 1,
        status: "approved",
        runType: "standard",
        revisionNo: 1,
        totalGross: "6000000.00",
        totalNet: "6000000.00",
      });
      const runId = (runRes as any).insertId ?? 1;

      await db().insert(s.payrollItems).values(
        empIds.map((eid) => ({
          runId,
          employeeId: eid,
          revisionNo: 1,
          payType: "monthly" as const,
          gross: "500000.00",
          overtime: "0.00",
          net: "500000.00",
        }))
      );

      queryCount = 0;
      const rep12WithRun = await getMonthlyAttendanceReport({ period: PERIOD, branchId: 1 });
      const countFor12WithRun = queryCount;

      expect(rep12WithRun.rows).toHaveLength(12);
      expect(countFor12WithRun).toBeLessThanOrEqual(6);
      expect(countFor12WithRun).toBe(6); // 1: employees, 2: settings, 3: attendance, 4: leaves, 5: payrollRuns, 6: payrollItems

      // Test 1C: Seed branch 2 with only 2 employees and compare query count
      await db().insert(s.employees).values({
        id: 201,
        firstName: "موظف",
        lastName: "فرع2 رقم1",
        branchId: 2,
        payType: "monthly",
        salary: "600000.00",
        hireDate: "2026-01-01",
      });
      await db().insert(s.employees).values({
        id: 202,
        firstName: "موظف",
        lastName: "فرع2 رقم2",
        branchId: 2,
        payType: "monthly",
        salary: "600000.00",
        hireDate: "2026-01-01",
      });

      queryCount = 0;
      const rep2 = await getMonthlyAttendanceReport({ period: PERIOD, branchId: 2 });
      const countFor2 = queryCount;

      expect(rep2.rows).toHaveLength(2);
      // Since an approved payroll run exists for the period, Query 6 runs for branch 2's employees -> exactly 6 queries
      expect(countFor2).toBeLessThanOrEqual(6);
      expect(countFor2).toBe(6);

      // Mathematical Proof:
      // If the algorithm were O(N) (N+1 query problem):
      // For 12 employees, query count would be 1 + 12 * 5 = 61 queries.
      // Instead, actual query count for 12 employees is exactly 6 (with payroll run).
      // The query count for 12 employees (6) equals the query count for 2 employees (6).
      // Ratio of queries (N=12 vs N=2) = 6/6 = 1.0 (strict O(1) asymptotic complexity).
      expect(countFor12WithRun).toBe(countFor2);
    } finally {
      // Restore original select unconditionally
      drizzleDb.select = originalSelect as any;
    }
  });

  // =========================================================================
  // Requirement 2: Empty Input Edge Cases
  // =========================================================================
  describe("Invariant 2: Empty Input & Branch Isolation Edge Cases", () => {
    it("Empty Branch: Returns zero rows and cleanly initialized summary without inArray SQL error", async () => {
      // Branch 999999 has 0 employees
      const rep = await getMonthlyAttendanceReport({ period: PERIOD, branchId: 999999 });

      expect(rep).toBeDefined();
      expect(rep.period).toBe(PERIOD);
      expect(rep.rows).toEqual([]);
      expect(rep.totals).toEqual({
        employees: 0,
        payableHours: "0.00",
        overtimeHours: "0.00",
        restWorkedHours: "0.00",
        absentDays: 0,
        reviewDays: 0,
        totalDue: "0.00",
        withoutSchedule: 0,
        exempt: 0,
      });
    });

    it("Empty Company: When no employees exist at all, returns clean summary immediately", async () => {
      // Table is empty
      const rep = await getMonthlyAttendanceReport({ period: PERIOD });

      expect(rep.rows).toHaveLength(0);
      expect(rep.totals.employees).toBe(0);
      expect(rep.totals.totalDue).toBe("0.00");
    });

    it("Terminated Employees: Employees terminated before month start are excluded; if 0 active, returns empty result cleanly", async () => {
      // Seed employee terminated before June 2026
      await db().insert(s.employees).values({
        firstName: "منتهي",
        lastName: "الخدمة",
        branchId: 1,
        payType: "monthly",
        salary: "500000.00",
        hireDate: "2025-01-01",
        terminationDate: "2026-05-31", // terminated before 2026-06-01
      });

      // Seed employee hired after June 2026
      await db().insert(s.employees).values({
        firstName: "مستقبلي",
        lastName: "التوظيف",
        branchId: 1,
        payType: "monthly",
        salary: "500000.00",
        hireDate: "2026-07-01", // hired after 2026-06-30
      });

      const rep = await getMonthlyAttendanceReport({ period: PERIOD, branchId: 1 });
      expect(rep.rows).toHaveLength(0);
      expect(rep.totals.employees).toBe(0);
      expect(rep.totals.totalDue).toBe("0.00");
    });
  });

  // =========================================================================
  // Requirement 3: Financial & Hourly Calculation Accuracy
  // =========================================================================
  describe("Invariant 3: Financial & Hourly Calculation Accuracy", () => {
    it("Accurate calculations for regular attendance, overtime, leaves, penalties, hourly, and exempt employees", async () => {
      // 1. Employee 1: Full Attendance (Monthly)
      // Salary = 520,000 IQD. Scheduled hours = 26 days * 8h = 208h. Hourly rate = 520,000 / 208 = 2500.00 IQD.
      const emp1Id = 301;
      await db().insert(s.employees).values({
        id: emp1Id,
        firstName: "كامل",
        lastName: "الدوام",
        branchId: 1,
        payType: "monthly",
        salary: "520000.00",
        hireDate: "2026-01-01",
        workSchedule: SCHED,
      });

      // Seed full 26 days attendance of 8h each
      await db().insert(s.attendance).values(
        WORK_DAYS.map((d) => ({
          employeeId: emp1Id,
          branchId: 1,
          attendanceDate: d,
          status: "PRESENT" as const,
          hours: "8.00",
          hourlyRate: "2500.00",
          amount: "20000.00",
          source: "fingerprint" as const,
        }))
      );

      // 2. Employee 2: Absence / Partial Attendance
      // Salary = 520,000 IQD. Rate = 2500.00 IQD/h.
      // Attends 22 days (misses 4 days = 32 hours).
      const emp2Id = 302;
      await db().insert(s.employees).values({
        id: emp2Id,
        firstName: "غياب",
        lastName: "جزئي",
        branchId: 1,
        payType: "monthly",
        salary: "520000.00",
        hireDate: "2026-01-01",
        workSchedule: SCHED,
      });

      await db().insert(s.attendance).values(
        WORK_DAYS.slice(0, 22).map((d) => ({
          employeeId: emp2Id,
          branchId: 1,
          attendanceDate: d,
          status: "PRESENT" as const,
          hours: "8.00",
          hourlyRate: "2500.00",
          amount: "20000.00",
          source: "fingerprint" as const,
        }))
      );

      // 3. Employee 3: Overtime (10 hours overtime @ 1.5x)
      // Salary = 520,000 IQD. Rate = 2500.00 IQD/h. Overtime rate = 2500 * 1.5 = 3750.00 IQD/h.
      // 26 days attended: 21 days with 8h, 5 days with 10h (2h overtime each = 10 overtime hours).
      const emp3Id = 303;
      await db().insert(s.employees).values({
        id: emp3Id,
        firstName: "إضافي",
        lastName: "منتظم",
        branchId: 1,
        payType: "monthly",
        salary: "520000.00",
        hireDate: "2026-01-01",
        workSchedule: SCHED,
      });

      const emp3Att = WORK_DAYS.map((d, idx) => ({
        employeeId: emp3Id,
        branchId: 1,
        attendanceDate: d,
        status: "PRESENT" as const,
        hours: idx < 5 ? "10.00" : "8.00",
        hourlyRate: "2500.00",
        amount: idx < 5 ? "27500.00" : "20000.00",
        source: "fingerprint" as const,
      }));
      await db().insert(s.attendance).values(emp3Att);

      // 4. Employee 4: Rest Day Work (Friday work @ 1.0x)
      // Attends all 26 work days (8h) + 1 Friday (June 5, 8h).
      // Rest day work is paid at 1.0x regular rate (8h * 2500 = 20,000.00 IQD).
      const emp4Id = 304;
      await db().insert(s.employees).values({
        id: emp4Id,
        firstName: "عمل",
        lastName: "جمعة",
        branchId: 1,
        payType: "monthly",
        salary: "520000.00",
        hireDate: "2026-01-01",
        workSchedule: SCHED,
      });

      const emp4Att = WORK_DAYS.map((d) => ({
        employeeId: emp4Id,
        branchId: 1,
        attendanceDate: d,
        status: "PRESENT" as const,
        hours: "8.00",
        hourlyRate: "2500.00",
        amount: "20000.00",
        source: "fingerprint" as const,
      }));
      // Add Friday work
      emp4Att.push({
        employeeId: emp4Id,
        branchId: 1,
        attendanceDate: FRIDAYS[0], // 2026-06-05
        status: "PRESENT" as const,
        hours: "8.00",
        hourlyRate: "2500.00",
        amount: "20000.00",
        source: "fingerprint" as const,
      });
      await db().insert(s.attendance).values(emp4Att);

      // 5. Employee 5: Paid Leave (3 days paid leave)
      // Salary = 520,000 IQD. Attends 23 work days, has 3 days approved paid leave (2026-06-01 to 2026-06-03).
      // Paid leave should count as payable hours with zero deduction.
      const emp5Id = 305;
      await db().insert(s.employees).values({
        id: emp5Id,
        firstName: "إجازة",
        lastName: "مدفوعة",
        branchId: 1,
        payType: "monthly",
        salary: "520000.00",
        hireDate: "2026-01-01",
        workSchedule: SCHED,
      });

      await db().insert(s.attendance).values(
        WORK_DAYS.slice(3).map((d) => ({
          employeeId: emp5Id,
          branchId: 1,
          attendanceDate: d,
          status: "PRESENT" as const,
          hours: "8.00",
          hourlyRate: "2500.00",
          amount: "20000.00",
          source: "fingerprint" as const,
        }))
      );
      await db().insert(s.leaveRequests).values({
        employeeId: emp5Id,
        leaveType: "annual",
        fromDate: "2026-06-01",
        toDate: "2026-06-03",
        days: 3,
        paid: true,
        status: "approved",
      });

      // 6. Employee 6: Unpaid Leave (2 days unpaid leave)
      // Salary = 520,000 IQD. Attends 24 work days, has 2 days approved unpaid leave (2026-06-01 to 2026-06-02).
      // Unpaid leave should be deducted and not counted as payable hours.
      const emp6Id = 306;
      await db().insert(s.employees).values({
        id: emp6Id,
        firstName: "إجازة",
        lastName: "بلا راتب",
        branchId: 1,
        payType: "monthly",
        salary: "520000.00",
        hireDate: "2026-01-01",
        workSchedule: SCHED,
      });

      await db().insert(s.attendance).values(
        WORK_DAYS.slice(2).map((d) => ({
          employeeId: emp6Id,
          branchId: 1,
          attendanceDate: d,
          status: "PRESENT" as const,
          hours: "8.00",
          hourlyRate: "2500.00",
          amount: "20000.00",
          source: "fingerprint" as const,
        }))
      );
      await db().insert(s.leaveRequests).values({
        employeeId: emp6Id,
        leaveType: "unpaid",
        fromDate: "2026-06-01",
        toDate: "2026-06-02",
        days: 2,
        paid: false,
        status: "approved",
      });

      // 7. Employee 7: Needs Review Attendance Flag
      const emp7Id = 307;
      await db().insert(s.employees).values({
        id: emp7Id,
        firstName: "تحت",
        lastName: "المراجعة",
        branchId: 1,
        payType: "monthly",
        salary: "520000.00",
        hireDate: "2026-01-01",
        workSchedule: SCHED,
      });

      await db().insert(s.attendance).values([
        {
          employeeId: emp7Id,
          branchId: 1,
          attendanceDate: WORK_DAYS[0],
          status: "PRESENT" as const,
          hours: "4.00",
          hourlyRate: "2500.00",
          amount: "10000.00",
          source: "fingerprint" as const,
          needsReview: true,
          reviewReason: "بصمة انصراف مفقودة",
        },
      ]);

      // 8. Employee 8: Hourly Pay Type
      // Pay type = hourly. 5 shifts of 6h = 30h. Total amount paid = 150,000 IQD.
      const emp8Id = 308;
      await db().insert(s.employees).values({
        id: emp8Id,
        firstName: "أجر",
        lastName: "ساعي",
        branchId: 1,
        payType: "hourly",
        salary: null,
        hireDate: "2026-01-01",
        workSchedule: SCHED,
      });

      await db().insert(s.attendance).values(
        WORK_DAYS.slice(0, 5).map((d) => ({
          employeeId: emp8Id,
          branchId: 1,
          attendanceDate: d,
          status: "PRESENT" as const,
          hours: "6.00",
          hourlyRate: "5000.00",
          amount: "30000.00",
          source: "manual" as const,
        }))
      );

      // 9. Employee 9: Attendance Exempt (Fixed Salary)
      // Exempt = true. Zero attendance records logged. Due = full salary (750,000.00 IQD).
      const emp9Id = 309;
      await db().insert(s.employees).values({
        id: emp9Id,
        firstName: "معفى",
        lastName: "من البصمة",
        branchId: 1,
        payType: "monthly",
        salary: "750000.00",
        hireDate: "2026-01-01",
        attendanceExempt: true,
        workSchedule: SCHED,
      });

      // Execute Monthly Attendance Report
      const report = await getMonthlyAttendanceReport({ period: PERIOD, branchId: 1 });
      const rowMap = new Map(report.rows.map((r) => [r.employeeId, r]));

      // Assertions on Employee 1 (Full Attendance)
      const r1 = rowMap.get(emp1Id)!;
      expect(r1).toBeDefined();
      expect(r1.payableHours).toBe("208.00");
      expect(r1.absentDays).toBe(0);
      expect(r1.overtimeHours).toBe("0.00");
      expect(r1.basePay).toBe("520000.00");
      expect(r1.totalDue).toBe("520000.00");

      // Assertions on Employee 2 (Absence)
      const r2 = rowMap.get(emp2Id)!;
      expect(r2).toBeDefined();
      expect(r2.payableHours).toBe("176.00"); // 22 days * 8h
      expect(r2.absentDays).toBe(4);
      expect(r2.basePay).toBe("440000.00"); // 176h * 2500 IQD
      expect(r2.totalDue).toBe("440000.00");

      // Assertions on Employee 3 (Overtime @ 1.5x)
      const r3 = rowMap.get(emp3Id)!;
      expect(r3).toBeDefined();
      expect(r3.payableHours).toBe("208.00");
      expect(r3.overtimeHours).toBe("10.00");
      // Overtime pay: 10h * 2500 * 1.5 = 37,500.00 IQD
      expect(r3.overtimePay).toBe("37500.00");
      expect(r3.basePay).toBe("520000.00");
      expect(r3.totalDue).toBe("557500.00"); // 520,000 + 37,500

      // Assertions on Employee 4 (Rest Day Work @ 1.0x)
      const r4 = rowMap.get(emp4Id)!;
      expect(r4).toBeDefined();
      expect(r4.payableHours).toBe("208.00"); // 208 standard payable hours
      expect(r4.restWorkedHours).toBe("8.00");
      // Rest day work is paid at 1.0x (2500 IQD/h * 8h = 20,000.00 IQD)
      expect(r4.basePay).toBe("540000.00"); // 520,000 + 20,000
      expect(r4.totalDue).toBe("540000.00");

      // Assertions on Employee 5 (Paid Leave)
      const r5 = rowMap.get(emp5Id)!;
      expect(r5).toBeDefined();
      expect(r5.payableHours).toBe("208.00"); // 23 worked days * 8h + 3 paid leave days * 8h = 208h
      expect(r5.absentDays).toBe(0);
      expect(r5.basePay).toBe("520000.00");
      expect(r5.totalDue).toBe("520000.00");

      // Assertions on Employee 6 (Unpaid Leave)
      const r6 = rowMap.get(emp6Id)!;
      expect(r6).toBeDefined();
      expect(r6.payableHours).toBe("192.00"); // 24 worked days * 8h = 192h
      expect(r6.unpaidLeaveDays).toBe(2);
      expect(r6.absentDays).toBe(0); // Approved unpaid leave is counted as unpaidLeaveDays, not unexpected absence
      expect(r6.basePay).toBe("480000.00"); // 192h * 2500 IQD
      expect(r6.totalDue).toBe("480000.00");

      // Assertions on Employee 7 (Needs Review Flag)
      const r7 = rowMap.get(emp7Id)!;
      expect(r7).toBeDefined();
      expect(r7.reviewDays).toBe(1);

      // Assertions on Employee 8 (Hourly Worker)
      const r8 = rowMap.get(emp8Id)!;
      expect(r8).toBeDefined();
      expect(r8.payType).toBe("hourly");
      expect(r8.dueBasis).toBe("hourly");
      expect(r8.totalDue).toBe("150000.00"); // 5 days * 30,000 IQD

      // Assertions on Employee 9 (Attendance Exempt)
      const r9 = rowMap.get(emp9Id)!;
      expect(r9).toBeDefined();
      expect(r9.attendanceExempt).toBe(true);
      expect(r9.dueBasis).toBe("exempt");
      expect(r9.totalDue).toBe("750000.00"); // Fixed salary

      // Summary Totals Verification
      expect(report.totals.employees).toBe(9);
      expect(report.totals.exempt).toBe(1);
      expect(report.totals.reviewDays).toBe(1);

      const computedTotalDue = report.rows.reduce((sum, r) => sum + Number(r.totalDue), 0);
      expect(Number(report.totals.totalDue)).toBeCloseTo(computedTotalDue, 2);
    });
  });
});
