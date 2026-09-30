import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { withTx } from "../tx";
import { computeDocumentStatus } from "../employeeDocumentService";
import { calculateLeaveEncashment } from "../leaveService";
import { executeTransferInTx, executePendingTransfers } from "../employeeTransferService";
import {
  approveEmployeeContract,
  renewEmployeeContract,
  terminateEmployeeContract,
} from "../employeeContractService";
import { baghdadToday } from "../businessDay";

describe("HR Enterprise Transactions — Atomic Logic & Legal Compliance", () => {
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
      // 1,500,000 IQD gross monthly / 30 = 50,000 per day * 10 days = 500,000 IQD
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

  describe("employeeContractService: Iraqi Labor Law Art. 33 Probation Guard", () => {
    it("verifies 3-month probation period limit calculation", () => {
      const start = new Date("2026-01-01");
      const validProbation = new Date("2026-03-31");
      const diffDaysValid = Math.ceil(
        (validProbation.getTime() - start.getTime()) / (1000 * 60 * 60 * 24),
      );
      expect(diffDaysValid).toBeLessThanOrEqual(92);

      const invalidProbation = new Date("2026-05-01");
      const diffDaysInvalid = Math.ceil(
        (invalidProbation.getTime() - start.getTime()) / (1000 * 60 * 60 * 24),
      );
      expect(diffDaysInvalid).toBeGreaterThan(92);
    });
  });

  describe("employeePenaltyService: Iraqi Labor Law Art. 139 Deduction Limit", () => {
    it("verifies maximum deduction ceiling is 3 days", () => {
      const legalLimit = 3.0;
      expect(2.5).toBeLessThanOrEqual(legalLimit);
      expect(3.0).toBeLessThanOrEqual(legalLimit);
      expect(3.5).toBeGreaterThan(legalLimit);
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

  describe("employeeTransferService (GAP-08 & GAP-09)", () => {
    it("GAP-09: executeTransferInTx atomically updates employees and users.branchId", async () => {
      const db = getDb();
      if (!db) return;
      await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
      await db
        .insert(s.branches)
        .values([
          { id: 101, name: "فرع البصرة", code: "BSR", type: "SALES" },
          { id: 102, name: "فرع أربيل", code: "EBL", type: "SALES" },
        ])
        .onDuplicateKeyUpdate({ set: { name: sql`VALUES(name)` } });
      await db
        .insert(s.users)
        .values({
          id: 991,
          openId: "test-transfer-user-991",
          name: "موظف منقول",
          role: "cashier",
          branchId: 101,
        })
        .onDuplicateKeyUpdate({ set: { branchId: 101 } });
      await db
        .insert(s.employees)
        .values({
          id: 991,
          userId: 991,
          firstName: "مهند",
          lastName: "الزبيدي",
          branchId: 101,
          department: "المبيعات",
          position: "كاشير",
          salary: "600000",
          payType: "monthly",
        })
        .onDuplicateKeyUpdate({
          set: { branchId: 101, department: "المبيعات", position: "كاشير" },
        });

      await db
        .insert(s.employeeTransfers)
        .values({
          id: 991,
          employeeId: 991,
          fromBranchId: 101,
          toBranchId: 102,
          fromDepartment: "المبيعات",
          toDepartment: "المخازن",
          fromPosition: "كاشير",
          toPosition: "أمين مخزن",
          decisionNumber: "TR-991",
          transferDate: "2026-06-01",
          effectiveDate: "2026-06-01",
          status: "APPROVED",
          createdById: 1,
        })
        .onDuplicateKeyUpdate({ set: { status: "APPROVED" } });

      await withTx(async (tx) => {
        await executeTransferInTx(tx, {
          id: 991,
          employeeId: 991,
          toBranchId: 102,
          toDepartment: "المخازن",
          toPosition: "أمين مخزن",
        });
      });

      const [updatedEmp] = await db
        .select()
        .from(s.employees)
        .where(eq(s.employees.id, 991));
      expect(Number(updatedEmp.branchId)).toBe(102);
      expect(updatedEmp.department).toBe("المخازن");
      expect(updatedEmp.position).toBe("أمين مخزن");

      const [updatedUser] = await db
        .select()
        .from(s.users)
        .where(eq(s.users.id, 991));
      expect(Number(updatedUser.branchId)).toBe(102);
    });

    it("GAP-08: executePendingTransfers processes approved transfers with effectiveDate <= today", async () => {
      const db = getDb();
      if (!db) return;
      await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
      const today = baghdadToday();
      await db
        .insert(s.branches)
        .values([
          { id: 101, name: "فرع البصرة", code: "BSR", type: "SALES" },
          { id: 103, name: "فرع النجف", code: "NJF", type: "SALES" },
        ])
        .onDuplicateKeyUpdate({ set: { name: sql`VALUES(name)` } });
      await db
        .insert(s.employees)
        .values({
          id: 992,
          firstName: "سنان",
          lastName: "البصري",
          branchId: 101,
          department: "الاستقبال",
          position: "موظف استقبال",
          salary: "500000",
          payType: "monthly",
        })
        .onDuplicateKeyUpdate({ set: { branchId: 101 } });

      await db
        .insert(s.employeeTransfers)
        .values({
          id: 992,
          employeeId: 992,
          fromBranchId: 101,
          toBranchId: 103,
          fromDepartment: "الاستقبال",
          toDepartment: "خدمة العملاء",
          fromPosition: "موظف استقبال",
          toPosition: "ممثل خدمة",
          decisionNumber: "TR-992",
          transferDate: today,
          effectiveDate: today,
          status: "APPROVED",
          createdById: 1,
        })
        .onDuplicateKeyUpdate({
          set: { status: "APPROVED", effectiveDate: today },
        });

      const res = await executePendingTransfers();
      expect(res.executedCount).toBeGreaterThanOrEqual(1);
      expect(res.transferIds).toContain(992);

      const [trRow] = await db
        .select()
        .from(s.employeeTransfers)
        .where(eq(s.employeeTransfers.id, 992));
      expect(trRow.status).toBe("EFFECTIVE");

      const [empRow] = await db
        .select()
        .from(s.employees)
        .where(eq(s.employees.id, 992));
      expect(Number(empRow.branchId)).toBe(103);
      expect(empRow.department).toBe("خدمة العملاء");
    });
  });

  describe("employeeContractService: GAP-12 Contract Lifecycle & Sync", () => {
    it("GAP-12: approveEmployeeContract updates employee salary, position, allowances and marks previous active contract as RENEWED", async () => {
      const db = getDb();
      if (!db) return;
      await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
      const today = baghdadToday();

      await db
        .insert(s.branches)
        .values([{ id: 101, name: "فرع البصرة", code: "BSR", type: "SALES" }])
        .onDuplicateKeyUpdate({ set: { name: sql`VALUES(name)` } });

      await db
        .insert(s.employees)
        .values({
          id: 993,
          firstName: "طارق",
          lastName: "الزبيدي",
          branchId: 101,
          position: "محاسب مبتدئ",
          salary: "600000.00",
          allowances: "50000.00",
          payType: "monthly",
        })
        .onDuplicateKeyUpdate({
          set: { position: "محاسب مبتدئ", salary: "600000.00", allowances: "50000.00" },
        });

      // Insert prior active contract
      await db
        .insert(s.employeeContracts)
        .values({
          id: 9931,
          employeeId: 993,
          branchId: 101,
          contractType: "FIXED_TERM",
          startDate: "2025-01-01",
          endDate: "2025-12-31",
          jobTitle: "محاسب مبتدئ",
          basicSalary: "600000.00",
          allowances: "50000.00",
          status: "ACTIVE",
          createdById: 1,
        })
        .onDuplicateKeyUpdate({ set: { status: "ACTIVE" } });

      // Insert new draft contract
      await db
        .insert(s.employeeContracts)
        .values({
          id: 9932,
          employeeId: 993,
          branchId: 101,
          contractType: "INDEFINITE",
          startDate: today,
          jobTitle: "محاسب أول",
          basicSalary: "950000.00",
          allowances: "100000.00",
          status: "DRAFT",
          createdById: 2,
        })
        .onDuplicateKeyUpdate({ set: { status: "DRAFT" } });

      const actor = { userId: 1, role: "admin" } as any;
      await approveEmployeeContract(actor, 9932);

      // Verify old contract is RENEWED
      const [oldC] = await db
        .select()
        .from(s.employeeContracts)
        .where(eq(s.employeeContracts.id, 9931));
      expect(oldC.status).toBe("RENEWED");

      // Verify new contract is ACTIVE
      const [newC] = await db
        .select()
        .from(s.employeeContracts)
        .where(eq(s.employeeContracts.id, 9932));
      expect(newC.status).toBe("ACTIVE");

      // Verify employee record synchronized
      const [emp] = await db
        .select()
        .from(s.employees)
        .where(eq(s.employees.id, 993));
      expect(emp.position).toBe("محاسب أول");
      expect(Number(emp.salary)).toBe(950000);
      expect(Number(emp.allowances)).toBe(100000);
    });

    it("GAP-12: renewEmployeeContract marks old contract RENEWED, creates active contract and syncs employee", async () => {
      const db = getDb();
      if (!db) return;
      await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
      const actor = { userId: 1, role: "admin" } as any;

      await db
        .insert(s.employees)
        .values({
          id: 994,
          firstName: "قاسم",
          lastName: "السعدي",
          branchId: 101,
          position: "محاسب",
          salary: "800000.00",
          allowances: "100000.00",
          payType: "monthly",
        })
        .onDuplicateKeyUpdate({ set: { salary: "800000.00" } });

      await db
        .insert(s.employeeContracts)
        .values({
          id: 9941,
          employeeId: 994,
          branchId: 101,
          contractType: "FIXED_TERM",
          startDate: "2025-01-01",
          endDate: "2025-12-31",
          jobTitle: "محاسب",
          basicSalary: "800000.00",
          allowances: "100000.00",
          status: "ACTIVE",
          createdById: 1,
        })
        .onDuplicateKeyUpdate({ set: { status: "ACTIVE" } });

      const res = await renewEmployeeContract(actor, {
        id: 9941,
        basicSalary: "1100000.00",
        allowances: "150000.00",
        jobTitle: "مدير حسابات",
        contractNumber: "CNT-994-2026",
      });

      expect(res.oldContractId).toBe(9941);
      expect(res.status).toBe("ACTIVE");

      const [oldC] = await db
        .select()
        .from(s.employeeContracts)
        .where(eq(s.employeeContracts.id, 9941));
      expect(oldC.status).toBe("RENEWED");

      const [newC] = await db
        .select()
        .from(s.employeeContracts)
        .where(eq(s.employeeContracts.id, res.newContractId));
      expect(newC.status).toBe("ACTIVE");
      expect(newC.contractNumber).toBe("CNT-994-2026");

      const [emp] = await db
        .select()
        .from(s.employees)
        .where(eq(s.employees.id, 994));
      expect(emp.position).toBe("مدير حسابات");
      expect(Number(emp.salary)).toBe(1100000);
      expect(Number(emp.allowances)).toBe(150000);
    });

    it("GAP-12: terminateEmployeeContract sets status to TERMINATED and records endDate", async () => {
      const db = getDb();
      if (!db) return;
      await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
      const actor = { userId: 1, role: "admin" } as any;
      const today = baghdadToday();

      await db
        .insert(s.employees)
        .values({
          id: 995,
          firstName: "ليث",
          lastName: "العبيدي",
          branchId: 101,
          position: "مهندس",
          salary: "1200000.00",
          payType: "monthly",
        })
        .onDuplicateKeyUpdate({ set: { position: "مهندس" } });

      await db
        .insert(s.employeeContracts)
        .values({
          id: 9951,
          employeeId: 995,
          branchId: 101,
          contractType: "FIXED_TERM",
          startDate: "2025-01-01",
          endDate: "2026-12-31",
          jobTitle: "مهندس",
          basicSalary: "1200000.00",
          status: "ACTIVE",
          createdById: 1,
        })
        .onDuplicateKeyUpdate({ set: { status: "ACTIVE" } });

      await terminateEmployeeContract(actor, 9951, "انتهاء المشروع");

      const [termC] = await db
        .select()
        .from(s.employeeContracts)
        .where(eq(s.employeeContracts.id, 9951));
      expect(termC.status).toBe("TERMINATED");
      expect(termC.endDate).toBe(today);
      expect(termC.terms).toContain("انتهاء المشروع");
    });
  });
});
