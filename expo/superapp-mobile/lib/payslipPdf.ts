import type { MobilePayslip } from "@/lib/secureTransportPayload";

import { formatIqd } from "./format";
import { buildPayslipBreakdown } from "./payslipBreakdown";

type PayslipPdfInput = Readonly<{
  employeeName: string;
  payslip: NonNullable<MobilePayslip["personal"]["payslip"]>;
}>;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function amount(value: string): string {
  return formatIqd(value);
}

/**
 * A compact personal payslip. It deliberately omits payroll IDs, branch,
 * employer costs, HR notes, device/session metadata, and internal audit data.
 */
export function buildPersonalPayslipPdfHtml(input: PayslipPdfInput): string {
  const breakdown = buildPayslipBreakdown({
    gross: input.payslip.gross,
    allowances: input.payslip.allowances,
    overtime: input.payslip.overtime,
    commission: input.payslip.commission,
    deductions: input.payslip.deductions,
    advanceDeduction: input.payslip.advanceDeduction,
    socialSecurityEmployee: input.payslip.socialSecurityEmployee,
    incomeTax: input.payslip.incomeTax,
    net: input.payslip.net,
  });
  const lines: readonly (readonly [string, string, boolean])[] = [
    ["الأجر الإجمالي (يشمل المخصصات)", amount(breakdown.gross), true],
    ["منه المخصصات (معلومة ضمن الإجمالي)", amount(breakdown.allowances), breakdown.allowances !== "0.00"],
    ["الأجر الإضافي", amount(breakdown.overtime), breakdown.overtime !== "0.00"],
    ["العمولات", amount(breakdown.commission), breakdown.commission !== "0.00"],
    ["استقطاع السلف", amount(breakdown.advanceDeduction), breakdown.advanceDeduction !== "0.00"],
    ["خفض الأجر وخصومات أخرى", amount(breakdown.otherDeductions), breakdown.otherDeductions !== "0.00"],
    ["ضمان الموظف", amount(breakdown.socialSecurityEmployee), breakdown.socialSecurityEmployee !== "0.00"],
    ["ضريبة الدخل", amount(breakdown.incomeTax), breakdown.incomeTax !== "0.00"],
    ["إجمالي الاستقطاع", amount(breakdown.totalDeductions), true],
  ];
  const rows = lines
    .filter(([, , visible]) => visible)
    .map(([label, value]) => `
    <tr><th>${escapeHtml(label)}</th><td dir="ltr">${escapeHtml(value)}</td></tr>`)
    .join("");
  const mismatch = !breakdown.allowancesValid || !breakdown.deductionComponentsValid || !breakdown.netMatches;

  return `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8" />
<style>
  @page { margin: 18mm 14mm; }
  body { color: #1f2933; direction: rtl; font-family: Arial, sans-serif; font-size: 12px; line-height: 1.55; }
  h1 { color: #0f6a55; font-size: 20px; margin: 0 0 6px; }
  p { margin: 0 0 8px; } table { border-collapse: collapse; margin-top: 16px; width: 100%; }
  th { background: #f5f8f6; color: #263631; font-weight: 600; width: 58%; } th, td { border: 1px solid #ccd8d2; padding: 8px; text-align: right; }
  .net th, .net td { background: #eaf4ef; color: #124f41; font-size: 14px; font-weight: 700; }
  .equation { background: #f5f8f6; border: 1px solid #ccd8d2; margin-top: 12px; padding: 9px; }
  .equation strong { display: block; margin-bottom: 3px; }
  .equation .numbers { direction: ltr; font-weight: 700; text-align: left; }
  .warning { color: #b42318; font-weight: 700; margin-top: 6px; }
  .notice { color: #5d6b65; font-size: 10px; margin-top: 18px; }
</style></head><body>
  <h1>قسيمة راتب شخصية</h1>
  <p><strong>الموظف:</strong> ${escapeHtml(input.employeeName)}</p>
  <p><strong>الفترة:</strong> ${escapeHtml(input.payslip.period)} · <strong>الحالة:</strong> ${input.payslip.status === "paid" ? "مصروف" : "معتمد"}</p>
  <table><tbody>${rows}
    <tr class="net"><th>صافي الراتب</th><td dir="ltr">${escapeHtml(amount(breakdown.net))}</td></tr>
  </tbody></table>
  <div class="equation"><strong>معادلة الصافي</strong>
    <div>الأجر الإجمالي + الإضافي + العمولة − إجمالي الاستقطاع = الصافي</div>
    <div class="numbers">${escapeHtml(amount(breakdown.gross))} + ${escapeHtml(amount(breakdown.overtime))} + ${escapeHtml(amount(breakdown.commission))} − ${escapeHtml(amount(breakdown.totalDeductions))} = ${escapeHtml(amount(breakdown.expectedNet))}</div>
    ${mismatch ? '<div class="warning">توجد مكونات غير متطابقة في لقطة القسيمة. راجع قسم الموارد البشرية.</div>' : ""}
  </div>
  <p class="notice">هذا كشف شخصي يُنشأ بعد تحقق ثنائي جديد ويُشارك فقط بطلبك من تطبيق سوبر العربية.</p>
</body></html>`;
}
