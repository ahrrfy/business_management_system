/**
 * E2E Test Suite: Dynamic Commission Rules & Payroll Lifecycle (F3, F4)
 *
 * Covers:
 *  - Tier 1: Feature Coverage (F3 Dynamic Multi-Role Rules, F4 Negative Carryover & Payroll Lifecycle)
 *  - Tier 2: Boundary & Corner Cases (Zero targets, empty periods, mutual exclusivity invariants, idempotency)
 *  - Tier 3: Cross-Feature Combinations (SOD Maker-Checker, Payroll freeze, Cashier balancing disqualification)
 *  - Tier 4: Real-World Monthly Close Workflow (End-to-end branch payroll cycle)
 *
 * Rules:
 *  - TZ=UTC, decimal.js precision, no floats, zero-drift guarantees.
 *  - Strict SOD (Creator !== Approver) and payroll run lock enforcement.
 */
import Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../../drizzle/schema";
import { getDb } from "../../../db";
import { truncateTables } from "../../__tests__/__testUtils__";
import { money, round2, toDbMoney } from "../../money";
import {
  applyPlanTier,
  calculateActivityBounties,
  calculateMarginalSlabs,
  computeCommissionRun,
  evaluateCashierBalancingBonus,
} from "../engine";
import { assignPlan, createPlan } from "../plans";
import { approveRun, deleteDraft, getRun, unapproveRun } from "../runs";
import { saveTargets } from "../targets";
import { assertCommissionArtifactReadyForPayrollTx } from "../payrollReadiness";

const COMPUTER = { userId: 1, branchId: 1 };
const APPROVER = { userId: 2, branchId: 1 };

const TABLES = [
  "invoiceAttributions",
  "commissionRunLines",
  "commissionRuns",
  "commissionAssignments",
  "commissionPlanTiers",
  "commissionPlans",
  "salesTargets",
  "payrollItems",
  "payrollRuns",
  "accountingEntries",
  "workOrders",
  "invoices",
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
  await truncateTables(TABLES);
}

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "t-admin", name: "المحتسب", role: "admin", branchId: 1 },
    { id: 2, openId: "t-manager", name: "المعتمد", role: "manager", branchId: 1 },
    { id: 3, openId: "t-rep", name: "بائع الصالة", role: "cashier", branchId: 1 },
    { id: 4, openId: "t-cashier", name: "الكاشير", role: "cashier", branchId: 1 },
  ]);
  await d.insert(s.employees).values([
    { id: 11, userId: 3, branchId: 1, firstName: "عمر", lastName: "البائع", payType: "monthly", salary: "1000000" },
    { id: 12, userId: 4, branchId: 1, firstName: "ياسر", lastName: "الكاشير", payType: "monthly", salary: "850000" },
  ]);
}

