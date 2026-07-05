/**
 * قوالب طباعة مكتبة العربية.
 * الثمانية الرَسميّة (فاتورتان، تقرير مبيعات، عرض سعر، طلب خدمة، كشف حساب، سندَا قبض/دفع) تُنفَّذ
 * بالتصميم عالي الدقة في printTemplatesV2.ts (تسليم ٥/٧/٢٦). دوال هذا الملف بأسمائها القديمة تُحوَّل
 * صراحةً إلى نظرائها V2 (adapter بسيط) حتى لا تتأثّر شاشات النظام. القوالب المتبقّية (aging، production،
 * receipts، shift، barcode labels) خارج نطاق التسليم وتُبقى بتصميمها السابق (يستفيد كل الطباعة من ألوان
 * وخطّ التذييل الجديدة عبر brand.ts + docHtml.ts).
 */
import { BRAND as B, CO, RECEIPT_PHONES, esc, fmt, fmtC, openPrintWindow, logoUrl } from './brand';
import {
  wrapA4Doc, wrapReceiptDoc,
  docHeader, docMeta, docTable, docSummary, docFooter, agingSummaryBars,
} from './docHtml';
import {
  printSalesInvoiceV2, printPurchaseInvoiceV2,
  printQuotationV2, printWorkOrderV2, printStatementV2,
  printSalesReportV2,
} from './printTemplatesV2';

/** إعادة تصدير قوالب V2 الرَسميّة للاستخدام المباشر (فاتورة مشتريات + تقرير مبيعات جديدان بلا نظير قديم). */
export {
  printSalesInvoiceV2, printPurchaseInvoiceV2, printQuotationV2,
  printWorkOrderV2, printStatementV2, printSalesReportV2,
} from './printTemplatesV2';
export type {
  SalesInvoiceV2Data, PurchaseInvoiceV2Data, QuotationV2Data,
  WorkOrderV2Data, StatementV2Data, SalesReportV2Data, VoucherV2Data,
} from './printTemplatesV2';
import { qrCodeSvg } from './qr';
import { code128Svg } from './barcode';
import { type LabelRenderItem, type LabelRenderOpts } from './labelRaster';
import { getLabelSize, type LabelSize } from './labelSize';
import { labelDocHtml } from './labelDesign';

// ─── إعدادات الشركة المشتركة (تُقرأ من settings مستقبلاً — الآن ثابتات brand.ts) ──
const COMPANY_SETTINGS = {
  taxId: CO.taxId,
  commercialRegistry: CO.commercialRegistry,
  chamberLicense: CO.chamberLicense,
};

/**
 * يستنتج نوع الحركة وشارتها اللونية في كشف الحساب المفصّل **من نصّ البيان نفسه** لا من إشارة
 * مدين/دائن وحدها. كشف حالها القديم كان يصنِّف كل صفٍّ مدين «فاتورة» — خطأ فادح لحركات مدينة
 * أخرى تماماً (سند صرف مستقل، استرداد من المورّد، مرتجع) تُنتج تصنيفاً متناقضاً كـ«فاتورة — استرداد».
 * الترتيب أهمّ: أخصّ الكلمات المفتاحية أولاً (مرتجع/استرداد قبل فاتورة/سند العامّين).
 */
function inferStatementTypeLabel(description: string, debit: string | number | null | undefined): { label: string; color: string } {
  const s = description ?? '';
  if (s.includes('مرتجع')) return { label: 'مرتجع', color: B.orange };
  if (s.includes('استرداد')) return { label: 'استرداد', color: B.orange };
  if (s.includes('تسوية')) return { label: 'تسوية', color: B.green };
  if (s.includes('سند قبض')) return { label: 'سند قبض', color: B.green };
  if (s.includes('سند صرف') || s.includes('سند دفع')) return { label: 'سند دفع', color: B.green };
  if (s.includes('فاتورة مبيعات')) return { label: 'فاتورة مبيعات', color: '#8A1F11' };
  if (s.includes('فاتورة مشتريات')) return { label: 'فاتورة مشتريات', color: '#8A1F11' };
  if (s.includes('فاتورة')) return { label: 'فاتورة', color: '#8A1F11' };
  if (s.includes('أمر شراء')) return { label: 'أمر شراء', color: '#8A1F11' };
  if (s.includes('شراء')) return { label: 'شراء', color: '#8A1F11' };
  if (s.includes('دفعة')) return { label: 'دفعة', color: B.green };
  // fallback: السلوك القديم لبيانات لا تحمل كلمات مفتاحية معروفة.
  return Number(debit ?? 0) > 0 ? { label: 'فاتورة', color: '#8A1F11' } : { label: 'سند', color: B.green };
}

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
  /** الرقم الضريبي **للشركة** (من إعدادات النظام) — يُطبع في «معلومات ضريبية» بجانب رقم العميل. */
  companyTaxId?: string | null;
  paymentMethod?: string | null;
  notes?: string | null;
  items: {
    productName: string;
    unitName?: string | null;
    quantity: string | number;
    unitPrice: string | number;
    total: string | number;
    /** حصة السطر من ضريبة الفاتورة (اختياري، decimal-string 2dp). عند وجود قيمة موجبة واحدة
     *  على الأقلّ بين البنود، يُدرَج عمود «الضريبة» في جدول العناصر بجانب «المبلغ». */
    taxAmount?: string | number | null;
  }[];
  subtotal: string | number;
  discountAmount?: string | number | null;
  taxAmount?: string | number | null;
  taxRate?: number | null;
  total: string | number;
  paidAmount?: string | number | null;
}

