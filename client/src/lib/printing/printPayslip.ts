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
  wrapMultiA4Doc,
  type CompanySettings,
} from "./docHtml";
import { esc, fmt, openPrintWindow } from "./brand";
import { formatArabicMoneyWords } from "./tafqit";
import { D, round2 } from "@/lib/money";
import { buildPayrollPayslipBreakdown } from "@/lib/payrollPayslipBreakdown";

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
  /** معلومة داخل gross وليست استحقاقاً إضافياً. */
  allowances?: string | null;
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
  entitlementSettled?: string | null;
  signedDifference?: string | null;
  settlementClassification?: string | null;
  settlementEventId?: number | null;
  settlementEvidenceVersion?: number | null;
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

/**
 * يولّد محتوى صفحة HTML لقسيمة راتب الموظف الواحدة، متضمناً الرأس والبطاقات والجدول والتواقيع.
 */
export function renderPayslipHtml(d: PayslipData): string {
  const breakdown = buildPayrollPayslipBreakdown({
    gross: d.gross,
    allowances: d.allowances,
    baseSalary: d.baseSalary,
    overtime: d.overtime,
    commission: d.commission,
    deductions: d.deductions,
    advanceDeduction: d.advanceDeduction,
    socialSecurityEmployee: d.socialSecurityEmployee,
    incomeTax: d.incomeTax,
    net: d.net,
  });
  const zeroSettlement = d.paidAmount != null && D(d.paidAmount).isZero() && d.settlementEvidenceVersion === 2;
  const header = pageHeader(
    {
      title: "كشف راتب",
      subtitle: "بيان احتساب الأجر الشهري — الاستحقاق والاستقطاع والصافي",
      fields: [
        { label: "الشهر", value: d.period },
        { label: "رقم المسيّر", value: `PR-${d.runId}` },
        ...(d.revisionNo != null ? [{ label: "المراجعة", value: `R${d.revisionNo}` }] : []),
        ...(d.accrualDate ? [{ label: "تاريخ الاستحقاق", value: d.accrualDate }] : []),
        ...(d.paidAt ? [{ label: zeroSettlement ? "تاريخ التسوية" : "تاريخ الصرف الفعلي", value: d.paidAt }] : []),
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
        ...(D(breakdown.baseWage).gt(0)
          ? [{ label: "الأجر الأساس / أجر الحضور", value: `${fmt(breakdown.baseWage)} د.ع` }]
          : []),
        ...(D(breakdown.allowances).gt(0)
          ? [{ label: "منه المخصصات (ضمن الإجمالي)", value: `${fmt(breakdown.allowances)} د.ع` }]
          : []),
        ...(d.hours != null && D(d.hours).gt(0) ? [{ label: "الساعات المستحقّة", value: `${fmt(d.hours)} ساعة` }] : []),
        ...(d.paymentMethod ? [{ label: "طريقة الصرف", value: d.paymentMethod }] : []),
        ...(d.paymentReference ? [{ label: "مرجع الصرف", value: d.paymentReference }] : []),
      ],
    },
  ]);

  const earnings = [
    line("الأجر الإجمالي (يشمل المخصصات)", breakdown.gross, "earn"),
    line("عمل إضافي", breakdown.overtime, "earn"),
    line("عمولة مبيعات", breakdown.commission, "earn"),
  ].filter(Boolean) as Array<{ bandLabel: string; amount: string; _n: string }>;

  const deducts = [
    line("استقطاع سلفة", breakdown.advanceDeduction, "deduct"),
    line("ضمان اجتماعي (حصة الموظف)", breakdown.socialSecurityEmployee, "deduct"),
    line("ضريبة الدخل", breakdown.incomeTax, "deduct"),
    line("خفض الأجر وخصومات أخرى", breakdown.otherDeductions, "deduct"),
  ].filter(Boolean) as Array<{ bandLabel: string; amount: string; _n: string }>;

  const earningRows = earnings.map((earning) => ({
    band: earning.bandLabel,
    earn: earning.amount,
    deduct: "—",
  }));
  if (D(breakdown.allowances).gt(0)) {
    earningRows.splice(1, 0, {
      band: "منه المخصصات (معلومة ضمن الإجمالي)",
      earn: fmt(breakdown.allowances),
      deduct: "—",
    });
  }

  const table = docTableV2(
    [
      { key: "band", label: "البند", width: 320 },
      { key: "earn", label: "استحقاق", width: 130 },
      { key: "deduct", label: "استقطاع", width: 130, color: "#B42318" },
    ],
    [
      ...earningRows,
      ...deducts.map((x) => ({ band: x.bandLabel, earn: "—", deduct: `−${x.amount}` })),
      {
        band: "المجموع",
        earn: fmt(breakdown.totalEarnings),
        deduct: D(breakdown.totalDeductions).gt(0) ? `−${fmt(breakdown.totalDeductions)}` : "—",
      },
    ],
    { hideIndex: true },
  );

  const equationBox = `<div style="margin-top:8px;padding:8px 14px;border:1px solid #CBD5E1;border-radius:4px;background:#F8FAFC">
    <div style="font-size:10.5px;font-weight:800;color:#334155">معادلة الصافي</div>
    <div style="margin-top:3px;font-size:10px;color:#475569">الأجر الإجمالي + الإضافي + العمولة − إجمالي الاستقطاع = الصافي</div>
    <div dir="ltr" style="margin-top:3px;font-size:10.5px;font-weight:700;text-align:left">${fmt(breakdown.gross)} + ${fmt(breakdown.overtime)} + ${fmt(breakdown.commission)} − ${fmt(breakdown.totalDeductions)} = ${fmt(breakdown.expectedNet)} د.ع</div>
    ${!breakdown.deductionComponentsValid ? `<div style="margin-top:4px;color:#B42318;font-size:9.75px">تنبيه: مكونات الاستقطاع المسماة تتجاوز إجمالي الاستقطاع المحفوظ.</div>` : ""}
    ${!breakdown.allowancesValid ? `<div style="margin-top:4px;color:#B42318;font-size:9.75px">تنبيه: المخصصات لا تطابق الأجر الإجمالي المحفوظ.</div>` : ""}
    ${!breakdown.netMatches ? `<div style="margin-top:4px;color:#B42318;font-size:9.75px">تنبيه: الصافي المحفوظ (${fmt(breakdown.net)}) لا يطابق المعادلة.</div>` : ""}
  </div>`;

  // ملاحظة الاحتساب — مصدرها بند المسيّر نفسه (تفصيل الأجر بالحضور/الإجازة).
  const noteBox = d.note
    ? `<div style="margin-top:8px;padding:6px 14px;border:1px dashed #1D4ED8;border-radius:4px;background:#EFF6FF">
        <span style="font-size:10.75px;font-weight:800;color:#1D4ED8">تفصيل الاحتساب: </span>
        <span style="font-size:10.5px;color:#000">${esc(d.note)}</span>
      </div>`
    : "";

  const grand = grandTotalBar("صافي المستحقّ", fmt(breakdown.net), { big: true });
  const tafqit = tafqitLine(formatArabicMoneyWords(breakdown.net));

  const settlement =
    d.paidAmount != null
      ? infoCards([
          {
            title: zeroSettlement
              ? "تسوية تقريب بلا صرف نقدي"
              : "تسوية المستحق والصرف الفعلي",
            variant: "gray",
            fields: [
              ...(d.entitlementSettled != null
                ? [
                    {
                      label: "المستحق المسوّى",
                      value: `${fmt(d.entitlementSettled)} د.ع`,
                    },
                  ]
                : []),
              { label: "المدفوع فعلياً", value: `${fmt(d.paidAmount)} د.ع` },
              ...(d.signedDifference != null
                ? [
                    {
                      label: "فرق التقريب (المدفوع − المستحق)",
                      value: `${D(d.signedDifference).gt(0) ? "+" : ""}${fmt(d.signedDifference)} د.ع`,
                    },
                  ]
                : []),
              {
                label: "التصنيف",
                value:
                  d.settlementClassification === "ROUNDING_DIFF"
                    ? "حساب فروق التقريب المعتمد"
                    : d.settlementClassification === "EXACT"
                      ? "تسوية مطابقة"
                      : "فرق تاريخي غير مصنف",
              },
              ...(d.settlementEventId != null
                ? [
                    {
                      label: "حدث التسوية",
                      value: `EV-${d.settlementEventId} / V${d.settlementEvidenceVersion ?? "legacy"}`,
                    },
                  ]
                : []),
            ],
          },
        ])
      : "";

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
    ${[d.paidAt && !zeroSettlement ? "الموظف (استلمت)" : "الموظف (اطلعت)", "المحاسب", "المدير المفوَّض"]
      .map(
        (l) => `<div style="flex:1;text-align:center">
          <div style="height:34px"></div>
          <div style="border-top:1px solid #0F1613;padding-top:5px;font-size:10.25px;color:#000;font-weight:600">${esc(l)}</div>
        </div>`,
      )
      .join("")}
  </div>
  <div style="margin-top:10px;font-size:9.75px;color:#8B8E89">${zeroSettlement ? "تسوية المستحق بفرق التقريب؛ لم يقع صرف نقدي ولا يوجد إيصال صرف." : "هذا الكشف بيان احتساب واستحقاق — لا يثبت قبض الموظف ما لم تظهر حالة «مدفوع» وتاريخ الصرف."}</div>`;

  return `${pageBodyOpen()}${header}${cards}${table}${equationBox}${noteBox}${grand}${tafqit}${settlement}${employerLiabilities}${audit}${signatures}${pageBodyClose()}${pageFooter(
    d.settings,
    { rightText: `REF PR-${d.runId}/${d.period}/EMP-${d.employeeId}` },
  )}`;
}

export function printPayslip(d: PayslipData): boolean {
  return openPrintWindow(wrapA4Doc(`كشف راتب ${d.employeeName} — ${d.period}`, renderPayslipHtml(d)));
}

/**
 * طباعة/تصدير قسائم الرواتب لمجموعة من الموظفين في ملف ومستند واحد متعدد الصفحات A4.
 */
export function printBatchPayslips(
  slips: PayslipData[],
  meta?: { title?: string; period?: string },
): boolean {
  if (slips.length === 0) return false;
  const period = meta?.period ?? slips[0]?.period ?? "";
  const title = meta?.title ?? `قسائم رواتب ${period} — ${slips.length} موظف`;
  const pagesHtml = slips.map((d) => renderPayslipHtml(d));
  return openPrintWindow(wrapMultiA4Doc(title, pagesHtml, {
    badgeLabel: `مسيّر رواتب ${period} (${slips.length} موظف)`
  }));
}

