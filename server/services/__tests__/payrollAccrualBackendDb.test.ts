import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { toDateStr } from "../money";
import { PAYROLL_LEGAL_DEFAULTS } from "../payrollLegalService";
import { approveRun as approveCommissionRun } from "../commissions/runs";
import { withTx } from "../tx";
import {
  cancelLockedEmployeeAdvanceTx,
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
  "receipts",
  "financialPeriods",
  "payrollItems",
  "payrollRuns",
  "employeeAdvances",
  "employeeTerminations",
  "employees",
  "payrollLegalSettings",
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
    { id: 1, openId: "payroll-maker", role: "admin", branchId: 1, isOwner: true },
    { id: 2, openId: "payroll-checker", role: "manager", branchId: 1, isOwner: true },
    { id: 3, openId: "payroll-payer", role: "manager", branchId: 1, isOwner: true },
    { id: 4, openId: "payroll-return-checker", role: "manager", branchId: 1, isOwner: true },
    { id: 5, openId: "payroll-hr-full", role: "manager", branchId: 1 },
    { id: 6, openId: "payroll-inactive-owner", role: "manager", branchId: 1, isOwner: true, isActive: false },
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
      gross: "600.00",
      net: "600.00",
    },
    {
      runId,
      employeeId: 11,
      branchIdSnapshot: 1,
      payType: "monthly",
      gross: "400.00",
      net: "400.00",
    },
  ]);
  return runId;
}

