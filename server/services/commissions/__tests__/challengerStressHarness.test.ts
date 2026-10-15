/**
 * Challenger Stress Harness: Negative Carryover Invariants & Payroll Lifecycle
 *
 * Authored by M2 Challenger 2 (Empirical Challenger).
 *
 * Verifies:
 * 1. Multi-month consecutive returns driving carryOut increasingly negative (-400k -> -700k -> -1.2M),
 *    followed by partial recovery (-400k), and finally full recovery (+2.6M net base) with zero IQD drift.
 * 2. Invariant: effectiveBase * carryOut === 0 universally across all periods.
 * 3. Payroll readiness assertions: payroll cannot approve or pay if active plan exists without approved commission run.
 * 4. Maker-Checker Segregation of Duties (SOD) and freeze protections against deletion/unapproval.
 */
import Decimal from "decimal.js";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../../drizzle/schema";
import { getDb } from "../../../db";
import { computeCommissionRun } from "../engine";
import { assignPlan, createPlan } from "../plans";
import { approveRun, getRun, unapproveRun, deleteDraft } from "../runs";
import { saveTargets } from "../targets";
import { assertCommissionArtifactReadyForPayrollTx } from "../payrollReadiness";
import { approveRun as approvePayroll, generatePayroll, payRun, cancelRun } from "../../../services/payrollService";

const COMPUTER = { userId: 1, branchId: 1 };
const APPROVER = { userId: 2, branchId: 1, isOwner: true };

const TABLES = [
  "accountingEntries",
  "receipts",
  "payrollItems",
  "payrollRuns",
  "commissionRunApprovalRequests",
  "commissionRunLines",
  "commissionRuns",
  "commissionAssignments",
  "commissionPlanTiers",
  "commissionPlans",
  "salesTargets",
  "workOrders",
  "invoices",
  "attendance",
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
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "t-admin", name: "المحتسب", role: "admin", branchId: 1, isOwner: false, isActive: true },
    { id: 2, openId: "t-manager", name: "المعتمد", role: "manager", branchId: 1, isOwner: true, isActive: true },
    { id: 3, openId: "t-rep", name: "بائع الصالة", role: "cashier", branchId: 1, isOwner: false, isActive: true },
  ]);
  await d.insert(s.employees).values([
    { id: 11, userId: 3, branchId: 1, firstName: "عمر", lastName: "البائع", payType: "monthly", salary: "1000000", allowances: "0" },
  ]);
  await d.insert(s.receipts).values({
    branchId: 1,
    cashBucket: "TREASURY",
    direction: "IN",
    amount: "10000000.00",
    paymentMethod: "CASH",
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    referenceNumber: "TEST-TREASURY-FUNDING-1",
    createdBy: 2,
  });
}

