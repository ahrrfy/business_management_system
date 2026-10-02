/**
 * Adversarial Empirical Verification Test Suite — Wave 2 HR Remediation
 * Challenger 1: Rigorous stress testing of GAP-03 and GAP-04.
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { withTx } from "../tx";
import { createEmployee } from "../employeeService";
import {
  approveRun,
  generatePayroll,
  getRun,
  payRun,
} from "../payrollService";
import {
  createSpotBonus,
  approveSpotBonus,
  paySpotBonusCash,
} from "../employeeSpotBonusService";
import { computeExpectedCash } from "../shiftService";

const ACTOR = { userId: 1, branchId: 1, role: "admin" as const };
const APPROVER = { userId: 2, branchId: 1, role: "manager" as const };

const TABLES = [
  "accountingEntries",
  "receipts",
  "payrollItems",
  "payrollRuns",
  "payrollObligations",
  "payrollAccountingEvents",
  "attendance",
  "leaveRequests",
  "employeePenalties",
  "employeeSpotBonuses",
  "employees",
  "auditLogs",
  "shifts",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) {
    await d.execute(sql.raw(`DELETE FROM \`${t}\``));
  }
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seedBase() {
  const d = db();
  await d
    .insert(s.branches)
    .values([
      { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
      { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
    ])
    .onDuplicateKeyUpdate({ set: { name: sql`VALUES(name)` } });

  await d
    .insert(s.users)
    .values([
      { id: 1, openId: "test-admin", name: "مدير", role: "admin", branchId: 1, isOwner: true },
      { id: 2, openId: "test-approver", name: "مالك مدقّق", role: "manager", branchId: 1, isOwner: true },
    ])
    .onDuplicateKeyUpdate({ set: { name: sql`VALUES(name)`, isOwner: true } });
}

describe("Adversarial Empirical Verification — Wave 2 (GAP-03 & GAP-04)", () => {
  beforeEach(async () => {
    await reset();
    await seedBase();
  });

  describe("GAP-03: Employee Spot Bonus Payout & Payroll Integration", () => {
    it("GAP-03.1: Rejects paying spot bonus cash when treasury cash is insufficient with clean PRECONDITION_FAILED", async () => {
      const d = db();
      const emp = await createEmployee({
        firstName: "أحمد",
        lastName: "الزبيدي",
        branchId: 1,
        salary: "800000",
        payType: "monthly",
      });

      // Treasury has 0 cash (no receipts inserted)
      const bonusRes = await createSpotBonus(ACTOR, {
        employeeId: emp!.id,
        amount: "150000",
        reason: "مكافأة إنجاز",
        disbursementType: "CASH_TREASURY",
      });
      await approveSpotBonus(APPROVER, bonusRes.id);

      // Attempt to pay from empty treasury
      await expect(
        paySpotBonusCash(APPROVER, { id: bonusRes.id, cashBucket: "TREASURY" }),
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
      });

      // Verify bonus remains APPROVED and no receipt was created
      const [bonus] = await d
        .select()
        .from(s.employeeSpotBonuses)
        .where(eq(s.employeeSpotBonuses.id, bonusRes.id));
      expect(bonus.status).toBe("APPROVED");
      expect(bonus.paidAt).toBeNull();
      expect(bonus.voucherId).toBeNull();

      const outReceipts = await d
        .select()
        .from(s.receipts)
        .where(eq(s.receipts.direction, "OUT"));
      expect(outReceipts).toHaveLength(0);
    });

    it("GAP-03.2: Rejects paying spot bonus cash when drawer cash is insufficient with clean PRECONDITION_FAILED", async () => {
      const d = db();
      const emp = await createEmployee({
        firstName: "مهند",
        lastName: "التميمي",
        branchId: 1,
        salary: "900000",
        payType: "monthly",
      });

      // Open shift with only 25,000 in drawer
      await d.insert(s.shifts).values({
        id: 701,
        branchId: 1,
        userId: 2,
        openingBalance: "25000.00",
        status: "OPEN",
        startedAt: new Date(),
      });

      const bonusRes = await createSpotBonus(ACTOR, {
        employeeId: emp!.id,
        amount: "100000", // Needs 100,000 but drawer only has 25,000
        reason: "مكافأة فورية استثنائية",
        disbursementType: "CASH_TREASURY",
      });
      await approveSpotBonus(APPROVER, bonusRes.id);

      // Attempt to pay from underfunded drawer
      await expect(
        paySpotBonusCash(APPROVER, {
          id: bonusRes.id,
          cashBucket: "DRAWER",
          shiftId: 701,
        }),
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
      });

      // Verify no money left drawer
      const expectedCash = await withTx((tx) =>
        computeExpectedCash(tx, 701, "25000.00"),
      );
      expect(Number(expectedCash)).toBe(25000);
    });

    it("GAP-03.3: Rejects paying spot bonus twice on second attempt", async () => {
      const d = db();
      const emp = await createEmployee({
        firstName: "سجاد",
        lastName: "الساعدي",
        branchId: 1,
        salary: "750000",
        payType: "monthly",
      });

      // Fund treasury with 500,000
      await d.insert(s.receipts).values({
        id: 7020,
        branchId: 1,
        cashBucket: "TREASURY",
        direction: "IN",
        amount: "500000.00",
        paymentMethod: "CASH",
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        approvedBy: 1,
        approvedAt: new Date(),
        createdBy: 1,
      });

      const bonusRes = await createSpotBonus(ACTOR, {
        employeeId: emp!.id,
        amount: "100000",
        reason: "مكافأة عمل إضافي متميز",
        disbursementType: "CASH_TREASURY",
      });
      await approveSpotBonus(APPROVER, bonusRes.id);

      // First payout succeeds
      const firstPay = await paySpotBonusCash(APPROVER, {
        id: bonusRes.id,
        cashBucket: "TREASURY",
      });
      expect(firstPay.status).toBe("PAID");
      expect(firstPay.receiptId).toBeDefined();

      // Second payout attempt must be rejected cleanly
      await expect(
        paySpotBonusCash(APPROVER, {
          id: bonusRes.id,
          cashBucket: "TREASURY",
        }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    });

    it("GAP-03.4: Spot bonus added to gross pay correctly raises the statutory absorbable wage limit", async () => {
      const d = db();
      // Employee base salary: 1,000,000 IQD
      const emp = await createEmployee({
        firstName: "علي",
        lastName: "الخفاجي",
        branchId: 1,
        salary: "1000000",
        allowances: "0",
        payType: "monthly",
      });

      // Add a disciplinary penalty of 150,000 IQD
      // Under Iraqi Labor Law Art. 57, penalty deduction is capped at 10% of absorbableWage.
      // Without spot bonus: absorbableWage = 1,000,000, max penalty = 100,000.
      // With spot bonus of 500,000: gross = 1,500,000, absorbableWage = 1,500,000, max penalty = 150,000!
      await d.insert(s.employeePenalties).values({
        employeeId: emp!.id,
        branchId: 1,
        penaltyType: "SALARY_DEDUCTION",
        decisionNumber: "PEN-2026-001",
        decisionDate: "2026-08-01",
        deductionDays: "1.00",
        deductionAmount: "150000.00",
        reason: "مخالفة انضباطية جسيمة",
        status: "APPROVED",
        createdById: 1,
        approvedById: 2,
      });

      // Add spot bonus of 500,000 IQD with PAYROLL_ADDITION
      await d.insert(s.employeeSpotBonuses).values({
        employeeId: emp!.id,
        branchId: 1,
        amount: "500000.00",
        reason: "مكافأة إنتاجية عالية",
        disbursementType: "PAYROLL_ADDITION",
        status: "APPROVED",
        createdById: 1,
        approvedById: 2,
        approvedAt: new Date(),
      });

      const run = await generatePayroll("2026-08", ACTOR);
      expect(run).toBeDefined();

      const [item] = await d
        .select()
        .from(s.payrollItems)
        .where(eq(s.payrollItems.employeeId, emp!.id));

      // Gross should be 1,000,000 + 500,000 = 1,500,000
      expect(Number(item.gross)).toBe(1500000);
      // Because absorbableWage is now 1,500,000, the 10% cap is 150,000, so full 150,000 penalty is absorbed!
      expect(Number(item.deductions)).toBe(150000);
      // Net is 1,500,000 - 150,000 = 1,350,000
      expect(Number(item.net)).toBe(1350000);
      expect(item.note).toContain("مكافأة فورية: 500000.00 د.ع");
    });
  });

  describe("GAP-04: Drawer vs. Treasury Payroll Settlement", () => {
    it("GAP-04.1: Rejects drawer payroll cash payment when shiftId is missing", async () => {
      const emp = await createEmployee({
        firstName: "مصطفى",
        lastName: "اللامي",
        branchId: 1,
        salary: "500000",
        allowances: "0",
        payType: "monthly",
      });

      const run = await generatePayroll("2026-08", ACTOR);
      await approveRun(run!.id, APPROVER);

      await expect(
        payRun(run!.id, APPROVER, {
          paymentMethod: "CASH",
          cashBucket: "DRAWER",
          // shiftId omitted
        }),
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
      });
    });

    it("GAP-04.2: Rejects drawer payroll cash payment when shift is CLOSED", async () => {
      const d = db();
      const emp = await createEmployee({
        firstName: "كرار",
        lastName: "الفرطوسي",
        branchId: 1,
        salary: "500000",
        allowances: "0",
        payType: "monthly",
      });

      await d.insert(s.shifts).values({
        id: 801,
        branchId: 1,
        userId: 2,
        status: "CLOSED",
        startedAt: new Date(),
        closedAt: new Date(),
      });

      const run = await generatePayroll("2026-08", ACTOR);
      await approveRun(run!.id, APPROVER);

      await expect(
        payRun(run!.id, APPROVER, {
          paymentMethod: "CASH",
          cashBucket: "DRAWER",
          shiftId: 801,
        }),
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
      });
    });

    it("GAP-04.3: Rejects drawer payroll cash payment when shift branch mismatches payroll branch", async () => {
      const d = db();
      // Employee in Branch 1
      const emp = await createEmployee({
        firstName: "عمر",
        lastName: "العبيدي",
        branchId: 1,
        salary: "500000",
        allowances: "0",
        payType: "monthly",
      });

      // Shift opened in Branch 2
      await d.insert(s.shifts).values({
        id: 802,
        branchId: 2,
        userId: 2,
        openingBalance: "1000000.00",
        status: "OPEN",
        startedAt: new Date(),
      });

      const run = await generatePayroll("2026-08", ACTOR);
      await approveRun(run!.id, APPROVER);

      await expect(
        payRun(run!.id, APPROVER, {
          paymentMethod: "CASH",
          cashBucket: "DRAWER",
          shiftId: 802,
        }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    });

    it("GAP-04.4: Rejects drawer payroll cash payment when drawer balance is insufficient", async () => {
      const d = db();
      const emp = await createEmployee({
        firstName: "سعد",
        lastName: "الزبيدي",
        branchId: 1,
        salary: "700000",
        allowances: "0",
        payType: "monthly",
      });

      // Open shift with only 200,000 IQD in drawer
      await d.insert(s.shifts).values({
        id: 803,
        branchId: 1,
        userId: 2,
        openingBalance: "200000.00",
        status: "OPEN",
        startedAt: new Date(),
      });

      const run = await generatePayroll("2026-08", ACTOR);
      await approveRun(run!.id, APPROVER);

      // Attempt payment of 700,000 from drawer that only has 200,000
      await expect(
        payRun(run!.id, APPROVER, {
          paymentMethod: "CASH",
          cashBucket: "DRAWER",
          shiftId: 803,
        }),
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
      });

      // Verify run remains approved and no receipt was created
      const storedRun = await getRun(run!.id);
      expect(storedRun?.status).toBe("approved");
      expect(storedRun?.paidAt).toBeNull();

      const outReceipts = await d
        .select()
        .from(s.receipts)
        .where(eq(s.receipts.direction, "OUT"));
      expect(outReceipts).toHaveLength(0);
    });

    it("GAP-04.5: Successful drawer payroll cash payment verifies receipts row and computeExpectedCash accurately reflects disbursement", async () => {
      const d = db();
      const emp = await createEmployee({
        firstName: "بسام",
        lastName: "المحمداوي",
        branchId: 1,
        salary: "600000",
        allowances: "0",
        payType: "monthly",
      });

      // Open shift in Branch 1 with 1,500,000 opening balance
      await d.insert(s.shifts).values({
        id: 804,
        branchId: 1,
        userId: 2,
        openingBalance: "1500000.00",
        status: "OPEN",
        startedAt: new Date(),
      });

      // Prior to disbursement: expected cash is exactly 1,500,000 IQD
      const expectedCashBefore = await withTx((tx) =>
        computeExpectedCash(tx, 804, "1500000.00"),
      );
      expect(Number(expectedCashBefore)).toBe(1500000);

      const run = await generatePayroll("2026-08", ACTOR);
      await approveRun(run!.id, APPROVER);

      const paid = await payRun(run!.id, APPROVER, {
        paymentMethod: "CASH",
        cashBucket: "DRAWER",
        shiftId: 804,
      });
      expect(paid?.status).toBe("paid");

      // Verify receipt created
      const [receipt] = await d
        .select()
        .from(s.receipts)
        .where(
          and(eq(s.receipts.shiftId, 804), eq(s.receipts.direction, "OUT")),
        );
      expect(receipt).toBeDefined();
      expect(receipt.cashBucket).toBe("DRAWER");
      expect(receipt.shiftId).toBe(804);
      expect(Number(receipt.amount)).toBe(600000);
      expect(receipt.paymentMethod).toBe("CASH");
      expect(receipt.status).toBe("COMPLETED");
      expect(receipt.approvalStatus).toBe("APPROVED");

      // Verify computeExpectedCash reflects the disbursement: 1,500,000 - 600,000 = 900,000 IQD!
      const expectedCashAfter = await withTx((tx) =>
        computeExpectedCash(tx, 804, "1500000.00"),
      );
      expect(Number(expectedCashAfter)).toBe(900000);
    });
  });
});
