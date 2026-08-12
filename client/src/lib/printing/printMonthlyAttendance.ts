/* ============================================================================
 * تقرير الحضور الشهريّ لكل الموظفين — A4 عرضيّ (landscape)
 * (client/src/lib/printing/printMonthlyAttendance.ts)
 *
 * أعمدةٌ كثيرة ⇒ صفحةٌ عرضية، وأرقامٌ بمنزلتين ثابتتين ومحاذاةٍ يسارية موحّدة
 * (tabular) فتُقرأ الأعمدة رأسياً بلا تعثّر.
 * ========================================================================== */
import {
  docTableV2,
  grandTotalBar,
  pageBodyClose,
  pageBodyOpen,
  pageFooter,
  pageHeader,
  tafqitLine,
  wrapA4Doc,
  type CompanySettings,
} from "./docHtml";
import { fmt, openPrintWindow } from "./brand";
import { formatArabicMoneyWords } from "./tafqit";

export interface MonthlyRow {
  employeeId: number;
  employeeName: string;
  position?: string | null;
  department?: string | null;
  scheduledHours: string;
  payableHours: string;
  absentDays: number;
  unpaidLeaveDays: number;
  overtimeHours: string;
  restWorkedHours: string;
  hourlyRate: string;
  totalDue: string;
  reviewDays: number;
}

export interface MonthlyAttendanceData {
  period: string;
  rows: MonthlyRow[];
  totals: {
    employees: number;
    payableHours: string;
    overtimeHours: string;
    restWorkedHours: string;
    absentDays: number;
    reviewDays: number;
    totalDue: string;
  };
  settings?: CompanySettings;
}

const h2 = (v: string | number) => Number(v).toFixed(2);

export function printMonthlyAttendance(d: MonthlyAttendanceData): boolean {
  const header = pageHeader(
    {
      title: "تقرير الحضور الشهريّ",
      subtitle: "الساعات المقرَّرة والمستحقّة والغياب والإضافيّ والمستحقّ — لكل الموظفين",
      fields: [
        { label: "الشهر", value: d.period },
        { label: "عدد الموظفين", value: String(d.totals.employees) },
      ],
      badge:
        d.totals.reviewDays > 0
          ? { label: `${d.totals.reviewDays} يوم يحتاج تصحيح`, color: "#B7791F" }
          : { label: "مكتمل", color: "#0D6B52" },
    },
    d.settings,
  );

  const table = docTableV2(
    [
      { key: "name", label: "الموظف", width: 150 },
      { key: "dept", label: "القسم", width: 88 },
      { key: "sched", label: "مقرَّر", width: 58 },
      { key: "payable", label: "مستحقّ", width: 62, emphasize: true },
      { key: "absent", label: "غياب", width: 46 },
      { key: "leave", label: "بلا راتب", width: 56 },
      { key: "ot", label: "إضافيّ", width: 54 },
      { key: "rest", label: "يوم راحة", width: 58 },
      { key: "rate", label: "سعر الساعة", width: 76 },
      { key: "due", label: "المستحقّ", width: 92, emphasize: true },
      { key: "rev", label: "تصحيح", width: 50 },
    ],
    d.rows.map((r) => ({
      name: r.employeeName,
      dept: r.department || "—",
      sched: h2(r.scheduledHours),
      payable: h2(r.payableHours),
      absent: String(r.absentDays || "—"),
      leave: String(r.unpaidLeaveDays || "—"),
      ot: Number(r.overtimeHours) > 0 ? h2(r.overtimeHours) : "—",
      rest: Number(r.restWorkedHours) > 0 ? h2(r.restWorkedHours) : "—",
      rate: fmt(r.hourlyRate),
      due: fmt(r.totalDue),
      rev: String(r.reviewDays || "—"),
    })),
    { hideIndex: false },
  );

  const summary = `<div style="margin-top:8px;display:flex;gap:10px;flex-wrap:wrap">
    ${[
      ["ساعات مستحقّة", h2(d.totals.payableHours)],
      ["أوفر تايم", h2(d.totals.overtimeHours)],
      ["عمل أيام الراحة", h2(d.totals.restWorkedHours)],
      ["أيام غياب", String(d.totals.absentDays)],
    ]
      .map(
        ([l, v]) => `<div style="flex:1;min-width:110px;border:1px solid #D9DDD8;border-radius:4px;padding:5px 8px">
          <div style="font-size:9.5px;color:#8B8E89">${l}</div>
          <div style="font-size:12.5px;font-weight:800;direction:ltr;unicode-bidi:isolate">${v}</div>
        </div>`,
      )
      .join("")}
  </div>`;

  const grand = grandTotalBar("إجمالي المستحقّ عن الشهر", fmt(d.totals.totalDue), { big: true });
  const tafqit = tafqitLine(formatArabicMoneyWords(d.totals.totalDue));

  const note = `<div style="margin-top:10px;font-size:9.75px;color:#8B8E89">
    يُحتسب هذا التقرير بنواة مسيّر الرواتب نفسها ⇒ أرقامه مطابقة لكشف كل موظف ولما يُدفع فعلاً.
    وهو بيانُ احتسابٍ لا سند صرف — الصرف عبر المسيّر الشهريّ باعتماده المزدوج.
  </div>`;

  const body = `${pageBodyOpen()}${header}${table}${summary}${grand}${tafqit}${note}${pageBodyClose()}${pageFooter(
    d.settings,
    { rightText: `REF ATT-M/${d.period}` },
  )}`;
  return openPrintWindow(wrapA4Doc(`تقرير الحضور الشهريّ — ${d.period}`, body, { orientation: "landscape" }));
}
