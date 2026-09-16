import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync(new URL("./EmployeeAdvances.tsx", import.meta.url), "utf8");
const panel = readFileSync(new URL("../components/hr/EmployeeAdvanceRepaymentPanel.tsx", import.meta.url), "utf8");

describe("employee advance repayment UI contract", () => {
  it("wires the maker/checker repayment, return, review, and ledger routes", () => {
    expect(page).toContain("EmployeeAdvanceRepaymentPanel");
    for (const route of [
      "advanceRepaymentRequests",
      "advanceRepaymentLedger",
      "requestAdvanceRepayment",
      "requestAdvanceRepaymentReturn",
      "approveAdvanceRepayment",
      "rejectAdvanceRepayment",
    ]) expect(panel).toContain(`payroll.${route}`);
    expect(panel).toContain("!owner && <Button");
    // ⭐ قرار المالك (٣/٩/٢٦): لا اعتماد ثانٍ بعد المالك — الاعتماد/الرفض مشروطان بـowner
    // وحده، لا باستقلاله عن صانع الطلب أو مراجع أصله.
    expect(panel).toContain("{owner && request.status === \"PENDING\" && <>");
    expect(panel).not.toContain(".every((actorId) => currentUserId !== Number(actorId))");
    expect(panel).not.toContain("يلزم مالك مستقل عن صانع الطلب");
  });

  it("shows scoped advance balances without querying salary runs or salary obligations", () => {
    expect(panel).toContain('advancesList.useQuery({ status: "ACTIVE" })');
    expect(panel).toContain("new Map<string, EmployeeBalance>()");
    expect(panel).toContain("employeeBranchKey(employeeId, branchId)");
    expect(panel).toContain("employeeBranchKey(row.employeeId, row.branchId) === employeeScopeKey");
    // قاموس حالة التوظيف مصدره الوحيد @shared/hr — ثلاث حالات لا حالتان:
    // تعبير ثنائي محليّ كان يعرض الموظف «leave» «على رأس العمل» — عكس الحقيقة.
    expect(panel).toContain('import { employmentStatusLabel } from "@shared/hr"');
    expect(panel).toContain('employee.employmentStatus ? employmentStatusLabel(employee.employmentStatus) : "—"');
    expect(panel).not.toContain('"منتهي الخدمة"');
    expect(panel).not.toContain('"على رأس العمل"');
    expect(panel).toContain("إجمالي الرصيد ضمن النطاق");
    expect(panel).toContain("لا تعرض هذه اللوحة أجور الموظفين أو تفاصيل مسيّرات الرواتب");
    expect(panel).not.toContain("payroll.list.useQuery");
    expect(panel).not.toContain("payroll.get.useQuery");
    expect(panel).not.toContain("payroll.obligations.useQuery");
  });

  it("requires precise evidence and never sends a repayment above the Decimal balance", () => {
    expect(panel).toContain("D(effectiveAmount || 0).lte(D(selected.remaining))");
    expect(panel).toContain("evidenceNote.trim().length >= 10");
    expect(panel).toContain('/^\\d{4}$/.test(lastFour)');
    expect(panel).toContain('setLastFour(event.target.value.replace(/\\D/g, "").slice(0, 4))');
    expect(panel).toContain('cashBucket: method === "CASH" ? "DRAWER"');
    expect(panel).toContain("shiftQ.data?.id");
    expect(panel).toContain('timeZone: "Asia/Baghdad"');
  });

  it("prints the receipt, journal entry, allocations, actors, and audit hashes", () => {
    expect(panel).toContain("repaymentPrint(request, allocations)");
    expect(panel).toContain("REC-${request.receiptId}");
    expect(panel).toContain("AE-${request.accountingEntryId}");
    expect(panel).toContain("request.sourceHash");
    expect(panel).toContain("request.evidenceHash");
    expect(panel).toContain("USER-${request.createdBy}");
    expect(panel).toContain("USER-${request.reviewedBy}");
    expect(panel).toContain("iqd(row.amount)");
    expect(panel).toContain("allocation.receiptId");
    expect(panel).toContain("allocation.accountingEntryId");
  });

  it("exports an allocation-level Excel register with money guarded at the file boundary", () => {
    expect(panel).toContain("exportRepaymentLedger");
    expect(panel).toContain('filename: "سجل-سداد-سلف-الموظفين"');
    expect(panel).toContain("toExcelMoney(request.amount)");
    expect(panel).toContain("toExcelMoney(allocation.amount)");
    expect(panel).toContain('header: "إيصال التخصيص"');
    expect(panel).toContain('header: "قيد التخصيص"');
  });

  it("lets any active owner decide a return regardless of who touched the original repayment (قرار المالك ٣/٩/٢٦)", () => {
    expect(panel).not.toContain("original?.createdBy");
    expect(panel).not.toContain("original?.reviewedBy");
    expect(panel).not.toContain("const independent");
  });

  it("keeps IQD arithmetic in Decimal and guards Excel conversion", () => {
    expect(page).toContain("toExcelMoney(r.amount)");
    expect(page).toContain("toExcelMoney(r.remaining)");
    expect(page).not.toContain("Number(r.amount)");
    expect(page).not.toContain("Number(r.remaining)");
    expect(page).not.toContain("Number(amount || 0)");
    expect(page).not.toContain("Number(balQ.data.balance)");
  });
});
