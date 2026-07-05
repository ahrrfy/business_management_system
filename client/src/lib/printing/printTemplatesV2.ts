/**
 * قوالب طباعة الرَسميّة — «مطبوعات مكتبة العربية» (تسليم ٥/٧/٢٦، عالية الدقة).
 *
 * ٨ مستندات: فاتورة مبيعات، فاتورة مشتريات، تقرير مبيعات، عرض سعر، طلب خدمة، كشف حساب، سند قبض، سند دفع.
 * كلها A4 بمقاس نقاطي ثابت (794×1123px) بإطار زخرفة داخلي 24px، ترويسة موحّدة مع الأرقام القانونية،
 * وتذييل مثبَّت أسفل الصفحة. الخط Cairo. الحبر أسود. الأخضر رمز هوية.
 *
 * القوالب القديمة في printTemplates.ts (aging، production، receipts، shift) تبقى كما هي — الوحدات
 * غير المشمولة بالتسليم هذا. الأسماء المُعاد تصديرها في هذا الملف هي المداخل الرئيسية للثمانية أعلاه.
 */
import { BRAND as B, esc, fmt, fmtC, openPrintWindow } from './brand';
import {
  wrapA4Doc,
  pageHeader,
  pageBodyOpen,
  pageBodyClose,
  pageFooter,
  infoCards,
  docTableV2,
  docTableDetailRow,
  totalsBox,
  grandTotalBar,
  tafqitLine,
  signaturesBlock,
  type CompanySettings,
  type DocTableCol,
} from './docHtml';
import { formatArabicMoneyWords } from './tafqit';

// ─── مساعدات مشتركة ──────────────────────────────────────────────────────────

/**
 * تحويل ISO/Date إلى `dd/mm/yyyy` (بأرقام لاتينية داخل خانة اتجاه LTR في التصميم).
 * ⚠️ تاريخ نصّي بصيغة YYYY-MM-DD يُعامَل كتاريخ يوميّ محلّي **لا** UTC — `new Date('2026-07-05')`
 *   يفسّر السلسلة كمنتصف ليل UTC فيُظهرها في المتصفّحات غرب UTC بيومٍ أسبق. المرجع الرسمي
 *   للسندات/الفواتير هو يوم التقويم في العراق، فنُنسّق مباشرةً بلا مرور بـDate.
 */
function fmtDate(d?: string | Date | null): string {
  if (!d) return new Date().toLocaleDateString('en-GB');
  if (typeof d === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(d);
    if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  }
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return String(d);
  return date.toLocaleDateString('en-GB');
}

/** أرقام IQD بلا كسور — الفلوس لا تُتداول. للمبالغ فقط لا الكميات. */
function fmtIQD(n: string | number | null | undefined): string {
  return fmt(Math.round(Number(n ?? 0)));
}

/** كميات — تحتفظ بالكسور (البيع يقبل حتى ٣ منازل). عرض «١.٥» كما هو لا «٢». */
function fmtQty(n: string | number | null | undefined): string {
  if (n == null || n === '') return '—';
  const num = Number(n);
  if (Number.isNaN(num)) return String(n);
  // تجميل: بلا كسور زائدة (1.500 ⇒ 1.5) لكن 1.5 يبقى كما هو.
  return num.toLocaleString('en-US', { maximumFractionDigits: 3 });
}

/** اتّجاه رصيد العميل (الموجب = لنا عليه). */
function balanceDirCustomer(balance: number): string {
  return balance >= 0 ? 'لنا' : 'علينا';
}
/** اتّجاه رصيد المورّد (الموجب = علينا نحن للمورّد). */
function balanceDirSupplier(balance: number): string {
  return balance >= 0 ? 'علينا' : 'لنا';
}

// ═════════════════════════════════════════════════════════════════════════════
// ١. فاتورة مبيعات — A4
// ═════════════════════════════════════════════════════════════════════════════

export interface SalesInvoiceV2Data {
  invoiceNumber: string;
  invoiceDate?: string | Date | null;
  /** حالة الدفع كنص عربي: «مدفوعة»، «مدفوعة جزئياً»، «آجلة»، … (مع لون الشارة الملائم). */
  statusLabel?: string | null;
  statusColor?: string | null;

  customerName?: string | null;
  customerAddress?: string | null;
  customerPhone?: string | null;

  paymentMethod?: string | null;
  salesRep?: string | null;
  branchName?: string | null;

  items: {
    productName: string;
    unitName?: string | null;
    quantity: string | number;
    unitPrice: string | number;
    /** حصة السطر من الضريبة (Line-tax). إن كانت صفرية، تُعرَض «—». */
    taxAmount?: string | number | null;
    total: string | number;
  }[];

  subtotal: string | number;
  discountAmount?: string | number | null;
  taxAmount?: string | number | null;
  taxRate?: number | null;
  total: string | number;
  paidAmount?: string | number | null;
  remainingAmount?: string | number | null;

  /** رصيد العميل قبل وبعد هذه الفاتورة (من دفتر الأستاذ الفعلي). */
  customerBalanceBefore?: string | number | null;
  customerBalanceAfter?: string | number | null;

  /** SVG جاهز من qr.ts (اختياري). إن غاب يُستعمل placeholder. */
  qrSvg?: string | null;
  qrCaption?: string | null;

  settings?: CompanySettings;
}

