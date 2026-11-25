import { salesInvoiceTotals } from "./receiptLayoutInvoiceTotals";
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
import type { PrintWindowOptions } from "./brand";
import { fmtQty } from '@shared/quantityFormat';
import Decimal from 'decimal.js';
import { docBarcode } from '@shared/documentNumber';
import { fmtDate as formatDate } from '../date';
import { productBarcodeSvg } from './barcode';
import { canonicalizeBarcodeInput } from '@shared/barcodeNormalize';
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
  type DocHeaderBarcode,
} from './docHtml';
import { formatArabicMoneyWords } from './tafqit';
import { formatPaymentMethodPrintHtml } from './cardBrandLogos';
import { isDeadInvoice } from '@shared/predicates';
import { renderA4PromoBannerHtml, type PromoPrintSummary } from './promoPrintSummary';
import {
  balanceDirectionLabel,
  buildBalanceTrailSnapshot,
  type LedgerPartyKind,
} from '@shared/balanceTrail';

// ─── مساعدات مشتركة ──────────────────────────────────────────────────────────

/**
 * تحويل ISO/Date إلى `dd/mm/yyyy` (بأرقام لاتينية داخل خانة اتجاه LTR في التصميم).
 * ⚠️ تاريخ نصّي بصيغة YYYY-MM-DD يُعامَل كتاريخ يوميّ محلّي **لا** UTC — `new Date('2026-07-05')`
 *   يفسّر السلسلة كمنتصف ليل UTC فيُظهرها في المتصفّحات غرب UTC بيومٍ أسبق. المرجع الرسمي
 *   للسندات/الفواتير هو يوم التقويم في العراق، فنُنسّق مباشرةً بلا مرور بـDate.
 */
function fmtDate(d?: string | Date | null): string {
  return formatDate(d ?? new Date());
}

function dMoney(n: string | number | Decimal | null | undefined): Decimal {
  if (n == null || n === '') return new Decimal(0);
  try {
    const cleaned = typeof n === 'string' ? n.replace(/,/g, '').trim() : n;
    const val = new Decimal(cleaned || 0);
    return val.isFinite() ? val : new Decimal(0);
  } catch {
    return new Decimal(0);
  }
}

/** تنسيق دينار عراقي بـDecimal مع حفظ الكسور غير الصفرية (حتى خانتين عشريتين). */
function fmtIQD(n: string | number | null | undefined): string {
  return fmt(dMoney(n).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2));
}

function taxLabel(taxAmount: string | number | null | undefined, taxRate: number | null | undefined, subtotal: string | number, discount: string | number | null | undefined): string {
  const explicitRate = taxRate != null && Number.isFinite(taxRate) ? Number(taxRate) : null;
  if (explicitRate != null && explicitRate > 0) return `ضريبة المبيعات (${explicitRate}٪)`;
  const tx = dMoney(taxAmount);
  const base = dMoney(subtotal).minus(dMoney(discount));
  if (base.gt(0) && tx.gt(0)) {
    const computed = tx.div(base).times(100).toDecimalPlaces(1, Decimal.ROUND_HALF_UP).toNumber();
    return `ضريبة المبيعات (${computed}٪)`;
  }
  return 'ضريبة المبيعات';
}

export { fmtQty };

/** اتّجاه رصيد العميل (الموجب = لنا عليه). */
function balanceDirCustomer(balance: string | number | Decimal): string {
  const b = dMoney(balance);
  if (b.abs().lt('0.01')) return 'خالص';
  return b.gt(0) ? 'لنا' : 'علينا';
}
/** اتّجاه رصيد المورّد (الموجب = علينا نحن للمورّد). */
function balanceDirSupplier(balance: string | number | Decimal): string {
  const b = dMoney(balance);
  if (b.abs().lt('0.01')) return 'خالص';
  return b.gt(0) ? 'علينا' : 'لنا';
}

function balanceSnapshotPrintHtml(input: {
  partyType: LedgerPartyKind;
  before: string | number | null | undefined;
  after?: string | number | null | undefined;
  debit?: string | number | null | undefined;
  credit?: string | number | null | undefined;
  unit?: string;
}): string {
  const unit = input.unit ?? 'د.ع';
  const snap = buildBalanceTrailSnapshot({
    partyType: input.partyType,
    before: input.before,
    debit: input.debit,
    credit: input.credit,
  });
  const afterVal = input.after != null ? dMoney(input.after) : dMoney(snap.after);
  const afterAbs = fmtIQD(afterVal.abs().toFixed(2));
  const afterDir = balanceDirectionLabel(input.partyType, afterVal);
  const debitD = dMoney(snap.debit);
  const creditD = dMoney(snap.credit);
  const deltaD = dMoney(input.after != null ? afterVal.minus(dMoney(snap.before)) : snap.delta);
  const sign = deltaD.isNegative() ? '− ' : deltaD.gt(0) ? '+ ' : '';
  const effectText = `${sign}${fmtIQD(deltaD.abs().toFixed(2))}`;
  const effectKind = debitD.gt(0) && creditD.isZero() ? 'مدين' : creditD.gt(0) && debitD.isZero() ? 'دائن' : 'الأثر';

  return `<div data-balance-snapshot style="margin-top:10px;display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:8px 10px;background:${B.bgWarm};border:1px solid ${B.border};border-radius:4px">
    <div style="text-align:center">
      <div style="font-size:9px;color:${B.textFaint};font-weight:700">الرصيد قبل الحركة</div>
      <div style="font-size:12px;font-weight:800;color:#000;direction:ltr;unicode-bidi:isolate;font-variant-numeric:tabular-nums">${esc(fmtIQD(snap.beforeAbs))} ${esc(unit)}</div>
      <div style="font-size:9.5px;color:${B.textFaint};font-weight:700">${esc(snap.beforeDirectionLabel)}</div>
    </div>
    <div style="text-align:center;border-inline:1px dashed ${B.border};padding-inline:6px">
      <div style="font-size:9px;color:${B.textFaint};font-weight:700">${esc(effectKind)}</div>
      <div style="font-size:12px;font-weight:900;color:${deltaD.isNegative() ? B.green : B.alert};direction:ltr;unicode-bidi:isolate;font-variant-numeric:tabular-nums">${esc(effectText)} ${esc(unit)}</div>
    </div>
    <div style="text-align:center">
      <div style="font-size:9px;color:${B.textFaint};font-weight:700">الرصيد بعد الحركة</div>
      <div style="font-size:12.5px;font-weight:900;color:#000;direction:ltr;unicode-bidi:isolate;font-variant-numeric:tabular-nums">${esc(afterAbs)} ${esc(unit)}</div>
      <div style="font-size:9.5px;color:${afterVal.gt(0) ? (input.partyType === 'SUPPLIER' ? B.alert : B.green) : B.textFaint};font-weight:800">${esc(afterDir)}</div>
    </div>
  </div>`;
}

/**
 * حلّ وتجهيز كائن باركود المستند للترويسة الرسمية.
 * إن لم يُلغَ صراحةً (false/null)، يُنشأ تلقائياً كرمز آلة قياسي ببادئة النوع (مثل INV-XXXXX).
 */
export function resolveDocBarcode(
  prefix: string,
  docNum: string,
  barcode?: DocHeaderBarcode | string | boolean | null,
  placement?: 'beside' | 'below',
): DocHeaderBarcode | null {
  if (barcode === false || barcode === null) return null;
  const defaultPlacement = placement ?? 'beside';
  if (typeof barcode === 'object' && barcode !== undefined) {
    return {
      ...barcode,
      placement: placement ?? barcode.placement ?? defaultPlacement,
    };
  }
  if (typeof barcode === 'string') {
    return {
      value: barcode,
      placement: defaultPlacement,
    };
  }
  return {
    value: docBarcode(prefix, docNum),
    placement: defaultPlacement,
  };
}

/**
 * راسم باركود السطر في جدول المستندات الرسمية (بديل عمود الضريبة عند عدم تفعيلها).
 * يُخرج تمثيلاً مرئياً كاملاً (قضبان SVG هندسية + الرمز المقروء بشرياً بالأسفل)
 * بمقاييس دقيقة تلائم جدول A4 وقابلة للمسح الضوئي الفوري بواسطة كافة الماسحات.
 */