export async function printInvoiceA4(d: InvoicePrintData): Promise<void> {
  // hifi-redesign (٥/٧/٢٦): ينفَّذ عبر printSalesInvoiceV2 بالتصميم المرجعي. الحقول الوصفية (customerTaxId/
  // companyTaxId/notes) لم تعُد تظهر بالترويسة الجديدة (الأرقام القانونية تُقرأ من إعدادات الشركة).
  const date = d.invoiceDate
    ? new Date(d.invoiceDate as string).toLocaleDateString('en-GB')
    : new Date().toLocaleDateString('en-GB');

  const qrPayload = [
    CO.sub,
    `رقم الفاتورة: ${d.invoiceNumber}`,
    `التاريخ: ${date}`,
    `الإجمالي: ${fmtC(d.total)}`,
  ].join('\n');
  const qrSvg = await qrCodeSvg(qrPayload, { size: 88, margin: 1 }).catch(() => '');

  const remainingNum = Math.max(Number(d.total) - Number(d.paidAmount ?? 0), 0);
  const statusLabel = remainingNum <= 0.001
    ? 'مدفوعة'
    : (Number(d.paidAmount ?? 0) > 0 ? 'مدفوعة جزئياً' : 'آجلة');
  const statusColor = remainingNum <= 0.001 ? '#0D6B52' : (Number(d.paidAmount ?? 0) > 0 ? '#92400E' : '#8A1F11');

  printSalesInvoiceV2({
    invoiceNumber: d.invoiceNumber,
    invoiceDate: d.invoiceDate,
    statusLabel,
    statusColor,
    customerName: d.customerName,
    customerAddress: d.customerAddress,
    customerPhone: d.customerPhone,
    paymentMethod: d.paymentMethod,
    items: d.items.map((it) => ({
      productName: it.productName,
      unitName: it.unitName,
      quantity: it.quantity,
      unitPrice: it.unitPrice,
      taxAmount: it.taxAmount ?? null,
      total: it.total,
    })),
    subtotal: d.subtotal,
    discountAmount: d.discountAmount ?? null,
    taxAmount: d.taxAmount ?? null,
    taxRate: d.taxRate ?? null,
    total: d.total,
    paidAmount: d.paidAmount ?? null,
    qrSvg: qrSvg || null,
    settings: {
      taxId: d.companyTaxId ?? COMPANY_SETTINGS.taxId,
      commercialRegistry: COMPANY_SETTINGS.commercialRegistry,
      chamberLicense: COMPANY_SETTINGS.chamberLicense,
    },
  });
  return;
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
  // hifi-redesign (٥/٧/٢٦): يحوَّل إلى printQuotationV2 بالتصميم المرجعي (٦ أعمدة صنف/وحدة/كمية/سعر/ضريبة/إجمالي،
  // شروط في صندوق أخضر داخلي، توقيعا العميل والممثّل التجاري). description القديم يُلحَق باسم المنتج.
  printQuotationV2({
    quoteNumber: d.quoteNumber,
    quoteDate: d.quoteDate,
    validUntil: d.validUntil,
    customerName: d.customerName,
    contactPerson: d.contactPerson,
    customerPhone: d.customerPhone,
    items: d.items.map((it) => ({
      // الوصف يُلحَق باسم المنتج (لا يستولي على عمود الوحدة). عمود «الوحدة» يبقى للوحدة الفعلية
      // (قطعة/كرتون/…) — كسر الفصل بين العمودين كان يُظهر نصاً طويلاً محلّ الوحدة.
      productName: [it.productName, it.variantName, it.description].filter(Boolean).join(' — '),
      unitName: it.unitName ?? null,
      quantity: it.quantity,
      unitPrice: it.unitPrice,
      total: it.total,
    })),
    subtotal: d.subtotal,
    taxAmount: d.taxAmount ?? null,
    total: d.total,
    terms: d.notes ?? null,
    settings: COMPANY_SETTINGS,
  });
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
    { key: 'name', label: 'المنتج' },
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
// ٤. طلب خدمة — A4
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
  // hifi-redesign (٥/٧/٢٦): يحوَّل إلى printWorkOrderV2 بالتصميم المرجعي (بلا عمود ضريبة، توقيعا الفني والعميل،
  // شارة الحالة الملوّنة أعلى الترويسة). notes القديم = ملاحظات التشغيل الجديدة.
  const statusLabel = WO_STATUS_AR[d.status ?? ''] ?? (d.status ?? '');
  const statusColor = WO_STATUS_COLOR[d.status ?? ''] ?? '#92400E';
  printWorkOrderV2({
    woNumber: d.woNumber,
    woDate: d.woDate,
    dueDate: d.dueDate,
    statusLabel: statusLabel || null,
    statusColor,
    customerName: d.customerName,
    customerPhone: d.customerPhone,
    jobType: d.jobType,
    jobSpecs: d.specs,
    items: d.items.map((it) => ({
      name: it.name,
      unit: it.unit ?? null,
      quantity: it.quantity,
      unitPrice: it.unitPrice,
      total: it.total,
    })),
    total: d.total,
    operationNotes: d.notes,
    settings: COMPANY_SETTINGS,
  });
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
  // hifi-redesign (٥/٧/٢٦): يحوَّل إلى printStatementV2 (كشف مفصّل). صف تفاصيل تحت كل حركة يشرح
  // محتوى الفاتورة/السند. النوع = "customer".
  const periodLabel = [d.fromDate, d.toDate].filter(Boolean).join(' — ') || '—';
  printStatementV2({
    partyKind: 'customer',
    partyName: d.customerName,
    partyPhone: d.customerPhone,
    periodLabel,
    openingBalance: d.openingBalance ?? 0,
    transactionsCount: d.transactions.length,
    transactions: d.transactions.map((t) => {
      const { label, color } = inferStatementTypeLabel(t.description, t.debit);
      return {
        date: t.date,
        ref: t.ref,
        description: t.description,
        debit: t.debit ?? null,
        credit: t.credit ?? null,
        balance: t.balance,
        typeLabel: label,
        typeColor: color,
        details: t.description,
      };
    }),
    totalDebit: d.totalDebit,
    totalCredit: d.totalCredit,
    closingBalance: d.closingBalance,
    settings: COMPANY_SETTINGS,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// كشف حساب جهة توصيل (COD) — A4: مدين=عهدة خرجت، دائن=مورَّد/مشطوب، + مستحقات الجهة (أجور)
export interface DeliveryPartyStmtPrintData {
  partyName: string;
  partyType?: string | null;
  partyPhone?: string | null;
  fromDate?: string | null;
  toDate?: string | null;
  transactions: { date: string; ref: string; description: string; debit?: string | number | null; credit?: string | number | null; balance: string | number }[];
  totalDispatched: string | number;
  totalSettled: string | number;
  totalFees: string | number;
  closingBalance: string | number;
}

export function printDeliveryPartyStmt(d: DeliveryPartyStmtPrintData): void {
  const cols = [
    { key: 'date', label: 'التاريخ', width: '18mm', align: 'center' as const },
    { key: 'ref', label: 'المرجع', width: '28mm' },
    { key: 'desc', label: 'البيان' },
    { key: 'debit', label: 'مدين (عهدة)', width: '22mm', align: 'left' as const },
    { key: 'credit', label: 'دائن (مورَّد)', width: '22mm', align: 'left' as const },
    { key: 'bal', label: 'العهدة', width: '22mm', align: 'left' as const, bold: true },
  ];
  const rows = d.transactions.map(t => ({
    date: t.date, ref: t.ref, desc: t.description,
    debit: t.debit ? fmt(t.debit) : '',
    credit: t.credit ? fmt(t.credit) : '',
    bal: fmt(t.balance),
  }));
  const partyFields = [
    { label: 'الجهة', value: d.partyName },
    ...(d.partyType ? [{ label: 'النوع', value: d.partyType }] : []),
    ...(d.partyPhone ? [{ label: 'الهاتف', value: d.partyPhone }] : []),
  ];
  const summFields = [
    { label: 'إجمالي العهدة (COD)', value: fmtC(d.totalDispatched) },
    { label: 'إجمالي المورَّد/المشطوب', value: fmtC(d.totalSettled) },
    { label: 'مستحقات الجهة (أجور)', value: fmtC(d.totalFees) },
    { label: 'العهدة القائمة', value: fmtC(d.closingBalance) },
  ];
  const period = [d.fromDate, d.toDate].filter(Boolean).join(' — ');
  const extraHeader = period ? [{ label: 'الفترة', value: period }] : [];
  const summaryItems = [
    { label: 'مستحقات الجهة (أجور توصيل)', value: fmtC(d.totalFees) },
    { label: 'العهدة القائمة (مستحق المكتبة)', value: fmtC(d.closingBalance), bold: true, large: true },
  ];
  const body = [
    docHeader('كشف حساب جهة توصيل', undefined, d.toDate ?? undefined, extraHeader),
    docMeta([
      { title: 'معلومات الجهة', fields: partyFields },
      { title: 'ملخّص الحساب', fields: summFields },
    ]),
    docTable(cols, rows),
    docSummary(summaryItems),
    docFooter(),
  ].join('');
  openPrintWindow(wrapA4Doc(`كشف حساب — ${d.partyName}`, body));
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
  // hifi-redesign (٥/٧/٢٦): يحوَّل إلى printStatementV2 (النوع = "supplier").
  // ⚠️ الرصيد المُمرَّر هنا (openingBalance/balance/closingBalance) موقَّع فعلاً بنفس اصطلاح
  // suppliers.currentBalance (موجب="علينا له")، مطابقاً لبناء ledger في SupplierStatement.tsx
  // (bal = bal.plus(credit).minus(debit)). لا نُطبِّق Math.abs هنا — printStatementV2 يحسب
  // الاتجاه (لنا/علينا) من الإشارة نفسها ويَعرض القيمة المطلقة بجانبه، فتُحفَظ دلالة رصيد
  // دائن/تسديد زائد للمورّد (سالب ⇒ «لنا») بدل ابتلاعها بقيمة مطلقة صامتة.
  const periodLabel = [d.fromDate, d.toDate].filter(Boolean).join(' — ') || '—';
  printStatementV2({
    partyKind: 'supplier',
    partyName: d.supplierName,
    partyPhone: d.supplierPhone,
    periodLabel,
    openingBalance: Number(d.openingBalance ?? 0),
    transactionsCount: d.transactions.length,
    transactions: d.transactions.map((t) => {
      // ملاحظة: للمورّد الدائن هو ما يزيد الذمة (اتجاه معاكس للعميل) — نمرّر debit كإشارة fallback
      // متّسقة (نفس القيمة المطلقة المستعملة في fallback الدالة، فقط نعكس أيّهما "الزيادة").
      const { label, color } = inferStatementTypeLabel(t.description, t.credit);
      return {
        date: t.date,
        ref: t.ref,
        description: t.description,
        debit: t.debit ?? null,
        credit: t.credit ?? null,
        balance: Number(t.balance),
        typeLabel: label,
        typeColor: color,
        details: t.description,
      };
    }),
    totalDebit: d.totalDebit,
    totalCredit: d.totalCredit,
    closingBalance: Number(d.closingBalance),
    settings: COMPANY_SETTINGS,
  });
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
    { key: 'balance', label: 'الرصيد الحالي', width: '20mm', align: 'left' as const },
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
// ٩. ملصقات الباركود — ملصق حراري بمقاس الورق (HPRT LPQ58، عرض ≤58مم)
// ═══════════════════════════════════════════════════════════════════════════════

/** توافق خلفي: نوع عنصر الملصق هو نفسه LabelRenderItem. */
export type BarcodeLabelItem = LabelRenderItem;

/**
 * طباعة ملصقات الباركود عبر نافذة المتصفّح **بمقاس الملصق الفعلي** — ملصق واحد لكل صفحة
 * `@page` بمقاس الوسائط، فتطبع عبر تعريف Windows لطابعة الملصقات (HPRT LPQ58). تصميمٌ متّجه
 * مباشر (HTML+SVG، بلا تحويلٍ إلى صورة): اسم ديناميكيّ حسب طوله + قضبان Code128 تملأ المتاح +
 * أرقام الباركود + (الرمز/السعر) — بخطوط ثقيلة وبلا خطوط رفيعة. التصميم في `labelDesign.ts`
 * (مصدر واحد مشترك مع المعاينة الحيّة). تطبع تلقائياً عند التحميل ثم تُغلق.
 */
export function printBarcodeSheet(
  items: LabelRenderItem[],
  size: LabelSize = getLabelSize(),
  opts: LabelRenderOpts = {},
): boolean {
  const html = labelDocHtml(items, size, opts, true);
  return openPrintWindow(
    html,
    `width=${Math.max(320, Math.round(size.widthMm * 5))},height=${Math.max(360, Math.round(size.heightMm * 7))}`,
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ١١. أمر تشغيل / مستند إنتاج — A4 (وحدة الإنتاج/تحويل المخزون)
// ═══════════════════════════════════════════════════════════════════════════════

export interface ProductionDocData {
  docNumber?: string | null;
  date?: string | null;
  branchName?: string | null;
  workOrder?: string | null;
  recipeName?: string | null;
  outputName: string;
  outputUnit?: string | null;
  /** العدد المخطّط تشغيله (الدفعة). */
  planned: number;
  good?: number | null;
  scrap?: number | null;
  /** الهدر المعياري ككسر (0.05). */
  wasteStdPct: number;
  normalAllow: number;
  abnormalUnits?: number | null;
  /** الإنتاجية المحقّقة ككسر. */
  yieldPct?: number | null;
  inputs: { name: string; sku?: string | null; perUnit: number | string; consumed: number | string; short?: boolean }[];
  materialsCost: string | number;
  laborCost: string | number;
  totalCost: string | number;
  abnormalLoss?: string | number | null;
  unitCost: string | number;
  /** كلفة المنتج بعد WAVG (مستند الإنتاج بعد الترحيل). */
  newCost?: string | number | null;
}

const pctStr = (frac: number) => `${Math.round(Number(frac) * 100 * 10) / 10}`.replace(/\.0$/, '') + '%';

/** أمر تشغيل (قبل الترحيل: مخطّط + فراغات) أو مستند إنتاج (بعده: أرقام فعلية + WAVG + الهدر). */
export function printProductionDoc(d: ProductionDocData, mode: 'order' | 'document'): void {
  const isOrder = mode === 'order';
  const title = isOrder ? 'أمر تشغيل' : 'مستند إنتاج';
  const blank = '__________';
  const date = d.date ?? new Date().toLocaleDateString('en-GB');

  const h2 = (t: string) => `<div style="font-size:11px;font-weight:800;color:${B.green};margin:5mm 0 2.5mm;padding-bottom:1.5mm;border-bottom:1px solid ${B.borderLight};">${esc(t)}</div>`;

  const prodFields = [
    { label: 'المنتج', value: d.outputName },
    ...(d.recipeName ? [{ label: 'الوصفة', value: d.recipeName }] : []),
    { label: isOrder ? 'العدد المطلوب' : 'الناتج السليم', value: `${fmt(isOrder ? d.planned : (d.good ?? d.planned))} ${d.outputUnit ?? ''}` },
  ];
  const docFields = [
    { label: 'نوع المستند', value: title },
    { label: 'الفرع', value: d.branchName ?? '—' },
    { label: 'التاريخ', value: date },
    ...(d.workOrder ? [{ label: 'طلب خدمة', value: d.workOrder }] : []),
  ];

  const cols = [
    { key: 'name', label: 'المنتج' },
    { key: 'sku', label: 'الرمز', width: '24mm' },
    { key: 'per', label: 'لكل وحدة', width: '20mm', align: 'center' as const },
    { key: 'total', label: 'الإجمالي المطلوب', width: '26mm', align: 'left' as const, bold: true },
    { key: 'avail', label: 'التوفّر', width: '18mm', align: 'center' as const },
  ];
  const rows = d.inputs.map(i => ({
    name: i.name,
    sku: i.sku ?? '',
    per: fmt(i.perUnit),
    total: fmt(i.consumed),
    avail: i.short ? '✗ ناقص' : '✓ متوفّر',
  }));
  const materialsTotalRow = `<div style="display:flex;justify-content:space-between;background:${B.bg};
    border:1px solid ${B.border};border-top:none;border-radius:0 0 4px 4px;padding:2.5mm 3mm;
    font-size:10px;font-weight:700;margin-top:-1mm;margin-bottom:4mm;">
    <span>إجمالي كلفة المواد</span><span dir="ltr">${fmtC(d.materialsCost)}</span></div>`;

  const kv = (pairs: { l: string; v: string; bad?: boolean }[]) => `<table style="width:100%;border-collapse:collapse;font-size:10px;">
    ${pairs.map(p => `<tr>
      <td style="padding:1.8mm 1mm;border-bottom:1px dotted ${B.borderLight};color:${p.bad ? B.orangeDark : B.textMuted};">${esc(p.l)}</td>
      <td style="padding:1.8mm 1mm;border-bottom:1px dotted ${B.borderLight};text-align:left;font-weight:700;${p.bad ? `color:${B.orangeDark};` : ''}" dir="ltr">${esc(p.v)}</td>
    </tr>`).join('')}
  </table>`;

  const yieldKv = kv([
    { l: 'العدد المخطّط', v: `${fmt(d.planned)} ${d.outputUnit ?? ''}` },
    { l: 'السليم الفعلي', v: isOrder ? blank : fmt(d.good ?? 0) },
    { l: 'التالف (هدر)', v: isOrder ? blank : fmt(d.scrap ?? 0) },
    { l: 'الهدر المعياري المسموح', v: `${pctStr(d.wasteStdPct)} (${fmt(d.normalAllow)} وحدة)` },
    ...(!isOrder && d.yieldPct != null ? [{ l: 'الإنتاجية المحقّقة', v: pctStr(d.yieldPct) }] : []),
    ...(!isOrder && Number(d.abnormalUnits ?? 0) > 0 ? [{ l: 'هدر غير طبيعي', v: `${fmt(d.abnormalUnits ?? 0)} وحدة`, bad: true }] : []),
  ]);
  const costKv = kv([
    { l: 'كلفة المواد', v: fmtC(d.materialsCost) },
    { l: 'العمالة', v: fmtC(d.laborCost) },
    { l: 'الكلفة الكلية للتشغيل', v: fmtC(d.totalCost) },
    ...(!isOrder && Number(d.abnormalLoss ?? 0) > 0 ? [{ l: 'خسارة هدر غير طبيعي', v: `− ${fmtC(d.abnormalLoss ?? 0)}`, bad: true }] : []),
    { l: isOrder ? 'كلفة الوحدة التقديرية' : 'كلفة الوحدة السليمة', v: fmtC(d.unitCost) },
    ...(!isOrder && d.newCost != null ? [{ l: 'كلفة المنتج بعد WAVG', v: fmtC(d.newCost) }] : []),
  ]);

  const cols2 = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:7mm;margin-bottom:4mm;">
    <div>${h2('الإنتاجية')}${yieldKv}</div>
    <div>${h2('ملخّص الكلفة')}${costKv}</div>
  </div>`;

  const notesBox = `${h2('ملاحظات التشغيل')}<div style="height:18mm;border:1px solid ${B.border};border-radius:4px;margin-bottom:4mm;"></div>`;

  const signatures = `<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10mm;margin-top:8mm;">
    ${['المشغّل / المنفّذ', 'المشرف', 'التاريخ والتوقيع'].map(s => `<div style="text-align:center;">
      <div style="border-top:1px solid ${B.borderDk};height:10mm;margin-bottom:2mm;"></div>
      <span style="font-size:9px;color:${B.textMuted};">${esc(s)}</span></div>`).join('')}
  </div>`;

  const note = `<div style="margin-top:6mm;font-size:8.5px;color:${B.textFaint};text-align:center;border-top:1px solid ${B.borderLight};padding-top:2.5mm;">
    مستند تحويل أصل↔أصل — لا قيد ربح/خسارة على الإنتاج نفسه؛ الهدر غير الطبيعي فقط يُسجَّل خسارة. الورق مصدر حقيقة واحد بوحدة «ورقة» ⇒ لا مخزون سالب.
  </div>`;

  const body = [
    docHeader(title, d.docNumber ?? undefined, date),
    docMeta([
      { title: 'المنتج المطلوب إنتاجه', fields: prodFields },
      { title: 'بيانات المستند', fields: docFields },
    ]),
    h2('المتطلبات — المواد المُستهلَكة'),
    docTable(cols, rows, false),
    materialsTotalRow,
    cols2,
    notesBox,
    signatures,
    note,
    docFooter(),
  ].join('');

  openPrintWindow(wrapA4Doc(`${title} ${d.docNumber ?? ''}`.trim(), body));
}

// ═══════════════════════════════════════════════════════════════════════════════
// ١٠. إيصال نقطة البيع (بديل المتصفح — 80mm)
// ═══════════════════════════════════════════════════════════════════════════════

export interface ReceiptBrowserData {
  receiptNumber: string;
  date: string;
  time?: string | null;
  cashierName?: string | null;
  customerName?: string | null;
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
  /** مبلغ الآجل/الذمة في البيع الآجل (يظهر صفّاً بارزاً بعد المدفوع) */
  credit?: string | number | null;
  /** طريقة الدفع كنصّ جاهز للعرض (نقدي/بطاقة/تحويل/محفظة/صك) — تظهر في كتلة الإجماليات */
  paymentMethod?: string | null;
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

  const contactRows = RECEIPT_PHONES.map(p => `<tr style="border-bottom:1px dashed #ccc;">
    <td style="padding:1mm 0;font-weight:600;">${esc(p.l)}</td>
    <td style="padding:1mm 0;text-align:left;direction:ltr;font-weight:700;letter-spacing:0.3px;">${esc(p.n)}</td>
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
  ${d.customerName ? `<div style="font-size:10px;margin-bottom:1mm;">العميل: <strong>${esc(d.customerName)}</strong></div>` : ''}
  <div style="border-bottom:1px dashed #999;margin:2mm 0;"></div>
  <table style="width:100%;font-size:10px;border-collapse:collapse;">
    <thead><tr style="border-bottom:1px solid #000;">
      <th style="text-align:right;padding:1mm 0;font-weight:700;">المنتج</th>
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
    ${d.paymentMethod ? `<div style="display:flex;justify-content:space-between;font-weight:800;"><span>طريقة الدفع:</span><span>${esc(d.paymentMethod)}</span></div>` : ''}
    ${d.paid != null ? `<div style="display:flex;justify-content:space-between;"><span>المدفوع:</span><span>${fmt(d.paid)}</span></div>` : ''}
    ${d.change != null ? `<div style="display:flex;justify-content:space-between;"><span>الباقي:</span><span>${fmt(d.change)}</span></div>` : ''}
    ${Number(d.credit ?? 0) > 0 ? `<div style="display:flex;justify-content:space-between;font-weight:800;"><span>آجل/ذمة:</span><span>${fmt(d.credit)}</span></div>` : ''}
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

// ═══════════════════════════════════════════════════════════════════════════════
// ١١. إيصال طلب الخدمة الحراري — 80مم (بديل المتصفّح)
// ═══════════════════════════════════════════════════════════════════════════════

import type { WorkOrderReceiptData } from './workOrderRaster';

const WO_STATUS_HTML: Record<string, string> = {
  RECEIVED: 'مُستلَم', IN_PROGRESS: 'قيد التنفيذ', READY: 'جاهز للتسليم',
  DELIVERED: 'مُسلَّم', CANCELLED: 'ملغى',
};

export function printBrowserWorkOrderReceipt(d: WorkOrderReceiptData): void {
  const logo = logoUrl();

  let barSvg = '';
  try {
    const bc = code128Svg(d.orderNumber, { moduleWidth: 0.8, height: 35, showText: true });
    barSvg = bc.svg;
  } catch { /* بلا باركود */ }

  const statusLabel = WO_STATUS_HTML[d.status ?? ''] ?? (d.status ?? '');

  const infoRows = [
    ['رقم الأمر', esc(d.orderNumber)],
    d.orderDate  ? ['تاريخ الاستلام', esc(d.orderDate)]  : null,
    d.dueDate    ? ['موعد التسليم', esc(d.dueDate)]       : null,
    d.customerName  ? ['العميل', esc(d.customerName)]     : null,
    d.customerPhone ? ['الهاتف', esc(d.customerPhone)]    : null,
    d.status        ? ['الحالة', statusLabel]              : null,
  ].filter(Boolean) as [string, string][];

  const infoHtml = infoRows.map(([l, v]) =>
    `<div style="display:flex;justify-content:space-between;font-size:10px;padding:0.7mm 0;border-bottom:1px dashed #ddd;">
       <span style="font-weight:700;">${l}:</span>
       <span style="text-align:left;">${v}</span>
     </div>`
  ).join('');

  const specsHtml = d.specs
    ? `<div style="font-size:9.5px;color:#333;margin:1.5mm 0;padding:1.5mm;background:#f5f5f5;border-radius:2px;white-space:pre-wrap;word-break:break-all;">${esc(d.specs)}</div>`
    : '';

  const notesHtml = d.notes
    ? `<div style="margin:2mm 0;">
         <div style="font-size:9.5px;font-weight:700;margin-bottom:1mm;">ملاحظات:</div>
         <div style="font-size:9.5px;white-space:pre-wrap;word-break:break-all;">${esc(d.notes)}</div>
       </div>`
    : '';

  const contactRows = RECEIPT_PHONES.slice(0, 2).map(p =>
    `<tr><td style="text-align:right;padding:0.8mm 0;">${esc(p.l)}</td>
         <td style="text-align:left;padding:0.8mm 0;font-weight:700;" dir="ltr">${esc(p.n)}</td></tr>`
  ).join('');

  const body = `
  <div style="text-align:center;margin-bottom:3mm;">
    ${logo ? `<img src="${logo}" style="height:40px;margin-bottom:1.5mm;" onerror="this.style.display='none'">` : ''}
    <div style="font-size:14px;font-weight:900;">مكتبة العربية</div>
    <div style="font-size:11px;font-weight:800;">للطباعة والقرطاسية</div>
  </div>

  ${barSvg ? `<div style="text-align:center;margin:2mm 0;">${barSvg}</div>` : ''}

  <div style="border-top:2px solid #000;border-bottom:2px solid #000;padding:2mm 0;text-align:center;margin:2mm 0;">
    <span style="font-size:13px;font-weight:900;">طلب خدمة / المطبعة</span>
  </div>

  <div style="margin:2mm 0;">${infoHtml}</div>

  <div style="border-bottom:1px dashed #999;margin:2mm 0;"></div>

  ${d.jobTitle ? `
  <div style="font-size:10px;font-weight:700;margin-bottom:0.5mm;">نوع العمل:</div>
  <div style="font-size:10px;margin-bottom:1mm;">${esc(d.jobTitle)}</div>` : ''}

  ${d.quantity != null && String(d.quantity).trim() ? `
  <div style="display:flex;justify-content:space-between;font-size:10px;padding:0.5mm 0;">
    <span style="font-weight:700;">الكمية:</span><span>${esc(String(d.quantity))}</span>
  </div>` : ''}

  ${specsHtml}

  <div style="border-bottom:1px dashed #999;margin:2mm 0;"></div>

  <div style="display:flex;justify-content:space-between;align-items:center;padding:2mm 0;border-top:1.5px solid #000;border-bottom:1.5px solid #000;margin:1mm 0;">
    <span style="font-size:12px;font-weight:900;">الإجمالي:</span>
    <span style="font-size:13px;font-weight:900;">${fmtC(d.total)}</span>
  </div>

  ${notesHtml}

  <div style="border-bottom:1px dashed #999;margin:2mm 0;"></div>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:6mm;margin:3mm 0 2mm;">
    <div style="text-align:center;border-top:1px solid #000;padding-top:1mm;font-size:8.5px;color:#555;">توقيع المسؤول</div>
    <div style="text-align:center;border-top:1px solid #000;padding-top:1mm;font-size:8.5px;color:#555;">توقيع العميل</div>
  </div>

  <div style="border-bottom:1px dashed #999;margin:2mm 0;"></div>
  <div style="text-align:center;font-size:10px;font-weight:700;margin:1.5mm 0;">شكراً لتعاملكم مع مكتبة العربية</div>
  <table style="width:100%;font-size:9px;border-collapse:collapse;margin:1mm 0;">
    <tbody>${contactRows}</tbody>
  </table>
  <div style="text-align:center;font-size:8.5px;color:#555;margin-top:1.5mm;">بغداد — العامرية / شارع العمل الشعبي</div>`;

  openPrintWindow(wrapReceiptDoc(`طلب خدمة ${d.orderNumber}`, body), 'width=380,height=750');
}

// ═══════════════════════════════════════════════════════════════════════════════
// إيصالات الوردية الحرارية — فتح / إغلاق (Z-Report)
// ═══════════════════════════════════════════════════════════════════════════════

// دالة مساعدة: حساب مدة الوردية
function calcDuration(openedAt: Date | string | null, closedAt: Date): string {
  if (!openedAt) return '—';
  const ms = closedAt.getTime() - new Date(openedAt).getTime();
  if (ms < 0) return '—';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h === 0) return `${m} دقيقة`;
  return m > 0 ? `${h} ساعة ${m} دقيقة` : `${h} ساعة`;
}

// ترجمة طرق الدفع
const METHOD_AR: Record<string, string> = {
  CASH: 'نقدي', CARD: 'بطاقة', CHECK: 'صك', TRANSFER: 'تحويل', WALLET: 'محفظة',
};

// ═══════════════════════════════════════════════════════════════════════════════
// ١١. إيصال فتح الوردية — حراري 80مم
// ═══════════════════════════════════════════════════════════════════════════════

export interface ShiftOpenData {
  shiftId: number;
  openingBalance: number;
  /** اسم الكاشير — من me.data?.name في POS.tsx */
  cashierName: string;
  /** اسم الفرع — من branches.data?.find(b => b.id === branchId)?.name */
  branchName: string;
  /** وقت فتح الوردية — new Date() مباشرةً بعد onSuccess */
  openedAt: Date;
}

export function printShiftOpenBrowser(d: ShiftOpenData): void {
  const logo    = logoUrl();
  const date    = d.openedAt.toLocaleDateString('en-GB');
  const time    = d.openedAt.toLocaleTimeString('ar-IQ', { hour: '2-digit', minute: '2-digit' });
  const printed = d.openedAt.toLocaleString('ar-IQ-u-nu-latn', { dateStyle: 'short', timeStyle: 'short' });

  const metaRows = [
    ['رقم الوردية', `#${d.shiftId}`],
    ['التاريخ',     date],
    ['وقت الفتح',   time],
    ['الكاشير',     esc(d.cashierName)],
    ['الفرع',       esc(d.branchName)],
    ['طُبعت في',    esc(printed)],
  ].map(([l, v]) =>
    `<div style="display:flex;justify-content:space-between;padding:4.5px 0;border-bottom:1px dashed #999;font-size:13px;">
      <span style="font-weight:600;color:#333;">${l}</span>
      <span style="font-weight:800;">${v}</span>
    </div>`,
  ).join('');

  const phones = RECEIPT_PHONES.slice(0, 2)
    .map(p => `<div>${esc(p.l)}: <strong>${esc(p.n)}</strong></div>`)
    .join('');

  const body = `
  <!-- رأس الشركة -->
  <div style="text-align:center;padding:14px 0 10px;">
    <img src="${logo}" style="width:52px;height:52px;object-fit:contain;margin-bottom:6px;"
         alt="" onerror="this.style.display='none'">
    <div style="font-size:19px;font-weight:900;">مكتبة العربية</div>
    <div style="font-size:14px;font-weight:800;margin-top:1px;">للطباعة والقرطاسية</div>
    <div style="font-size:10.5px;font-weight:600;margin-top:3px;line-height:1.45;">
      ${esc(CO.name)}<br>${esc(CO.address)}
    </div>
  </div>

  <div style="height:2.5px;background:#000;margin-bottom:8px;"></div>

  <!-- شارة العنوان — معكوسة -->
  <div style="background:#000;color:#fff;text-align:center;padding:8px 0;margin-bottom:10px;border-radius:2px;">
    <div style="font-size:16px;font-weight:900;letter-spacing:.5px;">فتح الوردية</div>
    <div style="font-size:11px;font-weight:600;opacity:.85;">بيان الرصيد الافتتاحي</div>
  </div>

  <!-- بيانات الوردية -->
  ${metaRows}

  <div style="border-top:1.5px dashed #000;margin:10px 0;"></div>

  <!-- الرصيد الافتتاحي — معكوس كبير -->
  <div style="background:#000;color:#fff;text-align:center;padding:12px 8px;margin:8px 0;border-radius:2px;">
    <div style="font-size:11.5px;font-weight:700;opacity:.9;margin-bottom:4px;">الرصيد الافتتاحي للصندوق</div>
    <div style="font-size:36px;font-weight:900;direction:ltr;line-height:1;letter-spacing:-1px;">${fmt(d.openingBalance)}</div>
    <div style="font-size:14px;font-weight:800;margin-top:4px;">دينار عراقي</div>
  </div>

  <!-- صندوق تحقق الكاشير -->
  <div style="border:1.5px solid #000;border-radius:2px;padding:8px 10px;margin-bottom:10px;">
    <div style="text-align:center;font-size:11.5px;font-weight:800;margin-bottom:6px;">تحقق الكاشير من الرصيد المستلم</div>
    <div style="display:flex;justify-content:space-between;font-size:13px;">
      <span style="font-weight:600;">مستلم نقداً:</span>
      <span style="font-weight:900;direction:ltr;border-bottom:1px solid #000;
            min-width:90px;text-align:left;display:inline-block;">
        ${fmt(d.openingBalance)} د.ع
      </span>
    </div>
  </div>

  <div style="border-top:1.5px dashed #000;margin:10px 0;"></div>

  <!-- توقيعات -->
  <div style="text-align:center;font-size:11.5px;font-weight:800;margin-bottom:8px;">التوقيعات</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:8px 0 4px;">
    <div style="text-align:center;">
      <div style="height:26px;border-bottom:1.5px solid #000;margin-bottom:3px;"></div>
      <div style="font-size:10.5px;font-weight:700;">توقيع الكاشير</div>
    </div>
    <div style="text-align:center;">
      <div style="height:26px;border-bottom:1.5px solid #000;margin-bottom:3px;"></div>
      <div style="font-size:10.5px;font-weight:700;">توقيع المشرف</div>
    </div>
  </div>

  <div style="height:2px;background:#000;margin:10px 0;"></div>

  <!-- فوتر -->
  <div style="text-align:center;font-size:11.5px;font-weight:600;line-height:1.7;padding-bottom:4px;">
    <div style="font-weight:900;font-size:13px;">${esc(CO.footer)}</div>
    ${phones}
  </div>`;

  openPrintWindow(wrapReceiptDoc(`فتح الوردية #${d.shiftId}`, body), 'width=380,height=720');
}

// ═══════════════════════════════════════════════════════════════════════════════
// ١٢. إيصال إغلاق الوردية / Z-Report — حراري 80مم
// ═══════════════════════════════════════════════════════════════════════════════

export interface ShiftCloseData {
  shiftId: number;
  /** وقت فتح الوردية — من shift?.openedAt */
  openedAt: Date | string | null;
  /** وقت الإغلاق — new Date() مباشرةً بعد onSuccess */
  closedAt: Date;
  cashierName: string;
  branchName: string;
  /** من r.openingBalance (نتيجة shifts.close) */
  openingBalance: string | number;
  /** من rep?.invoiceCount (نتيجة shifts.report) */
  invoiceCount: number;
  /** من rep?.salesTotal */
  salesTotal: string | number;
  /** اختياري — إجمالي الخصومات (إن أُضيف لـ shifts.report مستقبلاً) */
  discountsTotal?: string | number | null;
  /** اختياري — إجمالي المرتجعات */
  returnsTotal?: string | number | null;
  /** من rep?.payments */
  payments: {
    method: string;
    direction: 'IN' | 'OUT';
    count: number;
    total: string | number;
  }[];
  /** من r.expectedCash */
  expectedCash: string | number;
  /** من r.countedCash */
  countedCash: string | number;
  /** من r.variance */
  variance: string | number;
}

export function printShiftCloseBrowser(d: ShiftCloseData): void {
  const logo     = logoUrl();
  const openedStr  = d.openedAt
    ? new Date(d.openedAt).toLocaleString('ar-IQ-u-nu-latn', { dateStyle: 'short', timeStyle: 'short' })
    : '—';
  const closedStr  = d.closedAt.toLocaleString('ar-IQ-u-nu-latn', { dateStyle: 'short', timeStyle: 'short' });
  const duration   = calcDuration(d.openedAt, d.closedAt);

  // صفوف بيانات الوردية
  const metaRows = [
    ['رقم الوردية', `#${d.shiftId}`],
    ['فُتحت',        esc(openedStr)],
    ['أُغلقت',       esc(closedStr)],
    ['مدة الوردية',  esc(duration)],
    ['الكاشير',      esc(d.cashierName)],
    ['الفرع',        esc(d.branchName)],
  ].map(([l, v]) =>
    `<div style="display:flex;justify-content:space-between;padding:4.5px 0;border-bottom:1px dashed #999;font-size:13px;">
      <span style="font-weight:600;color:#333;">${l}</span>
      <span style="font-weight:800;">${v}</span>
    </div>`,
  ).join('');

  // جدول طرق الدفع
  const payRows = d.payments
    .filter(p => Number(p.total) !== 0)
    .map(p => {
      const label  = `${METHOD_AR[p.method] ?? p.method} ${p.direction === 'IN' ? 'وارد' : 'صادر'}`;
      const amtStr = p.direction === 'OUT' ? `( ${fmt(p.total)} )` : fmt(p.total);
      return `<div style="display:grid;grid-template-columns:1fr 42px 82px;font-size:12px;
               padding:4.5px 0;border-bottom:1px dashed #999;align-items:center;">
        <span style="font-weight:700;">${esc(label)}</span>
        <span style="text-align:center;font-weight:600;">${p.count}</span>
        <span style="text-align:left;direction:ltr;font-weight:800;">${amtStr}</span>
      </div>`;
    }).join('');

  // حساب صافي المبيعات
  const discounts = Number(d.discountsTotal ?? 0);
  const returns   = Number(d.returnsTotal   ?? 0);
  const netSales  = Number(d.salesTotal) - discounts - returns;

  // الفرق: label + قيمة
  const varNum   = Number(d.variance);
  const varLabel = varNum === 0 ? 'مطابق تماماً ✓' : varNum > 0 ? 'الفرق — زيادة' : 'الفرق — عجز';
  const varVal   = varNum === 0 ? 'صفر' : `${varNum > 0 ? '+' : '−'} ${fmt(Math.abs(varNum))} د.ع`;

  const phones = RECEIPT_PHONES.slice(0, 2)
    .map(p => `<div>${esc(p.l)}: <strong>${esc(p.n)}</strong></div>`)
    .join('');

  const sectionHdr = (title: string) =>
    `<div style="background:#000;color:#fff;text-align:center;padding:5px 0;
      font-size:12px;font-weight:900;letter-spacing:.5px;margin:8px 0 4px;border-radius:2px;">
      ${esc(title)}
    </div>`;

  const body = `
  <!-- رأس الشركة -->
  <div style="text-align:center;padding:14px 0 10px;">
    <img src="${logo}" style="width:52px;height:52px;object-fit:contain;margin-bottom:6px;"
         alt="" onerror="this.style.display='none'">
    <div style="font-size:19px;font-weight:900;">مكتبة العربية</div>
    <div style="font-size:14px;font-weight:800;margin-top:1px;">للطباعة والقرطاسية</div>
    <div style="font-size:10.5px;font-weight:600;margin-top:3px;line-height:1.45;">
      ${esc(CO.name)}<br>${esc(CO.address)}
    </div>
  </div>

  <div style="height:2.5px;background:#000;margin-bottom:8px;"></div>

  <!-- شارة العنوان -->
  <div style="background:#000;color:#fff;text-align:center;padding:8px 0;margin-bottom:10px;border-radius:2px;">
    <div style="font-size:16px;font-weight:900;letter-spacing:.5px;">إغلاق الوردية</div>
    <div style="font-size:11px;font-weight:600;opacity:.85;">تقرير نهاية اليوم — Z Report</div>
  </div>

  <!-- بيانات الوردية -->
  ${metaRows}
  <div style="border-top:1.5px dashed #000;margin:8px 0;"></div>

  <!-- ملخص المبيعات -->
  ${sectionHdr('ملخّص المبيعات')}

  <div style="display:flex;justify-content:space-between;padding:4.5px 0;border-bottom:1px dashed #999;font-size:13px;">
    <span style="font-weight:600;color:#333;">عدد الفواتير</span>
    <span style="font-size:16px;font-weight:900;">${d.invoiceCount} فاتورة</span>
  </div>
  <div style="display:flex;justify-content:space-between;padding:4.5px 0;border-bottom:1px dashed #999;font-size:13px;">
    <span style="font-weight:600;color:#333;">إجمالي المبيعات</span>
    <span style="font-size:16px;font-weight:900;direction:ltr;">${fmt(d.salesTotal)} د.ع</span>
  </div>
  ${discounts > 0 ? `<div style="display:flex;justify-content:space-between;padding:4.5px 0;border-bottom:1px dashed #999;font-size:13px;">
    <span style="font-weight:600;color:#333;">إجمالي الخصومات</span>
    <span style="font-weight:800;direction:ltr;">${fmt(discounts)} د.ع</span>
  </div>` : ''}
  ${returns > 0 ? `<div style="display:flex;justify-content:space-between;padding:4.5px 0;border-bottom:1px dashed #999;font-size:13px;">
    <span style="font-weight:600;color:#333;">المرتجعات</span>
    <span style="font-weight:800;direction:ltr;">${fmt(returns)} د.ع</span>
  </div>` : ''}

  <!-- صافي المبيعات — معكوس -->
  <div style="background:#000;color:#fff;display:flex;justify-content:space-between;
    align-items:center;padding:7px 6px;margin:4px 0;border-radius:2px;">
    <span style="font-size:14px;font-weight:900;">صافي المبيعات</span>
    <span style="font-size:16px;font-weight:900;direction:ltr;">${fmt(netSales)} د.ع</span>
  </div>

  <!-- تفصيل طرق الدفع -->
  ${sectionHdr('تفصيل طرق الدفع')}

  <div style="display:grid;grid-template-columns:1fr 42px 82px;font-size:11px;font-weight:800;
    padding:3px 0;border-bottom:2px solid #000;">
    <span style="text-align:right;">الطريقة</span>
    <span style="text-align:center;">عدد</span>
    <span style="text-align:left;">المبلغ</span>
  </div>
  ${payRows || '<div style="font-size:12px;padding:6px 0;text-align:center;">لا حركات</div>'}

  <!-- تسوية الصندوق -->
  ${sectionHdr('تسوية الصندوق النقدي')}

  <div style="display:flex;justify-content:space-between;padding:4.5px 0;border-bottom:1px dashed #999;font-size:13px;">
    <span style="font-weight:600;color:#333;">الرصيد الافتتاحي</span>
    <span style="font-weight:800;direction:ltr;">${fmt(d.openingBalance)} د.ع</span>
  </div>

  <!-- النقد المتوقع — صندوق بارز -->
  <div style="display:flex;justify-content:space-between;align-items:center;
    padding:6px;border:2px solid #000;border-radius:2px;margin:4px 0;">
    <span style="font-size:13px;font-weight:900;">النقد المتوقع</span>
    <span style="font-size:16px;font-weight:900;direction:ltr;">${fmt(d.expectedCash)} د.ع</span>
  </div>

  <!-- النقد المعدود — صندوق بارز -->
  <div style="display:flex;justify-content:space-between;align-items:center;
    padding:6px;border:2.5px solid #000;border-radius:2px;margin:4px 0;">
    <span style="font-size:13px;font-weight:900;">النقد المعدود</span>
    <span style="font-size:16px;font-weight:900;direction:ltr;">${fmt(d.countedCash)} د.ع</span>
  </div>

  <!-- الفرق — معكوس -->
  <div style="background:#000;color:#fff;display:flex;justify-content:space-between;
    align-items:center;padding:9px 10px;margin:8px 0;border-radius:2px;">
    <div>
      <div style="font-size:14px;font-weight:900;">${esc(varLabel)}</div>
      ${varNum !== 0 ? '<div style="font-size:10.5px;font-weight:700;opacity:.8;">يتطلّب مراجعة المشرف</div>' : ''}
    </div>
    <div style="font-size:22px;font-weight:900;direction:ltr;">${esc(varVal)}</div>
  </div>

  <!-- الإجمالي الكبير — معكوس -->
  <div style="background:#000;color:#fff;text-align:center;padding:12px 8px;
    margin:10px 0;border-radius:2px;">
    <div style="font-size:11.5px;font-weight:700;opacity:.9;margin-bottom:4px;">إجمالي مبيعات الوردية</div>
    <div style="font-size:36px;font-weight:900;direction:ltr;line-height:1;letter-spacing:-1px;">
      ${fmt(d.salesTotal)}
    </div>
    <div style="font-size:14px;font-weight:800;margin-top:4px;">دينار عراقي</div>
  </div>

  <div style="border-top:1.5px dashed #000;margin:10px 0;"></div>

  <!-- توقيعات -->
  <div style="text-align:center;font-size:11.5px;font-weight:800;margin-bottom:8px;">التوقيعات والمراجعة</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:8px 0 4px;">
    <div style="text-align:center;">
      <div style="height:26px;border-bottom:1.5px solid #000;margin-bottom:3px;"></div>
      <div style="font-size:10.5px;font-weight:700;">توقيع الكاشير</div>
    </div>
    <div style="text-align:center;">
      <div style="height:26px;border-bottom:1.5px solid #000;margin-bottom:3px;"></div>
      <div style="font-size:10.5px;font-weight:700;">توقيع المشرف</div>
    </div>
  </div>

  <!-- تاريخ الطباعة -->
  <div style="border-top:1px dashed #aaa;margin:8px 0;"></div>
  <div style="text-align:center;font-size:10.5px;font-weight:600;margin-bottom:8px;direction:ltr;">
    طُبع: ${esc(closedStr)} · نسخة أصلية
  </div>

  <div style="height:2px;background:#000;margin-bottom:10px;"></div>

  <!-- فوتر -->
  <div style="text-align:center;font-size:11.5px;font-weight:600;line-height:1.7;padding-bottom:4px;">
    <div style="font-weight:900;font-size:13px;">نهاية الوردية — شكراً</div>
    ${phones}
  </div>`;

  openPrintWindow(wrapReceiptDoc(`إغلاق الوردية #${d.shiftId}`, body), 'width=380,height=920');
}
