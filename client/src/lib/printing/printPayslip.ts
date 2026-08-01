/* ============================================================================
 * كشف راتب الموظف — A4 بالتصميم المرجعي V2 (client/src/lib/printing/printPayslip.ts)
 *
 * كان النظام يحتسب الرواتب ويصرفها بلا كشفٍ يستلمه الموظف — فجوةٌ رصدها تدقيق ٣١/٧
 * (لا قالب payslip في lib/printing إطلاقاً). الكشف بيانُ احتسابٍ لا سند صرف: الصرف
 * يمرّ بمسيّر الرواتب واعتماده المزدوج.
 *
 * يعرض الاستحقاق والاستقطاع مفصَّلَين ثم الصافي بالتفقيط، ويُظهر تفصيل «الأجر بالحضور»
 * (ساعات مستحقّة من مقرَّرة × سعر الساعة) حين يكون مفعَّلاً — فالموظف يرى **لماذا** نقص
 * أجره بالساعات والأيام لا بمبلغٍ غامض.
 * ========================================================================== */
import {
  docTableV2,
  grandTotalBar,
  infoCards,
  pageBodyClose,
  pageBodyOpen,
  pageFooter,
  pageHeader,
  tafqitLine,
  wrapA4Doc,
  type CompanySettings,
} from "./docHtml";
import { esc, fmt, openPrintWindow } from "./brand";
import { formatArabicMoneyWords } from "./tafqit";

export interface PayslipData {
  runId: number;
  period: string; // YYYY-MM
  statusLabel: string; // «مسودة» | «معتمد» | «مدفوع»
  employeeName: string;
  employeeId: number;
  position?: string | null;
  department?: string | null;
  branchName?: string | null;
  payTypeLabel: string;
  baseSalary?: string | null;
  /** ساعات مستحقّة (الساعيّ دائماً، والشهريّ عند تفعيل الأجر بالحضور). */
  hours?: string | null;
  gross: string;
  overtime: string;
  commission: string;
  deductions: string;
  advanceDeduction?: string | null;
  socialSecurityEmployee?: string | null;
  incomeTax?: string | null;
  net: string;
  /** ملاحظة الاحتساب (تفصيل الأجر بالحضور أو خصم الإجازة) — تُعرض كما هي للشفافية. */
  note?: string | null;
  paidAt?: string | null;
  settings?: CompanySettings;
}

/** بند في جدول الاستحقاق/الاستقطاع — يُطوى إن كان صفراً فلا يزحم الكشف. */
function line(label: string, value: string | null | undefined, kind: "earn" | "deduct"): {
  bandLabel: string;
  amount: string;
  _n: number;
  _kind: string;
} | null {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n === 0) return null;
  return { bandLabel: label, amount: fmt(String(Math.abs(n))), _n: Math.abs(n), _kind: kind };
}

