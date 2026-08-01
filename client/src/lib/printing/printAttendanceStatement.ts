/* ============================================================================
 * كشف حضور الموظف — A4 بالتصميم المرجعي V2
 * (client/src/lib/printing/printAttendanceStatement.ts)
 *
 * قرار المالك (٣١/٧): «أريد لكل يوم ساعاته من ساعة إلى ساعة وأجر الساعة لهذا اليوم»،
 * و«المجموع التراكميّ لأيام الشهر هو الراتب الذي يستحقّه».
 *
 * الكشف يعرض صفّاً لكل يوم دوام بحالته، فيرى الموظف **سببَ** أجره لا رقمه فقط —
 * ويرى المديرُ الأيامَ الموسومة «يحتاج تصحيح» قبل إغلاق الشهر.
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

export interface StatementDay {
  date: string;
  dayName: string;
  scheduledHours: string;
  attendedHours: string;
  countedHours: string;
  overtimeHours: string;
  rate: string;
  amount: string;
  state: "present" | "absent" | "paidLeave" | "unpaidLeave" | "beforeStart" | "restWorked";
  checkIn?: string | null;
  checkOut?: string | null;
  needsReview?: boolean;
}

export interface AttendanceStatementData {
  employeeName: string;
  employeeId: number;
  position?: string | null;
  department?: string | null;
  branchName?: string | null;
  period: string;
  from: string;
  to: string;
  totals: {
    scheduledHours: string;
    payableHours: string;
    unpaidHours: string;
    basePay: string;
    overtimeHours: string;
    overtimePay: string;
    absentDays: number;
    unpaidLeaveDays: number;
    shortHours: string;
    reviewDays: number;
  };
  settings?: CompanySettings;
}

const STATE_LABEL: Record<StatementDay["state"], string> = {
  present: "حضور",
  absent: "غياب",
  paidLeave: "إجازة مدفوعة",
  unpaidLeave: "إجازة بلا راتب",
  beforeStart: "قبل السريان",
  restWorked: "عمل يوم راحة",
};

export function printAttendanceStatement(d: AttendanceStatementData, days: StatementDay[]): boolean {
  const header = pageHeader(
    {
      title: "كشف حضور ودوام",
      subtitle: "تفصيل يوميّ — الساعات وسعر الساعة وأجر كل يوم",
      fields: [
        { label: "الشهر", value: d.period },
        { label: "الفترة", value: `${d.from} ← ${d.to}` },
      ],
      badge: d.totals.reviewDays > 0
        ? { label: `${d.totals.reviewDays} يوم يحتاج تصحيح`, color: "#B7791F" }
        : { label: "مكتمل", color: "#0D6B52" },
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
      title: "ملخّص الشهر",
      variant: "gray",
      fields: [
        { label: "ساعات مقرَّرة", value: `${fmt(d.totals.scheduledHours)} ساعة` },
        { label: "ساعات مستحقّة", value: `${fmt(d.totals.payableHours)} ساعة` },
        { label: "غياب", value: `${d.totals.absentDays} يوم` },
        { label: "إجازة بلا راتب", value: `${d.totals.unpaidLeaveDays} يوم` },
        { label: "نقص ساعات", value: `${fmt(d.totals.shortHours)} ساعة` },
        { label: "أوفر تايم", value: `${fmt(d.totals.overtimeHours)} ساعة` },
      ],
    },
  ]);

  const table = docTableV2(
    [
      { key: "date", label: "التاريخ", width: 78 },
      { key: "day", label: "اليوم", width: 62 },
      { key: "inOut", label: "من ← إلى", width: 92 },
      { key: "sched", label: "مقرَّر", width: 52 },
      { key: "counted", label: "محتسَب", width: 56 },
      { key: "ot", label: "إضافي", width: 52 },
      { key: "rate", label: "سعر الساعة", width: 78 },
      { key: "amount", label: "أجر اليوم", width: 86, emphasize: true },
      { key: "state", label: "الحالة", width: 82 },
    ],
    days.map((x) => ({
      date: x.date,
      day: x.dayName,
      inOut: x.checkIn ? `${x.checkIn} ← ${x.checkOut ?? "—"}` : "—",
      sched: fmt(x.scheduledHours),
      counted: fmt(x.countedHours),
      ot: Number(x.overtimeHours) > 0 ? fmt(x.overtimeHours) : "—",
      rate: fmt(x.rate),
      amount: fmt(x.amount),
      state: `${STATE_LABEL[x.state]}${x.needsReview ? " ⚠" : ""}`.replace("⚠", "(يحتاج تصحيح)"),
    })),
    { hideIndex: true },
  );

  const otNote =
    Number(d.totals.overtimePay) > 0
      ? `<div style="margin-top:8px;padding:6px 14px;border:1px dashed #0D6B52;border-radius:4px;background:#F0FDF4">
          <span style="font-size:10.75px;font-weight:800;color:#0D6B52">أوفر تايم (بندٌ مستقلّ): </span>
          <span style="font-size:12.25px;font-weight:800;color:#0D6B52;direction:ltr;unicode-bidi:isolate">${esc(fmt(d.totals.overtimePay))} د.ع</span>
          <span style="font-size:10.25px;color:#000"> — ${esc(fmt(d.totals.overtimeHours))} ساعة فوق المقرَّر اليوميّ، لا تدخل الأجر الأساس.</span>
        </div>`
      : "";

  const reviewNote =
    d.totals.reviewDays > 0
      ? `<div style="margin-top:8px;padding:6px 14px;border:1px dashed #B7791F;border-radius:4px;background:#FFFBEB">
          <span style="font-size:10.75px;font-weight:800;color:#B7791F">${d.totals.reviewDays} يوم يحتاج تصحيح: </span>
          <span style="font-size:10.25px;color:#000">بصمةُ خروجٍ ناقصة أو ساعاتٌ تجاوزت السقف المعقول — تُصحَّح أوقاتها يدوياً قبل اعتماد المسيّر.</span>
        </div>`
      : "";

  const grand = grandTotalBar("الأجر المستحقّ عن الشهر (أساس + أوفر تايم)", fmt(String(Number(d.totals.basePay) + Number(d.totals.overtimePay))), { big: true });
  const tafqit = tafqitLine(formatArabicMoneyWords(String(Number(d.totals.basePay) + Number(d.totals.overtimePay))));

  const signatures = `<div style="margin-top:26px;display:flex;justify-content:space-between;gap:24px">
    ${["الموظف", "مسؤول الموارد البشرية", "المدير المفوَّض"]
      .map(
        (l) => `<div style="flex:1;text-align:center">
          <div style="height:32px"></div>
          <div style="border-top:1px solid #0F1613;padding-top:5px;font-size:10.25px;color:#000;font-weight:600">${esc(l)}</div>
        </div>`,
      )
      .join("")}
  </div>
  <div style="margin-top:10px;font-size:9.75px;color:#8B8E89">كشفُ احتسابٍ من سجلّ البصمات — الصرف عبر مسيّر الرواتب الشهري باعتماده المزدوج.</div>`;

  const body = `${pageBodyOpen()}${header}${cards}${table}${otNote}${reviewNote}${grand}${tafqit}${signatures}${pageBodyClose()}${pageFooter(
    d.settings,
    { rightText: `REF ATT/${d.period}/EMP-${d.employeeId}` },
  )}`;
  return openPrintWindow(wrapA4Doc(`كشف حضور ${d.employeeName} — ${d.period}`, body));
}
