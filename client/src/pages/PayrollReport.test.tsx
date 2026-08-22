import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const report = readFileSync(new URL("./PayrollReport.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
const reportsCenter = readFileSync(new URL("./ReportsCenter.tsx", import.meta.url), "utf8");

describe("Payroll accrual report contract", () => {
  it("يعرض المعتمد والمدفوع والملغى ويقرأ الالتزامات المستقلة", () => {
    expect(report).toContain('approved: "badge-status-pending"');
    expect(report).toContain('paid: "badge-status-active"');
    expect(report).toContain('cancelled: "badge-status-cancelled"');
    expect(report).toContain("trpc.payroll.obligations.useQuery");
    expect(report).toContain("enabled: ownerAccess");
    expect(report).toContain("settledObligationAmount");
    expect(report).toContain("ledgerDate(row.dueDate ?? row.createdAt).slice(0, 7) === period");
    expect(report).not.toContain('sum(paidRows, (row) => row.totalNet)');
    expect(report).toContain("gross: sum(accruedRows");
    expect(report).toContain("net: sum(accruedRows");
  });

  it("يُصدر الحقول المالية كأرقام Excel لا نصوص منسقة", () => {
    for (const field of [
      "totalGross", "totalNet", "totalIncomeTax", "totalSocialSecurityEmployee",
      "totalSocialSecurityEmployer", "totalEndOfServiceAccrual",
    ]) expect(report).toContain(`toExcelMoney(row.${field})`);
    expect(report).toContain("sortingFn: decimalSort");
    expect(report).not.toContain("Number(row.totalGross)");
    expect(report).not.toContain("Number(row.totalNet)");
  });

  it("يحمل تاريخ الاستحقاق والمراجعة وبصمتي السياسة والاعتماد", () => {
    expect(report).toContain("row.accrualDate");
    expect(report).toContain("row.revisionNo");
    expect(report).toContain("row.legalPolicyHash");
    expect(report).toContain("row.approvalSnapshotHash");
  });

  it("يعرض ويطبع ويصدر سجل كل حركة مالية مع مستندها ومنفذها", () => {
    expect(report).toContain("trpc.payroll.financialLedger.useQuery");
    expect(report).toContain("سجل حركة الأموال والمستندات");
    expect(report).toContain("printFinancialLedger");
    expect(report).toContain("REC-${row.receiptId}");
    expect(report).toContain("EV-${row.eventId}");
    expect(report).toContain("USER-${row.createdBy}");
    expect(report).toContain('sheetName: "سجل حركة الأموال"');
    expect(report).toContain("toExcelMoney(row.amount)");
    for (const kind of ["SALARY_PAYMENT_RETURN", "TAX_REMITTANCE", "SOCIAL_SECURITY_REMITTANCE", "REMITTANCE_RETURN"]) {
      expect(report).toContain(kind);
    }
  });

  it("يطابق طريق وبطاقة التقرير بوابة المالك الخادمية", () => {
    expect(app).toContain('path="/reports/payroll"><Shell><RequireOwner>');
    expect(app).toContain("me.data?.isOwner === true");
    expect(reportsCenter).toContain('href: "/reports/payroll"');
    expect(reportsCenter).toContain("ownerOnly: true");
    expect(reportsCenter).toContain("(!it.ownerOnly || isOwner)");
  });
});
