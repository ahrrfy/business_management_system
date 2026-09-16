import type { MobilePayslip } from "@/lib/secureTransportPayload";

import { formatIqd } from "./format";

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
  const lines: readonly (readonly [string, string])[] = [
    ["الأجر الإجمالي", amount(input.payslip.gross)],
    ["البدلات", amount(input.payslip.allowances)],
    ["الإضافي", amount(input.payslip.overtime)],
    ["العمولات", amount(input.payslip.commission)],
    ["الاستقطاعات", amount(input.payslip.deductions)],
    ["منها السلف", amount(input.payslip.advanceDeduction)],
    ["ضمان الموظف", amount(input.payslip.socialSecurityEmployee)],
    ["ضريبة الدخل", amount(input.payslip.incomeTax)],
  ];
  const rows = lines.map(([label, value]) => `
    <tr><th>${escapeHtml(label)}</th><td dir="ltr">${escapeHtml(value)}</td></tr>`).join("");

  return `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8" />
<style>
  @page { margin: 18mm 14mm; }
  body { color: #1f2933; direction: rtl; font-family: Arial, sans-serif; font-size: 12px; line-height: 1.55; }
  h1 { color: #0f6a55; font-size: 20px; margin: 0 0 6px; }
  p { margin: 0 0 8px; } table { border-collapse: collapse; margin-top: 16px; width: 100%; }
  th { background: #f5f8f6; color: #263631; font-weight: 600; width: 58%; } th, td { border: 1px solid #ccd8d2; padding: 8px; text-align: right; }
  .net th, .net td { background: #eaf4ef; color: #124f41; font-size: 14px; font-weight: 700; }
  .notice { color: #5d6b65; font-size: 10px; margin-top: 18px; }
</style></head><body>
  <h1>قسيمة راتب شخصية</h1>
  <p><strong>الموظف:</strong> ${escapeHtml(input.employeeName)}</p>
  <p><strong>الفترة:</strong> ${escapeHtml(input.payslip.period)} · <strong>الحالة:</strong> ${input.payslip.status === "paid" ? "مصروف" : "معتمد"}</p>
  <table><tbody>${rows}
    <tr class="net"><th>صافي الراتب</th><td dir="ltr">${escapeHtml(amount(input.payslip.net))}</td></tr>
  </tbody></table>
  <p class="notice">هذا كشف شخصي يُنشأ بعد تحقق ثنائي جديد ويُشارك فقط بطلبك من تطبيق سوبر العربية.</p>
</body></html>`;
}
