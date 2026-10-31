import Decimal from "decimal.js";
import { eq } from "drizzle-orm";
import { MySql2PreparedQuery } from "drizzle-orm/mysql2/session";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb, getPool } from "../../db";
import { baghdadToday } from "../businessDay";
import {
  getEmployeeAdvanceCapacity,
  getEmployeeAdvanceCapacityTx,
  type EmployeeAdvanceCapacity,
} from "../employeeAdvanceCapacityService";
import { arabicDayName, projectAttendanceWage } from "../attendanceService";
import { getEmployeeStatement } from "../hr/employeeStatement";
import { approveEmployeePenalty } from "../employeePenaltyService";
import { disburseEmployeeLoan, requestEmployeeLoan } from "../employeeLoanService";
import { updateItem } from "../payrollService";
import { type Actor, withTx } from "../tx";

const EMPLOYEE_ID = 10;
const BRANCH_ID = 1;
const ACTOR: Actor = { userId: 1, branchId: BRANCH_ID, role: "cashier" };
const FIXED_PERIOD = "2030-06";
const FIXED_AS_OF = "2030-06-15";
const TODAY = baghdadToday();
const CURRENT_PERIOD = TODAY.slice(0, 7);
const ALL_DAYS_TEN = {
  الأحد: { hours: 8, rate: 10 },
  الاثنين: { hours: 8, rate: 10 },
  الثلاثاء: { hours: 8, rate: 10 },
  الأربعاء: { hours: 8, rate: 10 },
  الخميس: { hours: 8, rate: 10 },
  الجمعة: { hours: 8, rate: 10 },
  السبت: { hours: 8, rate: 10 },
};
const ALL_DAY_RATES_ONE = {
  الأحد: 1,
  الاثنين: 1,
  الثلاثاء: 1,
  الأربعاء: 1,
  الخميس: 1,
  الجمعة: 1,
  السبت: 1,
};

function db() {
  const connection = getDb();
  if (!connection) throw new Error("DATABASE_URL not set for tests");
  return connection;
}

function previousPeriod(period: string): string {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  return month === 1
    ? `${year - 1}-12`
    : `${year}-${String(month - 1).padStart(2, "0")}`;
}

async function seedAttendance(input: {
  date: string;
  status?: "PRESENT" | "ABSENT" | "LATE" | "LEAVE";
  hours?: string;
  amount: string;
  hourlyRate?: string;
  /** سعر ملف الموظف الحالي؛ يجعل fixture الساعي canonical بدلاً من الثقة في amount المخزن. */
  currentHourlyRate?: string;
  source?: "manual" | "fingerprint";
  needsReview?: boolean;
  reviewReason?: string | null;
  notes?: string | null;
  checkIn?: Date | null;
  checkOut?: Date | null;
}) {
  const connection = db();
  if (input.currentHourlyRate != null) {
    const [employee] = await connection
      .select({ dayRates: s.employees.dayRates })
      .from(s.employees)
      .where(eq(s.employees.id, EMPLOYEE_ID))
      .limit(1);
    const dayRates = employee?.dayRates && typeof employee.dayRates === "object"
      ? { ...(employee.dayRates as Record<string, number>) }
      : {};
    dayRates[arabicDayName(input.date)] = Number(input.currentHourlyRate);
    await connection
      .update(s.employees)
      .set({ dayRates })
      .where(eq(s.employees.id, EMPLOYEE_ID));
  }
  await connection
    .insert(s.attendance)
    .values({
      employeeId: EMPLOYEE_ID,
      branchId: BRANCH_ID,
      attendanceDate: input.date,
      status: input.status ?? "PRESENT",
      hours: input.hours ?? "8.00",
      hourlyRate: input.hourlyRate ?? input.currentHourlyRate ?? "1.00",
      amount: input.amount,
      source: input.source ?? "manual",
      needsReview: input.needsReview ?? false,
      reviewReason: input.reviewReason ?? null,
      notes: input.notes ?? null,
      checkIn: input.checkIn ?? null,
      checkOut: input.checkOut ?? null,
    });
}

async function seedPaidLeave(fromDate: string, toDate: string, days: number) {
  await db()
    .insert(s.leaveRequests)
    .values({
      employeeId: EMPLOYEE_ID,
      leaveType: "إجازة مدفوعة",
      paid: true,
      fromDate,
      toDate,
      days,
      status: "approved",
      decidedBy: ACTOR.userId,
      decidedAt: new Date(`${fromDate}T12:00:00.000Z`),
    });
}

async function seedUnpaidLeave(fromDate: string, toDate: string, days: number) {
  await db()
    .insert(s.leaveRequests)
    .values({
      employeeId: EMPLOYEE_ID,
      leaveType: "بدون راتب",
      paid: false,
      fromDate,
      toDate,
      days,
      status: "approved",
      decidedBy: ACTOR.userId,
      decidedAt: new Date(`${fromDate}T12:00:00.000Z`),
    });
}

async function currentCapacity(): Promise<EmployeeAdvanceCapacity> {
  return getEmployeeAdvanceCapacity({
    employeeId: EMPLOYEE_ID,
    scopedBranchId: BRANCH_ID,
    period: CURRENT_PERIOD,
    asOf: TODAY,
  });
}

function pauseNextEmployeeForUpdate() {
  const execute = MySql2PreparedQuery.prototype.execute;
  let locked!: () => void;
  let release!: () => void;
  let paused = false;
  const lockReached = new Promise<void>((resolve) => { locked = resolve; });
  const mayContinue = new Promise<void>((resolve) => { release = resolve; });
  const spy = vi.spyOn(MySql2PreparedQuery.prototype, "execute").mockImplementation(async function (
    this: typeof MySql2PreparedQuery.prototype,
    values,
  ) {
    const query = (this as unknown as { query: { sql: string } }).query.sql;
    const result = await execute.call(this, values);
    if (!paused && query.includes("from `employees`") && query.includes("for update")) {
      paused = true;
      locked();
      await mayContinue;
    }
    return result;
  });
  return { lockReached, release, restore: () => spy.mockRestore() };
}