export function printSalesInvoiceV2(d: SalesInvoiceV2Data): boolean {
  const date = fmtDate(d.invoiceDate);
  const badge = d.statusLabel ? { label: d.statusLabel, color: d.statusColor ?? B.orange } : null;

  const header = pageHeader({
    title: 'فاتورة مبيعات',
    fields: [
      { label: 'رقم الفاتورة', value: d.invoiceNumber },
      { label: 'التاريخ', value: date },
    ],
    badge,
  }, d.settings);

  const cards = infoCards([
    {
      title: 'معلومات العميل',
      variant: 'green',
      fields: [
        { label: 'الاسم', value: d.customerName ?? 'عميل نقدي' },
        ...(d.customerAddress ? [{ label: 'العنوان', value: d.customerAddress }] : []),
        ...(d.customerPhone ? [{ label: 'الهاتف', value: d.customerPhone }] : []),
      ],
    },
    {
      title: 'تفاصيل الدفع',
      variant: 'gray',
      fields: [
        ...(d.paymentMethod ? [{ label: 'طريقة الدفع', value: d.paymentMethod }] : []),
        ...(d.salesRep ? [{ label: 'مندوب المبيعات', value: d.salesRep }] : []),
        ...(d.branchName ? [{ label: 'الفرع', value: d.branchName }] : []),
      ],
    },
  ]);

  const cols: DocTableCol[] = [
    { key: 'name', label: 'الصنف' },
    { key: 'unit', label: 'الوحدة', width: 58 },
    { key: 'qty',  label: 'الكمية', width: 52 },
    { key: 'price', label: 'السعر', width: 74 },
    { key: 'tax', label: 'الضريبة', width: 62, color: B.orange },
    { key: 'total', label: 'الإجمالي', width: 88, emphasize: true },
  ];
  const rows = d.items.map((it) => ({
    name: it.productName,
    unit: it.unitName ?? '',
    qty:  fmtQty(it.quantity),
    price: fmtIQD(it.unitPrice),
    tax:  Number(it.taxAmount ?? 0) > 0 ? fmtIQD(it.taxAmount) : '—',
    total: fmtIQD(it.total),
  }));
  const table = docTableV2(cols, rows);

  const remainingNum = Number(d.remainingAmount ?? (Number(d.total) - Number(d.paidAmount ?? 0)));
  const balBefore = d.customerBalanceBefore != null ? Number(d.customerBalanceBefore) : null;
  const balAfter = d.customerBalanceAfter != null ? Number(d.customerBalanceAfter) : null;

  const totals = totalsBox({
    lines: [
      { label: 'المجموع الفرعي', value: fmtIQD(d.subtotal) },
      ...(Number(d.discountAmount ?? 0) > 0 ? [{ label: 'الخصم', value: fmtIQD(d.discountAmount), color: B.orange, sign: '−' as const }] : []),
      ...(Number(d.taxAmount ?? 0) > 0 ? [{ label: `ضريبة المبيعات (${d.taxRate ?? 15}٪)`, value: fmtIQD(d.taxAmount), sign: '+' as const }] : []),
    ],
    grandTotal: { label: 'الإجمالي المستحق', value: fmtIQD(d.total) },
    paid: d.paidAmount != null ? { label: 'المدفوع', value: fmtIQD(d.paidAmount) } : null,
    remaining: remainingNum > 0 ? { label: 'المتبقّي', value: fmtIQD(remainingNum) } : null,
    balance: balAfter != null ? {
      beforeLabel: 'كان الرصيد',
      before: fmtIQD(balBefore ?? 0),
      afterLabel: 'الرصيد الكلي بعد الفاتورة',
      after: fmtIQD(Math.abs(balAfter)),
      direction: balanceDirCustomer(balAfter),
      directionColor: B.alert,
    } : null,
  });

  const tafqit = tafqitLine(formatArabicMoneyWords(d.total));

  const sig = signaturesBlock({
    qrSvg: d.qrSvg ?? true,
    qrCaption: d.qrCaption ?? 'امسح للتحقق من مطابقة بيانات الفاتورة',
    items: [
      { kind: 'sig', label: 'توقيع المستلم' },
      { kind: 'stamp' },
      { kind: 'sig', label: 'المفوّض بالبيع' },
    ],
  });

  const body = `${pageBodyOpen()}${header}${cards}${table}${totals}${tafqit}${sig}${pageBodyClose()}${pageFooter(d.settings, { rightText: `REF ${d.invoiceNumber}` })}`;
  return openPrintWindow(wrapA4Doc(`فاتورة ${d.invoiceNumber}`, body));
}

// ═════════════════════════════════════════════════════════════════════════════
// ٢. فاتورة مشتريات — A4
// ═════════════════════════════════════════════════════════════════════════════

export interface PurchaseInvoiceV2Data {
  invoiceNumber: string;
  invoiceDate?: string | Date | null;
  statusLabel?: string | null;
  statusColor?: string | null;

  supplierName?: string | null;
  supplierAddress?: string | null;
  supplierPhone?: string | null;

  paymentMethod?: string | null;
  linkedPO?: string | null;
  warehouseName?: string | null;

  items: {
    productName: string;
    unitName?: string | null;
    quantity: string | number;
    unitPrice: string | number;
    taxAmount?: string | number | null;
    total: string | number;
  }[];

  subtotal: string | number;
  discountAmount?: string | number | null;
  taxAmount?: string | number | null;
  taxRate?: number | null;
  total: string | number;
  paidAmount?: string | number | null;
  remainingAmount?: string | number | null;

  supplierBalanceBefore?: string | number | null;
  supplierBalanceAfter?: string | number | null;

  qrSvg?: string | null;
  qrCaption?: string | null;
  settings?: CompanySettings;
}