export function renderItemBarcodeCell(rawCode?: string | null, svgOverride?: string | null): string {
  if (svgOverride) {
    const code = rawCode ? canonicalizeBarcodeInput(rawCode) : '';
    return `<div style="display:inline-flex;flex-direction:column;align-items:center;justify-content:center;width:100%;max-width:115px;margin:0 auto;vertical-align:middle">
      <div style="width:100%;max-width:105px;height:22px;display:flex;align-items:center;justify-content:center;overflow:hidden">${svgOverride}</div>
      ${code ? `<span style="font-family:monospace;font-size:8.5px;font-weight:700;color:#000;line-height:1.2;margin-top:1.5px;direction:ltr;unicode-bidi:isolate;letter-spacing:0.5px">${esc(code)}</span>` : ''}
    </div>`;
  }
  if (!rawCode) return '<span style="color:#888;font-weight:700">—</span>';
  const code = canonicalizeBarcodeInput(rawCode);
  if (!code) return '<span style="color:#888;font-weight:700">—</span>';
  try {
    const res = productBarcodeSvg(code, {
      moduleWidth: 1,
      height: 22,
      quietZone: 4,
      showText: false,
      fitToBox: true,
    });
    return `<div style="display:inline-flex;flex-direction:column;align-items:center;justify-content:center;width:100%;max-width:115px;margin:0 auto;vertical-align:middle">
      <div style="width:100%;max-width:105px;height:22px;display:flex;align-items:center;justify-content:center;overflow:hidden">${res.svg}</div>
      <span style="font-family:monospace;font-size:8.5px;font-weight:700;color:#000;line-height:1.2;margin-top:1.5px;direction:ltr;unicode-bidi:isolate;letter-spacing:0.5px">${esc(code)}</span>
    </div>`;
  } catch {
    return `<span style="font-family:monospace;font-size:9.5px;font-weight:700;color:#000;direction:ltr;unicode-bidi:isolate">${esc(code)}</span>`;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// ١. فاتورة مبيعات — A4
// ═════════════════════════════════════════════════════════════════════════════

export interface SalesInvoiceV2Data {
  invoiceNumber: string;
  invoiceDate?: string | Date | null;
  /** باركود رقم الفاتورة للطباعة الرسمية (اختياري، إن غاب يُنشأ تلقائياً من رقم الفاتورة كرمز آلة INV-XXXXX) */
  barcode?: DocHeaderBarcode | string | boolean | null;
  /** موضع الباركود: بجانب الرقم أو تحته (الافتراضي "beside") */
  barcodePlacement?: 'beside' | 'below';
  /** حالة الدفع كنص عربي: «مدفوعة»، «مدفوعة جزئياً»، «آجلة»، … (مع لون الشارة الملائم). */
  statusLabel?: string | null;
  statusColor?: string | null;

  customerName?: string | null;
  customerAddress?: string | null;
  customerPhone?: string | null;

  paymentMethod?: string | null;
  /** تفصيل دفعات الفاتورة عند تعدّد طرق الدفع (MIXED) */
  paymentLegs?: Array<{
    method: string;
    amount: string | number;
    reference?: string | null;
  }> | null;
  salesRep?: string | null;
  branchName?: string | null;
  /** وسم النسخة كما أجازه مسار طباعة الفواتير. */
  copyLabel?: string | null;

  items: {
    productName: string;
    unitName?: string | null;
    quantity: string | number;
    unitPrice: string | number;
    /** حصة السطر من الضريبة (Line-tax). إن كانت صفرية، تُعرَض «—». */
    taxAmount?: string | number | null;
    total: string | number;
    /** هدايا الفاتورة (0149): سطرٌ مُهدىً — يُطبَع «مجاناً» ووسمُ «هدية» بجانب الاسم. */
    isGift?: boolean | null;
    /** باركود المنتج (يُستبدل به عمود الضريبة عند عدم تفعيلها). */
    barcode?: string | null;
    /** SVG جاهز للباركود إن وُجد. */
    barcodeSvg?: string | null;
  }[];

  /** تحكم صريح بإظهار عمود الباركود بدل الضريبة (الافتراضي: true عندما لا توجد ضريبة على الفاتورة). */
  showBarcodeColumn?: boolean;

  /** إفصاح التوصيل (0152): الأجرة المقبوضة (>0 ⇒ سطر «أجرة التوصيل»). */
  deliveryFee?: string | number | null;
  /** true ⇒ يُطبَع «التوصيل: مجاناً» — يميّزه عن غياب التوصيل أصلاً. */
  deliveryFree?: boolean | null;
  /** قيمة الأجرة المُتنازَل عنها — تُطبَع «مجاناً — قيمته X» ليرى الزبون مقدار ما أُهدي له. */
  deliveryWaivedAmount?: string | number | null;
  /** ٨/٨ — توصيل الاستقبال (COURIER/COD): الأجرة على الإرسالية لا على `invoices.deliveryFee`
   *  (تمريرٌ لا إيراد). عرضٌ فقط — لا يدخل «الإجمالي المستحق للمكتبة»، لكن يُظهر «المجموع النهائي
   *  الذي يدفعه الزبون شاملاً التوصيل» كي تُصوَّر الفاتورة وتُرسَل للزبون. */
  courierDelivery?: { partyName: string; fee: string | number; feeCollection: "COURIER" | "COUNTER" | "SHOP" } | null;

  subtotal: string | number;
  discountAmount?: string | number | null;
  taxAmount?: string | number | null;
  taxRate?: number | null;
  total: string | number;
  paidAmount?: string | number | null;
  remainingAmount?: string | number | null;
  currentTotal?: string | number | null;
  returnedTotal?: string | number | null;
  status?: string | null;

  /** رصيد العميل قبل وبعد هذه الفاتورة (من دفتر الأستاذ الفعلي). */
  customerBalanceBefore?: string | number | null;
  customerBalanceAfter?: string | number | null;

  /** SVG جاهز من qr.ts (اختياري). إن غاب يُستعمل placeholder. */
  qrSvg?: string | null;
  qrCaption?: string | null;
  /** ملخص المزايا والعروض الترويجية للطباعة التسويقية على الفاتورة الرسمية. */
  promoSummary?: PromoPrintSummary | null;

  settings?: CompanySettings;
}

export function buildSalesInvoiceV2Body(d: SalesInvoiceV2Data): string {
  const date = fmtDate(d.invoiceDate);
  const badge = d.statusLabel ? { label: d.statusLabel, color: d.statusColor ?? B.orange } : null;

  const header = pageHeader({
    title: 'فاتورة مبيعات',
    fields: [
      { label: 'رقم الفاتورة', value: d.invoiceNumber },
      { label: 'التاريخ', value: date },
    ],
    badge,
    barcode: resolveDocBarcode('INV', d.invoiceNumber, d.barcode, d.barcodePlacement),
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
        ...(d.paymentLegs && d.paymentLegs.length > 1
          ? d.paymentLegs.map((leg) => ({
              label: `دفعة (${leg.method})`,
              value: `${fmtIQD(leg.amount)} د.ع${leg.reference ? ` — مرجع: ${leg.reference}` : ''}`,
            }))
          : []),
        ...(d.salesRep ? [{ label: 'مندوب المبيعات', value: d.salesRep }] : []),
        ...(d.branchName ? [{ label: 'الفرع', value: d.branchName }] : []),
        ...(d.copyLabel ? [{ label: 'نوع النسخة', value: d.copyLabel }] : []),
      ],
    },
  ]);

  const hasTax =
    dMoney(d.taxAmount).gt(0) ||
    dMoney(d.taxRate).gt(0) ||
    d.items.some((it) => dMoney(it.taxAmount).gt(0));
  const showBarcode =
    d.showBarcodeColumn !== undefined ? d.showBarcodeColumn : !hasTax;

  const cols: DocTableCol[] = showBarcode
    ? [
        { key: 'name', label: 'المنتج' },
        { key: 'unit', label: 'الوحدة', width: 50 },
        { key: 'qty',  label: 'الكمية', width: 48 },
        { key: 'price', label: 'السعر', width: 70 },
        { key: 'barcode', label: 'الباركود', width: 115, rawHtml: true },
        { key: 'total', label: 'الإجمالي', width: 84, emphasize: true },
      ]
    : [
        { key: 'name', label: 'المنتج' },
        { key: 'unit', label: 'الوحدة', width: 58 },
        { key: 'qty',  label: 'الكمية', width: 52 },
        { key: 'price', label: 'السعر', width: 74 },
        { key: 'tax', label: 'الضريبة', width: 62, color: B.orange },
        { key: 'total', label: 'الإجمالي', width: 88, emphasize: true },
      ];
  const rows = d.items.map((it) => ({
    name: it.isGift ? `${it.productName} (هدية)` : it.productName,
    unit: it.unitName ?? '',
    qty:  fmtQty(it.quantity),
    price: it.isGift ? 'مجاناً' : fmtIQD(it.unitPrice),
    barcode: renderItemBarcodeCell(it.barcode, it.barcodeSvg),
    tax:  dMoney(it.taxAmount).gt(0) ? fmtIQD(it.taxAmount) : '—',
    total: it.isGift ? 'مجاناً' : fmtIQD(it.total),
  }));
  const table = docTableV2(cols, rows);
  const promoBanner = renderA4PromoBannerHtml(d.promoSummary, fmtIQD, isDeadInvoice(d.status));

  const totals = salesInvoiceTotals(d, fmtIQD, taxLabel);

  let balanceStrip = '';
  if (d.customerBalanceBefore != null && d.customerBalanceAfter != null) {
    const beforeD = dMoney(d.customerBalanceBefore);
    const afterD = dMoney(d.customerBalanceAfter);
    const diffD = afterD.minus(beforeD);
    balanceStrip = balanceSnapshotPrintHtml({
      partyType: 'CUSTOMER',
      before: beforeD.toFixed(2),
      after: afterD.toFixed(2),
      debit: diffD.gt(0) ? diffD.toFixed(2) : '0',
      credit: diffD.lt(0) ? diffD.abs().toFixed(2) : '0',
    });
  }

  const tafqit = tafqitLine(formatArabicMoneyWords(dMoney(d.total).toNumber()));

  const sig = signaturesBlock({
    qrSvg: d.qrSvg ?? null,
    qrCaption: d.qrCaption ?? 'امسح للتحقق من مطابقة بيانات الفاتورة',
    items: [
      { kind: 'sig', label: 'توقيع المستلم' },
      { kind: 'stamp' },
      { kind: 'sig', label: 'المفوّض بالبيع' },
    ],
  });

  return `${pageBodyOpen()}${header}${cards}${table}${promoBanner}${totals}${balanceStrip}${tafqit}${sig}${pageBodyClose()}${pageFooter(d.settings, { rightText: `REF ${d.invoiceNumber}` })}`;
}

