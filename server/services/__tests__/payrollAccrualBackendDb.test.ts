import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySql2PreparedQuery } from "drizzle-orm/mysql2/session";
import * as s from "../../../drizzle/schema";
import { getDb, getPool } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { money, toDateStr } from "../money";
import { POSTING_POLICY_HASH } from "../accounting/postingEngine";
import { readSalarySettlementEvidence } from "../payroll/settlementEvidence";
import { approvePayrollAccrualTx } from "../payroll/obligations";
import { payrollHash } from "../payroll/helpers";
import { PAYROLL_LEGAL_DEFAULTS } from "../payrollLegalService";
import { approveRun as approveCommissionRun } from "../commissions/runs";
import { disburseEmployeeLoan } from "../employeeLoanService";
import { cancelEmployeePenalty } from "../employeePenaltyService";
import { withTx } from "../tx";
import {
  cancelLockedEmployeeAdvanceTx,
  grantAdvance,
  lockUntouchedEmployeeAdvanceForCancellationTx,
} from "../advances";
import { buildPayrollLegalPolicyEvidence } from "../payroll/legalSnapshot";
import {
  approveRemittanceRequest,
  approveRun,
  cancelRun,
  createRemittanceRequest,
  generatePayroll,
  getPayrollFinancialLedger,
  getRun,
  listRuns,
  listStatutoryObligationSummary,
  payRemittanceRequest,
  payRun,
  rejectRemittanceRequest,
  returnRemittance,
  returnSalaryPayment,
  updateItem,
} from "../payrollService";

const MAKER = { userId: 1, branchId: 1, role: "admin" };
const CHECKER = { userId: 2, branchId: 1, role: "manager" };
const PAYER = { userId: 3, branchId: 1, role: "manager" };
const RETURN_CHECKER = { userId: 4, branchId: 1, role: "manager" };
const NON_OWNER_HR = { userId: 5, branchId: 1, role: "manager" };
const INACTIVE_OWNER = { userId: 6, branchId: 1, role: "manager" };

const TABLES = [
  "commissionRunLines",
  "commissionRuns",
  "commissionPlans",
  "payrollObligationAllocations",
  "payrollAccountingEvents",
  "payrollObligations",
  "payrollRemittanceRequests",
  "advanceSettlements",
  "journalLines",
  "journalEntries",
  "accountingEntries",
  "idempotencyKeys",
  "receipts",
  "employeeLoanRequests",
  "shifts",
  "financialPeriods",
  "payrollItems",
  "payrollRuns",
  "employeePenalties",
  "employeeSpotBonuses",
  "employeeAdvances",
  "employeeTerminations",
  "employees",
  "payrollLegalSettings",
  "documentCounters",
  "branches",
  "users",
];

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function reset() {
  const runner = db();
  await runner.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of TABLES) {
    await runner.execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  }
  await runner.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seedBase() {
  const runner = db();
  await runner.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
  ]);
  await runner.insert(s.users).values([
    {
      id: 1,
      openId: "payroll-maker",
      role: "admin",
      branchId: 1,
      isOwner: true,
    },
    {
      id: 2,
      openId: "payroll-checker",
      role: "manager",
      branchId: 1,
      isOwner: true,
    },
    {
      id: 3,
      openId: "payroll-payer",
      role: "manager",
      branchId: 1,
      isOwner: true,
    },
    {
      id: 4,
      openId: "payroll-return-checker",
      role: "manager",
      branchId: 1,
      isOwner: true,
    },
    { id: 5, openId: "payroll-hr-full", role: "manager", branchId: 1 },
    {
      id: 6,
      openId: "payroll-inactive-owner",
      role: "manager",
      branchId: 1,
      isOwner: true,
      isActive: false,
    },
  ]);
  await runner.insert(s.receipts).values({
    branchId: 1,
    direction: "IN",
    amount: "10000.00",
    paymentMethod: "CASH",
    cashBucket: "TREASURY",
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    referenceNumber: "PAYROLL-TEST-FUND",
    createdBy: 1,
  });
  await runner.insert(s.employees).values([
    {
      id: 10,
      branchId: 1,
      firstName: "موظف",
      lastName: "اختبار",
      payType: "monthly",
      salary: "1000.00",
    },
    {
      id: 11,
      branchId: 1,
      firstName: "موظف",
      lastName: "ثانٍ",
      payType: "monthly",
      salary: "400.00",
    },
  ]);
  await runner.insert(s.employeeAdvances).values({
    id: 20,
    employeeId: 10,
    branchId: 1,
    amount: "500.00",
    remaining: "500.00",
    monthlyDeduction: "100.00",
    sourceType: "OTHER_DEDUCTION",
    status: "ACTIVE",
    createdBy: 1,
  });
}

async function seedDraft(period = "2026-07") {
  const runner = db();
  const legalPolicy = buildPayrollLegalPolicyEvidence(PAYROLL_LEGAL_DEFAULTS);
  const inserted = await runner.insert(s.payrollRuns).values({
    period,
    branchId: 1,
    status: "draft",
    employeeCount: 1,
    totalGross: "1000.00",
    totalOvertime: "100.00",
    totalCommission: "50.00",
    totalDeductions: "250.00",
    totalNet: "900.00",
    totalSocialSecurityEmployee: "80.00",
    totalIncomeTax: "50.00",
    totalSocialSecurityEmployer: "120.00",
    totalEndOfServiceAccrual: "40.00",
    legalPolicySnapshot: legalPolicy.snapshot,
    legalPolicyHash: legalPolicy.hash,
    createdBy: MAKER.userId,
  });
  const runId = extractInsertId(inserted);
  await runner.insert(s.payrollItems).values({
    runId,
    employeeId: 10,
    branchIdSnapshot: 1,
    payType: "monthly",
    gross: "1000.00",
    overtime: "100.00",
    commission: "50.00",
    deductions: "250.00",
    wageReduction: "20.00",
    advanceDeduction: "100.00",
    socialSecurityEmployee: "80.00",
    incomeTax: "50.00",
    socialSecurityEmployer: "120.00",
    endOfServiceAccrual: "40.00",
    net: "900.00",
  });
  return runId;
}

async function seedTwoEmployeeDraft(period = "2026-07") {
  const runner = db();
  // هذا السيناريو يختبر دفع موظفين وإعادة أحد الدفعين فقط، بلا دين موظف جانبي.
  await runner.delete(s.employeeAdvances).where(eq(s.employeeAdvances.id, 20));
  const legalPolicy = buildPayrollLegalPolicyEvidence(PAYROLL_LEGAL_DEFAULTS);
  const inserted = await runner.insert(s.payrollRuns).values({
    period,
    branchId: 1,
    status: "draft",
    employeeCount: 2,
    totalGross: "1000.00",
    totalNet: "1000.00",
    legalPolicySnapshot: legalPolicy.snapshot,
    legalPolicyHash: legalPolicy.hash,
    createdBy: MAKER.userId,
  });
  const runId = extractInsertId(inserted);
  await runner.insert(s.payrollItems).values([
    {
      runId,
      employeeId: 10,
      branchIdSnapshot: 1,
      payType: "monthly",
      gross: "750.00",
      net: "750.00",
    },
    {
      runId,
      employeeId: 11,
      branchIdSnapshot: 1,
      payType: "monthly",
      gross: "250.00",
      net: "250.00",
    },
  ]);
  return runId;
}

async function seedZeroNetStatutoryDraft(period = "2026-07") {
  const runner = db();
  // الاستقطاع الآخر في هذا السيناريو 500 كي يبقى الصافي صفراً بعد المزامنة عند الاعتماد.
  await runner
    .update(s.employeeAdvances)
    .set({ monthlyDeduction: "500.00" })
    .where(eq(s.employeeAdvances.id, 20));
  const legalPolicy = buildPayrollLegalPolicyEvidence(PAYROLL_LEGAL_DEFAULTS);
  const inserted = await runner.insert(s.payrollRuns).values({
    period,
    branchId: 1,
    status: "draft",
    employeeCount: 1,
    totalGross: "1000.00",
    totalDeductions: "1000.00",
    totalNet: "0.00",
    totalSocialSecurityEmployee: "300.00",
    totalIncomeTax: "200.00",
    totalSocialSecurityEmployer: "100.00",
    totalEndOfServiceAccrual: "50.00",
    legalPolicySnapshot: legalPolicy.snapshot,
    legalPolicyHash: legalPolicy.hash,
    createdBy: MAKER.userId,
  });
  const runId = extractInsertId(inserted);
  await runner.insert(s.payrollItems).values({
    runId,
    employeeId: 10,
    branchIdSnapshot: 1,
    payType: "monthly",
    gross: "1000.00",
    deductions: "1000.00",
    advanceDeduction: "500.00",
    socialSecurityEmployee: "300.00",
    incomeTax: "200.00",
    socialSecurityEmployer: "100.00",
    endOfServiceAccrual: "50.00",
    net: "0.00",
  });
  return runId;
}

const PAYROLL_LOCK_TEST_NOW = new Date("2026-10-31T12:00:00.000Z");
const PAYROLL_LOCK_TEST_PERIOD = "2026-10";

async function seedPayerShift() {
  const runner = db();
  await runner.insert(s.shifts).values({
    id: 901,
    branchId: 1,
    userId: PAYER.userId,
    openingBalance: "10000.00",
    status: "OPEN",
    shiftType: "RETAIL",
    openGuard: `1:${PAYER.userId}:RETAIL`,
  });
}

async function seedApprovedLoanForPayer(key: string) {
  const runner = db();
  await seedPayerShift();
  const inserted = await runner.insert(s.employeeLoanRequests).values({
    employeeId: 10,
    branchId: 1,
    amount: "100.00",
    installmentsCount: 1,
    monthlyDeduction: "100.00",
    payrollPeriod: PAYROLL_LOCK_TEST_PERIOD,
    clientRequestId: `payroll-lock-${key}`,
    reason: "اختبار ترتيب أقفال السلفة والمسيّر",
    status: "APPROVED",
    createdById: MAKER.userId,
    reviewedById: CHECKER.userId,
    reviewedAt: new Date(),
  });
  return extractInsertId(inserted);
}

function pauseNextForUpdate(table: "employees" | "payrollRuns" | "shifts") {
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
        query.includes(`from \`${table}\``) &&
        query.includes("for update")
      ) {
        paused = true;
        locked();
        await mayContinue;
      }
      return result;
    });
  return {
    lockReached,
    release,
    restore: () => spy.mockRestore(),
  };
}