export function printPurchaseInvoiceV2(d: PurchaseInvoiceV2Data): boolean {
  const date = fmtDate(d.invoiceDate);
  const badge = d.statusLabel ? { label: d.statusLabel, color: d.statusColor ?? B.orange } : null;

  const header = pageHeader({
    title: 'فاتورة مشتريات',
    fields: [
      { label: 'رقم الفاتورة', value: d.invoiceNumber },
      { label: 'التاريخ', value: date },
    ],
    badge,
  }, d.settings);

  const cards = infoCards([
    {
      title: 'معلومات المورّد',
      variant: 'green',
      fields: [
        { label: 'الاسم', value: d.supplierName ?? '—' },
        ...(d.supplierAddress ? [{ label: 'العنوان', value: d.supplierAddress }] : []),
        ...(d.supplierPhone ? [{ label: 'الهاتف', value: d.supplierPhone }] : []),
      ],
    },
    {
      title: 'تفاصيل الشراء',
      variant: 'gray',
      fields: [
        ...(d.paymentMethod ? [{ label: 'طريقة الدفع', value: d.paymentMethod }] : []),
        ...(d.linkedPO ? [{ label: 'رقم أمر الشراء المرتبط', value: d.linkedPO }] : []),
        ...(d.warehouseName ? [{ label: 'المخزن المستلم', value: d.warehouseName }] : []),
      ],
    },
  ]);

  const cols: DocTableCol[] = [
    { key: 'name', label: 'الصنف' },
    { key: 'unit', label: 'الوحدة', width: 58 },
    { key: 'qty', label: 'الكمية', width: 52 },
    { key: 'price', label: 'السعر', width: 74 },
    { key: 'tax', label: 'الضريبة', width: 62, color: B.orange },
    { key: 'total', label: 'الإجمالي', width: 88, emphasize: true },
  ];
  const rows = d.items.map((it) => ({
    name: it.productName,
    unit: it.unitName ?? '',
    qty: fmtQty(it.quantity),
    price: fmtIQD(it.unitPrice),
    tax: Number(it.taxAmount ?? 0) > 0 ? fmtIQD(it.taxAmount) : '—',
    total: fmtIQD(it.total),
  }));
  const table = docTableV2(cols, rows);

  const remainingNum = Number(d.remainingAmount ?? (Number(d.total) - Number(d.paidAmount ?? 0)));
  const balBefore = d.supplierBalanceBefore != null ? Number(d.supplierBalanceBefore) : null;
  const balAfter = d.supplierBalanceAfter != null ? Number(d.supplierBalanceAfter) : null;

  const totals = totalsBox({
    lines: [
      { label: 'المجموع الفرعي', value: fmtIQD(d.subtotal) },
      ...(Number(d.discountAmount ?? 0) > 0 ? [{ label: 'خصم المورّد', value: fmtIQD(d.discountAmount), color: B.orange, sign: '−' as const }] : []),
      ...(Number(d.taxAmount ?? 0) > 0 ? [{ label: `ضريبة المبيعات (${d.taxRate ?? 15}٪)`, value: fmtIQD(d.taxAmount), sign: '+' as const }] : []),
    ],
    grandTotal: { label: 'الإجمالي المستحق للمورّد', value: fmtIQD(d.total) },
    paid: d.paidAmount != null ? { label: 'المدفوع', value: fmtIQD(d.paidAmount) } : null,
    remaining: remainingNum > 0 ? { label: 'المتبقّي', value: fmtIQD(remainingNum) } : null,
    balance: balAfter != null ? {
      beforeLabel: 'كان الرصيد',
      before: fmtIQD(balBefore ?? 0),
      afterLabel: 'الرصيد الكلي بعد الفاتورة',
      after: fmtIQD(Math.abs(balAfter)),
      direction: balanceDirSupplier(balAfter),
      directionColor: B.alert,
    } : null,
  });

  const tafqit = tafqitLine(formatArabicMoneyWords(d.total));

  const sig = signaturesBlock({
    qrSvg: d.qrSvg ?? true,
    qrCaption: d.qrCaption ?? 'امسح للتحقق من مطابقة بيانات الفاتورة',
    items: [
      { kind: 'sig', label: 'استلام المخزن' },
      { kind: 'stamp' },
      { kind: 'sig', label: 'مسؤول المشتريات' },
    ],
  });

  const body = `${pageBodyOpen()}${header}${cards}${table}${totals}${tafqit}${sig}${pageBodyClose()}${pageFooter(d.settings, { rightText: `REF ${d.invoiceNumber}` })}`;
  return openPrintWindow(wrapA4Doc(`فاتورة مشتريات ${d.invoiceNumber}`, body));
}

// ═════════════════════════════════════════════════════════════════════════════
// ٣. تقرير المبيعات — A4 (شريط ملخّص 4 خانات + جدول فواتير + إجمالي في التذييل)
// ═════════════════════════════════════════════════════════════════════════════

export interface SalesReportV2Data {
  /** الفترة كنصّ عربي: «01/06 — 01/07/2026». */
  periodLabel: string;
  branchLabel?: string | null;

  invoiceCount: number;
  totalSum: string | number;
  paidSum: string | number;
  unpaidSum: string | number;

  rows: {
    invoiceNumber: string;
    date: string;
    customerName: string;
    total: string | number;
    paid: string | number;
    remaining: string | number;
    /** حالة كنصّ عربي: «مسدَّدة»، «جزئية»، «آجلة». */
    status: string;
    /** لون شارة الحالة (`#0D6B52`/`#92400E`/`#8A1F11`). */
    statusColor?: string;
  }[];

  settings?: CompanySettings;
}

