// طابعة A4 عامّة موحّدة لكل تقارير «مركز التقارير» — قيمة مضافة خبيرة (نمط عالمي متّسق).
// تبني مستند A4 بقالب الشركة (شعار + رأس + بطاقات وصفية + جدول + صندوق ملخّص + تذييل) عبر
// بُناة docHtml المشتركة نفسها التي تستعملها الفاتورة/الكشف ⇒ كل تقرير يُطبع بالهوية ذاتها بدالة
// واحدة بدل دالةٍ لكل تقرير. لا تلمس القوالب الخاصّة (الفاتورة/الكشف/الأعمار) — هي مستقلّة.
//
// الاستعمال النموذجي من أي صفحة تقرير:
//   printReportDoc({
//     title: "تقرير المبيعات",
//     headerExtra: [{ label: "الفترة", value: "2026-06-01 — 2026-06-30" }, { label: "الفرع", value: "الكل" }],
//     columns: [{ key: "num", label: "رقم" }, { key: "total", label: "الإجمالي", align: "left" }],
//     rows: [{ num: "INV-1", total: "1,000 د.ع" }],
//     summary: [{ label: "الإجمالي", value: "1,000 د.ع", large: true, bold: true }],
//   });
import { openPrintWindow } from "./brand";
import {
  wrapA4Doc,
  docHeader,
  docMeta,
  docTable,
  docSummary,
  docFooter,
  type TableCol,
  type MetaSection,
  type SummaryItem,
} from "./docHtml";
import { BRAND, esc } from "./brand";

export interface ReportDocInput {
  /** عنوان التقرير (يظهر في شارة الرأس). */
  title: string;
  /** رقم مستند اختياري. */
  docNum?: string | null;
  /** تاريخ الإصدار (نصّ معروض)؛ الافتراضي = اليوم بالـar-IQ. */
  docDate?: string | null;
  /** أسطر إضافية في رأس المستند (الفترة/الفرع/الفلاتر النشطة). */
  headerExtra?: { label: string; value: string }[];
  /** تنويه/افتراضات يظهر أسفل الرأس (للقوائم المالية المبسّطة مثلاً). */
  note?: string;
  /** بطاقات وصفية اختيارية (خضراء/برتقالية) — معلومات الطرف أو ملخّص الفلاتر. */
  meta?: MetaSection[];
  /** أعمدة الجدول. */
  columns: TableCol[];
  /** صفوف الجدول (قيم نصّية جاهزة العرض — نسّق الأموال قبل التمرير). */
  rows: Record<string, string>[];
  /** صندوق الملخّص المالي (يمين)؛ آخر عنصر بـlarge=true يأخذ الخلفية الخضراء. */
  summary?: SummaryItem[];
  /** إظهار عمود التسلسل «م». الافتراضي true. */
  showIndex?: boolean;
  /** نصّ يظهر حين لا صفوف (بدل جدول فارغ). */
  emptyText?: string;
}

/** تنويه احترافي (شريط خفيف) — يُستعمل للافتراضات/حدود التقرير. */
function noteBlock(note: string): string {
  return `<div style="margin-bottom:4mm;padding:2.5mm 3.5mm;background:${BRAND.orangePale};
    border:1px solid ${BRAND.orangeLight};border-radius:4px;border-right:3px solid ${BRAND.orange};
    font-size:8.5px;color:${BRAND.orangeDark};line-height:1.6;">${esc(note)}</div>`;
}

/**
 * يبني مستند A4 ويفتح نافذة الطباعة. يعيد false إن حُجبت النافذة المنبثقة (ليُبلَّغ المستخدم).
 * المحتوى: رأس الشركة → تنويه (اختياري) → بطاقات وصفية (اختياري) → جدول → صندوق ملخّص (اختياري) → تذييل.
 */
export function printReportDoc(input: ReportDocInput): boolean {
  const date = input.docDate ?? new Date().toLocaleDateString("ar-IQ-u-nu-latn");
  const head = docHeader(input.title, input.docNum ?? null, date, input.headerExtra);
  const note = input.note ? noteBlock(input.note) : "";
  const meta = input.meta && input.meta.length ? docMeta(input.meta) : "";

  let table: string;
  if (input.rows.length === 0) {
    table = `<div style="padding:14mm 4mm;text-align:center;color:${BRAND.textFaint};
      border:1px dashed ${BRAND.border};border-radius:6px;margin-bottom:5mm;font-size:11px;">
      ${esc(input.emptyText ?? "لا بيانات في هذا النطاق.")}</div>`;
  } else {
    table = docTable(input.columns, input.rows, input.showIndex !== false);
  }

  const summary = input.summary && input.summary.length ? docSummary(input.summary) : "";

  const body = `${head}${note}${meta}${table}${summary}${docFooter()}`;
  return openPrintWindow(wrapA4Doc(input.title, body));
}