export function buildSalesInvoiceV2Html(d: SalesInvoiceV2Data): string {
  return wrapA4Doc(`فاتورة ${d.invoiceNumber}`, buildSalesInvoiceV2Body(d));
}

export function printSalesInvoiceV2(d: SalesInvoiceV2Data, options?: PrintWindowOptions): boolean {
  return options
    ? openPrintWindow(buildSalesInvoiceV2Html(d), undefined, options)
    : openPrintWindow(buildSalesInvoiceV2Html(d));
}

// ═════════════════════════════════════════════════════════════════════════════
// ٢. فاتورة مشتريات — A4
// ═════════════════════════════════════════════════════════════════════════════

export interface PurchaseInvoiceV2Data {
  invoiceNumber: string;
  invoiceDate?: string | Date | null;
  /** باركود رقم الفاتورة للطباعة الرسمية (اختياري، إن غاب يُنشأ تلقائياً من رقم الفاتورة كرمز آلة PO-XXXXX) */
  barcode?: DocHeaderBarcode | string | boolean | null;
  /** موضع الباركود: بجانب الرقم أو تحته (الافتراضي "beside") */
  barcodePlacement?: 'beside' | 'below';
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
    /** باركود المنتج (يُستبدل به عمود الضريبة عند عدم تفعيلها). */
    barcode?: string | null;
    /** SVG جاهز للباركود إن وُجد. */
    barcodeSvg?: string | null;
  }[];

  /** تحكم صريح بإظهار عمود الباركود بدل الضريبة (الافتراضي: true عندما لا توجد ضريبة على الفاتورة). */
  showBarcodeColumn?: boolean;

  subtotal: string | number;
  discountAmount?: string | number | null;
  taxAmount?: string | number | null;
  taxRate?: number | null;
  total: string | number;
  paidAmount?: string | number | null;
  remainingAmount?: string | number | null;
  returnedAmount?: string | number | null;
  recognizedAmount?: string | number | null;

  supplierBalanceBefore?: string | number | null;
  supplierBalanceAfter?: string | number | null;

  createdByName?: string | null;
  approvedByName?: string | null;
  cashSourceLabel?: string | null;
  agreedCurrency?: string | null;
  agreedRate?: string | number | null;
  usdTotal?: string | number | null;

  qrSvg?: string | null;
  qrCaption?: string | null;
  settings?: CompanySettings;
}

export function buildPurchaseInvoiceV2Body(d: PurchaseInvoiceV2Data): string {
  const date = fmtDate(d.invoiceDate);
  const badge = d.statusLabel ? { label: d.statusLabel, color: d.statusColor ?? B.orange } : null;

  const header = pageHeader({
    title: 'فاتورة مشتريات',
    fields: [
      { label: 'رقم الفاتورة', value: d.invoiceNumber },
      { label: 'التاريخ', value: date },
    ],
    badge,
    barcode: resolveDocBarcode('PO', d.invoiceNumber, d.barcode, d.barcodePlacement),
  }, d.settings);

  const isUsd = d.agreedCurrency === 'USD' || (dMoney(d.usdTotal).gt(0) && dMoney(d.agreedRate).gt(0));
  const cards = infoCards([
    {
      title: 'معلومات المورّد',
      variant: 'green',
      fields: [
        { label: 'الاسم', value: d.supplierName ?? '—' },
        ...(d.supplierAddress ? [{ label: 'العنوان', value: d.supplierAddress }] : []),
        ...(d.supplierPhone ? [{ label: 'الهاتف', value: d.supplierPhone }] : []),
        ...(d.createdByName ? [{ label: 'المنشئ', value: d.createdByName }] : []),
        ...(d.approvedByName ? [{ label: 'المعتمد', value: d.approvedByName }] : []),
      ],
    },
    {
      title: 'تفاصيل الشراء',
      variant: 'gray',
      fields: [
        ...(d.paymentMethod ? [{ label: 'طريقة الدفع', value: d.paymentMethod }] : []),
        ...(d.cashSourceLabel ? [{ label: 'مصدر الصرف', value: d.cashSourceLabel }] : []),
        ...(d.linkedPO ? [{ label: 'رقم أمر الشراء المرتبط', value: d.linkedPO }] : []),
        ...(d.warehouseName ? [{ label: 'المخزن المستلم', value: d.warehouseName }] : []),
        ...(isUsd && d.agreedRate ? [{ label: 'العملة المثبتة', value: `USD (${fmtIQD(d.agreedRate)} د.ع/$)` }] : []),
      ],
    },
  ]);

  const fmtUsd2 = (v: string | number | null | undefined) =>
    dMoney(v).toNumber().toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const usdEquation = isUsd && dMoney(d.usdTotal).gt(0) && dMoney(d.agreedRate).gt(0)
    ? `<div style="margin-top:8px;padding:7px 12px;border:1px solid ${B.border};border-radius:4px;background:${B.bgWarm};font-size:10.75px;font-weight:700;color:${B.ink};display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
        <span>تفصيل العملة المثبتة:</span>
        <span style="direction:ltr;unicode-bidi:isolate;font-variant-numeric:tabular-nums">$${esc(fmtUsd2(d.usdTotal))} × ${esc(fmtIQD(d.agreedRate))} د.ع/$ = ${esc(fmtIQD(d.total))} د.ع</span>
      </div>`
    : '';

  const hasTax =
    dMoney(d.taxAmount).gt(0) ||
    dMoney(d.taxRate).gt(0) ||
    d.items.some((it) => dMoney(it.taxAmount).gt(0));
  const showBarcode =
    d.showBarcodeColumn !== undefined ? d.showBarcodeColumn : !hasTax;

  const cols: DocTableCol[] = showBarcode
    ? [
        { key: 'name', label: 'المنتج' },
        { key: 'unit', label: 'الوحدة', width: 50 },
        { key: 'qty', label: 'الكمية', width: 48 },
        { key: 'price', label: 'السعر', width: 70 },
        { key: 'barcode', label: 'الباركود', width: 115, rawHtml: true },
        { key: 'total', label: 'الإجمالي', width: 84, emphasize: true },
      ]
    : [
        { key: 'name', label: 'المنتج' },
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
    barcode: renderItemBarcodeCell(it.barcode, it.barcodeSvg),
    tax: dMoney(it.taxAmount).gt(0) ? fmtIQD(it.taxAmount) : '—',
    total: fmtIQD(it.total),
  }));
  const table = docTableV2(cols, rows);

  const remainingD = d.remainingAmount != null
    ? dMoney(d.remainingAmount)
    : dMoney(d.total).minus(dMoney(d.paidAmount));
  const balBeforeD = d.supplierBalanceBefore != null ? dMoney(d.supplierBalanceBefore) : null;
  const balAfterD = d.supplierBalanceAfter != null ? dMoney(d.supplierBalanceAfter) : null;

  const totals = totalsBox({
    lines: [
      { label: 'المجموع الفرعي', value: fmtIQD(d.subtotal) },
      ...(dMoney(d.discountAmount).gt(0) ? [{ label: 'خصم المورّد', value: fmtIQD(d.discountAmount), color: B.orange, sign: '−' as const }] : []),
      ...(dMoney(d.taxAmount).gt(0) ? [{ label: taxLabel(d.taxAmount, d.taxRate, d.subtotal, d.discountAmount), value: fmtIQD(d.taxAmount), sign: '+' as const }] : []),
    ],
    grandTotal: { label: 'إجمالي أمر الشراء', value: fmtIQD(d.total) },
    paid: d.paidAmount != null ? { label: 'المدفوع', value: fmtIQD(d.paidAmount) } : null,
    remaining: remainingD.gt(0) ? { label: 'المتبقّي', value: fmtIQD(remainingD.toFixed(2)) } : null,
    balance: balAfterD != null ? {
      beforeLabel: 'الرصيد السابق',
      before: fmtIQD((balBeforeD ?? new Decimal(0)).toFixed(2)),
      afterLabel: 'الرصيد النهائي (المستحق للمورّد)',
      after: fmtIQD(balAfterD.abs().toFixed(2)),
      direction: balanceDirSupplier(balAfterD),
      directionColor: B.alert,
    } : null,
  });

  let balanceStrip = '';
  if (balBeforeD != null && balAfterD != null) {
    const diffD = balAfterD.minus(balBeforeD);
    balanceStrip = balanceSnapshotPrintHtml({
      partyType: 'SUPPLIER',
      before: balBeforeD.toFixed(2),
      after: balAfterD.toFixed(2),
      credit: diffD.gt(0) ? diffD.toFixed(2) : '0',
      debit: diffD.lt(0) ? diffD.abs().toFixed(2) : '0',
    });
  }

  const tafqit = tafqitLine(formatArabicMoneyWords(dMoney(d.total).toNumber()));

  const sig = signaturesBlock({
    qrSvg: d.qrSvg ?? null,
    qrCaption: d.qrCaption ?? 'امسح للتحقق من مطابقة بيانات الفاتورة',
    items: [
      { kind: 'sig', label: 'استلام المخزن' },
      { kind: 'stamp' },
      { kind: 'sig', label: 'مسؤول المشتريات' },
    ],
  });

  const reduction = dMoney(d.returnedAmount).gt(0)
    ? `<p style="font-size:11px;color:${B.ink};margin:8px 0">تخفيض الذمة بعد الشراء: ${esc(fmtIQD(d.returnedAmount))}</p>` : '';
  const recognition = d.recognizedAmount != null && !dMoney(d.recognizedAmount).eq(dMoney(d.total))
    ? `<p style="font-size:11px;color:${B.ink};margin:8px 0">المفوتر بذمة المورد: ${esc(fmtIQD(d.recognizedAmount))}</p>` : '';
  return `${pageBodyOpen()}${header}${cards}${usdEquation}${table}${totals}${balanceStrip}${reduction}${recognition}${tafqit}${sig}${pageBodyClose()}${pageFooter(d.settings, { rightText: `REF ${d.invoiceNumber}` })}`;
}

