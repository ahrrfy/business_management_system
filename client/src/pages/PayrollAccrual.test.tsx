import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync(new URL("./Payroll.tsx", import.meta.url), "utf8");
const operations = readFileSync(new URL("../components/hr/PayrollAccrualOperations.tsx", import.meta.url), "utf8");
const payment = readFileSync(new URL("../components/hr/PayrollPaymentDialog.tsx", import.meta.url), "utf8");
const payslip = readFileSync(new URL("../lib/printing/printPayslip.ts", import.meta.url), "utf8");

describe("Payroll accrual UI contract", () => {
  it("يفصل اعتماد الاستحقاق عن صرف الصافي وإعادة المسيّر", () => {
    expect(page).toContain("اعتماد الاستحقاق");
    expect(page).toContain("PayrollPaymentDialog");
    expect(page).toContain("عكس الاستحقاق وإعادة");
    expect(page).toContain('reason: "إعادة للمسودة من شاشة الرواتب"');
    expect(page).not.toContain("عكس الدفع يقيّد قيوداً معاكسة");
    expect(page).toContain("enabled: ownerAccess");
    expect(page).toContain("محصورة بجلسة المالك");
  });

  it("يعرض لقطة الفرع والمراجعة والبصمات والالتزامات الأربع", () => {
    expect(page).toContain("p.branchIdSnapshot");
    expect(page).toContain("p.revisionNo");
    expect(operations).toContain("run.legalPolicyHash");
    expect(operations).toContain("run.approvalSnapshotHash");
    expect(operations).toContain("summary.map");
    expect(operations).toContain("OBLIGATION_KIND_LABEL[row.kind]");
  });

  it("يوصل كامل دورة التحويل القانوني وفصل المهام", () => {
    for (const procedure of [
      "createRemittance", "approveRemittance", "rejectRemittance",
      "payRemittance", "returnRemittance", "returnSalaryPayment",
    ]) expect(operations).toContain(`trpc.payroll.${procedure}`);
    // ⭐ قرار المالك (٣/٩/٢٦): لا اعتماد ثانٍ بعد المالك — الاعتماد/الرفض/الدفع/الإعادة
    // مشروطة بـowner وحده، لا باستقلاله عن صانع الطلب.
    expect(operations).not.toContain("currentUserId !== Number(request.createdBy)");
    expect(operations).toContain("supportingDocumentUrl");
    expect(operations).toContain("reason.trim().length >= 5");
    expect(operations).toContain("minLength={5}");
    expect(operations).not.toContain('action?.type === "RETURN_SALARY" ? 5 : 1');
  });

  it("يطلب مرجعاً لغير النقد ويصرّح بمسار صافي الصفر", () => {
    expect(payment).toContain('const isNonCash = method !== "CASH"');
    expect(payment).toContain('/^\\d{4}$/.test(referenceNumber.trim())');
    expect(payment).toContain('placeholder={method === "CARD" ? "آخر 4 أرقام"');
    expect(operations).toContain('/^\\d{4}$/.test(reference.trim())');
    expect(operations).toContain('method === "CARD" ? 4 : 100');
    expect(payment).toContain("الصافي صفر: سيُقفل المسيّر تدقيقياً بلا إيصال أو حركة خزينة");
    expect(payment).toContain("me.data?.isOwner === true");
  });

  it("يسمح بإعادة دفع الجزء المعاد من مسيّر ما زال بحالة مدفوع", () => {
    expect(page).toContain('obligation.kind === "SALARY_NET"');
    expect(page).toContain('obligation.status === "OPEN" || obligation.status === "PARTIAL"');
    expect(page).toContain("isPaid && D(openSalaryAmount).gt(0)");
    expect(page).toContain("إعادة دفع الالتزامات المفتوحة");
  });

  it("القسيمة بيان استحقاق ببصمات ولا تدّعي القبض قبل الدفع", () => {
    expect(payslip).toContain("لا يثبت قبض الموظف ما لم تظهر حالة «مدفوع»");
    expect(payslip).toContain('d.paidAt ? "الموظف (استلمت)" : "الموظف (اطلعت)"');
    expect(payslip).toContain("POLICY ${esc(d.legalPolicyHash");
    expect(payslip).toContain("التزامات على الشركة — لا تُخصم من الموظف");
    expect(page).toContain("run?.employeePaymentSnapshots");
    expect(page).toContain("paymentYmd(slipPayment?.paymentDate)");
    expect(page).not.toContain("paidAt: run.paidAt");
    expect(page).toContain("مستحق غير مدفوع");
  });

  it("keeps branch remittance making available without exposing salary runs", () => {
    const makerPanel = operations.slice(
      operations.indexOf("export function PayrollRemittanceRequestPanel"),
      operations.indexOf("function CreateRemittanceDialog"),
    );
    expect(page).toContain("PayrollRemittanceRequestPanel");
    expect(operations).toContain("export function PayrollRemittanceRequestPanel");
    expect(operations).toContain("!owner && <Button");
    expect(operations).toContain("إنشاء الطلب من موظف الفرع");
    expect(makerPanel).toContain("payroll.statutoryObligationSummary.useQuery");
    expect(makerPanel).not.toContain("payroll.obligations.useQuery");
    expect(makerPanel).not.toContain("SALARY_NET");
    expect(makerPanel).not.toContain("EOS_PROVISION");
  });

  it("requires an auditable reason when returning an employee salary payment", () => {
    expect(operations).toContain("reason.trim().length >= 5");
    expect(operations).toContain("minLength={5}");
    expect(operations).toContain("reason: reason.trim()");
    expect(operations).toContain("5 أحرف على الأقل");
  });

  it("never renders an untrusted remittance attachment as a direct link", () => {
    expect(operations).toContain("safeRemittanceDocumentUrl");
    expect(operations).toContain('parsed.protocol === "https:"');
    expect(operations).toContain('rel="noopener noreferrer"');
    expect(operations).toContain("مستند غير صالح");
    expect(operations).not.toContain("href={request.supportingDocumentUrl}");
  });
});