async function seedZeroNetStatutoryDraft(period = "2026-07") {
  const runner = db();
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

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("payroll accrual lifecycle — DB invariants", () => {
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

    await Promise.all([
      approveRun(runId, CHECKER),
      approveRun(runId, CHECKER),
    ]);

    const obligations = await runner
      .select()
      .from(s.payrollObligations)
      .where(eq(s.payrollObligations.runId, runId));
    expect(obligations).toHaveLength(4);
    expect(Object.fromEntries(obligations.map((row) => [row.kind, row.originalAmount]))).toEqual({
      SALARY_NET: "900.00",
      INCOME_TAX: "50.00",
      SOCIAL_SECURITY: "200.00",
      EOS_PROVISION: "40.00",
    });
    const statutorySummary = await listStatutoryObligationSummary({ branchId: 1 });
    expect(statutorySummary).toEqual(
      expect.arrayContaining([
        { kind: "INCOME_TAX", branchIdSnapshot: 1, remainingAmount: "50.00", openCount: 1 },
        { kind: "SOCIAL_SECURITY", branchIdSnapshot: 1, remainingAmount: "200.00", openCount: 1 },
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
      payRun(runId, PAYER, { paymentMethod: "CASH", paymentDate: "2026-08-01" }),
      payRun(runId, PAYER, { paymentMethod: "CASH", paymentDate: "2026-08-01" }),
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
      amount: "900.00",
    });

    await returnSalaryPayment(
      { accountingEventId: Number(salaryEvents[0].id), returnedAt: "2026-08-02", reason: "إعادة المبلغ من الموظف" },
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
    expect(reopenVsCancellation.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(reopenVsCancellation.filter((result) => result.status === "rejected")).toHaveLength(1);
    for (const result of reopenVsCancellation) {
      if (result.status === "rejected") {
        expect(String(result.reason)).not.toMatch(/ER_LOCK_DEADLOCK|deadlock/i);
      }
    }
    const reopenedResult = reopenVsCancellation.find((result) => result.status === "fulfilled");
    expect(reopenedResult?.status).toBe("fulfilled");
    const reopened = reopenedResult?.status === "fulfilled" ? reopenedResult.value : null;
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

    await expect(cancelRun(runId, MAKER, "إعادة مراجعة ذاتية")).resolves.toMatchObject({
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
    expect(outcomes[1].status).toBe("fulfilled");
    if (outcomes[0].status === "rejected") {
      expect(outcomes[0].reason).toMatchObject({ code: "BAD_REQUEST" });
      expect(String(outcomes[0].reason?.message ?? "")).not.toContain("DEADLOCK");
    }
    const [run] = await runner.select().from(s.payrollRuns).where(eq(s.payrollRuns.id, runId));
    expect(run.status).toBe("approved");
  });

  it("serializes legal-policy updates against approval and rejects a stale generated snapshot", async () => {
    const runner = db();
    const runId = await seedDraft();
    let policyLocked!: () => void;
    let releasePolicy!: () => void;
    const locked = new Promise<void>((resolve) => { policyLocked = resolve; });
    const release = new Promise<void>((resolve) => { releasePolicy = resolve; });
    const updater = withTx(async (tx) => {
      await tx.insert(s.payrollLegalSettings).values({ id: 1 })
        .onDuplicateKeyUpdate({ set: { id: 1 } });
      await tx.select().from(s.payrollLegalSettings)
        .where(eq(s.payrollLegalSettings.id, 1)).for("update").limit(1);
      policyLocked();
      await release;
      await tx.update(s.payrollLegalSettings).set({
        incomeTaxEnabled: true,
        incomeTaxBrackets: [{ upTo: null, rate: "10" }],
        updatedBy: CHECKER.userId,
      }).where(eq(s.payrollLegalSettings.id, 1));
    });
    await locked;
    const approval = approveRun(runId, CHECKER);
    releasePolicy();
    await updater;
    await expect(approval).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const [run] = await runner.select().from(s.payrollRuns).where(eq(s.payrollRuns.id, runId));
    expect(run.status).toBe("draft");
    expect(await runner.select().from(s.payrollAccountingEvents)).toHaveLength(0);
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
    expect(raced.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(raced.filter((result) => result.status === "rejected")).toHaveLength(1);
    const [payroll] = await runner.select().from(s.payrollRuns).where(eq(s.payrollRuns.id, runId));
    const [commission] = await runner.select().from(s.commissionRuns).where(eq(s.commissionRuns.id, 90));
    expect(
      (payroll.status === "approved" && commission.status === "draft") ||
      (payroll.status === "draft" && commission.status === "approved"),
    ).toBe(true);
  });

  it("serializes commission approval with payroll generation without deadlock or silent capture", async () => {
    const runner = db();
    await runner.insert(s.commissionPlans).values({ id: 91, name: "Race commission" });
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
    const [run] = await runner.select().from(s.payrollRuns).where(eq(s.payrollRuns.period, "2026-07"));
    const [commission] = await runner.select().from(s.commissionRuns).where(eq(s.commissionRuns.id, 91));
    const [item] = await runner.select().from(s.payrollItems).where(and(
      eq(s.payrollItems.runId, Number(run.id)),
      eq(s.payrollItems.employeeId, 10),
    ));
    expect(commission.status).toBe("approved");
    if (commission.payrollRunId == null) {
      expect(item.commission).toBe("0.00");
    } else {
      expect(Number(commission.payrollRunId)).toBe(Number(run.id));
      expect(item.commission).toBe("100.00");
    }
  });

  it("posts reopen reversal to the original accrual date and reapproval keeps one net July expense", async () => {
    const runner = db();
    const runId = await seedDraft();
    await approveRun(runId, CHECKER);
    const [firstAccrual] = await runner
      .select({ amount: s.accountingEntries.amount, entryDate: s.accountingEntries.entryDate })
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
      .select({ amount: s.accountingEntries.amount, entryDate: s.accountingEntries.entryDate })
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
    expect(economicEntries.map((entry) => toDateStr(new Date(entry.entryDate)))).toEqual([
      "2026-07-31",
      "2026-07-31",
      "2026-07-31",
    ]);
    expect(economicEntries.reduce((sum, entry) => sum + Number(entry.amount), 0)).toBe(
      Number(firstAccrual.amount),
    );
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

    await expect(cancelRun(runId, CHECKER, "محاولة فتح فترة مقفلة")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const [run] = await runner.select().from(s.payrollRuns).where(eq(s.payrollRuns.id, runId));
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
    await expect(approveRun(Number(run?.id), CHECKER)).resolves.toMatchObject({ status: "approved" });
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
    await runner.delete(s.employeeAdvances).where(eq(s.employeeAdvances.employeeId, 10));
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
    expect(covered).toMatchObject({ gross: "0.00", commission: "100.00", net: "100.00" });
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
    const employeeA = firstPayments.find((row) => Number(row.employeeId) === 10);
    expect(employeeA).toBeDefined();

    const salaryReturnInput = {
      accountingEventId: Number(employeeA!.eventId),
      returnedAt: "2026-08-02",
      reason: "إعادة جزئية مثبتة",
    };
    await expect(returnSalaryPayment(salaryReturnInput, RETURN_CHECKER)).resolves.toMatchObject({ replayed: false });
    await expect(returnSalaryPayment(salaryReturnInput, RETURN_CHECKER)).resolves.toMatchObject({ replayed: true });
    await expect(
      returnSalaryPayment({ ...salaryReturnInput, reason: "سبب مختلف عن الإعادة المثبتة" }, RETURN_CHECKER),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const [afterReturn] = await runner
      .select()
      .from(s.payrollRuns)
      .where(eq(s.payrollRuns.id, runId));
    expect(afterReturn).toMatchObject({ status: "approved", paidAt: null, paidBy: null });
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
        returnedObligations.map((row) => [Number(row.employeeId), `${row.remainingAmount}:${row.status}`]),
      ),
    ).toEqual({ 10: "600.00:OPEN", 11: "0.00:SETTLED" });
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
        { employeeId: 10, amount: "600.00", paymentDate: "2026-08-01", active: false },
        { employeeId: 11, amount: "400.00", paymentDate: "2026-08-01", active: true },
      ]),
    );

    await Promise.all([
      payRun(runId, PAYER, { paymentMethod: "CASH", paymentDate: "2026-08-03" }),
      payRun(runId, PAYER, { paymentMethod: "CASH", paymentDate: "2026-08-03" }),
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
    expect(finalPayments.filter((row) => Number(row.employeeId) === 10)).toHaveLength(2);
    expect(finalPayments.filter((row) => Number(row.employeeId) === 11)).toHaveLength(1);
    expect(new Set(finalPayments.map((row) => row.sourceKey)).size).toBe(3);
    await expect(
      payRun(runId, PAYER, { paymentMethod: "CASH", paymentDate: "2026-08-03" }),
    ).resolves.toMatchObject({ replayed: true });
    await expect(
      payRun(runId, PAYER, { paymentMethod: "TRANSFER", paymentDate: "2026-08-03", referenceNumber: "DIFFERENT-RETRY" }),
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
    expect(finalObligations.every((row) => row.remainingAmount === "0.00" && row.status === "SETTLED")).toBe(true);
    const [paidRun] = await runner
      .select()
      .from(s.payrollRuns)
      .where(eq(s.payrollRuns.id, runId));
    expect(paidRun.status).toBe("paid");
    expect(paidRun.paidAt).not.toBeNull();
    const paidView = await getRun(runId);
    expect(
      paidView!.employeePaymentSnapshots.filter((payment) => payment.active).map((payment) => ({
        employeeId: payment.employeeId,
        amount: payment.amount,
        paymentDate: toDateStr(new Date(payment.paymentDate!)),
      })),
    ).toEqual(
      expect.arrayContaining([
        { employeeId: 10, amount: "600.00", paymentDate: "2026-08-03" },
        { employeeId: 11, amount: "400.00", paymentDate: "2026-08-01" },
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
      salaryMovements.find((row) => row.movementType === "SALARY_PAYMENT_RETURN"),
    ).toMatchObject({ active: true, amount: "600.00" });

    await payRun(runId, PAYER, { paymentMethod: "CASH", paymentDate: "2026-08-03" });
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
      supportingDocumentUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlA+uQAAAAASUVORK5CYII=",
      clientRequestId: "tax-remittance-idempotent",
    };

    const duplicate = await Promise.all([
      createRemittanceRequest(base, MAKER),
      createRemittanceRequest(base, MAKER),
    ]);
    expect(new Set(duplicate.map((row) => Number(row.id))).size).toBe(1);
    expect(duplicate.filter((row) => row.replayed)).toHaveLength(1);

    const competing = await Promise.allSettled([
      createRemittanceRequest({ ...base, clientRequestId: "tax-competing-a" }, MAKER),
      createRemittanceRequest({ ...base, clientRequestId: "tax-competing-b" }, MAKER),
    ]);
    expect(competing.filter((row) => row.status === "rejected")).toHaveLength(2);

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
      payRemittanceRequest({ requestId, paymentMethod: "CASH", paymentDate: "2026-08-01" }, PAYER),
    ).resolves.toMatchObject({ replayed: true });
    await expect(
      payRemittanceRequest({ requestId, paymentMethod: "TRANSFER", paymentDate: "2026-08-01", referenceNumber: "DIFFERENT-RETRY" }, PAYER),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await returnRemittance(
      requestId,
      "إعادة فعلية من الهيئة",
      RETURN_CHECKER,
      { returnedAt: "2026-08-02" },
    );
    await expect(returnRemittance(
      requestId,
      "إعادة فعلية من الهيئة",
      RETURN_CHECKER,
      { returnedAt: "2026-08-02" },
    )).resolves.toMatchObject({ replayed: true });
    await expect(returnRemittance(
      requestId,
      "إعادة فعلية من الهيئة",
      RETURN_CHECKER,
      { returnedAt: "2026-08-03", referenceNumber: "DIFFERENT-RETURN" },
    )).rejects.toMatchObject({ code: "CONFLICT" });

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
    const remittanceLedger = await getPayrollFinancialLedger({ period: "2026-08" });
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
        expect.objectContaining({ movementType: "REMITTANCE_RETURN", active: true }),
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
        supportingDocumentUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlA+uQAAAAASUVORK5CYII=",
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
        supportingDocumentUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlA+uQAAAAASUVORK5CYII=",
        status: "REJECTED",
        sourceKey: "PAYROLL:REMIT-REQ:decided-rejected",
        createdBy: MAKER.userId,
        rejectedBy: CHECKER.userId,
        rejectedAt: new Date(),
        rejectionReason: "مرجع غير صحيح",
      },
    ]);
    await expect(approveRemittanceRequest(70, NON_OWNER_HR)).rejects.toMatchObject({
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
  it("accrues statutory and advance effects without cash and reverses them exactly", async () => {
    const runner = db();
    const runId = await seedZeroNetStatutoryDraft();
    const receiptsBefore = await runner.select().from(s.receipts);

    await expect(approveRun(runId, CHECKER)).resolves.toMatchObject({ status: "approved" });

    const obligations = await runner
      .select()
      .from(s.payrollObligations)
      .where(eq(s.payrollObligations.runId, runId));
    expect(obligations.map((row) => [row.kind, row.originalAmount, row.remainingAmount, row.status]).sort())
      .toEqual([
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
      .where(and(
        eq(s.advanceSettlements.runId, runId),
        eq(s.advanceSettlements.direction, "APPLY"),
      ));
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ advanceId: 20, amount: "500.00", reversalOfId: null });
    const [advanceAfterApproval] = await runner
      .select()
      .from(s.employeeAdvances)
      .where(eq(s.employeeAdvances.id, 20));
    expect(advanceAfterApproval).toMatchObject({ remaining: "0.00", status: "SETTLED" });
    expect(await runner.select().from(s.receipts)).toHaveLength(receiptsBefore.length);

    const paid = await payRun(runId, PAYER, {
      paymentMethod: "CASH",
      paymentDate: "2026-08-01",
    });
    expect(paid).toMatchObject({ status: "paid", paidBy: PAYER.userId, replayed: false });
    expect(paid.paidAt).not.toBeNull();
    expect(await runner.select().from(s.receipts)).toHaveLength(receiptsBefore.length);
    expect(await runner
      .select()
      .from(s.payrollAccountingEvents)
      .where(and(
        eq(s.payrollAccountingEvents.runId, runId),
        eq(s.payrollAccountingEvents.eventKind, "SALARY_PAYMENT"),
      ))).toHaveLength(0);

    await expect(cancelRun(runId, CHECKER, "عكس مسير صفري بعد تدقيق الالتزامات")).resolves.toMatchObject({
      status: "draft",
      revisionNo: 1,
    });
    const reversedObligations = await runner
      .select()
      .from(s.payrollObligations)
      .where(eq(s.payrollObligations.runId, runId));
    expect(reversedObligations.every((row) => row.status === "REVERSED" && row.remainingAmount === "0.00"))
      .toBe(true);
    const settlements = await runner
      .select()
      .from(s.advanceSettlements)
      .where(eq(s.advanceSettlements.runId, runId))
      .orderBy(s.advanceSettlements.id);
    expect(settlements.map((row) => [row.direction, row.amount, row.reversalOfId])).toEqual([
      ["APPLY", "500.00", null],
      ["REVERSE", "500.00", Number(settlements[0].id)],
    ]);
    const [advanceAfterReopen] = await runner
      .select()
      .from(s.employeeAdvances)
      .where(eq(s.employeeAdvances.id, 20));
    expect(advanceAfterReopen).toMatchObject({ remaining: "500.00", status: "ACTIVE" });

    const [reversal] = await runner
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.dedupeKey, `PAYROLL:ACCRUAL-REV:${runId}:0:1`));
    expect(reversal).toMatchObject({
      entryType: "ADJUST",
      postingProfile: null,
      postingIntentJson: null,
      amount: "-1150.00",
      receiptId: null,
    });
    expect(toDateStr(new Date(reversal.entryDate))).toBe("2026-07-31");
    expect(await runner.select().from(s.receipts)).toHaveLength(receiptsBefore.length);
  });
});