export function buildPurchaseInvoiceV2Html(d: PurchaseInvoiceV2Data): string {
  return wrapA4Doc(`فاتورة مشتريات ${d.invoiceNumber}`, buildPurchaseInvoiceV2Body(d));
}

export function printPurchaseInvoiceV2(d: PurchaseInvoiceV2Data): boolean {
  return openPrintWindow(buildPurchaseInvoiceV2Html(d));
}

// ═════════════════════════════════════════════════════════════════════════════
// ٣. تقرير المبيعات — A4 (شريط ملخّص 4 خانات + جدول فواتير + إجمالي في التذييل)
// ═════════════════════════════════════════════════════════════════════════════

export interface SalesReportV2Data {
  /** الفترة كنصّ عربي: «01/06 — 01/07/2026». */
  periodLabel: string;
  printedByName?: string | null;
  printRequestedAt?: string | null;
  branchLabel?: string | null;

  invoiceCount: number;
  totalSum: string | number;
  paidSum: string | number;
  unpaidSum: string | number;

  rows: {
    invoiceNumber: string;
    date: string;
    customerName: string;
    branchName?: string;
    salespersonName?: string;
    shiftId?: number | null;
    paymentMethod?: string;
    subtotal?: string | number;
    discount?: string | number;
    tax?: string | number;
    total: string | number;
    paid: string | number;
    returned?: string | number;
    remaining: string | number;
    cost?: string | number;
    netRevenue?: string | number;
    netCOGS?: string | number;
    profit?: string | number;
    /** حالة كنصّ عربي: «مسدَّدة»، «جزئية»، «آجلة». */
    status: string;
    /** لون شارة الحالة (`#0D6B52`/`#92400E`/`#8A1F11`). */
    statusColor?: string;
    items?: {
      productName: string;
      unitName?: string | null;
      quantity: string | number;
      unitPrice: string | number;
      total: string | number;
    }[];
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
    { key: 'num', label: 'رقم الفاتورة', width: 130 },
    { key: 'total', label: 'الإجمالي', width: 110 },
    { key: 'returned', label: 'المرتجع', width: 110, color: B.alert },
    { key: 'paid', label: 'المدفوع', width: 110 },
    { key: 'remaining', label: 'المتبقّي', width: 110, color: B.alert },
    ...(d.rows.some((r) => r.cost !== undefined) ? [{ key: 'cost', label: 'التكلفة الأصلية (تاريخية)', width: 110 } satisfies DocTableCol] : []),
    ...(d.rows.some((r) => r.netRevenue !== undefined) ? [{ key: 'netRevenueAmount', label: 'صافي الإيراد', width: 110 } satisfies DocTableCol] : []),
    ...(d.rows.some((r) => r.netCOGS !== undefined) ? [{ key: 'netCOGSAmount', label: 'صافي تكلفة المبيعات', width: 110 } satisfies DocTableCol] : []),
    ...(d.rows.some((r) => r.profit !== undefined) ? [{ key: 'profitAmount', label: 'الربح', width: 110 } satisfies DocTableCol] : []),
  ];
  const rows = d.rows.map((r) => ({
    num: r.invoiceNumber,
    date: r.date,
    customer: r.customerName,
    branch: r.branchName ?? '—',
    salesperson: r.salespersonName ?? '—',
    shift: r.shiftId == null ? '—' : String(r.shiftId),
    payment: formatPaymentMethodPrintHtml(r.paymentMethod ?? '—', esc, { heightPx: 12 }),
    total: fmtIQD(r.total),
    returned: fmtIQD(r.returned ?? 0),
    paid: fmtIQD(r.paid),
    remaining: fmtIQD(r.remaining),
    cost: r.cost === undefined ? '' : fmtIQD(r.cost),
    netRevenueAmount: r.netRevenue === undefined ? '' : fmt(r.netRevenue),
    netCOGSAmount: r.netCOGS === undefined ? '' : fmt(r.netCOGS),
    profitAmount: r.profit === undefined ? '' : fmt(r.profit),
    status: r.status,
  }));

