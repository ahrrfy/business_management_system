/* ============================================================================
 * تقرير الخزينة — A4 بالتصميم المرجعي V2 (نمط printAttendanceStatement/printTransferDoc).
 *
 * وثيقة توقيع واعتماد: ملخّص مقبوضات/مدفوعات حسب طريقة الدفع (أساس نقدي) + فروقات
 * الورديات في الفترة + خانات توقيع (أمين الصندوق/المحاسب/المدير) — مستندٌ مادّيّ
 * يُوقَّع عند إغلاق الفترة/اليوم ويُحفظ في الأرشيف الورقي، بخلاف زرّ «تصدير Excel»
 * الذي يحمل تفصيل كل وردية (لا يتكرّر هنا كي تبقى الوثيقة موجزة قابلة للتوقيع).
 * ========================================================================== */
import {
  docTableV2,
  grandTotalBar,
  infoCards,
  pageBodyClose,
  pageBodyOpen,
  pageFooter,
  pageHeader,
  signaturesBlock,
  wrapA4Doc,
  type CompanySettings,
} from "./docHtml";
import { esc, fmt, openPrintWindow } from "./brand";
import { D } from "../money";

export interface TreasuryReportMethodLine {
  label: string;
  in: string;
  out: string;
  net: string;
  settlement: "DRAWER" | "NON_CASH";
}

export interface TreasuryReportData {
  from: string;
  to: string;
  branchLabel: string;
  methods: TreasuryReportMethodLine[];
  totalIn: string;
  totalOut: string;
  net: string;
  shiftsCount: number;
  totalCounted: string;
  totalVariance: string;
  settings?: CompanySettings;
}

export function printTreasuryReportA4(d: TreasuryReportData): boolean {
  const header = pageHeader(
    {
      title: "تقرير الخزينة",
      subtitle: "مقبوضات ومدفوعات حسب طريقة الدفع (أساس نقدي) + فروقات الورديات — وثيقة توقيع واعتماد",
      fields: [
        { label: "الفترة", value: `${d.from} ← ${d.to}` },
        { label: "الفرع", value: d.branchLabel },
      ],
    },
    d.settings,
  );

  const cards = infoCards([
    {
      title: "حركة النقد",
      variant: "green",
      fields: [
        { label: "المقبوضات", value: fmt(d.totalIn) },
        { label: "المدفوعات", value: fmt(d.totalOut) },
        { label: "صافي الصندوق", value: fmt(d.net) },
      ],
    },
    {
      title: "الورديات في الفترة",
      variant: "gray",
      fields: [
        { label: "عدد الورديات", value: String(d.shiftsCount) },
        { label: "النقد المعدود", value: fmt(d.totalCounted) },
        { label: "إجمالي الفروقات", value: fmt(d.totalVariance) },
      ],
    },
  ]);

  const table = docTableV2(
    [
      { key: "label", label: "طريقة الدفع", width: 150 },
      { key: "settlement", label: "مكان التسوية", width: 140 },
      { key: "in", label: "مقبوضات", width: 110, color: "#0D6B52" },
      { key: "out", label: "مدفوعات", width: 110, color: "#8A1F11" },
      { key: "net", label: "الصافي", width: 110, emphasize: true },
    ],
    d.methods.map((m) => ({
      label: m.label,
      settlement: m.settlement === "DRAWER" ? "درج الكاشير" : "إلكتروني / خارج الدرج",
      in: fmt(m.in),
      out: fmt(m.out),
      net: fmt(m.net),
    })),
    {
      hideIndex: true,
      totalsRow: {
        label: "الإجمالي",
        cells: [
          { key: "in", value: fmt(d.totalIn), color: "#0D6B52" },
          { key: "out", value: fmt(d.totalOut), color: "#8A1F11" },
          { key: "net", value: fmt(d.net), emphasize: true },
        ],
      },
    },
  );

  const grand = grandTotalBar("صافي الصندوق", fmt(d.net), { big: true });

  const varianceTone = D(d.totalVariance).isZero()
    ? { text: "الورديات مطابقة بلا فروقات نقدية.", color: "#0D6B52", bg: "#F0FDF4" }
    : { text: "توجد فروقات نقدية في ورديات الفترة — راجع سجلّ الورديات قبل الاعتماد.", color: "#B7791F", bg: "#FFFBEB" };
  const varianceNote = `<div style="margin-top:8px;padding:6px 14px;border:1px dashed ${varianceTone.color};border-radius:4px;background:${varianceTone.bg}">
    <span style="font-size:10.25px;font-weight:800;color:${varianceTone.color}">${esc(varianceTone.text)}</span>
  </div>`;

  const note = `<div style="margin-top:8px;font-size:9.75px;color:#8B8E89">أساس نقدي مباشر: من المقبوضات/المدفوعات المكتملة (لا أساس الاستحقاق). تفصيل كل وردية في تصدير Excel.</div>`;

  const signatures = signaturesBlock({
    items: [
      { kind: "sig", label: "أمين الصندوق" },
      { kind: "sig", label: "المحاسب" },
      { kind: "sig", label: "المدير المعتمِد" },
    ],
    spaceHeight: 30,
  });

  const body = `${pageBodyOpen()}${header}${cards}${table}${grand}${varianceNote}${note}<div style="margin-top:30px">${signatures}</div>${pageBodyClose()}${pageFooter(
    d.settings,
    { rightText: `REF TREASURY/${d.from}_${d.to}` },
  )}`;
  return openPrintWindow(wrapA4Doc(`تقرير الخزينة ${d.from} — ${d.to}`, body));
}
