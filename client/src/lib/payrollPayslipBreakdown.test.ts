import { describe, expect, it } from "vitest";

import { buildPayrollPayslipBreakdown } from "./payrollPayslipBreakdown";

describe("buildPayrollPayslipBreakdown", () => {
  it("treats allowances as part of gross and deductions as one classified total", () => {
    const result = buildPayrollPayslipBreakdown({
      gross: "1000000.00",
      allowances: "100000.00",
      overtime: "50000.00",
      commission: "20000.00",
      deductions: "200000.00",
      advanceDeduction: "100000.00",
      socialSecurityEmployee: "30000.00",
      incomeTax: "20000.00",
      net: "870000.00",
    });

    expect(result).toMatchObject({
      baseWage: "900000.00",
      allowances: "100000.00",
      totalEarnings: "1070000.00",
      otherDeductions: "50000.00",
      totalDeductions: "200000.00",
      expectedNet: "870000.00",
      netDifference: "0.00",
      allowancesValid: true,
      deductionComponentsValid: true,
      netMatches: true,
    });
  });

  it("derives the informational allowances amount from base salary for legacy print callers", () => {
    const result = buildPayrollPayslipBreakdown({
      gross: "750000.00",
      baseSalary: "700000.00",
      overtime: "0",
      commission: "0",
      deductions: "0",
      net: "750000.00",
    });

    expect(result.allowances).toBe("50000.00");
    expect(result.baseWage).toBe("700000.00");
    expect(result.netMatches).toBe(true);
  });

  it("preserves large decimal strings without Number rounding", () => {
    const result = buildPayrollPayslipBreakdown({
      gross: "9007199254740993.50",
      allowances: "0.00",
      overtime: "0.50",
      commission: "0.00",
      deductions: "1.00",
      net: "9007199254740993.00",
    });

    expect(result.totalEarnings).toBe("9007199254740994.00");
    expect(result.expectedNet).toBe("9007199254740993.00");
    expect(result.netMatches).toBe(true);
  });

  it("exposes over-classified deductions and a stored-net mismatch", () => {
    const result = buildPayrollPayslipBreakdown({
      gross: "1000.00",
      allowances: "1200.00",
      overtime: "0",
      commission: "0",
      deductions: "50.00",
      advanceDeduction: "60.00",
      net: "960.00",
    });

    expect(result.allowancesValid).toBe(false);
    expect(result.deductionComponentsValid).toBe(false);
    expect(result.deductionClassificationGap).toBe("-10.00");
    expect(result.otherDeductions).toBe("0.00");
    expect(result.expectedNet).toBe("950.00");
    expect(result.netDifference).toBe("10.00");
    expect(result.netMatches).toBe(false);
  });
});