export function printSalesReportV2(d: SalesReportV2Data): boolean {
  const header = pageHeader({
    title: 'تقرير المبيعات',
    fields: [
      { label: 'الفترة', value: d.periodLabel },
      { label: 'الفرع', value: d.branchLabel ?? 'الكل' },
    ],
  }, d.settings);

  // شريط ملخّص 4 خانات
  const kpi = (val: string, label: string, color = B.ink) => `<div style="flex:1;padding:13px;text-align:center;border-inline-end:1px solid ${B.border}">
    <div style="font-size:20.5px;font-weight:900;color:${color};direction:ltr;unicode-bidi:isolate;white-space:nowrap;font-variant-numeric:tabular-nums">${esc(val)}</div>
    <div style="font-size:9.75px;color:#000;font-weight:700;margin-top:3px">${esc(label)}</div>
  </div>`;
  const summary = `<div style="display:flex;margin-top:18px;border:1px solid ${B.border};border-radius:4px;overflow:hidden">
    ${kpi(fmt(d.invoiceCount), 'عدد الفواتير')}
    ${kpi(fmtIQD(d.totalSum), 'الإجمالي (د.ع)')}
    ${kpi(fmtIQD(d.paidSum), 'المحصَّل', B.green)}
    <div style="flex:1;padding:13px;text-align:center">
      <div style="font-size:20.5px;font-weight:900;color:${B.alert};direction:ltr;unicode-bidi:isolate;white-space:nowrap;font-variant-numeric:tabular-nums">${esc(fmtIQD(d.unpaidSum))}</div>
      <div style="font-size:9.75px;color:#000;font-weight:700;margin-top:3px">المتبقّي</div>
    </div>
  </div>`;

  const cols: DocTableCol[] = [
    { key: 'num', label: 'رقم الفاتورة', width: 98 },
    { key: 'date', label: 'التاريخ', width: 66 },
    { key: 'customer', label: 'العميل' },
    { key: 'total', label: 'الإجمالي', width: 82 },
    { key: 'paid', label: 'المدفوع', width: 82 },
    { key: 'remaining', label: 'المتبقّي', width: 82, color: B.alert },
    { key: 'status', label: 'الحالة', width: 60 },
  ];
  const rows = d.rows.map((r) => ({
    num: r.invoiceNumber,
    date: r.date,
    customer: r.customerName,
    total: fmtIQD(r.total),
    paid: fmtIQD(r.paid),
    remaining: fmtIQD(r.remaining),
    status: r.status,
  }));

  // نبني الجدول ثم نُعدّل خلايا الحالة يدوياً لأنها ملوّنة حسب الحالة
  // (docTableV2 لا يدعم لوناً مختلفاً لكل صف على نفس العمود)
  let table = docTableV2(cols, rows, {
    indexWidth: 26,
    totalsRow: {
      label: 'الإجمالي',
      cells: [
        { key: 'total', value: fmtIQD(d.totalSum) },
        { key: 'paid', value: fmtIQD(d.paidSum), color: B.green },
        { key: 'remaining', value: fmtIQD(d.unpaidSum), color: B.alert },
      ],
    },
  });

  // استبدال لون الحالة سطراً-بسطر بعد التوليد (الشرح: لكل صف tbody، خليّة الحالة الأخيرة تحمل status).
  d.rows.forEach((r, i) => {
    const statusColor = r.statusColor ?? (r.status === 'مسدَّدة' ? B.green : r.status === 'جزئية' ? B.orange : B.alert);
    // تُبدَّل خلية الحالة بأخرى بلون مناسب. البحث بمُعرِّف السطر بعيد؛ الأنسب: نبني صفوف الجدول يدوياً.
    // نستبدل النَصّ الأخير `>${r.status}</td>` بلمرّة الأولى في الجدول (ترتيب الصفوف مُحفَظ).
    const marker = `>${esc(r.status)}</td>`;
    const idx = table.indexOf(marker);
    if (idx >= 0) {
      // نستبدل خلية الحالة كاملةً بأخرى بلون مخصّص. للأمانة: نبحث عن بداية <td> السابق لهذا marker.
      const tdStart = table.lastIndexOf('<td', idx);
      const tdEndSearch = table.indexOf('</td>', idx);
      if (tdStart >= 0 && tdEndSearch >= 0) {
        const bg = i % 2 === 0 ? '#fff' : B.zebra;
        const replacement = `<td style="vertical-align:middle;padding:7px 8px;text-align:center;font-size:9.75px;font-weight:800;color:${statusColor};background:${bg};border:1.5px solid ${B.borderDk}">${esc(r.status)}</td>`;
        table = table.slice(0, tdStart) + replacement + table.slice(tdEndSearch + '</td>'.length);
      }
    }
  });

  const note = `<div style="margin-top:10px;font-size:9.75px;color:${B.textFaint}">مُولَّد آلياً من مركز التقارير · لا يتطلّب توقيعاً — للاستخدام الداخلي</div>`;

  const body = `${pageBodyOpen()}${header}${summary}${table}${note}${pageBodyClose()}${pageFooter(d.settings, { rightText: 'صفحة 1 من 1' })}`;
  return openPrintWindow(wrapA4Doc('تقرير المبيعات', body));
}

// ═════════════════════════════════════════════════════════════════════════════
// ٤. عرض سعر — A4
// ═════════════════════════════════════════════════════════════════════════════

export interface QuotationV2Data {
  quoteNumber: string;
  quoteDate?: string | Date | null;
  validUntil?: string | null;

  customerName?: string | null;
  contactPerson?: string | null;
  customerPhone?: string | null;

  deliveryTime?: string | null;
  deliveryLocation?: string | null;

  items: {
    productName: string;
    unitName?: string | null;
    quantity: string | number;
    unitPrice: string | number;
    taxAmount?: string | number | null;
    total: string | number;
  }[];

  subtotal: string | number;
  taxAmount?: string | number | null;
  taxRate?: number | null;
  total: string | number;

  terms?: string | null;
  settings?: CompanySettings;
}