async function waitForPayrollLockWait(): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const [rows] = await getPool().query(
      `SELECT COUNT(*) AS n
         FROM performance_schema.data_lock_waits w
         JOIN performance_schema.data_locks requested
           ON requested.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID
        WHERE requested.OBJECT_SCHEMA = DATABASE()
          AND requested.OBJECT_NAME IN ('employees', 'payrollRuns', 'shifts')`,
    );
    if (Number((rows as Array<{ n: number }>)[0]?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("لم يصل سباق السلفة/المسيّر إلى انتظار القفل المتوقع");
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("payroll accrual lifecycle — DB invariants", () => {
  it("A06 repair rejects a paid retry whose run lock follows a real salary return", async () => {
    const runId = await seedDraft();
    await approveRun(runId, CHECKER);
    const paid = await payRun(runId, PAYER, { paymentDate: "2026-08-01" });
    const original = paid.employeePaymentSnapshots![0];
    let returnLocked!: () => void;
    let releaseReturn!: () => void;
    const locked = new Promise<void>((resolve) => {
      returnLocked = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseReturn = resolve;
    });
    const execute = MySql2PreparedQuery.prototype.execute;
    let paused = false;
    let sawPaidPreview = false;
    let sawRetryLock = false;
    const spy = vi
      .spyOn(MySql2PreparedQuery.prototype, "execute")
      .mockImplementation(async function (
        this: typeof MySql2PreparedQuery.prototype,
        values,
      ) {
        const query = (this as unknown as { query: { sql: string } }).query.sql;
        if (
          paused &&
          query.includes("from `payrollRuns`") &&
          query.includes("for update")
        ) {
          sawRetryLock = true;
          releaseReturn();
        }
        const result = await execute.call(this, values);
        if (
          !paused &&
          query.includes("from `payrollAccountingEvents`") &&
          query.includes("inner join `payrollRuns`") &&
          query.includes("for update")
        ) {
          paused = true;
          returnLocked();
          await release;
        } else if (
          paused &&
          query.includes("from `payrollRuns`") &&
          !query.includes("for update")
        ) {
          sawPaidPreview = result[0]?.status === "paid";
        }
        return result;
      });
    try {
      const returned = returnSalaryPayment(
        {
          accountingEventId: original.eventId,
          returnedAt: "2026-08-02",
          reason: "إعادة راتب أثناء إعادة المحاولة",
        },
        RETURN_CHECKER,
      );
      await locked;
      const retry = payRun(runId, PAYER, { paymentDate: "2026-08-01" });
      await expect(retry).rejects.toMatchObject({ code: "CONFLICT" });
      await returned;
      expect(sawPaidPreview && sawRetryLock).toBe(true);
    } finally {
      releaseReturn();
      spy.mockRestore();
    }
    const reopened = await getRun(runId);
    expect(reopened?.status).toBe("approved");
    expect(
      reopened?.accountingEvents.filter(
        (event) => event.eventKind === "SALARY_PAYMENT",
      ),
    ).toHaveLength(1);
    await expect(
      payRun(runId, PAYER, { paymentDate: "2026-08-03" }),
    ).resolves.toMatchObject({ replayed: false, status: "paid" });
  });

  it("A06 repair rejects mutable receipt proof in every reader and return", async () => {
    const runId = await seedDraft();
    await approveRun(runId, CHECKER);
    const paid = await payRun(runId, PAYER, {
      paymentMethod: "TRANSFER",
      referenceNumber: "FROZEN-TRANSFER",
      paymentDate: "2026-08-01",
    });
    const payment = paid.employeePaymentSnapshots![0];
    const [receipt] = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.id, payment.receiptId!));
    const shiftId = extractInsertId(
      await db()
        .insert(s.shifts)
        .values({ branchId: 1, userId: PAYER.userId, status: "CLOSED" }),
    );
    const changes: Partial<typeof s.receipts.$inferInsert>[] = [
      { voucherDate: new Date("2026-08-02T00:00:00Z") },
      { paymentMethod: "WALLET" },
      { referenceNumber: "OTHER-REFERENCE" },
      { cashBucket: "TREASURY" },
      { shiftId },
      { branchId: 2 },
      { direction: "IN" },
      { approvalStatus: "PENDING_APPROVAL" },
      { status: "PENDING" },
    ];
    for (const change of changes) {
      await db()
        .update(s.receipts)
        .set(change)
        .where(eq(s.receipts.id, receipt.id));
      await expect(getRun(runId)).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(getPayrollFinancialLedger()).rejects.toMatchObject({
        code: "CONFLICT",
      });
      await expect(listRuns()).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(
        returnSalaryPayment(
          {
            accountingEventId: payment.eventId,
            returnedAt: "2026-08-03",
            reason: "اختبار سلامة دليل الصرف",
          },
          RETURN_CHECKER,
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      await db()
        .update(s.receipts)
        .set({
          voucherDate: receipt.voucherDate,
          paymentMethod: receipt.paymentMethod,
          referenceNumber: receipt.referenceNumber,
          cashBucket: receipt.cashBucket,
          shiftId: receipt.shiftId,
          branchId: receipt.branchId,
          direction: receipt.direction,
          approvalStatus: receipt.approvalStatus,
          status: receipt.status,
        })
        .where(eq(s.receipts.id, receipt.id));
    }
    // SQL timestamp precision and time of day do not change the frozen payment day.
    await db()
      .update(s.receipts)
      .set({ voucherDate: new Date("2026-08-01T13:14:15.123Z") })
      .where(eq(s.receipts.id, receipt.id));
    const view = await getRun(runId);
    expect(
      toDateStr(new Date(view!.employeePaymentSnapshots[0].paymentDate!)),
    ).toBe("2026-08-01");
    const returnInput = {
      accountingEventId: payment.eventId,
      returnedAt: "2026-08-03",
      reason: "اختبار سلامة دليل الإعادة",
    };
    const returned = await returnSalaryPayment(returnInput, RETURN_CHECKER);
    if (!("receiptId" in returned) || returned.receiptId == null)
      throw new Error("Expected new return receipt");
    const [returnReceipt] = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.id, returned.receiptId!));
    await db()
      .update(s.receipts)
      .set({ referenceNumber: "TAMPERED-RETURN" })
      .where(eq(s.receipts.id, returnReceipt.id));
    await expect(getPayrollFinancialLedger()).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(
      returnSalaryPayment(returnInput, RETURN_CHECKER),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await db()
      .update(s.receipts)
      .set({ referenceNumber: returnReceipt.referenceNumber })
      .where(eq(s.receipts.id, returnReceipt.id));
    await expect(
      returnSalaryPayment(returnInput, RETURN_CHECKER),
    ).resolves.toMatchObject({ replayed: true });
  });

  it("A06 repair checks an earlier active batch independently of the latest retry contract", async () => {
    const runId = await seedTwoEmployeeDraft();
    await approveRun(runId, CHECKER);
    const first = await payRun(runId, PAYER, { paymentDate: "2026-08-01" });
    const [a, b] = first.employeePaymentSnapshots!;
    await returnSalaryPayment(
      {
        accountingEventId: a.eventId,
        returnedAt: "2026-08-02",
        reason: "إعادة جزئية مثبتة",
      },
      RETURN_CHECKER,
    );
    await payRun(runId, PAYER, { paymentDate: "2026-08-03" });
    await expect(
      payRun(runId, PAYER, { paymentDate: "2026-08-03" }),
    ).resolves.toMatchObject({ replayed: true });
    await db()
      .update(s.receipts)
      .set({ status: "PENDING" })
      .where(eq(s.receipts.id, b.receiptId!));
    await expect(
      payRun(runId, PAYER, { paymentDate: "2026-08-03" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await db()
      .update(s.receipts)
      .set({ status: "COMPLETED" })
      .where(eq(s.receipts.id, b.receiptId!));
    const [reversal] = await db()
      .select()
      .from(s.payrollObligationAllocations)
      .where(eq(s.payrollObligationAllocations.direction, "REVERSE"));
    await db()
      .update(s.payrollObligationAllocations)
      .set({ amount: "1.00" })
      .where(eq(s.payrollObligationAllocations.id, reversal.id));
    await expect(
      payRun(runId, PAYER, { paymentDate: "2026-08-03" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("A06 fails ACTIVE rounding without its approved account and rolls back every settlement effect", async () => {
    const runner = db();
    const runId = await seedDraft();
    await approveRun(runId, CHECKER);
    await runner.insert(s.accounts).values([
      {
        code: "A06-L",
        name: "رواتب مستحقة",
        type: "LIABILITY",
        systemRole: "ACCRUED_SALARY",
      },
      {
        code: "A06-C",
        name: "خزينة",
        type: "ASSET",
        systemRole: "TREASURY_CASH",
      },
    ]);
    await runner
      .update(s.doubleEntrySettings)
      .set({
        mode: "ACTIVE",
        shadowCycleId: "A06",
        shadowOpeningHash: "a".repeat(64),
        policyApprovalReference: "A06-APPROVED",
        policyApprovalPolicyHash: POSTING_POLICY_HASH,
        policyApprovalCycleId: "A06",
        policyApprovalOpeningHash: "a".repeat(64),
        policyAccountantName: "المحاسب",
        policyApprovedAt: new Date(),
        policyApprovedBy: CHECKER.userId,
      })
      .where(eq(s.doubleEntrySettings.id, 1));
    await expect(
      payRun(runId, PAYER, {
        paymentMethod: "CASH",
        paymentDate: "2026-08-01",
      }),
    ).rejects.toThrow();
    expect(await runner.select().from(s.receipts)).toHaveLength(1);
    expect(
      await runner.select().from(s.payrollObligationAllocations),
    ).toHaveLength(0);
    expect(
      await runner
        .select()
        .from(s.payrollAccountingEvents)
        .where(eq(s.payrollAccountingEvents.eventKind, "SALARY_PAYMENT")),
    ).toHaveLength(0);
    expect((await getRun(runId))!.status).toBe("approved");
  });
  it("A06 retains legacy hash and reverses only historical two-leg actual cash without inventing rounding", async () => {
    const runner = db();
    const runId = await seedDraft();
    await approveRun(runId, CHECKER);
    const paid = await payRun(runId, PAYER, {
      paymentMethod: "CASH",
      paymentDate: "2026-08-01",
    });
    const payment = paid.employeePaymentSnapshots![0];
    const [obligation] = await runner
      .select()
      .from(s.payrollObligations)
      .where(eq(s.payrollObligations.id, payment.obligationId));
    await runner
      .update(s.payrollAccountingEvents)
      .set({
        settlementEvidence: null,
        sourceHash: payrollHash({
          kind: "SALARY_PAYMENT",
          obligationSourceKey: obligation.sourceKey,
          amount: payment.amount,
          method: "CASH",
          referenceNumber: null,
          paymentYmd: "2026-08-01",
        }),
      })
      .where(eq(s.payrollAccountingEvents.id, payment.eventId));
    expect(
      (await getRun(runId))!.employeePaymentSnapshots[0].classification,
    ).toBe("LEGACY_UNCLASSIFIED");
    await expect(
      payRun(runId, PAYER, {
        paymentMethod: "CASH",
        paymentDate: "2026-08-01",
      }),
    ).resolves.toMatchObject({ replayed: true });
    const returned = await returnSalaryPayment(
      {
        accountingEventId: payment.eventId,
        returnedAt: "2026-08-02",
        reason: "عكس أصل تاريخي مثبت",
      },
      RETURN_CHECKER,
    );
    const [event] = await runner
      .select()
      .from(s.payrollAccountingEvents)
      .where(eq(s.payrollAccountingEvents.id, returned.eventId));
    expect(event.settlementEvidence).toBeNull();
    const [receipt] = await runner
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.id, returned.receiptId!));
    expect(receipt.amount).toBe(payment.amount);
    const [restored] = await runner
      .select()
      .from(s.payrollObligations)
      .where(eq(s.payrollObligations.id, payment.obligationId));
    expect(restored.remainingAmount).toBe("900.00");
    const transfer = {
      paymentMethod: "TRANSFER" as const,
      paymentDate: "2026-08-03",
      referenceNumber: "A06-EXACT-TRANSFER",
    };
    const repaid = await payRun(runId, PAYER, transfer);
    expect(
      repaid.employeePaymentSnapshots!.find((row) => row.active),
    ).toMatchObject({
      amount: "900.00",
      signedDifference: "0.00",
      classification: "EXACT",
    });
    await expect(
      payRun(runId, PAYER, {
        ...transfer,
        referenceNumber: "DIFFERENT-REFERENCE",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it.each([
    ["100100.00", "100000.00", "-100.00", "ACTIVE"],
    ["100150.00", "100250.00", "100.00", "ACTIVE"],
    ["124.99", "0.00", "-124.99", "ACTIVE"],
    ["125.00", "250.00", "125.00", "OFF"],
  ] as const)(
    "A06 settles, reads, retries, returns and repays %s/%s in %s",
    async (entitlement, actual, difference, mode) => {
      const runner = db();
      const runId = await seedDraft();
      const gross = money(entitlement).plus(100).toFixed(2);
      await runner
        .update(s.payrollRuns)
        .set({ totalGross: gross, totalNet: entitlement })
        .where(eq(s.payrollRuns.id, runId));
      await runner
        .update(s.payrollItems)
        .set({ gross, net: entitlement })
        .where(eq(s.payrollItems.runId, runId));
      await runner.update(s.receipts).set({ amount: "1000000.00" });
      await approveRun(runId, CHECKER);
      if (mode === "ACTIVE") {
        await runner.insert(s.accounts).values([
          {
            code: "A06-L",
            name: "رواتب مستحقة",
            type: "LIABILITY",
            systemRole: "ACCRUED_SALARY",
          },
          {
            code: "A06-C",
            name: "خزينة",
            type: "ASSET",
            systemRole: "TREASURY_CASH",
          },
          {
            code: "A06-R",
            name: "فروق تقريب",
            type: "EXPENSE",
            systemRole: "ROUNDING_DIFF",
          },
        ]);
        await runner
          .update(s.doubleEntrySettings)
          .set({
            mode: "ACTIVE",
            shadowCycleId: "A06",
            shadowOpeningHash: "a".repeat(64),
            policyApprovalReference: "A06-APPROVED",
            policyApprovalPolicyHash: POSTING_POLICY_HASH,
            policyApprovalCycleId: "A06",
            policyApprovalOpeningHash: "a".repeat(64),
            policyAccountantName: "المحاسب",
            policyApprovedAt: new Date(),
            policyApprovedBy: CHECKER.userId,
          })
          .where(eq(s.doubleEntrySettings.id, 1));
      }
      const payment = {
        paymentMethod: "CASH" as const,
        paymentDate: "2026-08-01",
      };
      const paid = await payRun(runId, PAYER, payment);
      const snapshot = paid.employeePaymentSnapshots!.find(
        (row) => row.active,
      )!;
      expect(snapshot).toMatchObject({
        amount: actual,
        entitlementSettled: entitlement,
        signedDifference: difference,
        evidenceVersion: 2,
      });
      expect(snapshot.receiptId == null).toBe(actual === "0.00");
      expect((await listRuns()).find((row) => row.id === runId)).toMatchObject({
        totalActualSalaryPaid: actual,
        salarySettlementCount: 1,
      });
      const [event] = await runner
        .select()
        .from(s.payrollAccountingEvents)
        .where(eq(s.payrollAccountingEvents.id, snapshot.eventId));
      const evidence = readSalarySettlementEvidence(
        event.settlementEvidence,
        event.sourceHash,
      )!;
      expect(evidence.components.roleDebits.ACCRUED_SALARY).toBe(entitlement);
      const lines = await runner
        .select()
        .from(s.journalLines)
        .innerJoin(
          s.journalEntries,
          eq(s.journalLines.journalId, s.journalEntries.id),
        )
        .where(eq(s.journalEntries.entryId, event.accountingEntryId));
      if (mode === "ACTIVE") {
        expect(
          lines.find((row) => row.journalLines.role === "ACCRUED_SALARY")
            ?.journalLines.debit,
        ).toBe(entitlement);
        expect(
          lines.filter((row) => row.journalLines.role === "TREASURY_CASH"),
        ).toHaveLength(actual === "0.00" ? 0 : 1);
      }
      expect(
        (await getPayrollFinancialLedger({ period: "2026-08" })).find(
          (row) => row.eventId === snapshot.eventId,
        ),
      ).toMatchObject({
        active: true,
        amount: actual,
        receiptId: snapshot.receiptId,
      });
      // Retry proves original scope before current cash balance/mapping validation.
      await runner
        .update(s.receipts)
        .set({ amount: "0.00" })
        .where(eq(s.receipts.referenceNumber, "PAYROLL-TEST-FUND"));
      await expect(payRun(runId, PAYER, payment)).resolves.toMatchObject({
        replayed: true,
      });
      await expect(
        payRun(runId, PAYER, {
          ...payment,
          cashBucket: "DRAWER",
          shiftId: 999,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(
        payRun(runId, PAYER, { ...payment, paymentDate: "2026-08-02" }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      const returned = await returnSalaryPayment(
        {
          accountingEventId: snapshot.eventId,
          returnedAt: "2026-08-02",
          reason: "إعادة تسوية مثبتة",
        },
        RETURN_CHECKER,
      );
      expect(returned.receiptId == null).toBe(actual === "0.00");
      const [obligation] = await runner
        .select()
        .from(s.payrollObligations)
        .where(eq(s.payrollObligations.id, snapshot.obligationId));
      expect(obligation.remainingAmount).toBe(entitlement);
      const [returnEvent] = await runner
        .select()
        .from(s.payrollAccountingEvents)
        .where(eq(s.payrollAccountingEvents.id, returned.eventId));
      const returnedEvidence = readSalarySettlementEvidence(
        returnEvent.settlementEvidence,
        returnEvent.sourceHash,
      )!;
      expect(returnedEvidence.components.roleCredits.ACCRUED_SALARY).toBe(
        entitlement,
      );
      await expect(
        returnSalaryPayment(
          {
            accountingEventId: snapshot.eventId,
            returnedAt: "2026-08-02",
            reason: "إعادة تسوية مثبتة",
          },
          RETURN_CHECKER,
        ),
      ).resolves.toMatchObject({ replayed: true });
      await runner
        .update(s.receipts)
        .set({ amount: "1000000.00" })
        .where(eq(s.receipts.referenceNumber, "PAYROLL-TEST-FUND"));
      const repaid = await payRun(runId, PAYER, {
        ...payment,
        paymentDate: "2026-08-03",
      });
      expect(
        repaid.employeePaymentSnapshots!.filter((row) => row.active),
      ).toHaveLength(1);
      const [newEvent] = await runner
        .select()
        .from(s.payrollAccountingEvents)
        .where(
          eq(
            s.payrollAccountingEvents.id,
            repaid.employeePaymentSnapshots!.find((row) => row.active)!.eventId,
          ),
        );
      expect(newEvent.sourceKey).toContain(":r1");
      await runner
        .update(s.payrollObligationAllocations)
        .set({ amount: "1.00" })
        .where(
          eq(s.payrollObligationAllocations.accountingEventId, newEvent.id),
        );
      await expect(
        payRun(runId, PAYER, { ...payment, paymentDate: "2026-08-03" }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    },
  );
  it("serializes approve/pay retries and preserves append-only approval/reopen evidence", async () => {
    const runner = db();
    const runId = await seedDraft();
    await runner.insert(s.receipts).values({
      id: 900,
      branchId: 1,
      direction: "OUT",
      amount: "500.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      voucherNumber: "PV-PAYROLL-LOCK-900",
      createdBy: 1,
    });
    await runner
      .update(s.employeeAdvances)
      .set({ receiptId: 900 })
      .where(eq(s.employeeAdvances.id, 20));

    await Promise.all([approveRun(runId, CHECKER), approveRun(runId, CHECKER)]);

    const obligations = await runner
      .select()
      .from(s.payrollObligations)
      .where(eq(s.payrollObligations.runId, runId));
    expect(obligations).toHaveLength(4);
    expect(
      Object.fromEntries(
        obligations.map((row) => [row.kind, row.originalAmount]),
      ),
    ).toEqual({
      SALARY_NET: "900.00",
      INCOME_TAX: "50.00",
      SOCIAL_SECURITY: "200.00",
      EOS_PROVISION: "40.00",
    });
    const statutorySummary = await listStatutoryObligationSummary({
      branchId: 1,
    });
    expect(statutorySummary).toEqual(
      expect.arrayContaining([
        {
          kind: "INCOME_TAX",
          branchIdSnapshot: 1,
          remainingAmount: "50.00",
          openCount: 1,
        },
        {
          kind: "SOCIAL_SECURITY",
          branchIdSnapshot: 1,
          remainingAmount: "200.00",
          openCount: 1,
        },
      ]),
    );
    expect(Object.keys(statutorySummary[0]).sort()).toEqual([
      "branchIdSnapshot",
      "kind",
      "openCount",
      "remainingAmount",
    ]);

    const [accrual] = await runner
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.dedupeKey, `PAYROLL:ACCRUAL:${runId}:0:1`));
    expect(accrual).toMatchObject({
      entryType: "ADJUST",
      amount: "1290.00",
      dedupeKey: `PAYROLL:ACCRUAL:${runId}:0:1`,
    });
    expect(toDateStr(new Date(accrual.entryDate))).toBe("2026-07-31");

    const [advanceAfterApproval] = await runner
      .select()
      .from(s.employeeAdvances)
      .where(eq(s.employeeAdvances.id, 20));
    expect(advanceAfterApproval.remaining).toBe("400.00");

    await runner
      .update(s.employees)
      .set({ branchId: 2 })
      .where(eq(s.employees.id, 10));
    await Promise.all([
      payRun(runId, PAYER, {
        paymentMethod: "CASH",
        paymentDate: "2026-08-01",
      }),
      payRun(runId, PAYER, {
        paymentMethod: "CASH",
        paymentDate: "2026-08-01",
      }),
    ]);

    const salaryEvents = await runner
      .select()
      .from(s.payrollAccountingEvents)
      .where(
        and(
          eq(s.payrollAccountingEvents.runId, runId),
          eq(s.payrollAccountingEvents.eventKind, "SALARY_PAYMENT"),
        ),
      );
    expect(salaryEvents).toHaveLength(1);
    expect(salaryEvents[0].branchIdSnapshot).toBe(1);
    const salaryReceipts = await runner
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.id, Number(salaryEvents[0].receiptId)));
    expect(salaryReceipts).toHaveLength(1);
    expect(salaryReceipts[0]).toMatchObject({
      branchId: 1,
      direction: "OUT",
      amount: "1000.00",
    });

    await returnSalaryPayment(
      {
        accountingEventId: Number(salaryEvents[0].id),
        returnedAt: "2026-08-02",
        reason: "إعادة المبلغ من الموظف",
      },
      RETURN_CHECKER,
    );
    const reopenVsCancellation = await Promise.allSettled([
      cancelRun(runId, CHECKER, "إعادة تدقيق"),
      withTx(async (tx) => {
        const locked = await lockUntouchedEmployeeAdvanceForCancellationTx(tx, {
          originalReceiptId: 900,
          employeeId: 10,
          branchId: 1,
          expectedAmount: "500.00",
        });
        await cancelLockedEmployeeAdvanceTx(tx, locked);
      }),
    ]);
    expect(
      reopenVsCancellation.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      reopenVsCancellation.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    for (const result of reopenVsCancellation) {
      if (result.status === "rejected") {
        expect(String(result.reason)).not.toMatch(/ER_LOCK_DEADLOCK|deadlock/i);
      }
    }
    const reopenedResult = reopenVsCancellation.find(
      (result) => result.status === "fulfilled",
    );
    expect(reopenedResult?.status).toBe("fulfilled");
    const reopened =
      reopenedResult?.status === "fulfilled" ? reopenedResult.value : null;
    expect(reopened).toMatchObject({ status: "draft", revisionNo: 1 });

    const events = await runner
      .select()
      .from(s.payrollAccountingEvents)
      .where(eq(s.payrollAccountingEvents.runId, runId));
    expect(events.map((row) => row.eventKind).sort()).toEqual([
      "ACCRUAL",
      "ACCRUAL_REVERSAL",
      "SALARY_PAYMENT",
      "SALARY_PAYMENT_RETURN",
    ]);
    const [advanceAfterReopen] = await runner
      .select()
      .from(s.employeeAdvances)
      .where(eq(s.employeeAdvances.id, 20));
    expect(advanceAfterReopen.remaining).toBe("500.00");
  });

  it("requires an active owner for approval and reopen, and permits self-approval (قرار المالك ٣/٩/٢٦)", async () => {
    const runId = await seedDraft();

    await expect(approveRun(runId, NON_OWNER_HR)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(approveRun(runId, INACTIVE_OWNER)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    const firstApproval = await approveRun(runId, MAKER);
    expect(firstApproval.replayed).toBe(false);
    const replayedApproval = await approveRun(runId, CHECKER);
    expect(replayedApproval.replayed).toBe(true);

    await expect(cancelRun(runId, NON_OWNER_HR)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(cancelRun(runId, INACTIVE_OWNER)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    await expect(
      cancelRun(runId, MAKER, "إعادة مراجعة ذاتية"),
    ).resolves.toMatchObject({
      status: "draft",
      revisionNo: 1,
    });
  });

  it("serializes item update against approval without a database deadlock", async () => {
    const runner = db();
    const runId = await seedDraft();
    const [item] = await runner
      .select({ id: s.payrollItems.id })
      .from(s.payrollItems)
      .where(eq(s.payrollItems.runId, runId));
    const outcomes = await Promise.allSettled([
      updateItem(Number(item.id), { overtime: "120.00" }, MAKER),
      approveRun(runId, CHECKER),
    ]);
    if (outcomes[1].status === "rejected") throw outcomes[1].reason;
    expect(outcomes[1].status).toBe("fulfilled");
    if (outcomes[0].status === "rejected") {
      expect(outcomes[0].reason).toMatchObject({ code: "BAD_REQUEST" });
      expect(String(outcomes[0].reason?.message ?? "")).not.toContain(
        "DEADLOCK",
      );
    }
    const [run] = await runner
      .select()
      .from(s.payrollRuns)
      .where(eq(s.payrollRuns.id, runId));
    expect(run.status).toBe("approved");
    expect(run.totalNet).toBe(outcomes[0].status === "fulfilled" ? "920.00" : "900.00");
  });

  it("rejects a new payroll employee discovered after the ordered employee locks", async () => {
    const runner = db();
    const runId = await seedDraft();
    const barrier = pauseNextForUpdate("employees");
    const approval = approveRun(runId, CHECKER);
    try {
      await barrier.lockReached;
      await runner.insert(s.payrollItems).values({
        runId,
        employeeId: 11,
        branchIdSnapshot: 1,
        payType: "monthly",
        gross: "400.00",
        net: "400.00",
      });
      barrier.release();
      await expect(approval).rejects.toMatchObject({ code: "CONFLICT" });
      const [run] = await runner
        .select()
        .from(s.payrollRuns)
        .where(eq(s.payrollRuns.id, runId));
      expect(run.status).toBe("draft");
      expect(await runner.select().from(s.payrollObligations)).toHaveLength(0);
      expect(
        await runner.select().from(s.payrollAccountingEvents),
      ).toHaveLength(0);
      expect(await runner.select().from(s.accountingEntries)).toHaveLength(0);
    } finally {
      barrier.release();
      await Promise.allSettled([approval]);
      barrier.restore();
    }
  });

  it("approves with the advance committed while approval waited for the employee lock", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(PAYROLL_LOCK_TEST_NOW);
    const runner = db();
    const runId = await seedDraft(PAYROLL_LOCK_TEST_PERIOD);
    const loanId = await seedApprovedLoanForPayer("disburse-before-approval");
    const barrier = pauseNextForUpdate("employees");
    let disbursement: ReturnType<typeof disburseEmployeeLoan> | undefined;
    let approval: ReturnType<typeof approveRun> | undefined;
    try {
      disbursement = disburseEmployeeLoan(PAYER, loanId);
      await barrier.lockReached;
      approval = approveRun(runId, CHECKER);
      await waitForPayrollLockWait();
      barrier.release();
      const [disbursed, approved] = await Promise.allSettled([
        disbursement,
        approval,
      ]);
      expect(disbursed.status).toBe("fulfilled");
      expect(approved.status).toBe("fulfilled");
      for (const outcome of [disbursed, approved]) {
        if (outcome.status === "rejected") {
          expect(String(outcome.reason)).not.toMatch(
            /ER_LOCK_DEADLOCK|deadlock/i,
          );
        }
      }

      const [run] = await runner
        .select()
        .from(s.payrollRuns)
        .where(eq(s.payrollRuns.id, runId));
      expect(run).toMatchObject({
        status: "approved",
        totalDeductions: "350.00",
        totalNet: "800.00",
      });
      const [item] = await runner
        .select()
        .from(s.payrollItems)
        .where(eq(s.payrollItems.runId, runId));
      expect(item).toMatchObject({
        advanceDeduction: "200.00",
        deductions: "350.00",
        net: "800.00",
      });
      expect(
        await runner
          .select()
          .from(s.employeeAdvances)
          .where(eq(s.employeeAdvances.sourceType, "SALARY_ADVANCE")),
      ).toHaveLength(1);
      expect(
        await runner
          .select()
          .from(s.receipts)
          .where(
            and(
              eq(s.receipts.direction, "OUT"),
              eq(s.receipts.cashBucket, "DRAWER"),
            ),
          ),
      ).toHaveLength(1);
    } finally {
      barrier.release();
      const pending: Promise<unknown>[] = [];
      if (disbursement) pending.push(disbursement);
      if (approval) pending.push(approval);
      await Promise.allSettled(pending);
      barrier.restore();
      vi.useRealTimers();
    }
  }, 15_000);

  it("orders approval before a concurrent loan disbursement without deadlock or partial loan money", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(PAYROLL_LOCK_TEST_NOW);
    const runner = db();
    const runId = await seedDraft(PAYROLL_LOCK_TEST_PERIOD);
    const loanId = await seedApprovedLoanForPayer("approve-disburse");
    const barrier = pauseNextForUpdate("payrollRuns");
    let approval: ReturnType<typeof approveRun> | undefined;
    let disbursement: ReturnType<typeof disburseEmployeeLoan> | undefined;
    try {
      approval = approveRun(runId, CHECKER);
      await barrier.lockReached;
      disbursement = disburseEmployeeLoan(PAYER, loanId);
      await waitForPayrollLockWait();
      barrier.release();
      const [approved, disbursed] = await Promise.allSettled([
        approval,
        disbursement,
      ]);
      expect(approved.status).toBe("fulfilled");
      expect(disbursed).toMatchObject({
        status: "rejected",
        reason: { code: "PRECONDITION_FAILED" },
      });
      if (disbursed.status === "rejected") {
        expect(String(disbursed.reason)).not.toMatch(
          /ER_LOCK_DEADLOCK|deadlock/i,
        );
      }

      const [loan] = await runner
        .select()
        .from(s.employeeLoanRequests)
        .where(eq(s.employeeLoanRequests.id, loanId));
      expect(loan).toMatchObject({
        status: "APPROVED",
        advanceId: null,
        receiptId: null,
      });
      expect(
        await runner
          .select()
          .from(s.employeeAdvances)
          .where(eq(s.employeeAdvances.sourceType, "SALARY_ADVANCE")),
      ).toHaveLength(0);
      expect(
        await runner
          .select()
          .from(s.receipts)
          .where(
            and(
              eq(s.receipts.direction, "OUT"),
              eq(s.receipts.cashBucket, "DRAWER"),
            ),
          ),
      ).toHaveLength(0);
      expect(
        await runner
          .select()
          .from(s.accountingEntries)
          .where(
            eq(
              s.accountingEntries.dedupeKey,
              `EMPLOYEE_LOAN_DISBURSEMENT:${loanId}`,
            ),
          ),
      ).toHaveLength(0);
      expect(await runner.select().from(s.idempotencyKeys)).toHaveLength(0);
    } finally {
      barrier.release();
      const pending: Promise<unknown>[] = [];
      if (approval) pending.push(approval);
      if (disbursement) pending.push(disbursement);
      await Promise.allSettled(pending);
      barrier.restore();
      vi.useRealTimers();
    }
  }, 15_000);

  it("orders salary pay before a concurrent loan disbursement and commits only the salary payment", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(PAYROLL_LOCK_TEST_NOW);
    const runner = db();
    const runId = await seedDraft(PAYROLL_LOCK_TEST_PERIOD);
    await approveRun(runId, CHECKER);
    const loanId = await seedApprovedLoanForPayer("pay-disburse");
    const barrier = pauseNextForUpdate("payrollRuns");
    let payment: ReturnType<typeof payRun> | undefined;
    let disbursement: ReturnType<typeof disburseEmployeeLoan> | undefined;
    try {
      payment = payRun(runId, PAYER, {
        paymentMethod: "CASH",
        paymentDate: "2026-10-31",
      });
      await barrier.lockReached;
      disbursement = disburseEmployeeLoan(PAYER, loanId);
      await waitForPayrollLockWait();
      barrier.release();
      const [paid, disbursed] = await Promise.allSettled([
        payment,
        disbursement,
      ]);
      expect(paid.status).toBe("fulfilled");
      expect(disbursed).toMatchObject({
        status: "rejected",
        reason: { code: "PRECONDITION_FAILED" },
      });
      if (disbursed.status === "rejected") {
        expect(String(disbursed.reason)).not.toMatch(
          /ER_LOCK_DEADLOCK|deadlock/i,
        );
      }

      const [run] = await runner
        .select()
        .from(s.payrollRuns)
        .where(eq(s.payrollRuns.id, runId));
      expect(run.status).toBe("paid");
      const salaryEvents = await runner
        .select()
        .from(s.payrollAccountingEvents)
        .where(
          and(
            eq(s.payrollAccountingEvents.runId, runId),
            eq(s.payrollAccountingEvents.eventKind, "SALARY_PAYMENT"),
          ),
        );
      expect(salaryEvents).toHaveLength(1);
      expect(
        await runner
          .select()
          .from(s.receipts)
          .where(
            and(
              eq(s.receipts.direction, "OUT"),
              eq(s.receipts.cashBucket, "TREASURY"),
            ),
          ),
      ).toHaveLength(1);
      expect(
        await runner
          .select()
          .from(s.receipts)
          .where(
            and(
              eq(s.receipts.direction, "OUT"),
              eq(s.receipts.cashBucket, "DRAWER"),
            ),
          ),
      ).toHaveLength(0);
      expect(
        await runner
          .select()
          .from(s.accountingEntries)
          .where(
            eq(
              s.accountingEntries.dedupeKey,
              `EMPLOYEE_LOAN_DISBURSEMENT:${loanId}`,
            ),
          ),
      ).toHaveLength(0);
      expect(
        await runner
          .select()
          .from(s.employeeAdvances)
          .where(eq(s.employeeAdvances.sourceType, "SALARY_ADVANCE")),
      ).toHaveLength(0);
    } finally {
      barrier.release();
      const pending: Promise<unknown>[] = [];
      if (payment) pending.push(payment);
      if (disbursement) pending.push(disbursement);
      await Promise.allSettled(pending);
      barrier.restore();
      vi.useRealTimers();
    }
  }, 15_000);

  it("orders DRAWER salary pay before a legacy owner-auto-approved advance without deadlock or duplicate effects", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(PAYROLL_LOCK_TEST_NOW);
    const runner = db();
    const runId = await seedDraft(PAYROLL_LOCK_TEST_PERIOD);
    await approveRun(runId, CHECKER);
    await seedPayerShift();
    const barrier = pauseNextForUpdate("shifts");
    let payment: ReturnType<typeof payRun> | undefined;
    let grant: ReturnType<typeof grantAdvance> | undefined;
    try {
      payment = payRun(runId, PAYER, {
        paymentMethod: "CASH",
        cashBucket: "DRAWER",
        shiftId: 901,
        paymentDate: "2026-10-31",
      });
      await barrier.lockReached;
      grant = grantAdvance(
        {
          employeeId: 10,
          branchId: 1,
          amount: "100.00",
          monthlyDeduction: "100.00",
          clientRequestId: "payroll-lock-legacy-grant",
        },
        PAYER,
      );
      await waitForPayrollLockWait();
      barrier.release();
      const [paid, granted] = await Promise.allSettled([payment, grant]);
      expect(paid.status).toBe("fulfilled");
      expect(granted).toMatchObject({
        status: "rejected",
        reason: { code: "PRECONDITION_FAILED" },
      });
      for (const outcome of [paid, granted]) {
        if (outcome.status === "rejected") {
          expect(String(outcome.reason)).not.toMatch(
            /ER_LOCK_DEADLOCK|deadlock/i,
          );
        }
      }

      const [run] = await runner
        .select()
        .from(s.payrollRuns)
        .where(eq(s.payrollRuns.id, runId));
      expect(run.status).toBe("paid");
      expect(
        await runner
          .select()
          .from(s.payrollAccountingEvents)
          .where(
            and(
              eq(s.payrollAccountingEvents.runId, runId),
              eq(s.payrollAccountingEvents.eventKind, "SALARY_PAYMENT"),
            ),
          ),
      ).toHaveLength(1);
      const drawerPayments = await runner
        .select()
        .from(s.receipts)
        .where(
          and(
            eq(s.receipts.direction, "OUT"),
            eq(s.receipts.cashBucket, "DRAWER"),
          ),
        );
      expect(drawerPayments).toHaveLength(1);
      expect(drawerPayments[0]?.shiftId).toBe(901);
      expect(
        await runner
          .select()
          .from(s.employeeAdvances)
          .where(eq(s.employeeAdvances.sourceType, "SALARY_ADVANCE")),
      ).toHaveLength(0);
      expect(await runner.select().from(s.idempotencyKeys)).toHaveLength(0);
    } finally {
      barrier.release();
      const pending: Promise<unknown>[] = [];
      if (payment) pending.push(payment);
      if (grant) pending.push(grant);
      await Promise.allSettled(pending);
      barrier.restore();
      vi.useRealTimers();
    }
  }, 15_000);

  it("serializes legal-policy updates against approval and rejects a stale generated snapshot", async () => {
    const runner = db();
    const runId = await seedDraft();
    let policyLocked!: () => void;
    let releasePolicy!: () => void;
    const locked = new Promise<void>((resolve) => {
      policyLocked = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releasePolicy = resolve;
    });
    const updater = withTx(async (tx) => {
      await tx
        .insert(s.payrollLegalSettings)
        .values({ id: 1 })
        .onDuplicateKeyUpdate({ set: { id: 1 } });
      await tx
        .select()
        .from(s.payrollLegalSettings)
        .where(eq(s.payrollLegalSettings.id, 1))
        .for("update")
        .limit(1);
      policyLocked();
      await release;
      await tx
        .update(s.payrollLegalSettings)
        .set({
          incomeTaxEnabled: true,
          incomeTaxBrackets: [{ upTo: null, rate: "10" }],
          updatedBy: CHECKER.userId,
        })
        .where(eq(s.payrollLegalSettings.id, 1));
    });
    await locked;
    const approval = approveRun(runId, CHECKER);
    releasePolicy();
    await updater;
    await expect(approval).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    const [run] = await runner
      .select()
      .from(s.payrollRuns)
      .where(eq(s.payrollRuns.id, runId));
    expect(run.status).toBe("draft");
    expect(await runner.select().from(s.payrollAccountingEvents)).toHaveLength(
      0,
    );
  });

  it("serializes commission approval with payroll approval so exactly one financial state wins", async () => {
    const runner = db();
    const runId = await seedDraft();
    await runner.insert(s.commissionRuns).values({
      id: 90,
      period: "2026-07",
      status: "draft",
      employeeCount: 1,
      totalCommission: "50.00",
      createdBy: MAKER.userId,
    });
    const raced = await Promise.allSettled([
      approveRun(runId, CHECKER),
      approveCommissionRun(90, CHECKER),
    ]);
    expect(
      raced.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(raced.filter((result) => result.status === "rejected")).toHaveLength(
      1,
    );
    const [payroll] = await runner
      .select()
      .from(s.payrollRuns)
      .where(eq(s.payrollRuns.id, runId));
    const [commission] = await runner
      .select()
      .from(s.commissionRuns)
      .where(eq(s.commissionRuns.id, 90));
    expect(
      (payroll.status === "approved" && commission.status === "draft") ||
        (payroll.status === "draft" && commission.status === "approved"),
    ).toBe(true);
  });

  it("serializes commission approval with payroll generation without deadlock or silent capture", async () => {
    const runner = db();
    await runner
      .insert(s.commissionPlans)
      .values({ id: 91, name: "Race commission" });
    await runner.insert(s.commissionRuns).values({
      id: 91,
      period: "2026-07",
      status: "draft",
      employeeCount: 1,
      totalCommission: "100.00",
      createdBy: MAKER.userId,
    });
    await runner.insert(s.commissionRunLines).values({
      runId: 91,
      employeeId: 10,
      userId: MAKER.userId,
      planId: 91,
      commissionAmount: "100.00",
    });
    const raced = await Promise.allSettled([
      generatePayroll("2026-07", MAKER),
      approveCommissionRun(91, CHECKER),
    ]);
    expect(raced.every((result) => result.status === "fulfilled")).toBe(true);
    const [run] = await runner
      .select()
      .from(s.payrollRuns)
      .where(eq(s.payrollRuns.period, "2026-07"));
    const [commission] = await runner
      .select()
      .from(s.commissionRuns)
      .where(eq(s.commissionRuns.id, 91));
    const [item] = await runner
      .select()
      .from(s.payrollItems)
      .where(
        and(
          eq(s.payrollItems.runId, Number(run.id)),
          eq(s.payrollItems.employeeId, 10),
        ),
      );
    expect(commission.status).toBe("approved");
    if (commission.payrollRunId == null) {
      expect(item.commission).toBe("0.00");
    } else {
      expect(Number(commission.payrollRunId)).toBe(Number(run.id));
      expect(item.commission).toBe("100.00");
    }
  });

  it("carries uncaptured historical payroll bonuses once and excludes future approvals", async () => {
    const runner = db();
    await runner.insert(s.payrollRuns).values({
      period: "2026-06",
      status: "paid",
      employeeCount: 1,
      totalGross: "1000.00",
      totalNet: "1000.00",
      createdBy: MAKER.userId,
      approvedBy: CHECKER.userId,
      approvedAt: new Date("2026-06-30T17:00:00.000Z"),
      paidBy: PAYER.userId,
      paidAt: new Date("2026-06-30T18:00:00.000Z"),
    });
    await runner.insert(s.employeeSpotBonuses).values([
      {
        id: 201,
        employeeId: 10,
        branchId: 1,
        amount: "100.00",
        reason: "مكافأة اعتمدت بعد دفع مسيّر شهرها",
        disbursementType: "PAYROLL_ADDITION",
        status: "APPROVED",
        createdById: MAKER.userId,
        approvedById: CHECKER.userId,
        // 23:30 بغداد في 30 حزيران، وبعد دفع مسيّر حزيران.
        approvedAt: new Date("2026-06-30T20:30:00.000Z"),
      },
      {
        id: 202,
        employeeId: 10,
        branchId: 1,
        amount: "25.00",
        reason: "مكافأة إرثية معتمدة بلا وقت اعتماد",
        disbursementType: "PAYROLL_ADDITION",
        status: "APPROVED",
        createdById: MAKER.userId,
        approvedById: CHECKER.userId,
        approvedAt: null,
      },
      {
        id: 203,
        employeeId: 10,
        branchId: 1,
        amount: "75.00",
        reason: "مكافأة شهر مستقبلي لا تُعجّل",
        disbursementType: "PAYROLL_ADDITION",
        status: "APPROVED",
        createdById: MAKER.userId,
        approvedById: CHECKER.userId,
        // 00:30 بغداد في 1 آب، فلا تدخل مسيّر تموز.
        approvedAt: new Date("2026-07-31T21:30:00.000Z"),
      },
    ]);

    const staleDraftId = await seedDraft("2026-07");
    await expect(approveRun(staleDraftId, CHECKER)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    await expect(
      cancelRun(staleDraftId, MAKER, "إعادة توليد لالتقاط مكافآت معلقة"),
    ).resolves.toMatchObject({ deleted: true });

    const first = await generatePayroll("2026-07", NON_OWNER_HR);
    expect(first?.status).toBe("draft");
    const firstItem = first?.items?.find(
      (item) => Number(item.employeeId) === 10,
    );
    expect(firstItem).toMatchObject({
      gross: "1125.00",
      net: "1025.00",
    });
    let bonuses = await runner
      .select({
        id: s.employeeSpotBonuses.id,
        runId: s.employeeSpotBonuses.payrollRunId,
      })
      .from(s.employeeSpotBonuses)
      .orderBy(s.employeeSpotBonuses.id);
    expect(bonuses).toEqual([
      { id: 201, runId: Number(first?.id) },
      { id: 202, runId: Number(first?.id) },
      { id: 203, runId: null },
    ]);

    await expect(
      cancelRun(Number(first?.id), MAKER, "إثبات عدم تكرار المكافأة عند إعادة التوليد"),
    ).resolves.toMatchObject({ deleted: true });
    const regenerated = await generatePayroll("2026-07", NON_OWNER_HR);
    expect(regenerated?.status).toBe("draft");
    const regeneratedItem = regenerated?.items?.find(
      (item) => Number(item.employeeId) === 10,
    );
    expect(regeneratedItem).toMatchObject({
      gross: "1125.00",
      net: "1025.00",
    });
    bonuses = await runner
      .select({
        id: s.employeeSpotBonuses.id,
        runId: s.employeeSpotBonuses.payrollRunId,
      })
      .from(s.employeeSpotBonuses)
      .orderBy(s.employeeSpotBonuses.id);
    expect(bonuses).toEqual([
      { id: 201, runId: Number(regenerated?.id) },
      { id: 202, runId: Number(regenerated?.id) },
      { id: 203, runId: null },
    ]);
    await expect(
      approveRun(Number(regenerated?.id), CHECKER),
    ).resolves.toMatchObject({ status: "approved" });
  });

  it("leaves historical bonuses for future hires unlinked without blocking the current payroll", async () => {
    const runner = db();
    await runner.insert(s.employees).values({
      id: 12,
      branchId: 1,
      firstName: "موظف",
      lastName: "مستقبلي",
      payType: "monthly",
      salary: "800.00",
      hireDate: "2026-08-01",
    });
    await runner.insert(s.employeeSpotBonuses).values({
      id: 260,
      employeeId: 12,
      branchId: 1,
      amount: "50.00",
      reason: "مكافأة قديمة لموظف يبدأ بعد فترة المسيّر",
      disbursementType: "PAYROLL_ADDITION",
      status: "APPROVED",
      createdById: MAKER.userId,
      approvedById: CHECKER.userId,
      approvedAt: new Date("2026-06-15T12:00:00.000Z"),
    });

    const july = await generatePayroll("2026-07", NON_OWNER_HR);
    expect(july?.status).toBe("draft");
    expect(
      july?.items?.some((item) => Number(item.employeeId) === 12),
    ).toBe(false);
    let [bonus] = await runner
      .select({
        status: s.employeeSpotBonuses.status,
        runId: s.employeeSpotBonuses.payrollRunId,
      })
      .from(s.employeeSpotBonuses)
      .where(eq(s.employeeSpotBonuses.id, 260));
    expect(bonus).toEqual({ status: "APPROVED", runId: null });

    await expect(
      approveRun(Number(july?.id), CHECKER),
    ).resolves.toMatchObject({ status: "approved" });
    [bonus] = await runner
      .select({
        status: s.employeeSpotBonuses.status,
        runId: s.employeeSpotBonuses.payrollRunId,
      })
      .from(s.employeeSpotBonuses)
      .where(eq(s.employeeSpotBonuses.id, 260));
    expect(bonus).toEqual({ status: "APPROVED", runId: null });
  });

  it("fails approval promptly when an eligible payroll bonus is being changed", async () => {
    const runner = db();
    const runId = await seedDraft("2026-07");
    await runner.insert(s.employeeSpotBonuses).values({
      id: 250,
      employeeId: 10,
      branchId: 1,
      amount: "50.00",
      reason: "مكافأة معلقة أثناء اعتماد المسيّر",
      disbursementType: "PAYROLL_ADDITION",
      status: "APPROVED",
      createdById: MAKER.userId,
      approvedById: CHECKER.userId,
      approvedAt: new Date("2026-07-15T12:00:00.000Z"),
    });
    let locked!: () => void;
    let release!: () => void;
    const bonusLocked = new Promise<void>((resolve) => { locked = resolve; });
    const mayCommit = new Promise<void>((resolve) => { release = resolve; });
    const holder = withTx(async (tx) => {
      await tx
        .select({ id: s.employeeSpotBonuses.id })
        .from(s.employeeSpotBonuses)
        .where(eq(s.employeeSpotBonuses.id, 250))
        .for("update")
        .limit(1);
      locked();
      await mayCommit;
    });
    await bonusLocked;

    const approval = approveRun(runId, CHECKER);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        approval.then(
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
    } finally {
      if (timeout) clearTimeout(timeout);
      release();
      await holder;
      await Promise.allSettled([approval]);
    }

    const [run] = await runner
      .select({ status: s.payrollRuns.status })
      .from(s.payrollRuns)
      .where(eq(s.payrollRuns.id, runId));
    expect(run?.status).toBe("draft");
    expect(await runner.select().from(s.payrollAccountingEvents)).toHaveLength(
      0,
    );
    const [bonus] = await runner
      .select({
        status: s.employeeSpotBonuses.status,
        runId: s.employeeSpotBonuses.payrollRunId,
      })
      .from(s.employeeSpotBonuses)
      .where(eq(s.employeeSpotBonuses.id, 250));
    expect(bonus).toEqual({ status: "APPROVED", runId: null });
  }, 15_000);

  it("carries and caps an uncaptured historical penalty once while excluding future decisions", async () => {
    const runner = db();
    await runner.insert(s.payrollRuns).values({
      period: "2026-06",
      status: "paid",
      employeeCount: 1,
      totalGross: "1000.00",
      totalNet: "1000.00",
      createdBy: MAKER.userId,
      approvedBy: CHECKER.userId,
      approvedAt: new Date("2026-06-30T17:00:00.000Z"),
      paidBy: PAYER.userId,
      paidAt: new Date("2026-06-30T18:00:00.000Z"),
    });
    await runner.insert(s.employeePenalties).values([
      {
        id: 301,
        employeeId: 10,
        branchId: 1,
        penaltyType: "SALARY_DEDUCTION",
        decisionNumber: "HISTORICAL-PENALTY",
        decisionDate: "2026-06-30",
        reason: "عقوبة اعتمدت بعد دفع مسيّر شهر القرار",
        deductionAmount: "250.00",
        status: "APPROVED",
        createdById: MAKER.userId,
        approvedById: CHECKER.userId,
        approvedAt: new Date("2026-06-30T20:30:00.000Z"),
      },
      {
        id: 302,
        employeeId: 10,
        branchId: 1,
        penaltyType: "SALARY_DEDUCTION",
        decisionNumber: "FUTURE-PENALTY",
        decisionDate: "2026-08-01",
        reason: "قرار شهر مستقبلي لا يُعجّل",
        deductionAmount: "500.00",
        status: "APPROVED",
        createdById: MAKER.userId,
        approvedById: CHECKER.userId,
        approvedAt: new Date("2026-07-01T12:00:00.000Z"),
      },
    ]);

    const staleDraftId = await seedDraft("2026-07");
    await expect(approveRun(staleDraftId, CHECKER)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("عقوبة #301"),
    });
    await expect(
      cancelRun(staleDraftId, MAKER, "إعادة توليد لالتقاط عقوبة معلقة"),
    ).resolves.toMatchObject({ deleted: true });

    const first = await generatePayroll("2026-07", NON_OWNER_HR);
    expect(first?.status).toBe("draft");
    const firstItem = first?.items?.find(
      (item) => Number(item.employeeId) === 10,
    );
    expect(firstItem).toMatchObject({
      gross: "1000.00",
      deductions: "200.00",
      wageReduction: "100.00",
      advanceDeduction: "100.00",
      net: "800.00",
    });
    let penalties = await runner
      .select({
        id: s.employeePenalties.id,
        status: s.employeePenalties.status,
        runId: s.employeePenalties.payrollRunId,
      })
      .from(s.employeePenalties)
      .orderBy(s.employeePenalties.id);
    expect(penalties).toEqual([
      { id: 301, status: "APPLIED", runId: Number(first?.id) },
      { id: 302, status: "APPROVED", runId: null },
    ]);

    await expect(
      cancelRun(Number(first?.id), MAKER, "إثبات عدم تكرار العقوبة عند إعادة التوليد"),
    ).resolves.toMatchObject({ deleted: true });
    const regenerated = await generatePayroll("2026-07", NON_OWNER_HR);
    expect(regenerated?.status).toBe("draft");
    const regeneratedItem = regenerated?.items?.find(
      (item) => Number(item.employeeId) === 10,
    );
    expect(regeneratedItem).toMatchObject({
      gross: "1000.00",
      deductions: "200.00",
      wageReduction: "100.00",
      advanceDeduction: "100.00",
      net: "800.00",
    });
    penalties = await runner
      .select({
        id: s.employeePenalties.id,
        status: s.employeePenalties.status,
        runId: s.employeePenalties.payrollRunId,
      })
      .from(s.employeePenalties)
      .orderBy(s.employeePenalties.id);
    expect(penalties).toEqual([
      { id: 301, status: "APPLIED", runId: Number(regenerated?.id) },
      { id: 302, status: "APPROVED", runId: null },
    ]);
    await expect(
      approveRun(Number(regenerated?.id), CHECKER),
    ).resolves.toMatchObject({ status: "approved" });
  });

  it("rolls back generation when a selected historical penalty is cancelled before capture", async () => {
    const runner = db();
    await runner.insert(s.payrollRuns).values({
      period: "2026-06",
      status: "paid",
      employeeCount: 1,
      totalGross: "1000.00",
      totalNet: "1000.00",
      createdBy: MAKER.userId,
      approvedBy: CHECKER.userId,
      approvedAt: new Date("2026-06-30T17:00:00.000Z"),
      paidBy: PAYER.userId,
      paidAt: new Date("2026-06-30T18:00:00.000Z"),
    });
    await runner.insert(s.employeePenalties).values({
      id: 401,
      employeeId: 10,
      branchId: 1,
      penaltyType: "SALARY_DEDUCTION",
      decisionNumber: "CANCEL-DURING-GENERATION",
      decisionDate: "2026-06-30",
      reason: "عقوبة قديمة تُلغى أثناء توليد الشهر التالي",
      deductionAmount: "250.00",
      status: "APPROVED",
      createdById: MAKER.userId,
      approvedById: CHECKER.userId,
      approvedAt: new Date("2026-06-30T20:30:00.000Z"),
    });

    const execute = MySql2PreparedQuery.prototype.execute;
    let selected!: () => void;
    let resume!: () => void;
    let paused = false;
    const penaltySelected = new Promise<void>((resolve) => { selected = resolve; });
    const mayContinue = new Promise<void>((resolve) => { resume = resolve; });
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
          query.includes("from `employeePenalties`") &&
          !query.includes("for update")
        ) {
          paused = true;
          selected();
          await mayContinue;
        }
        return result;
      });
    let generation: ReturnType<typeof generatePayroll> | undefined;
    try {
      generation = generatePayroll("2026-07", NON_OWNER_HR);
      await penaltySelected;
      await expect(
        cancelEmployeePenalty(CHECKER, 401, "إلغاء معتمد قبل التقاط المسيّر"),
      ).resolves.toMatchObject({ status: "CANCELLED" });
      resume();
      await expect(generation).rejects.toMatchObject({ code: "CONFLICT" });
    } finally {
      resume();
      await Promise.allSettled([generation].filter(Boolean) as Promise<unknown>[]);
      spy.mockRestore();
    }

    const [penalty] = await runner
      .select({
        status: s.employeePenalties.status,
        runId: s.employeePenalties.payrollRunId,
      })
      .from(s.employeePenalties)
      .where(eq(s.employeePenalties.id, 401));
    expect(penalty).toEqual({ status: "CANCELLED", runId: null });
    expect(
      await runner
        .select({ id: s.payrollRuns.id })
        .from(s.payrollRuns)
        .where(eq(s.payrollRuns.period, "2026-07")),
    ).toHaveLength(0);
    expect(await runner.select().from(s.payrollItems)).toHaveLength(0);
  }, 15_000);

  it("posts reopen reversal to the original accrual date and reapproval keeps one net July expense", async () => {
    const runner = db();
    const runId = await seedDraft();
    await approveRun(runId, CHECKER);
    const [firstAccrual] = await runner
      .select({
        amount: s.accountingEntries.amount,
        entryDate: s.accountingEntries.entryDate,
      })
      .from(s.payrollAccountingEvents)
      .innerJoin(
        s.accountingEntries,
        eq(s.payrollAccountingEvents.accountingEntryId, s.accountingEntries.id),
      )
      .where(
        and(
          eq(s.payrollAccountingEvents.runId, runId),
          eq(s.payrollAccountingEvents.eventKind, "ACCRUAL"),
        ),
      );
    expect(toDateStr(new Date(firstAccrual.entryDate))).toBe("2026-07-31");

    await cancelRun(runId, CHECKER, "تصحيح داخل فترة الاستحقاق");
    await approveRun(runId, CHECKER);
    const economicEntries = await runner
      .select({
        amount: s.accountingEntries.amount,
        entryDate: s.accountingEntries.entryDate,
      })
      .from(s.payrollAccountingEvents)
      .innerJoin(
        s.accountingEntries,
        eq(s.payrollAccountingEvents.accountingEntryId, s.accountingEntries.id),
      )
      .where(
        and(
          eq(s.payrollAccountingEvents.runId, runId),
          sql`${s.payrollAccountingEvents.eventKind} IN ('ACCRUAL', 'ACCRUAL_REVERSAL')`,
        ),
      );
    expect(economicEntries).toHaveLength(3);
    expect(
      economicEntries.map((entry) => toDateStr(new Date(entry.entryDate))),
    ).toEqual(["2026-07-31", "2026-07-31", "2026-07-31"]);
    expect(
      economicEntries.reduce((sum, entry) => sum + Number(entry.amount), 0),
    ).toBe(Number(firstAccrual.amount));
  });

  it("rejects reopening a locked accrual month without any mutation", async () => {
    const runner = db();
    const runId = await seedDraft();
    await approveRun(runId, CHECKER);
    const beforeEvents = await runner
      .select({ id: s.payrollAccountingEvents.id })
      .from(s.payrollAccountingEvents)
      .where(eq(s.payrollAccountingEvents.runId, runId));
    await runner.insert(s.financialPeriods).values({
      cutoffDate: "2026-07-31",
      status: "LOCKED",
      lockedBy: CHECKER.userId,
    });

    await expect(
      cancelRun(runId, CHECKER, "محاولة فتح فترة مقفلة"),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const [run] = await runner
      .select()
      .from(s.payrollRuns)
      .where(eq(s.payrollRuns.id, runId));
    expect(run.status).toBe("approved");
    const afterEvents = await runner
      .select({ id: s.payrollAccountingEvents.id })
      .from(s.payrollAccountingEvents)
      .where(eq(s.payrollAccountingEvents.runId, runId));
    expect(afterEvents).toHaveLength(beforeEvents.length);
  });

  it("excludes only the employee whose termination already recognized wages and still pays coworkers", async () => {
    const runner = db();
    await runner.insert(s.employeeTerminations).values({
      employeeId: 10,
      terminationType: "استقالة",
      lastDay: "2026-07-15",
      settlement: "600.00",
      earnedGrossWages: "600.00",
      status: "completed",
      recognizedAt: new Date("2026-07-15T12:00:00.000Z"),
      recognizedBy: CHECKER.userId,
      settlementSnapshotHash: "a".repeat(64),
      settlementEvidenceNote: "إثبات أجور التسوية المعتمدة للاختبار",
      zeroAmountsAttested: true,
      createdBy: MAKER.userId,
    });

    const run = await generatePayroll("2026-07", MAKER);
    expect(run?.items.map((item) => Number(item.employeeId))).toEqual([11]);
    expect(run?.employeeCount).toBe(1);
    expect(run?.notes).toContain("PAYROLL_TERMINATION_WAGE_COVERAGE_V1:");
    expect(run?.notes).toContain('"employeeId":10');
    await expect(approveRun(Number(run?.id), CHECKER)).resolves.toMatchObject({
      status: "approved",
      employeeCount: 1,
    });
  });

  it("treats an explicit zero termination wage as authoritative and does not auto-prorate it", async () => {
    const runner = db();
    await runner.insert(s.employeeTerminations).values({
      employeeId: 10,
      terminationType: "استقالة",
      lastDay: "2026-07-15",
      settlement: "0.00",
      earnedGrossWages: "0.00",
      status: "completed",
      recognizedAt: new Date("2026-07-15T12:00:00.000Z"),
      recognizedBy: CHECKER.userId,
      settlementSnapshotHash: "d".repeat(64),
      settlementEvidenceNote: "إقرار صريح بصفر الأجور المكتسبة",
      zeroAmountsAttested: true,
      createdBy: MAKER.userId,
    });

    const run = await generatePayroll("2026-07", MAKER);
    expect(run?.items.map((item) => Number(item.employeeId))).toEqual([11]);
    expect(run?.notes).toContain('"earnedGrossWages":"0.00"');
    await expect(approveRun(Number(run?.id), CHECKER)).resolves.toMatchObject({
      status: "approved",
    });
    const employeeTenObligations = await runner
      .select()
      .from(s.payrollObligations)
      .where(eq(s.payrollObligations.employeeId, 10));
    expect(employeeTenObligations).toHaveLength(0);
  });

  it("rejects approval of an old draft that overlaps recognized termination wages", async () => {
    const runner = db();
    const runId = await seedDraft();
    await runner.insert(s.employeeTerminations).values({
      employeeId: 10,
      terminationType: "استقالة",
      lastDay: "2026-07-15",
      settlement: "600.00",
      earnedGrossWages: "600.00",
      status: "completed",
      recognizedAt: new Date("2026-07-15T12:00:00.000Z"),
      recognizedBy: CHECKER.userId,
      settlementSnapshotHash: "b".repeat(64),
      settlementEvidenceNote: "إثبات مسودة قديمة متداخلة",
      zeroAmountsAttested: true,
      createdBy: MAKER.userId,
    });
    await expect(approveRun(runId, CHECKER)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });

  it("keeps approved commission as a zero-base payroll item beside recognized termination wages", async () => {
    const runner = db();
    await runner
      .delete(s.employeeAdvances)
      .where(eq(s.employeeAdvances.employeeId, 10));
    await runner.insert(s.employeeTerminations).values({
      employeeId: 10,
      terminationType: "استقالة",
      lastDay: "2026-07-15",
      settlement: "500.00",
      earnedGrossWages: "500.00",
      status: "completed",
      recognizedAt: new Date("2026-07-15T12:00:00.000Z"),
      recognizedBy: CHECKER.userId,
      settlementSnapshotHash: "c".repeat(64),
      settlementEvidenceNote: "إثبات أجر الإنهاء مع عمولة مستقلة",
      zeroAmountsAttested: true,
      createdBy: MAKER.userId,
    });
    await runner.insert(s.commissionPlans).values({
      id: 30,
      name: "لقطة اختبار العمولة",
      createdBy: MAKER.userId,
    });
    await runner.insert(s.commissionRuns).values({
      id: 31,
      period: "2026-07",
      status: "approved",
      employeeCount: 1,
      totalCommission: "100.00",
      createdBy: MAKER.userId,
      approvedBy: CHECKER.userId,
      approvedAt: new Date("2026-07-31T12:00:00.000Z"),
    });
    await runner.insert(s.commissionRunLines).values({
      runId: 31,
      employeeId: 10,
      userId: MAKER.userId,
      branchId: 1,
      planId: 30,
      commissionAmount: "100.00",
    });

    const run = await generatePayroll("2026-07", MAKER);
    const covered = run?.items.find((item) => Number(item.employeeId) === 10);
    expect(covered).toMatchObject({
      gross: "0.00",
      commission: "100.00",
      net: "100.00",
    });
    expect(run?.totalCommission).toBe("100.00");
    await approveRun(Number(run?.id), CHECKER);
    const [commissionObligation] = await runner
      .select()
      .from(s.payrollObligations)
      .where(
        and(
          eq(s.payrollObligations.employeeId, 10),
          eq(s.payrollObligations.kind, "SALARY_NET"),
        ),
      );
    expect(commissionObligation.originalAmount).toBe("100.00");
    const [commissionRun] = await runner
      .select()
      .from(s.commissionRuns)
      .where(eq(s.commissionRuns.id, 31));
    expect(Number(commissionRun.payrollRunId)).toBe(Number(run?.id));
  });

  it("repays only the open employee obligation after a partial salary return", async () => {
    const runner = db();
    const runId = await seedTwoEmployeeDraft();
    await approveRun(runId, CHECKER);
    await payRun(runId, PAYER, {
      paymentMethod: "CASH",
      paymentDate: "2026-08-01",
    });

    const firstPayments = await runner
      .select({
        eventId: s.payrollAccountingEvents.id,
        employeeId: s.payrollObligations.employeeId,
        sourceKey: s.payrollAccountingEvents.sourceKey,
      })
      .from(s.payrollAccountingEvents)
      .innerJoin(
        s.payrollObligations,
        eq(s.payrollAccountingEvents.obligationId, s.payrollObligations.id),
      )
      .where(
        and(
          eq(s.payrollAccountingEvents.runId, runId),
          eq(s.payrollAccountingEvents.eventKind, "SALARY_PAYMENT"),
        ),
      );
    expect(firstPayments).toHaveLength(2);
    const employeeA = firstPayments.find(
      (row) => Number(row.employeeId) === 10,
    );
    expect(employeeA).toBeDefined();

    const salaryReturnInput = {
      accountingEventId: Number(employeeA!.eventId),
      returnedAt: "2026-08-02",
      reason: "إعادة جزئية مثبتة",
    };
    await expect(
      returnSalaryPayment(salaryReturnInput, RETURN_CHECKER),
    ).resolves.toMatchObject({ replayed: false });
    await expect(
      returnSalaryPayment(salaryReturnInput, RETURN_CHECKER),
    ).resolves.toMatchObject({ replayed: true });
    await expect(
      returnSalaryPayment(
        { ...salaryReturnInput, reason: "سبب مختلف عن الإعادة المثبتة" },
        RETURN_CHECKER,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const [afterReturn] = await runner
      .select()
      .from(s.payrollRuns)
      .where(eq(s.payrollRuns.id, runId));
    expect(afterReturn).toMatchObject({
      status: "approved",
      paidAt: null,
      paidBy: null,
    });
    const returnedObligations = await runner
      .select()
      .from(s.payrollObligations)
      .where(
        and(
          eq(s.payrollObligations.runId, runId),
          eq(s.payrollObligations.kind, "SALARY_NET"),
        ),
      );
    expect(
      Object.fromEntries(
        returnedObligations.map((row) => [
          Number(row.employeeId),
          `${row.remainingAmount}:${row.status}`,
        ]),
      ),
    ).toEqual({ 10: "750.00:OPEN", 11: "0.00:SETTLED" });
    const returnedView = await getRun(runId);
    expect(
      returnedView!.employeePaymentSnapshots.map((payment) => ({
        employeeId: payment.employeeId,
        amount: payment.amount,
        paymentDate: toDateStr(new Date(payment.paymentDate!)),
        active: payment.active,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          employeeId: 10,
          amount: "750.00",
          paymentDate: "2026-08-01",
          active: false,
        },
        {
          employeeId: 11,
          amount: "250.00",
          paymentDate: "2026-08-01",
          active: true,
        },
      ]),
    );

    await Promise.all([
      payRun(runId, PAYER, {
        paymentMethod: "CASH",
        paymentDate: "2026-08-03",
      }),
      payRun(runId, PAYER, {
        paymentMethod: "CASH",
        paymentDate: "2026-08-03",
      }),
    ]);

    const finalPayments = await runner
      .select({
        eventId: s.payrollAccountingEvents.id,
        employeeId: s.payrollObligations.employeeId,
        sourceKey: s.payrollAccountingEvents.sourceKey,
      })
      .from(s.payrollAccountingEvents)
      .innerJoin(
        s.payrollObligations,
        eq(s.payrollAccountingEvents.obligationId, s.payrollObligations.id),
      )
      .where(
        and(
          eq(s.payrollAccountingEvents.runId, runId),
          eq(s.payrollAccountingEvents.eventKind, "SALARY_PAYMENT"),
        ),
      );
    expect(finalPayments).toHaveLength(3);
    expect(
      finalPayments.filter((row) => Number(row.employeeId) === 10),
    ).toHaveLength(2);
    expect(
      finalPayments.filter((row) => Number(row.employeeId) === 11),
    ).toHaveLength(1);
    expect(new Set(finalPayments.map((row) => row.sourceKey)).size).toBe(3);
    await expect(
      payRun(runId, PAYER, {
        paymentMethod: "CASH",
        paymentDate: "2026-08-03",
      }),
    ).resolves.toMatchObject({ replayed: true });
    await expect(
      payRun(runId, PAYER, {
        paymentMethod: "TRANSFER",
        paymentDate: "2026-08-03",
        referenceNumber: "DIFFERENT-RETRY",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const finalObligations = await runner
      .select()
      .from(s.payrollObligations)
      .where(
        and(
          eq(s.payrollObligations.runId, runId),
          eq(s.payrollObligations.kind, "SALARY_NET"),
        ),
      );
    expect(
      finalObligations.every(
        (row) => row.remainingAmount === "0.00" && row.status === "SETTLED",
      ),
    ).toBe(true);
    const [paidRun] = await runner
      .select()
      .from(s.payrollRuns)
      .where(eq(s.payrollRuns.id, runId));
    expect(paidRun.status).toBe("paid");
    expect(paidRun.paidAt).not.toBeNull();
    const paidView = await getRun(runId);
    expect(
      paidView!.employeePaymentSnapshots
        .filter((payment) => payment.active)
        .map((payment) => ({
          employeeId: payment.employeeId,
          amount: payment.amount,
          paymentDate: toDateStr(new Date(payment.paymentDate!)),
        })),
    ).toEqual(
      expect.arrayContaining([
        { employeeId: 10, amount: "750.00", paymentDate: "2026-08-03" },
        { employeeId: 11, amount: "250.00", paymentDate: "2026-08-01" },
      ]),
    );
    const salaryLedger = await getPayrollFinancialLedger({ period: "2026-08" });
    const salaryMovements = salaryLedger.filter((row) => row.runId === runId);
    expect(salaryMovements).toHaveLength(4);
    expect(
      salaryMovements.filter(
        (row) => row.movementType === "SALARY_PAYMENT" && row.active,
      ),
    ).toHaveLength(2);
    expect(
      salaryMovements.filter(
        (row) => row.movementType === "SALARY_PAYMENT" && !row.active,
      ),
    ).toHaveLength(1);
    expect(
      salaryMovements.find(
        (row) => row.movementType === "SALARY_PAYMENT_RETURN",
      ),
    ).toMatchObject({ active: true, amount: "750.00" });

    await payRun(runId, PAYER, {
      paymentMethod: "CASH",
      paymentDate: "2026-08-03",
    });
    const repeatedPayments = await runner
      .select({ id: s.payrollAccountingEvents.id })
      .from(s.payrollAccountingEvents)
      .where(
        and(
          eq(s.payrollAccountingEvents.runId, runId),
          eq(s.payrollAccountingEvents.eventKind, "SALARY_PAYMENT"),
        ),
      );
    const [replayedRun] = await runner
      .select()
      .from(s.payrollRuns)
      .where(eq(s.payrollRuns.id, runId));
    expect(repeatedPayments).toHaveLength(3);
    expect(replayedRun.paidAt?.getTime()).toBe(paidRun.paidAt?.getTime());
  });

  it("makes remittance request keys idempotent and serializes competing reservations", async () => {
    const runner = db();
    const runId = await seedDraft();
    await approveRun(runId, CHECKER);
    const base = {
      kind: "INCOME_TAX" as const,
      payingBranchId: 1,
      amount: "50.00",
      authorityName: "الهيئة العامة للضرائب",
      referenceNumber: "TAX-2026-07",
      supportingDocumentUrl:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlA+uQAAAAASUVORK5CYII=",
      clientRequestId: "tax-remittance-idempotent",
    };

    const duplicate = await Promise.all([
      createRemittanceRequest(base, MAKER),
      createRemittanceRequest(base, MAKER),
    ]);
    expect(new Set(duplicate.map((row) => Number(row.id))).size).toBe(1);
    expect(duplicate.filter((row) => row.replayed)).toHaveLength(1);

    const competing = await Promise.allSettled([
      createRemittanceRequest(
        { ...base, clientRequestId: "tax-competing-a" },
        MAKER,
      ),
      createRemittanceRequest(
        { ...base, clientRequestId: "tax-competing-b" },
        MAKER,
      ),
    ]);
    expect(competing.filter((row) => row.status === "rejected")).toHaveLength(
      2,
    );

    const requestId = Number(duplicate[0].id);
    await approveRemittanceRequest(requestId, CHECKER);
    const createDuringPay = await Promise.allSettled([
      payRemittanceRequest(
        { requestId, paymentMethod: "CASH", paymentDate: "2026-08-01" },
        PAYER,
      ),
      createRemittanceRequest(
        { ...base, clientRequestId: "tax-create-during-pay" },
        MAKER,
      ),
    ]);
    expect(createDuringPay[0].status).toBe("fulfilled");
    expect(createDuringPay[1].status).toBe("rejected");
    await expect(
      payRemittanceRequest(
        { requestId, paymentMethod: "CASH", paymentDate: "2026-08-01" },
        PAYER,
      ),
    ).resolves.toMatchObject({ replayed: true });
    await expect(
      payRemittanceRequest(
        {
          requestId,
          paymentMethod: "TRANSFER",
          paymentDate: "2026-08-01",
          referenceNumber: "DIFFERENT-RETRY",
        },
        PAYER,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await returnRemittance(requestId, "إعادة فعلية من الهيئة", RETURN_CHECKER, {
      returnedAt: "2026-08-02",
    });
    await expect(
      returnRemittance(requestId, "إعادة فعلية من الهيئة", RETURN_CHECKER, {
        returnedAt: "2026-08-02",
      }),
    ).resolves.toMatchObject({ replayed: true });
    await expect(
      returnRemittance(requestId, "إعادة فعلية من الهيئة", RETURN_CHECKER, {
        returnedAt: "2026-08-03",
        referenceNumber: "DIFFERENT-RETURN",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const [request] = await runner
      .select()
      .from(s.payrollRemittanceRequests)
      .where(eq(s.payrollRemittanceRequests.id, requestId));
    expect(request.status).toBe("REVERSED");
    const [tax] = await runner
      .select()
      .from(s.payrollObligations)
      .where(
        and(
          eq(s.payrollObligations.runId, runId),
          eq(s.payrollObligations.kind, "INCOME_TAX"),
        ),
      );
    expect(tax).toMatchObject({ remainingAmount: "50.00", status: "OPEN" });
    const events = await runner
      .select()
      .from(s.payrollAccountingEvents)
      .where(eq(s.payrollAccountingEvents.remittanceRequestId, requestId));
    expect(events.map((row) => row.eventKind).sort()).toEqual([
      "REMITTANCE_RETURN",
      "TAX_REMITTANCE",
    ]);
    const remittanceLedger = await getPayrollFinancialLedger({
      period: "2026-08",
    });
    const requestMovements = remittanceLedger.filter(
      (row) => row.remittanceRequestId === requestId,
    );
    expect(requestMovements).toHaveLength(2);
    expect(requestMovements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          movementType: "TAX_REMITTANCE",
          active: false,
          authorityName: "الهيئة العامة للضرائب",
        }),
        expect.objectContaining({
          movementType: "REMITTANCE_RETURN",
          active: true,
        }),
      ]),
    );
  });

  it("authorizes remittance approval/rejection before replaying a decided request", async () => {
    const runner = db();
    await runner.insert(s.payrollRemittanceRequests).values([
      {
        id: 70,
        kind: "INCOME_TAX",
        payingBranchId: 1,
        requestedAmount: "10.00",
        authorityName: "الضريبة",
        referenceNumber: "DECIDED-APPROVED",
        supportingDocumentUrl:
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlA+uQAAAAASUVORK5CYII=",
        status: "APPROVED",
        sourceKey: "PAYROLL:REMIT-REQ:decided-approved",
        createdBy: MAKER.userId,
        approvedBy: CHECKER.userId,
        approvedAt: new Date(),
      },
      {
        id: 71,
        kind: "SOCIAL_SECURITY",
        payingBranchId: 1,
        requestedAmount: "10.00",
        authorityName: "الضمان",
        referenceNumber: "DECIDED-REJECTED",
        supportingDocumentUrl:
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlA+uQAAAAASUVORK5CYII=",
        status: "REJECTED",
        sourceKey: "PAYROLL:REMIT-REQ:decided-rejected",
        createdBy: MAKER.userId,
        rejectedBy: CHECKER.userId,
        rejectedAt: new Date(),
        rejectionReason: "مرجع غير صحيح",
      },
    ]);
    await expect(
      approveRemittanceRequest(70, NON_OWNER_HR),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      rejectRemittanceRequest(71, "مرجع غير صحيح", NON_OWNER_HR),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(approveRemittanceRequest(70, CHECKER)).resolves.toMatchObject({
      replayed: true,
    });
    await expect(
      rejectRemittanceRequest(71, "سبب مختلف", CHECKER),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("payroll zero-net classified lifecycle", () => {
  it("يرفض ترحيل خصم قديم غير مصنف ويرجع كل الآثار المالية", async () => {
    const runner = db();
    const runId = await seedZeroNetStatutoryDraft();
    await runner
      .update(s.employeeAdvances)
      .set({ sourceType: "LEGACY_UNCLASSIFIED", payrollPeriod: null })
      .where(eq(s.employeeAdvances.id, 20));
    const [run] = await runner
      .select()
      .from(s.payrollRuns)
      .where(eq(s.payrollRuns.id, runId));
    const items = await runner
      .select()
      .from(s.payrollItems)
      .where(eq(s.payrollItems.runId, runId));
    const before = {
      run,
      items,
      advance: await runner
        .select()
        .from(s.employeeAdvances)
        .where(eq(s.employeeAdvances.id, 20)),
      receipts: await runner.select().from(s.receipts),
    };

    await expect(
      withTx((tx) =>
        approvePayrollAccrualTx(tx, {
          run,
          items: items.map((item) => ({ ...item, currentBranchId: 1 })),
          actorUserId: CHECKER.userId,
          approvedAt: new Date("2026-08-01T12:00:00.000Z"),
        }),
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message:
        "استقطاع السلفة يفوق الرصيد النشط وقت اعتماد المسيّر — أعد المسيّر لمسودة وحدّثه.",
    });

    expect(
      await runner
        .select()
        .from(s.payrollRuns)
        .where(eq(s.payrollRuns.id, runId)),
    ).toEqual([before.run]);
    expect(
      await runner
        .select()
        .from(s.payrollItems)
        .where(eq(s.payrollItems.runId, runId)),
    ).toEqual(before.items);
    expect(
      await runner
        .select()
        .from(s.employeeAdvances)
        .where(eq(s.employeeAdvances.id, 20)),
    ).toEqual(before.advance);
    expect(await runner.select().from(s.advanceSettlements)).toHaveLength(0);
    expect(await runner.select().from(s.payrollObligations)).toHaveLength(0);
    expect(await runner.select().from(s.payrollAccountingEvents)).toHaveLength(0);
    expect(await runner.select().from(s.accountingEntries)).toHaveLength(0);
    expect(await runner.select().from(s.journalEntries)).toHaveLength(0);
    expect(await runner.select().from(s.journalLines)).toHaveLength(0);
    expect(await runner.select().from(s.receipts)).toEqual(before.receipts);
  });

  it("يسوّي قسط OTHER_DEDUCTION المصنف بلا نقد ويعكسه بدقة", async () => {
    const runner = db();
    const runId = await seedZeroNetStatutoryDraft();
    const receiptsBefore = await runner.select().from(s.receipts);

    await expect(approveRun(runId, CHECKER)).resolves.toMatchObject({
      status: "approved",
    });

    const obligations = await runner
      .select()
      .from(s.payrollObligations)
      .where(eq(s.payrollObligations.runId, runId));
    expect(
      obligations
        .map((row) => [
          row.kind,
          row.originalAmount,
          row.remainingAmount,
          row.status,
        ])
        .sort(),
    ).toEqual([
      ["EOS_PROVISION", "50.00", "50.00", "OPEN"],
      ["INCOME_TAX", "200.00", "200.00", "OPEN"],
      ["SOCIAL_SECURITY", "400.00", "400.00", "OPEN"],
    ]);

    const [accrual] = await runner
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.dedupeKey, `PAYROLL:ACCRUAL:${runId}:0:1`));
    expect(accrual).toMatchObject({
      entryType: "ADJUST",
      postingProfile: null,
      postingIntentJson: null,
      amount: "1150.00",
      receiptId: null,
    });
    const applied = await runner
      .select()
      .from(s.advanceSettlements)
      .where(
        and(
          eq(s.advanceSettlements.runId, runId),
          eq(s.advanceSettlements.direction, "APPLY"),
        ),
      );
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({
      advanceId: 20,
      amount: "500.00",
      reversalOfId: null,
    });
    const [advanceAfterApproval] = await runner
      .select()
      .from(s.employeeAdvances)
      .where(eq(s.employeeAdvances.id, 20));
    expect(advanceAfterApproval).toMatchObject({
      remaining: "0.00",
      status: "SETTLED",
    });
    expect(await runner.select().from(s.receipts)).toHaveLength(
      receiptsBefore.length,
    );

    const paid = await payRun(runId, PAYER, {
      paymentMethod: "CASH",
      paymentDate: "2026-08-01",
    });
    expect(paid).toMatchObject({
      status: "paid",
      paidBy: PAYER.userId,
      replayed: false,
    });
    expect(paid.paidAt).not.toBeNull();
    expect(await runner.select().from(s.receipts)).toHaveLength(
      receiptsBefore.length,
    );
    expect(
      await runner
        .select()
        .from(s.payrollAccountingEvents)
        .where(
          and(
            eq(s.payrollAccountingEvents.runId, runId),
            eq(s.payrollAccountingEvents.eventKind, "SALARY_PAYMENT"),
          ),
        ),
    ).toHaveLength(0);

    await expect(
      cancelRun(runId, CHECKER, "عكس مسير صفري بعد تدقيق الالتزامات"),
    ).resolves.toMatchObject({
      status: "draft",
      revisionNo: 1,
    });
    const reversedObligations = await runner
      .select()
      .from(s.payrollObligations)
      .where(eq(s.payrollObligations.runId, runId));
    expect(
      reversedObligations.every(
        (row) => row.status === "REVERSED" && row.remainingAmount === "0.00",
      ),
    ).toBe(true);
    const settlements = await runner
      .select()
      .from(s.advanceSettlements)
      .where(eq(s.advanceSettlements.runId, runId))
      .orderBy(s.advanceSettlements.id);
    expect(
      settlements.map((row) => [row.direction, row.amount, row.reversalOfId]),
    ).toEqual([
      ["APPLY", "500.00", null],
      ["REVERSE", "500.00", Number(settlements[0].id)],
    ]);
    const [advanceAfterReopen] = await runner
      .select()
      .from(s.employeeAdvances)
      .where(eq(s.employeeAdvances.id, 20));
    expect(advanceAfterReopen).toMatchObject({
      remaining: "500.00",
      status: "ACTIVE",
    });

    const [reversal] = await runner
      .select()
      .from(s.accountingEntries)
      .where(
        eq(s.accountingEntries.dedupeKey, `PAYROLL:ACCRUAL-REV:${runId}:0:1`),
      );
    expect(reversal).toMatchObject({
      entryType: "ADJUST",
      postingProfile: null,
      postingIntentJson: null,
      amount: "-1150.00",
      receiptId: null,
    });
    expect(toDateStr(new Date(reversal.entryDate))).toBe("2026-07-31");
    expect(await runner.select().from(s.receipts)).toHaveLength(
      receiptsBefore.length,
    );
  });
});
