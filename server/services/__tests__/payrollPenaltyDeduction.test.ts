/**
 * اختبارات تسقيف الجزاءات الانضباطية ومطابقة مسيّر الرواتب (GAP-01):
 * المادة (57) من قانون العمل العراقي رقم 37 لسنة 2015:
 *  - استقطاع الجزاءات التأديبية لا يتجاوز 10% من صافي الأجر الشهري.
 *  - صافي الراتب بعد التسقيف >= 0 دائماً.
 *  - توحيد معادلة classifiedDeductions مع deductions المخزنة (عبر wageReduction المدمج)،
 *    مما يحل تعارض الاعتماد التلقائي للمالك (PRECONDITION_FAILED).
 */
import Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";
import { MySql2PreparedQuery } from "drizzle-orm/mysql2/session";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb, getPool } from "../../db";
import { createEmployee } from "../employeeService";
import {
  IRAQI_LABOR_LAW_ARTICLE_57_PENALTY_CAP_RATIO,
  capPenaltyDeduction,
  computeArticle57PenaltyCap,
  computeNet,
  payrollBreakdown,
} from "../payroll/helpers";
import { generatePayroll } from "../payrollService";
import {
  approveEmployeePenalty,
  cancelEmployeePenalty,
  createEmployeePenalty,
} from "../employeePenaltyService";
import { withTx } from "../tx";

