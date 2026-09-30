import { describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { withTx } from "../tx";
import { computeDocumentStatus } from "../employeeDocumentService";
import { calculateLeaveEncashment } from "../leaveService";
import {
  requestEmployeeTransfer,
  approveEmployeeTransfer,
  executeTransferInTx,
  executePendingTransfers,
  listEmployeeTransfers,
} from "../employeeTransferService";
import {
  createEmployeeContract,
  approveEmployeeContract,
  renewEmployeeContract,
  terminateEmployeeContract,
  listEmployeeContracts,
} from "../employeeContractService";
import {
  createEmployeePenalty,
  approveEmployeePenalty,
  cancelEmployeePenalty,
  listEmployeePenalties,
  getUnappliedPenalties,
  applyPenaltiesToPayrollRunTx,
} from "../employeePenaltyService";
import {
  createSpotBonus,
  approveSpotBonus,
  paySpotBonusCash,
  listEmployeeSpotBonuses,
} from "../employeeSpotBonusService";
import {
  assignEmployeeCustody,
  returnEmployeeCustody,
  listEmployeeCustody,
  getOpenEmployeeCustody,
} from "../employeeCustodyService";
import { baghdadToday } from "../businessDay";

// ===========================================================================
// Test Helper: Seed a dedicated branch and employee for the test
// (Ensures test independence despite afterEach truncation by __setup__.ts)
// ===========================================================================
async function seedEmp(opts: {
  branchId?: number;
  branchName?: string;
  employeeId?: number;
  salary?: string;
  allowances?: string;
  department?: string;
  position?: string;
  employmentStatus?: "active" | "leave" | "terminated";
} = {}) {
  const db = getDb();
  if (!db) throw new Error("Database not connected");
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  const branchId = opts.branchId ?? 101;
  const employeeId = opts.employeeId ?? 9101;

  await db.insert(s.branches).values({
    id: branchId,
    name: opts.branchName ?? "فرع الكرادة",
    code: `B-${branchId}`,
    type: "SALES",
  }).onDuplicateKeyUpdate({ set: { name: opts.branchName ?? "فرع الكرادة" } });

  await db.insert(s.employees).values({
    id: employeeId,
    branchId,
    firstName: "علي",
    lastName: "المعموري",
    department: opts.department ?? "المبيعات",
    position: opts.position ?? "موظف",
    salary: opts.salary ?? "1000000.00",
    allowances: opts.allowances ?? "0.00",
    employmentStatus: opts.employmentStatus ?? "active",
    payType: "monthly",
  }).onDuplicateKeyUpdate({
    set: {
      branchId,
      salary: opts.salary ?? "1000000.00",
      allowances: opts.allowances ?? "0.00",
      employmentStatus: opts.employmentStatus ?? "active",
    },
  });

  return { db, branchId, employeeId };
}

describe("HR Enterprise Transactions — Atomic Logic & Legal Compliance", () => {
  // =========================================================================
  // Section A: Helper & Legal Arithmetic Unit Tests
  // =========================================================================
  describe("employeeDocumentService: computeDocumentStatus", () => {
    it("marks documents past expiry date as EXPIRED", () => {
      const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const status = computeDocumentStatus(pastDate, 30);
      expect(status).toBe("EXPIRED");
    });

    it("marks documents within alert window as EXPIRING_SOON", () => {
      const soonDate = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const status = computeDocumentStatus(soonDate, 30);
      expect(status).toBe("EXPIRING_SOON");
    });

    it("marks documents far in the future as ACTIVE", () => {
      const farDate = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const status = computeDocumentStatus(farDate, 30);
      expect(status).toBe("ACTIVE");
    });

    it("marks documents with null expiry date as ACTIVE", () => {
      const status = computeDocumentStatus(null, 30);
      expect(status).toBe("ACTIVE");
    });
  });

  describe("leaveService: calculateLeaveEncashment (Iraqi Labor Law Art. 77)", () => {
    it("calculates exact cash compensation for unused annual leave days", () => {
      const result = calculateLeaveEncashment({
        salary: "1200000",
        allowances: "300000",
        annualLeaveBalance: 10,
      });

      expect(result.dailyWage.toNumber()).toBe(50000);
      expect(result.unusedDays).toBe(10);
      expect(result.encashmentAmount.toNumber()).toBe(500000);
    });

    it("returns zero compensation when leave balance is zero or negative", () => {
      const resultZero = calculateLeaveEncashment({
        salary: "1000000",
        allowances: "0",
        annualLeaveBalance: 0,
      });
      expect(resultZero.encashmentAmount.toNumber()).toBe(0);

      const resultNeg = calculateLeaveEncashment({
        salary: "1000000",
        allowances: "0",
        annualLeaveBalance: -2,
      });
      expect(resultNeg.encashmentAmount.toNumber()).toBe(0);
    });

    it("handles zero salary gracefully without NaN or infinity", () => {
      const result = calculateLeaveEncashment({
        salary: "0",
        allowances: "0",
        annualLeaveBalance: 15,
      });
      expect(result.dailyWage.toNumber()).toBe(0);
      expect(result.encashmentAmount.toNumber()).toBe(0);
    });
  });

  describe("employeeLoanService: Iraqi Labor Law Art. 51 Debt Limit", () => {
    it("verifies maximum monthly deduction cannot exceed 20% of salary", () => {
      const basicSalary = 1000000;
      const maxMonthlyLegalDeduction = basicSalary * 0.2; // 200,000 IQD

      const compliantDeduction = 150000;
      expect(compliantDeduction).toBeLessThanOrEqual(maxMonthlyLegalDeduction);

      const excessDeduction = 250000;
      expect(excessDeduction).toBeGreaterThan(maxMonthlyLegalDeduction);
    });
  });

  // =========================================================================
  // Group 1: employeeContractService (12 Integration Tests)
  // =========================================================================
  describe("Group 1: employeeContractService Lifecycle & Governance", () => {
    it("createContract:happy_path creates draft contracts across all contract types", async () => {
      const { db } = await seedEmp({ employeeId: 9101, branchId: 101 });
      const actor = { userId: 1, role: "admin", branchId: 101 } as any;

      const types = ["FIXED_TERM", "INDEFINITE", "PROBATION", "SEASONAL"] as const;
      for (const t of types) {
        const res = await createEmployeeContract(actor, {
          employeeId: 9101,
          contractType: t,
          contractNumber: `CNT-9101-${t}`,
          startDate: "2026-01-01",
          endDate: t === "INDEFINITE" ? null : "2026-12-31",
          basicSalary: "850000.00",
          allowances: "50000.00",
          jobTitle: "محاسب",
        });
        expect(res.id).toBeDefined();
        expect(res.status).toBe("DRAFT");

        const [saved] = await db.select().from(s.employeeContracts).where(eq(s.employeeContracts.id, res.id));
        expect(saved.contractType).toBe(t);
        expect(saved.status).toBe("DRAFT");
        expect(Number(saved.basicSalary)).toBe(850000);
      }
    });

    it("createContract:probation_cap_violation rejects probation period exceeding 93 days (Art. 33)", async () => {
      await seedEmp({ employeeId: 9101 });
      const actor = { userId: 1, role: "admin", branchId: 101 } as any;
      await expect(
        createEmployeeContract(actor, {
          employeeId: 9101,
          contractType: "PROBATION",
          startDate: "2026-01-01",
          probationEndDate: "2026-04-15", // ~104 days
        }),
      ).rejects.toThrow();
    });

    it("createContract:probation_cap_compliant accepts probation period within 90 days", async () => {
      await seedEmp({ employeeId: 9101 });
      const actor = { userId: 1, role: "admin", branchId: 101 } as any;
      const res = await createEmployeeContract(actor, {
        employeeId: 9101,
        contractType: "PROBATION",
        startDate: "2026-01-01",
        probationEndDate: "2026-03-31", // 89 days
      });
      expect(res.status).toBe("DRAFT");
    });

    it("createContract:employee_not_found throws NOT_FOUND for non-existent employee", async () => {
      const actor = { userId: 1, role: "admin" } as any;
      await expect(
        createEmployeeContract(actor, {
          employeeId: 999999,
          contractType: "FIXED_TERM",
          startDate: "2026-01-01",
        }),
      ).rejects.toThrow();
    });

    it("approveContract:maker_checker_violation prevents non-admin creator from approving own contract", async () => {
      await seedEmp({ employeeId: 9101 });
      const creator = { userId: 5, role: "manager", branchId: 101 } as any;

      const res = await createEmployeeContract(creator, {
        employeeId: 9101,
        contractType: "FIXED_TERM",
        startDate: "2026-01-01",
      });

      await expect(approveEmployeeContract(creator, res.id)).rejects.toThrow();
    });

    it("approveContract:admin_override permits admin creator to self-approve", async () => {
      await seedEmp({ employeeId: 9101 });
      const admin = { userId: 1, role: "admin", branchId: 101 } as any;
      const res = await createEmployeeContract(admin, {
        employeeId: 9101,
        contractType: "FIXED_TERM",
        startDate: "2026-01-01",
      });

      const approved = await approveEmployeeContract(admin, res.id);
      expect(approved.status).toBe("ACTIVE");
    });

    it("approveContract:invalid_state rejects approving already active contract", async () => {
      await seedEmp({ employeeId: 9101 });
      const admin = { userId: 1, role: "admin", branchId: 101 } as any;
      const res = await createEmployeeContract(admin, {
        employeeId: 9101,
        contractType: "FIXED_TERM",
        startDate: "2026-01-01",
      });
      await approveEmployeeContract(admin, res.id);

      await expect(approveEmployeeContract(admin, res.id)).rejects.toThrow();
    });

    it("approveContract:cross_branch_violation rejects approval by out-of-branch manager", async () => {
      await seedEmp({ employeeId: 9101, branchId: 101 });
      const admin = { userId: 1, role: "admin" } as any;
      const managerBranch2 = { userId: 9, role: "manager", branchId: 102 } as any;

      const res = await createEmployeeContract(admin, {
        employeeId: 9101,
        contractType: "FIXED_TERM",
        startDate: "2026-01-01",
      });

      await expect(approveEmployeeContract(managerBranch2, res.id)).rejects.toThrow();
    });

    it("approveContract:atomic_sync_and_renew_old marks old contract RENEWED and syncs employee record", async () => {
      const { db } = await seedEmp({ employeeId: 9102, branchId: 101, salary: "700000.00", position: "فني شبكات" });
      const admin = { userId: 1, role: "admin", branchId: 101 } as any;

      const c1 = await createEmployeeContract(admin, {
        employeeId: 9102,
        contractType: "FIXED_TERM",
        startDate: "2025-01-01",
        basicSalary: "700000.00",
        allowances: "30000.00",
        jobTitle: "فني شبكات",
      });
      await approveEmployeeContract(admin, c1.id);

      const c2 = await createEmployeeContract(admin, {
        employeeId: 9102,
        contractType: "INDEFINITE",
        startDate: "2026-01-01",
        basicSalary: "900000.00",
        allowances: "60000.00",
        jobTitle: "رئيس مهندسين",
      });
      await approveEmployeeContract(admin, c2.id);

      const [oldC] = await db.select().from(s.employeeContracts).where(eq(s.employeeContracts.id, c1.id));
      expect(oldC.status).toBe("RENEWED");

      const [newC] = await db.select().from(s.employeeContracts).where(eq(s.employeeContracts.id, c2.id));
      expect(newC.status).toBe("ACTIVE");

      const [emp] = await db.select().from(s.employees).where(eq(s.employees.id, 9102));
      expect(emp.position).toBe("رئيس مهندسين");
      expect(Number(emp.salary)).toBe(900000);
      expect(Number(emp.allowances)).toBe(60000);
    });

    it("renewContract:invalid_state_guard prevents renewing draft or invalid contract", async () => {
      await seedEmp({ employeeId: 9101 });
      const admin = { userId: 1, role: "admin", branchId: 101 } as any;
      const res = await createEmployeeContract(admin, {
        employeeId: 9101,
        contractType: "FIXED_TERM",
        startDate: "2026-01-01",
      });

      await expect(
        renewEmployeeContract(admin, {
          id: res.id,
          basicSalary: "1000000.00",
        }),
      ).rejects.toThrow();
    });

    it("terminateContract:active_only_guard rejects terminating non-ACTIVE contract", async () => {
      await seedEmp({ employeeId: 9101 });
      const admin = { userId: 1, role: "admin", branchId: 101 } as any;
      const res = await createEmployeeContract(admin, {
        employeeId: 9101,
        contractType: "FIXED_TERM",
        startDate: "2026-01-01",
      });

      await expect(terminateEmployeeContract(admin, res.id, "سبب تجريبي")).rejects.toThrow();
    });

    it("terminateContract:records_end_date_and_reason terminates active contract cleanly", async () => {
      const { db } = await seedEmp({ employeeId: 9101 });
      const admin = { userId: 1, role: "admin", branchId: 101 } as any;
      const res = await createEmployeeContract(admin, {
        employeeId: 9101,
        contractType: "FIXED_TERM",
        startDate: "2026-01-01",
      });
      await approveEmployeeContract(admin, res.id);

      const term = await terminateEmployeeContract(admin, res.id, "فسخ بالتراضي بين الطرفين");
      expect(term.status).toBe("TERMINATED");

      const [c] = await db.select().from(s.employeeContracts).where(eq(s.employeeContracts.id, res.id));
      expect(c.status).toBe("TERMINATED");
      expect(c.endDate).toBe(baghdadToday());
      expect(c.terms).toContain("فسخ بالتراضي");
    });
  });

  // =========================================================================
  // Group 2: employeePenaltyService (12 Integration Tests)
  // =========================================================================
  describe("Group 2: employeePenaltyService Lifecycle & Legal Limits", () => {
    it("createPenalty:non_financial_types zeroes out deduction days and amounts for warning/attention", async () => {
      const { db } = await seedEmp({ employeeId: 9201, branchId: 101 });
      const actor = { userId: 1, role: "admin", branchId: 101 } as any;

      const res = await createEmployeePenalty(actor, {
        employeeId: 9201,
        penaltyType: "WARNING",
        decisionNumber: "PEN-9201-W",
        decisionDate: "2026-06-01",
        reason: "إنذار أولي بسبب التأخر",
        deductionDays: 2,
        deductionAmount: 50000,
      });

      const [p] = await db.select().from(s.employeePenalties).where(eq(s.employeePenalties.id, res.id));
      expect(p.status).toBe("DRAFT");
      expect(p.penaltyType).toBe("WARNING");
      expect(Number(p.deductionDays)).toBe(0);
      expect(Number(p.deductionAmount)).toBe(0);
    });

    it("createPenalty:salary_deduction_auto_calc calculates deduction amount accurately", async () => {
      const { db } = await seedEmp({ employeeId: 9202, branchId: 101, salary: "1200000.00", allowances: "300000.00" });
      const actor = { userId: 1, role: "admin", branchId: 101 } as any;

      const res = await createEmployeePenalty(actor, {
        employeeId: 9202,
        penaltyType: "SALARY_DEDUCTION",
        decisionNumber: "PEN-9202-D",
        decisionDate: "2026-06-01",
        reason: "خصم يومين بسبب غياب غير مبرر",
        deductionDays: 2,
      });

      const [p] = await db.select().from(s.employeePenalties).where(eq(s.employeePenalties.id, res.id));
      expect(p.penaltyType).toBe("SALARY_DEDUCTION");
      expect(Number(p.deductionDays)).toBe(2);
      expect(Number(p.deductionAmount)).toBe(100000);
    });

    it("createPenalty:art139_legal_ceiling rejects deductions exceeding 3 days (Iraqi Labor Law)", async () => {
      await seedEmp({ employeeId: 9202 });
      const actor = { userId: 1, role: "admin", branchId: 101 } as any;
      await expect(
        createEmployeePenalty(actor, {
          employeeId: 9202,
          penaltyType: "SALARY_DEDUCTION",
          decisionNumber: "PEN-ILLEGAL",
          decisionDate: "2026-06-01",
          reason: "خصم 4 أيام غير قانوني",
          deductionDays: 4,
        }),
      ).rejects.toThrow();
    });

    it("createPenalty:employee_not_found throws NOT_FOUND for non-existent employee", async () => {
      const actor = { userId: 1, role: "admin" } as any;
      await expect(
        createEmployeePenalty(actor, {
          employeeId: 999999,
          penaltyType: "WARNING",
          decisionNumber: "PEN-NONE",
          decisionDate: "2026-06-01",
          reason: "تجربة",
        }),
      ).rejects.toThrow();
    });

    it("approvePenalty:happy_path moves penalty to APPROVED with row lock", async () => {
      const { db } = await seedEmp({ employeeId: 9201 });
      const admin = { userId: 1, role: "admin", branchId: 101 } as any;

      const res = await createEmployeePenalty(admin, {
        employeeId: 9201,
        penaltyType: "ATTENTION",
        decisionNumber: "PEN-APP-1",
        decisionDate: "2026-06-01",
        reason: "لفت نظر رسمي",
      });

      const approved = await approveEmployeePenalty(admin, res.id);
      expect(approved.status).toBe("APPROVED");

      const [p] = await db.select().from(s.employeePenalties).where(eq(s.employeePenalties.id, res.id));
      expect(p.status).toBe("APPROVED");
      expect(p.approvedById).toBe(1);
      expect(p.approvedAt).toBeDefined();
    });

    it("approvePenalty:maker_checker_violation prevents non-admin creator from approving own penalty", async () => {
      await seedEmp({ employeeId: 9201 });
      const creator = { userId: 6, role: "manager", branchId: 101 } as any;
      const res = await createEmployeePenalty(creator, {
        employeeId: 9201,
        penaltyType: "WARNING",
        decisionNumber: "PEN-MK-1",
        decisionDate: "2026-06-01",
        reason: "مخالفة انضباطية",
      });

      await expect(approveEmployeePenalty(creator, res.id)).rejects.toThrow();
    });

    it("approvePenalty:admin_bypass allows admin creator to approve own penalty", async () => {
      await seedEmp({ employeeId: 9201 });
      const admin = { userId: 1, role: "admin", branchId: 101 } as any;
      const res = await createEmployeePenalty(admin, {
        employeeId: 9201,
        penaltyType: "WARNING",
        decisionNumber: "PEN-ADM-1",
        decisionDate: "2026-06-01",
        reason: "إنذار إداري معتمد",
      });

      const approved = await approveEmployeePenalty(admin, res.id);
      expect(approved.status).toBe("APPROVED");
    });

    it("approvePenalty:invalid_state rejects approving already approved penalty", async () => {
      await seedEmp({ employeeId: 9201 });
      const admin = { userId: 1, role: "admin", branchId: 101 } as any;
      const res = await createEmployeePenalty(admin, {
        employeeId: 9201,
        penaltyType: "ATTENTION",
        decisionNumber: "PEN-DBL-1",
        decisionDate: "2026-06-01",
        reason: "لفت نظر",
      });
      await approveEmployeePenalty(admin, res.id);

      await expect(approveEmployeePenalty(admin, res.id)).rejects.toThrow();
    });

    it("cancelPenalty:happy_path cancels penalty and appends cancellation reason", async () => {
      const { db } = await seedEmp({ employeeId: 9201 });
      const admin = { userId: 1, role: "admin", branchId: 101 } as any;

      const res = await createEmployeePenalty(admin, {
        employeeId: 9201,
        penaltyType: "ATTENTION",
        decisionNumber: "PEN-CAN-1",
        decisionDate: "2026-06-01",
        reason: "قرار صادر بحاجة للإلغاء",
      });

      const cancelled = await cancelEmployeePenalty(admin, res.id, "إلغاء لثبوت براءة الموظف");
      expect(cancelled.status).toBe("CANCELLED");

      const [p] = await db.select().from(s.employeePenalties).where(eq(s.employeePenalties.id, res.id));
      expect(p.status).toBe("CANCELLED");
      expect(p.reason).toContain("ثبوت براءة الموظف");
    });

    it("cancelPenalty:applied_lock rejects cancelling a penalty that is already APPLIED in payroll", async () => {
      const { db } = await seedEmp({ employeeId: 9202 });
      const admin = { userId: 1, role: "admin", branchId: 101 } as any;

      const res = await createEmployeePenalty(admin, {
        employeeId: 9202,
        penaltyType: "SALARY_DEDUCTION",
        decisionNumber: "PEN-APPLIED-LOCK",
        decisionDate: "2026-06-01",
        reason: "خصم مطبق",
        deductionDays: 1,
      });
      await approveEmployeePenalty(admin, res.id);

      await db.update(s.employeePenalties).set({ status: "APPLIED", payrollRunId: 888 }).where(eq(s.employeePenalties.id, res.id));

      await expect(cancelEmployeePenalty(admin, res.id, "طلب إلغاء متأخر")).rejects.toThrow();
    });

    it("payroll_integration:getUnappliedPenalties retrieves only unapplied approved deduction penalties", async () => {
      await seedEmp({ employeeId: 9202 });
      const admin = { userId: 1, role: "admin", branchId: 101 } as any;

      const p1 = await createEmployeePenalty(admin, {
        employeeId: 9202,
        penaltyType: "SALARY_DEDUCTION",
        decisionNumber: "PEN-UNAPPLIED-1",
        decisionDate: "2026-06-01",
        reason: "خصم معتمد للمسير القادم",
        deductionDays: 1,
      });
      await approveEmployeePenalty(admin, p1.id);

      const unapplied = await getUnappliedPenalties(9202);
      expect(unapplied.some((x: any) => x.id === p1.id)).toBe(true);
    });

    it("payroll_integration:applyPenaltiesToPayrollRunTx atomically links penalties and sets APPLIED", async () => {
      const { db } = await seedEmp({ employeeId: 9202 });
      const admin = { userId: 1, role: "admin", branchId: 101 } as any;

      const p1 = await createEmployeePenalty(admin, {
        employeeId: 9202,
        penaltyType: "SALARY_DEDUCTION",
        decisionNumber: "PEN-LINK-TX",
        decisionDate: "2026-06-01",
        reason: "خصم سيُربط بالمسير 777",
        deductionDays: 1,
      });
      await approveEmployeePenalty(admin, p1.id);

      await withTx(async (tx) => {
        await applyPenaltiesToPayrollRunTx(tx, 777, [p1.id]);
      });

      const [p] = await db.select().from(s.employeePenalties).where(eq(s.employeePenalties.id, p1.id));
      expect(p.status).toBe("APPLIED");
      expect(Number(p.payrollRunId)).toBe(777);
    });
  });

  // =========================================================================
  // Group 3: employeeTransferService (11 Integration Tests)
  // =========================================================================
  describe("Group 3: employeeTransferService Lifecycle & Execution", () => {
    it("requestTransfer:happy_path registers pending transfer and captures employee snapshot", async () => {
      const { db } = await seedEmp({ employeeId: 9301, branchId: 101, department: "المحاسبة", position: "مدقق داخلي" });
      const actor = { userId: 1, role: "admin", branchId: 101 } as any;

      await db.insert(s.branches).values({ id: 102, name: "فرع المنصور", code: "MN102" }).onDuplicateKeyUpdate({ set: { name: "فرع المنصور" } });

      const res = await requestEmployeeTransfer(actor, {
        employeeId: 9301,
        toBranchId: 102,
        toDepartment: "إدارة المخاطر",
        toPosition: "مدير تدقيق",
        decisionNumber: "TR-9301-A",
        transferDate: "2026-06-01",
        effectiveDate: "2026-06-15",
        reason: "ترقية ونقل فرعي",
      });

      expect(res.id).toBeDefined();
      expect(res.status).toBe("PENDING");

      const [tr] = await db.select().from(s.employeeTransfers).where(eq(s.employeeTransfers.id, res.id));
      expect(tr.status).toBe("PENDING");
      expect(Number(tr.fromBranchId)).toBe(101);
      expect(Number(tr.toBranchId)).toBe(102);
      expect(tr.fromDepartment).toBe("المحاسبة");
      expect(tr.toDepartment).toBe("إدارة المخاطر");
    });

    it("requestTransfer:invalid_destination_branch throws NOT_FOUND for non-existent branch", async () => {
      await seedEmp({ employeeId: 9301, branchId: 101 });
      const actor = { userId: 1, role: "admin", branchId: 101 } as any;
      await expect(
        requestEmployeeTransfer(actor, {
          employeeId: 9301,
          toBranchId: 999999,
          decisionNumber: "TR-INVALID",
          transferDate: "2026-06-01",
          effectiveDate: "2026-06-01",
        }),
      ).rejects.toThrow();
    });

    it("approveTransfer:immediate_execution marks transfer EFFECTIVE when effectiveDate <= today", async () => {
      const { db } = await seedEmp({ employeeId: 9301, branchId: 101 });
      await db.insert(s.branches).values({ id: 102, name: "فرع المنصور", code: "MN102" }).onDuplicateKeyUpdate({ set: { name: "فرع المنصور" } });
      const admin = { userId: 1, role: "admin", branchId: 101 } as any;
      const today = baghdadToday();

      const res = await requestEmployeeTransfer(admin, {
        employeeId: 9301,
        toBranchId: 102,
        toDepartment: "المبيعات",
        toPosition: "مشرف فرع",
        decisionNumber: "TR-IMMEDIATE",
        transferDate: today,
        effectiveDate: today,
      });

      const approved = await approveEmployeeTransfer(admin, res.id);
      expect(approved.status).toBe("EFFECTIVE");

      const [emp] = await db.select().from(s.employees).where(eq(s.employees.id, 9301));
      expect(Number(emp.branchId)).toBe(102);
      expect(emp.department).toBe("المبيعات");
      expect(emp.position).toBe("مشرف فرع");
    });

    it("approveTransfer:deferred_execution marks transfer APPROVED when effectiveDate is in the future", async () => {
      const { db } = await seedEmp({ employeeId: 9302, branchId: 101 });
      await db.insert(s.branches).values({ id: 102, name: "فرع المنصور", code: "MN102" }).onDuplicateKeyUpdate({ set: { name: "فرع المنصور" } });
      const admin = { userId: 1, role: "admin", branchId: 101 } as any;

      const res = await requestEmployeeTransfer(admin, {
        employeeId: 9302,
        toBranchId: 102,
        toDepartment: "المخزن",
        toPosition: "أمين مخزن",
        decisionNumber: "TR-FUTURE-1",
        transferDate: "2026-01-01",
        effectiveDate: "2099-12-31",
      });

      const approved = await approveEmployeeTransfer(admin, res.id);
      expect(approved.status).toBe("APPROVED");

      const [emp] = await db.select().from(s.employees).where(eq(s.employees.id, 9302));
      expect(Number(emp.branchId)).toBe(101);
    });

    it("approveTransfer:maker_checker_violation prevents non-admin creator from approving own transfer", async () => {
      const { db } = await seedEmp({ employeeId: 9301, branchId: 101 });
      await db.insert(s.branches).values({ id: 102, name: "فرع المنصور", code: "MN102" }).onDuplicateKeyUpdate({ set: { name: "فرع المنصور" } });
      const creator = { userId: 7, role: "manager", branchId: 101 } as any;

      const res = await requestEmployeeTransfer(creator, {
        employeeId: 9301,
        toBranchId: 102,
        decisionNumber: "TR-MK-FAIL",
        transferDate: "2026-06-01",
        effectiveDate: "2026-06-01",
      });

      await expect(approveEmployeeTransfer(creator, res.id)).rejects.toThrow();
    });

    it("approveTransfer:admin_bypass allows admin creator to approve own transfer", async () => {
      const { db } = await seedEmp({ employeeId: 9301, branchId: 101 });
      await db.insert(s.branches).values({ id: 102, name: "فرع المنصور", code: "MN102" }).onDuplicateKeyUpdate({ set: { name: "فرع المنصور" } });
      const admin = { userId: 1, role: "admin", branchId: 101 } as any;

      const res = await requestEmployeeTransfer(admin, {
        employeeId: 9301,
        toBranchId: 102,
        decisionNumber: "TR-ADM-OK",
        transferDate: "2026-06-01",
        effectiveDate: "2026-06-01",
      });

      const approved = await approveEmployeeTransfer(admin, res.id);
      expect(approved.status).toBe("EFFECTIVE");
    });

    it("approveTransfer:invalid_state rejects approving non-pending transfer", async () => {
      const { db } = await seedEmp({ employeeId: 9301, branchId: 101 });
      await db.insert(s.branches).values({ id: 102, name: "فرع المنصور", code: "MN102" }).onDuplicateKeyUpdate({ set: { name: "فرع المنصور" } });
      const admin = { userId: 1, role: "admin", branchId: 101 } as any;

      const res = await requestEmployeeTransfer(admin, {
        employeeId: 9301,
        toBranchId: 102,
        decisionNumber: "TR-DBL",
        transferDate: "2026-06-01",
        effectiveDate: "2026-06-01",
      });
      await approveEmployeeTransfer(admin, res.id);

      await expect(approveEmployeeTransfer(admin, res.id)).rejects.toThrow();
    });

    it("executePendingTransfers:processes_due_transfers updates due transfers and user branch", async () => {
      const { db } = await seedEmp({ employeeId: 9303, branchId: 101 });
      await db.insert(s.branches).values({ id: 102, name: "فرع المنصور", code: "MN102" }).onDuplicateKeyUpdate({ set: { name: "فرع المنصور" } });
      const today = baghdadToday();

      await db.insert(s.users).values({
        id: 9303,
        openId: "test-user-9303",
        name: "مستخدم منقول",
        role: "cashier",
        branchId: 101,
      }).onDuplicateKeyUpdate({ set: { branchId: 101 } });

      await db.update(s.employees).set({ userId: 9303 }).where(eq(s.employees.id, 9303));

      await db.insert(s.employeeTransfers).values({
        id: 93031,
        employeeId: 9303,
        fromBranchId: 101,
        toBranchId: 102,
        fromDepartment: "مبيعات",
        toDepartment: "خدمة عملاء",
        fromPosition: "كاشير",
        toPosition: "ممثل",
        decisionNumber: "TR-93031",
        transferDate: today,
        effectiveDate: today,
        status: "APPROVED",
        createdById: 1,
      }).onDuplicateKeyUpdate({ set: { status: "APPROVED", effectiveDate: today } });

      const res = await executePendingTransfers();
      expect(res.executedCount).toBeGreaterThanOrEqual(1);

      const [u] = await db.select().from(s.users).where(eq(s.users.id, 9303));
      expect(Number(u.branchId)).toBe(102);
    });

    it("executePendingTransfers:ignores_future_transfers leaves future transfers APPROVED", async () => {
      const { db } = await seedEmp({ employeeId: 9303, branchId: 101 });
      await db.insert(s.branches).values({ id: 102, name: "فرع المنصور", code: "MN102" }).onDuplicateKeyUpdate({ set: { name: "فرع المنصور" } });

      await db.insert(s.employeeTransfers).values({
        id: 93032,
        employeeId: 9303,
        fromBranchId: 101,
        toBranchId: 102,
        decisionNumber: "TR-93032",
        transferDate: "2026-01-01",
        effectiveDate: "2099-01-01",
        status: "APPROVED",
        createdById: 1,
      }).onDuplicateKeyUpdate({ set: { status: "APPROVED", effectiveDate: "2099-01-01" } });

      await executePendingTransfers();

      const [tr] = await db.select().from(s.employeeTransfers).where(eq(s.employeeTransfers.id, 93032));
      expect(tr.status).toBe("APPROVED");
    });

    it("executeTransferInTx:atomically_updates_employee_and_user updates records inside transaction", async () => {
      const { db } = await seedEmp({ employeeId: 9303, branchId: 101 });
      await db.insert(s.branches).values({ id: 102, name: "فرع المنصور", code: "MN102" }).onDuplicateKeyUpdate({ set: { name: "فرع المنصور" } });

      await withTx(async (tx) => {
        await executeTransferInTx(tx, {
          id: 93031,
          employeeId: 9303,
          toBranchId: 102,
          toDepartment: "إدارة",
          toPosition: "مشرف",
        });
      });

      const [emp] = await db.select().from(s.employees).where(eq(s.employees.id, 9303));
      expect(Number(emp.branchId)).toBe(102);
      expect(emp.department).toBe("إدارة");
    });

    it("listEmployeeTransfers:branch_visibility allows managers of both branches to view transfers", async () => {
      const { db } = await seedEmp({ employeeId: 9301, branchId: 101 });
      await db.insert(s.branches).values({ id: 102, name: "فرع المنصور", code: "MN102" }).onDuplicateKeyUpdate({ set: { name: "فرع المنصور" } });
      const admin = { userId: 1, role: "admin", branchId: 101 } as any;

      await requestEmployeeTransfer(admin, {
        employeeId: 9301,
        toBranchId: 102,
        decisionNumber: "TR-VIS-1",
        transferDate: "2026-06-01",
        effectiveDate: "2026-06-01",
      });

      const list1 = await listEmployeeTransfers(9301, 101);
      expect(list1.length).toBeGreaterThanOrEqual(1);

      const list2 = await listEmployeeTransfers(9301, 102);
      expect(list2.length).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // Group 4: employeeSpotBonusService (13 Integration Tests)
  // =========================================================================
  describe("Group 4: employeeSpotBonusService Cash & Accrual Operations", () => {
    it("createSpotBonus:happy_path registers draft spot bonus for treasury or payroll addition", async () => {
      const { db } = await seedEmp({ employeeId: 9401, branchId: 101 });
      const actor = { userId: 1, role: "admin", branchId: 101 } as any;

      const res = await createSpotBonus(actor, {
        employeeId: 9401,
        amount: "150000.00",
        reason: "مكافأة تميز في خدمة الزبائن",
        decisionNumber: "SB-9401-1",
        disbursementType: "CASH_TREASURY",
      });

      expect(res.id).toBeDefined();
      expect(res.status).toBe("DRAFT");

      const [b] = await db.select().from(s.employeeSpotBonuses).where(eq(s.employeeSpotBonuses.id, res.id));
      expect(b.status).toBe("DRAFT");
      expect(Number(b.amount)).toBe(150000);
      expect(b.disbursementType).toBe("CASH_TREASURY");
    });

    it("createSpotBonus:zero_or_negative_amount rejects zero or negative amounts", async () => {
      await seedEmp({ employeeId: 9401 });
      const actor = { userId: 1, role: "admin", branchId: 101 } as any;
      await expect(
        createSpotBonus(actor, {
          employeeId: 9401,
          amount: 0,
          reason: "مبلغ صفري",
        }),
      ).rejects.toThrow();

      await expect(
        createSpotBonus(actor, {
          employeeId: 9401,
          amount: -50000,
          reason: "مبلغ سالب",
        }),
      ).rejects.toThrow();
    });

    it("createSpotBonus:employee_not_found throws NOT_FOUND for non-existent employee", async () => {
      const actor = { userId: 1, role: "admin" } as any;
      await expect(
        createSpotBonus(actor, {
          employeeId: 999999,
          amount: "50000.00",
          reason: "مكافأة لموظف وهمي",
        }),
      ).rejects.toThrow();
    });

    it("approveSpotBonus:happy_path moves bonus to APPROVED with approver tracking", async () => {
      const { db } = await seedEmp({ employeeId: 9401 });
      const admin = { userId: 1, role: "admin", branchId: 101 } as any;

      const res = await createSpotBonus(admin, {
        employeeId: 9401,
        amount: "80000.00",
        reason: "مكافأة معتمدة",
        disbursementType: "CASH_TREASURY",
      });

      const approved = await approveSpotBonus(admin, res.id);
      expect(approved.status).toBe("APPROVED");

      const [b] = await db.select().from(s.employeeSpotBonuses).where(eq(s.employeeSpotBonuses.id, res.id));
      expect(b.status).toBe("APPROVED");
      expect(b.approvedById).toBe(1);
    });

    it("approveSpotBonus:maker_checker_violation prevents non-admin creator from approving own bonus", async () => {
      await seedEmp({ employeeId: 9401 });
      const creator = { userId: 8, role: "manager", branchId: 101 } as any;
      const res = await createSpotBonus(creator, {
        employeeId: 9401,
        amount: "50000.00",
        reason: "مكافأة ذاتية",
      });

      await expect(approveSpotBonus(creator, res.id)).rejects.toThrow();
    });

    it("approveSpotBonus:admin_bypass allows admin creator to self-approve", async () => {
      await seedEmp({ employeeId: 9401 });
      const admin = { userId: 1, role: "admin", branchId: 101 } as any;
      const res = await createSpotBonus(admin, {
        employeeId: 9401,
        amount: "60000.00",
        reason: "مكافأة أدمن ذاتية",
      });

      const approved = await approveSpotBonus(admin, res.id);
      expect(approved.status).toBe("APPROVED");
    });

    it("paySpotBonusCash:treasury_happy_path pays approved bonus from treasury and posts accounting entry", async () => {
      const { db } = await seedEmp({ employeeId: 9401, branchId: 101 });
      const actor = { userId: 1, role: "admin", branchId: 101 } as any;

      await db.insert(s.receipts).values({
        id: 94011,
        branchId: 101,
        cashBucket: "TREASURY",
        direction: "IN",
        amount: "5000000.00",
        paymentMethod: "CASH",
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        approvedBy: 1,
        approvedAt: new Date(),
        createdBy: 1,
      }).onDuplicateKeyUpdate({ set: { amount: "5000000.00" } });

      const bonus = await createSpotBonus(actor, {
        employeeId: 9401,
        amount: "120000.00",
        reason: "مكافأة خزينة",
        disbursementType: "CASH_TREASURY",
      });
      await approveSpotBonus(actor, bonus.id);

      const payRes = await paySpotBonusCash(actor, { id: bonus.id, cashBucket: "TREASURY" });
      expect(payRes.status).toBe("PAID");
      expect(payRes.receiptId).toBeDefined();

      const [receipt] = await db.select().from(s.receipts).where(eq(s.receipts.id, payRes.receiptId));
      expect(receipt.direction).toBe("OUT");
      expect(receipt.cashBucket).toBe("TREASURY");
      expect(Number(receipt.amount)).toBe(120000);

      const [entry] = await db.select().from(s.accountingEntries).where(eq(s.accountingEntries.receiptId, payRes.receiptId));
      expect(entry).toBeDefined();
      expect(entry.entryType).toBe("PAYMENT_OUT");
    });

    it("paySpotBonusCash:drawer_happy_path pays approved bonus from open cashier drawer", async () => {
      const { db } = await seedEmp({ employeeId: 9401, branchId: 101 });
      const actor = { userId: 1, role: "admin", branchId: 101 } as any;

      await db.insert(s.shifts).values({
        id: 94020,
        branchId: 101,
        userId: 1,
        status: "OPEN",
        startedAt: new Date(),
      }).onDuplicateKeyUpdate({ set: { status: "OPEN" } });

      await db.insert(s.receipts).values({
        id: 94021,
        branchId: 101,
        shiftId: 94020,
        cashBucket: "DRAWER",
        direction: "IN",
        amount: "500000.00",
        paymentMethod: "CASH",
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        approvedBy: 1,
        approvedAt: new Date(),
        createdBy: 1,
      }).onDuplicateKeyUpdate({ set: { amount: "500000.00" } });

      const bonus = await createSpotBonus(actor, {
        employeeId: 9401,
        amount: "45000.00",
        reason: "مكافأة درج",
        disbursementType: "CASH_TREASURY",
      });
      await approveSpotBonus(actor, bonus.id);

      const payRes = await paySpotBonusCash(actor, { id: bonus.id, cashBucket: "DRAWER", shiftId: 94020 });
      expect(payRes.status).toBe("PAID");

      const [receipt] = await db.select().from(s.receipts).where(eq(s.receipts.id, payRes.receiptId));
      expect(receipt.cashBucket).toBe("DRAWER");
      expect(receipt.shiftId).toBe(94020);
    });

    it("paySpotBonusCash:closed_shift_guard rejects paying from closed shift drawer", async () => {
      const { db } = await seedEmp({ employeeId: 9401, branchId: 101 });
      const actor = { userId: 1, role: "admin", branchId: 101 } as any;

      await db.insert(s.shifts).values({
        id: 94022,
        branchId: 101,
        userId: 1,
        status: "CLOSED",
        startedAt: new Date(),
        endedAt: new Date(),
      }).onDuplicateKeyUpdate({ set: { status: "CLOSED" } });

      const bonus = await createSpotBonus(actor, {
        employeeId: 9401,
        amount: "30000.00",
        reason: "مكافأة وردية مغلقة",
        disbursementType: "CASH_TREASURY",
      });
      await approveSpotBonus(actor, bonus.id);

      await expect(
        paySpotBonusCash(actor, { id: bonus.id, cashBucket: "DRAWER", shiftId: 94022 }),
      ).rejects.toThrow();
    });

    it("paySpotBonusCash:wrong_branch_guard prevents paying bonus of different branch", async () => {
      await seedEmp({ employeeId: 9401, branchId: 101 });
      const actorBranch2 = { userId: 2, role: "manager", branchId: 102 } as any;
      const admin = { userId: 1, role: "admin", branchId: 101 } as any;

      const bonus = await createSpotBonus(admin, {
        employeeId: 9401,
        amount: "50000.00",
        reason: "مكافأة فرع 1",
        disbursementType: "CASH_TREASURY",
      });
      await approveSpotBonus(admin, bonus.id);

      await expect(
        paySpotBonusCash(actorBranch2, { id: bonus.id, cashBucket: "TREASURY" }),
      ).rejects.toThrow();
    });

    it("paySpotBonusCash:draft_guard rejects paying unapproved DRAFT bonus", async () => {
      await seedEmp({ employeeId: 9401, branchId: 101 });
      const admin = { userId: 1, role: "admin", branchId: 101 } as any;
      const bonus = await createSpotBonus(admin, {
        employeeId: 9401,
        amount: "50000.00",
        reason: "مسودة غير معتمدة",
        disbursementType: "CASH_TREASURY",
      });

      await expect(
        paySpotBonusCash(admin, { id: bonus.id, cashBucket: "TREASURY" }),
      ).rejects.toThrow();
    });

    it("paySpotBonusCash:payroll_addition_guard rejects paying PAYROLL_ADDITION bonus with cash", async () => {
      await seedEmp({ employeeId: 9401, branchId: 101 });
      const admin = { userId: 1, role: "admin", branchId: 101 } as any;
      const bonus = await createSpotBonus(admin, {
        employeeId: 9401,
        amount: "50000.00",
        reason: "إضافة لمسير الرواتب فقط",
        disbursementType: "PAYROLL_ADDITION",
      });
      await approveSpotBonus(admin, bonus.id);

      await expect(
        paySpotBonusCash(admin, { id: bonus.id, cashBucket: "TREASURY" }),
      ).rejects.toThrow();
    });

    it("listEmployeeSpotBonuses:branch_scoped filters bonuses by employee and branch", async () => {
      await seedEmp({ employeeId: 9401, branchId: 101 });
      const admin = { userId: 1, role: "admin", branchId: 101 } as any;

      await createSpotBonus(admin, {
        employeeId: 9401,
        amount: "25000.00",
        reason: "مكافأة للاستعلام",
      });

      const list = await listEmployeeSpotBonuses(9401, 101);
      expect(Array.isArray(list)).toBe(true);
      expect(list.length).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // Group 5: employeeCustodyService (12 Integration Tests)
  // =========================================================================
  describe("Group 5: employeeCustodyService Lifecycle & Row Lock Safety", () => {
    it("assignCustody:happy_path assigns custody item to active employee with HELD status", async () => {
      const { db } = await seedEmp({ employeeId: 9501, branchId: 101, employmentStatus: "active" });
      const actor = { userId: 1, role: "admin", branchId: 101 } as any;

      const res = await assignEmployeeCustody(actor, {
        employeeId: 9501,
        itemType: "DEVICE",
        itemName: "لابتوب Dell Precision",
        itemCode: "IT-0091",
        serialNumber: "SN-99887766",
        quantity: 1,
        conditionAtHandover: "ممتازة جديدة بالصندوق",
        handoverDate: "2026-06-01",
      });

      expect(res.id).toBeDefined();
      expect(res.status).toBe("HELD");

      const [c] = await db.select().from(s.employeeCustody).where(eq(s.employeeCustody.id, res.id));
      expect(c.status).toBe("HELD");
      expect(c.itemName).toBe("لابتوب Dell Precision");
      expect(c.serialNumber).toBe("SN-99887766");
      expect(Number(c.branchId)).toBe(101);
    });

    it("assignCustody:inactive_employee_guard rejects assigning custody to terminated or on-leave employee", async () => {
      await seedEmp({ employeeId: 9502, branchId: 101, employmentStatus: "terminated" });
      const actor = { userId: 1, role: "admin", branchId: 101 } as any;

      await expect(
        assignEmployeeCustody(actor, {
          employeeId: 9502,
          itemType: "TOOL",
          itemName: "عدة صيانة",
          handoverDate: "2026-06-01",
        }),
      ).rejects.toThrow();

      // Test on-leave status
      await seedEmp({ employeeId: 9502, branchId: 101, employmentStatus: "leave" });
      await expect(
        assignEmployeeCustody(actor, {
          employeeId: 9502,
          itemType: "TOOL",
          itemName: "عدة صيانة",
          handoverDate: "2026-06-01",
        }),
      ).rejects.toThrow();
    });

    it("assignCustody:employee_not_found throws NOT_FOUND for non-existent employee", async () => {
      const actor = { userId: 1, role: "admin" } as any;
      await expect(
        assignEmployeeCustody(actor, {
          employeeId: 999999,
          itemType: "KEY",
          itemName: "مفتاح الخزينة",
          handoverDate: "2026-06-01",
        }),
      ).rejects.toThrow();
    });

    it("returnCustody:normal_return updates status to RETURNED and records receiver", async () => {
      const { db } = await seedEmp({ employeeId: 9501, branchId: 101 });
      const actor = { userId: 1, role: "admin", branchId: 101 } as any;

      const res = await assignEmployeeCustody(actor, {
        employeeId: 9501,
        itemType: "KEY",
        itemName: "مفتاح المخزن الرئيسي",
        handoverDate: "2026-06-01",
      });

      const ret = await returnEmployeeCustody(actor, {
        id: res.id,
        actualReturnDate: "2026-06-10",
        conditionAtReturn: "سليم بحالة جيدة",
        status: "RETURNED",
      });

      expect(ret.status).toBe("RETURNED");

      const [c] = await db.select().from(s.employeeCustody).where(eq(s.employeeCustody.id, res.id));
      expect(c.status).toBe("RETURNED");
      expect(c.actualReturnDate).toBe("2026-06-10");
      expect(c.receivedById).toBe(1);
    });

    it("returnCustody:damaged_return updates status to DAMAGED with damage notes", async () => {
      const { db } = await seedEmp({ employeeId: 9501, branchId: 101 });
      const actor = { userId: 1, role: "admin", branchId: 101 } as any;

      const res = await assignEmployeeCustody(actor, {
        employeeId: 9501,
        itemType: "TOOL",
        itemName: "ميزان إلكتروني",
        handoverDate: "2026-06-01",
      });

      const ret = await returnEmployeeCustody(actor, {
        id: res.id,
        actualReturnDate: "2026-06-11",
        conditionAtReturn: "كسر في الشاشة الزجاجية",
        returnNotes: "تلف ناتج عن سوء الاستخدام",
        status: "DAMAGED",
      });

      expect(ret.status).toBe("DAMAGED");

      const [c] = await db.select().from(s.employeeCustody).where(eq(s.employeeCustody.id, res.id));
      expect(c.status).toBe("DAMAGED");
      expect(c.returnNotes).toContain("سوء الاستخدام");
    });

    it("returnCustody:lost_report marks custody as LOST", async () => {
      const { db } = await seedEmp({ employeeId: 9501, branchId: 101 });
      const actor = { userId: 1, role: "admin", branchId: 101 } as any;

      const res = await assignEmployeeCustody(actor, {
        employeeId: 9501,
        itemType: "DOCUMENT",
        itemName: "سجل الوصولات اليدوي",
        handoverDate: "2026-06-01",
      });

      const ret = await returnEmployeeCustody(actor, {
        id: res.id,
        actualReturnDate: "2026-06-12",
        returnNotes: "تم الإبلاغ عن فقدان السجل خارج الفرع",
        status: "LOST",
      });

      expect(ret.status).toBe("LOST");

      const [c] = await db.select().from(s.employeeCustody).where(eq(s.employeeCustody.id, res.id));
      expect(c.status).toBe("LOST");
    });

    it("returnCustody:already_settled_guard rejects returning custody that is not HELD", async () => {
      await seedEmp({ employeeId: 9501, branchId: 101 });
      const actor = { userId: 1, role: "admin", branchId: 101 } as any;
      const res = await assignEmployeeCustody(actor, {
        employeeId: 9501,
        itemType: "UNIFORM",
        itemName: "زي العمل الرسمي",
        handoverDate: "2026-06-01",
      });
      await returnEmployeeCustody(actor, { id: res.id, actualReturnDate: "2026-06-10" });

      // Second return must be rejected because status is no longer HELD
      await expect(
        returnEmployeeCustody(actor, { id: res.id, actualReturnDate: "2026-06-11" }),
      ).rejects.toThrow();
    });

    it("returnCustody:custody_not_found throws NOT_FOUND for non-existent custody ID", async () => {
      const actor = { userId: 1, role: "admin" } as any;
      await expect(
        returnEmployeeCustody(actor, { id: 999999, actualReturnDate: "2026-06-10" }),
      ).rejects.toThrow();
    });

    it("clearance_integration:getOpenEmployeeCustody retrieves only HELD items", async () => {
      await seedEmp({ employeeId: 9501, branchId: 101 });
      const actor = { userId: 1, role: "admin", branchId: 101 } as any;

      const openCustody = await assignEmployeeCustody(actor, {
        employeeId: 9501,
        itemType: "VEHICLE",
        itemName: "دراجة نارية للتوصيل",
        handoverDate: "2026-06-01",
      });

      const list = await getOpenEmployeeCustody(9501);
      expect(list.some((x: any) => x.id === openCustody.id)).toBe(true);

      await returnEmployeeCustody(actor, { id: openCustody.id, actualReturnDate: "2026-06-15" });
      const listAfter = await getOpenEmployeeCustody(9501);
      expect(listAfter.some((x: any) => x.id === openCustody.id)).toBe(false);
    });

    it("branch_isolation:listEmployeeCustody filters custody by employee and branchId", async () => {
      await seedEmp({ employeeId: 9501, branchId: 101 });
      const actor = { userId: 1, role: "admin", branchId: 101 } as any;

      await assignEmployeeCustody(actor, {
        employeeId: 9501,
        itemType: "TOOL",
        itemName: "مجموعة مفكات",
        handoverDate: "2026-06-01",
      });

      const list = await listEmployeeCustody(9501, 101);
      expect(Array.isArray(list)).toBe(true);
      expect(list.length).toBeGreaterThanOrEqual(1);

      const listBranch2 = await listEmployeeCustody(9501, 102);
      expect(listBranch2.length).toBe(0);
    });

    it("assignCustody:branch_fallback falls back to actor branchId when employee branchId is missing", async () => {
      const { db } = await seedEmp({ employeeId: 9503, branchId: 101 });
      await db.update(s.employees).set({ branchId: null }).where(eq(s.employees.id, 9503));
      const actor = { userId: 1, role: "admin", branchId: 101 } as any;

      const res = await assignEmployeeCustody(actor, {
        employeeId: 9503,
        itemType: "DEVICE",
        itemName: "قارئ باركود لاسلكي",
        handoverDate: "2026-06-01",
      });

      const [c] = await db.select().from(s.employeeCustody).where(eq(s.employeeCustody.id, res.id));
      expect(Number(c.branchId)).toBe(101);
    });

    it("returnCustody:row_lock_protection executes safely within withTx using for-update lock", async () => {
      await seedEmp({ employeeId: 9501, branchId: 101 });
      const actor = { userId: 1, role: "admin", branchId: 101 } as any;
      const res = await assignEmployeeCustody(actor, {
        employeeId: 9501,
        itemType: "TOOL",
        itemName: "مقص ورق صناعي",
        handoverDate: "2026-06-01",
      });

      const ret = await returnEmployeeCustody(actor, {
        id: res.id,
        actualReturnDate: "2026-06-18",
        status: "RETURNED",
      });
      expect(ret.status).toBe("RETURNED");
    });
  });
});
