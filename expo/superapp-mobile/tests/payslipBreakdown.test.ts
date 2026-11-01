import { describe, expect, it } from "vitest";

import { buildPayslipBreakdown } from "../lib/payslipBreakdown";

describe("buildPayslipBreakdown", () => {
  it("does not add allowances or classified deductions twice", () => {
    const result = buildPayslipBreakdown({
      gross: "1000000.00",
      allowances: "100000.00",
      overtime: "50000.00",
      commission: "20000.00",
      deductions: "200000.00",
      advanceDeduction: "100000.00",
      penaltyDeduction: "30000.00",
      socialSecurityEmployee: "30000.00",
      incomeTax: "20000.00",
      net: "870000.00",
    });

    expect(result).toMatchObject({
      baseWage: "900000.00",
      totalEarnings: "1070000.00",
      penaltyDeduction: "30000.00",
      otherDeductions: "20000.00",
      totalDeductions: "200000.00",
      expectedNet: "870000.00",
      netMatches: true,
    });
  });

  it("keeps an unknown historical penalty unknown and a captured zero distinct", () => {
    const input = { gross: "1000", overtime: "0", commission: "0", deductions: "100", net: "900" };
    expect(buildPayslipBreakdown(input)).toMatchObject({ penaltyDeduction: null, otherDeductions: "100.00", expectedNet: "900.00" });
    expect(buildPayslipBreakdown({ ...input, penaltyDeduction: "0.00" })).toMatchObject({ penaltyDeduction: "0.00", otherDeductions: "100.00", expectedNet: "900.00" });
  });

  it("flags penalty components that exceed total deductions", () => {
    const result = buildPayslipBreakdown({ gross: "1000", overtime: "0", commission: "0", deductions: "100", penaltyDeduction: "101", net: "900" });
    expect(result).toMatchObject({ penaltyDeduction: "101.00", deductionClassificationGap: "-1.00", deductionComponentsValid: false, expectedNet: "900.00" });
  });

  it("rounds money HALF_UP at the display boundary without floating point", () => {
    const result = buildPayslipBreakdown({
      gross: "100.005",
      allowances: "0",
      overtime: "0",
      commission: "0",
      deductions: "0.005",
      net: "100.00",
    });

    expect(result.gross).toBe("100.01");
    expect(result.totalDeductions).toBe("0.01");
    expect(result.expectedNet).toBe("100.00");
    expect(result.netMatches).toBe(true);
  });

  it("preserves values beyond JavaScript safe integers", () => {
    const result = buildPayslipBreakdown({
      gross: "9007199254740993.50",
      allowances: "0.00",
      overtime: "0.50",
      commission: "0",
      deductions: "1.00",
      net: "9007199254740993.00",
    });

    expect(result.totalEarnings).toBe("9007199254740994.00");
    expect(result.expectedNet).toBe("9007199254740993.00");
  });

  it("exposes invalid classifications and net differences", () => {
    const result = buildPayslipBreakdown({
      gross: "1000",
      allowances: "1200",
      overtime: "0",
      commission: "0",
      deductions: "50",
      advanceDeduction: "60",
      net: "960",
    });

    expect(result.allowancesValid).toBe(false);
    expect(result.deductionComponentsValid).toBe(false);
    expect(result.deductionClassificationGap).toBe("-10.00");
    expect(result.netDifference).toBe("10.00");
    expect(result.netMatches).toBe(false);
  });
});