export function printQuotationV2(d: QuotationV2Data): boolean {
  const header = pageHeader({
    title: 'عرض سعر',
    fields: [
      { label: 'رقم العرض', value: d.quoteNumber },
      { label: 'تاريخ الإصدار', value: fmtDate(d.quoteDate) },
    ],
    badge: d.validUntil ? { label: `صالح حتى ${d.validUntil}`, color: B.orange } : null,
  }, d.settings);

  const cards = infoCards([
    {
      title: 'معلومات العميل',
      variant: 'green',
      fields: [
        { label: 'الاسم', value: d.customerName ?? '—' },
        ...(d.contactPerson ? [{ label: 'شخص التواصل', value: d.contactPerson }] : []),
        ...(d.customerPhone ? [{ label: 'الهاتف', value: d.customerPhone }] : []),
      ],
    },
    {
      title: 'تفاصيل العرض',
      variant: 'gray',
      fields: [
        ...(d.deliveryTime ? [{ label: 'مدة التنفيذ المتوقعة', value: d.deliveryTime }] : []),
        ...(d.deliveryLocation ? [{ label: 'التسليم', value: d.deliveryLocation }] : []),
      ],
    },
  ]);

  const cols: DocTableCol[] = [
    { key: 'name', label: 'الصنف' },
    { key: 'unit', label: 'الوحدة', width: 58 },
    { key: 'qty', label: 'الكمية', width: 52 },
    { key: 'price', label: 'السعر', width: 74 },
    { key: 'tax', label: 'الضريبة', width: 62, color: B.orange },
    { key: 'total', label: 'الإجمالي', width: 88, emphasize: true },
  ];
  const rows = d.items.map((it) => ({
    name: it.productName,
    unit: it.unitName ?? '',
    qty: fmtQty(it.quantity),
    price: fmtIQD(it.unitPrice),
    tax: Number(it.taxAmount ?? 0) > 0 ? fmtIQD(it.taxAmount) : '—',
    total: fmtIQD(it.total),
  }));
  const table = docTableV2(cols, rows);

  const totals = totalsBox({
    lines: [
      { label: 'المجموع الفرعي', value: fmtIQD(d.subtotal) },
      ...(Number(d.taxAmount ?? 0) > 0 ? [{ label: `ضريبة المبيعات (${d.taxRate ?? 15}٪)`, value: fmtIQD(d.taxAmount), sign: '+' as const }] : []),
    ],
    grandTotal: { label: 'الإجمالي', value: fmtIQD(d.total) },
  });

  const termsText = d.terms ?? 'الأسعار لا تشمل التوصيل خارج بغداد · العرض صالح حتى التاريخ أعلاه فقط · الأسعار قابلة للتعديل بعد انتهاء الصلاحية · يبدأ التنفيذ بعد استلام دفعة مقدَّمة 50٪.';
  const termsBox = `<div style="margin-top:14px;padding:10px 14px;border:1px solid ${B.border};border-inline-start:3px solid ${B.ink};border-radius:4px;background:${B.bgWarm}">
    <div style="font-size:10.25px;font-weight:800;color:${B.ink};margin-bottom:4px">الشروط والأحكام</div>
    <div style="font-size:10.75px;color:#000;line-height:1.7">${esc(termsText)}</div>
  </div>`;

  const sigs = `<div style="display:flex;justify-content:space-between;margin-top:24px;gap:20px">
    <div style="text-align:center;width:220px">
      <div style="height:22px"></div>
      <div style="border-top:1px solid ${B.ink};padding-top:5px;font-size:10.25px;color:#000;font-weight:600">توقيع العميل بالموافقة على العرض</div>
    </div>
    <div style="text-align:center;width:220px">
      <div style="height:22px"></div>
      <div style="border-top:1px solid ${B.ink};padding-top:5px;font-size:10.25px;color:#000;font-weight:600">الممثل التجاري — مكتبة العربية</div>
    </div>
  </div>`;

  const body = `${pageBodyOpen()}${header}${cards}${table}${totals}${termsBox}${sigs}${pageBodyClose()}${pageFooter(d.settings, { rightText: `REF ${d.quoteNumber}` })}`;
  return openPrintWindow(wrapA4Doc(`عرض سعر ${d.quoteNumber}`, body));
}

// ═════════════════════════════════════════════════════════════════════════════
// ٥. طلب خدمة (Work Order) — A4
// ═════════════════════════════════════════════════════════════════════════════

export interface WorkOrderV2Data {
  woNumber: string;
  /** تاريخ إصدار الطلب (اليوم الذي استُلم فيه العمل). يظهر «تاريخ الإصدار» في الترويسة. */
  woDate?: string | Date | null;
  dueDate?: string | null;
  statusLabel?: string | null;
  statusColor?: string | null;

  customerName?: string | null;
  customerPhone?: string | null;

  jobType?: string | null;
  jobSpecs?: string | null;

  items: {
    name: string;
    unit?: string | null;
    quantity: string | number;
    unitPrice: string | number;
    total: string | number;
  }[];

  total: string | number;

  operationNotes?: string | null;
  settings?: CompanySettings;
}