const TABLES = [
  "accountingEntries",
  "receipts",
  "payrollObligations",
  "payrollItems",
  "payrollRuns",
  "attendance",
  "leaveRequests",
  "employeePenalties",
  "employeeAdvances",
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

function pauseNextEmployeeForUpdate() {
  const execute = MySql2PreparedQuery.prototype.execute;
  let locked!: () => void;
  let release!: () => void;
  let paused = false;
  const lockReached = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const mayContinue = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spy = vi
    .spyOn(MySql2PreparedQuery.prototype, "execute")
    .mockImplementation(async function (
      this: typeof MySql2PreparedQuery.prototype,
      values,
    ) {
      const query = (this as unknown as { query: { sql: string } }).query.sql;
      const result = await execute.call(this, values);
      if (
        !paused &&
        query.includes("from `employees`") &&
        query.includes("for update")
      ) {
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
  throw new Error("لم يصل اختبار العقوبة إلى انتظار قفل الموظف المتوقع");
}

async function resetDb() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) {
    await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  }
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seedBaseData() {
  const d = db();
  await d
    .insert(s.branches)
    .values([
      { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
      { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
    ]);
  await d
    .insert(s.users)
    .values([
      { id: 1, openId: "test-admin", name: "مدير النظام", role: "admin", branchId: 1, isOwner: false },
      { id: 2, openId: "test-owner", name: "المالك المعتمد", role: "manager", branchId: 1, isOwner: true },
    ]);
  await d.insert(s.receipts).values([
    {
      branchId: 1,
      direction: "IN",
      amount: "100000000",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      referenceNumber: "TEST-TREASURY-B1",
      createdBy: 1,
    },
  ]);
}

describe("Article 57 Iraqi Labor Law — Unit Tests", () => {
  it("defines exact 10% statutory penalty cap ratio", () => {
    expect(IRAQI_LABOR_LAW_ARTICLE_57_PENALTY_CAP_RATIO.toString()).toBe("0.1");
  });

  it("calculates exact 10% penalty cap on various net salary bases", () => {
    expect(computeArticle57PenaltyCap(new Decimal("1000000")).toFixed(2)).toBe("100000.00");
    expect(computeArticle57PenaltyCap(new Decimal("750000")).toFixed(2)).toBe("750000" === "0" ? "0" : "75000.00");
    expect(computeArticle57PenaltyCap(new Decimal("1250500")).toFixed(2)).toBe("125050.00");
  });

  it("returns zero cap for zero or negative net salary", () => {
    expect(computeArticle57PenaltyCap(new Decimal("0")).toFixed(2)).toBe("0.00");
    expect(computeArticle57PenaltyCap(new Decimal("-50000")).toFixed(2)).toBe("0.00");
  });

  it("handles fractional rounding correctly using HALF_UP", () => {
    // 333,333.33 * 0.10 = 33,333.333 -> 33,333.33
    expect(computeArticle57PenaltyCap(new Decimal("333333.33")).toFixed(2)).toBe("33333.33");
    // 333,333.35 * 0.10 = 33,333.335 -> 33,333.34
    expect(computeArticle57PenaltyCap(new Decimal("333333.35")).toFixed(2)).toBe("33333.34");
  });

  it("caps penalty deductions at 10% boundary via capPenaltyDeduction", () => {
    const baseWage = new Decimal("1000000"); // Cap = 100,000

    // Under cap: deducted as-is
    expect(capPenaltyDeduction(baseWage, new Decimal("40000")).toFixed(2)).toBe("40000.00");

    // Exactly at cap: deducted as-is
    expect(capPenaltyDeduction(baseWage, new Decimal("100000")).toFixed(2)).toBe("100000.00");

    // Over cap: capped at 10%
    expect(capPenaltyDeduction(baseWage, new Decimal("150000")).toFixed(2)).toBe("100000.00");

    // Substantially over cap (e.g. 5M penalty on 1M salary): capped at 10%
    expect(capPenaltyDeduction(baseWage, new Decimal("5000000")).toFixed(2)).toBe("100000.00");
  });

  it("returns zero if raw penalty or base wage is non-positive", () => {
    const baseWage = new Decimal("1000000");
    expect(capPenaltyDeduction(baseWage, new Decimal("0")).toFixed(2)).toBe("0.00");
    expect(capPenaltyDeduction(baseWage, new Decimal("-50000")).toFixed(2)).toBe("0.00");

    expect(capPenaltyDeduction(new Decimal("0"), new Decimal("50000")).toFixed(2)).toBe("0.00");
    expect(capPenaltyDeduction(new Decimal("-200000"), new Decimal("50000")).toFixed(2)).toBe("0.00");
  });

  it("guarantees computeNet handles non-negative clamping option", () => {
    const gross = new Decimal("500000");
    const overtime = new Decimal("0");
    const commission = new Decimal("0");
    const hugeDeductions = new Decimal("800000");

    // Regular computeNet returns negative
    expect(computeNet(gross, overtime, commission, hugeDeductions).toFixed(2)).toBe("-300000.00");

    // Clamped computeNet returns zero
    expect(computeNet(gross, overtime, commission, hugeDeductions, true).toFixed(2)).toBe("0.00");
  });
});

describe("payrollBreakdown with Penalties — Unit Tests", () => {
  it("validates payroll item where wageReduction contains penalty deduction (DB row model)", () => {
    const item = {
      gross: "1000000.00",
      overtime: "0.00",
      commission: "0.00",
      deductions: "50000.00",
      wageReduction: "50000.00", // Contains 50,000 penalty
      advanceDeduction: "0.00",
      socialSecurityEmployee: "0.00",
      incomeTax: "0.00",
      socialSecurityEmployer: "0.00",
      endOfServiceAccrual: "0.00",
      net: "950000.00",
    };

    const breakdown = payrollBreakdown(item);
    expect(breakdown.wageReduction.toFixed(2)).toBe("50000.00");
    expect(breakdown.earnedWage.toFixed(2)).toBe("950000.00");
    expect(breakdown.net.toFixed(2)).toBe("950000.00");
    expect(breakdown.expenseTotal.toFixed(2)).toBe("950000.00");
  });

  it("validates payroll item with explicit penaltyDeduction parameter", () => {
    const item = {
      gross: "1000000.00",
      overtime: "0.00",
      commission: "0.00",
      deductions: "100000.00",
      wageReduction: "30000.00", // Leave deduction only
      penaltyDeduction: "70000.00", // Explicit penalty deduction
      advanceDeduction: "0.00",
      socialSecurityEmployee: "0.00",
      incomeTax: "0.00",
      socialSecurityEmployer: "0.00",
      endOfServiceAccrual: "0.00",
      net: "900000.00",
    };

    const breakdown = payrollBreakdown(item);
    expect(breakdown.wageReduction.toFixed(2)).toBe("30000.00");
    expect(breakdown.penaltyDeduction?.toFixed(2)).toBe("70000.00");
    expect(breakdown.earnedWage.toFixed(2)).toBe("900000.00");
    expect(breakdown.net.toFixed(2)).toBe("900000.00");
  });

  it("rejects unclassified deductions with Arabic contract error message", () => {
    const item = {
      gross: "1000000.00",
      overtime: "0.00",
      commission: "0.00",
      deductions: "150000.00", // Mismatched: sum is 100,000 but stored is 150,000
      wageReduction: "50000.00",
      advanceDeduction: "50000.00",
      socialSecurityEmployee: "0.00",
      incomeTax: "0.00",
      socialSecurityEmployer: "0.00",
      endOfServiceAccrual: "0.00",
      net: "850000.00",
    };

    expect(() => payrollBreakdown(item)).toThrow(/لا تطابق تصنيفها/);
  });

  it("rejects negative net salary in payrollBreakdown", () => {
    const item = {
      gross: "500000.00",
      overtime: "0.00",
      commission: "0.00",
      deductions: "600000.00",
      wageReduction: "600000.00",
      advanceDeduction: "0.00",
      socialSecurityEmployee: "0.00",
      incomeTax: "0.00",
      socialSecurityEmployer: "0.00",
      endOfServiceAccrual: "0.00",
      net: "-100000.00",
    };

    expect(() => payrollBreakdown(item)).toThrow(/لا يجوز وجود مبلغ سالب/);
  });
});

describe("Payroll Generation & Approval with Penalties — Integration DB Tests", () => {
  beforeEach(async () => {
    await resetDb();
    await seedBaseData();
  });

  it.each(["draft", "approved", "paid"] as const)(
    "approves nonfinancial disciplinary records while payroll is %s",
    async (status) => {
      const employee = await createEmployee({
        firstName: "موظف",
        lastName: "بقرار انضباطي دون استقطاع",
        payType: "monthly",
        salary: "1000000",
        branchId: 1,
      });
      if (!employee) throw new Error("Expected employee fixture");
      await db().insert(s.payrollRuns).values({
        id: 1000, period: "2026-06", status, createdBy: 1,
      });
      const actor = { userId: 1, role: "admin", branchId: 1 };
      for (const penaltyType of ["ATTENTION", "WARNING", "SUSPENSION", "DISMISSAL"] as const) {
        const penalty = await createEmployeePenalty(actor, {
          employeeId: employee.id,
          penaltyType,
          decisionNumber: `NONFIN-${status}-${penaltyType}`,
          decisionDate: "2026-06-15",
          reason: "قرار انضباطي لا يغير استحقاق الراتب",
          deductionDays: 1,
          deductionAmount: "50000.00",
        });
        await expect(approveEmployeePenalty(actor, penalty.id)).resolves.toMatchObject({ status: "APPROVED" });
      }
      const rows = await db().select().from(s.employeePenalties);
      expect(rows).toHaveLength(4);
      expect(rows.every(row => row.status === "APPROVED" && row.deductionAmount === "0.00")).toBe(true);
      const [run] = await db().select().from(s.payrollRuns).where(eq(s.payrollRuns.id, 1000));
      expect(run.status).toBe(status);
      expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
      expect(await db().select().from(s.receipts)).toHaveLength(1);
    },
  );

  it.each(["draft", "approved", "paid"] as const)(
    "still rejects a new monetary penalty while payroll is %s",
    async (status) => {
      const employee = await createEmployee({
        firstName: "موظف",
        lastName: "باستقطاع مالي لاحق للمسير",
        payType: "monthly",
        salary: "1000000",
        branchId: 1,
      });
      if (!employee) throw new Error("Expected employee fixture");
      const actor = { userId: 1, role: "admin", branchId: 1 };
      const penalty = await createEmployeePenalty(actor, {
        employeeId: employee.id,
        penaltyType: "SALARY_DEDUCTION",
        decisionNumber: `FIN-${status}`,
        decisionDate: "2026-06-15",
        reason: "استقطاع مالي لم تلتقطه لقطة المسير",
        deductionAmount: "50000.00",
      });
      await db().insert(s.payrollRuns).values({
        id: 1000, period: "2026-06", status, createdBy: 1,
      });
      await expect(approveEmployeePenalty(actor, penalty.id)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
      const [row] = await db().select().from(s.employeePenalties).where(eq(s.employeePenalties.id, penalty.id));
      expect(row.status).toBe("DRAFT");
      expect(row.approvedById).toBeNull();
    },
  );

  it("serializes approval and cancellation on the employee lock without a deadlock", async () => {
    const employee = await createEmployee({
      firstName: "موظف",
      lastName: "سباق اعتماد وإلغاء العقوبة",
      payType: "monthly",
      salary: "1000000",
      branchId: 1,
    });
    if (!employee) throw new Error("Expected employee fixture");
    const actor = { userId: 1, role: "admin", branchId: 1 };
    const originalReason = "استقطاع قيد مراجعة متزامنة";
    const penalty = await createEmployeePenalty(actor, {
      employeeId: employee.id,
      penaltyType: "SALARY_DEDUCTION",
      decisionNumber: "PEN-APPROVE-CANCEL-RACE",
      decisionDate: "2026-06-15",
      reason: originalReason,
      deductionAmount: "50000.00",
    });

    const barrier = pauseNextEmployeeForUpdate();
    let approval: ReturnType<typeof approveEmployeePenalty> | undefined;
    let cancellation: ReturnType<typeof cancelEmployeePenalty> | undefined;
    try {
      approval = approveEmployeePenalty(actor, penalty.id);
      await barrier.lockReached;
      cancellation = cancelEmployeePenalty(actor, penalty.id, "إلغاء متزامن");
      await waitForEmployeeLockWait();
      barrier.release();

      const [approved, cancelled] = await Promise.allSettled([
        approval,
        cancellation,
      ]);
      expect(approved).toMatchObject({
        status: "fulfilled",
        value: { status: "APPROVED" },
      });
      expect(cancelled).toMatchObject({
        status: "rejected",
        reason: { code: "CONFLICT" },
      });
      if (cancelled.status === "rejected") {
        expect(String(cancelled.reason)).not.toContain("ER_LOCK_DEADLOCK");
      }
    } finally {
      barrier.release();
      await Promise.allSettled(
        [approval, cancellation].filter(Boolean) as Promise<unknown>[],
      );
      barrier.restore();
    }

    const [stored] = await db()
      .select()
      .from(s.employeePenalties)
      .where(eq(s.employeePenalties.id, penalty.id));
    expect(stored).toMatchObject({
      status: "APPROVED",
      approvedById: actor.userId,
      payrollRunId: null,
      reason: originalReason,
    });
    expect(await db().select().from(s.payrollRuns)).toHaveLength(0);
    expect(await db().select().from(s.payrollItems)).toHaveLength(0);
    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
    expect(await db().select().from(s.receipts)).toHaveLength(1);
  }, 15_000);

  it("maps a busy payroll source lock to CONFLICT and rolls cancellation back", async () => {
    const employee = await createEmployee({
      firstName: "موظف",
      lastName: "مصدر عقوبة مقفول",
      payType: "monthly",
      salary: "1000000",
      branchId: 1,
    });
    if (!employee) throw new Error("Expected employee fixture");
    const actor = { userId: 1, role: "admin", branchId: 1 };
    const penalty = await createEmployeePenalty(actor, {
      employeeId: employee.id,
      penaltyType: "SALARY_DEDUCTION",
      decisionNumber: "PEN-BUSY-RUN",
      decisionDate: "2026-07-15",
      reason: "استقطاع لا يجوز إلغاؤه فوق مصدر مشغول",
      deductionAmount: "50000.00",
    });
    const [runResult] = await db().insert(s.payrollRuns).values({
      period: "2026-07",
      status: "draft",
      createdBy: actor.userId,
    });
    let locked!: () => void;
    let release!: () => void;
    const lockReached = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const mayContinue = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = withTx(async (tx) => {
      await tx
        .select({ id: s.payrollRuns.id })
        .from(s.payrollRuns)
        .where(eq(s.payrollRuns.id, runResult.insertId))
        .for("update")
        .limit(1);
      locked();
      await mayContinue;
    });
    await lockReached;

    const cancellation = cancelEmployeePenalty(
      actor,
      penalty.id,
      "إلغاء أثناء قفل المسيّر",
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        cancellation.then(
          (value) => ({ status: "fulfilled" as const, value }),
          (reason: unknown) => ({ status: "rejected" as const, reason }),
        ),
        new Promise<{ status: "timeout" }>((resolve) => {
          timer = setTimeout(() => resolve({ status: "timeout" }), 2_000);
        }),
      ]);
      expect(outcome).toMatchObject({
        status: "rejected",
        reason: { code: "CONFLICT" },
      });
    } finally {
      if (timer) clearTimeout(timer);
      release();
      await Promise.allSettled([holder, cancellation]);
    }

    const [stored] = await db()
      .select()
      .from(s.employeePenalties)
      .where(eq(s.employeePenalties.id, penalty.id));
    expect(stored).toMatchObject({
      status: "DRAFT",
      approvedById: null,
      payrollRunId: null,
    });
    expect(await db().select().from(s.payrollItems)).toHaveLength(0);
    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
    expect(await db().select().from(s.receipts)).toHaveLength(1);
  }, 15_000);

  it("successfully generates and auto-approves payroll for an employee with penalty within 10% cap", async () => {
    const emp = await createEmployee({
      firstName: "أحمد",
      lastName: "البصري",
      payType: "monthly",
      salary: "1000000",
      allowances: "0",
    });

    // إضافة عقوبة معتمدة بقيمة 50,000 د.ع (5% <= 10%)
    await db().insert(s.employeePenalties).values({
      employeeId: emp!.id,
      branchId: 1,
      penaltyType: "SALARY_DEDUCTION",
      decisionNumber: "PEN-2026-001",
      decisionDate: "2026-05-01",
      reason: "مخالفة انضباطية أولى",
      deductionDays: "0.00",
      deductionAmount: "50000.00",
      status: "APPROVED",
      createdById: 1,
      approvedById: 2,
      approvedAt: new Date("2026-05-02T10:00:00Z"),
    });

    // توليد المسير بواسطة المالك -> يطلق الاعتماد التلقائي
    const run = await generatePayroll("2026-05", {
      userId: 2,
      branchId: 1,
      isOwner: true,
      role: "manager",
    });

    expect(run).toBeDefined();
    expect(run!.status).toBe("approved");
    expect(run!.items.length).toBe(1);

    const item = run!.items[0];
    expect(Number(item.gross)).toBe(1000000);
    expect(Number(item.deductions)).toBe(50000);
    expect(Number(item.wageReduction)).toBe(50000); // Penalty recorded in wageReduction
    expect(Number(item.net)).toBe(950000);

    // التحقق من تحديث حالة العقوبة إلى APPLIED وربطها برقم المسير
    const [penaltyRow] = await db()
      .select()
      .from(s.employeePenalties)
      .where(eq(s.employeePenalties.employeeId, emp!.id));

    expect(penaltyRow.status).toBe("APPLIED");
    expect(Number(penaltyRow.payrollRunId)).toBe(Number(run!.id));

    // التحقق من إنشاء الالتزام المحاسبي للصافي
    const obligations = await db()
      .select()
      .from(s.payrollObligations)
      .where(eq(s.payrollObligations.runId, Number(run!.id)));

    const netObligation = obligations.find((o) => o.kind === "SALARY_NET");
    expect(netObligation).toBeDefined();
    expect(Number(netObligation!.originalAmount)).toBe(950000);
  });

  it("caps penalties exceeding 10% of salary according to Article 57 and approves without conflict", async () => {
    const emp = await createEmployee({
      firstName: "حيدر",
      lastName: "الكرخي",
      payType: "monthly",
      salary: "1000000",
      allowances: "0",
    });

    // عقوبة بقيمة 250,000 د.ع (25% من الراتب — تتجاوز سقف الـ 10%)
    await db().insert(s.employeePenalties).values({
      employeeId: emp!.id,
      branchId: 1,
      penaltyType: "SALARY_DEDUCTION",
      decisionNumber: "PEN-2026-002",
      decisionDate: "2026-06-01",
      reason: "تكرار الغياب غير المبرر",
      deductionDays: "0.00",
      deductionAmount: "250000.00",
      status: "APPROVED",
      createdById: 1,
      approvedById: 2,
      approvedAt: new Date("2026-06-02T10:00:00Z"),
    });

    // توليد المسير بواسطة المالك
    const run = await generatePayroll("2026-06", {
      userId: 2,
      branchId: 1,
      isOwner: true,
      role: "manager",
    });

    expect(run).toBeDefined();
    expect(run!.status).toBe("approved");

    const item = run!.items[0];
    expect(Number(item.gross)).toBe(1000000);
    // تم تسقيف الاستقطاع إلى 100,000 د.ع بالضبط (10% من 1,000,000)
    expect(Number(item.deductions)).toBe(100000);
    expect(Number(item.wageReduction)).toBe(100000);
    expect(Number(item.net)).toBe(900000);

    // سجل العقوبة تم اعتماده وربطه بالمسير
    const [penaltyRow] = await db()
      .select()
      .from(s.employeePenalties)
      .where(eq(s.employeePenalties.employeeId, emp!.id));
    expect(penaltyRow).toBeDefined();
    expect(penaltyRow.status).toBe("APPLIED");
    expect(Number(penaltyRow.payrollRunId)).toBe(Number(run!.id));
  });

  it("guarantees net salary is never negative even when raw penalty exceeds total salary", async () => {
    const emp = await createEmployee({
      firstName: "سلمان",
      lastName: "النجفي",
      payType: "monthly",
      salary: "500000",
      allowances: "0",
    });

    // عقوبة خيالية تفوق الراتب بعشرة أضعاف (5,000,000 د.ع)
    await db().insert(s.employeePenalties).values({
      employeeId: emp!.id,
      branchId: 1,
      penaltyType: "SALARY_DEDUCTION",
      decisionNumber: "PEN-2026-003",
      decisionDate: "2026-07-01",
      reason: "إتلاف عتاد ومعدات",
      deductionDays: "0.00",
      deductionAmount: "5000000.00",
      status: "APPROVED",
      createdById: 1,
      approvedById: 2,
      approvedAt: new Date("2026-07-02T10:00:00Z"),
    });

    const run = await generatePayroll("2026-07", {
      userId: 2,
      branchId: 1,
      isOwner: true,
      role: "manager",
    });

    expect(run).toBeDefined();
    expect(run!.status).toBe("approved");

    const item = run!.items[0];
    expect(Number(item.gross)).toBe(500000);
    // تسقيف إلى 50,000 د.ع (10% من 500,000)
    expect(Number(item.deductions)).toBe(50000);
    expect(Number(item.wageReduction)).toBe(50000);
    expect(Number(item.net)).toBe(450000);
    expect(Number(item.net)).toBeGreaterThanOrEqual(0);
  });

  it("correctly aggregates multiple penalties for the same employee and enforces the 10% cap on total", async () => {
    const emp = await createEmployee({
      firstName: "كرار",
      lastName: "العامري",
      payType: "monthly",
      salary: "800000", // 10% cap = 80,000
      allowances: "0",
    });

    // عقوبتان: 50,000 + 60,000 = 110,000 (تتجاوز سقف 80,000)
    await db().insert(s.employeePenalties).values([
      {
        employeeId: emp!.id,
        branchId: 1,
        penaltyType: "WARNING",
        decisionNumber: "PEN-2026-004A",
        decisionDate: "2026-08-01",
        reason: "إنذار أول",
        deductionDays: "0.00",
        deductionAmount: "50000.00",
        status: "APPROVED",
        createdById: 1,
        approvedById: 2,
        approvedAt: new Date("2026-08-02T10:00:00Z"),
      },
      {
        employeeId: emp!.id,
        branchId: 1,
        penaltyType: "SALARY_DEDUCTION",
        decisionNumber: "PEN-2026-004B",
        decisionDate: "2026-08-05",
        reason: "خصم تأخير",
        deductionDays: "0.00",
        deductionAmount: "60000.00",
        status: "APPROVED",
        createdById: 1,
        approvedById: 2,
        approvedAt: new Date("2026-08-06T10:00:00Z"),
      },
    ]);

    const run = await generatePayroll("2026-08", {
      userId: 2,
      branchId: 1,
      isOwner: true,
      role: "manager",
    });

    expect(run).toBeDefined();
    expect(run!.status).toBe("approved");

    const item = run!.items[0];
    expect(Number(item.deductions)).toBe(80000); // المسقف عند 80,000
    expect(Number(item.wageReduction)).toBe(80000);
    expect(Number(item.net)).toBe(720000);

    // كِلا العقوبتين أصبحت APPLIED ومربوطة بالمسير
    const penalties = await db()
      .select()
      .from(s.employeePenalties)
      .where(eq(s.employeePenalties.employeeId, emp!.id));

    expect(penalties.length).toBe(2);
    expect(penalties.every((p) => p.status === "APPLIED")).toBe(true);
    expect(penalties.every((p) => Number(p.payrollRunId) === Number(run!.id))).toBe(true);
  });

  it("integrates penalties with unpaid leave deductions and advances without collision", async () => {
    const emp = await createEmployee({
      firstName: "يوسف",
      lastName: "السعدي",
      payType: "monthly",
      salary: "1200000",
      allowances: "0",
    });

    // 1. إجازة بلا راتب: 3 أيام داخل الشهر (2026-09)
    // خصم الإجازة = 1,200,000 ÷ 30 × 3 = 120,000 د.ع
    await db().insert(s.leaveRequests).values({
      employeeId: emp!.id,
      leaveType: "بدون راتب",
      paid: false,
      fromDate: "2026-09-10",
      toDate: "2026-09-12",
      days: 3,
      status: "approved",
    });

    // الأجر المتاح للاستيعاب = 1,200,000 − 120,000 = 1,080,000 د.ع
    // سقف الجزاءات القانوني = 10% من 1,080,000 = 108,000 د.ع

    // 2. عقوبة بقيمة 200,000 د.ع -> تُسقَّف إلى 108,000 د.ع
    await db().insert(s.employeePenalties).values({
      employeeId: emp!.id,
      branchId: 1,
      penaltyType: "SALARY_DEDUCTION",
      decisionNumber: "PEN-2026-005",
      decisionDate: "2026-09-02",
      reason: "مخالفة تشغيلية",
      deductionDays: "0.00",
      deductionAmount: "200000.00",
      status: "APPROVED",
      createdById: 1,
      approvedById: 2,
      approvedAt: new Date("2026-09-03T10:00:00Z"),
    });

    // المتبقي المتاح للسلفة = 1,080,000 − 108,000 = 972,000 د.ع

    // 3. سلفة نشطة بقيمة 300,000 د.ع وقسط شهري 300,000 د.ع (تستوعب بالكامل)
    await db().insert(s.employeeAdvances).values({
      id: 99,
      employeeId: emp!.id,
      branchId: 1,
      amount: "300000.00",
      remaining: "300000.00",
      monthlyDeduction: "300000.00",
      sourceType: "SALARY_ADVANCE",
      payrollPeriod: "2026-09",
      status: "ACTIVE",
      createdBy: 1,
    });

    // توليد المسير بواسطة المالك
    const run = await generatePayroll("2026-09", {
      userId: 2,
      branchId: 1,
      isOwner: true,
      role: "manager",
    });

    expect(run).toBeDefined();
    expect(run!.status).toBe("approved");

    const item = run!.items[0];
    expect(Number(item.gross)).toBe(1200000);

    // الاستقطاعات:
    // wageReduction = leaveDeduction (120,000) + penaltyDeduction (108,000) = 228,000
    expect(Number(item.wageReduction)).toBe(228000);

    // advanceDeduction = 300,000
    expect(Number(item.advanceDeduction)).toBe(300000);

    // deductions = 228,000 + 300,000 = 528,000
    expect(Number(item.deductions)).toBe(528000);

    // net = 1,200,000 − 528,000 = 672,000
    expect(Number(item.net)).toBe(672000);
  });
});
