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
  overtimeAmount?: string;
  totalAmount?: string;
  state: "present" | "absent" | "open" | "paidLeave" | "unpaidLeave" | "beforeStart" | "restWorked";
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
    openDays?: number;
    unpaidLeaveDays: number;
    shortHours: string;
    reviewDays: number;
  };
  /** المستحقّ الفعليّ عن الشهر وأساسُه (من الخادم) — غيابهما ⇒ حساب الحضور كما كان. */
  amountDue?: string;
  dueBasis?: "hourly" | "exempt" | "attendance" | "fixedSalary" | "payrollSnapshot";
  /**
   * لقطةُ الشهر المصروف (ق٣) — وجودُها يعني أن `amountDue` مجمَّدٌ من المسيّر. الورقة
   * المطبوعة تُسلَّم للموظف بيده، فيلزمها أن تقول **صراحةً** إنها تعرض ما صُرف لا ما
   * يُشتقّ اليوم، وأن تُظهر الصافي المدفوع وما استُقطع منه.
   */
  payrollSnapshot?: {
    status: "approved" | "paid";
    gross: string;
    allowances: string;
    overtime: string;
    commission: string;
    deductions: string;
    net: string;
  } | null;
  settings?: CompanySettings;
}

const STATE_LABEL: Record<StatementDay["state"], string> = {
  present: "حضور",
  absent: "غياب",
  open: "ينقص انصراف",
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
      { key: "checkIn", label: "من", width: 52 },
      { key: "checkOut", label: "إلى", width: 52 },
      { key: "sched", label: "مقرَّر", width: 48 },
      { key: "counted", label: "محتسَب", width: 52 },
      { key: "ot", label: "إضافي", width: 48 },
      { key: "rate", label: "سعر الساعة", width: 70 },
      { key: "amount", label: "أجر أساس", width: 74 },
      { key: "otAmount", label: "أجر إضافي", width: 74 },
      { key: "total", label: "إجمالي اليوم", width: 82, emphasize: true },
      { key: "state", label: "الحالة", width: 78 },
    ],
    days.map((x) => ({
      date: x.date,
      day: x.dayName,
      checkIn: x.checkIn ?? "—",
      checkOut: x.checkOut ?? "—",
      sched: fmt(x.scheduledHours),
      counted: fmt(x.countedHours),
      ot: Number(x.overtimeHours) > 0 ? fmt(x.overtimeHours) : "—",
      rate: fmt(x.rate),
      amount: fmt(x.amount),
      otAmount: Number(x.overtimeAmount ?? 0) > 0 ? fmt(x.overtimeAmount!) : "—",
      total: fmt(x.totalAmount ?? x.amount),
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

  const exemptNote =
    d.dueBasis === "exempt"
      ? `<div style="margin-top:8px;padding:6px 14px;border:1px dashed #B7791F;border-radius:4px;background:#FFFBEB">
          <span style="font-size:10.75px;font-weight:800;color:#B7791F">راتب ثابت — لا يخضع للحضور: </span>
          <span style="font-size:10.25px;color:#000">يُصرف راتبه ومخصّصاته كاملةً بلا احتساب ساعات. الجدول أعلاه للاطّلاع لا للاحتساب.</span>
        </div>`
      : "";

  /*
   * الشهر المصروف (ق٣): الورقة تُسلَّم بيد الموظف، فتقول صراحةً إن الرقم **من المسيّر** لا
   * مشتقٌّ من راتبٍ وجدولٍ قد تغيّرا بعده — وتُظهر معه الصافي المدفوع وما استُقطع، وإلّا
   * قُرئ الفرقُ بين الإجماليّ وما قبضه بيده خطأً في النظام أو نقصاً في حقّه.
   */
  const snap = d.payrollSnapshot;
  const frozenNote = snap
    ? `<div style="margin-top:8px;padding:6px 14px;border:1px dashed #1D4ED8;border-radius:4px;background:#EFF6FF">
          <span style="font-size:10.75px;font-weight:800;color:#1D4ED8">الشهر ${snap.status === "paid" ? "مدفوع" : "معتمد"} — الأرقام من المسيّر: </span>
          <span style="font-size:10.25px;color:#000">هذه أرقام مسيّر الشهر كما اعتُمدت، لا تتغيّر بتعديلٍ لاحق على الراتب أو الجدول. الأجر الإجماليّ ${esc(fmt(snap.gross))} د.ع${Number(snap.overtime) > 0 ? ` + أوفر تايم ${esc(fmt(snap.overtime))} د.ع` : ""}${Number(snap.commission) > 0 ? ` + عمولة ${esc(fmt(snap.commission))} د.ع` : ""}${Number(snap.deductions) > 0 ? `، استقطاع ${esc(fmt(snap.deductions))} د.ع` : ""} ⇐ <b>الصافي ${esc(fmt(snap.net))} د.ع</b>. الجدول أعلاه تفصيلٌ للاطّلاع.</span>
        </div>`
    : "";

  const reviewNote =
    d.totals.reviewDays > 0
      ? `<div style="margin-top:8px;padding:6px 14px;border:1px dashed #B7791F;border-radius:4px;background:#FFFBEB">
          <span style="font-size:10.75px;font-weight:800;color:#B7791F">${d.totals.reviewDays} يوم يحتاج تصحيح: </span>
          <span style="font-size:10.25px;color:#000">بصمةُ خروجٍ ناقصة أو ساعاتٌ تجاوزت السقف المعقول — تُصحَّح أوقاتها يدوياً قبل اعتماد المسيّر.</span>
        </div>`
      : "";

  /*
   * المستحقّ من الخادم بأساسه — لا مجموعَ حساب الحضور دائماً: المُعفى (راتبٌ ثابت) يُطبَع
   * له راتبُه لا صفرُ بصماته، ومن كان الأجر بالحضور معطَّلاً عنه يُطبَع له ما سيُصرف فعلاً.
   */
  const dueAmount = d.amountDue ?? String(Number(d.totals.basePay) + Number(d.totals.overtimePay));
  const dueLabel =
    d.dueBasis === "payrollSnapshot"
      ? `الأجر المستحقّ عن الشهر (من مسيّر ${d.payrollSnapshot?.status === "paid" ? "مدفوع" : "معتمد"})`
      : d.dueBasis === "exempt"
        ? "الراتب الثابت المستحقّ عن الشهر (لا يخضع للحضور)"
        : d.dueBasis === "fixedSalary"
          ? "الراتب الثابت المستحقّ عن الشهر (الأجر بالحضور غير مفعَّل)"
          : d.dueBasis === "hourly"
            ? "الأجر المستحقّ عن الشهر (بالساعة من سجلّ الحضور)"
            : "الأجر المستحقّ عن الشهر (أساس + أوفر تايم)";
  const grand = grandTotalBar(dueLabel, fmt(dueAmount), { big: true });
  const tafqit = tafqitLine(formatArabicMoneyWords(dueAmount));

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

  const body = `${pageBodyOpen()}${header}${cards}${table}${otNote}${exemptNote}${frozenNote}${reviewNote}${grand}${tafqit}${signatures}${pageBodyClose()}${pageFooter(
    d.settings,
    { rightText: `REF ATT/${d.period}/EMP-${d.employeeId}` },
  )}`;
  return openPrintWindow(wrapA4Doc(`كشف حضور ${d.employeeName} — ${d.period}`, body));
}