export function printPayslip(d: PayslipData): boolean {
  const header = pageHeader(
    {
      title: "كشف راتب",
      subtitle: "بيان احتساب الأجر الشهري — الاستحقاق والاستقطاع والصافي",
      fields: [
        { label: "الشهر", value: d.period },
        { label: "رقم المسيّر", value: `PR-${d.runId}` },
        ...(d.paidAt ? [{ label: "تاريخ الصرف", value: d.paidAt }] : []),
      ],
      badge: {
        label: d.statusLabel,
        color: d.statusLabel === "مدفوع" ? "#0D6B52" : d.statusLabel === "معتمد" ? "#1D4ED8" : "#B7791F",
      },
    },
    d.settings,
  );

  const cards = infoCards([
    {
      title: "الموظف",
      variant: "green",
      fields: [
        { label: "الاسم", value: d.employeeName },
        { label: "الرقم", value: `EMP-${d.employeeId}` },
        { label: "الوظيفة", value: d.position || "—" },
        { label: "القسم", value: d.department || "—" },
        { label: "الفرع", value: d.branchName || "—" },
      ],
    },
    {
      title: "أساس الاحتساب",
      variant: "gray",
      fields: [
        { label: "طريقة الأجر", value: d.payTypeLabel },
        ...(d.baseSalary != null && Number(d.baseSalary) > 0
          ? [{ label: "الراتب الأساس", value: `${fmt(d.baseSalary)} د.ع` }]
          : []),
        ...(d.hours != null && Number(d.hours) > 0 ? [{ label: "الساعات المستحقّة", value: `${fmt(d.hours)} ساعة` }] : []),
      ],
    },
  ]);

  const earnings = [
    line("الأجر الأساس والمخصّصات", d.gross, "earn"),
    line("عمل إضافي", d.overtime, "earn"),
    line("عمولة مبيعات", d.commission, "earn"),
  ].filter(Boolean) as Array<{ bandLabel: string; amount: string; _n: number }>;

  const deducts = [
    line("استقطاع سلفة", d.advanceDeduction, "deduct"),
    line("ضمان اجتماعي (حصة الموظف)", d.socialSecurityEmployee, "deduct"),
    line("ضريبة الدخل", d.incomeTax, "deduct"),
  ].filter(Boolean) as Array<{ bandLabel: string; amount: string; _n: number }>;

  // الفارق بين إجمالي الاستقطاع والبنود المسمّاة = خصومات أخرى (إجازة بلا راتب…)
  const namedDeduct = deducts.reduce((s, x) => s + x._n, 0);
  const otherDeduct = Number(d.deductions ?? 0) - namedDeduct;
  if (otherDeduct > 0.004) {
    deducts.push({ bandLabel: "خصومات أخرى (إجازة/غياب)", amount: fmt(String(otherDeduct)), _n: otherDeduct });
  }

  const totalEarn = earnings.reduce((s, x) => s + x._n, 0);

  const table = docTableV2(
    [
      { key: "band", label: "البند", width: 320 },
      { key: "earn", label: "استحقاق", width: 130 },
      { key: "deduct", label: "استقطاع", width: 130, color: "#B42318" },
    ],
    [
      ...earnings.map((e) => ({ band: e.bandLabel, earn: e.amount, deduct: "—" })),
      ...deducts.map((x) => ({ band: x.bandLabel, earn: "—", deduct: `−${x.amount}` })),
      {
        band: "المجموع",
        earn: fmt(String(totalEarn)),
        deduct: Number(d.deductions) > 0 ? `−${fmt(d.deductions)}` : "—",
      },
    ],
    { hideIndex: true },
  );

  // ملاحظة الاحتساب — مصدرها بند المسيّر نفسه (تفصيل الأجر بالحضور/الإجازة).
  const noteBox = d.note
    ? `<div style="margin-top:8px;padding:6px 14px;border:1px dashed #1D4ED8;border-radius:4px;background:#EFF6FF">
        <span style="font-size:10.75px;font-weight:800;color:#1D4ED8">تفصيل الاحتساب: </span>
        <span style="font-size:10.5px;color:#000">${esc(d.note)}</span>
      </div>`
    : "";

  const grand = grandTotalBar("صافي المستحقّ", fmt(d.net), { big: true });
  const tafqit = tafqitLine(formatArabicMoneyWords(d.net));

  const signatures = `<div style="margin-top:30px;display:flex;justify-content:space-between;gap:24px">
    ${["الموظف (استلمت)", "المحاسب", "المدير المفوَّض"]
      .map(
        (l) => `<div style="flex:1;text-align:center">
          <div style="height:34px"></div>
          <div style="border-top:1px solid #0F1613;padding-top:5px;font-size:10.25px;color:#000;font-weight:600">${esc(l)}</div>
        </div>`,
      )
      .join("")}
  </div>
  <div style="margin-top:10px;font-size:9.75px;color:#8B8E89">هذا الكشف بيان احتساب — الصرف يتمّ عبر مسيّر الرواتب باعتماده المزدوج.</div>`;

  const body = `${pageBodyOpen()}${header}${cards}${table}${noteBox}${grand}${tafqit}${signatures}${pageBodyClose()}${pageFooter(
    d.settings,
    { rightText: `REF PR-${d.runId}/${d.period}/EMP-${d.employeeId}` },
  )}`;
  return openPrintWindow(wrapA4Doc(`كشف راتب ${d.employeeName} — ${d.period}`, body));
}
