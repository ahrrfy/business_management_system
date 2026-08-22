import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const financial = readFileSync(new URL("../reportsFinancialService.ts", import.meta.url), "utf8");
const closePack = readFileSync(new URL("../reports/monthlyClosePack.ts", import.meta.url), "utf8");
const payrollSlice = financial.slice(
  financial.indexOf("const pr = rowsOf("),
  financial.indexOf("const sl = rowsOf("),
);

describe("P&L payroll accrual source contract", () => {
  it("يقرأ أحداث الاستحقاق وأثر تسوية نهاية الخدمة وعكوسهما فقط في الوضع المشتق", () => {
    expect(payrollSlice).toContain("FROM payrollAccountingEvents pae");
    for (const kind of ["ACCRUAL", "ACCRUAL_REVERSAL", "EOS_SETTLEMENT", "EOS_SETTLEMENT_REVERSAL"]) {
      expect(payrollSlice).toContain(`'${kind}'`);
    }
    expect(payrollSlice).toContain("ae.entryType = 'ADJUST'");
  });

  it("يحوّل ACTIVE إلى أدوار اليومية بإشارة مدين/دائن ويستبعد قيود الدفع من P&L", () => {
    expect(financial).toContain('accountingBasis: "DOUBLE_ENTRY_ACTIVE"');
    expect(financial).toContain("FROM journalLines jl");
    expect(financial).toContain("revenue = revenue.add(credit.sub(debit))");
    expect(financial).toContain("const amount = debit.sub(credit)");
    expect(financial).toContain('role === "COGS"');
  });

  it("يستخرج خصوم الرواتب من أرصدة أدوار الدورة النشطة حتى تاريخ اللقطة", () => {
    for (const role of ["ACCRUED_SALARY", "PAYROLL_TAX_PAYABLE", "SOCIAL_SECURITY_PAYABLE", "EOS_PROVISION"]) {
      expect(financial).toContain(`'${role}'`);
    }
    expect(financial).toContain("SUM(jl.credit - jl.debit)");
    expect(financial).toContain('payrollMode.mode === "ACTIVE" || payrollMode.mode === "SHADOW"');
    expect(financial).toContain("FROM payrollObligations");
    expect(financial).toContain("je.entryDate <= ${asOf}");
    expect(financial).toContain("FROM payrollObligationAllocations allocation");
    expect(financial).toContain("DATE(allocation.occurredAt) <= ${asOf}");
    expect(financial).toContain("po.originalAmount - COALESCE");
    expect(financial).toContain("تخصيصات السداد/الاسترداد وعكوسها المؤرخة حتى اللقطة");
  });

  it("يعرض صافي مقاصة الفروع كمستحق لنا أو علينا ولا يخفيه داخل الشركة", () => {
    expect(financial).toContain("jl.role = 'INTERBRANCH_CLEARING'");
    expect(financial).toContain("SUM(jl.debit - jl.credit)");
    expect(financial).toContain("const dueFromBranches = interbranchNet.gt(0)");
    expect(financial).toContain("const dueToBranches = interbranchNet.lt(0)");
    expect(financial).toContain(".add(dueFromBranches)");
    expect(financial).toContain(".add(dueToBranches)");
  });

  it("يحسب أصل سلف الموظفين من اليومية أو من تخصيصات OFF المؤرخة", () => {
    expect(financial).toContain("jl.role = 'EMPLOYEE_ADVANCES'");
    expect(financial).toContain("FROM advanceSettlements aset");
    expect(financial).toContain("FROM terminationAdvanceAllocations taa");
    expect(financial).toContain("FROM employeeAdvanceRepaymentAllocations ara");
    expect(financial).toContain("ara.advanceRepaymentAllocationDirection = 'APPLY'");
    expect(financial).toContain("ea.advanceStatus = 'CANCELLED' AND DATE(ea.updatedAt)");
    expect(financial).toContain("aset.advanceSettlementDirection = 'APPLY'");
    expect(financial).toContain("taa.terminationAdvanceDirection = 'APPLY'");
    expect(financial).toContain(".add(employeeAdvanceReceivable)");
  });

  it("لا يعيد الرواتب إلى الأساس النقدي عبر PAYMENT_OUT", () => {
    expect(payrollSlice).not.toContain("PAYMENT_OUT");
    expect(payrollSlice).not.toContain("dedupeKey LIKE 'PAYROLL%'");
  });

  it("يحترم تاريخ القيد والفرع ويغذي حزمة الإقفال من المصدر نفسه", () => {
    expect(payrollSlice).toContain("ae.entryDate >= ${from} AND ae.entryDate <= ${to}");
    expect(payrollSlice).toContain("${branchAe}");
    expect(closePack).toContain("plSnapshot(from, to, branchId)");
  });
});
