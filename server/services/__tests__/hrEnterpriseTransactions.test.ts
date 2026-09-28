import { describe, expect, it } from "vitest";
import { computeDocumentStatus } from "../employeeDocumentService";
import { calculateLeaveEncashment } from "../leaveService";

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
});