  // Keep full signed decimal(15,2) amounts readable at the existing 9.25px Cairo size.
  // Metadata occupies an immediately linked wrapping row instead of squeezing money.
  // Maximum width: 24 + 130 + 8×110 = 1034px inside the 1035px A4 landscape table.
  const headCell = (label: string, width: number) => `<th style="vertical-align:middle;padding:7px 8px;text-align:center;font-size:11.5px;font-weight:800;color:#fff;border:1.5px solid rgba(255,255,255,.5);letter-spacing:.2px;width:${width}px">${esc(label)}</th>`;
  const tableRows = d.rows.map((r, i) => {
    const bg = i % 2 === 0 ? '#fff' : B.zebra;
    const statusColor = r.statusColor ?? (r.status === 'مسدَّدة' ? B.green : r.status === 'جزئية' ? B.orange : B.alert);
    const cell = (value: string, numeric = false, color = '#000') => `<td style="vertical-align:middle;padding:6px;text-align:center;font-size:9.25px;color:${color};font-weight:${numeric ? 800 : 700};border:1.5px solid ${B.borderDk};${numeric ? 'direction:ltr;unicode-bidi:isolate;white-space:nowrap;font-variant-numeric:tabular-nums;' : 'overflow-wrap:anywhere;'}">${esc(value)}</td>`;
    const metadata = [
      ['التاريخ', esc(rows[i].date)], ['العميل', esc(rows[i].customer)],
      ['الفرع', esc(rows[i].branch)], ['الكاشير / البائع', esc(rows[i].salesperson)],
      ['الوردية', esc(rows[i].shift)], ['الدفع', rows[i].payment],
      ['الحالة', `<span style="color:${statusColor};font-weight:800">${esc(rows[i].status)}</span>`],
    ].map(([label, value]) => `<span style="max-width:100%;overflow-wrap:anywhere"><strong>${label}:</strong> ${value}</span>`).join('');
    const itemLines = r.items && r.items.length > 0
      ? `<div style="margin-top:4px;padding-top:4px;border-top:1px dashed ${B.border};display:flex;flex-wrap:wrap;gap:6px 14px;font-size:8.75px;color:${B.textFaint}">
          ${r.items.map((it) => `<span>• ${esc(it.productName)}${it.unitName ? ` (${esc(it.unitName)})` : ''}: ${esc(fmtQty(it.quantity))} × ${esc(fmtIQD(it.unitPrice))} = <strong style="color:${B.ink}">${esc(fmtIQD(it.total))}</strong></span>`).join('')}
        </div>`
      : '';
    return `<tbody style="background:${bg};break-inside:avoid">
      <tr data-sales-financial>${cell(String(i + 1))}${cols.map(c => cell(rows[i][c.key as keyof typeof rows[number]], c.key !== 'num', c.color)).join('')}</tr>
      <tr><td colspan="${cols.length + 1}" style="padding:6px 10px;border:1.5px solid ${B.borderDk};font-size:9.25px;font-weight:700;line-height:1.7;text-align:right"><div data-sales-metadata style="display:flex;flex-wrap:wrap;column-gap:16px;row-gap:4px">${metadata}</div>${itemLines}</td></tr>
    </tbody>`;
  }).join('');
  const table = `<div style="margin-top:13px;border:2px solid ${B.ink};border-radius:4px">
    <table style="width:100%;border-collapse:collapse;table-layout:fixed">
      <thead><tr style="background:${B.greenDark}">${headCell('م', 24)}${cols.map(c => headCell(c.label, c.width!)).join('')}</tr></thead>
      ${tableRows || '<tbody></tbody>'}
    </table>
  </div>`;

  const note = `<div style="margin-top:10px;font-size:9.75px;color:${B.textFaint}">مُولَّد آلياً من مركز التقارير · لا يتطلّب توقيعاً — للاستخدام الداخلي</div>`;

  const body = `${pageBodyOpen()}${header}${summary}${table}${note}${pageBodyClose()}${pageFooter(d.settings, { rightText: `تقرير المبيعات · ${d.invoiceCount} فاتورة` })}`;
  return openPrintWindow(wrapA4Doc('تقرير المبيعات', body, { orientation: 'landscape' }));
}

// ═════════════════════════════════════════════════════════════════════════════
// ٤. عرض سعر — A4
// ═════════════════════════════════════════════════════════════════════════════

export interface QuotationV2Data {
  quoteNumber: string;
  quoteDate?: string | Date | null;
  validUntil?: string | null;
  /** باركود رقم العرض للطباعة الرسمية (اختياري، إن غاب يُنشأ كرمز آلة QUO-XXXXX) */
  barcode?: DocHeaderBarcode | string | boolean | null;
  /** موضع الباركود: بجانب الرقم أو تحته (الافتراضي "beside") */
  barcodePlacement?: 'beside' | 'below';

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
    /** باركود المنتج (يُستبدل به عمود الضريبة عند عدم تفعيلها). */
    barcode?: string | null;
    /** SVG جاهز للباركود إن وُجد. */
    barcodeSvg?: string | null;
  }[];

  /** تحكم صريح بإظهار عمود الباركود بدل الضريبة (الافتراضي: true عندما لا توجد ضريبة على الفاتورة). */
  showBarcodeColumn?: boolean;

  subtotal: string | number;
  discountAmount?: string | number | null;
  taxAmount?: string | number | null;
  taxRate?: number | null;
  total: string | number;

  terms?: string | null;
  /** SVG جاهز من qr.ts — QR حقيقي قابل للمسح ببيانات العرض. لا placeholder زائف عند غيابه. */
  qrSvg?: string | null;
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
    barcode: resolveDocBarcode('QUO', d.quoteNumber, d.barcode, d.barcodePlacement),
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

  const hasTax =
    dMoney(d.taxAmount).gt(0) ||
    dMoney(d.taxRate).gt(0) ||
    d.items.some((it) => dMoney(it.taxAmount).gt(0));
  const showBarcode =
    d.showBarcodeColumn !== undefined ? d.showBarcodeColumn : !hasTax;

  const cols: DocTableCol[] = showBarcode
    ? [
        { key: 'name', label: 'المنتج' },
        { key: 'unit', label: 'الوحدة', width: 50 },
        { key: 'qty', label: 'الكمية', width: 48 },
        { key: 'price', label: 'السعر', width: 70 },
        { key: 'barcode', label: 'الباركود', width: 115, rawHtml: true },
        { key: 'total', label: 'الإجمالي', width: 84, emphasize: true },
      ]
    : [
        { key: 'name', label: 'المنتج' },
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
    barcode: renderItemBarcodeCell(it.barcode, it.barcodeSvg),
    tax: dMoney(it.taxAmount).gt(0) ? fmtIQD(it.taxAmount) : '—',
    total: fmtIQD(it.total),
  }));
  const table = docTableV2(cols, rows);

  const totals = totalsBox({
    lines: [
      { label: 'المجموع الفرعي', value: fmtIQD(d.subtotal) },
      ...(dMoney(d.discountAmount).gt(0) ? [{ label: 'الخصم', value: fmtIQD(d.discountAmount), color: B.orange, sign: '−' as const }] : []),
      ...(dMoney(d.taxAmount).gt(0) ? [{ label: taxLabel(d.taxAmount, d.taxRate, d.subtotal, d.discountAmount), value: fmtIQD(d.taxAmount), sign: '+' as const }] : []),
    ],
    grandTotal: { label: 'الإجمالي', value: fmtIQD(d.total) },
  });

  const termsText = d.terms ?? 'مدة صلاحية عروض الشركات وعروض الأسعار 5 أيام كحد أقصى من تاريخ الإصدار (ما لم يُنص على تاريخ أقصر أعلاه)، ولا تشمل ورق الاستنساخ أو الأصناف المتداولة يومياً ذات الأسعار المتغيّرة · يبدأ التنفيذ بعد اعتماد العرض وفق شروط الدفع المتفق عليها.';
  const termsBox = `<div style="margin-top:14px;padding:10px 14px;border:1px solid ${B.border};border-inline-start:3px solid ${B.ink};border-radius:4px;background:${B.bgWarm}">
    <div style="font-size:10.25px;font-weight:800;color:${B.ink};margin-bottom:4px">الشروط والأحكام</div>
    <div style="font-size:10.75px;color:#000;line-height:1.7">${esc(termsText)}</div>
  </div>`;

  const sigs = `<div style="margin-top:24px">${signaturesBlock({
    qrSvg: d.qrSvg ?? null,
    qrCaption: d.qrSvg ? 'امسح للتحقق من بيانات العرض' : null,
    items: [
      { kind: 'sig', label: 'توقيع العميل بالموافقة على العرض', width: 200 },
      { kind: 'sig', label: 'الممثل التجاري', width: 200 },
    ],
  })}</div>`;

  const body = `${pageBodyOpen()}${header}${cards}${table}${totals}${termsBox}${sigs}${pageBodyClose()}${pageFooter(d.settings, { rightText: `REF ${d.quoteNumber}` })}`;
  return openPrintWindow(wrapA4Doc(`عرض سعر ${d.quoteNumber}`, body));
}

