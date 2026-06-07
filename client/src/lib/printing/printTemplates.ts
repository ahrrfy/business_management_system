/**
 * قوالب طباعة مكتبة العربية — 10 قوالب كاملة
 * كل وظيفة تُولّد HTML وتفتح نافذة طباعة.
 */
import { BRAND as B, CO, esc, fmt, fmtC, openPrintWindow, CAIRO_FONT, logoUrl } from './brand';
import {
  wrapA4Doc, wrapReceiptDoc,
  docHeader, docMeta, docTable, docSummary, docFooter, agingSummaryBars,
} from './docHtml';
import { qrCodeSvg } from './qr';
import { code128Svg } from './barcode';

// ═══════════════════════════════════════════════════════════════════════════════
// ١. فاتورة مبيعات ضريبية — A4 + QR Code
// ═══════════════════════════════════════════════════════════════════════════════

export interface InvoicePrintData {
  invoiceNumber: string;
  invoiceDate?: string | Date | null;
  customerName?: string | null;
  customerPhone?: string | null;
  customerAddress?: string | null;
  customerTaxId?: string | null;
  paymentMethod?: string | null;
  notes?: string | null;
  items: {
    productName: string;
    unitName?: string | null;
    quantity: string | number;
    unitPrice: string | number;
    total: string | number;
  }[];
  subtotal: string | number;
  discountAmount?: string | number | null;
  taxAmount?: string | number | null;
  taxRate?: number | null;
  total: string | number;
  paidAmount?: string | number | null;
}