let invoiceSeq = 200;
async function seedSale(opts: { sellerId: number; revenue: string; date: string; isReturn?: boolean }) {
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

describe("E2E Dynamic Commission Rules & Payroll Lifecycle (F3, F4)", () => {
  beforeEach(async () => {
    await reset();
    await seedBase();
  });

  // =========================================================================
  // TIER 1: Feature Coverage (F3 & F4)
  // =========================================================================
  describe("Tier 1: Feature Coverage", () => {
    it("F3.1: Retroactive full-base plan (TARGET_PCT) applies highest reached tier percentage + fixed bonus", async () => {
      const { planId } = await createPlan(
        {
          name: "خطة الهدف التصاعدية",
          tierMode: "TARGET_PCT",
          tiers: [
            { threshold: "70", ratePct: "1.0", fixedBonus: "0" },
            { threshold: "100", ratePct: "2.0", fixedBonus: "50000" },
            { threshold: "120", ratePct: "3.0", fixedBonus: "100000" },
          ],
        },
        COMPUTER,
      );
      await assignPlan({ employeeId: 11, planId, effectiveFrom: "2026-04" }, COMPUTER);

      // Target = 10,000,000 IQD. Sales = 11,000,000 IQD -> 110% achievement (Tier 2: 2.0% + 50,000 IQD)
      await saveTargets({ period: "2026-04", rows: [{ employeeId: 11, target: "10000000" }] }, COMPUTER);
      await seedSale({ sellerId: 3, revenue: "11000000", date: "2026-04-15" });

      const res = await computeCommissionRun("2026-04", COMPUTER);
      const run = await getRun(res.runId);
      expect(run.status).toBe("draft");
      const line = run.lines.find((l) => l.employeeId === 11)!;

      // 11,000,000 * 2% = 220,000 + 50,000 bonus = 270,000 IQD
      expect(line.effectiveBase).toBe("11000000.00");
      expect(line.commissionAmount).toBe("270000.00");
      expect(line.fixedBonus).toBe("50000.00");
    });

    it("F3.2: Marginal progressive slab plan calculates tax-bracket style commission without cliff drops", () => {
      const slabs = [
        { from: new Decimal("0"), to: new Decimal("5000000"), ratePct: new Decimal("1.0") },
        { from: new Decimal("5000000"), to: new Decimal("15000000"), ratePct: new Decimal("2.0") },
        { from: new Decimal("15000000"), ratePct: new Decimal("3.0") },
      ];

      // Base = 12,000,000 IQD
      // First 5M @ 1% = 50,000 IQD
      // Next 7M @ 2% = 140,000 IQD
      // Total = 190,000 IQD
      const comm = calculateMarginalSlabs(new Decimal("12000000"), slabs);
      expect(comm.toString()).toBe("190000");

      // Base = 20,000,000 IQD
      // First 5M @ 1% = 50,000 IQD
      // Next 10M @ 2% = 200,000 IQD
      // Remaining 5M @ 3% = 150,000 IQD
      // Total = 400,000 IQD
      const comm2 = calculateMarginalSlabs(new Decimal("20000000"), slabs);
      expect(comm2.toString()).toBe("400000");
    });

    it("F3.3 & F3.4: Receptionist per-order bounties and fulfiller dispatch bounties calculate accurately", () => {
      const bounties = calculateActivityBounties({
        completedWorkOrdersCount: 12, // 12 custom print orders
        bountyPerWorkOrder: new Decimal("2500"), // 2,500 IQD each = 30,000 IQD
        dispatchedOnlineOrdersCount: 45, // 45 online orders
        bountyPerOnlineOrder: new Decimal("1000"), // 1,000 IQD each = 45,000 IQD
      });

      expect(bounties.workOrderBounty.toString()).toBe("30000");
      expect(bounties.fulfillerBounty.toString()).toBe("45000");
      expect(bounties.totalBounties.toString()).toBe("75000");
    });

    it("F3.5: Cashier register balancing bonus qualifies only on zero cash drawer variance", () => {
      const perfectShifts = [
        { actualCashCounted: new Decimal("1500000"), expectedCash: new Decimal("1500000") },
        { actualCashCounted: new Decimal("2100000"), expectedCash: new Decimal("2100000") },
        { actualCashCounted: new Decimal("1850000"), expectedCash: new Decimal("1850000") },
      ];

      const res = evaluateCashierBalancingBonus({
        shifts: perfectShifts,
        balancingAllowance: new Decimal("50000"),
        disqualificationThreshold: new Decimal("5000"),
      });

      expect(res.eligible).toBe(true);
      expect(res.bonusAmount.toString()).toBe("50000");
    });

    it("F4.1 & F4.2: Negative gross base sets commission to 0 and carries forward negative carryout into next period", async () => {
      const { planId } = await createPlan(
        {
          name: "خطة عادية",
          tierMode: "AMOUNT_SLAB",
          tiers: [{ threshold: "0", ratePct: "2.0", fixedBonus: "0" }],
        },
        COMPUTER,
      );
      await assignPlan({ employeeId: 11, planId, effectiveFrom: "2026-05" }, COMPUTER);

      // Period 2026-05: Returns exceed sales! Net sales = -200,000 IQD
      await seedSale({ sellerId: 3, revenue: "200000", date: "2026-05-10", isReturn: true });

      const resMay = await computeCommissionRun("2026-05", COMPUTER);
      const runMay = await getRun(resMay.runId);
      const lineMay = runMay.lines.find((l) => l.employeeId === 11)!;

      expect(lineMay.effectiveBase).toBe("0.00");
      expect(lineMay.carryOut).toBe("-200000.00");
      expect(lineMay.commissionAmount).toBe("0.00");

      // Approve May run with independent approver
      await approveRun(resMay.runId, APPROVER);

      // Period 2026-06: New sales of 500,000 IQD. CarryIn = -200,000 IQD -> EffectiveBase = 300,000 IQD
      await seedSale({ sellerId: 3, revenue: "500000", date: "2026-06-08" });

      const resJune = await computeCommissionRun("2026-06", COMPUTER);
      const runJune = await getRun(resJune.runId);
      const lineJune = runJune.lines.find((l) => l.employeeId === 11)!;

      expect(lineJune.carryIn).toBe("-200000.00");
      expect(lineJune.effectiveBase).toBe("300000.00"); // 500k - 200k = 300k
      expect(lineJune.carryOut).toBe("0.00");
      // 300,000 * 2% = 6,000 IQD
      expect(lineJune.commissionAmount).toBe("6000.00");
    });

    it("F4.3: Segregation of Duties (SOD) rejects self-approval by creator", async () => {
      const { planId } = await createPlan(
        { name: "خطة تجريبية", tierMode: "AMOUNT_SLAB", tiers: [{ threshold: "0", ratePct: "1.0", fixedBonus: "0" }] },
        COMPUTER,
      );
      await assignPlan({ employeeId: 11, planId, effectiveFrom: "2026-07" }, COMPUTER);
      await seedSale({ sellerId: 3, revenue: "100000", date: "2026-07-05" });

      const res = await computeCommissionRun("2026-07", COMPUTER);

      // COMPUTER created the run (createdBy = 1). COMPUTER attempting approval must be rejected!
      await expect(approveRun(res.runId, COMPUTER)).rejects.toThrow();

      // Independent manager APPROVER (userId = 2) succeeds!
      const approved = await approveRun(res.runId, APPROVER);
      expect(approved.status).toBe("approved");
    });

    it("F4.4: assertCommissionArtifactReadyForPayrollTx blocks payroll approval if commission run is missing", async () => {
      const { planId } = await createPlan(
        { name: "خطة الرواتب", tierMode: "AMOUNT_SLAB", tiers: [{ threshold: "0", ratePct: "1.0", fixedBonus: "0" }] },
        COMPUTER,
      );
      await assignPlan({ employeeId: 11, planId, effectiveFrom: "2026-08" }, COMPUTER);

      const d = db();
      await d.transaction(async (tx) => {
        // In 2026-08, employee 11 has an active plan, but NO commission run exists!
        await expect(assertCommissionArtifactReadyForPayrollTx(tx, "2026-08")).rejects.toThrow();
      });
    });
  });

  // =========================================================================
  // TIER 2: Boundary & Corner Cases
  // =========================================================================
  describe("Tier 2: Boundary & Corner Cases", () => {
    it("B2.1: Empty period with zero sales creates clean zero line for eligible staff without errors", async () => {
      const { planId } = await createPlan(
        { name: "خطة هادئة", tierMode: "AMOUNT_SLAB", tiers: [{ threshold: "0", ratePct: "1.0", fixedBonus: "0" }] },
        COMPUTER,
      );
      await assignPlan({ employeeId: 11, planId, effectiveFrom: "2026-09" }, COMPUTER);

      const res = await computeCommissionRun("2026-09", COMPUTER);
      const run = await getRun(res.runId);
      expect(run.lines).toHaveLength(1);
      const line = run.lines[0];
      expect(line.baseSales).toBe("0.00");
      expect(line.effectiveBase).toBe("0.00");
      expect(line.commissionAmount).toBe("0.00");
    });

    it("B2.2: Null or zero sales target under TARGET_PCT produces explicit zero line without NaN or division by zero", async () => {
      const { planId } = await createPlan(
        {
          name: "خطة النسبة",
          tierMode: "TARGET_PCT",
          tiers: [{ threshold: "100", ratePct: "2.0", fixedBonus: "0" }],
        },
        COMPUTER,
      );
      await assignPlan({ employeeId: 11, planId, effectiveFrom: "2026-10" }, COMPUTER);
      // No target entered for 2026-10
      await seedSale({ sellerId: 3, revenue: "500000", date: "2026-10-12" });

      const res = await computeCommissionRun("2026-10", COMPUTER);
      const run = await getRun(res.runId);
      const line = run.lines[0];
      expect(line.targetAmount).toBeNull();
      expect(line.achievementPct).toBeNull();
      expect(line.commissionAmount).toBe("0.00");
      expect(line.detail).toMatchObject({ noTarget: true });
    });

    it("B2.3: Invariant check: effectiveBase * carryOut === 0 holds universally across all runs", async () => {
      const { planId } = await createPlan(
        { name: "خطة الثوابت", tierMode: "AMOUNT_SLAB", tiers: [{ threshold: "0", ratePct: "1.0", fixedBonus: "0" }] },
        COMPUTER,
      );
      await assignPlan({ employeeId: 11, planId, effectiveFrom: "2026-11" }, COMPUTER);
      await seedSale({ sellerId: 3, revenue: "400000", date: "2026-11-04" });

      const res = await computeCommissionRun("2026-11", COMPUTER);
      const run = await getRun(res.runId);
      for (const line of run.lines) {
        const eff = new Decimal(line.effectiveBase);
        const cout = new Decimal(line.carryOut);
        expect(eff.times(cout).isZero()).toBe(true);
      }
    });

    it("B2.4: Recalculating draft commission run is 100% idempotent and leaves no duplicate rows", async () => {
      const { planId } = await createPlan(
        { name: "خطة الإعادة", tierMode: "AMOUNT_SLAB", tiers: [{ threshold: "0", ratePct: "1.0", fixedBonus: "0" }] },
        COMPUTER,
      );
      await assignPlan({ employeeId: 11, planId, effectiveFrom: "2026-12" }, COMPUTER);
      await seedSale({ sellerId: 3, revenue: "750000", date: "2026-12-10" });

      const res1 = await computeCommissionRun("2026-12", COMPUTER);
      const run1 = await getRun(res1.runId);
      expect(run1.lines).toHaveLength(1);

      // Re-run computation
      const res2 = await computeCommissionRun("2026-12", COMPUTER);
      const run2 = await getRun(res2.runId);
      expect(run2.id).toBe(run1.id);
      expect(run2.lines).toHaveLength(1);
      expect(run2.totalCommission).toBe(run1.totalCommission);
    });
  });

  // =========================================================================
  // TIER 3: Cross-Feature Combinations
  // =========================================================================
  describe("Tier 3: Cross-Feature Combinations", () => {
    it("C4: Approved commission run is frozen against deletion or alteration; unapproval is rejected", async () => {
      const { planId } = await createPlan(
        { name: "خطة التجميد", tierMode: "AMOUNT_SLAB", tiers: [{ threshold: "0", ratePct: "1.0", fixedBonus: "0" }] },
        COMPUTER,
      );
      await assignPlan({ employeeId: 11, planId, effectiveFrom: "2027-01" }, COMPUTER);
      await seedSale({ sellerId: 3, revenue: "300000", date: "2027-01-10" });

      const res = await computeCommissionRun("2027-01", COMPUTER);
      await approveRun(res.runId, APPROVER);

      // Attempting to delete draft on approved run must throw
      await expect(deleteDraft(res.runId, COMPUTER)).rejects.toThrow();

      // Attempting to unapprove must throw PRECONDITION_FAILED
      await expect(unapproveRun(res.runId, APPROVER)).rejects.toThrow();
    });

    it("C5: applyPlanTier sorts unsorted tier configurations deterministically", () => {
      const unsortedPlan = {
        id: 99,
        name: "خطة غير مرتبة",
        basis: "NET_SALES",
        tierMode: "AMOUNT_SLAB" as const,
        tiers: [
          { sort: 2, threshold: new Decimal("2000000"), ratePct: new Decimal("5.0"), fixedBonus: new Decimal("20000") },
          { sort: 0, threshold: new Decimal("0"), ratePct: new Decimal("1.0"), fixedBonus: new Decimal("0") },
          { sort: 1, threshold: new Decimal("1000000"), ratePct: new Decimal("3.0"), fixedBonus: new Decimal("10000") },
        ],
      };

      // 1.5M falls in middle tier (threshold 1,000,000)
      const res = applyPlanTier(unsortedPlan, new Decimal("1500000"), null);
      expect(res.tier?.sort).toBe(1);
      expect(res.ratePct.toString()).toBe("3");
      expect(res.fixedBonus.toString()).toBe("10000");
      // 1,500,000 * 3% + 10,000 = 45,000 + 10,000 = 55,000
      expect(res.commission.toString()).toBe("55000");
    });

    it("C6: Cashier drawer balancing bonus is disqualified if any shift exceeds shortage threshold", () => {
      const shiftsWithMajorShortage = [
        { actualCashCounted: new Decimal("1500000"), expectedCash: new Decimal("1500000") },
        { actualCashCounted: new Decimal("990000"), expectedCash: new Decimal("1000000") }, // 10,000 IQD shortage > 5,000 limit
      ];

      const res = evaluateCashierBalancingBonus({
        shifts: shiftsWithMajorShortage,
        balancingAllowance: new Decimal("50000"),
        disqualificationThreshold: new Decimal("5000"),
      });

      expect(res.eligible).toBe(false);
      expect(res.bonusAmount.toString()).toBe("0");
      expect(res.disqualificationReason).toContain("تجاوز العجز النقدي");
    });

    it("C7: Cashier balancing bonus returns no_shifts_recorded when shifts are empty", () => {
      const emptyRes = evaluateCashierBalancingBonus({
        shifts: [],
        balancingAllowance: new Decimal("50000"),
        disqualificationThreshold: new Decimal("5000"),
      });
      expect(emptyRes.eligible).toBe(false);
      expect(emptyRes.bonusAmount.toString()).toBe("0");
      expect(emptyRes.reason).toBe("no_shifts_recorded");

      const nullRes = evaluateCashierBalancingBonus({
        shifts: undefined as any,
        balancingAllowance: new Decimal("50000"),
        disqualificationThreshold: new Decimal("5000"),
      });
      expect(nullRes.eligible).toBe(false);
      expect(nullRes.bonusAmount.toString()).toBe("0");
      expect(nullRes.reason).toBe("no_shifts_recorded");
    });

    it("C8: Activity bounties clamp negative counts to zero", () => {
      const res = calculateActivityBounties({
        completedWorkOrdersCount: -5,
        bountyPerWorkOrder: new Decimal("2000"),
        dispatchedOnlineOrdersCount: -3,
        bountyPerOnlineOrder: new Decimal("1000"),
      });
      expect(res.workOrderBounty.toString()).toBe("0");
      expect(res.fulfillerBounty.toString()).toBe("0");
      expect(res.totalBounties.toString()).toBe("0");
    });

    it("C9: computeCommissionRun integrates activity bounties and cashier balancing bonus into line payout and detail", async () => {
      const { planId } = await createPlan(
        { name: "خطة متعددة الأدوار", tierMode: "AMOUNT_SLAB", tiers: [{ threshold: "0", ratePct: "2.0", fixedBonus: "0" }] },
        COMPUTER,
      );
      await assignPlan({ employeeId: 11, planId, effectiveFrom: "2027-03" }, COMPUTER);
      await assignPlan({ employeeId: 12, planId, effectiveFrom: "2027-03" }, COMPUTER);

      // Rep 11 has sales of 1,000,000 IQD -> tier commission = 20,000 IQD
      await seedSale({ sellerId: 3, revenue: "1000000", date: "2027-03-05" });

      const res = await computeCommissionRun("2027-03", COMPUTER, null, {
        bountyPerWorkOrder: new Decimal("5000"),
        bountyPerOnlineOrder: new Decimal("2000"),
        cashierBalancingAllowance: new Decimal("50000"),
        cashierDisqualificationThreshold: new Decimal("5000"),
        cashierShiftsByUser: {
          4: [
            { actualCashCounted: new Decimal("500000"), expectedCash: new Decimal("500000") },
          ],
        },
      });

      const run = await getRun(res.runId);
      const line11 = run.lines.find((l) => l.employeeId === 11)!;
      const line12 = run.lines.find((l) => l.employeeId === 12)!;

      // Rep 11: 20,000 IQD tier commission
      expect(line11.commissionAmount).toBe("20000.00");
      expect(line11.detail).toMatchObject({
        tierCommission: "20000.00",
        cashierBonus: { eligible: false, bonusAmount: "0.00", reason: "no_shifts_recorded" },
      });

      // Cashier 12: 0 sales tier + 50,000 balancing bonus = 50,000 IQD
      expect(line12.commissionAmount).toBe("50000.00");
      expect(line12.detail).toMatchObject({
        tierCommission: "0.00",
        cashierBonus: { eligible: true, bonusAmount: "50000.00" },
      });

      expect(run.totalCommission).toBe("70000.00");
    });
  });

  // =========================================================================
  // TIER 4: Real-World Monthly Close Workflow
  // =========================================================================
  describe("Tier 4: Real-World Monthly Close Workflow", () => {
    it("Executes complete end-of-month commission closing with SOD approval and payroll readiness assertion", async () => {
      const { planId } = await createPlan(
        {
          name: "خطة الإقفال الشهري للفرع",
          tierMode: "TARGET_PCT",
          tiers: [
            { threshold: "80", ratePct: "1.5", fixedBonus: "0" },
            { threshold: "100", ratePct: "2.5", fixedBonus: "75000" },
          ],
        },
        COMPUTER,
      );
      await assignPlan({ employeeId: 11, planId, effectiveFrom: "2027-02" }, COMPUTER);
      await assignPlan({ employeeId: 12, planId, effectiveFrom: "2027-02" }, COMPUTER);

      // Set Targets: Rep 11 = 5,000,000 IQD; Cashier 12 = 3,000,000 IQD
      await saveTargets(
        {
          period: "2027-02",
          rows: [
            { employeeId: 11, target: "5000000" },
            { employeeId: 12, target: "3000000" },
          ],
        },
        COMPUTER,
      );

      // Rep 11 (userId 3) sales = 5,500,000 IQD (110% -> 2.5% + 75,000 bonus = 137,500 + 75,000 = 212,500 IQD)
      await seedSale({ sellerId: 3, revenue: "5500000", date: "2027-02-14" });
      // Cashier 12 (userId 4) sales = 2,700,000 IQD (90% -> 1.5% + 0 bonus = 40,500 IQD)
      await seedSale({ sellerId: 4, revenue: "2700000", date: "2027-02-18" });

      // Step 1: Accountant computes draft run
      const res = await computeCommissionRun("2027-02", COMPUTER);
      const draft = await getRun(res.runId);
      expect(draft.status).toBe("draft");
      expect(draft.totalCommission).toBe("253000.00"); // 212,500 + 40,500 = 253,000 IQD

      // Step 2: Branch Manager approves run (Maker-Checker)
      const approved = await approveRun(res.runId, APPROVER);
      expect(approved.status).toBe("approved");

      // Step 3: Verify Payroll readiness check passes inside transaction
      const d = db();
      await d.transaction(async (tx) => {
        const artifact = await assertCommissionArtifactReadyForPayrollTx(tx, "2027-02");
        expect(artifact.runId).toBe(res.runId);
        expect(artifact.status).toBe("approved");
      });
    });
  });
});