export function printWorkOrderV2(d: WorkOrderV2Data): boolean {
  const header = pageHeader({
    title: 'طلب خدمة',
    fields: [
      { label: 'رقم الطلب', value: d.woNumber },
      ...(d.woDate ? [{ label: 'تاريخ الإصدار', value: fmtDate(d.woDate) }] : []),
      ...(d.dueDate ? [{ label: 'تاريخ التسليم', value: d.dueDate }] : []),
    ],
    badge: d.statusLabel ? { label: d.statusLabel, color: d.statusColor ?? B.orange } : null,
  }, d.settings);

  const cards = infoCards([
    {
      title: 'معلومات العميل',
      variant: 'green',
      fields: [
        { label: 'الاسم', value: d.customerName ?? '—' },
        ...(d.customerPhone ? [{ label: 'الهاتف', value: d.customerPhone }] : []),
      ],
    },
    {
      title: 'تفاصيل العمل',
      variant: 'gray',
      fields: [
        ...(d.jobType ? [{ label: 'نوع العمل', value: d.jobType }] : []),
        ...(d.jobSpecs ? [{ label: 'المواصفات', value: d.jobSpecs }] : []),
      ],
    },
  ]);

  const cols: DocTableCol[] = [
    { key: 'name', label: 'البند' },
    { key: 'unit', label: 'الوحدة', width: 58 },
    { key: 'qty', label: 'الكمية', width: 60 },
    { key: 'price', label: 'السعر', width: 84 },
    { key: 'total', label: 'الإجمالي', width: 92, emphasize: true },
  ];
  const rows = d.items.map((it) => ({
    name: it.name,
    unit: it.unit ?? '',
    qty: fmtQty(it.quantity),
    price: fmtIQD(it.unitPrice),
    total: fmtIQD(it.total),
  }));
  const table = docTableV2(cols, rows);

  const totalBar = `<div style="display:flex;justify-content:flex-end;margin-top:10px">
    <div style="width:290px">${grandTotalBar('الإجمالي', fmtIQD(d.total)).replace('margin-top:16px;', 'margin-top:0;')}</div>
  </div>`;

  const notes = `<div style="margin-top:14px">
    <div style="font-size:10.25px;font-weight:800;color:${B.ink};margin-bottom:5px">ملاحظات التشغيل</div>
    <div style="min-height:46px;border:1px dashed #C9CAC2;border-radius:4px;padding:8px;font-size:10.75px;color:#000">${esc(d.operationNotes ?? '')}</div>
  </div>`;

  const sigs = `<div style="display:flex;justify-content:space-between;margin-top:22px;gap:20px">
    <div style="text-align:center;width:220px">
      <div style="height:22px"></div>
      <div style="border-top:1px solid ${B.ink};padding-top:5px;font-size:10.25px;color:#000;font-weight:600">الفني المسؤول عن التنفيذ</div>
    </div>
    <div style="text-align:center;width:220px">
      <div style="height:22px"></div>
      <div style="border-top:1px solid ${B.ink};padding-top:5px;font-size:10.25px;color:#000;font-weight:600">توقيع العميل عند الاستلام</div>
    </div>
  </div>`;

  const body = `${pageBodyOpen()}${header}${cards}${table}${totalBar}${notes}${sigs}${pageBodyClose()}${pageFooter(d.settings, { rightText: `REF ${d.woNumber}` })}`;
  return openPrintWindow(wrapA4Doc(`طلب خدمة ${d.woNumber}`, body));
}

// ═════════════════════════════════════════════════════════════════════════════
// ٦. كشف حساب مفصّل — A4 (لكل حركة صفّ قيم + صف تفاصيل)
// ═════════════════════════════════════════════════════════════════════════════

export interface StatementV2Data {
  /** «customer» = رصيد ختامي مستحق «لنا»، «supplier» = مستحق «علينا». يُغيّر أسماء الحقول. */
  partyKind: 'customer' | 'supplier';
  partyName: string;
  partyPhone?: string | null;

  periodLabel: string;
  openingBalance: string | number;
  transactionsCount: number;

  transactions: {
    date: string;
    ref: string;
    description: string;
    debit?: string | number | null;
    credit?: string | number | null;
    balance: string | number;
    /** نوع الحركة كنصّ عربي: «فاتورة»، «سند قبض»، «سند دفع»، … */
    typeLabel: string;
    /** لون شارة النوع في الصفّ التفصيلي (`#8A1F11` للفاتورة، `#0D6B52` للسند). */
    typeColor?: string | null;
    /** نص التفاصيل الإضافيّة أسفل قيم الصف — يشرح محتوى الفاتورة/السند. */
    details: string;
  }[];

  totalDebit: string | number;
  totalCredit: string | number;
  closingBalance: string | number;

  settings?: CompanySettings;
}