// ═════════════════════════════════════════════════════════════════════════════
// ٥. طلب خدمة (Work Order) — A4
// ═════════════════════════════════════════════════════════════════════════════

export interface WorkOrderV2Data {
  woNumber: string;
  /** باركود رقم الطلب للطباعة الرسمية (اختياري، إن غاب يُنشأ كرمز آلة WO-XXXXX) */
  barcode?: DocHeaderBarcode | string | boolean | null;
  /** موضع الباركود: بجانب الرقم أو تحته (الافتراضي "beside") */
  barcodePlacement?: 'beside' | 'below';
  /** تاريخ إصدار الطلب (اليوم الذي استُلم فيه العمل). يظهر «تاريخ الإصدار» في الترويسة. */
  woDate?: string | Date | null;
  dueDate?: string | null;
  statusLabel?: string | null;
  statusColor?: string | null;

  customerName?: string | null;
  customerPhone?: string | null;
  employeeName?: string | null;

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
    barcode: resolveDocBarcode('WO', d.woNumber, d.barcode, d.barcodePlacement),
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
        ...(d.employeeName ? [{ label: 'الموظف', value: d.employeeName }] : []),
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
  scopeLabel?: string;
  companyCurrentBalance?: string | number;
  /** «customer» = رصيد ختامي مستحق «لنا»، «supplier» = مستحق «علينا». يُغيّر أسماء الحقول. */
  partyKind: 'customer' | 'supplier';
  partyName: string;
  partyPhone?: string | null;

  periodLabel: string;
  printedByName?: string | null;
  printRequestedAt?: string | null;
  openingBalance: string | number;
  currentBalance?: string | number | null;
  usdReference?: string | number | null;
  heldDepositsTotal?: string | number | null;
  transactionsCount: number;

  transactions: {
    date: string;
    ref: string;
    description: string;
    debit?: string | number | null;
    credit?: string | number | null;
    balanceBefore?: string | number | null;
    balance: string | number;
    /** نوع الحركة كنصّ عربي: «فاتورة»، «سند قبض»، «سند دفع»، … */
    typeLabel: string;
    /** لون شارة النوع في الصفّ التفصيلي (`#8A1F11` للفاتورة، `#0D6B52` للسند). */
    typeColor?: string | null;
    /** نص التفاصيل الإضافيّة أسفل قيم الصف — يشرح محتوى الفاتورة/السند. */
    details: string;
    actor?: string | null;
    items?: {
      productName: string;
      unitName?: string | null;
      quantity: string | number;
      unitPrice: string | number;
      total: string | number;
    }[];
  }[];

  totalDebit: string | number;
  totalCredit: string | number;
  closingBalance: string | number;

  settings?: CompanySettings;
}

export function buildStatementV2Html(d: StatementV2Data): string {
  const isCustomer = d.partyKind === 'customer';
  const header = pageHeader({
    title: 'كشف حساب',
    subtitle: 'بيان تفصيلي — يوضح محتوى كل فاتورة وسند مرتبط بالحركة',
    fields: [
      { label: 'الفترة', value: d.periodLabel },
      ...(d.scopeLabel ? [{ label: 'نطاق الكشف', value: d.scopeLabel }] : []),
      ...(d.printedByName ? [{ label: 'طالب الطباعة', value: d.printedByName }] : []),
      ...(d.printRequestedAt ? [{ label: 'وقت طلب الطباعة', value: d.printRequestedAt }] : []),
    ],
  }, d.settings);

  const usdD = dMoney(d.usdReference);
  const heldD = dMoney(d.heldDepositsTotal);
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
        { label: 'الرصيد السابق', value: fmtIQD(d.openingBalance) },
        ...(d.companyCurrentBalance != null ? [{ label: 'رصيد الشركة الحالي (كل الفروع)', value: fmtIQD(d.companyCurrentBalance) }] : []),
        ...(d.currentBalance != null ? [{ label: 'الرصيد الحالي', value: fmtIQD(d.currentBalance) }] : []),
        { label: 'عدد الحركات', value: String(d.transactionsCount) },
      ],
    },
  ]);

  const extraRefLines: string[] = [];
  if (!isCustomer && !usdD.isZero()) {
    extraRefLines.push(
      `مرجع الفواتير الدولارية (مشمول بالدينار المثبت): $${usdD.abs().toNumber().toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} — ${balanceDirectionLabel('SUPPLIER', usdD)}`,
    );
  }
  if (isCustomer && heldD.gt(0)) {
    extraRefLines.push(
      `عربون قيد الاحتجاز (غير مطبق على فاتورة): ${fmtIQD(heldD.toFixed(2))} د.ع`,
    );
  }
  const disclosureLine = extraRefLines.length > 0
    ? `<div style="margin-top:8px;padding:6px 10px;border:1px solid ${B.border};border-radius:4px;background:${B.bgWarm};font-size:10px;font-weight:700;color:${B.ink}">${esc(extraRefLines.join(' · '))}</div>`
    : '';

  // بناء الجدول يدوياً: كل حركة = صفّان (قيم + تفاصيل).
  const cols: DocTableCol[] = [
    { key: 'date', label: 'التاريخ', width: 66 },
    { key: 'ref', label: 'المرجع', width: 98 },
    { key: 'desc', label: 'البيان' },
    { key: 'debit', label: 'مدين', width: 72, color: B.alert },
    { key: 'credit', label: 'دائن', width: 72, color: B.green },
    { key: 'before', label: 'قبل', width: 76, color: B.textFaint },
    { key: 'balance', label: 'بعد', width: 80, color: B.ink },
  ];

  const th = (label: string, width?: number) =>
    `<th style="vertical-align:middle;padding:7px 6px;text-align:center;font-size:10.5px;font-weight:800;color:#fff;border:1.5px solid rgba(255,255,255,.5);letter-spacing:.2px;${width ? `width:${width}px;` : ''}">${esc(label)}</th>`;
  const head = `<tr style="background:${B.greenDark}">${cols.map((c) => th(c.label, c.width)).join('')}</tr>`;

  const cellStyle = (color = '#000', size = 11.25, opts: { money?: boolean; noBottom?: boolean } = {}) => {
    const money = opts.money ? 'direction:ltr;unicode-bidi:isolate;white-space:nowrap;font-variant-numeric:tabular-nums;' : '';
    const nb = opts.noBottom ? 'border-bottom:none;' : '';
    return `vertical-align:middle;padding:5px;text-align:center;font-size:${size}px;color:${color};font-weight:${opts.money ? '800' : '700'};border:1.5px solid ${B.borderDk};${nb}${money}`;
  };

  let runningPrev = dMoney(d.openingBalance);
  const bodyRows = d.transactions.map((t, i) => {
    const bg = i % 2 === 0 ? '#fff' : B.zebra;
    const debitD = dMoney(t.debit);
    const creditD = dMoney(t.credit);
    const debit = debitD.gt(0) ? fmtIQD(debitD.toFixed(2)) : '—';
    const credit = creditD.gt(0) ? fmtIQD(creditD.toFixed(2)) : '—';
    const debitColor = debitD.gt(0) ? B.alert : '#000';
    const creditColor = creditD.gt(0) ? B.green : '#000';
    const rowBeforeD = t.balanceBefore != null ? dMoney(t.balanceBefore) : runningPrev;
    const rowAfterD = dMoney(t.balance);
    runningPrev = rowAfterD;

    const valueRow = `<tr style="background:${bg}">
      <td style="${cellStyle('#000', 10.75, { money: true, noBottom: true })}">${esc(t.date)}</td>
      <td style="${cellStyle('#000', 10.75, { money: true, noBottom: true })}">${esc(t.ref)}</td>
      <td style="${cellStyle('#000', 10.75, { noBottom: true })}">${esc(t.description)}</td>
      <td style="${cellStyle(debitColor, 11, { money: true, noBottom: true })}">${esc(debit)}</td>
      <td style="${cellStyle(creditColor, 11, { money: true, noBottom: true })}">${esc(credit)}</td>
      <td style="${cellStyle(B.textFaint, 10.75, { money: true, noBottom: true })}">${esc(fmtIQD(rowBeforeD.toFixed(2)))}</td>
      <td style="${cellStyle(B.ink, 11.25, { money: true, noBottom: true })};font-weight:900">${esc(fmtIQD(rowAfterD.toFixed(2)))}</td>
    </tr>`;
    const itemText = t.items && t.items.length > 0
      ? ` · البنود: ${t.items.map((it) => `${it.productName}${it.unitName ? ` (${it.unitName})` : ''} × ${fmtQty(it.quantity)} = ${fmtIQD(it.total)}`).join(' | ')}`
      : '';
    const details = `${t.actor ? `${t.details} — المنفذ: ${t.actor}` : t.details}${itemText}`;
    const detailRow = docTableDetailRow(i, t.typeLabel, t.typeColor ?? B.alert, details, cols.length);
    return valueRow + detailRow;
  }).join('');

  const foot = `<tfoot><tr style="background:#F2F2EC">
    <td colspan="3" style="vertical-align:middle;padding:6px;text-align:center;font-size:10.75px;font-weight:800;color:${B.ink};border:1.5px solid ${B.borderDk};border-top:3px solid ${B.ink}">الإجمالي</td>
    <td style="vertical-align:middle;padding:6px;text-align:center;font-size:11px;font-weight:900;color:${B.alert};border:1.5px solid ${B.borderDk};border-top:3px solid ${B.ink};direction:ltr;unicode-bidi:isolate;white-space:nowrap;font-variant-numeric:tabular-nums">${esc(fmtIQD(d.totalDebit))}</td>
    <td style="vertical-align:middle;padding:6px;text-align:center;font-size:11px;font-weight:900;color:${B.green};border:1.5px solid ${B.borderDk};border-top:3px solid ${B.ink};direction:ltr;unicode-bidi:isolate;white-space:nowrap;font-variant-numeric:tabular-nums">${esc(fmtIQD(d.totalCredit))}</td>
    <td style="vertical-align:middle;padding:6px;text-align:center;font-size:10.5px;font-weight:800;color:${B.textFaint};border:1.5px solid ${B.borderDk};border-top:3px solid ${B.ink};direction:ltr;unicode-bidi:isolate;white-space:nowrap;font-variant-numeric:tabular-nums">${esc(fmtIQD(d.openingBalance))}</td>
    <td style="vertical-align:middle;padding:6px;text-align:center;font-size:11px;font-weight:900;color:${B.ink};border:1.5px solid ${B.borderDk};border-top:3px solid ${B.ink};direction:ltr;unicode-bidi:isolate;white-space:nowrap;font-variant-numeric:tabular-nums">${esc(fmtIQD(d.closingBalance))}</td>
  </tr></tfoot>`;

  const table = `<div style="margin-top:14px;border:2px solid ${B.ink};border-radius:4px;overflow:hidden">
    <table style="width:100%;border-collapse:collapse;table-layout:fixed">
      <thead>${head}</thead>
      <tbody>${bodyRows}</tbody>
      ${foot}
    </table>
  </div>`;

  const closingSigned = dMoney(d.closingBalance);
  const closingAbs = closingSigned.abs();
  const closingDir = isCustomer ? balanceDirCustomer(closingSigned) : balanceDirSupplier(closingSigned);
  const closingBar = `<div style="display:flex;justify-content:flex-end;margin-top:10px">
    <div style="width:290px">${grandTotalBar(`الرصيد الختامي المستحق (${closingDir})`, fmtIQD(closingAbs.toFixed(2))).replace('margin-top:16px;', 'margin-top:0;')}</div>
  </div>`;

  const sig = `<div style="display:flex;justify-content:flex-start;margin-top:24px">
    <div style="text-align:center;width:260px">
      <div style="height:28px"></div>
      <div style="border-top:1px solid ${B.ink};padding-top:5px;font-size:10.25px;color:#000;font-weight:600">توقيع ${isCustomer ? 'العميل' : 'المورّد'} إقراراً بمطابقة الرصيد أعلاه — التاريخ: ___________</div>
    </div>
  </div>`;

  const body = `${pageBodyOpen()}${header}${cards}${disclosureLine}${table}${closingBar}${sig}${pageBodyClose()}${pageFooter(d.settings, { rightText: `${isCustomer ? 'كشف حساب عميل' : 'كشف حساب مورد'} · ${d.transactionsCount} حركة` })}`;
  return wrapA4Doc(`كشف حساب — ${d.partyName}`, body);
}