async function waitForEmployeeLockWait(): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const [rows] = await getPool().query(
      `SELECT COUNT(*) AS n
         FROM performance_schema.data_lock_waits w
         JOIN performance_schema.data_locks requested
           ON requested.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID
        WHERE requested.OBJECT_SCHEMA = DATABASE()
          AND requested.OBJECT_NAME = 'employees'`,
    );
    if (Number((rows as Array<{ n: number }>)[0]?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("لم يصل اختبار السعة إلى انتظار قفل الموظف المتوقع");
}

async function seedDisbursementCase(amount: string, key: string) {
  const connection = db();
  await connection
    .update(s.users)
    .set({
      operationPolicy: {
        version: 1,
        grants: {
          "operation.payroll.advanceGrant": true,
          "operation.hrEnterprise.loans.disburse": true,
        },
      },
    })
    .where(eq(s.users.id, ACTOR.userId));
  await connection.insert(s.users).values({
    id: 2,
    openId: `advance-capacity-reviewer-${key}`,
    name: "مراجع سعة السلفة",
    role: "manager",
    branchId: BRANCH_ID,
    operationPolicy: {
      version: 1,
      grants: { "operation.hrEnterprise.penalties.approve": true },
    },
  });
  await connection.insert(s.shifts).values({
    id: 100,
    branchId: BRANCH_ID,
    userId: ACTOR.userId,
    openingBalance: "100000.00",
    status: "OPEN",
    shiftType: "RETAIL",
    openGuard: `${BRANCH_ID}:${ACTOR.userId}:RETAIL`,
  });
  await connection.insert(s.monthCloseSequence).values({
    id: 1,
    status: "NEEDS_BOOTSTRAP",
    version: 0,
  });
  const [inserted] = await connection.insert(s.employeeLoanRequests).values({
    employeeId: EMPLOYEE_ID,
    branchId: BRANCH_ID,
    amount,
    installmentsCount: 1,
    monthlyDeduction: amount,
    payrollPeriod: CURRENT_PERIOD,
    clientRequestId: `capacity-current-read-${key}`,
    status: "APPROVED",
    createdById: 2,
    reviewedById: 2,
    reviewedAt: new Date(),
  });
  return inserted.insertId;
}

beforeEach(async () => {
  const connection = db();
  await connection.insert(s.branches).values({
    id: BRANCH_ID,
    name: "فرع اختبار حد السلفة",
    code: "ADV-CAP",
    type: "MAIN",
  });
  await connection.insert(s.users).values({
    id: ACTOR.userId,
    openId: "advance-capacity-tester",
    name: "مختبر حد السلفة",
    role: "cashier",
    branchId: BRANCH_ID,
    operationPolicy: {
      version: 1,
      grants: { "operation.payroll.advanceGrant": true },
    },
  });
  await connection.insert(s.employees).values({
    id: EMPLOYEE_ID,
    branchId: BRANCH_ID,
    firstName: "موظف",
    lastName: "اختبار",
    payType: "hourly",
    salary: "3000.00",
    allowances: "0.00",
    dayRates: ALL_DAY_RATES_ONE,
    hireDate: "2020-01-01",
    employmentStatus: "active",
  });
  await connection.insert(s.payrollLegalSettings).values({
    id: 1,
    socialSecurityEnabled: true,
    socialSecurityEmployeeRate: "10.00",
    socialSecurityEmployerRate: "0.00",
    socialSecurityBase: "gross",
    incomeTaxEnabled: true,
    incomeTaxBrackets: [{ upTo: null, rate: "10.00" }],
    incomeTaxExemption: "0.00",
    endOfServiceEnabled: false,
    endOfServiceDaysPerYear: "0.00",
    updatedBy: ACTOR.userId,
  });
});

describe("employee advance earned-capacity contract", () => {
  it("يستهلك كامل الإجازة الأجر والمكافأة الفورية دون العمولة ويبقى ثابتاً بعد المسودة", async () => {
    const connection = db();
    await connection
      .update(s.employees)
      .set({ payType: "monthly", attendanceExempt: true })
      .where(eq(s.employees.id, EMPLOYEE_ID));
    await seedUnpaidLeave("2030-06-01", "2030-06-30", 30);
    await connection.insert(s.employeeSpotBonuses).values({
      employeeId: EMPLOYEE_ID,
      branchId: BRANCH_ID,
      amount: "100.00",
      reason: "مكافأة يستهلكها كامل الإجازة بلا راتب",
      disbursementType: "PAYROLL_ADDITION",
      status: "APPROVED",
      createdById: ACTOR.userId,
      approvedById: ACTOR.userId,
      approvedAt: new Date("2030-06-06T12:00:00.000Z"),
    });
    await connection.insert(s.commissionPlans).values({
      id: 30,
      name: "خطة عمولة حد السلفة",
      createdBy: ACTOR.userId,
    });
    await connection.insert(s.commissionRuns).values({
      id: 31,
      period: FIXED_PERIOD,
      status: "approved",
      employeeCount: 1,
      totalCommission: "50.00",
      createdBy: ACTOR.userId,
      approvedBy: ACTOR.userId,
      approvedAt: new Date("2030-06-30T12:00:00.000Z"),
    });
    await connection.insert(s.commissionRunLines).values({
      runId: 31,
      employeeId: EMPLOYEE_ID,
      userId: ACTOR.userId,
      branchId: BRANCH_ID,
      planId: 30,
      commissionAmount: "50.00",
    });
    const input = {
      employeeId: EMPLOYEE_ID,
      scopedBranchId: BRANCH_ID,
      period: FIXED_PERIOD,
      asOf: "2030-06-30",
    };

    const beforeDraft = await getEmployeeAdvanceCapacity(input);
    expect(beforeDraft).toMatchObject({
      earnedCompensation: "0.00",
      approvedAdditions: "150.00",
      mandatoryDeductions: "100.00",
      maxAvailable: "50.00",
    });

    await connection.insert(s.payrollRuns).values({
      id: 1,
      period: FIXED_PERIOD,
      status: "draft",
      createdBy: ACTOR.userId,
      employeeCount: 1,
      totalGross: "3100.00",
      totalCommission: "50.00",
      totalDeductions: "3100.00",
      totalNet: "50.00",
    });
    await connection.insert(s.payrollItems).values({
      runId: 1,
      employeeId: EMPLOYEE_ID,
      payType: "monthly",
      gross: "3100.00",
      commission: "50.00",
      deductions: "3100.00",
      wageReduction: "3100.00",
      net: "50.00",
    });
    await connection
      .update(s.employeeSpotBonuses)
      .set({ payrollRunId: 1 })
      .where(eq(s.employeeSpotBonuses.employeeId, EMPLOYEE_ID));
    await connection
      .update(s.commissionRuns)
      .set({ payrollRunId: 1 })
      .where(eq(s.commissionRuns.id, 31));

    const afterDraft = await getEmployeeAdvanceCapacity(input);
    expect(afterDraft).toMatchObject({
      earnedCompensation: beforeDraft.earnedCompensation,
      approvedAdditions: beforeDraft.approvedAdditions,
      mandatoryDeductions: beforeDraft.mandatoryDeductions,
      maxAvailable: beforeDraft.maxAvailable,
    });
  });

  it("يصفّر الأجر المكتسب والقانوني عند إجازة بلا راتب تغطي نافذة الخدمة حتى اليوم", async () => {
    await db()
      .update(s.employees)
      .set({ payType: "monthly", attendanceExempt: true })
      .where(eq(s.employees.id, EMPLOYEE_ID));
    await seedUnpaidLeave("2030-06-01", "2030-06-30", 30);

    const capacity = await getEmployeeAdvanceCapacity({
      employeeId: EMPLOYEE_ID,
      scopedBranchId: BRANCH_ID,
      period: FIXED_PERIOD,
      asOf: FIXED_AS_OF,
    });

    expect(capacity).toMatchObject({
      earnedCompensation: "0.00",
      mandatoryDeductions: "0.00",
      maxAvailable: "0.00",
      blocked: false,
    });
    const enforced = await withTx((tx) => getEmployeeAdvanceCapacityTx(tx, {
      employeeId: EMPLOYEE_ID,
      scopedBranchId: BRANCH_ID,
      period: FIXED_PERIOD,
      asOf: FIXED_AS_OF,
      lock: true,
    }));
    expect(enforced).toEqual(capacity);
  });

  it("يقص الإجازة بلا راتب عند التعيين وasOf قبل إنشاء المسودة", async () => {
    await db()
      .update(s.employees)
      .set({
        payType: "monthly",
        attendanceExempt: false,
        hireDate: "2030-06-10",
      })
      .where(eq(s.employees.id, EMPLOYEE_ID));
    // لا يُحسب 1-9 قبل التعيين ولا 16-20 بعد asOf؛ أيام الإجازة المكتسبة فعلياً = 3.
    await seedUnpaidLeave("2030-06-01", "2030-06-12", 12);
    await seedUnpaidLeave("2030-06-16", "2030-06-20", 5);
    const input = {
      employeeId: EMPLOYEE_ID,
      scopedBranchId: BRANCH_ID,
      period: FIXED_PERIOD,
      asOf: FIXED_AS_OF,
    };

    const capacity = await getEmployeeAdvanceCapacity(input);
    // نافذة الخدمة 6 أيام: 600 ثابت - 3 × (3000 ÷ 30) = 300 مكتسب.
    // القانوني على 300 المكتسبة: ضمان 30 + ضريبة 27 = 57؛ المتاح 243.
    expect(capacity).toMatchObject({
      earnedCompensation: "300.00",
      mandatoryDeductions: "57.00",
      maxAvailable: "243.00",
    });
  });

  it("لا يحتسب خصم الإجازة مرة ثانية بعد التقاطه في مسودة الراتب", async () => {
    await db()
      .update(s.employees)
      .set({ payType: "monthly", attendanceExempt: false })
      .where(eq(s.employees.id, EMPLOYEE_ID));
    await seedUnpaidLeave("2030-06-05", "2030-06-09", 5);
    const input = {
      employeeId: EMPLOYEE_ID,
      scopedBranchId: BRANCH_ID,
      period: FIXED_PERIOD,
      asOf: "2030-06-30",
    };

    const beforeDraft = await getEmployeeAdvanceCapacity(input);
    expect(beforeDraft).toMatchObject({
      earnedCompensation: "2500.00",
      mandatoryDeductions: "475.00",
      maxAvailable: "2025.00",
    });

    await db().insert(s.payrollRuns).values({
      id: 1,
      period: FIXED_PERIOD,
      status: "draft",
      createdBy: ACTOR.userId,
      employeeCount: 1,
      totalGross: "3000.00",
      totalDeductions: "975.00",
      totalNet: "2025.00",
    });
    await db().insert(s.payrollItems).values({
      runId: 1,
      employeeId: EMPLOYEE_ID,
      payType: "monthly",
      gross: "3000.00",
      deductions: "975.00",
      wageReduction: "500.00",
      socialSecurityEmployee: "250.00",
      incomeTax: "225.00",
      net: "2025.00",
    });

    const afterDraft = await getEmployeeAdvanceCapacity(input);
    expect(afterDraft).toMatchObject({
      earnedCompensation: beforeDraft.earnedCompensation,
      mandatoryDeductions: beforeDraft.mandatoryDeductions,
      maxAvailable: beforeDraft.maxAvailable,
    });
  });

  it("يطابق تقريب المعدل اليومي قبل ضرب أيام الإجازة", async () => {
    await db()
      .update(s.employees)
      .set({
        payType: "monthly",
        attendanceExempt: true,
        salary: "1000.00",
      })
      .where(eq(s.employees.id, EMPLOYEE_ID));
    await seedUnpaidLeave("2030-06-01", "2030-06-02", 2);

    const capacity = await getEmployeeAdvanceCapacity({
      employeeId: EMPLOYEE_ID,
      scopedBranchId: BRANCH_ID,
      period: FIXED_PERIOD,
      asOf: "2030-06-30",
    });

    // round2(1000 ÷ 30) = 33.33؛ يومان = 66.66 لا 66.67.
    expect(capacity).toMatchObject({
      earnedCompensation: "933.34",
      mandatoryDeductions: "177.33",
      maxAvailable: "756.01",
    });
  });

  it("لا يخصم الإجازة مرتين من أجر الحضور المكتسب", async () => {
    await db()
      .update(s.employees)
      .set({ payType: "monthly", attendanceExempt: false })
      .where(eq(s.employees.id, EMPLOYEE_ID));
    await db().insert(s.hrAttendanceSettings).values({
      id: 1,
      attendancePayEnabled: true,
      attendancePayFrom: "2030-06-01",
      updatedBy: ACTOR.userId,
    });
    await seedAttendance({ date: "2030-06-05", amount: "115.38" });
    await seedAttendance({ date: "2030-06-06", amount: "115.38" });
    await seedUnpaidLeave("2030-06-05", "2030-06-05", 1);

    const capacity = await getEmployeeAdvanceCapacity({
      employeeId: EMPLOYEE_ID,
      scopedBranchId: BRANCH_ID,
      period: FIXED_PERIOD,
      asOf: FIXED_AS_OF,
    });

    // نواة الحضور أسقطت 5 حزيران بالفعل؛ يبقى أجر 6 حزيران ولا يُطرح منه 100 ثانيةً.
    expect(capacity).toMatchObject({
      earnedCompensation: "115.38",
      mandatoryDeductions: "21.92",
      maxAvailable: "93.46",
    });
  });

  it.each(["basic", "gross"] as const)("يفصل الإضافي عن الوعاء القانوني %s ويبقى ثابتاً بعد المسودة", async (socialSecurityBase) => {
    const connection = db();
    const expected = socialSecurityBase === "basic"
      ? { social: "8.00", tax: "8.20", deductions: "16.20", net: "103.80" }
      : { social: "9.00", tax: "8.10", deductions: "17.10", net: "102.90" };
    const schedule = {
      الأحد: { hours: 8, rate: 10 },
      الاثنين: { hours: 8, rate: 10 },
      الثلاثاء: { hours: 8, rate: 10 },
      الأربعاء: { hours: 8, rate: 10 },
      الخميس: { hours: 8, rate: 10 },
      الجمعة: { hours: 8, rate: 10 },
      السبت: { hours: 8, rate: 10 },
    };
    await connection
      .update(s.employees)
      .set({
        payType: "monthly",
        attendanceExempt: false,
        allowances: "20.00",
        workSchedule: schedule,
      })
      .where(eq(s.employees.id, EMPLOYEE_ID));
    await connection
      .update(s.payrollLegalSettings)
      .set({ socialSecurityBase })
      .where(eq(s.payrollLegalSettings.id, 1));
    await connection.insert(s.hrAttendanceSettings).values({
      id: 1,
      attendancePayEnabled: true,
      attendancePayFrom: "2030-06-01",
      updatedBy: ACTOR.userId,
    });
    // 8 ساعات أساس × 10، وساعتان إضافيتان × 10 × 1.5. المخصص حتى 15/6 = 10.
    await seedAttendance({
      date: "2030-06-05",
      hours: "10.00",
      amount: "100.00",
    });
    const input = {
      employeeId: EMPLOYEE_ID,
      scopedBranchId: BRANCH_ID,
      period: FIXED_PERIOD,
      asOf: FIXED_AS_OF,
    };

    const statement = await getEmployeeStatement({
      employeeId: EMPLOYEE_ID,
      scopedBranchId: BRANCH_ID,
      period: FIXED_PERIOD,
      employmentEndOverride: FIXED_AS_OF,
    });
    expect(statement?.livePayrollComponents).toEqual({
      basic: "80.00",
      allowances: "10.00",
      gross: "90.00",
      overtime: "30.00",
    });

    const beforeDraft = await getEmployeeAdvanceCapacity(input);
    // القانون: ضمان 10% من الوعاء المختار، وضريبة 10% من (gross=90 - الضمان).
    // الإضافي 30 يزيد الأجر المتاح، لكنه لا يضخم basic أو gross القانوني.
    expect(beforeDraft).toMatchObject({
      earnedCompensation: "120.00",
      mandatoryDeductions: expected.deductions,
      maxAvailable: expected.net,
    });

    await connection.insert(s.payrollRuns).values({
      id: 1,
      period: FIXED_PERIOD,
      status: "draft",
      createdBy: ACTOR.userId,
      employeeCount: 1,
      totalGross: "90.00",
      totalOvertime: "30.00",
      totalDeductions: expected.deductions,
      totalNet: expected.net,
    });
    await connection.insert(s.payrollItems).values({
      runId: 1,
      employeeId: EMPLOYEE_ID,
      payType: "monthly",
      gross: "90.00",
      allowances: "10.00",
      overtime: "30.00",
      deductions: expected.deductions,
      socialSecurityEmployee: expected.social,
      incomeTax: expected.tax,
      net: expected.net,
    });

    const afterDraft = await getEmployeeAdvanceCapacity(input);
    expect(afterDraft).toMatchObject({
      earnedCompensation: beforeDraft.earnedCompensation,
      approvedAdditions: beforeDraft.approvedAdditions,
      mandatoryDeductions: beforeDraft.mandatoryDeductions,
      maxAvailable: beforeDraft.maxAvailable,
    });
  });

  it("يقص السعة عند تعويض المسودة المعدل دون توسيع الأجر أو تكرار خصم الديون", async () => {
    const connection = db();
    const schedule = Object.fromEntries(
      [
        "الأحد",
        "الاثنين",
        "الثلاثاء",
        "الأربعاء",
        "الخميس",
        "الجمعة",
        "السبت",
      ].map((day) => [day, { hours: 8, rate: 100 }]),
    );
    await connection
      .update(s.employees)
      .set({
        payType: "monthly",
        attendanceExempt: false,
        workSchedule: schedule,
      })
      .where(eq(s.employees.id, EMPLOYEE_ID));
    await connection.insert(s.hrAttendanceSettings).values({
      id: 1,
      attendancePayEnabled: true,
      attendancePayFrom: `${CURRENT_PERIOD}-01`,
      maxDailyHours: "12.00",
      updatedBy: ACTOR.userId,
    });
    // 8 × 100 أساس، و4 × 100 × 1.5 إضافي = 1400 مكتسب حتى اليوم.
    await seedAttendance({ date: TODAY, hours: "12.00", amount: "1400.00" });
    await connection.insert(s.employeeAdvances).values([
      {
        employeeId: EMPLOYEE_ID,
        branchId: BRANCH_ID,
        amount: "100.00",
        remaining: "100.00",
        monthlyDeduction: "100.00",
        sourceType: "SALARY_ADVANCE",
        payrollPeriod: CURRENT_PERIOD,
        status: "ACTIVE",
        createdBy: ACTOR.userId,
      },
      {
        employeeId: EMPLOYEE_ID,
        branchId: BRANCH_ID,
        amount: "50.00",
        remaining: "50.00",
        monthlyDeduction: "50.00",
        sourceType: "OTHER_DEDUCTION",
        payrollPeriod: null,
        status: "ACTIVE",
        createdBy: ACTOR.userId,
      },
    ]);
    await connection.insert(s.payrollRuns).values({
      id: 1,
      period: CURRENT_PERIOD,
      status: "draft",
      createdBy: ACTOR.userId,
      employeeCount: 1,
      totalGross: "800.00",
      totalOvertime: "600.00",
      totalDeductions: "302.00",
      totalNet: "1098.00",
    });
    await connection.insert(s.payrollItems).values({
      id: 1,
      runId: 1,
      employeeId: EMPLOYEE_ID,
      payType: "monthly",
      gross: "800.00",
      overtime: "600.00",
      deductions: "302.00",
      advanceDeduction: "150.00",
      socialSecurityEmployee: "80.00",
      incomeTax: "72.00",
      net: "1098.00",
    });
    const input = {
      employeeId: EMPLOYEE_ID,
      scopedBranchId: BRANCH_ID,
      period: CURRENT_PERIOD,
      asOf: TODAY,
    };

    // 1400 - قانوني 152 - سلفة 100 - استقطاع آخر 50 = 1098؛ advanceDeduction لا يخصم ثانية.
    expect(await getEmployeeAdvanceCapacity(input)).toMatchObject({
      earnedCompensation: "1400.00",
      mandatoryDeductions: "152.00",
      existingSalaryAdvances: "100.00",
      otherEmployeeDeductions: "50.00",
      maxAvailable: "1098.00",
    });

    await updateItem(1, { overtime: "0.00" }, ACTOR);
    expect((await getEmployeeAdvanceCapacity(input)).maxAvailable).toBe(
      "498.00",
    );

    // رفع المسودة لا يوسّع سقف الأجر المكتسب الحي.
    await updateItem(1, { overtime: "1000.00" }, ACTOR);
    expect((await getEmployeeAdvanceCapacity(input)).maxAvailable).toBe(
      "1098.00",
    );

    // خصم يدوي 200 فوق القانونية/الديون يخفض السقفين مرة واحدة.
    await updateItem(1, { overtime: "600.00", deductions: "502.00" }, ACTOR);
    expect((await getEmployeeAdvanceCapacity(input)).maxAvailable).toBe(
      "898.00",
    );

    await updateItem(1, { overtime: "0.00", deductions: "302.00" }, ACTOR);
    await connection.insert(s.employeeLoanRequests).values({
      employeeId: EMPLOYEE_ID,
      branchId: BRANCH_ID,
      amount: "25.00",
      installmentsCount: 1,
      monthlyDeduction: "25.00",
      payrollPeriod: CURRENT_PERIOD,
      clientRequestId: "existing-edited-draft-reservation",
      status: "PENDING",
      createdById: ACTOR.userId,
    });
    expect((await getEmployeeAdvanceCapacity(input)).maxAvailable).toBe(
      "473.00",
    );
    await expect(
      requestEmployeeLoan(ACTOR, {
        employeeId: EMPLOYEE_ID,
        amount: "473.01",
        clientRequestId: "edited-draft-over-capacity",
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("يصفّر السعة إذا كانت المسودة بلا تعويض أو بلا بند للموظف", async () => {
    await seedAttendance({ date: TODAY, amount: "1000.00", currentHourlyRate: "125.00" });
    await db().insert(s.payrollRuns).values({
      id: 1,
      period: CURRENT_PERIOD,
      status: "draft",
      createdBy: ACTOR.userId,
      employeeCount: 0,
      totalGross: "0.00",
      totalDeductions: "0.00",
      totalNet: "0.00",
    });
    const input = {
      employeeId: EMPLOYEE_ID,
      scopedBranchId: BRANCH_ID,
      period: CURRENT_PERIOD,
      asOf: TODAY,
    };

    expect(await getEmployeeAdvanceCapacity(input)).toMatchObject({
      maxAvailable: "0.00",
      blocked: true,
      blockers: [expect.stringContaining("غير مشمول بمسودة")],
    });
    await db().insert(s.payrollItems).values({
      runId: 1,
      employeeId: EMPLOYEE_ID,
      payType: "hourly",
      gross: "0.00",
      overtime: "0.00",
      commission: "0.00",
      deductions: "0.00",
      net: "0.00",
    });
    expect((await getEmployeeAdvanceCapacity(input)).maxAvailable).toBe("0.00");
  });

  it("يرى العقوبة المعتمدة التي التزمت أثناء انتظار صرف السلفة لقفل الموظف", async () => {
    await seedAttendance({ date: TODAY, amount: "1000.00", currentHourlyRate: "125.00" });
    const loanId = await seedDisbursementCase("750.00", "penalty-after-preview");
    const [penalty] = await db().insert(s.employeePenalties).values({
      employeeId: EMPLOYEE_ID,
      branchId: BRANCH_ID,
      penaltyType: "SALARY_DEDUCTION",
      decisionNumber: "CAP-CURRENT-PENALTY",
      decisionDate: TODAY,
      reason: "عقوبة تلتزم أثناء انتظار الصرف",
      deductionAmount: "100.00",
      status: "DRAFT",
      createdById: ACTOR.userId,
    });
    const reviewer: Actor = { userId: 2, branchId: BRANCH_ID, role: "manager" };
    const barrier = pauseNextEmployeeForUpdate();
    let approval: ReturnType<typeof approveEmployeePenalty> | undefined;
    let disbursement: ReturnType<typeof disburseEmployeeLoan> | undefined;
    try {
      approval = approveEmployeePenalty(reviewer, penalty.insertId);
      await barrier.lockReached;
      disbursement = disburseEmployeeLoan(ACTOR, loanId);
      await waitForEmployeeLockWait();
      barrier.release();
      const [approved, disbursed] = await Promise.allSettled([approval, disbursement]);
      expect(approved.status).toBe("fulfilled");
      expect(disbursed).toMatchObject({
        status: "rejected",
        reason: { code: "PRECONDITION_FAILED" },
      });
    } finally {
      barrier.release();
      await Promise.allSettled([approval, disbursement].filter(Boolean) as Promise<unknown>[]);
      barrier.restore();
    }
    const [storedPenalty] = await db()
      .select({ status: s.employeePenalties.status })
      .from(s.employeePenalties)
      .where(eq(s.employeePenalties.id, penalty.insertId));
    const [storedLoan] = await db()
      .select({ status: s.employeeLoanRequests.status })
      .from(s.employeeLoanRequests)
      .where(eq(s.employeeLoanRequests.id, loanId));
    expect(storedPenalty?.status).toBe("APPROVED");
    expect(storedLoan?.status).toBe("APPROVED");
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    expect(await db().select().from(s.employeeAdvances)).toHaveLength(0);
    expect(await db().select().from(s.idempotencyKeys)).toHaveLength(0);
  }, 15_000);

  it("يفشل مغلقاً بلا أثر جزئي عندما يكون مصدر مالي مقفولاً", async () => {
    await seedAttendance({ date: TODAY, amount: "1000.00", currentHourlyRate: "125.00" });
    const loanId = await seedDisbursementCase("100.00", "locked-penalty-source");
    const [penalty] = await db().insert(s.employeePenalties).values({
      employeeId: EMPLOYEE_ID,
      branchId: BRANCH_ID,
      penaltyType: "SALARY_DEDUCTION",
      decisionNumber: "CAP-LOCKED-PENALTY",
      decisionDate: TODAY,
      reason: "مصدر مقفول لا يجوز تجاهله",
      deductionAmount: "100.00",
      status: "APPROVED",
      createdById: 2,
      approvedById: 2,
      approvedAt: new Date(),
    });
    let locked!: () => void;
    let release!: () => void;
    const lockReached = new Promise<void>((resolve) => { locked = resolve; });
    const mayContinue = new Promise<void>((resolve) => { release = resolve; });
    const holder = withTx(async (tx) => {
      await tx
        .select({ id: s.employeePenalties.id })
        .from(s.employeePenalties)
        .where(eq(s.employeePenalties.id, penalty.insertId))
        .for("update")
        .limit(1);
      locked();
      await mayContinue;
    });
    await lockReached;
    try {
      await expect(disburseEmployeeLoan(ACTOR, loanId)).rejects.toMatchObject({
        code: "CONFLICT",
      });
    } finally {
      release();
      await holder;
    }
    const [storedLoan] = await db()
      .select({ status: s.employeeLoanRequests.status })
      .from(s.employeeLoanRequests)
      .where(eq(s.employeeLoanRequests.id, loanId));
    expect(storedLoan?.status).toBe("APPROVED");
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    expect(await db().select().from(s.employeeAdvances)).toHaveLength(0);
    expect(await db().select().from(s.idempotencyKeys)).toHaveLength(0);
  }, 15_000);

  it("يفشل سريعاً إذا كان توليد المسيّر يحتجز رأس الشهر دون دورة أقفال", async () => {
    let inserted!: () => void;
    let release!: () => void;
    const runInserted = new Promise<void>((resolve) => { inserted = resolve; });
    const mayCommit = new Promise<void>((resolve) => { release = resolve; });
    const holder = withTx(async (tx) => {
      await tx.insert(s.payrollRuns).values({
        period: CURRENT_PERIOD,
        status: "draft",
        createdBy: ACTOR.userId,
      });
      inserted();
      await mayCommit;
    });
    await runInserted;

    const execute = MySql2PreparedQuery.prototype.execute;
    const lockOrder: string[] = [];
    let runLockAttempts = 0;
    const spy = vi.spyOn(MySql2PreparedQuery.prototype, "execute").mockImplementation(async function (
      this: typeof MySql2PreparedQuery.prototype,
      values,
    ) {
      const query = (this as unknown as { query: { sql: string } }).query.sql;
      if (query.includes("from `employees`") && query.includes("for update")) {
        lockOrder.push("employee");
      }
      if (
        query.includes("from `payrollRuns`") &&
        query.includes("for update nowait")
      ) {
        lockOrder.push("run");
        runLockAttempts += 1;
      }
      return execute.call(this, values);
    });
    const capacity = withTx((tx) =>
      getEmployeeAdvanceCapacityTx(tx, {
        employeeId: EMPLOYEE_ID,
        scopedBranchId: BRANCH_ID,
        period: CURRENT_PERIOD,
        asOf: TODAY,
        lock: true,
      }),
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        capacity.then(
          () => ({ status: "fulfilled" as const }),
          (reason: unknown) => ({ status: "rejected" as const, reason }),
        ),
        new Promise<{ status: "timeout" }>((resolve) => {
          timeout = setTimeout(() => resolve({ status: "timeout" }), 2_000);
        }),
      ]);
      expect(outcome).toMatchObject({
        status: "rejected",
        reason: { code: "CONFLICT" },
      });
      expect(lockOrder.slice(0, 2)).toEqual(["employee", "run"]);
      expect(runLockAttempts).toBe(1);
    } finally {
      if (timeout) clearTimeout(timeout);
      release();
      await holder;
      await Promise.allSettled([capacity]);
      spy.mockRestore();
    }
  }, 15_000);

  it("يرى الراتب والإجازة المعتمدة اللذين التزما بعد preview قديم", async () => {
    await db()
      .update(s.employees)
      .set({ payType: "monthly", attendanceExempt: true, salary: "3000.00" })
      .where(eq(s.employees.id, EMPLOYEE_ID));
    const barrier = pauseNextEmployeeForUpdate();
    let writer: Promise<unknown> | undefined;
    let request: ReturnType<typeof requestEmployeeLoan> | undefined;
    try {
      writer = withTx(async (tx) => {
        await tx
          .select({ id: s.employees.id })
          .from(s.employees)
          .where(eq(s.employees.id, EMPLOYEE_ID))
          .for("update")
          .limit(1);
        await tx
          .update(s.employees)
          .set({ salary: "6000.00", allowances: "300.00" })
          .where(eq(s.employees.id, EMPLOYEE_ID));
        await tx.insert(s.leaveRequests).values({
          employeeId: EMPLOYEE_ID,
          leaveType: "بدون راتب",
          paid: false,
          fromDate: `${CURRENT_PERIOD}-01`,
          toDate: TODAY,
          days: Number(TODAY.slice(8, 10)),
          status: "approved",
          decidedBy: ACTOR.userId,
          decidedAt: new Date(),
        });
      });
      await barrier.lockReached;
      request = requestEmployeeLoan(ACTOR, {
        employeeId: EMPLOYEE_ID,
        amount: "1.00",
        clientRequestId: "current-salary-leave-after-preview",
      });
      await waitForEmployeeLockWait();
      barrier.release();
      const [written, requested] = await Promise.allSettled([writer, request]);
      expect(written.status).toBe("fulfilled");
      expect(requested).toMatchObject({
        status: "rejected",
        reason: { code: "PRECONDITION_FAILED" },
      });
    } finally {
      barrier.release();
      await Promise.allSettled([writer, request].filter(Boolean) as Promise<unknown>[]);
      barrier.restore();
    }
    expect(await db().select().from(s.employeeLoanRequests)).toHaveLength(0);
    const capacity = await currentCapacity();
    expect(capacity).toMatchObject({
      earnedCompensation: "0.00",
      maxAvailable: "0.00",
    });
  }, 15_000);

  it("يبقي المكافأة المعتمدة ضمن الحد بعد التقاطها في مسودة الراتب", async () => {
    await seedAttendance({ date: "2030-06-05", amount: "300.00", currentHourlyRate: "37.50" });
    await db()
      .insert(s.employeeSpotBonuses)
      .values({
        employeeId: EMPLOYEE_ID,
        branchId: BRANCH_ID,
        amount: "100.00",
        reason: "مكافأة معتمدة تلتقطها مسودة الراتب",
        disbursementType: "PAYROLL_ADDITION",
        status: "APPROVED",
        createdById: ACTOR.userId,
        approvedById: ACTOR.userId,
        approvedAt: new Date("2030-06-06T12:00:00.000Z"),
      });
    const input = {
      employeeId: EMPLOYEE_ID,
      scopedBranchId: BRANCH_ID,
      period: FIXED_PERIOD,
      asOf: FIXED_AS_OF,
    };
    const beforeDraft = await getEmployeeAdvanceCapacity(input);
    expect(beforeDraft.maxAvailable).toBe("324.00");
    await db().insert(s.payrollRuns).values({
      id: 1,
      period: FIXED_PERIOD,
      status: "draft",
      createdBy: ACTOR.userId,
      employeeCount: 1,
      totalGross: "400.00",
      totalDeductions: "76.00",
      totalNet: "324.00",
    });
    await db().insert(s.payrollItems).values({
      runId: 1,
      employeeId: EMPLOYEE_ID,
      payType: "hourly",
      gross: "400.00",
      deductions: "76.00",
      socialSecurityEmployee: "40.00",
      incomeTax: "36.00",
      net: "324.00",
    });
    await db()
      .update(s.employeeSpotBonuses)
      .set({ payrollRunId: 1 })
      .where(eq(s.employeeSpotBonuses.employeeId, EMPLOYEE_ID));
    const afterDraft = await getEmployeeAdvanceCapacity(input);
    expect(afterDraft.approvedAdditions).toBe("100.00");
    expect(afterDraft.maxAvailable).toBe(beforeDraft.maxAvailable);
  });

  it("يرفض الموظف المعطّل حتى لو بقيت حالته الوظيفية active", async () => {
    await db()
      .update(s.employees)
      .set({ isActive: false })
      .where(eq(s.employees.id, EMPLOYEE_ID));
    await expect(currentCapacity()).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    await expect(
      requestEmployeeLoan(ACTOR, {
        employeeId: EMPLOYEE_ID,
        amount: "1.00",
        clientRequestId: "inactive-employee-advance-blocked",
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await db().select().from(s.employeeLoanRequests)).toHaveLength(0);
  });

  it("يرفض موظفاً يبدأ بعد نهاية الشهر ولا يحوّل مكافأته القديمة إلى سعة", async () => {
    const year = Number(CURRENT_PERIOD.slice(0, 4));
    const month = Number(CURRENT_PERIOD.slice(5, 7));
    const nextMonthStart = new Date(Date.UTC(year, month, 1))
      .toISOString()
      .slice(0, 10);
    await db()
      .update(s.employees)
      .set({
        payType: "monthly",
        attendanceExempt: true,
        hireDate: nextMonthStart,
      })
      .where(eq(s.employees.id, EMPLOYEE_ID));
    await db().insert(s.employeeSpotBonuses).values({
      employeeId: EMPLOYEE_ID,
      branchId: BRANCH_ID,
      amount: "100.00",
      reason: "مكافأة قديمة لموظف لم تبدأ خدمته",
      disbursementType: "PAYROLL_ADDITION",
      status: "APPROVED",
      createdById: ACTOR.userId,
      approvedById: ACTOR.userId,
      approvedAt: new Date(
        `${previousPeriod(CURRENT_PERIOD)}-15T12:00:00.000Z`,
      ),
    });

    await expect(currentCapacity()).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    await expect(
      requestEmployeeLoan(ACTOR, {
        employeeId: EMPLOYEE_ID,
        amount: "1.00",
        clientRequestId: "future-hire-bonus-capacity-blocked",
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await db().select().from(s.employeeLoanRequests)).toHaveLength(0);
  });

  it("يسقف العقوبة من الأجر القابل للاستيعاب ويبقي السعة ثابتة بعد التقاطها في المسودة", async () => {
    const connection = db();
    await connection
      .update(s.payrollLegalSettings)
      .set({ socialSecurityEnabled: false, incomeTaxEnabled: false })
      .where(eq(s.payrollLegalSettings.id, 1));
    await seedAttendance({ date: "2030-06-05", amount: "1000.00", currentHourlyRate: "125.00" });
    const [penalty] = await connection.insert(s.employeePenalties).values({
      employeeId: EMPLOYEE_ID,
      branchId: BRANCH_ID,
      penaltyType: "SALARY_DEDUCTION",
      decisionNumber: "CAP-PENALTY-ARTICLE-57",
      decisionDate: "2030-06-06",
      reason: "عقوبة أعلى من السقف القانوني",
      deductionAmount: "200.00",
      status: "APPROVED",
      createdById: ACTOR.userId,
      approvedById: ACTOR.userId,
    });
    const input = {
      employeeId: EMPLOYEE_ID,
      scopedBranchId: BRANCH_ID,
      period: FIXED_PERIOD,
      asOf: FIXED_AS_OF,
    };

    const beforeDraft = await getEmployeeAdvanceCapacity(input);
    // 10% من 1000 = 100؛ المبلغ الاسمي 200 لا يخفض السعة إلى 800.
    expect(beforeDraft).toMatchObject({
      earnedCompensation: "1000.00",
      mandatoryDeductions: "100.00",
      maxAvailable: "900.00",
    });

    await connection.insert(s.payrollRuns).values({
      id: 1,
      period: FIXED_PERIOD,
      status: "draft",
      createdBy: ACTOR.userId,
      employeeCount: 1,
      totalGross: "1000.00",
      totalDeductions: "100.00",
      totalNet: "900.00",
    });
    await connection.insert(s.payrollItems).values({
      id: 1,
      runId: 1,
      employeeId: EMPLOYEE_ID,
      payType: "hourly",
      gross: "1000.00",
      deductions: "100.00",
      wageReduction: "100.00",
      net: "900.00",
    });
    await connection
      .update(s.employeePenalties)
      .set({ status: "APPLIED", payrollRunId: 1 })
      .where(eq(s.employeePenalties.id, penalty.insertId));

    const afterDraft = await getEmployeeAdvanceCapacity(input);
    expect(afterDraft).toMatchObject({
      mandatoryDeductions: beforeDraft.mandatoryDeductions,
      maxAvailable: beforeDraft.maxAvailable,
    });

    // بعد APPLIED تكون لقطة المسودة هي الحقيقة: لا تعاد إضافة العقوبة الاسمية،
    // ويضيّق/يوسّع تعديل المالك السعة بقدر صافي المسودة الفعلي.
    await updateItem(1, { deductions: "0.00" }, ACTOR);
    expect(await getEmployeeAdvanceCapacity(input)).toMatchObject({
      mandatoryDeductions: "0.00",
      maxAvailable: "1000.00",
    });
    await updateItem(1, { deductions: "200.00" }, ACTOR);
    expect(await getEmployeeAdvanceCapacity(input)).toMatchObject({
      mandatoryDeductions: "200.00",
      maxAvailable: "800.00",
    });
  });

  it("يحمل العقوبة القديمة غير الملتقطة في السعة ولا يعجّل قرار الشهر المستقبلي", async () => {
    const connection = db();
    await connection
      .update(s.payrollLegalSettings)
      .set({ socialSecurityEnabled: false, incomeTaxEnabled: false })
      .where(eq(s.payrollLegalSettings.id, 1));
    await seedAttendance({ date: "2030-06-05", amount: "1000.00", currentHourlyRate: "125.00" });
    await connection.insert(s.employeePenalties).values([
      {
        employeeId: EMPLOYEE_ID,
        branchId: BRANCH_ID,
        penaltyType: "SALARY_DEDUCTION",
        decisionNumber: "CAP-HISTORICAL-PENALTY",
        decisionDate: "2030-05-31",
        reason: "عقوبة قديمة غير ملتقطة",
        deductionAmount: "50.00",
        status: "APPROVED",
        createdById: ACTOR.userId,
        approvedById: ACTOR.userId,
      },
      {
        employeeId: EMPLOYEE_ID,
        branchId: BRANCH_ID,
        penaltyType: "SALARY_DEDUCTION",
        decisionNumber: "CAP-FUTURE-PENALTY",
        decisionDate: "2030-07-01",
        reason: "قرار شهر مستقبلي لا يدخل مبكراً",
        deductionAmount: "999.00",
        status: "APPROVED",
        createdById: ACTOR.userId,
        approvedById: ACTOR.userId,
      },
    ]);

    const capacity = await getEmployeeAdvanceCapacity({
      employeeId: EMPLOYEE_ID,
      scopedBranchId: BRANCH_ID,
      period: FIXED_PERIOD,
      asOf: FIXED_AS_OF,
    });

    expect(capacity).toMatchObject({
      earnedCompensation: "1000.00",
      mandatoryDeductions: "50.00",
      maxAvailable: "950.00",
    });
  });

  it("يحسب سقف العقوبة بعد الإجازة والقانوني مع المكافأة والعمولة", async () => {
    const connection = db();
    await connection
      .update(s.employees)
      .set({
        payType: "monthly",
        attendanceExempt: true,
        salary: "1000.00",
      })
      .where(eq(s.employees.id, EMPLOYEE_ID));
    await seedUnpaidLeave("2030-06-01", "2030-06-02", 2);
    await connection.insert(s.employeeSpotBonuses).values({
      employeeId: EMPLOYEE_ID,
      branchId: BRANCH_ID,
      amount: "100.00",
      reason: "مكافأة ضمن وعاء العقوبة",
      disbursementType: "PAYROLL_ADDITION",
      status: "APPROVED",
      createdById: ACTOR.userId,
      approvedById: ACTOR.userId,
      approvedAt: new Date("2030-06-06T12:00:00.000Z"),
    });
    await connection.insert(s.commissionPlans).values({
      id: 40,
      name: "خطة عمولة سقف العقوبة",
      createdBy: ACTOR.userId,
    });
    await connection.insert(s.commissionRuns).values({
      id: 41,
      period: FIXED_PERIOD,
      status: "approved",
      employeeCount: 1,
      totalCommission: "50.00",
      createdBy: ACTOR.userId,
      approvedBy: ACTOR.userId,
      approvedAt: new Date("2030-06-15T12:00:00.000Z"),
    });
    await connection.insert(s.commissionRunLines).values({
      runId: 41,
      employeeId: EMPLOYEE_ID,
      userId: ACTOR.userId,
      branchId: BRANCH_ID,
      planId: 40,
      commissionAmount: "50.00",
    });
    await connection.insert(s.employeePenalties).values({
      employeeId: EMPLOYEE_ID,
      branchId: BRANCH_ID,
      penaltyType: "SALARY_DEDUCTION",
      decisionNumber: "CAP-PENALTY-COMPONENTS",
      decisionDate: "2030-06-06",
      reason: "عقوبة تختبر الوعاء المركب",
      deductionAmount: "200.00",
      status: "APPROVED",
      createdById: ACTOR.userId,
      approvedById: ACTOR.userId,
    });

    const capacity = await getEmployeeAdvanceCapacity({
      employeeId: EMPLOYEE_ID,
      scopedBranchId: BRANCH_ID,
      period: FIXED_PERIOD,
      asOf: "2030-06-30",
    });

    // الراتب المكتسب 933.34 + المكافأة 100 + العمولة 50 - القانوني 196.33
    // = 887.01 قابل للاستيعاب؛ سقف العقوبة 88.70، والمتاح 798.31.
    expect(capacity).toMatchObject({
      earnedCompensation: "933.34",
      approvedAdditions: "150.00",
      mandatoryDeductions: "285.03",
      maxAvailable: "798.31",
    });
  });

  it("يدخل المكافأة القديمة والإرثية غير الملتقطة في السعة ولا يعجّل المستقبلية", async () => {
    const connection = db();
    await seedAttendance({ date: "2030-06-05", amount: "300.00", currentHourlyRate: "37.50" });
    await connection.insert(s.employeeSpotBonuses).values([
      {
        employeeId: EMPLOYEE_ID,
        branchId: BRANCH_ID,
        amount: "100.00",
        reason: "مكافأة قديمة غير ملتقطة",
        disbursementType: "PAYROLL_ADDITION",
        status: "APPROVED",
        createdById: ACTOR.userId,
        approvedById: ACTOR.userId,
        approvedAt: new Date("2030-05-31T20:30:00.000Z"),
      },
      {
        employeeId: EMPLOYEE_ID,
        branchId: BRANCH_ID,
        amount: "25.00",
        reason: "مكافأة إرثية بلا وقت اعتماد",
        disbursementType: "PAYROLL_ADDITION",
        status: "APPROVED",
        createdById: ACTOR.userId,
        approvedById: ACTOR.userId,
        approvedAt: null,
      },
      {
        employeeId: EMPLOYEE_ID,
        branchId: BRANCH_ID,
        amount: "999.00",
        reason: "مكافأة مستقبلية لا تدخل مبكراً",
        disbursementType: "PAYROLL_ADDITION",
        status: "APPROVED",
        createdById: ACTOR.userId,
        approvedById: ACTOR.userId,
        // 00:30 بغداد في 1 تموز، فلا تدخل سعة حزيران.
        approvedAt: new Date("2030-06-30T21:30:00.000Z"),
      },
    ]);

    const capacity = await getEmployeeAdvanceCapacity({
      employeeId: EMPLOYEE_ID,
      scopedBranchId: BRANCH_ID,
      period: FIXED_PERIOD,
      asOf: FIXED_AS_OF,
    });

    // 300 + 125 - (42.50 ضمان + 38.25 ضريبة) = 344.25.
    expect(capacity).toMatchObject({
      earnedCompensation: "300.00",
      approvedAdditions: "125.00",
      mandatoryDeductions: "80.75",
      maxAvailable: "344.25",
    });
  });

  it("يبني الحد من الأجر المكتسب والإضافات المعتمدة بعد القانوني والعقوبات والاستقطاعات الأخرى", async () => {
    const connection = db();
    await seedAttendance({ date: "2030-06-05", amount: "300.00", currentHourlyRate: "37.50" });
    await connection.insert(s.employeeSpotBonuses).values({
      employeeId: EMPLOYEE_ID,
      branchId: BRANCH_ID,
      amount: "100.00",
      reason: "مكافأة معتمدة للاختبار",
      disbursementType: "PAYROLL_ADDITION",
      status: "APPROVED",
      createdById: ACTOR.userId,
      approvedById: ACTOR.userId,
      approvedAt: new Date("2030-06-06T12:00:00.000Z"),
    });
    await connection.insert(s.employeePenalties).values({
      employeeId: EMPLOYEE_ID,
      branchId: BRANCH_ID,
      penaltyType: "SALARY_DEDUCTION",
      decisionNumber: "CAP-PENALTY-1",
      decisionDate: "2030-06-06",
      reason: "عقوبة معتمدة للاختبار",
      deductionAmount: "50.00",
      status: "APPROVED",
      createdById: ACTOR.userId,
      approvedById: ACTOR.userId,
    });
    await connection.insert(s.employeeSpotBonuses).values({
      employeeId: EMPLOYEE_ID,
      branchId: BRANCH_ID,
      amount: "999.00",
      reason: "مكافأة شهر مستقبلي لا تُعجّل",
      disbursementType: "PAYROLL_ADDITION",
      status: "APPROVED",
      createdById: ACTOR.userId,
      approvedById: ACTOR.userId,
      approvedAt: new Date("2030-07-20T12:00:00.000Z"),
    });
    await connection.insert(s.employeePenalties).values({
      employeeId: EMPLOYEE_ID,
      branchId: BRANCH_ID,
      penaltyType: "SALARY_DEDUCTION",
      decisionNumber: "CAP-PENALTY-FUTURE",
      decisionDate: "2030-07-20",
      reason: "عقوبة شهر مستقبلي لا تُعجّل",
      deductionAmount: "999.00",
      status: "APPROVED",
      createdById: ACTOR.userId,
      approvedById: ACTOR.userId,
    });
    await connection.insert(s.employeeAdvances).values({
      employeeId: EMPLOYEE_ID,
      branchId: BRANCH_ID,
      amount: "80.00",
      remaining: "80.00",
      monthlyDeduction: "30.00",
      sourceType: "OTHER_DEDUCTION",
      payrollPeriod: null,
      status: "ACTIVE",
      createdBy: ACTOR.userId,
    });

    const capacity = await getEmployeeAdvanceCapacity({
      employeeId: EMPLOYEE_ID,
      scopedBranchId: BRANCH_ID,
      period: FIXED_PERIOD,
      asOf: FIXED_AS_OF,
    });

    // 300 earned + 100 bonus - (40 social security + 36 tax)
    // - Article 57 penalty cap (10% × 324 = 32.40) - 30 other = 261.60.
    expect(capacity).toMatchObject({
      earnedCompensation: "300.00",
      approvedAdditions: "100.00",
      mandatoryDeductions: "108.40",
      otherEmployeeDeductions: "30.00",
      existingSalaryAdvances: "0.00",
      reservedRequests: "0.00",
      maxAvailable: "261.60",
      blocked: false,
      blockers: [],
    });
  });

  it("لا يحتسب الغياب أو الحضور المؤرخ بعد asOf ضمن الأجر المكتسب", async () => {
    await seedAttendance({ date: "2030-06-05", amount: "300.00", currentHourlyRate: "37.50" });
    const baseline = await getEmployeeAdvanceCapacity({
      employeeId: EMPLOYEE_ID,
      scopedBranchId: BRANCH_ID,
      period: FIXED_PERIOD,
      asOf: FIXED_AS_OF,
    });

    // حتى لو حمل صف الغياب مبلغاً قديماً فاسداً، لا يجوز أن يدخل وعاء الأجر.
    await seedAttendance({
      date: "2030-06-10",
      status: "ABSENT",
      amount: "999.00",
    });
    await seedAttendance({ date: "2030-06-20", amount: "700.00", currentHourlyRate: "87.50" });

    const atCutoff = await getEmployeeAdvanceCapacity({
      employeeId: EMPLOYEE_ID,
      scopedBranchId: BRANCH_ID,
      period: FIXED_PERIOD,
      asOf: FIXED_AS_OF,
    });
    expect(atCutoff.earnedCompensation).toBe("300.00");
    expect(atCutoff.maxAvailable).toBe(baseline.maxAvailable);

    const afterFutureAttendance = await getEmployeeAdvanceCapacity({
      employeeId: EMPLOYEE_ID,
      scopedBranchId: BRANCH_ID,
      period: FIXED_PERIOD,
      asOf: "2030-06-25",
    });
    expect(afterFutureAttendance.earnedCompensation).toBe("1000.00");
    expect(afterFutureAttendance.maxAvailable).toBe("810.00");
  });

  it("يستبعد اليوم المفتوح كله من الأجر والقانوني وسقف العقوبة دون تصفير الأيام المغلقة", async () => {
    const connection = db();
    await connection
      .update(s.employees)
      .set({
        payType: "monthly",
        attendanceExempt: false,
        salary: "2400.00",
        workSchedule: ALL_DAYS_TEN,
      })
      .where(eq(s.employees.id, EMPLOYEE_ID));
    await connection.insert(s.hrAttendanceSettings).values({
      id: 1,
      attendancePayEnabled: true,
      attendancePayFrom: "2030-06-01",
      updatedBy: ACTOR.userId,
    });
    await seedAttendance({ date: "2030-06-05", amount: "80.00", hourlyRate: "10.00" });
    await seedAttendance({
      date: "2030-06-06",
      amount: "80.00",
      hourlyRate: "10.00",
      source: "fingerprint",
      needsReview: true,
      reviewReason: "فترة دوام مفتوحة",
      checkIn: new Date("2030-06-06T08:00:00.000Z"),
      checkOut: null,
    });
    await connection.insert(s.employeePenalties).values({
      employeeId: EMPLOYEE_ID,
      branchId: BRANCH_ID,
      penaltyType: "SALARY_DEDUCTION",
      decisionNumber: "CAP-CONFIRMED-OPEN-DAY",
      decisionDate: "2030-06-06",
      reason: "اختبار سقف العقوبة من الأجر المؤكد",
      deductionAmount: "100.00",
      status: "APPROVED",
      createdById: ACTOR.userId,
      approvedById: ACTOR.userId,
    });

    const capacity = await getEmployeeAdvanceCapacity({
      employeeId: EMPLOYEE_ID,
      scopedBranchId: BRANCH_ID,
      period: FIXED_PERIOD,
      asOf: FIXED_AS_OF,
    });

    // 80 مؤكدة - (8 ضمان + 7.20 ضريبة) - سقف عقوبة 10% × 64.80 = 6.48.
    expect(capacity).toMatchObject({
      earnedCompensation: "80.00",
      mandatoryDeductions: "21.68",
      maxAvailable: "58.32",
      blocked: false,
      blockers: [],
      excludedAttendanceDates: ["2030-06-06"],
    });
    expect(capacity.warnings).toHaveLength(1);
  });

  it("يبقي الإجازة المدفوعة استحقاقاً مؤكداً ولو حمل يومها بصمة مفتوحة مستبعدة", async () => {
    const connection = db();
    await connection
      .update(s.employees)
      .set({
        payType: "monthly",
        attendanceExempt: false,
        salary: "2400.00",
        workSchedule: ALL_DAYS_TEN,
      })
      .where(eq(s.employees.id, EMPLOYEE_ID));
    await connection
      .update(s.payrollLegalSettings)
      .set({ socialSecurityEnabled: false, incomeTaxEnabled: false })
      .where(eq(s.payrollLegalSettings.id, 1));
    await connection.insert(s.hrAttendanceSettings).values({
      id: 1,
      attendancePayEnabled: true,
      attendancePayFrom: "2030-06-01",
      updatedBy: ACTOR.userId,
    });
    await seedPaidLeave("2030-06-05", "2030-06-05", 1);
    await seedAttendance({
      date: "2030-06-05",
      amount: "80.00",
      hourlyRate: "10.00",
      source: "fingerprint",
      needsReview: true,
      reviewReason: "فترة دوام مفتوحة",
      checkIn: new Date("2030-06-05T08:00:00.000Z"),
      checkOut: null,
    });

    const capacity = await getEmployeeAdvanceCapacity({
      employeeId: EMPLOYEE_ID,
      scopedBranchId: BRANCH_ID,
      period: FIXED_PERIOD,
      asOf: "2030-06-05",
    });

    expect(capacity).toMatchObject({
      earnedCompensation: "80.00",
      mandatoryDeductions: "0.00",
      maxAvailable: "80.00",
      blocked: false,
      excludedAttendanceDates: ["2030-06-05"],
    });
  });

  it("يحتسب الفترات المتعددة المغلقة ويستبعد اليوم ذي الفترة الثانية المفتوحة", async () => {
    const connection = db();
    await connection
      .update(s.employees)
      .set({
        payType: "monthly",
        attendanceExempt: false,
        salary: "2400.00",
        workSchedule: ALL_DAYS_TEN,
      })
      .where(eq(s.employees.id, EMPLOYEE_ID));
    await connection
      .update(s.payrollLegalSettings)
      .set({ socialSecurityEnabled: false, incomeTaxEnabled: false })
      .where(eq(s.payrollLegalSettings.id, 1));
    await connection.insert(s.hrAttendanceSettings).values({
      id: 1,
      attendancePayEnabled: true,
      attendancePayFrom: "2030-06-01",
      updatedBy: ACTOR.userId,
    });
    await seedAttendance({
      date: "2030-06-05",
      amount: "80.00",
      hourlyRate: "10.00",
      source: "fingerprint",
      checkIn: new Date("2030-06-05T08:00:00.000Z"),
      checkOut: new Date("2030-06-05T17:00:00.000Z"),
      notes: "[فترات الدوام: 08:00→12:00، 13:00→17:00 | استراحة/زمنية: 60 دقيقة]",
    });
    await seedAttendance({
      date: "2030-06-06",
      hours: "4.00",
      amount: "40.00",
      hourlyRate: "10.00",
      source: "fingerprint",
      checkIn: new Date("2030-06-06T08:00:00.000Z"),
      checkOut: new Date("2030-06-06T12:00:00.000Z"),
      notes: "[فترات الدوام: 08:00→12:00، 13:00→؟ | استراحة/زمنية: 60 دقيقة]",
    });

    const capacity = await getEmployeeAdvanceCapacity({
      employeeId: EMPLOYEE_ID,
      scopedBranchId: BRANCH_ID,
      period: FIXED_PERIOD,
      asOf: FIXED_AS_OF,
    });

    expect(capacity).toMatchObject({
      earnedCompensation: "80.00",
      maxAvailable: "80.00",
      blocked: false,
      excludedAttendanceDates: ["2030-06-06"],
    });
  });

  it("يقبل وسم الفترة الواحدة الصحيح ويستبعد الوسم المشوه أو المختلط", async () => {
    const connection = db();
    await connection
      .update(s.employees)
      .set({
        payType: "monthly",
        attendanceExempt: false,
        salary: "2400.00",
        workSchedule: ALL_DAYS_TEN,
      })
      .where(eq(s.employees.id, EMPLOYEE_ID));
    await connection
      .update(s.payrollLegalSettings)
      .set({ socialSecurityEnabled: false, incomeTaxEnabled: false })
      .where(eq(s.payrollLegalSettings.id, 1));
    await connection.insert(s.hrAttendanceSettings).values({
      id: 1,
      attendancePayEnabled: true,
      attendancePayFrom: "2030-06-01",
      updatedBy: ACTOR.userId,
    });
    await seedAttendance({
      date: "2030-06-05",
      amount: "80.00",
      hourlyRate: "10.00",
      source: "fingerprint",
      checkIn: new Date("2030-06-05T08:00:00.000Z"),
      checkOut: new Date("2030-06-05T16:00:00.000Z"),
      notes: "[فترات الدوام: 08:00→16:00]",
    });
    await seedAttendance({
      date: "2030-06-06",
      hours: "4.00",
      amount: "40.00",
      hourlyRate: "10.00",
      source: "fingerprint",
      checkIn: new Date("2030-06-06T08:00:00.000Z"),
      checkOut: new Date("2030-06-06T12:00:00.000Z"),
      notes: "[فترات الدوام: غير صالح]",
    });
    await seedAttendance({
      date: "2030-06-07",
      hours: "4.00",
      amount: "40.00",
      hourlyRate: "10.00",
      source: "fingerprint",
      checkIn: new Date("2030-06-07T08:00:00.000Z"),
      checkOut: new Date("2030-06-07T12:00:00.000Z"),
      notes: "[فترات الدوام: 08:00→12:00، غير صالح]",
    });

    const capacity = await getEmployeeAdvanceCapacity({
      employeeId: EMPLOYEE_ID,
      scopedBranchId: BRANCH_ID,
      period: FIXED_PERIOD,
      asOf: FIXED_AS_OF,
    });

    expect(capacity).toMatchObject({
      earnedCompensation: "80.00",
      maxAvailable: "80.00",
      blocked: false,
      excludedAttendanceDates: ["2030-06-06", "2030-06-07"],
    });
    expect(capacity.warnings).toHaveLength(1);
  });

  it("يثبت تعويض الشهر القصير عند نهايته فقط في الإسقاط المؤكد", async () => {
    const connection = db();
    await connection
      .update(s.employees)
      .set({
        payType: "monthly",
        attendanceExempt: false,
        salary: "2400.00",
        workSchedule: ALL_DAYS_TEN,
      })
      .where(eq(s.employees.id, EMPLOYEE_ID));
    await connection.insert(s.hrAttendanceSettings).values({
      id: 1,
      attendancePayEnabled: true,
      attendancePayFrom: "2030-02-01",
      updatedBy: ACTOR.userId,
    });
    await seedAttendance({ date: "2030-02-01", amount: "80.00", hourlyRate: "10.00" });

    const beforeEnd = await getEmployeeStatement({
      employeeId: EMPLOYEE_ID,
      scopedBranchId: BRANCH_ID,
      period: "2030-02",
      employmentEndOverride: "2030-02-27",
      confirmedAttendanceOnly: true,
    });
    const atEnd = await getEmployeeStatement({
      employeeId: EMPLOYEE_ID,
      scopedBranchId: BRANCH_ID,
      period: "2030-02",
      employmentEndOverride: "2030-02-28",
      confirmedAttendanceOnly: true,
    });

    expect(beforeEnd?.confirmedPayrollComponents).toMatchObject({ gross: "80.00", overtime: "0.00" });
    // شباط 28 يوماً: 16 ساعة تعويض × 10، ولا تُمنح قبل نهاية الشهر.
    expect(atEnd?.confirmedPayrollComponents).toMatchObject({ gross: "240.00", overtime: "0.00" });
    expect(beforeEnd?.amountDue).toBe("80.00");
    expect(atEnd?.amountDue).toBe("240.00");
  });

  it("يعيد إسقاط مبلغ الساعي اليدوي بلا أوقات من السعر الحالي ولا يثق بالمبلغ المخزن", async () => {
    await seedAttendance({
      date: "2030-06-05",
      hours: "8.00",
      amount: "500.00",
      hourlyRate: "1.00",
      currentHourlyRate: "125.00",
      source: "manual",
    });
    const statement = await getEmployeeStatement({
      employeeId: EMPLOYEE_ID,
      scopedBranchId: BRANCH_ID,
      period: FIXED_PERIOD,
      employmentEndOverride: FIXED_AS_OF,
      confirmedAttendanceOnly: true,
    });
    // الكشف المعتاد يبقى على اللقطة المخزنة؛ إسقاط القرار المالي وحده يعيد التسعير.
    expect(statement?.amountDue).toBe("500.00");
    expect(statement?.confirmedPayrollComponents).toMatchObject({
      basic: "1000.00",
      gross: "1000.00",
      overtime: "0.00",
    });
    expect(statement?.excludedAttendanceDates).toEqual([]);

    const capacity = await getEmployeeAdvanceCapacity({
      employeeId: EMPLOYEE_ID,
      scopedBranchId: BRANCH_ID,
      period: FIXED_PERIOD,
      asOf: FIXED_AS_OF,
    });
    expect(capacity).toMatchObject({
      earnedCompensation: "1000.00",
      mandatoryDeductions: "190.00",
      maxAvailable: "810.00",
      blocked: false,
    });
  });

  it("يطابق projector تقريب إعادة التسعير وسقوطها إلى السعر المخزن للساعات المقصوصة", () => {
    const current = projectAttendanceWage({
      employee: { payType: "hourly", dayRates: { الأربعاء: 41.666 } },
      date: "2030-06-05",
      // هذه لقطة الساعات بعد سقف الكاتب؛ projector لا يعيد اختراع سقف مختلف.
      hours: "12.00",
      storedHourlyRate: "1.00",
      status: "PRESENT",
    });
    expect(current.rate.toFixed(2)).toBe("41.67");
    expect(current.amount.toFixed(2)).toBe("500.00");

    const fallback = projectAttendanceWage({
      employee: { payType: "hourly", dayRates: null },
      date: "2030-06-05",
      hours: "12.00",
      storedHourlyRate: "41.67",
      status: "PRESENT",
    });
    expect(fallback.rate.toFixed(2)).toBe("41.67");
    expect(fallback.amount.toFixed(2)).toBe("500.00");
  });

  it.each([
    { label: "المعفى", attendanceExempt: true },
    { label: "الثابت مع تعطيل أجر الحضور", attendanceExempt: false },
  ])("يبقي أجر $label ولا يعرض تحذير حضور لا يؤثر في الحد", async ({ attendanceExempt }) => {
    await db()
      .update(s.employees)
      .set({ payType: "monthly", attendanceExempt, salary: "3000.00" })
      .where(eq(s.employees.id, EMPLOYEE_ID));
    await seedAttendance({
      date: "2030-06-05",
      amount: "8.00",
      source: "fingerprint",
      needsReview: true,
      reviewReason: "فترة دوام مفتوحة",
      checkIn: new Date("2030-06-05T08:00:00.000Z"),
      checkOut: null,
    });

    const capacity = await getEmployeeAdvanceCapacity({
      employeeId: EMPLOYEE_ID,
      scopedBranchId: BRANCH_ID,
      period: FIXED_PERIOD,
      asOf: FIXED_AS_OF,
    });

    expect(capacity).toMatchObject({
      earnedCompensation: "1500.00",
      mandatoryDeductions: "285.00",
      maxAvailable: "1215.00",
      blocked: false,
      excludedAttendanceDates: [],
      warnings: [],
    });
  });

  it("يحجب سلفة راتبية غير مسواة من شهر سابق طلباً شهرياً جديداً", async () => {
    await seedAttendance({ date: TODAY, amount: "1000.00", currentHourlyRate: "125.00" });
    const oldPeriod = previousPeriod(CURRENT_PERIOD);
    await db().insert(s.employeeAdvances).values({
      employeeId: EMPLOYEE_ID,
      branchId: BRANCH_ID,
      amount: "100.00",
      remaining: "100.00",
      monthlyDeduction: "100.00",
      sourceType: "SALARY_ADVANCE",
      payrollPeriod: oldPeriod,
      status: "ACTIVE",
      createdBy: ACTOR.userId,
    });

    const capacity = await currentCapacity();
    expect(capacity.blocked).toBe(true);
    expect(capacity.maxAvailable).toBe("0.00");
    expect(capacity.blockers).toContain(
      `توجد سلفة راتبية غير مسوّاة من شهر ${oldPeriod}`,
    );
    await expect(
      requestEmployeeLoan(ACTOR, {
        employeeId: EMPLOYEE_ID,
        amount: "1.00",
        clientRequestId: "blocked-by-old-salary-advance",
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await db().select().from(s.employeeLoanRequests)).toHaveLength(0);
  });

  it("يحجب طلباً تاريخياً بلا فترة قبل إنشاء طلب سلفة جديد", async () => {
    await seedAttendance({ date: TODAY, amount: "1000.00", currentHourlyRate: "125.00" });
    await db().insert(s.employeeLoanRequests).values({
      employeeId: EMPLOYEE_ID,
      branchId: BRANCH_ID,
      amount: "100.00",
      installmentsCount: 1,
      monthlyDeduction: "100.00",
      payrollPeriod: null,
      clientRequestId: "legacy-unclassified-request",
      status: "PENDING",
      createdById: ACTOR.userId,
    });

    const capacity = await currentCapacity();
    expect(capacity.blocked).toBe(true);
    expect(capacity.maxAvailable).toBe("0.00");
    expect(capacity.blockers).toContain(
      "يوجد طلب سلفة تاريخي غير مصنف؛ ألغِه أو أعد تقديمه للشهر الجاري",
    );
    await expect(
      requestEmployeeLoan(ACTOR, {
        employeeId: EMPLOYEE_ID,
        amount: "1.00",
        clientRequestId: "blocked-by-legacy-request",
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await db().select().from(s.employeeLoanRequests)).toHaveLength(1);
  });

  it("يرفض المبلغ الأعلى من maxAvailable بلا إنشاء طلب", async () => {
    await seedAttendance({ date: TODAY, amount: "1000.00", currentHourlyRate: "125.00" });
    const capacity = await currentCapacity();
    expect(capacity).toMatchObject({
      earnedCompensation: "1000.00",
      mandatoryDeductions: "190.00",
      maxAvailable: "810.00",
      blocked: false,
    });
    const overLimit = new Decimal(capacity.maxAvailable)
      .plus("0.01")
      .toFixed(2);

    await expect(
      requestEmployeeLoan(ACTOR, {
        employeeId: EMPLOYEE_ID,
        amount: overLimit,
        clientRequestId: "over-earned-capacity",
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await db().select().from(s.employeeLoanRequests)).toHaveLength(0);
  });
});
