import Decimal from "decimal.js";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { baghdadToday } from "../businessDay";
import {
  getEmployeeAdvanceCapacity,
  type EmployeeAdvanceCapacity,
} from "../employeeAdvanceCapacityService";
import { requestEmployeeLoan } from "../employeeLoanService";
import type { Actor } from "../tx";

const EMPLOYEE_ID = 10;
const BRANCH_ID = 1;
const ACTOR: Actor = { userId: 1, branchId: BRANCH_ID, role: "cashier" };
const FIXED_PERIOD = "2030-06";
const FIXED_AS_OF = "2030-06-15";
const TODAY = baghdadToday();
const CURRENT_PERIOD = TODAY.slice(0, 7);

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
}) {
  await db()
    .insert(s.attendance)
    .values({
      employeeId: EMPLOYEE_ID,
      branchId: BRANCH_ID,
      attendanceDate: input.date,
      status: input.status ?? "PRESENT",
      hours: input.hours ?? "8.00",
      hourlyRate: "1.00",
      amount: input.amount,
      source: "manual",
      needsReview: false,
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

  it("يبني الحد من الأجر المكتسب والإضافات المعتمدة بعد القانوني والعقوبات والاستقطاعات الأخرى", async () => {
    const connection = db();
    await seedAttendance({ date: "2030-06-05", amount: "300.00" });
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
      reason: "مكافأة شهر سابق لا تُرحّل",
      disbursementType: "PAYROLL_ADDITION",
      status: "APPROVED",
      createdById: ACTOR.userId,
      approvedById: ACTOR.userId,
      approvedAt: new Date("2030-05-20T12:00:00.000Z"),
    });
    await connection.insert(s.employeePenalties).values({
      employeeId: EMPLOYEE_ID,
      branchId: BRANCH_ID,
      penaltyType: "SALARY_DEDUCTION",
      decisionNumber: "CAP-PENALTY-OLD",
      decisionDate: "2030-05-20",
      reason: "عقوبة شهر سابق لا تُرحّل",
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

    // 300 earned + 100 bonus - (40 social security + 36 tax + 50 penalty)
    // - 30 other employee deduction = 244 available.
    expect(capacity).toMatchObject({
      earnedCompensation: "300.00",
      approvedAdditions: "100.00",
      mandatoryDeductions: "126.00",
      otherEmployeeDeductions: "30.00",
      existingSalaryAdvances: "0.00",
      reservedRequests: "0.00",
      maxAvailable: "244.00",
      blocked: false,
      blockers: [],
    });
  });

  it("لا يحتسب الغياب أو الحضور المؤرخ بعد asOf ضمن الأجر المكتسب", async () => {
    await seedAttendance({ date: "2030-06-05", amount: "300.00" });
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
    await seedAttendance({ date: "2030-06-20", amount: "700.00" });

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

  it("يحجب سلفة راتبية غير مسواة من شهر سابق طلباً شهرياً جديداً", async () => {
    await seedAttendance({ date: TODAY, amount: "1000.00" });
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
    await seedAttendance({ date: TODAY, amount: "1000.00" });
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
    await seedAttendance({ date: TODAY, amount: "1000.00" });
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