export function printStatementV2(d: StatementV2Data): boolean {
  return openPrintWindow(buildStatementV2Html(d));
}

// ═════════════════════════════════════════════════════════════════════════════
// ٧+٨. سند قبض / سند دفع — A4 (نفس القالب، اتّجاه معكوس)
// ═════════════════════════════════════════════════════════════════════════════

export interface VoucherV2Data {
  /** «IN» = سند قبض، «OUT» = سند دفع/صرف. */
  direction: 'IN' | 'OUT';
  /** نوع الطرف الحقيقي (لئلا يُعكس «له علينا/لنا عليه» عند RV المورد أو PV العميل). */
  partyType?: 'SUPPLIER' | 'CUSTOMER' | 'DELIVERY_PARTY' | 'OTHER' | null;
  voucherNumber: string;
  voucherDate?: string | Date | null;

  /** «معتمد» أو «بانتظار الاعتماد» أو «مرفوض». */
  statusLabel?: string | null;
  statusColor?: string | null;

  partyName: string;
  partyTypeLabel: string;
  partyBalanceBefore?: string | number | null;
  partyBalanceAfter?: string | number | null;

  paymentMethodLabel: string;
  referenceNumber?: string | null;
  cashSourceLabel?: string | null;
  branchName?: string | null;
  categoryName?: string | null;
  relatedInvoiceNumber?: string | null;
  counterpartyName?: string | null;
  createdByName?: string | null;
  approvedByName?: string | null;
  printedByName?: string | null;
  printRequestedAt?: string | null;

  description: string;

  /** المبلغ الرقمي بـDecimal. */
  amount: string | number;

  qrSvg?: string | null;
  qrCaption?: string | null;
  signatureShortHash?: string | null;
  attachmentImageUrl?: string | null;
  barcode?: DocHeaderBarcode | string | boolean | null;
  barcodePlacement?: 'beside' | 'below';

  settings?: CompanySettings;
}

function resolveVoucherPartyKind(d: VoucherV2Data): LedgerPartyKind | null {
  if (d.partyType === 'SUPPLIER') return 'SUPPLIER';
  if (d.partyType === 'CUSTOMER') return 'CUSTOMER';
  if (d.partyType === 'DELIVERY_PARTY' || d.partyType === 'OTHER') return null;
  const lbl = d.partyTypeLabel ?? '';
  if (lbl.includes('مورد') || lbl.includes('مورّد')) return 'SUPPLIER';
  if (lbl.includes('عميل') || lbl.includes('زبون')) return 'CUSTOMER';
  return d.direction === 'IN' ? 'CUSTOMER' : 'SUPPLIER';
}