export function printStatementV2(d: StatementV2Data): boolean {
  const isCustomer = d.partyKind === 'customer';
  const header = pageHeader({
    title: 'كشف حساب',
    subtitle: 'بيان تفصيلي — يوضح محتوى كل فاتورة وسند مرتبط بالحركة',
    fields: [
      { label: 'الفترة', value: d.periodLabel },
    ],
  }, d.settings);

  const cards = infoCards([
    {
      title: isCustomer ? 'معلومات العميل' : 'معلومات المورّد',
      variant: 'green',
      fields: [
        { label: 'الاسم', value: d.partyName },
        ...(d.partyPhone ? [{ label: 'الهاتف', value: d.partyPhone }] : []),
      ],
    },
    {
      title: 'ملخّص الحساب',
      variant: 'gray',
      fields: [
        { label: 'الرصيد الافتتاحي', value: fmtIQD(d.openingBalance) },
        { label: 'عدد الحركات', value: String(d.transactionsCount) },
      ],
    },
  ]);

  // بناء الجدول يدوياً: كل حركة = صفّان (قيم + تفاصيل).
  const cols: DocTableCol[] = [
    { key: 'date', label: 'التاريخ', width: 74 },
    { key: 'ref', label: 'المرجع', width: 104 },
    { key: 'desc', label: 'البيان' },
    { key: 'debit', label: 'مدين', width: 84, color: B.alert },
    { key: 'credit', label: 'دائن', width: 84, color: B.green },
    { key: 'balance', label: 'الرصيد', width: 90, color: B.ink },
  ];

  // الرأس (استعارة نمط docTableV2 دون totalsRow؛ صفوف الجسم مخصّصة).
  const th = (label: string, width?: number) =>
    `<th style="vertical-align:middle;padding:7px 8px;text-align:center;font-size:10.75px;font-weight:800;color:#fff;border:1.5px solid rgba(255,255,255,.5);letter-spacing:.2px;${width ? `width:${width}px;` : ''}">${esc(label)}</th>`;
  const head = `<tr style="background:${B.greenDark}">${cols.map((c) => th(c.label, c.width)).join('')}</tr>`;

  const cellStyle = (color = '#000', size = 11.75, opts: { money?: boolean; noBottom?: boolean } = {}) => {
    const money = opts.money ? 'direction:ltr;unicode-bidi:isolate;white-space:nowrap;font-variant-numeric:tabular-nums;' : '';
    const nb = opts.noBottom ? 'border-bottom:none;' : '';
    return `vertical-align:middle;padding:6px;text-align:center;font-size:${size}px;color:${color};font-weight:${opts.money ? '800' : '700'};border:1.5px solid ${B.borderDk};${nb}${money}`;
  };

  const bodyRows = d.transactions.map((t, i) => {
    const bg = i % 2 === 0 ? '#fff' : B.zebra;
    const debit = Number(t.debit ?? 0) > 0 ? fmtIQD(t.debit) : '—';
    const credit = Number(t.credit ?? 0) > 0 ? fmtIQD(t.credit) : '—';
    const debitColor = Number(t.debit ?? 0) > 0 ? B.alert : '#000';
    const creditColor = Number(t.credit ?? 0) > 0 ? B.green : '#000';

    const valueRow = `<tr style="background:${bg}">
      <td style="${cellStyle('#000', 11.5, { money: true, noBottom: true })}">${esc(t.date)}</td>
      <td style="${cellStyle('#000', 11.75, { money: true, noBottom: true })}">${esc(t.ref)}</td>
      <td style="${cellStyle('#000', 11.25, { noBottom: true })}">${esc(t.description)}</td>
      <td style="${cellStyle(debitColor, 11.75, { money: true, noBottom: true })}">${esc(debit)}</td>
      <td style="${cellStyle(creditColor, 11.75, { money: true, noBottom: true })}">${esc(credit)}</td>
      <td style="${cellStyle(B.ink, 12, { money: true, noBottom: true })};font-weight:900">${esc(fmtIQD(t.balance))}</td>
    </tr>`;
    const detailRow = docTableDetailRow(i, t.typeLabel, t.typeColor ?? B.alert, t.details, cols.length);
    return valueRow + detailRow;
  }).join('');

  // تذييل جدول: صف الإجمالي
  const foot = `<tfoot><tr style="background:#F2F2EC">
    <td colspan="3" style="vertical-align:middle;padding:6px;text-align:center;font-size:10.75px;font-weight:800;color:${B.ink};border:1.5px solid ${B.borderDk};border-top:3px solid ${B.ink}">الإجمالي</td>
    <td style="vertical-align:middle;padding:6px;text-align:center;font-size:11.25px;font-weight:900;color:${B.alert};border:1.5px solid ${B.borderDk};border-top:3px solid ${B.ink};direction:ltr;unicode-bidi:isolate;white-space:nowrap;font-variant-numeric:tabular-nums">${esc(fmtIQD(d.totalDebit))}</td>
    <td style="vertical-align:middle;padding:6px;text-align:center;font-size:11.25px;font-weight:900;color:${B.green};border:1.5px solid ${B.borderDk};border-top:3px solid ${B.ink};direction:ltr;unicode-bidi:isolate;white-space:nowrap;font-variant-numeric:tabular-nums">${esc(fmtIQD(d.totalCredit))}</td>
    <td style="vertical-align:middle;padding:6px;text-align:center;font-size:11.25px;font-weight:900;color:${B.ink};border:1.5px solid ${B.borderDk};border-top:3px solid ${B.ink};direction:ltr;unicode-bidi:isolate;white-space:nowrap;font-variant-numeric:tabular-nums">${esc(fmtIQD(d.closingBalance))}</td>
  </tr></tfoot>`;

  const table = `<div style="margin-top:18px;border:2px solid ${B.ink};border-radius:4px;overflow:hidden">
    <table style="width:100%;border-collapse:collapse;table-layout:fixed">
      <thead>${head}</thead>
      <tbody>${bodyRows}</tbody>
      ${foot}
    </table>
  </div>`;

  // شريط الرصيد الختامي — الاتّجاه يُحسَب من إشارة الرصيد + نوع الطرف (عميل موجب=«لنا»، مورّد موجب=«علينا»).
  // القيمة تُعرَض بالقيمة المطلقة والاتّجاه بجانبها ⇒ لا تلغى دلالة الائتمان/الدين عند سالبية الرصيد
  // (مورّد ذو رصيد سالب = دفعنا زيادةً، «لنا عليه» — تظهر بوضوح بدل الابتلاع بـabs الصامت).
  const closingSigned = Number(d.closingBalance);
  const closingAbs = Math.abs(closingSigned);
  const closingDir = isCustomer ? balanceDirCustomer(closingSigned) : balanceDirSupplier(closingSigned);
  const closingBar = `<div style="display:flex;justify-content:flex-end;margin-top:10px">
    <div style="width:290px">${grandTotalBar(`الرصيد الختامي المستحق (${closingDir})`, fmtIQD(closingAbs)).replace('margin-top:16px;', 'margin-top:0;')}</div>
  </div>`;

  const sig = `<div style="display:flex;justify-content:flex-start;margin-top:26px">
    <div style="text-align:center;width:260px">
      <div style="height:28px"></div>
      <div style="border-top:1px solid ${B.ink};padding-top:5px;font-size:10.25px;color:#000;font-weight:600">توقيع ${isCustomer ? 'العميل' : 'المورّد'} إقراراً بمطابقة الرصيد أعلاه — التاريخ: ___________</div>
    </div>
  </div>`;

  const body = `${pageBodyOpen()}${header}${cards}${table}${closingBar}${sig}${pageBodyClose()}${pageFooter(d.settings, { rightText: 'صفحة 1 من 1' })}`;
  return openPrintWindow(wrapA4Doc(`كشف حساب — ${d.partyName}`, body));
}

// ═════════════════════════════════════════════════════════════════════════════
// ٧+٨. سند قبض / سند دفع — A4 (نفس القالب، اتّجاه معكوس)
// ═════════════════════════════════════════════════════════════════════════════

export interface VoucherV2Data {
  /** «IN» = سند قبض من عميل، «OUT» = سند دفع لمورّد. */
  direction: 'IN' | 'OUT';
  voucherNumber: string;
  voucherDate?: string | Date | null;

