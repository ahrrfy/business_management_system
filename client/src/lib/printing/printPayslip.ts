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
import { D, round2 } from "@/lib/money";

export interface PayslipData {
  runId: number;
  period: string; // YYYY-MM
  statusLabel: string; // «مسوّدة» | «معتمد» | «مدفوع»
  employeeName: string;
  employeeId: number;
  position?: string | null;
  department?: string | null;
  branchName?: string | null;
  revisionNo?: number | null;
  accrualDate?: string | null;
  legalPolicyHash?: string | null;
  approvalSnapshotHash?: string | null;
  itemSnapshotHash?: string | null;
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
  socialSecurityEmployer?: string | null;
  endOfServiceAccrual?: string | null;
  net: string;
  /** ملاحظة الاحتساب (تفصيل الأجر بالحضور أو خصم الإجازة) — تُعرض كما هي للشفافية. */
  note?: string | null;
  paidAt?: string | null;
  paidAmount?: string | null;
  paymentMethod?: string | null;
  paymentReference?: string | null;
  receiptId?: number | null;
  settings?: CompanySettings;
}

/** بند في جدول الاستحقاق/الاستقطاع — يُطوى إن كان صفراً فلا يزحم الكشف. */
function line(label: string, value: string | null | undefined, kind: "earn" | "deduct"): {
  bandLabel: string;
  amount: string;
  _n: string;
  _kind: string;
} | null {
  const n = D(value ?? 0);
  if (n.isZero()) return null;
  const absolute = round2(n.abs()).toFixed(2);
  return { bandLabel: label, amount: fmt(absolute), _n: absolute, _kind: kind };
}

export function printPayslip(d: PayslipData): boolean {
  const header = pageHeader(
    {
      title: "كشف راتب",
      subtitle: "بيان احتساب الأجر الشهري — الاستحقاق والاستقطاع والصافي",
      fields: [
        { label: "الشهر", value: d.period },
        { label: "رقم المسيّر", value: `PR-${d.runId}` },
        ...(d.revisionNo != null ? [{ label: "المراجعة", value: `R${d.revisionNo}` }] : []),
        ...(d.accrualDate ? [{ label: "تاريخ الاستحقاق", value: d.accrualDate }] : []),
        ...(d.paidAt ? [{ label: "تاريخ الصرف الفعلي", value: d.paidAt }] : []),
        ...(d.receiptId ? [{ label: "مستند الصرف", value: `REC-${d.receiptId}` }] : []),
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
        ...(d.baseSalary != null && D(d.baseSalary).gt(0)
          ? [{ label: "الراتب الأساس", value: `${fmt(d.baseSalary)} د.ع` }]
          : []),
        ...(d.hours != null && D(d.hours).gt(0) ? [{ label: "الساعات المستحقّة", value: `${fmt(d.hours)} ساعة` }] : []),
        ...(d.paymentMethod ? [{ label: "طريقة الصرف", value: d.paymentMethod }] : []),
        ...(d.paymentReference ? [{ label: "مرجع الصرف", value: d.paymentReference }] : []),
      ],
    },
  ]);

  const earnings = [
    line("الأجر الأساس والمخصّصات", d.gross, "earn"),
    line("عمل إضافي", d.overtime, "earn"),
    line("عمولة مبيعات", d.commission, "earn"),
  ].filter(Boolean) as Array<{ bandLabel: string; amount: string; _n: string }>;

  const deducts = [
    line("استقطاع سلفة", d.advanceDeduction, "deduct"),
    line("ضمان اجتماعي (حصة الموظف)", d.socialSecurityEmployee, "deduct"),
    line("ضريبة الدخل", d.incomeTax, "deduct"),
  ].filter(Boolean) as Array<{ bandLabel: string; amount: string; _n: string }>;

  // الفارق بين إجمالي الاستقطاع والبنود المسمّاة = خصومات أخرى (إجازة بلا راتب…)
  const namedDeduct = deducts.reduce((sum, item) => sum.plus(D(item._n)), D(0));
  const otherDeduct = round2(D(d.deductions ?? 0).minus(namedDeduct));
  if (otherDeduct.gt(0)) {
    const amount = otherDeduct.toFixed(2);
    deducts.push({ bandLabel: "خصومات أخرى (إجازة/غياب)", amount: fmt(amount), _n: amount });
  }

  const totalEarn = round2(earnings.reduce((sum, item) => sum.plus(D(item._n)), D(0))).toFixed(2);

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
        deduct: D(d.deductions).gt(0) ? `−${fmt(d.deductions)}` : "—",
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

  const employerLiabilities = D(d.socialSecurityEmployer ?? 0).gt(0) || D(d.endOfServiceAccrual ?? 0).gt(0)
    ? `<div style="margin-top:8px;padding:8px 14px;border:1px solid #CBD5E1;border-radius:4px;background:#F8FAFC">
        <div style="font-size:10.75px;font-weight:800;color:#334155;margin-bottom:4px">التزامات على الشركة — لا تُخصم من الموظف</div>
        ${D(d.socialSecurityEmployer ?? 0).gt(0) ? `<div style="font-size:10.25px">حصة رب العمل في الضمان: <b>${fmt(d.socialSecurityEmployer!)} د.ع</b></div>` : ""}
        ${D(d.endOfServiceAccrual ?? 0).gt(0) ? `<div style="font-size:10.25px">استحقاق نهاية الخدمة للفترة: <b>${fmt(d.endOfServiceAccrual!)} د.ع</b></div>` : ""}
      </div>`
    : "";

  const audit = `<div style="margin-top:8px;padding:6px 10px;border:1px solid #E5E7EB;border-radius:4px;font-size:8.75px;color:#64748B;direction:ltr;text-align:left;word-break:break-all">
    POLICY ${esc(d.legalPolicyHash || "N/A")}<br>
    APPROVAL ${esc(d.approvalSnapshotHash || "N/A")}<br>
    ITEM ${esc(d.itemSnapshotHash || "N/A")}
  </div>`;

  const signatures = `<div style="margin-top:30px;display:flex;justify-content:space-between;gap:24px">
    ${[d.paidAt ? "الموظف (استلمت)" : "الموظف (اطلعت)", "المحاسب", "المدير المفوَّض"]
      .map(
        (l) => `<div style="flex:1;text-align:center">
          <div style="height:34px"></div>
          <div style="border-top:1px solid #0F1613;padding-top:5px;font-size:10.25px;color:#000;font-weight:600">${esc(l)}</div>
        </div>`,
      )
      .join("")}
  </div>
  <div style="margin-top:10px;font-size:9.75px;color:#8B8E89">هذا الكشف بيان احتساب واستحقاق — لا يثبت قبض الموظف ما لم تظهر حالة «مدفوع» وتاريخ الصرف.</div>`;

  const body = `${pageBodyOpen()}${header}${cards}${table}${noteBox}${grand}${tafqit}${employerLiabilities}${audit}${signatures}${pageBodyClose()}${pageFooter(
    d.settings,
    { rightText: `REF PR-${d.runId}/${d.period}/EMP-${d.employeeId}` },
  )}`;
  return openPrintWindow(wrapA4Doc(`كشف راتب ${d.employeeName} — ${d.period}`, body));
}
