import { describe, expect, it } from "vitest";

import { buildPersonalPayslipPdfHtml } from "../lib/payslipPdf";

describe("personal payslip PDF", () => {
  it("escapes personal text and excludes internal payroll metadata", () => {
    const html = buildPersonalPayslipPdfHtml({
      employeeName: "موظف <script>alert(1)</script>",
      payslip: {
        period: "2026-09",
        status: "paid",
        paidAt: null,
        payType: "monthly",
        hours: "176.00",
        gross: "1000000.00",
        allowances: "20000.00",
        overtime: "0.00",
        commission: "0.00",
        deductions: "10000.00",
        advanceDeduction: "0.00",
        socialSecurityEmployee: "0.00",
        incomeTax: "0.00",
        net: "1010000.00",
      },
    });

    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("صافي الراتب");
    expect(html).not.toMatch(/payrollItemId|branchId|employer|note|session/i);
  });

  it("preserves large decimal strings without JavaScript number rounding", () => {
    const html = buildPersonalPayslipPdfHtml({
      employeeName: "موظف",
      payslip: {
        period: "2026-09",
        status: "approved",
        paidAt: null,
        payType: "monthly",
        hours: "176.00",
        gross: "9007199254740993.50",
        allowances: "0.00",
        overtime: "0.00",
        commission: "0.00",
        deductions: "0.00",
        advanceDeduction: "0.00",
        socialSecurityEmployee: "0.00",
        incomeTax: "0.00",
        net: "9007199254740993.50",
      },
    });

    expect(html).toContain("9,007,199,254,740,994");
    expect(html).not.toContain("9,007,199,254,740,992");
  });
});
