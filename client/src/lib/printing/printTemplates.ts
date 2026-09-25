/**
 * قوالب طباعة مكتبة العربية.
 * الثمانية الرَسميّة (فاتورتان، تقرير مبيعات، عرض سعر، طلب خدمة، كشف حساب، سندَا قبض/دفع) تُنفَّذ
 * بالتصميم عالي الدقة في printTemplatesV2.ts (تسليم ٥/٧/٢٦). دوال هذا الملف بأسمائها القديمة تُحوَّل
 * صراحةً إلى نظرائها V2 (adapter بسيط) حتى لا تتأثّر شاشات النظام. القوالب المتبقّية (aging، production،
 * receipts، shift، barcode labels) خارج نطاق التسليم وتُبقى بتصميمها السابق (يستفيد كل الطباعة من ألوان
 * وخطّ التذييل الجديدة عبر brand.ts + docHtml.ts).
 */
import { workOrderStatusLabel, workOrderStatusPrintColor } from "@shared/workOrderStatus";
import { BRAND as B, CAIRO_FONT, CO, RECEIPT_PHONES, STOREFRONT_URL, esc, fmt, fmtC, openPrintWindow, logoUrl } from './brand';
import { fmtQty } from '@shared/quantityFormat';
import { fmtDate, fmtDateTime } from '../date';
import {
  wrapA4Doc, wrapReceiptDoc,
  docHeader, docMeta, docTable, docSummary, docFooter, agingSummaryBars,
} from './docHtml';
import {
  printSalesInvoiceV2, printPurchaseInvoiceV2,
  printQuotationV2, printWorkOrderV2, printStatementV2,
  printSalesReportV2,
} from './printTemplatesV2';
import { formatArabicMoneyWords } from './tafqit';

/** إعادة تصدير قوالب V2 الرَسميّة للاستخدام المباشر (فاتورة مشتريات + تقرير مبيعات جديدان بلا نظير قديم). */
export {
  printSalesInvoiceV2, printPurchaseInvoiceV2, printQuotationV2,
  printWorkOrderV2, printStatementV2, printSalesReportV2,
} from './printTemplatesV2';
export type {
  SalesInvoiceV2Data, PurchaseInvoiceV2Data, QuotationV2Data,
  WorkOrderV2Data, StatementV2Data, SalesReportV2Data, VoucherV2Data,
} from './printTemplatesV2';
import { qrCodeSvg, qrSvgSync } from './qr';
import { code128Svg } from './barcode';
import { docBarcode } from '@shared/documentNumber';
import { buildDigitalBlocks, type DigitalReceiptDetail } from './digitalReceiptLines';
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
  salespersonName?: string | null;
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
    /** هدايا الفاتورة (0149): سطرٌ مُهدىً — يُطبَع «مجاناً» بدل صفرٍ يُقرأ خطأَ تسعير. */
    isGift?: boolean | null;
  }[];
  /** إفصاح التوصيل (0152): أجرةٌ مقبوضة / توصيلٌ مُهدىً بقيمته / لا توصيل. */
  deliveryFee?: string | number | null;
  deliveryFree?: boolean | null;
  deliveryWaivedAmount?: string | number | null;
  /** ٨/٨ — توصيل الاستقبال (COURIER/COD): الأجرة على الإرسالية لا الفاتورة — عرضٌ فقط. */
  courierDelivery?: { partyName: string; fee: string | number; feeCollection: "COURIER" | "COUNTER" | "SHOP" } | null;
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
  const date = fmtDate(d.invoiceDate ?? new Date());

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
    salesRep: d.salespersonName,
    items: d.items.map((it) => ({
      productName: it.productName,
      unitName: it.unitName,
      quantity: it.quantity,
      unitPrice: it.unitPrice,
      taxAmount: it.taxAmount ?? null,
      total: it.total,
      isGift: it.isGift ?? null,
    })),
    deliveryFee: d.deliveryFee ?? null,
    deliveryFree: d.deliveryFree ?? null,
    deliveryWaivedAmount: d.deliveryWaivedAmount ?? null,
    courierDelivery: d.courierDelivery ?? null,
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
    taxAmount?: string | number | null;
    total: string | number;
  }[];
  subtotal: string | number;
  discountAmount?: string | number | null;
  taxAmount?: string | number | null;
  taxRate?: number | null;
  total: string | number;
}

export async function printQuotation(d: QuotationPrintData): Promise<void> {
  // hifi-redesign (٥/٧/٢٦): يحوَّل إلى printQuotationV2 بالتصميم المرجعي (٦ أعمدة منتج/وحدة/كمية/سعر/ضريبة/إجمالي،
  // شروط في صندوق أخضر داخلي، توقيعا العميل والممثّل التجاري). description القديم يُلحَق باسم المنتج.
  const qrPayload = [
    CO.sub,
    `عرض سعر: ${d.quoteNumber}`,
    ...(d.quoteDate ? [`التاريخ: ${d.quoteDate}`] : []),
    `الإجمالي: ${fmtC(d.total)}`,
  ].join('\n');
  const qrSvg = await qrCodeSvg(qrPayload, { size: 88, margin: 1 }).catch(() => '');
  printQuotationV2({
    qrSvg: qrSvg || null,
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
      taxAmount: it.taxAmount ?? null,
      total: it.total,
    })),
    subtotal: d.subtotal,
    discountAmount: d.discountAmount ?? null,
    taxAmount: d.taxAmount ?? null,
    taxRate: d.taxRate ?? null,
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
    qty: fmtQty(it.quantity),
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
  employeeName?: string | null;
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