export async function printInvoiceA4(d: InvoicePrintData): Promise<void> {
  const date = d.invoiceDate
    ? new Date(d.invoiceDate as string).toLocaleDateString('en-GB').replace(/\//g, '/')
    : new Date().toLocaleDateString('en-GB');

  const qrPayload = [
    CO.sub,
    `رقم الفاتورة: ${d.invoiceNumber}`,
    `التاريخ: ${date}`,
    `الإجمالي: ${fmtC(d.total)}`,
  ].join('\n');

  const qrSvg = await qrCodeSvg(qrPayload, { size: 88, margin: 1 }).catch(() => '');

  const cols = [
    { key: 'name', label: 'الصنف' },
    { key: 'unit', label: 'الوحدة', width: '14mm', align: 'center' as const },
    { key: 'qty', label: 'الكمية', width: '14mm', align: 'center' as const },
    { key: 'price', label: 'سعر الوحدة', width: '22mm', align: 'left' as const },
    { key: 'amount', label: 'المبلغ', width: '24mm', align: 'left' as const, bold: true },
  ];
  const rows = d.items.map(it => ({
    name: it.productName,
    unit: it.unitName ?? '',
    qty: fmt(it.quantity),
    price: fmt(it.unitPrice),
    amount: fmt(it.total),
  }));

  const custFields = [
    { label: 'الاسم', value: d.customerName ?? 'عميل عابر' },
    ...(d.customerAddress ? [{ label: 'العنوان', value: d.customerAddress }] : []),
    ...(d.customerPhone ? [{ label: 'الهاتف', value: d.customerPhone }] : []),
  ];
  const taxFields = [
    ...(d.customerTaxId ? [{ label: 'الرقم الضريبي', value: d.customerTaxId }] : []),
    { label: 'رقم الفاتورة', value: d.invoiceNumber },
    { label: 'التاريخ', value: date },
    ...(d.paymentMethod ? [{ label: 'طريقة الدفع', value: d.paymentMethod }] : []),
  ];

  const summaryItems = [
    { label: 'المجموع الفرعي', value: fmtC(d.subtotal) },
    ...(Number(d.discountAmount ?? 0) > 0
      ? [{ label: 'الخصم', value: fmtC(d.discountAmount) }]
      : []),
    ...(Number(d.taxAmount ?? 0) > 0
      ? [{ label: `ضريبة القيمة المضافة${d.taxRate ? ` (${d.taxRate}%)` : ''}`, value: fmtC(d.taxAmount) }]
      : []),
    { label: 'الإجمالي المستحق', value: fmtC(d.total), bold: true, large: true },
  ];

  const paidAmount = Number(d.paidAmount ?? 0);
  const remaining = Number(d.total) - paidAmount;
  const remainingHtml = paidAmount > 0
    ? `<div style="text-align:left;font-size:9.5px;color:#555;margin-bottom:4mm;">
        المدفوع: <strong>${fmtC(paidAmount)}</strong> &nbsp;|&nbsp;
        المتبقّي: <strong style="color:${remaining > 0.01 ? '#DC2626' : '#059669'};">${fmtC(Math.max(remaining, 0))}</strong>
      </div>`
    : '';

  const notesHtml = d.notes
    ? `<div style="background:${B.bg};border:1px solid ${B.border};border-radius:4px;padding:3mm;margin-bottom:4mm;font-size:9.5px;">
        <strong>ملاحظات: </strong>${esc(d.notes)}</div>`
    : '';

  const body = [
    docHeader('فاتورة مبيعات ضريبية', d.invoiceNumber, date),
    docMeta([
      { title: 'معلومات العميل', fields: custFields },
      { title: 'معلومات ضريبية', fields: taxFields },
    ]),
    docTable(cols, rows),
    docSummary(summaryItems, qrSvg || undefined),
    remainingHtml,
    notesHtml,
    docFooter(),
  ].join('');

  openPrintWindow(wrapA4Doc(`فاتورة ${d.invoiceNumber}`, body));
}

// ═══════════════════════════════════════════════════════════════════════════════
// ٢. عرض سعر — A4
// ═══════════════════════════════════════════════════════════════════════════════

export interface QuotationPrintData {
  quoteNumber: string;
  quoteDate?: string | null;
  validUntil?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  customerAddress?: string | null;
  contactPerson?: string | null;
  notes?: string | null;
  items: {
    productName: string;
    variantName?: string | null;
    description?: string | null;
    unitName?: string | null;
    quantity: string | number;
    unitPrice: string | number;
    total: string | number;
  }[];
  subtotal: string | number;
  taxAmount?: string | number | null;
  total: string | number;
}

export function printQuotation(d: QuotationPrintData): void {
  const cols = [
    { key: 'name', label: 'الصنف' },
    { key: 'desc', label: 'الوصف', width: '30mm' },
    { key: 'qty', label: 'الكمية', width: '14mm', align: 'center' as const },
    { key: 'price', label: 'سعر الوحدة', width: '20mm', align: 'left' as const },
    { key: 'amount', label: 'المبلغ', width: '24mm', align: 'left' as const, bold: true },
  ];
  const rows = d.items.map(it => ({
    name: [it.productName, it.variantName].filter(Boolean).join(' — '),
    desc: it.description ?? (it.unitName ?? ''),
    qty: fmt(it.quantity),
    price: fmt(it.unitPrice),
    amount: fmt(it.total),
  }));

  const custFields = [
    { label: 'الاسم', value: d.customerName ?? '—' },
    ...(d.customerAddress ? [{ label: 'العنوان', value: d.customerAddress }] : []),
    ...(d.contactPerson ? [{ label: 'شخص التواصل', value: d.contactPerson }] : []),
    ...(d.customerPhone ? [{ label: 'الهاتف', value: d.customerPhone }] : []),
  ];
  const offerFields = [
    { label: 'رقم العرض', value: d.quoteNumber },
    ...(d.quoteDate ? [{ label: 'تاريخ الإصدار', value: d.quoteDate }] : []),
    ...(d.validUntil ? [{ label: 'صالح حتى', value: d.validUntil }] : []),
  ];

  const summaryItems = [
    { label: 'المجموع الفرعي', value: fmtC(d.subtotal) },
    ...(Number(d.taxAmount ?? 0) > 0 ? [{ label: 'ضريبة القيمة المضافة', value: fmtC(d.taxAmount) }] : []),
    { label: 'الإجمالي', value: fmtC(d.total), bold: true, large: true },
  ];

  const extraHeader = d.validUntil ? [{ label: 'صالح حتى', value: d.validUntil }] : [];

  const terms = `<div style="background:${B.orangeLight};border:1px solid ${B.orange};border-radius:4px;
    padding:3mm;margin-bottom:4mm;font-size:9.5px;color:${B.orangeDark};">
    <strong>الشروط والأحكام:</strong>
    <span> • الأسعار لا تشمل التوصيل خارج بغداد • العرض صالح لمدة 5 يوم من تاريخ الإصدار • الأسعار قابلة للتغيير بعد انتهاء صلاحية العرض</span>
  </div>`;

  const notesHtml = d.notes
    ? `<div style="background:${B.bg};border:1px solid ${B.border};border-radius:4px;padding:3mm;margin-bottom:4mm;font-size:9.5px;">
        <strong>ملاحظات: </strong>${esc(d.notes)}</div>`
    : '';

  const body = [
    docHeader('عرض سعر', d.quoteNumber, d.quoteDate ?? undefined, extraHeader),
    docMeta([
      { title: 'معلومات العميل', fields: custFields },
      { title: 'تفاصيل العرض', fields: offerFields },
    ]),
    docTable(cols, rows),
    docSummary(summaryItems),
    terms,
    notesHtml,
    docFooter(),
  ].join('');

  openPrintWindow(wrapA4Doc(`عرض سعر ${d.quoteNumber}`, body));
}

// ═══════════════════════════════════════════════════════════════════════════════
// ٣. أمر شراء — A4
// ═══════════════════════════════════════════════════════════════════════════════

export interface POPrintData {
  poNumber: string;
  poDate?: string | null;
  expectedDate?: string | null;
  supplierName?: string | null;
  supplierPhone?: string | null;
  supplierAddress?: string | null;
  contactPerson?: string | null;
  notes?: string | null;
  items: {
    productName: string;
    unitName?: string | null;
    quantity: string | number;
    unitPrice: string | number;
    total: string | number;
  }[];
  subtotal: string | number;
  taxAmount?: string | number | null;
  total: string | number;
}

export function printPO(d: POPrintData): void {
  const cols = [
    { key: 'name', label: 'الصنف' },
    { key: 'unit', label: 'الوحدة', width: '14mm', align: 'center' as const },
    { key: 'qty', label: 'الكمية', width: '14mm', align: 'center' as const },
    { key: 'price', label: 'سعر الوحدة', width: '22mm', align: 'left' as const },
    { key: 'amount', label: 'المبلغ', width: '26mm', align: 'left' as const, bold: true },
  ];
  const rows = d.items.map(it => ({
    name: it.productName,
    unit: it.unitName ?? '',
    qty: fmt(it.quantity),
    price: fmt(it.unitPrice),
    amount: fmt(it.total),
  }));

  const suppFields = [
    { label: 'الاسم', value: d.supplierName ?? '—' },
    ...(d.supplierAddress ? [{ label: 'العنوان', value: d.supplierAddress }] : []),
    ...(d.contactPerson ? [{ label: 'شخص التواصل', value: d.contactPerson }] : []),
    ...(d.supplierPhone ? [{ label: 'الهاتف', value: d.supplierPhone }] : []),
  ];
  const orderFields = [
    { label: 'رقم الأمر', value: d.poNumber },
    ...(d.poDate ? [{ label: 'تاريخ الإصدار', value: d.poDate }] : []),
    ...(d.expectedDate ? [{ label: 'التسليم المتوقع', value: d.expectedDate }] : []),
  ];

  const summaryItems = [
    { label: 'المجموع الفرعي', value: fmtC(d.subtotal) },
    ...(Number(d.taxAmount ?? 0) > 0 ? [{ label: 'ضريبة القيمة المضافة', value: fmtC(d.taxAmount) }] : []),
    { label: 'الإجمالي', value: fmtC(d.total), bold: true, large: true },
  ];

  const extraHeader = d.expectedDate ? [{ label: 'التسليم المتوقع', value: d.expectedDate }] : [];

  const notesHtml = d.notes
    ? `<div style="background:${B.bg};border:1px solid ${B.border};border-radius:4px;padding:3mm;margin-bottom:4mm;font-size:9.5px;">
        <strong>ملاحظات: </strong>${esc(d.notes)}</div>`
    : '';

  const body = [
    docHeader('أمر شراء', d.poNumber, d.poDate ?? undefined, extraHeader),
    docMeta([
      { title: 'معلومات المورد', fields: suppFields },
      { title: 'تفاصيل الطلب', fields: orderFields },
    ]),
    docTable(cols, rows),
    docSummary(summaryItems),
    notesHtml,
    docFooter(),
  ].join('');

  openPrintWindow(wrapA4Doc(`أمر شراء ${d.poNumber}`, body));
}

// ═══════════════════════════════════════════════════════════════════════════════
// ٤. أمر شغل — A4
// ═══════════════════════════════════════════════════════════════════════════════

export interface WorkOrderPrintData {
  woNumber: string;
  woDate?: string | null;
  dueDate?: string | null;
  status?: string | null;
  customerName?: string | null;
  contactPerson?: string | null;
  customerPhone?: string | null;
  jobType?: string | null;
  specs?: string | null;
  notes?: string | null;
  items: {
    name: string;
    unit?: string | null;
    quantity: string | number;
    unitPrice: string | number;
    total: string | number;
  }[];
  subtotal: string | number;
  taxAmount?: string | number | null;
  total: string | number;
}

const WO_STATUS_COLOR: Record<string, string> = {
  RECEIVED: '#1A9B78', IN_PROGRESS: '#CC7E3F', READY: '#3B82F6',
  DELIVERED: '#059669', CANCELLED: '#DC2626',
};
const WO_STATUS_AR: Record<string, string> = {
  RECEIVED: 'مُستلَم', IN_PROGRESS: 'قيد التنفيذ', READY: 'جاهز للتسليم',
  DELIVERED: 'مُسلَّم', CANCELLED: 'ملغى',
};

export function printWorkOrder(d: WorkOrderPrintData): void {
  const cols = [
    { key: 'name', label: 'البند' },
    { key: 'unit', label: 'الوحدة', width: '14mm', align: 'center' as const },
    { key: 'qty', label: 'الكمية', width: '14mm', align: 'center' as const },
    { key: 'price', label: 'سعر الوحدة', width: '20mm', align: 'left' as const },
    { key: 'amount', label: 'المبلغ', width: '24mm', align: 'left' as const, bold: true },
  ];
  const rows = d.items.map(it => ({
    name: it.name, unit: it.unit ?? '',
    qty: fmt(it.quantity), price: fmt(it.unitPrice), amount: fmt(it.total),
  }));

  const statusColor = WO_STATUS_COLOR[d.status ?? ''] ?? '#6B7280';
  const statusLabel = WO_STATUS_AR[d.status ?? ''] ?? (d.status ?? '');

  const custCard = `<div style="flex:1;background:${B.greenPale};border:1px solid ${B.greenLight};border-radius:4px;padding:3mm;">
    <div style="font-size:10px;font-weight:700;color:${B.green};margin-bottom:2mm;">معلومات العميل</div>
    <div style="font-size:9px;margin-bottom:1mm;"><span style="color:${B.textMuted};">الاسم: </span><strong>${esc(d.customerName ?? '—')}</strong></div>
    ${d.contactPerson ? `<div style="font-size:9px;margin-bottom:1mm;"><span style="color:${B.textMuted};">التواصل: </span><strong>${esc(d.contactPerson)}</strong></div>` : ''}
    ${d.customerPhone ? `<div style="font-size:9px;"><span style="color:${B.textMuted};">الهاتف: </span><strong>${esc(d.customerPhone)}</strong></div>` : ''}
  </div>`;

  const jobCard = `<div style="flex:1;background:${B.orangeLight};border:1px solid ${B.orange}40;border-radius:4px;padding:3mm;">
    <div style="font-size:10px;font-weight:700;color:${B.orangeDark};margin-bottom:2mm;">تفاصيل العمل</div>
    ${d.jobType ? `<div style="font-size:9px;margin-bottom:1mm;"><span style="color:${B.textMuted};">نوع العمل: </span><strong>${esc(d.jobType)}</strong></div>` : ''}
    ${d.specs ? `<div style="font-size:9px;margin-bottom:1mm;"><span style="color:${B.textMuted};">المواصفات: </span><strong>${esc(d.specs)}</strong></div>` : ''}
    <div style="font-size:9px;display:flex;align-items:center;gap:2mm;">
      <span style="color:${B.textMuted};">الحالة: </span>
      <span style="background:${statusColor};color:#fff;padding:0.5mm 3mm;border-radius:10px;font-size:8.5px;font-weight:600;">${esc(statusLabel)}</span>
    </div>
  </div>`;

  const summaryItems = [
    { label: 'المجموع الفرعي', value: fmtC(d.subtotal) },
    ...(Number(d.taxAmount ?? 0) > 0 ? [{ label: 'ضريبة القيمة المضافة', value: fmtC(d.taxAmount) }] : []),
    { label: 'الإجمالي', value: fmtC(d.total), bold: true, large: true },
  ];

  const notesHtml = d.notes
    ? `<div style="background:${B.bg};border:1px solid ${B.border};border-radius:4px;
        padding:3mm;margin-bottom:4mm;font-size:9px;white-space:pre-line;">
        <strong>ملاحظات: </strong>${esc(d.notes)}</div>`
    : '';

  const signatures = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12mm;margin-top:8mm;margin-bottom:5mm;">
    <div style="text-align:center;border-top:1px solid ${B.borderDk};padding-top:2mm;">
      <div style="font-size:9px;color:${B.textMuted};">توقيع المسؤول</div></div>
    <div style="text-align:center;border-top:1px solid ${B.borderDk};padding-top:2mm;">
      <div style="font-size:9px;color:${B.textMuted};">توقيع العميل</div></div>
  </div>`;

  const extraHeader = d.dueDate ? [{ label: 'تاريخ التسليم', value: d.dueDate }] : [];

  const body = [
    docHeader('أمر شغل', d.woNumber, d.woDate ?? undefined, extraHeader),
    `<div style="display:flex;gap:3mm;margin-bottom:4mm;">${custCard}${jobCard}</div>`,
    docTable(cols, rows),
    docSummary(summaryItems),
    notesHtml,
    signatures,
    docFooter(),
  ].join('');

  openPrintWindow(wrapA4Doc(`أمر شغل ${d.woNumber}`, body));
}

// ═══════════════════════════════════════════════════════════════════════════════
// ٥. كشف حساب عميل — A4
// ═══════════════════════════════════════════════════════════════════════════════

export interface CustomerStmtPrintData {
  customerName: string;
  customerCode?: string | null;
  customerPhone?: string | null;
  customerAddress?: string | null;
  fromDate?: string | null;
  toDate?: string | null;
  transactions: {
    date: string;
    ref: string;
    description: string;
    debit?: string | number | null;
    credit?: string | number | null;
    balance: string | number;
  }[];
  totalDebit: string | number;
  totalCredit: string | number;
  openingBalance?: string | number | null;
  closingBalance: string | number;
}

export function printCustomerStmt(d: CustomerStmtPrintData): void {
  const cols = [
    { key: 'date', label: 'التاريخ', width: '18mm', align: 'center' as const },
    { key: 'ref', label: 'المرجع', width: '24mm' },
    { key: 'desc', label: 'البيان' },
    { key: 'debit', label: 'مدين', width: '20mm', align: 'left' as const },
    { key: 'credit', label: 'دائن', width: '20mm', align: 'left' as const },
    { key: 'bal', label: 'الرصيد', width: '22mm', align: 'left' as const, bold: true },
  ];
  const rows = d.transactions.map(t => ({
    date: t.date, ref: t.ref, desc: t.description,
    debit: t.debit ? fmt(t.debit) : '',
    credit: t.credit ? fmt(t.credit) : '',
    bal: fmt(t.balance),
  }));

  const custFields = [
    { label: 'الاسم', value: d.customerName },
    ...(d.customerCode ? [{ label: 'كود العميل', value: d.customerCode }] : []),
    ...(d.customerAddress ? [{ label: 'العنوان', value: d.customerAddress }] : []),
    ...(d.customerPhone ? [{ label: 'الهاتف', value: d.customerPhone }] : []),
  ];
  const summFields = [
    ...(d.openingBalance != null ? [{ label: 'الرصيد الافتتاحي', value: fmtC(d.openingBalance) }] : []),
    { label: 'إجمالي المدين', value: fmtC(d.totalDebit) },
    { label: 'إجمالي الدائن', value: fmtC(d.totalCredit) },
    { label: 'الرصيد الختامي', value: fmtC(d.closingBalance) },
  ];

  const period = [d.fromDate, d.toDate].filter(Boolean).join(' — ');
  const extraHeader = period ? [{ label: 'الفترة', value: period }] : [];

  const summaryItems = [
    { label: 'إجمالي المدين', value: fmtC(d.totalDebit) },
    { label: 'إجمالي الدائن', value: fmtC(d.totalCredit) },
    { label: 'الرصيد الختامي', value: fmtC(d.closingBalance), bold: true, large: true },
  ];

  const body = [
    docHeader('كشف حساب عميل', undefined, d.toDate ?? undefined, extraHeader),
    docMeta([
      { title: 'معلومات العميل', fields: custFields },
      { title: 'ملخّص الحساب', fields: summFields },
    ]),
    docTable(cols, rows),
    docSummary(summaryItems),
    docFooter(),
  ].join('');

  openPrintWindow(wrapA4Doc(`كشف حساب — ${d.customerName}`, body));
}

// ═══════════════════════════════════════════════════════════════════════════════
// ٦. كشف حساب مورد — A4
// ═══════════════════════════════════════════════════════════════════════════════

export interface SupplierStmtPrintData {
  supplierName: string;
  supplierCode?: string | null;
  supplierPhone?: string | null;
  supplierAddress?: string | null;
  fromDate?: string | null;
  toDate?: string | null;
  transactions: {
    date: string;
    ref: string;
    description: string;
    debit?: string | number | null;
    credit?: string | number | null;
    balance: string | number;
  }[];
  totalDebit: string | number;
  totalCredit: string | number;
  openingBalance?: string | number | null;
  closingBalance: string | number;
}

export function printSupplierStmt(d: SupplierStmtPrintData): void {
  const cols = [
    { key: 'date', label: 'التاريخ', width: '18mm', align: 'center' as const },
    { key: 'ref', label: 'المرجع', width: '24mm' },
    { key: 'desc', label: 'البيان' },
    { key: 'debit', label: 'مدين', width: '20mm', align: 'left' as const },
    { key: 'credit', label: 'دائن', width: '20mm', align: 'left' as const },
    { key: 'bal', label: 'الرصيد', width: '22mm', align: 'left' as const, bold: true },
  ];
  const rows = d.transactions.map(t => ({
    date: t.date, ref: t.ref, desc: t.description,
    debit: t.debit ? fmt(t.debit) : '',
    credit: t.credit ? fmt(t.credit) : '',
    bal: `${fmt(Math.abs(Number(t.balance)))} (دائن)`,
  }));

  const suppFields = [
    { label: 'الاسم', value: d.supplierName },
    ...(d.supplierCode ? [{ label: 'كود المورد', value: d.supplierCode }] : []),
    ...(d.supplierAddress ? [{ label: 'العنوان', value: d.supplierAddress }] : []),
    ...(d.supplierPhone ? [{ label: 'الهاتف', value: d.supplierPhone }] : []),
  ];
  const summFields = [
    ...(d.openingBalance != null
      ? [{ label: 'الرصيد الافتتاحي', value: `${fmtC(Math.abs(Number(d.openingBalance)))} (دائن)` }]
      : []),
    { label: 'إجمالي المدين', value: fmtC(d.totalDebit) },
    { label: 'إجمالي الدائن', value: fmtC(d.totalCredit) },
    { label: 'الرصيد الختامي', value: `${fmtC(Math.abs(Number(d.closingBalance)))} (دائن)` },
  ];

  const period = [d.fromDate, d.toDate].filter(Boolean).join(' — ');
  const extraHeader = period ? [{ label: 'الفترة', value: period }] : [];

  const summaryItems = [
    { label: 'إجمالي المدين', value: fmtC(d.totalDebit) },
    { label: 'إجمالي الدائن', value: fmtC(d.totalCredit) },
    { label: 'الرصيد الختامي (مستحق للمورد)', value: fmtC(Math.abs(Number(d.closingBalance))), bold: true, large: true },
  ];

  const body = [
    docHeader('كشف حساب مورد', undefined, d.toDate ?? undefined, extraHeader),
    docMeta([
      { title: 'معلومات المورد', fields: suppFields },
      { title: 'ملخّص الحساب', fields: summFields },
    ]),
    docTable(cols, rows),
    docSummary(summaryItems),
    docFooter(),
  ].join('');

  openPrintWindow(wrapA4Doc(`كشف حساب — ${d.supplierName}`, body));
}

// ═══════════════════════════════════════════════════════════════════════════════
// ٧. تقرير أعمار الذمم المدينة — A4
// ═══════════════════════════════════════════════════════════════════════════════

export interface ARAgingPrintData {
  date: string;
  rows: { name: string; d0_30: number; d31_60: number; d61_90: number; d91p: number; unpaidTotal: number; currentBalance: number; }[];
  totals: { d0_30: number; d31_60: number; d61_90: number; d91p: number; unpaidTotal: number; currentBalance: number; };
}

export function printARAging(d: ARAgingPrintData): void {
  const cols = [
    { key: 'name', label: 'العميل' },
    { key: 'd0_30', label: '0–30 يوم', width: '18mm', align: 'left' as const },
    { key: 'd31_60', label: '31–60 يوم', width: '18mm', align: 'left' as const },
    { key: 'd61_90', label: '61–90 يوم', width: '18mm', align: 'left' as const },
    { key: 'd91p', label: 'أكثر من 90', width: '18mm', align: 'left' as const },
    { key: 'unpaid', label: 'إجمالي غير المسدّد', width: '22mm', align: 'left' as const, bold: true },
    { key: 'balance', label: 'الرصيد الجاري', width: '20mm', align: 'left' as const },
  ];
  const rows = d.rows.map(r => ({
    name: r.name,
    d0_30: r.d0_30 ? fmt(r.d0_30) : '—',
    d31_60: r.d31_60 ? fmt(r.d31_60) : '—',
    d61_90: r.d61_90 ? fmt(r.d61_90) : '—',
    d91p: r.d91p ? fmt(r.d91p) : '—',
    unpaid: fmt(r.unpaidTotal),
    balance: fmt(r.currentBalance),
  }));

  const t = d.totals;
  const pcts = [
    { label: '0–30', val: t.d0_30, color: '#1A9B78' },
    { label: '31–60', val: t.d31_60, color: '#3B82F6' },
    { label: '61–90', val: t.d61_90, color: '#CC7E3F' },
    { label: '>90', val: t.d91p, color: '#DC2626' },
  ];

  const totalsRow = `<div style="display:flex;background:${B.green};color:#fff;border-radius:0 0 4px 4px;
    padding:2.5mm 3mm;font-size:10px;font-weight:700;margin-top:-4mm;margin-bottom:4mm;">
    <span style="flex:1;">الإجمالي</span>
    <span style="width:18mm;text-align:left;">${fmt(t.d0_30)}</span>
    <span style="width:18mm;text-align:left;">${fmt(t.d31_60)}</span>
    <span style="width:18mm;text-align:left;">${fmt(t.d61_90)}</span>
    <span style="width:18mm;text-align:left;">${fmt(t.d91p)}</span>
    <span style="width:22mm;text-align:left;font-size:11px;">${fmt(t.unpaidTotal)}</span>
    <span style="width:20mm;text-align:left;">${fmt(t.currentBalance)}</span>
  </div>`;

  const body = [
    docHeader('تقرير أعمار الذمم المدينة', undefined, d.date),
    agingSummaryBars(pcts, t.unpaidTotal),
    docTable(cols, rows, false),
    totalsRow,
    docFooter(),
  ].join('');

  openPrintWindow(wrapA4Doc('أعمار الذمم المدينة', body));
}

// ═══════════════════════════════════════════════════════════════════════════════
// ٨. تقرير أعمار الذمم الدائنة — A4
// ═══════════════════════════════════════════════════════════════════════════════

export interface APAgingPrintData {
  date: string;
  rows: { name: string; d0_30: number; d31_60: number; d61_90: number; d91p: number; unpaidTotal: number; currentBalance: number; }[];
  totals: { d0_30: number; d31_60: number; d61_90: number; d91p: number; unpaidTotal: number; currentBalance: number; };
}

export function printAPAging(d: APAgingPrintData): void {
  const cols = [
    { key: 'name', label: 'المورد' },
    { key: 'd0_30', label: '0–30 يوم', width: '18mm', align: 'left' as const },
    { key: 'd31_60', label: '31–60 يوم', width: '18mm', align: 'left' as const },
    { key: 'd61_90', label: '61–90 يوم', width: '18mm', align: 'left' as const },
    { key: 'd91p', label: 'أكثر من 90', width: '18mm', align: 'left' as const },
    { key: 'unpaid', label: 'إجمالي مستحق', width: '22mm', align: 'left' as const, bold: true },
    { key: 'balance', label: 'الرصيد', width: '20mm', align: 'left' as const },
  ];
  const rows = d.rows.map(r => ({
    name: r.name,
    d0_30: r.d0_30 ? fmt(r.d0_30) : '—',
    d31_60: r.d31_60 ? fmt(r.d31_60) : '—',
    d61_90: r.d61_90 ? fmt(r.d61_90) : '—',
    d91p: r.d91p ? fmt(r.d91p) : '—',
    unpaid: fmt(r.unpaidTotal),
    balance: fmt(r.currentBalance),
  }));

  const t = d.totals;
  const pcts = [
    { label: '0–30', val: t.d0_30, color: '#1A9B78' },
    { label: '31–60', val: t.d31_60, color: '#3B82F6' },
    { label: '61–90', val: t.d61_90, color: '#CC7E3F' },
    { label: '>90', val: t.d91p, color: '#DC2626' },
  ];

  const totalsRow = `<div style="display:flex;background:#DC2626;color:#fff;border-radius:0 0 4px 4px;
    padding:2.5mm 3mm;font-size:10px;font-weight:700;margin-top:-4mm;margin-bottom:4mm;">
    <span style="flex:1;">الإجمالي</span>
    <span style="width:18mm;text-align:left;">${fmt(t.d0_30)}</span>
    <span style="width:18mm;text-align:left;">${fmt(t.d31_60)}</span>
    <span style="width:18mm;text-align:left;">${fmt(t.d61_90)}</span>
    <span style="width:18mm;text-align:left;">${fmt(t.d91p)}</span>
    <span style="width:22mm;text-align:left;font-size:11px;">${fmt(t.unpaidTotal)}</span>
    <span style="width:20mm;text-align:left;">${fmt(t.currentBalance)}</span>
  </div>`;

  const body = [
    docHeader('تقرير أعمار الذمم الدائنة', undefined, d.date),
    agingSummaryBars(pcts, t.unpaidTotal),
    docTable(cols, rows, false),
    totalsRow,
    docFooter(),
  ].join('');

  openPrintWindow(wrapA4Doc('أعمار الذمم الدائنة', body));
}

// ═══════════════════════════════════════════════════════════════════════════════
// ٩. ملصقات الباركود — A4 شبكي
// ═══════════════════════════════════════════════════════════════════════════════

export interface BarcodeLabelItem {
  name: string;
  sku: string;
  price: string | number;
  barcode: string;
}

export function printBarcodeSheet(items: BarcodeLabelItem[]): void {
  const logo = logoUrl();
  const today = new Date().toLocaleDateString('ar-IQ');

  const labels = items.map(item => {
    let barSvg = '';
    try {
      const result = code128Svg(item.barcode, { moduleWidth: 1.2, height: 40, showText: true });
      barSvg = result.svg;
    } catch { /* ignore */ }

    return `<div style="border:1px solid ${B.border};border-radius:3px;padding:2.5mm;text-align:center;break-inside:avoid;">
      <div style="font-size:9px;font-weight:600;color:#000;margin-bottom:1.5mm;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(item.name)}</div>
      <div style="width:100%;overflow:hidden;">${barSvg}</div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:1.5mm;padding:0 1mm;">
        <span style="font-size:8px;color:${B.textMuted};">${esc(item.sku)}</span>
        <span style="font-size:10px;font-weight:700;color:${B.green};">${fmtC(item.price)}</span>
      </div>
    </div>`;
  }).join('');

  const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>ملصقات الباركود</title>
  ${CAIRO_FONT}
  <style>*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}body{font-family:'Cairo',sans-serif;background:#fff;color:#000;direction:rtl}@page{size:A4;margin:0}</style>
  </head>
  <body style="width:210mm;min-height:297mm;background:#fff;position:relative;overflow:hidden;">
  <div style="position:absolute;top:0;right:0;bottom:0;width:4mm;background:linear-gradient(to bottom,${B.green},${B.greenDark} 40%,${B.orange} 100%);"></div>
  <div style="position:absolute;top:0;right:4mm;left:0;height:5.5mm;background:linear-gradient(135deg,${B.green},${B.greenDark} 60%,${B.greenDeep} 100%);"></div>
  <div style="padding:8mm 10mm;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5mm;">
      <div style="display:flex;align-items:center;gap:2mm;">
        <img src="${logo}" style="width:10mm;height:10mm;object-fit:contain;" alt="" onerror="this.style.display='none'">
        <span style="font-size:11px;font-weight:700;color:${B.greenDark};">${esc(CO.sub)}</span>
      </div>
      <span style="font-size:9px;color:${B.textMuted};">ملصقات الباركود — طباعة ${esc(today)}</span>
    </div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:3mm;">${labels}</div>
  </div>
  <div style="position:absolute;bottom:0;right:4mm;left:0;height:3.5mm;background:linear-gradient(135deg,${B.greenDark},${B.green} 100%);"></div>
  </body></html>`;

  openPrintWindow(html);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ١٠. إيصال نقطة البيع (بديل المتصفح — 80mm)
// ═══════════════════════════════════════════════════════════════════════════════

export interface ReceiptBrowserData {
  receiptNumber: string;
  date: string;
  time?: string | null;
  cashierName?: string | null;
  items: {
    name: string;
    quantity: number;
    price: string | number;
    total: string | number;
  }[];
  subtotal: string | number;
  tax?: string | number | null;
  total: string | number;
  paid?: string | number | null;
  change?: string | number | null;
}

export function printBrowserReceipt(d: ReceiptBrowserData): void {
  const logo = logoUrl();

  let barSvg = '';
  try {
    const bc = code128Svg(d.receiptNumber, { moduleWidth: 0.8, height: 35, showText: true });
    barSvg = bc.svg;
  } catch { /* ignore */ }

  const itemRows = d.items.map(it => `<tr>
    <td style="padding:1mm 0;">${esc(it.name)}</td>
    <td style="text-align:center;">${it.quantity}</td>
    <td style="text-align:left;">${fmt(it.price)}</td>
    <td style="text-align:left;font-weight:600;">${fmt(it.total)}</td>
  </tr>`).join('');

  const rctPhones = [
    { dept: 'الحسابات', num: '07883000017' },
    { dept: 'المبيعات / واتساب', num: '07838666999' },
    { dept: 'المبيعات', num: '07833484932' },
    { dept: 'الطباعة', num: '07838484932' },
  ];
  const contactRows = rctPhones.map(p => `<tr style="border-bottom:1px dashed #ccc;">
    <td style="padding:1mm 0;font-weight:600;">${esc(p.dept)}</td>
    <td style="padding:1mm 0;text-align:left;direction:ltr;font-weight:700;letter-spacing:0.3px;">${esc(p.num)}</td>
  </tr>`).join('');

  const body = `
  <div style="text-align:center;margin-bottom:2mm;">
    <img src="${logo}" style="width:20mm;height:20mm;object-fit:contain;" alt="" onerror="this.style.display='none'">
    <div style="font-size:18px;font-weight:900;margin-top:1.5mm;letter-spacing:-0.3px;">مكتبة العربية</div>
    <div style="font-size:12px;font-weight:800;margin-top:0.5mm;">للطباعة والقرطاسية</div>
    <div style="font-size:7.5px;color:#555;margin-top:0.5mm;">${esc(CO.name)}</div>
  </div>
  <div style="border-bottom:2px solid #000;margin:2mm 0;"></div>
  <div style="margin:2mm 0;text-align:center;">${barSvg}</div>
  <div style="display:flex;justify-content:space-between;font-size:10px;margin-bottom:1mm;">
    <span>رقم: <strong>${esc(d.receiptNumber)}</strong></span><span>${esc(d.date)}</span>
  </div>
  <div style="display:flex;justify-content:space-between;font-size:10px;margin-bottom:1mm;">
    ${d.cashierName ? `<span>الكاشير: ${esc(d.cashierName)}</span>` : '<span></span>'}
    ${d.time ? `<span>الوقت: ${esc(d.time)}</span>` : '<span></span>'}
  </div>
  <div style="border-bottom:1px dashed #999;margin:2mm 0;"></div>
  <table style="width:100%;font-size:10px;border-collapse:collapse;">
    <thead><tr style="border-bottom:1px solid #000;">
      <th style="text-align:right;padding:1mm 0;font-weight:700;">الصنف</th>
      <th style="text-align:center;padding:1mm 0;font-weight:700;width:8mm;">عدد</th>
      <th style="text-align:left;padding:1mm 0;font-weight:700;width:14mm;">السعر</th>
      <th style="text-align:left;padding:1mm 0;font-weight:700;width:16mm;">المبلغ</th>
    </tr></thead>
    <tbody>${itemRows}</tbody>
  </table>
  <div style="border-bottom:1px dashed #999;margin:2mm 0;"></div>
  <div style="font-size:10.5px;">
    <div style="display:flex;justify-content:space-between;"><span>المجموع:</span><span>${fmt(d.subtotal)}</span></div>
    ${Number(d.tax ?? 0) > 0 ? `<div style="display:flex;justify-content:space-between;"><span>الضريبة:</span><span>${fmt(d.tax)}</span></div>` : ''}
    <div style="display:flex;justify-content:space-between;font-weight:900;font-size:14px;margin:1.5mm 0;
      padding:1.5mm 0;border-top:1px solid #000;border-bottom:1px solid #000;">
      <span>الإجمالي:</span><span>${fmt(d.total)} د.ع</span>
    </div>
    ${d.paid != null ? `<div style="display:flex;justify-content:space-between;"><span>المدفوع:</span><span>${fmt(d.paid)}</span></div>` : ''}
    ${d.change != null ? `<div style="display:flex;justify-content:space-between;"><span>الباقي:</span><span>${fmt(d.change)}</span></div>` : ''}
  </div>
  <div style="border-bottom:1px dashed #999;margin:2mm 0;"></div>
  <div style="text-align:center;margin:3mm 0 1mm;">
    <div style="font-size:12px;font-weight:900;">شكراً لتسوقكم معنا</div>
    <div style="font-size:9px;color:#555;">نتمنى لكم تجربة ممتعة</div>
  </div>
  <div style="border-bottom:1px dashed #999;margin:2mm 0;"></div>
  <table style="width:100%;font-size:9.5px;border-collapse:collapse;margin:1mm 0;">
    <thead><tr style="border-bottom:1px solid #000;">
      <th style="text-align:right;padding:1mm 0;font-weight:700;">القسم</th>
      <th style="text-align:left;padding:1mm 0;font-weight:700;">رقم التواصل</th>
    </tr></thead>
    <tbody>${contactRows}</tbody>
  </table>
  <div style="text-align:center;font-size:9px;font-weight:600;margin:2mm 0 1mm;">
    بغداد — العامرية / شارع العمل الشعبي
  </div>
  <div style="border-bottom:1px dashed #999;margin:2mm 0;"></div>
  <div style="text-align:center;margin:2mm 0;padding:2mm;border:1.5px solid #000;border-radius:2px;font-size:9px;font-weight:700;line-height:1.6;">
    نعتذر عن قبول الاسترجاع — والاستبدال متاح<br>
    خلال 48 ساعة بشرط سلامة المنتج بـ100%
  </div>`;

  openPrintWindow(wrapReceiptDoc(`إيصال ${d.receiptNumber}`, body), 'width=380,height=700');
}