  /** «✓ معتمَد» أو «بانتظار اعتماد». افتراضي «معتمَد». */
  statusLabel?: string | null;
  statusColor?: string | null;

  /** اسم الطرف المُقابل (عميل للـIN، مورّد للـOUT). */
  partyName: string;
  /** كلمة تعريف الطرف: «عميل»، «مورّد»، «موظّف»، … */
  partyTypeLabel: string;
  /** رصيد الطرف قبل السند (رقم). عرضٌ لُنا/علينا يُحسَب من الاتجاه. */
  partyBalanceBefore?: string | number | null;

  paymentMethodLabel: string;
  /** رقم مرجعي حرّ — TRF-88231 أو CHQ-77410 أو رقم البطاقة (xxxx). */
  referenceNumber?: string | null;

  description: string;

  /** المبلغ الرَقمي. */
  amount: string | number;

  qrSvg?: string | null;
  qrCaption?: string | null;
  /** بَصمة SHA-256 مختصرة تُعرَض في يمين التذييل: `HASH 9F3C-…`. */
  signatureShortHash?: string | null;

  /**
   * مُرفَق السند كصورة (data: URL أو رابط مباشر) — يُطبَع كصورة مصغَّرة أسفل التوقيعات في نسخة A4
   * الرسمية (لا يُطبَع نصّاً خاماً؛ روابط data: الطويلة كانت ستُفسِد الصفحة قبل هذا التعديل).
   */
  attachmentImageUrl?: string | null;

  settings?: CompanySettings;
}

export function printVoucherV2(d: VoucherV2Data): boolean {
  const isReceipt = d.direction === 'IN';
  const title = isReceipt ? 'سند قبض' : 'سند دفع';

  // اتّجاه رصيد الطرف قبل السند (نصّ العرض «(لنا)» / «(علينا)»).
  const balBefore = d.partyBalanceBefore != null ? Number(d.partyBalanceBefore) : null;
  const balBeforeText = balBefore != null
    ? `${d.partyTypeLabel} — رصيد قبل السند: ${fmt(Math.abs(balBefore))} (${isReceipt ? balanceDirCustomer(balBefore) : balanceDirSupplier(balBefore)})`
    : d.partyTypeLabel;

  const badge = { label: d.statusLabel ?? '✓ معتمَد', color: d.statusColor ?? B.green };

  const header = pageHeader({
    title,
    fields: [
      { label: 'رقم السند', value: d.voucherNumber },
      { label: 'التاريخ', value: fmtDate(d.voucherDate) },
    ],
    badge,
  }, d.settings);

  const cards = infoCards([
    {
      title: 'الطرف المُقابل',
      variant: 'green',
      fields: [],
      bigLine: { primary: d.partyName, secondary: balBeforeText },
    },
    {
      title: 'تفاصيل الدفع',
      variant: 'gray',
      fields: [
        { label: 'الطريقة', value: d.paymentMethodLabel },
        ...(d.referenceNumber ? [{ label: 'الرقم المرجعي', value: d.referenceNumber }] : []),
      ],
    },
  ]);

  const descBox = `<div style="margin-top:14px;padding:11px 14px;background:${B.bgWarm};border:1px solid ${B.border};border-radius:4px">
    <div style="font-size:10.25px;font-weight:800;color:#000;margin-bottom:4px">الوصف / الغرض</div>
    <div style="font-size:12.25px;color:#000;line-height:1.6">${esc(d.description)}</div>
  </div>`;

  const amountBar = grandTotalBar(isReceipt ? 'المبلغ المُستلَم' : 'المبلغ المدفوع', fmtIQD(d.amount), { big: true });

  const tafqit = tafqitLine(formatArabicMoneyWords(d.amount));

  const sig = signaturesBlock({
    qrSvg: d.qrSvg ?? true,
    qrCaption: 'للتحقق من صحة السند',
    qrSize: 52,
    spaceHeight: 28,
    labelSize: 9.75,
    items: [
      { kind: 'sig', label: 'المُنشئ / المحاسب', width: 110 },
      { kind: 'sig', label: 'المُعتمِد', width: 110 },
      { kind: 'sig', label: 'المُستلم', width: 110 },
    ],
  });

  const attachmentBlock = d.attachmentImageUrl
    ? `<div style="margin-top:10px;text-align:center">
        <div style="font-size:8.5px;color:${B.textFaint};margin-bottom:3px">صورة المُرفَق المُرتبط بالسند</div>
        <img src="${esc(d.attachmentImageUrl)}" alt="مُرفَق السند"
          style="max-width:170px;max-height:170px;border:1px solid ${B.border};border-radius:4px;object-fit:contain" />
      </div>`
    : '';

  const footerRef = d.signatureShortHash ? `HASH ${d.signatureShortHash}` : `REF ${d.voucherNumber}`;
  const footerLeft = 'سند مرقّم تسلسلياً ومؤرشف إلكترونياً — لا يُعتمد بلا توقيع مستلم';

  // تذييل مخصّص: النص الأيسر بدل «footerLine» الافتراضي
  const customFooter = `<div class="page-footer">
    <div style="height:1px;background:${B.border};margin-bottom:10px"></div>
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
      <div style="font-size:10.25px;color:#000;font-weight:600">${esc(footerLeft)}</div>
      <div style="font-size:9.25px;color:${B.textFaint};font-family:ui-monospace,monospace;direction:ltr;unicode-bidi:isolate;white-space:nowrap">${esc(footerRef)}</div>
    </div>
  </div>`;

  const body = `${pageBodyOpen()}${header}${cards}${descBox}${amountBar}${tafqit}${sig}${attachmentBlock}${pageBodyClose()}${customFooter}`;
  return openPrintWindow(wrapA4Doc(`${title} ${d.voucherNumber}`, body));
}
