import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync(new URL("./BalanceSheet.tsx", import.meta.url), "utf8");

describe("Balance sheet payroll liabilities", () => {
  it("يفصح عن الالتزامات الأربعة من عقد التقرير", () => {
    expect(page).toContain("p.accruedSalaryLiability");
    expect(page).toContain("p.payrollTaxPayable");
    expect(page).toContain("p.socialSecurityPayable");
    expect(page).toContain("p.eosProvision");
  });

  it("لا يخفي رصيداً عكسياً بل يبقي إشارته ظاهرة للتدقيق", () => {
    expect(page).toContain("!D(r.v).isZero()");
  });

  it("shows interbranch due-from and due-to balances in UI, print, and export rows", () => {
    expect(page).toContain("p.dueFromBranches");
    expect(page).toContain("p.dueToBranches");
    expect(page).toContain("p?.interbranchNote");
    expect(page).toContain("toExcelMoney(r.amount)");
    expect(page).not.toContain("Number(r.amount)");
  });

  it("يعرض سلف الموظفين أصلاً ويُدخلها في صفوف الطباعة والتصدير", () => {
    expect(page).toContain("p.employeeAdvanceReceivable");
    expect(page).toContain("سلف مستحقة على الموظفين");
  });
});