export function buildVoucherV2Body(d: VoucherV2Data): string {
  const isReceipt = d.direction === 'IN';
  const title = isReceipt ? 'سند قبض' : 'سند دفع';
  const ledgerParty = resolveVoucherPartyKind(d);
  const amtD = dMoney(d.amount);

  const hasBefore = d.partyBalanceBefore != null && d.partyBalanceBefore !== '';
  const hasAfter = d.partyBalanceAfter != null && d.partyBalanceAfter !== '';
  const balBeforeD = hasBefore ? dMoney(d.partyBalanceBefore) : null;
  const derivedAfterD = balBeforeD != null && ledgerParty != null
    ? (ledgerParty === 'SUPPLIER'
        ? (isReceipt ? balBeforeD.plus(amtD) : balBeforeD.minus(amtD))
        : (isReceipt ? balBeforeD.minus(amtD) : balBeforeD.plus(amtD)))
    : null;
  const balAfterD = hasAfter ? dMoney(d.partyBalanceAfter) : derivedAfterD;

  const balBeforeText = balBeforeD != null
    ? `${d.partyTypeLabel} — رصيد قبل السند: ${fmtIQD(balBeforeD.abs().toFixed(2))} (${ledgerParty === 'CUSTOMER' ? balanceDirCustomer(balBeforeD) : balanceDirSupplier(balBeforeD)})`
    : d.partyTypeLabel;

  const cleanStatus = (d.statusLabel ?? 'معتمد').replace(/[✓✗⏳]/g, '').trim() || 'معتمد';
  const badge = { label: cleanStatus, color: d.statusColor ?? B.green };

  const header = pageHeader({
    title,
    fields: [
      { label: 'رقم السند', value: d.voucherNumber },
      { label: 'التاريخ', value: fmtDate(d.voucherDate) },
      ...(d.branchName ? [{ label: 'الفرع', value: d.branchName }] : []),
    ],
    badge,
    barcode: resolveDocBarcode('VCH', d.voucherNumber, d.barcode, d.barcodePlacement),
  }, d.settings);

  const partyFields = [
    ...(d.counterpartyName && d.counterpartyName !== d.partyName ? [{ label: 'المستفيد / المستلم', value: d.counterpartyName }] : []),
    ...(d.categoryName ? [{ label: 'الفئة', value: d.categoryName }] : []),
    ...(d.relatedInvoiceNumber ? [{ label: 'الفاتورة المرتبطة', value: d.relatedInvoiceNumber }] : []),
  ];

  const cards = infoCards([
    {
      title: 'الطرف المُقابل',
      variant: 'green',
      ...(partyFields.length === 0
        ? { fields: [], bigLine: { primary: d.partyName, secondary: balBeforeText } }
        : {
            fields: [
              { label: 'الاسم', value: d.partyName },
              { label: 'التصنيف', value: balBeforeText },
              ...partyFields,
            ],
          }),
    },
    {
      title: 'تفاصيل الدفع والاعتماد',
      variant: 'gray',
      fields: [
        { label: 'الطريقة', value: d.paymentMethodLabel },
        ...(d.cashSourceLabel ? [{ label: 'مصدر النقد', value: d.cashSourceLabel }] : []),
        ...(d.referenceNumber ? [{ label: 'الرقم المرجعي', value: d.referenceNumber }] : []),
        ...(d.createdByName ? [{ label: 'المنشئ', value: d.createdByName }] : []),
        ...(d.approvedByName ? [{ label: 'المعتمد', value: d.approvedByName }] : []),
        ...(d.printedByName ? [{ label: 'الطابع', value: d.printedByName }] : []),
        ...(d.printRequestedAt ? [{ label: 'وقت الطباعة', value: d.printRequestedAt }] : []),
      ],
    },
  ]);

  const balanceStrip = ledgerParty != null && balBeforeD != null
    ? balanceSnapshotPrintHtml({
        partyType: ledgerParty,
        before: balBeforeD.toFixed(2),
        after: balAfterD ? balAfterD.toFixed(2) : undefined,
        credit: isReceipt ? amtD.toFixed(2) : '0',
        debit: isReceipt ? '0' : amtD.toFixed(2),
      })
    : '';

  const descBox = `<div style="margin-top:12px;padding:10px 14px;background:${B.bgWarm};border:1px solid ${B.border};border-radius:4px">
    <div style="font-size:10.25px;font-weight:800;color:#000;margin-bottom:4px">الوصف / الغرض</div>
    <div style="font-size:12.25px;color:#000;line-height:1.6">${esc(d.description)}</div>
  </div>`;

  const amountBar = grandTotalBar(isReceipt ? 'المبلغ المُستلَم' : 'المبلغ المدفوع', fmtIQD(amtD.toFixed(2)), { big: true });

  const wholeD = amtD.abs().floor();
  const fracFils = amtD.abs().minus(wholeD).times(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  const wordsText = fracFils.isZero()
    ? formatArabicMoneyWords(wholeD.toFixed(0))
    : `${formatArabicMoneyWords(wholeD.toFixed(0)).replace(/ لا غير$/, '')} و${fracFils.toFixed(0)}/100 لا غير`;
  const tafqit = tafqitLine(wordsText);

  const sig = signaturesBlock({
    qrSvg: d.qrSvg ?? null,
    qrCaption: 'للتحقق من صحة السند',
    qrSize: 52,
    spaceHeight: 28,
    labelSize: 9.75,
    items: [
      { kind: 'sig', label: d.createdByName ? `المنشئ (${d.createdByName})` : 'المُنشئ / المحاسب', width: 115 },
      { kind: 'sig', label: d.approvedByName ? `المعتمد (${d.approvedByName})` : 'المُعتمِد', width: 115 },
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

  const customFooter = `<div class="page-footer">
    <div style="height:1px;background:${B.border};margin-bottom:10px"></div>
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
      <div style="font-size:10.25px;color:#000;font-weight:600">${esc(footerLeft)}</div>
      <div style="font-size:9.25px;color:${B.textFaint};font-family:ui-monospace,monospace;direction:ltr;unicode-bidi:isolate;white-space:nowrap">${esc(footerRef)}</div>
    </div>
  </div>`;

  return `${pageBodyOpen()}${header}${cards}${balanceStrip}${descBox}${amountBar}${tafqit}${sig}${attachmentBlock}${pageBodyClose()}${customFooter}`;
}

export function buildVoucherV2Html(d: VoucherV2Data): string {
  const title = d.direction === 'IN' ? 'سند قبض' : 'سند دفع';
  return wrapA4Doc(`${title} ${d.voucherNumber}`, buildVoucherV2Body(d));
}

export function printVoucherV2(d: VoucherV2Data): boolean {
  return openPrintWindow(buildVoucherV2Html(d));
}

// ═════════════════════════════════════════════════════════════════════════════
// ١١. سند تجهيز مخزني — A4 (بدون أسعار/مبالغ)
// ═════════════════════════════════════════════════════════════════════════════

export interface WarehouseSlipV2Data {
  invoiceNumber: string;
  invoiceDate?: string | Date | null;

  customerName?: string | null;
  customerPhone?: string | null;

  salesRep?: string | null;
  branchName?: string | null;

  items: {
    productName: string;
    unitName?: string | null;
    quantity: string | number;
  }[];

  notes?: string | null;
  /** باركود مرجع الفاتورة للطباعة الرسمية (اختياري). إما كائن DocHeaderBarcode أو نص القيمة أو true/false */
  barcode?: DocHeaderBarcode | string | boolean | null;
  /** موضع الباركود: بجانب الرقم أو تحته (الافتراضي "beside") */
  barcodePlacement?: 'beside' | 'below';
  settings?: CompanySettings;
}

export function printWarehouseSlipV2(d: WarehouseSlipV2Data): boolean {
  const date = fmtDate(d.invoiceDate);

  const header = pageHeader({
    title: 'سند تجهيز مخزني',
    fields: [
      { label: 'مرجع الفاتورة', value: d.invoiceNumber },
      { label: 'التاريخ', value: date },
    ],
    barcode: resolveDocBarcode('INV', d.invoiceNumber, d.barcode, d.barcodePlacement),
  }, d.settings);

  const cards = infoCards([
    {
      title: 'معلومات التسليم',
      variant: 'green',
      fields: [
        { label: 'العميل', value: d.customerName ?? 'عميل نقدي' },
        ...(d.customerPhone ? [{ label: 'الهاتف', value: d.customerPhone }] : []),
      ],
    },
    {
      title: 'بيانات التجهيز',
      variant: 'gray',
      fields: [
        ...(d.salesRep ? [{ label: 'البائع', value: d.salesRep }] : []),
        ...(d.branchName ? [{ label: 'الفرع', value: d.branchName }] : []),
      ],
    },
  ]);

  const cols: DocTableCol[] = [
    { key: 'seq', label: '#', width: 36 },
    { key: 'name', label: 'المنتج' },
    { key: 'unit', label: 'الوحدة', width: 70 },
    { key: 'qty', label: 'الكمية', width: 60, emphasize: true },
    { key: 'check', label: 'تم', width: 40 },
  ];
  const rows = d.items.map((it, i) => ({
    seq: String(i + 1),
    name: it.productName,
    unit: it.unitName ?? '',
    qty: fmtQty(it.quantity),
    check: '□',
  }));
  const table = docTableV2(cols, rows);

  const notesBlock = d.notes
    ? `<div style="margin:12px 0;padding:8px 12px;border:1px solid ${B.border};border-radius:6px;font-size:11px;color:${B.text}">
        <b>ملاحظات:</b> ${esc(d.notes)}
      </div>`
    : '';

  const sig = signaturesBlock({
    items: [
      { kind: 'sig', label: 'المُجهِّز (المخزن)' },
      { kind: 'sig', label: 'المُستلِم' },
    ],
  });

  const body = `${pageBodyOpen()}${header}${cards}${table}${notesBlock}${sig}${pageBodyClose()}${pageFooter(d.settings, { rightText: `REF ${d.invoiceNumber}` })}`;
  return openPrintWindow(wrapA4Doc(`سند تجهيز ${d.invoiceNumber}`, body));
}