let invoiceSeq = 800;
async function seedEntry(opts: { sellerId: number; revenue: string; date: string; isReturn?: boolean }) {
  const d = db();
  const id = ++invoiceSeq;
  const isRet = opts.isReturn ?? false;
  await d.insert(s.invoices).values({
    id,
    invoiceNumber: `${isRet ? "RET" : "INV"}-${id}`,
    sourceType: "POS",
    sourceId: `SRC-${id}`,
    branchId: 1,
    subtotal: opts.revenue,
    total: opts.revenue,
    paidAmount: opts.revenue,
    status: isRet ? "RETURNED" : "PAID",
    createdBy: opts.sellerId,
  });
  await d.insert(s.accountingEntries).values({
    entryType: isRet ? "RETURN" : "SALE",
    branchId: 1,
    invoiceId: id,
    revenue: isRet ? `-${opts.revenue}` : opts.revenue,
    cost: "0",
    profit: isRet ? `-${opts.revenue}` : opts.revenue,
    amount: isRet ? `-${opts.revenue}` : opts.revenue,
    entryDate: new Date(`${opts.date}T00:00:00Z`),
  });
  return id;
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("M2 Challenger Empirical Suite — Negative Carryover & Multi-Month Deficit Recovery", () => {
  it("Stress Test 1: 3-month consecutive returns driving carryOut increasingly negative (-400k -> -700k -> -1.2M), followed by partial recovery (-400k) and full recovery (+2.6M)", async () => {
    // 1. Create a 2% flat slab plan on net sales
    const { planId } = await createPlan(
      {
        name: "خطة الصالة التجريبية",
        tierMode: "AMOUNT_SLAB",
        tiers: [{ threshold: "0", ratePct: "2.0", fixedBonus: "0" }],
      },
      COMPUTER,
    );
    await assignPlan({ employeeId: 11, planId, effectiveFrom: "2026-01" }, COMPUTER);

    // Month 1: 2026-01. Gross sales = 1,000,000 IQD. Returns = 0.
    const invJan = await seedEntry({ sellerId: 3, revenue: "1000000", date: "2026-01-15" });
    const runJanRes = await computeCommissionRun("2026-01", COMPUTER);
    const runJan = (await getRun(runJanRes.runId))!;
    const lineJan = runJan.lines.find((l) => l.employeeId === 11)!;

    expect(lineJan.carryIn).toBe("0.00");
    expect(lineJan.effectiveBase).toBe("1000000.00");
    expect(lineJan.carryOut).toBe("0.00");
    expect(lineJan.commissionAmount).toBe("20000.00"); // 2% of 1M
    expect(new Decimal(lineJan.effectiveBase).times(new Decimal(lineJan.carryOut)).isZero()).toBe(true);

    await approveRun(runJanRes.runId, APPROVER);

    // Month 2: 2026-02. Return of 400,000 IQD against Month 1 sale. Zero new sales.
    await seedEntry({ sellerId: 3, revenue: "400000", date: "2026-02-10", isReturn: true });
    const runFebRes = await computeCommissionRun("2026-02", COMPUTER);
    const runFeb = (await getRun(runFebRes.runId))!;
    const lineFeb = runFeb.lines.find((l) => l.employeeId === 11)!;

    expect(lineFeb.carryIn).toBe("0.00");
    expect(lineFeb.baseSales).toBe("0.00");
    expect(lineFeb.baseReturns).toBe("400000.00");
    expect(lineFeb.effectiveBase).toBe("0.00");
    expect(lineFeb.carryOut).toBe("-400000.00");
    expect(lineFeb.commissionAmount).toBe("0.00");
    expect(new Decimal(lineFeb.effectiveBase).times(new Decimal(lineFeb.carryOut)).isZero()).toBe(true);

    await approveRun(runFebRes.runId, APPROVER);

    // Month 3: 2026-03. New sale 50,000 IQD, but another return of 350,000 IQD!
    // Gross = 50,000 - 350,000 + (-400,000 carryIn) = -700,000 IQD.
    await seedEntry({ sellerId: 3, revenue: "50000", date: "2026-03-05" });
    await seedEntry({ sellerId: 3, revenue: "350000", date: "2026-03-12", isReturn: true });
    const runMarRes = await computeCommissionRun("2026-03", COMPUTER);
    const runMar = (await getRun(runMarRes.runId))!;
    const lineMar = runMar.lines.find((l) => l.employeeId === 11)!;

    expect(lineMar.carryIn).toBe("-400000.00");
    expect(lineMar.baseSales).toBe("50000.00");
    expect(lineMar.baseReturns).toBe("350000.00");
    expect(lineMar.effectiveBase).toBe("0.00");
    expect(lineMar.carryOut).toBe("-700000.00");
    expect(lineMar.commissionAmount).toBe("0.00");
    expect(new Decimal(lineMar.effectiveBase).times(new Decimal(lineMar.carryOut)).isZero()).toBe(true);

    await approveRun(runMarRes.runId, APPROVER);

    // Month 4: 2026-04. Another massive return of 500,000 IQD! Zero sales.
    // Gross = 0 - 500,000 + (-700,000 carryIn) = -1,200,000 IQD.
    await seedEntry({ sellerId: 3, revenue: "500000", date: "2026-04-18", isReturn: true });
    const runAprRes = await computeCommissionRun("2026-04", COMPUTER);
    const runApr = (await getRun(runAprRes.runId))!;
    const lineApr = runApr.lines.find((l) => l.employeeId === 11)!;

    expect(lineApr.carryIn).toBe("-700000.00");
    expect(lineApr.baseReturns).toBe("500000.00");
    expect(lineApr.effectiveBase).toBe("0.00");
    expect(lineApr.carryOut).toBe("-1200000.00");
    expect(lineApr.commissionAmount).toBe("0.00");
    expect(new Decimal(lineApr.effectiveBase).times(new Decimal(lineApr.carryOut)).isZero()).toBe(true);

    await approveRun(runAprRes.runId, APPROVER);

    // Month 5: 2026-05. Partial recovery! Sales of 800,000 IQD, returns 0.
    // Gross = 800,000 - 0 + (-1,200,000 carryIn) = -400,000 IQD.
    // Deficit reduced from -1.2M down to -400k, still no payout.
    await seedEntry({ sellerId: 3, revenue: "800000", date: "2026-05-14" });
    const runMayRes = await computeCommissionRun("2026-05", COMPUTER);
    const runMay = (await getRun(runMayRes.runId))!;
    const lineMay = runMay.lines.find((l) => l.employeeId === 11)!;

    expect(lineMay.carryIn).toBe("-1200000.00");
    expect(lineMay.baseSales).toBe("800000.00");
    expect(lineMay.baseReturns).toBe("0.00");
    expect(lineMay.effectiveBase).toBe("0.00");
    expect(lineMay.carryOut).toBe("-400000.00");
    expect(lineMay.commissionAmount).toBe("0.00");
    expect(new Decimal(lineMay.effectiveBase).times(new Decimal(lineMay.carryOut)).isZero()).toBe(true);

    await approveRun(runMayRes.runId, APPROVER);

    // Month 6: 2026-06. High sales recovering entire carryIn deficit!
    // Sales of 3,000,000 IQD, returns 0.
    // Gross = 3,000,000 - 0 + (-400,000 carryIn) = +2,600,000 IQD.
    // CarryOut should reset cleanly to 0.00, and commission paid on exactly 2.6M.
    await seedEntry({ sellerId: 3, revenue: "3000000", date: "2026-06-20" });
    const runJunRes = await computeCommissionRun("2026-06", COMPUTER);
    const runJun = (await getRun(runJunRes.runId))!;
    const lineJun = runJun.lines.find((l) => l.employeeId === 11)!;

    expect(lineJun.carryIn).toBe("-400000.00");
    expect(lineJun.baseSales).toBe("3000000.00");
    expect(lineJun.baseReturns).toBe("0.00");
    expect(lineJun.effectiveBase).toBe("2600000.00");
    expect(lineJun.carryOut).toBe("0.00");
    // 2% of 2,600,000 = 52,000 IQD
    expect(lineJun.commissionAmount).toBe("52000.00");
    expect(new Decimal(lineJun.effectiveBase).times(new Decimal(lineJun.carryOut)).isZero()).toBe(true);

    await approveRun(runJunRes.runId, APPROVER);
  });

  it("Stress Test 2: Sequence guard blocks out-of-order execution when an unapproved draft exists", async () => {
    const { planId } = await createPlan(
      { name: "خطة التسلسل", tierMode: "AMOUNT_SLAB", tiers: [{ threshold: "0", ratePct: "1.0", fixedBonus: "0" }] },
      COMPUTER,
    );
    await assignPlan({ employeeId: 11, planId, effectiveFrom: "2026-01" }, COMPUTER);

    // Compute month 2026-07 as draft (do NOT approve)
    await seedEntry({ sellerId: 3, revenue: "100000", date: "2026-07-01" });
    await computeCommissionRun("2026-07", COMPUTER);

    // Attempting to compute month 2026-08 while 2026-07 is an unapproved draft MUST fail
    await expect(computeCommissionRun("2026-08", COMPUTER)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });
});

describe("M2 Challenger Empirical Suite — Payroll Lifecycle & Readiness Assertions", () => {
  it("Asserts payroll cannot approve or pay if active plan exists without approved commission run", async () => {
    // Plan assigned to employee for 2026-09
    const { planId } = await createPlan(
      { name: "خطة حارس الرواتب", tierMode: "AMOUNT_SLAB", tiers: [{ threshold: "0", ratePct: "2.0", fixedBonus: "0" }] },
      COMPUTER,
    );
    await assignPlan({ employeeId: 11, planId, effectiveFrom: "2026-09" }, COMPUTER);

    // Case A: No commission run at all for 2026-09
    const payrollDraft = await generatePayroll("2026-09", COMPUTER);
    const payrollId = Number(payrollDraft!.id);

    // Direct readiness assertion
    await db().transaction(async (tx) => {
      await expect(assertCommissionArtifactReadyForPayrollTx(tx, "2026-09")).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
      });
    });

    // approveRun must fail-closed
    await expect(approvePayroll(payrollId, APPROVER)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });

    // Forced-status approved payroll payRun must also fail-closed
    await db().update(s.payrollRuns).set({ status: "approved" }).where(eq(s.payrollRuns.id, payrollId));
    await expect(payRun(payrollId, APPROVER, { paymentMethod: "CASH", referenceNumber: "REF-CASH-TEST" })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });

    // Reset payroll back to draft for Case B
    await db().update(s.payrollRuns).set({ status: "draft" }).where(eq(s.payrollRuns.id, payrollId));

    // Case B: Commission run computed but remains in DRAFT (unapproved)
    await seedEntry({ sellerId: 3, revenue: "500000", date: "2026-09-10" });
    const commRun = await computeCommissionRun("2026-09", COMPUTER);

    // Direct readiness assertion with draft run
    await db().transaction(async (tx) => {
      await expect(assertCommissionArtifactReadyForPayrollTx(tx, "2026-09")).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
      });
    });

    // approveRun still blocked
    await expect(approvePayroll(payrollId, APPROVER)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });

    // Case C: Maker-Checker (SOD) violation
    // Creator (userId=1) attempts to self-approve commission run -> FORBIDDEN
    await expect(approveRun(commRun.runId, COMPUTER)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    // Case D: Independent approver approves commission run
    await approveRun(commRun.runId, APPROVER);

    // Case E: Cancel draft payroll, regenerate payroll and approve/pay successfully
    // Cancelling the draft allows safe regeneration to capture the approved commission lines
    await cancelRun(payrollId, APPROVER);
    const regeneratedPayroll = await generatePayroll("2026-09", COMPUTER);
    const item = regeneratedPayroll!.items.find((i) => Number(i.employeeId) === 11)!;

    // 2% of 500,000 = 10,000 IQD commission
    expect(Number(item.commission)).toBe(10000);
    expect(Number(item.gross)).toBe(1000000);
    expect(Number(item.net)).toBe(1010000);

    // Readiness check now passes cleanly
    await db().transaction(async (tx) => {
      const artifact = await assertCommissionArtifactReadyForPayrollTx(tx, "2026-09");
      expect(artifact.ready).toBe(true);
      expect(artifact.status).toBe("approved");
    });

    // approveRun now succeeds
    const approvedPayroll = await approvePayroll(Number(regeneratedPayroll!.id), APPROVER);
    expect(approvedPayroll.status).toBe("approved");

    // payRun now succeeds
    const paidPayroll = await payRun(Number(regeneratedPayroll!.id), APPROVER, {
      paymentMethod: "CASH",
      referenceNumber: "CASH-PAY-01",
    });
    expect(paidPayroll.status).toBe("paid");

    // Case F: Immutable audit freeze — approved commission cannot be unapproved or deleted
    await expect(unapproveRun(commRun.runId, APPROVER)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    await expect(deleteDraft(commRun.runId)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(computeCommissionRun("2026-09", COMPUTER)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});