export function printWorkOrder(d: WorkOrderPrintData): void {
  // hifi-redesign (٥/٧/٢٦): يحوَّل إلى printWorkOrderV2 بالتصميم المرجعي (بلا عمود ضريبة، توقيعا الفني والعميل،
  // شارة الحالة الملوّنة أعلى الترويسة). notes القديم = ملاحظات التشغيل الجديدة.
  const statusLabel = workOrderStatusLabel(d.status);
  const statusColor = workOrderStatusPrintColor(d.status);
  printWorkOrderV2({
    woNumber: d.woNumber,
    woDate: d.woDate,
    dueDate: d.dueDate,
    statusLabel: statusLabel || null,
    statusColor,
    customerName: d.customerName,
    customerPhone: d.customerPhone,
    employeeName: d.employeeName,
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
  printedByName?: string | null;
  printRequestedAt?: string | null;
  transactions: {
    date: string;
    ref: string;
    description: string;
    debit?: string | number | null;
    credit?: string | number | null;
    balance: string | number;
    actor?: string | null;
  }[];
  totalDebit: string | number;
  totalCredit: string | number;
  openingBalance?: string | number | null;
  currentBalance?: string | number | null;
  closingBalance: string | number;
}

export function printCustomerStmt(d: CustomerStmtPrintData): boolean {
  // hifi-redesign (٥/٧/٢٦): يحوَّل إلى printStatementV2 (كشف مفصّل). صف تفاصيل تحت كل حركة يشرح
  // محتوى الفاتورة/السند. النوع = "customer".
  const periodLabel = [d.fromDate, d.toDate].filter(Boolean).join(' — ') || '—';
  return printStatementV2({
    partyKind: 'customer',
    partyName: d.customerName,
    partyPhone: d.customerPhone,
    periodLabel,
    printedByName: d.printedByName,
    printRequestedAt: d.printRequestedAt,
    openingBalance: d.openingBalance ?? 0,
    currentBalance: d.currentBalance ?? null,
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
        actor: t.actor,
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
  printedByName?: string | null;
  printRequestedAt?: string | null;
  transactions: {
    date: string;
    ref: string;
    description: string;
    debit?: string | number | null;
    credit?: string | number | null;
    balance: string | number;
    actor?: string | null;
  }[];
  totalDebit: string | number;
  totalCredit: string | number;
  openingBalance?: string | number | null;
  currentBalance?: string | number | null;
  closingBalance: string | number;
}

export function printSupplierStmt(d: SupplierStmtPrintData): boolean {
  // hifi-redesign (٥/٧/٢٦): يحوَّل إلى printStatementV2 (النوع = "supplier").
  // ⚠️ الرصيد المُمرَّر هنا (openingBalance/balance/closingBalance) موقَّع فعلاً بنفس اصطلاح
  // suppliers.currentBalance (موجب="علينا له")، مطابقاً لبناء ledger في SupplierStatement.tsx
  // (bal = bal.plus(credit).minus(debit)). لا نُطبِّق Math.abs هنا — printStatementV2 يحسب
  // الاتجاه (لنا/علينا) من الإشارة نفسها ويَعرض القيمة المطلقة بجانبه، فتُحفَظ دلالة رصيد
  // دائن/تسديد زائد للمورّد (سالب ⇒ «لنا») بدل ابتلاعها بقيمة مطلقة صامتة.
  const periodLabel = [d.fromDate, d.toDate].filter(Boolean).join(' — ') || '—';
  return printStatementV2({
    partyKind: 'supplier',
    partyName: d.supplierName,
    partyPhone: d.supplierPhone,
    periodLabel,
    printedByName: d.printedByName,
    printRequestedAt: d.printRequestedAt,
    openingBalance: Number(d.openingBalance ?? 0),
    currentBalance: d.currentBalance ?? null,
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
        actor: t.actor,
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
  rows: { name: string; d0_30: number; d31_60: number; d61_90: number; d91p: number; unpaidTotal: number; unbucketed?: number; currentBalance: number; }[];
  totals: { d0_30: number; d31_60: number; d61_90: number; d91p: number; unpaidTotal: number; unbucketed?: number; currentBalance: number; };
}

export function printARAging(d: ARAgingPrintData): void {
  const cols = [
    { key: 'name', label: 'العميل' },
    { key: 'd0_30', label: '0–30 يوم', width: '17mm', align: 'left' as const },
    { key: 'd31_60', label: '31–60 يوم', width: '17mm', align: 'left' as const },
    { key: 'd61_90', label: '61–90 يوم', width: '17mm', align: 'left' as const },
    { key: 'd91p', label: 'أكثر من 90', width: '17mm', align: 'left' as const },
    { key: 'unpaid', label: 'غير المسدّد', width: '20mm', align: 'left' as const, bold: true },
    { key: 'unbucketed', label: 'غير مفوتر/افتتاحي', width: '22mm', align: 'left' as const },
    { key: 'balance', label: 'الرصيد الحالي', width: '20mm', align: 'left' as const, bold: true },
  ];
  const rows = d.rows.map(r => ({
    name: r.name,
    d0_30: r.d0_30 ? fmt(r.d0_30) : '—',
    d31_60: r.d31_60 ? fmt(r.d31_60) : '—',
    d61_90: r.d61_90 ? fmt(r.d61_90) : '—',
    d91p: r.d91p ? fmt(r.d91p) : '—',
    unpaid: fmt(r.unpaidTotal),
    unbucketed: r.unbucketed != null ? (r.unbucketed !== 0 ? fmt(r.unbucketed) : '—') : (r.currentBalance - r.unpaidTotal !== 0 ? fmt(r.currentBalance - r.unpaidTotal) : '—'),
    balance: fmt(r.currentBalance),
  }));

  const t = d.totals;
  const pcts = [
    { label: '0–30', val: t.d0_30, color: '#1A9B78' },
    { label: '31–60', val: t.d31_60, color: '#3B82F6' },
    { label: '61–90', val: t.d61_90, color: '#CC7E3F' },
    { label: '>90', val: t.d91p, color: '#DC2626' },
  ];

  const unbucketedTotal = t.unbucketed ?? (t.currentBalance - t.unpaidTotal);
  const totalsRow = `<div style="display:flex;background:${B.green};color:#fff;border-radius:0 0 4px 4px;
    padding:2.5mm 3mm;font-size:10px;font-weight:700;margin-top:-4mm;margin-bottom:4mm;">
    <span style="flex:1;">الإجمالي</span>
    <span style="width:17mm;text-align:left;">${fmt(t.d0_30)}</span>
    <span style="width:17mm;text-align:left;">${fmt(t.d31_60)}</span>
    <span style="width:17mm;text-align:left;">${fmt(t.d61_90)}</span>
    <span style="width:17mm;text-align:left;">${fmt(t.d91p)}</span>
    <span style="width:20mm;text-align:left;font-size:11px;">${fmt(t.unpaidTotal)}</span>
    <span style="width:22mm;text-align:left;">${fmt(unbucketedTotal)}</span>
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
  rows: { name: string; d0_30: number; d31_60: number; d61_90: number; d91p: number; unpaidTotal: number; unbucketed?: number; currentBalance: number; }[];
  totals: { d0_30: number; d31_60: number; d61_90: number; d91p: number; unpaidTotal: number; unbucketed?: number; currentBalance: number; };
}

export function printAPAging(d: APAgingPrintData): void {
  const cols = [
    { key: 'name', label: 'المورد' },
    { key: 'd0_30', label: '0–30 يوم', width: '17mm', align: 'left' as const },
    { key: 'd31_60', label: '31–60 يوم', width: '17mm', align: 'left' as const },
    { key: 'd61_90', label: '61–90 يوم', width: '17mm', align: 'left' as const },
    { key: 'd91p', label: 'أكثر من 90', width: '17mm', align: 'left' as const },
    { key: 'unpaid', label: 'إجمالي مستحق', width: '20mm', align: 'left' as const, bold: true },
    { key: 'unbucketed', label: 'غير مفوتر/افتتاحي', width: '22mm', align: 'left' as const },
    { key: 'balance', label: 'الرصيد', width: '20mm', align: 'left' as const, bold: true },
  ];
  const rows = d.rows.map(r => ({
    name: r.name,
    d0_30: r.d0_30 ? fmt(r.d0_30) : '—',
    d31_60: r.d31_60 ? fmt(r.d31_60) : '—',
    d61_90: r.d61_90 ? fmt(r.d61_90) : '—',
    d91p: r.d91p ? fmt(r.d91p) : '—',
    unpaid: fmt(r.unpaidTotal),
    unbucketed: r.unbucketed != null ? (r.unbucketed !== 0 ? fmt(r.unbucketed) : '—') : (r.currentBalance - r.unpaidTotal !== 0 ? fmt(r.currentBalance - r.unpaidTotal) : '—'),
    balance: fmt(r.currentBalance),
  }));

  const t = d.totals;
  const pcts = [
    { label: '0–30', val: t.d0_30, color: '#1A9B78' },
    { label: '31–60', val: t.d31_60, color: '#3B82F6' },
    { label: '61–90', val: t.d61_90, color: '#CC7E3F' },
    { label: '>90', val: t.d91p, color: '#DC2626' },
  ];

  const unbucketedTotal = t.unbucketed ?? (t.currentBalance - t.unpaidTotal);
  const totalsRow = `<div style="display:flex;background:#DC2626;color:#fff;border-radius:0 0 4px 4px;
    padding:2.5mm 3mm;font-size:10px;font-weight:700;margin-top:-4mm;margin-bottom:4mm;">
    <span style="flex:1;">الإجمالي</span>
    <span style="width:17mm;text-align:left;">${fmt(t.d0_30)}</span>
    <span style="width:17mm;text-align:left;">${fmt(t.d31_60)}</span>
    <span style="width:17mm;text-align:left;">${fmt(t.d61_90)}</span>
    <span style="width:17mm;text-align:left;">${fmt(t.d91p)}</span>
    <span style="width:20mm;text-align:left;font-size:11px;">${fmt(t.unpaidTotal)}</span>
    <span style="width:22mm;text-align:left;">${fmt(unbucketedTotal)}</span>
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
  const date = d.date ?? fmtDate(new Date());

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
  /** أثر النسخة المعدلة؛ يثبت رقم الأصل ومَن طلب/اعتمد التعديل على الحرارية. */
  revision?: {
    originalReceiptNumber: string;
    revisedAt: string;
    revisedByName: string;
    approvedByName?: string | null;
    approvedAt?: string | null;
  } | null;
  items: {
    name: string;
    quantity: number;
    price: string | number;
    total: string | number;
  }[];
  subtotal: string | number;
  /** خصم الفاتورة الكلي، إن وُجد. */
  discount?: string | number | null;
  tax?: string | number | null;
  /** تعديلُ التقريب النقديّ (± د.ع، النقد الكامل فقط) — يُطبع صريحاً كي يطابق حساب الإيصال إجماليه. */
  cashRounding?: string | number | null;
  total: string | number;
  paid?: string | number | null;
  change?: string | number | null;
  /** مبلغ الآجل/الذمة في البيع الآجل (يظهر صفّاً بارزاً بعد المدفوع) */
  credit?: string | number | null;
  /** طريقة الدفع كنصّ جاهز للعرض (نقدي/بطاقة/تحويل/محفظة/صك) — تظهر في كتلة الإجماليات */
  paymentMethod?: string | null;
  /** البطاقات الرقمية (ش١٠): تفاصيل كل كرت — بلا أيّ حقلٍ ماليّ داخليّ (§١٢.٢). */
  digitalDetails?: DigitalReceiptDetail[] | null;
  /** إخفاء وسط أرقام الهواتف في النسخة المطبوعة (افتراضياً مُفعَّل). */
  maskPhones?: boolean;
  /** ٨/٨ — كتلة التوصيل على الإيصال: تُظهر الجهة والأجرة ومَن يقبضها و«الإجمالي الذي يدفعه
   *  الزبون» بشفافية. الأجرة تمريرٌ لا إيراد ⇒ لا تدخل `total` أبداً؛ هنا **إفصاحٌ** للزبون فقط. */
  delivery?: {
    partyName: string;
    fee: string | number;
    feeCollection: "COURIER" | "COUNTER" | "SHOP";
    address?: string | null;
  } | null;
  /** G3 (١١/٨): رقم الوردية التي أُنشئت أو قُبضت عليها الفاتورة — مرجعٌ تشغيليّ في الترويسة.
   *  اختياريٌّ للتوافق الرجعي؛ يُمرَّر من كل بناة الإيصالات (POS/PrintPOS/Reception/reprint). */
  shiftId?: number | null;
  /** G3: مجموع العرابين المحتجزة على أوامر شغلٍ مرتبطة بهذه الفاتورة — إفصاحٌ منفصلٌ في كتلة
   *  الإجماليات كي يعرف الزبون أنّ لديه رصيداً محجوزاً سيُخصم عند التسليم. */
  heldDeposits?: string | number | null;
}

export function buildBrowserReceiptHtml(d: ReceiptBrowserData): string {
  const logo = logoUrl();

  let barSvg = '';
  try {
    const bc = code128Svg(d.receiptNumber, { moduleWidth: 0.8, height: 35, showText: true });
    barSvg = bc.svg;
  } catch { /* ignore */ }

  const storeQr = qrSvgSync(STOREFRONT_URL, 72);

  const metaRows = [
    ['رقم الإيصال', `#${esc(d.receiptNumber)}`],
    ['التاريخ والوقت', `${esc(d.date)}${d.time ? ` · ${esc(d.time)}` : ''}`],
    ...(d.cashierName ? [['الكاشير', esc(d.cashierName)]] : []),
    ...(d.shiftId != null ? [['الوردية', `#${d.shiftId}`]] : []),
    ...(d.customerName ? [['العميل', esc(d.customerName)]] : []),
  ].map(([l, v]) => `
    <tr>
      <td style="width:36%;font-weight:900;border:1px solid #000;padding:1mm 1.5mm;font-size:11px;">${l}</td>
      <td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;font-size:11px;">${v}</td>
    </tr>
  `).join('');

  const itemRows = d.items.map(it => `
    <tr>
      <td style="padding:1.5mm 1mm;font-weight:900;font-size:11.5px;color:#000;line-height:1.25;border:1px solid #000;">${esc(it.name)}</td>
      <td style="text-align:center;padding:1.5mm 1mm;font-weight:900;font-size:12px;color:#000;white-space:nowrap;font-variant-numeric:tabular-nums;border:1px solid #000;direction:ltr;">${fmtQty(it.quantity)}</td>
      <td style="text-align:left;padding:1.5mm 1mm;font-weight:800;font-size:11.5px;color:#000;direction:ltr;white-space:nowrap;font-variant-numeric:tabular-nums;border:1px solid #000;">${fmt(it.price)}</td>
      <td style="text-align:left;padding:1.5mm 1mm;font-weight:900;font-size:12px;color:#000;direction:ltr;white-space:nowrap;font-variant-numeric:tabular-nums;border:1px solid #000;">${fmt(it.total)}</td>
    </tr>
  `).join('');

  const contactRows = RECEIPT_PHONES.map(p => `
    <tr>
      <td style="padding:1mm 1.5mm;font-weight:900;font-size:10.5px;color:#000;border:1px solid #000;">${esc(p.l)}</td>
      <td style="padding:1mm 1.5mm;text-align:left;direction:ltr;font-weight:900;font-size:11px;letter-spacing:0.3px;color:#000;border:1px solid #000;">${esc(p.n)}</td>
    </tr>
  `).join('');

  // البطاقات الرقمية
  const digitalBlocks = buildDigitalBlocks(d.digitalDetails, { maskPhones: d.maskPhones });
  const digitalHtml = digitalBlocks.length
    ? `<table style="width:100%;font-size:10.5px;border-collapse:collapse;border:1.5px solid #000;margin:2mm 0;color:#000;">
        <thead><tr style="background:#000;color:#fff;"><th colspan="2" style="padding:1mm;font-weight:900;border:1px solid #000;text-align:right;">بيانات الشحن الرقمي</th></tr></thead>
        <tbody>` +
      digitalBlocks.map(b => `
        <tr><td colspan="2" style="font-weight:900;padding:1mm 1.5mm;background:#000;color:#fff;border:1px solid #000;">${esc(b.lineName)}</td></tr>
        ${b.rows.map(r => `<tr>
          <td style="width:38%;font-weight:800;padding:1mm 1.5mm;border:1px solid #000;">${esc(r.label)}</td>
          <td style="font-weight:900;padding:1mm 1.5mm;direction:${/هاتف|رقم|ID/.test(r.label) ? 'ltr' : 'rtl'};text-align:${/هاتف|رقم|ID/.test(r.label) ? 'left' : 'right'};border:1px solid #000;">${esc(r.value)}</td>
        </tr>`).join('')}
      `).join('') + `</tbody></table>`
    : '';

  // كتلة التوصيل
  const deliveryHtml = d.delivery ? (() => {
    const dl = d.delivery!;
    const fee = Number(dl.fee || 0);
    const shop = dl.feeCollection === "SHOP";
    const who = dl.feeCollection === "COUNTER" ? "مقبوضة في الاستقبال" : shop ? "على المكتبة — مجاناً للزبون" : "يقبضها المندوب من الزبون";
    const remainingMerchandise = Math.max(0, Number(d.total || 0) - Number(d.paid || 0));
    const courierFee = dl.feeCollection === "COURIER" ? fee : 0;
    const totalToCollect = remainingMerchandise + courierFee;

    let customerDueRow = "";
    if (totalToCollect === 0) {
      customerDueRow = `
        <tr style="background:#000;color:#fff;font-weight:900;">
          <td style="border:1px solid #000;padding:1.2mm 1.5mm;">المطلوب من الزبون</td>
          <td style="border:1px solid #000;padding:1.2mm 1.5mm;direction:ltr;text-align:left;font-variant-numeric:tabular-nums;">0 د.ع (مدفوع بالكامل)</td>
        </tr>`;
    } else if (remainingMerchandise === 0 && courierFee > 0) {
      customerDueRow = `
        <tr style="background:#000;color:#fff;font-weight:900;">
          <td style="border:1px solid #000;padding:1.2mm 1.5mm;">يدفع الزبون (أجرة التوصيل فقط)</td>
          <td style="border:1px solid #000;padding:1.2mm 1.5mm;direction:ltr;text-align:left;font-variant-numeric:tabular-nums;">${fmt(courierFee)} د.ع</td>
        </tr>
        <tr>
          <td colspan="2" style="border:1px solid #000;padding:1mm 1.5mm;text-align:center;font-weight:800;font-size:10px;background:#f5f5f5;">
            البضاعة مدفوعة مسبقاً بالكامل
          </td>
        </tr>`;
    } else if (courierFee > 0) {
      customerDueRow = `
        <tr style="background:#000;color:#fff;font-weight:900;">
          <td style="border:1px solid #000;padding:1.2mm 1.5mm;">يدفع الزبون شاملاً التوصيل</td>
          <td style="border:1px solid #000;padding:1.2mm 1.5mm;direction:ltr;text-align:left;font-variant-numeric:tabular-nums;">${fmt(totalToCollect)} د.ع</td>
        </tr>
        <tr>
          <td colspan="2" style="border:1px solid #000;padding:0.8mm 1.5mm;text-align:center;font-weight:700;font-size:9.5px;color:#333;">
            (متبقي البضاعة: ${fmt(remainingMerchandise)} + أجرة التوصيل: ${fmt(courierFee)})
          </td>
        </tr>`;
    } else {
      customerDueRow = `
        <tr style="background:#000;color:#fff;font-weight:900;">
          <td style="border:1px solid #000;padding:1.2mm 1.5mm;">يدفع الزبون (متبقي البضاعة)</td>
          <td style="border:1px solid #000;padding:1.2mm 1.5mm;direction:ltr;text-align:left;font-variant-numeric:tabular-nums;">${fmt(remainingMerchandise)} د.ع</td>
        </tr>`;
    }

    return `
    <table style="width:100%;font-size:11px;border-collapse:collapse;border:1.5px solid #000;margin:2mm 0;color:#000;">
      <thead><tr style="background:#000;color:#fff;"><th colspan="2" style="padding:1.2mm;font-weight:900;border:1px solid #000;">بيانات التوصيل</th></tr></thead>
      <tbody>
        <tr><td style="width:35%;font-weight:900;border:1px solid #000;padding:1mm 1.5mm;">الجهة</td><td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;">${esc(dl.partyName)}</td></tr>
        ${dl.address ? `<tr><td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;">العنوان</td><td style="font-weight:800;border:1px solid #000;padding:1mm 1.5mm;">${esc(dl.address)}</td></tr>` : ''}
        <tr><td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;">أجرة التوصيل</td><td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;">${shop ? "مجاناً" : fmt(fee)} (${who})</td></tr>
        ${customerDueRow}
      </tbody>
    </table>`;
  })() : '';

  const body = `
  <div style="text-align:center;margin-bottom:2mm;">
    <img src="${logo}" style="width:18mm;height:18mm;object-fit:contain;filter:grayscale(100%) contrast(1000%);" alt="" onerror="this.style.display='none'">
    <div style="font-size:18px;font-weight:900;margin-top:1mm;color:#000;">مكتبة العربية</div>
    <div style="font-size:12.5px;font-weight:900;margin-top:0.3mm;color:#000;">للطباعة والقرطاسية</div>
    <div style="font-size:9.5px;font-weight:800;color:#000;margin-top:0.3mm;">${esc(CO.name)}</div>
  </div>

  <div style="border-top:2px solid #000;border-bottom:2px solid #000;text-align:center;padding:1.2mm 0;margin:2mm 0;">
    <div style="font-size:14px;font-weight:900;letter-spacing:0.5px;">إيصال مبيعات التجزئة</div>
  </div>

  <div style="margin:2mm 0;text-align:center;">${barSvg}</div>

  <table style="width:100%;border-collapse:collapse;border:1.5px solid #000;margin:2mm 0;color:#000;">
    <tbody>${metaRows}</tbody>
  </table>

  ${d.revision ? `
  <table style="width:100%;border-collapse:collapse;border:2px solid #000;margin:2mm 0;font-size:10.5px;color:#000;">
    <thead><tr style="background:#000;color:#fff;"><th colspan="2" style="padding:1mm;font-weight:900;">فاتورة معدلة — بديلة عن: ${esc(d.revision.originalReceiptNumber)}</th></tr></thead>
    <tbody>
      <tr><td style="width:35%;font-weight:900;border:1px solid #000;padding:1mm 1.5mm;">طلب التعديل</td><td style="font-weight:800;border:1px solid #000;padding:1mm 1.5mm;">${esc(d.revision.revisedByName)} — ${esc(d.revision.revisedAt)}</td></tr>
      ${d.revision.approvedByName ? `<tr><td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;">الاعتماد</td><td style="font-weight:800;border:1px solid #000;padding:1mm 1.5mm;">${esc(d.revision.approvedByName)}${d.revision.approvedAt ? ` — ${esc(d.revision.approvedAt)}` : ''}</td></tr>` : ''}
    </tbody>
  </table>` : ''}

  <table style="width:100%;font-size:11px;border-collapse:collapse;color:#000;table-layout:fixed;border:1.5px solid #000;margin:2mm 0;">
    <thead><tr style="background:#000;color:#fff;">
      <th style="text-align:right;padding:1.5mm 1mm;font-weight:900;font-size:11.5px;border:1px solid #000;">المنتج</th>
      <th style="text-align:center;padding:1.5mm 1mm;font-weight:900;font-size:11.5px;border:1px solid #000;width:9mm;">عدد</th>
      <th style="text-align:left;padding:1.5mm 1mm;font-weight:900;font-size:11.5px;border:1px solid #000;width:16mm;">السعر</th>
      <th style="text-align:left;padding:1.5mm 1mm;font-weight:900;font-size:11.5px;border:1px solid #000;width:18mm;">المبلغ</th>
    </tr></thead>
    <tbody>${itemRows}</tbody>
  </table>

  ${digitalHtml}

  <!-- جدول الإجماليات والتفقيط -->
  <table style="width:100%;font-size:11px;border-collapse:collapse;border:1.5px solid #000;margin:2mm 0;color:#000;">
    <tbody>
      <tr><td style="width:55%;font-weight:900;border:1px solid #000;padding:1mm 1.5mm;">المجموع</td><td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;direction:ltr;text-align:left;font-variant-numeric:tabular-nums;">${fmt(d.subtotal)}</td></tr>
      ${Number(d.discount ?? 0) > 0 ? `<tr><td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;">الخصم</td><td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;direction:ltr;text-align:left;font-variant-numeric:tabular-nums;">-${fmt(d.discount)}</td></tr>` : ''}
      ${Number(d.tax ?? 0) > 0 ? `<tr><td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;">الضريبة</td><td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;direction:ltr;text-align:left;font-variant-numeric:tabular-nums;">${fmt(d.tax)}</td></tr>` : ''}
      ${d.cashRounding != null && Number(d.cashRounding) !== 0 ? `<tr><td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;">تقريب نقدي</td><td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;direction:ltr;text-align:left;font-variant-numeric:tabular-nums;">${Number(d.cashRounding) > 0 ? '+' : ''}${fmt(d.cashRounding)}</td></tr>` : ''}
      <tr style="background:#000;color:#fff;font-weight:900;">
        <td style="border:1px solid #000;padding:1.5mm;font-size:13px;">الإجمالي النهائي</td>
        <td style="border:1px solid #000;padding:1.5mm;direction:ltr;text-align:left;font-size:15px;font-variant-numeric:tabular-nums;white-space:nowrap;">${fmt(d.total)} د.ع</td>
      </tr>
      <tr>
        <td colspan="2" style="text-align:center;font-weight:900;font-size:10px;padding:1.2mm;border:1px solid #000;">
          ${formatArabicMoneyWords(d.total)}
        </td>
      </tr>
      ${d.paymentMethod ? `<tr><td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;">طريقة الدفع</td><td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;">${esc(d.paymentMethod)}</td></tr>` : ''}
      ${d.paid != null ? `<tr><td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;">المبلغ المدفوع</td><td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;direction:ltr;text-align:left;font-variant-numeric:tabular-nums;">${fmt(d.paid)}</td></tr>` : ''}
      ${d.change != null ? `<tr><td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;">المبلغ المتبقي (الفكة)</td><td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;direction:ltr;text-align:left;font-variant-numeric:tabular-nums;">${fmt(d.change)}</td></tr>` : ''}
      ${Number(d.heldDeposits ?? 0) > 0 ? `<tr><td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;">عربون محتجز</td><td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;direction:ltr;text-align:left;font-variant-numeric:tabular-nums;">${fmt(d.heldDeposits)}</td></tr>` : ''}
      ${Number(d.credit ?? 0) > 0 ? `<tr style="border:2px solid #000;"><td style="font-weight:900;border:1px solid #000;padding:1.2mm 1.5mm;">متبقٍّ (حساب آجل)</td><td style="font-weight:900;border:1px solid #000;padding:1.2mm 1.5mm;direction:ltr;text-align:left;font-variant-numeric:tabular-nums;">${fmt(d.credit)} د.ع</td></tr>` : ''}
    </tbody>
  </table>

  ${deliveryHtml}

  <div style="text-align:center;margin:2.5mm 0;padding:2mm;border:1.5px solid #000;background:#fff;color:#000;">
    <div style="font-size:12px;font-weight:900;margin-bottom:0.5mm;color:#000;">متجرنا الإلكتروني — تسوق وتوصيل مباشر</div>
    <div style="margin:1.5mm auto;display:flex;justify-content:center;">${storeQr}</div>
    <div style="font-size:10.5px;font-weight:900;direction:ltr;letter-spacing:0.3px;color:#000;">alarabiya.online/store</div>
    <div style="font-size:9pt;font-weight:800;margin-top:1mm;color:#000;">امسح الرمز للتسوق السريع</div>
  </div>

  <table style="width:100%;font-size:10px;border-collapse:collapse;margin:2mm 0;color:#000;border:1.5px solid #000;">
    <thead><tr style="background:#000;color:#fff;">
      <th style="text-align:right;padding:1mm 1.5mm;font-weight:900;border:1px solid #000;">القسم</th>
      <th style="text-align:left;padding:1mm 1.5mm;font-weight:900;border:1px solid #000;">رقم التواصل</th>
    </tr></thead>
    <tbody>${contactRows}</tbody>
  </table>

  <div style="text-align:center;font-size:10px;font-weight:900;margin:1.5mm 0;color:#000;">
    بغداد — العامرية / شارع العمل الشعبي
  </div>

  <div style="text-align:center;margin:2mm 0;padding:2mm;border:1.5px solid #000;font-size:10px;font-weight:900;line-height:1.5;color:#000;">
    نعتذر عن قبول الاسترجاع — والاستبدال متاح<br>
    خلال 48 ساعة بشرط سلامة المنتج بـ100%
  </div>`;

  return wrapReceiptDoc(`إيصال ${d.receiptNumber}`, body);
}

export function printBrowserReceipt(d: ReceiptBrowserData): boolean {
  return openPrintWindow(buildBrowserReceiptHtml(d), 'width=380,height=700');
}

// ═══════════════════════════════════════════════════════════════════════════════
// ١١. إيصال طلب الخدمة الحراري — 80مم (بديل المتصفّح)
// ═══════════════════════════════════════════════════════════════════════════════

import type { WorkOrderReceiptData } from './workOrderRaster';


export function printBrowserWorkOrderReceipt(d: WorkOrderReceiptData): void {
  const logo = logoUrl();
  const machineBarcode = docBarcode("WO", d.orderNumber);

  let barSvg = '';
  try {
    const bc = code128Svg(machineBarcode, { moduleWidth: 0.8, height: 35, showText: true });
    barSvg = bc.svg;
  } catch { /* بلا باركود */ }

  const statusLabel = workOrderStatusLabel(d.status);

  const infoRows = [
    ['رقم الأمر', esc(d.orderNumber)],
    d.orderDate  ? ['تاريخ الاستلام', esc(d.orderDate)]  : null,
    d.dueDate    ? ['موعد التسليم', esc(d.dueDate)]       : null,
    d.customerName  ? ['العميل', esc(d.customerName)]     : null,
    d.customerPhone ? ['الهاتف', esc(d.customerPhone)]    : null,
    d.employeeName  ? ['الموظف', esc(d.employeeName)]      : null,
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
    <span style="font-weight:700;">الكمية:</span><span>${esc(fmtQty(d.quantity))}</span>
  </div>` : ''}

  ${specsHtml}

  <div style="border-bottom:1px dashed #999;margin:2mm 0;"></div>

  <div style="display:flex;justify-content:space-between;align-items:center;padding:2mm 0;border-top:1.5px solid #000;border-bottom:1.5px solid #000;margin:1mm 0;">
    <span style="font-size:12px;font-weight:900;">الإجمالي:</span>
    <span style="font-size:13px;font-weight:900;">${fmtC(d.total)}</span>
  </div>

  ${d.paidUpfront != null && Number(d.paidUpfront) > 0 ? `
  <div style="display:flex;justify-content:space-between;font-size:10.5px;font-weight:700;padding:0.5mm 0;">
    <span>مدفوع مقدماً:</span><span>${fmtC(d.paidUpfront)}</span>
  </div>
  <div style="display:flex;justify-content:space-between;font-size:12px;font-weight:900;padding:1mm 0;border-bottom:1.5px solid #000;margin-bottom:1mm;">
    <span>المتبقّي عند الاستلام:</span><span>${fmtC(d.balanceDue ?? Math.max(0, Number(d.total) - Number(d.paidUpfront)))}</span>
  </div>` : ''}

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
  CASH: 'نقدي', CARD: 'بطاقة', CHECK: 'صك', TRANSFER: 'تحويل', WALLET: 'محفظة', TELECOM: 'رصيد زين',
};

/**
 * غلاف خاص بإيصالات الوردية على Epson 80mm.
 *
 * عرض الورقة الاسمي 80mm، لكن عرض الطباعة الفعلي في TM-T20III هو 72mm (576 نقطة). ترك جسم
 * المستند بعرض 80mm كان يجعل تعريف Windows يصغّره أو يعيد تدفّقه لحظة الطباعة وحدها. كذلك كان
 * wrapReceiptDoc يطبع في body.onload قبل اكتمال خط Cairo، فتُلتقط مقاييس الخط الاحتياطي ثم تتبدل
 * الوجوه العربية داخل مهمة الطباعة. هذا الغلاف يطابق عرض الرستر وينتظر الخط والصور قبل الطباعة.
 */
function wrapShiftReceiptDoc(title: string, bodyContent: string): string {
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<title>${esc(title)}</title>
${CAIRO_FONT}
<style>
  *,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
  *{-webkit-print-color-adjust:exact !important;print-color-adjust:exact !important;color-adjust:exact !important}
  @page{size:auto;margin:0}
  html{direction:rtl;background:#fff}
  body{font-family:'Cairo',sans-serif;width:72mm;max-width:72mm;background:#fff;color:#000;
    margin:0 auto;padding:2mm;font-size:11px;line-height:1.6;direction:rtl;overflow:visible}
  .shift-close-report{width:100%;direction:rtl;overflow:visible}
  .shift-close-report>*,.shift-close-report div,.shift-close-report span{min-width:0}
  .shift-close-report [style*="direction:ltr"]{unicode-bidi:isolate;white-space:nowrap}
  .shift-close-report [data-shift-row]{column-gap:8px;line-height:1.55;min-height:27px}
  .shift-close-report [data-shift-row]>:last-child{max-width:64%;overflow-wrap:anywhere}
  .shift-close-report [data-payment-row]{column-gap:4px;line-height:1.55;min-height:27px}
  @media print{
    html,body{width:72mm;max-width:72mm}
    body{margin:0 auto;padding:2mm}
  }
</style>
</head>
<body><main class="shift-close-report">${bodyContent}</main>
<script>
  (function () {
    var images = Array.from(document.images).map(function (image) {
      return image.complete
        ? Promise.resolve()
        : new Promise(function (resolve) {
            image.addEventListener('load', resolve, { once: true });
            image.addEventListener('error', resolve, { once: true });
          });
    });
    var fonts = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
    Promise.all([fonts].concat(images)).then(function () {
      window.setTimeout(function () { window.focus(); window.print(); }, 100);
    });
    window.addEventListener('afterprint', function () { window.close(); }, { once: true });
  })();
</script>
</body></html>`;
}

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
  /** اختياري — اسم القسم/نوع الوردية (مثل: «قسم الطباعة والاستنساخ») */
  departmentName?: string;
}

export function buildShiftOpenHtml(d: ShiftOpenData): string {
  const logo    = logoUrl();
  const date    = fmtDate(d.openedAt);
  const time    = fmtDateTime(d.openedAt).split('، ')[1] ?? '—';
  const printed = fmtDateTime(d.openedAt);

  const metaRows = [
    ['رقم الوردية', `#${d.shiftId}`],
    ...(d.departmentName ? [['القسم', esc(d.departmentName)]] : []),
    ['التاريخ',     date],
    ['وقت الفتح',   time],
    ['الكاشير',     esc(d.cashierName)],
    ['الفرع',       esc(d.branchName)],
    ['طُبعت في',    esc(printed)],
  ].map(([l, v]) => `
    <tr>
      <td style="width:38%;font-weight:900;border:1px solid #000;padding:1mm 1.5mm;font-size:11px;">${l}</td>
      <td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;font-size:11px;">${v}</td>
    </tr>
  `).join('');

  const phones = RECEIPT_PHONES.slice(0, 2)
    .map(p => `<div>${esc(p.l)}: <strong>${esc(p.n)}</strong></div>`)
    .join('');

  const body = `
  <!-- رأس الشركة -->
  <div style="text-align:center;padding:2mm 0;">
    <img src="${logo}" style="width:40px;height:40px;object-fit:contain;margin-bottom:2px;filter:grayscale(100%) contrast(1000%);"
         alt="" onerror="this.style.display='none'">
    <div style="font-size:17px;font-weight:900;color:#000;">مكتبة العربية</div>
    <div style="font-size:12px;font-weight:900;margin-top:1px;color:#000;">للطباعة والقرطاسية</div>
    <div style="font-size:9.5px;font-weight:800;margin-top:2px;line-height:1.3;color:#000;">
      ${esc(CO.name)}<br>${esc(CO.address)}
    </div>
  </div>

  <!-- شارة العنوان -->
  <div style="border-top:2px solid #000;border-bottom:2px solid #000;text-align:center;padding:1.5mm 0;margin:2mm 0;">
    <div style="font-size:15px;font-weight:900;letter-spacing:.5px;color:#000;">فتح الوردية</div>
    <div style="font-size:11px;font-weight:800;color:#000;">بيان الرصيد الافتتاحي للصندوق</div>
  </div>

  <!-- بيانات الوردية في جدول بحدود واضحة -->
  <table style="width:100%;border-collapse:collapse;border:1.5px solid #000;margin:2mm 0;color:#000;">
    <tbody>${metaRows}</tbody>
  </table>

  <!-- الرصيد الافتتاحي — صندوق مالي مؤطر بحدود سميكة -->
  <div style="border:2.5px solid #000;text-align:center;padding:2.5mm 2mm;margin:2.5mm 0;background:#fff;color:#000;">
    <div style="font-size:11px;font-weight:900;color:#000;margin-bottom:1mm;">الرصيد الافتتاحي للصندوق</div>
    <div style="font-size:32px;font-weight:900;direction:ltr;line-height:1;letter-spacing:-1px;font-variant-numeric:tabular-nums;color:#000;">${fmt(d.openingBalance)}</div>
    <div style="font-size:12px;font-weight:900;color:#000;margin-top:1mm;">دينار عراقي</div>
    <div style="font-size:10px;font-weight:900;color:#000;margin-top:1.5mm;padding-top:1.5mm;border-top:1px dashed #000;">
      ${formatArabicMoneyWords(d.openingBalance)}
    </div>
  </div>

  <!-- صندوق تحقق الكاشير -->
  <table style="width:100%;border-collapse:collapse;border:1.5px solid #000;margin:2mm 0;color:#000;">
    <thead><tr style="background:#000;color:#fff;"><th colspan="2" style="padding:1mm;font-weight:900;font-size:11px;border:1px solid #000;">إقرار الكاشير باستلام العهدة النقدية</th></tr></thead>
    <tbody>
      <tr>
        <td style="width:45%;font-weight:900;padding:1.5mm;border:1px solid #000;font-size:11.5px;">المبلغ المستلم نقداً</td>
        <td style="font-weight:900;direction:ltr;text-align:left;font-variant-numeric:tabular-nums;padding:1.5mm;border:1px solid #000;font-size:13px;">${fmt(d.openingBalance)} د.ع</td>
      </tr>
    </tbody>
  </table>

  <!-- توقيعات في جدول بحدود واضحة -->
  <table style="width:100%;border-collapse:collapse;border:1.5px solid #000;margin:3mm 0;color:#000;">
    <thead><tr style="background:#000;color:#fff;"><th colspan="2" style="padding:1mm;font-weight:900;font-size:10.5px;border:1px solid #000;">التوقيع والاعتماد الميداني</th></tr></thead>
    <tbody>
      <tr>
        <td style="width:50%;text-align:center;padding:2mm 1.5mm;border:1px solid #000;">
          <div style="font-size:9.5px;font-weight:900;margin-bottom:12mm;">توقيع الكاشير المستلم</div>
          <div style="border-top:1px solid #000;padding-top:1mm;font-size:9px;font-weight:800;">الاسم: ${esc(d.cashierName)}</div>
        </td>
        <td style="width:50%;text-align:center;padding:2mm 1.5mm;border:1px solid #000;">
          <div style="font-size:9.5px;font-weight:900;margin-bottom:12mm;">توقيع المشرف / الإدارة</div>
          <div style="border-top:1px solid #000;padding-top:1mm;font-size:9px;font-weight:800;">الختم أو الاعتماد</div>
        </td>
      </tr>
    </tbody>
  </table>

  <div style="height:1.5px;background:#000;margin:2mm 0;"></div>

  <!-- فوتر -->
  <div style="text-align:center;font-size:10px;font-weight:800;line-height:1.5;padding-bottom:1mm;color:#000;">
    <div style="font-weight:900;font-size:11.5px;">${esc(CO.footer)}</div>
    ${phones}
  </div>`;

  return wrapReceiptDoc(`فتح الوردية #${d.shiftId}`, body);
}

export function printShiftOpenBrowser(d: ShiftOpenData): void {
  openPrintWindow(buildShiftOpenHtml(d), 'width=380,height=720');
}

// ═══════════════════════════════════════════════════════════════════════════════
// ١٢. إيصال إغلاق الوردية / Z-Report — حراري 80مم
// ═══════════════════════════════════════════════════════════════════════════════

export interface ShiftCloseData {
  shiftId: number;
  openedAt: Date | string | null;
  closedAt: Date;
  cashierName: string;
  branchName: string;
  departmentName?: string;
  openingBalance: string | number;
  invoiceCount: number;
  salesTotal: string | number;
  discountsTotal?: string | number | null;
  returnsTotal?: string | number | null;
  payments: {
    method: string;
    direction: 'IN' | 'OUT';
    count: number;
    total: string | number;
  }[];
  expectedCash: string | number;
  countedCash: string | number;
  variance: string | number;
  heldDepositsCount?: number | null;
  heldDepositsTotal?: string | number | null;
  treasuryReturn?: {
    amount: string | number;
    referenceNumber: string;
  } | null;
}

export function buildShiftCloseHtml(d: ShiftCloseData): string {
  const logo     = logoUrl();
  const openedStr  = d.openedAt ? fmtDateTime(d.openedAt) : '—';
  const closedStr  = fmtDateTime(d.closedAt);
  const duration   = calcDuration(d.openedAt, d.closedAt);

  // صفوف بيانات الوردية
  const metaRows: [string, string, 'rtl' | 'ltr'][] = [
    ['رقم الوردية', `#${d.shiftId}`, 'ltr'],
  ];
  if (d.departmentName) {
    metaRows.push(['القسم', esc(d.departmentName), 'rtl']);
  }
  metaRows.push(
    ['فُتحت',        esc(openedStr), 'ltr'],
    ['أُغلقت',       esc(closedStr), 'ltr'],
    ['مدة الوردية',  esc(duration), 'rtl'],
    ['الكاشير',      esc(d.cashierName), 'rtl'],
    ['الفرع',        esc(d.branchName), 'rtl'],
  );
  const metaRowsHtml = metaRows.map(([l, v, direction]) => `
    <tr>
      <td style="width:36%;font-weight:900;border:1px solid #000;padding:1mm 1.5mm;font-size:11px;">${l}</td>
      <td dir="${direction}" style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;font-size:11px;direction:${direction};unicode-bidi:isolate;">${v}</td>
    </tr>
  `).join('');

  // جدول طرق الدفع
  const payRows = d.payments
    .filter(p => Number(p.total) !== 0)
    .map(p => {
      const label  = `${METHOD_AR[p.method] ?? p.method} ${p.direction === 'IN' ? 'وارد' : 'صادر'}`;
      const amtStr = p.direction === 'OUT' ? `( ${fmt(p.total)} )` : fmt(p.total);
      return `<tr>
        <td style="padding:1mm 1.5mm;font-weight:900;font-size:11px;border:1px solid #000;">${esc(label)}</td>
        <td style="text-align:center;padding:1mm 1.5mm;font-weight:800;font-size:11px;border:1px solid #000;">${p.count}</td>
        <td style="text-align:left;direction:ltr;font-weight:900;font-size:11.5px;font-variant-numeric:tabular-nums;white-space:nowrap;padding:1mm 1.5mm;border:1px solid #000;">${amtStr}</td>
      </tr>`;
    }).join('');

  // حساب صافي المبيعات
  const discounts = Number(d.discountsTotal ?? 0);
  const returns   = Number(d.returnsTotal   ?? 0);
  const netSales  = Number(d.salesTotal) - discounts - returns;

  // الفرق: label + قيمة
  const varNum   = Number(d.variance);
  const varLabel = varNum === 0 ? 'مطابق تماماً ✓' : varNum > 0 ? 'الفرق — زيادة نقدية' : 'الفرق — عجز بالصندوق';
  const varVal   = varNum === 0 ? '0 د.ع' : `${varNum > 0 ? '+' : '−'} ${fmt(Math.abs(varNum))} د.ع`;

  const phones = RECEIPT_PHONES.slice(0, 2)
    .map(p => `<div>${esc(p.l)}: <strong>${esc(p.n)}</strong></div>`)
    .join('');

  const body = `
  <!-- رأس الشركة -->
  <div style="text-align:center;padding:2mm 0;">
    <img src="${logo}" style="width:40px;height:40px;object-fit:contain;margin-bottom:2px;filter:grayscale(100%) contrast(1000%);"
         alt="" onerror="this.style.display='none'">
    <div style="font-size:17px;font-weight:900;color:#000;">مكتبة العربية</div>
    <div style="font-size:12px;font-weight:900;margin-top:1px;color:#000;">للطباعة والقرطاسية</div>
    <div style="font-size:9.5px;font-weight:800;margin-top:2px;line-height:1.3;color:#000;">
      ${esc(CO.name)}<br>${esc(CO.address)}
    </div>
  </div>

  <!-- شارة العنوان -->
  <div style="border-top:2px solid #000;border-bottom:2px solid #000;text-align:center;padding:1.5mm 0;margin:2mm 0;">
    <div style="font-size:15px;font-weight:900;letter-spacing:.5px;">إغلاق الوردية — Z Report</div>
    <div style="font-size:11px;font-weight:800;color:#000;">تقرير الإقفال المالي والعملياتي</div>
  </div>

  <!-- بيانات الوردية في جدول بحدود -->
  <table style="width:100%;border-collapse:collapse;border:1.5px solid #000;margin:2mm 0;color:#000;">
    <tbody>${metaRowsHtml}</tbody>
  </table>

  <!-- جدول ملخص المبيعات -->
  <table style="width:100%;border-collapse:collapse;border:1.5px solid #000;margin:2mm 0;color:#000;">
    <thead><tr style="background:#000;color:#fff;"><th colspan="2" style="padding:1mm;font-weight:900;font-size:11px;border:1px solid #000;">ملخّص المبيعات</th></tr></thead>
    <tbody>
      <tr><td style="width:55%;font-weight:900;border:1px solid #000;padding:1mm 1.5mm;font-size:11px;">عدد الفواتير</td><td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;font-size:12px;">${d.invoiceCount} فاتورة</td></tr>
      <tr><td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;font-size:11px;">إجمالي المبيعات</td><td style="font-weight:900;direction:ltr;text-align:left;font-variant-numeric:tabular-nums;border:1px solid #000;padding:1mm 1.5mm;font-size:12.5px;">${fmt(d.salesTotal)} د.ع</td></tr>
      ${discounts > 0 ? `<tr><td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;font-size:11px;">إجمالي الخصومات</td><td style="font-weight:900;direction:ltr;text-align:left;font-variant-numeric:tabular-nums;border:1px solid #000;padding:1mm 1.5mm;font-size:12px;">-${fmt(discounts)} د.ع</td></tr>` : ''}
      ${returns > 0 ? `<tr><td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;font-size:11px;">المرتجعات</td><td style="font-weight:900;direction:ltr;text-align:left;font-variant-numeric:tabular-nums;border:1px solid #000;padding:1mm 1.5mm;font-size:12px;">-${fmt(returns)} د.ع</td></tr>` : ''}
      ${Number(d.heldDepositsCount ?? 0) > 0 ? `<tr><td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;font-size:11px;">عرابين محجوزة (${d.heldDepositsCount})</td><td style="font-weight:900;direction:ltr;text-align:left;font-variant-numeric:tabular-nums;border:1px solid #000;padding:1mm 1.5mm;font-size:12px;">${fmt(d.heldDepositsTotal ?? 0)} د.ع</td></tr>` : ''}
      <tr style="background:#000;color:#fff;font-weight:900;">
        <td style="border:1px solid #000;padding:1.5mm;font-size:12.5px;">صافي المبيعات</td>
        <td style="border:1px solid #000;padding:1.5mm;direction:ltr;text-align:left;font-size:14.5px;font-variant-numeric:tabular-nums;white-space:nowrap;">${fmt(netSales)} د.ع</td>
      </tr>
      <tr>
        <td colspan="2" style="text-align:center;font-weight:900;font-size:10px;padding:1.2mm;border:1px solid #000;">
          ${formatArabicMoneyWords(netSales)}
        </td>
      </tr>
    </tbody>
  </table>

  <!-- جدول تفصيل طرق الدفع -->
  <table style="width:100%;font-size:11px;border-collapse:collapse;border:1.5px solid #000;margin:2mm 0;color:#000;">
    <thead>
      <tr style="background:#000;color:#fff;">
        <th style="text-align:right;padding:1mm 1.5mm;font-weight:900;border:1px solid #000;">طريقة الدفع</th>
        <th style="text-align:center;padding:1mm 1.5mm;font-weight:900;border:1px solid #000;width:35px;">عدد</th>
        <th style="text-align:left;padding:1mm 1.5mm;font-weight:900;border:1px solid #000;width:80px;">المبلغ</th>
      </tr>
    </thead>
    <tbody>
      ${payRows || '<tr><td colspan="3" style="font-size:11px;padding:2mm;text-align:center;border:1px solid #000;">لا توجد حركات</td></tr>'}
    </tbody>
  </table>

  <!-- جدول تسوية الصندوق النقدي -->
  <table style="width:100%;border-collapse:collapse;border:1.5px solid #000;margin:2mm 0;color:#000;">
    <thead><tr style="background:#000;color:#fff;"><th colspan="2" style="padding:1mm;font-weight:900;font-size:11px;border:1px solid #000;">تسوية ومطابقة الصندوق النقدي</th></tr></thead>
    <tbody>
      <tr><td style="width:55%;font-weight:900;border:1px solid #000;padding:1mm 1.5mm;font-size:11px;">الرصيد الافتتاحي</td><td style="font-weight:900;direction:ltr;text-align:left;font-variant-numeric:tabular-nums;border:1px solid #000;padding:1mm 1.5mm;font-size:12px;">${fmt(d.openingBalance)} د.ع</td></tr>
      <tr><td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;font-size:11px;">النقد المتوقع بالدرج</td><td style="font-weight:900;direction:ltr;text-align:left;font-variant-numeric:tabular-nums;border:1px solid #000;padding:1mm 1.5mm;font-size:12.5px;">${fmt(d.expectedCash)} د.ع</td></tr>
      <tr style="background:#000;color:#fff;font-weight:900;"><td style="border:1px solid #000;padding:1.2mm 1.5mm;font-size:11.5px;">النقد الفعلي المعدود</td><td style="border:1px solid #000;padding:1.2mm 1.5mm;direction:ltr;text-align:left;font-size:14px;font-variant-numeric:tabular-nums;">${fmt(d.countedCash)} د.ع</td></tr>
      <tr>
        <td style="font-weight:900;border:1px solid #000;padding:1.5mm;font-size:12px;">${esc(varLabel)}</td>
        <td style="font-weight:900;direction:ltr;text-align:left;font-variant-numeric:tabular-nums;border:1px solid #000;padding:1.5mm;font-size:14px;">${esc(varVal)}</td>
      </tr>
    </tbody>
  </table>

  ${d.treasuryReturn ? `
  <table style="width:100%;border-collapse:collapse;border:1.5px solid #000;margin:2mm 0;color:#000;font-size:10.5px;">
    <thead><tr style="background:#000;color:#fff;"><th colspan="2" style="padding:1mm;font-weight:900;border:1px solid #000;">ترحيل النقد إلى الخزينة الرئيسية</th></tr></thead>
    <tbody>
      <tr><td style="width:40%;font-weight:900;border:1px solid #000;padding:1mm 1.5mm;">المبلغ المرحل</td><td style="font-weight:900;direction:ltr;text-align:left;border:1px solid #000;padding:1mm 1.5mm;">${fmt(d.treasuryReturn.amount)} د.ع</td></tr>
      <tr><td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;">رقم سند التوريد</td><td style="font-weight:900;border:1px solid #000;padding:1mm 1.5mm;">${esc(d.treasuryReturn.referenceNumber)}</td></tr>
    </tbody>
  </table>` : ''}

  <!-- توقيعات في جدول بحدود واضحة -->
  <table style="width:100%;border-collapse:collapse;border:1.5px solid #000;margin:3mm 0;color:#000;">
    <thead><tr style="background:#000;color:#fff;"><th colspan="2" style="padding:1mm;font-weight:900;font-size:10.5px;border:1px solid #000;">التوقيعات والاعتماد</th></tr></thead>
    <tbody>
      <tr>
        <td style="width:50%;text-align:center;padding:2mm 1.5mm;border:1px solid #000;">
          <div style="font-size:9.5px;font-weight:900;margin-bottom:12mm;">توقيع الكاشير</div>
          <div style="border-top:1px solid #000;padding-top:1mm;font-size:9px;font-weight:800;">الاسم: ${esc(d.cashierName)}</div>
        </td>
        <td style="width:50%;text-align:center;padding:2mm 1.5mm;border:1px solid #000;">
          <div style="font-size:9.5px;font-weight:900;margin-bottom:12mm;">توقيع المشرف / الإدارة</div>
          <div style="border-top:1px solid #000;padding-top:1mm;font-size:9px;font-weight:800;">الختم أو الاعتماد</div>
        </td>
      </tr>
    </tbody>
  </table>

  <!-- تاريخ وطباعة الإغلاق -->
  <div style="text-align:center;font-size:9.5px;font-weight:800;margin:2mm 0;color:#000;">
    تاريخ الإغلاق: <span dir="ltr" style="font-weight:900;">${esc(closedStr)}</span> · نسخة رسمية
  </div>

  <div style="height:1.5px;background:#000;margin:2mm 0;"></div>

  <!-- فوتر -->
  <div style="text-align:center;font-size:10.5px;font-weight:800;line-height:1.5;padding-bottom:1mm;color:#000;">
    <div style="font-weight:900;font-size:12px;">نهاية الوردية — شكراً لجهودكم</div>
    ${phones}
  </div>`;

  return wrapShiftReceiptDoc(`إغلاق الوردية #${d.shiftId}`, body);
}

export function printShiftCloseBrowser(d: ShiftCloseData): void {
  openPrintWindow(buildShiftCloseHtml(d), 'width=380,height=920');
}
