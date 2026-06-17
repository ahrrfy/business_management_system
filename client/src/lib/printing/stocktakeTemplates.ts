/**
 * قوالب طباعة الجرد والتسوية — بنمط printQuotation (انظر printTemplates.ts)
 * ١. printStocktakeReport — «محضر جرد وتسوية» A4 (ترويسة + بيانات الجلسة + ملخص + فروقات مُسوّاة
 *    + تحليل انكماش حسب السبب + قيد محاسبي + مؤشر IRA + ثلاث خانات توقيع).
 * ٢. printCountSheets — «قوائم عدّ ورقية» صفحة لكل عامل (page-break)، عمياء تماماً: بلا أرصدة دفترية.
 * كل القيم المالية تصل مُحتسبة سلفاً (decimal.js في الشاشات) — القالب يعرض فقط ولا يجري حساباً مالياً.
 */
import { BRAND as B, esc, fmt, fmtC, openPrintWindow, CAIRO_FONT } from './brand';
import { wrapA4Doc, docHeader, docMeta, docTable, docFooter } from './docHtml';
import { code128Svg } from './barcode';

// ─── تسميات مشتركة (تُستورد أيضاً في شاشات الجرد) ────────────────────────────

export const STOCKTAKE_REASON_LABEL: Record<string, string> = {
  UNSPECIFIED: 'غير محدد',
  DAMAGE: 'تلف / كسر',
  LOSS_THEFT: 'فقدان / سرقة',
  ENTRY_ERROR: 'خطأ إدخال',
  PRINT_WASTE: 'هدر تشغيل مطبعة',
};

export const STOCKTAKE_SCOPE_LABEL: Record<string, string> = {
  FULL: 'جرد شامل للفرع',
  MOVING: 'المنتجات المتحركة',
  CATEGORY: 'حسب الفئة',
  MANUAL: 'منتجات مختارة',
};

export const STOCKTAKE_STATUS_LABEL: Record<string, string> = {
  COUNTING: 'قيد العدّ',
  REVIEW: 'قيد المراجعة',
  APPROVED: 'معتمدة ومُسوّاة',
  CANCELLED: 'ملغاة',
};

// ─── أدوات تنسيق محلية (عرض فقط) ─────────────────────────────────────────────

const dOnly = (v?: string | Date | null): string =>
  v ? new Date(v).toLocaleDateString('ar-IQ-u-nu-latn', { dateStyle: 'medium' }) : '—';

const dts = (v?: string | Date | null): string =>
  v ? new Date(v).toLocaleString('ar-IQ-u-nu-latn', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

/** كمية صحيحة مُشارة (+/−) — للعرض فقط. */
const signedInt = (n: number): string =>
  n > 0 ? `+${fmt(n)}` : n < 0 ? `−${fmt(Math.abs(n))}` : '0';

/** مبلغ مُشار (+/−) — قيمة decimal نصية محسوبة سلفاً؛ التحويل هنا للعرض فقط. */
const signedMoney = (v: string | number | null | undefined): string => {
  const n = Number(v ?? 0);
  const s = `${fmt(Math.abs(n))} د.ع`;
  return n < 0 ? `−${s}` : n > 0 ? `+${s}` : s;
};

/** عنوان قسم داخل الوثيقة. */
const secTitle = (t: string): string =>
  `<div style="font-size:10.5px;font-weight:800;color:${B.greenDark};margin:4mm 0 2mm;display:flex;align-items:center;gap:2mm;">
    <span style="width:3px;height:11px;border-radius:2px;background:${B.green};display:inline-block;"></span>${esc(t)}</div>`;

// ═══════════════════════════════════════════════════════════════════════════════
// ١. محضر جرد وتسوية — A4
// ═══════════════════════════════════════════════════════════════════════════════

export interface StocktakeAdjustedRow {
  productName: string;
  variantName?: string | null;
  sku?: string | null;
  baseUnit?: string | null;
  /** الرصيد الدفتري لحظة الاحتساب (bookNow). */
  bookQty: number;
  /** المعدود المصحَّح بالحركات اللاحقة (adjustedCount / finalQty). */
  adjustedQty: number;
  /** الفرق المُشار: المعدود المصحَّح − الدفتري. */
  diff: number;
  /** قيمة الفرق بالتكلفة (decimal نصي مُشار). */
  value: string | number | null;
  /** تسمية السبب بالعربية (من STOCKTAKE_REASON_LABEL). */
  reasonLabel: string;
  /** «تسوية تلقائية ضمن الحدّ» أو «تسوية بقرار: فلان — ملاحظة». */
  decisionLabel: string;
}

export interface StocktakeKeptRow {
  productName: string;
  variantName?: string | null;
  diff: number;
  decisionLabel: string;
}

export interface StocktakeReasonRow {
  reasonLabel: string;
  itemCount: number;
  netQty: number;
  /** صافي القيمة (decimal نصي مُشار، محسوب سلفاً). */
  netValue: string | number;
}

export interface StocktakeReportPrintData {
  code: string;
  name: string;
  branchName: string;
  scopeLabel: string;
  blind: boolean;
  thresholdPct: string | number;
  thresholdValue: string | number;
  dualThreshold?: string | number | null;
  createdByName?: string | null;
  createdAt?: string | Date | null;
  submittedAt?: string | Date | null;
  firstSignByName?: string | null;
  firstSignAt?: string | Date | null;
  approvedByName?: string | null;
  approvedAt?: string | Date | null;
  /** أسماء عمّال الجرد (التكليفات). */
  workerNames: string[];
  stats: {
    counted: number;
    matched: number;
    over: number;
    short: number;
    /** صافي قيمة التسوية (decimal نصي، محسوب سلفاً). */
    netValue: string | number;
  };
  adjusted: StocktakeAdjustedRow[];
  /** صافي كمية الفروقات المُسوّاة (Σ diff). */
  adjustedNetQty: number;
  /** صافي قيمة الفروقات المُسوّاة (decimal نصي، محسوب سلفاً). */
  adjustedNetValue: string | number;
  kept: StocktakeKeptRow[];
  /** أسماء المنتجات المطابقة (diff = 0). */
  matchedNames: string[];
  byReason: StocktakeReasonRow[];
  ledger: {
    /** Σ |قيم العجز المُسوّى| (موجب). */
    shortExpense: string | number;
    /** Σ قيم الزيادة المُسوّاة (موجب). */
    overGain: string | number;
  };
  ira: {
    /** نسبة دقة المخزون للجلسة (مطابقة/معدودة ×100) — نص جاهز للعرض أو null. */
    pct: string | number | null;
    matched: number;
    counted: number;
  };
}

export function printStocktakeReport(d: StocktakeReportPrintData): void {
  // ── بيانات الجلسة (docMeta) ──
  const sessionFields = [
    { label: 'الجلسة', value: d.name },
    { label: 'الفرع', value: d.branchName },
    { label: 'النطاق', value: d.scopeLabel },
    { label: 'طريقة العدّ', value: d.blind ? 'جرد أعمى' : 'عدّ مكشوف' },
    { label: 'عمّال الجرد', value: d.workerNames.length ? d.workerNames.join('، ') : '—' },
  ];
  const datesFields = [
    { label: 'أنشأها', value: `${d.createdByName ?? '—'} · ${dOnly(d.createdAt)}` },
    { label: 'تسليم العدّ', value: dts(d.submittedAt) },
    {
      label: 'التوقيع الأول',
      value: d.firstSignByName ? `${d.firstSignByName} · ${dts(d.firstSignAt)}` : '—',
    },
    {
      label: 'الاعتماد النهائي',
      value: d.approvedByName ? `${d.approvedByName} · ${dts(d.approvedAt)}` : '—',
    },
    { label: 'حدّ التسوية المباشرة', value: `${fmt(d.thresholdPct)}٪ أو ${fmtC(d.thresholdValue)}` },
    {
      label: 'حدّ التوقيع المزدوج',
      value: d.dualThreshold != null && d.dualThreshold !== '' ? fmtC(d.dualThreshold) : '—',
    },
  ];

  // ── ملخص الإحصاءات ──
  const statCard = (label: string, value: string, color = B.greenDark): string =>
    `<div style="flex:1;background:${B.bg};border:1px solid ${B.border};border-radius:4px;padding:2.5mm;text-align:center;">
      <div style="font-size:8px;color:${B.textMuted};margin-bottom:1mm;">${esc(label)}</div>
      <div style="font-size:12px;font-weight:800;color:${color};" dir="ltr">${esc(value)}</div>
    </div>`;
  const statsRow = `<div style="display:flex;gap:2mm;margin-bottom:4mm;">
    ${statCard('منتجات معدودة', fmt(d.stats.counted))}
    ${statCard('مطابقة', fmt(d.stats.matched), B.green)}
    ${statCard('زيادة', fmt(d.stats.over), '#3B82F6')}
    ${statCard('نقص', fmt(d.stats.short), '#DC2626')}
    ${statCard('صافي قيمة التسوية', signedMoney(d.stats.netValue))}
  </div>`;

  // ── أولاً: جدول الفروقات المُسوّاة ──
  const adjCols = [
    { key: 'name', label: 'المنتج' },
    { key: 'book', label: 'الدفتري', width: '14mm', align: 'center' as const },
    { key: 'counted', label: 'المعدود المصحَّح', width: '18mm', align: 'center' as const },
    { key: 'diff', label: 'الفرق ±', width: '13mm', align: 'center' as const, bold: true },
    { key: 'value', label: 'قيمة الفرق', width: '21mm', align: 'left' as const },
    { key: 'reason', label: 'السبب', width: '20mm' },
    { key: 'decision', label: 'القرار', width: '34mm' },
  ];
  const adjRows = d.adjusted.map((r) => ({
    name: `${r.productName}${r.variantName ? ` — ${r.variantName}` : ''}${r.baseUnit ? ` (${r.baseUnit})` : ''}${r.sku ? ` · ${r.sku}` : ''}`,
    book: fmt(r.bookQty),
    counted: fmt(r.adjustedQty),
    diff: signedInt(r.diff),
    value: signedMoney(r.value),
    reason: r.reasonLabel,
    decision: r.decisionLabel,
  }));
  const adjTotalsStrip = d.adjusted.length
    ? `<div style="display:flex;justify-content:space-between;align-items:center;background:${B.green};color:#fff;
        border-radius:0 0 4px 4px;padding:2.5mm 3mm;font-size:10px;font-weight:700;margin-top:-4mm;margin-bottom:4mm;">
        <span>صافي قيمة التسوية (بالتكلفة)</span>
        <span><span style="opacity:.85;font-size:9px;">الكمية: <span dir="ltr">${esc(signedInt(d.adjustedNetQty))}</span></span>
          &nbsp;·&nbsp; <span dir="ltr" style="font-size:11px;">${esc(signedMoney(d.adjustedNetValue))}</span></span>
      </div>`
    : '';
  const adjustedSection = d.adjusted.length
    ? docTable(adjCols, adjRows) + adjTotalsStrip
    : `<p style="background:${B.bg};border:1px dashed ${B.border};border-radius:4px;padding:3mm;
        margin-bottom:4mm;font-size:9.5px;color:${B.textMuted};text-align:center;">لا تسويات — الجرد مطابق.</p>`;

  // ── ثانياً: فروقات أُبقي رصيدها الدفتري ──
  const keptSection = d.kept.length
    ? secTitle(`ثانياً — فروقات أُبقي رصيدها الدفتري (${fmt(d.kept.length)})`) +
      docTable(
        [
          { key: 'name', label: 'المنتج' },
          { key: 'diff', label: 'الفرق ±', width: '16mm', align: 'center' as const, bold: true },
          { key: 'decision', label: 'القرار', width: '70mm' },
        ],
        d.kept.map((r) => ({
          name: `${r.productName}${r.variantName ? ` — ${r.variantName}` : ''}`,
          diff: signedInt(r.diff),
          decision: r.decisionLabel,
        })),
      )
    : '';

  // ── ثالثاً: المنتجات المطابقة ──
  const matchedSection =
    secTitle(`${d.kept.length ? 'ثالثاً' : 'ثانياً'} — المنتجات المطابقة (${fmt(d.stats.matched)})`) +
    `<p style="font-size:8.5px;line-height:1.9;color:${B.textMuted};margin-bottom:4mm;">
      ${esc(d.matchedNames.length ? d.matchedNames.join(' · ') : '—')}
    </p>`;

  // ── تحليل الانكماش حسب السبب ──
  const reasonSection = d.byReason.length
    ? secTitle('تحليل الفروقات حسب السبب (الانكماش)') +
      docTable(
        [
          { key: 'reason', label: 'السبب' },
          { key: 'items', label: 'منتجات', width: '16mm', align: 'center' as const },
          { key: 'qty', label: 'صافي الكمية', width: '22mm', align: 'center' as const },
          { key: 'value', label: 'صافي القيمة', width: '28mm', align: 'left' as const, bold: true },
        ],
        d.byReason.map((r) => ({
          reason: r.reasonLabel,
          items: fmt(r.itemCount),
          qty: signedInt(r.netQty),
          value: signedMoney(r.netValue),
        })),
        false,
      )
    : '';

  // ── القيد المحاسبي + مؤشر IRA ──
  const hasLedger = Number(d.ledger.shortExpense ?? 0) > 0 || Number(d.ledger.overGain ?? 0) > 0;
  const ledgerBox = `<div style="flex:1.4;background:${B.bg};border:1px solid ${B.border};border-radius:4px;padding:3mm;">
    <div style="font-size:9.5px;font-weight:800;margin-bottom:2mm;">القيد المحاسبي الآلي
      (مرجع <span dir="ltr" style="font-family:monospace;">${esc(d.code)}</span>)</div>
    ${hasLedger
      ? `${Number(d.ledger.shortExpense ?? 0) > 0
          ? `<div style="display:flex;justify-content:space-between;font-size:9.5px;margin-bottom:1mm;">
              <span>مصروف عجز مخزون (مدين)</span>
              <span dir="ltr" style="font-family:monospace;font-weight:800;color:#DC2626;">${esc(fmtC(d.ledger.shortExpense))}</span>
            </div>`
          : ''}
        ${Number(d.ledger.overGain ?? 0) > 0
          ? `<div style="display:flex;justify-content:space-between;font-size:9.5px;margin-bottom:1mm;">
              <span>تسوية زيادة مخزون (دائن)</span>
              <span dir="ltr" style="font-family:monospace;font-weight:800;color:${B.green};">${esc(fmtC(d.ledger.overGain))}</span>
            </div>`
          : ''}`
      : `<div style="font-size:9px;color:${B.textMuted};">لا قيد محاسبياً — لا فروقات مُسوّاة بقيمة.</div>`}
    <div style="font-size:7.5px;color:${B.textMuted};margin-top:1.5mm;">
      العجز يظهر مصروفاً صريحاً في الدفتر — لا يُدفن في التسوية، فتبقى الأرباح صادقة.</div>
  </div>`;
  const iraBox = `<div style="flex:1;background:${B.greenMist};border:1px solid ${B.greenLight};border-radius:4px;padding:3mm;text-align:center;">
    <div style="font-size:8.5px;color:${B.textMuted};margin-bottom:1mm;">مؤشر دقة المخزون (IRA) لهذه الجلسة</div>
    <div style="font-size:16px;font-weight:900;color:${B.greenDark};" dir="ltr">${d.ira.pct != null ? esc(`${fmt(d.ira.pct)}٪`) : '—'}</div>
    <div style="font-size:8px;color:${B.textMuted};margin-top:0.5mm;">مطابقة ${esc(fmt(d.ira.matched))} من ${esc(fmt(d.ira.counted))} معدودة</div>
  </div>`;
  const ledgerIraRow = `<div style="display:flex;gap:3mm;margin-bottom:4mm;">${ledgerBox}${iraBox}</div>`;

  // ── ملاحظة التنفيذ ──
  const footnote = `<p style="background:${B.bg};border:1px solid ${B.border};border-radius:4px;padding:3mm;
    margin-bottom:5mm;font-size:8.5px;line-height:1.8;color:${B.textMuted};">
    نُفّذت التسوية بحركات ADJUST ذرّية بمرجع <span dir="ltr" style="font-family:monospace;">${esc(d.code)}</span>
    في سجلّ حركات المخزون، وحُدِّثت الأرصدة لحظة الاعتماد.
    الحدّ المعتمد للتسوية المباشرة: ${esc(fmt(d.thresholdPct))}٪ أو ${esc(fmtC(d.thresholdValue))}.
    الحركات الواقعة بعد عدّ أي منتج صُحِّحت آلياً قبل احتساب الفرق.
  </p>`;

  // ── ثلاث خانات توقيع ──
  const sigBox = (title: string, who: string, when?: string): string => `<div style="text-align:center;">
    <div style="font-size:9.5px;font-weight:800;">${esc(title)}</div>
    <div style="font-size:8.5px;color:${B.textMuted};margin-top:1mm;">${esc(who)}</div>
    ${when ? `<div style="font-size:7.5px;color:${B.textFaint};margin-top:0.5mm;">${esc(when)}</div>` : ''}
    <div style="margin-top:9mm;border-top:1px solid #000;padding-top:1mm;font-size:8px;color:${B.textMuted};">التوقيع</div>
  </div>`;
  const signatures = `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8mm;margin-bottom:6mm;">
    ${sigBox('عدّ وأعدّ', d.workerNames.length ? d.workerNames.join('، ') : '—', dts(d.submittedAt))}
    ${sigBox('توقيع أول (راجع ودقّق)', d.firstSignByName ?? d.approvedByName ?? '—', d.firstSignByName ? dts(d.firstSignAt) : d.approvedByName ? dts(d.approvedAt) : undefined)}
    ${sigBox('توقيع نهائي (اعتمد)', d.approvedByName ?? '—', d.approvedByName ? dts(d.approvedAt) : undefined)}
  </div>`;

  const body = [
    docHeader('محضر جرد وتسوية', d.code, dOnly(d.approvedAt ?? d.createdAt), [
      { label: 'الفرع', value: d.branchName },
    ]),
    docMeta([
      { title: 'بيانات الجلسة', fields: sessionFields },
      { title: 'التواريخ والحدود', fields: datesFields },
    ]),
    statsRow,
    secTitle(`أولاً — الفروقات المُسوّاة (${fmt(d.adjusted.length)})`),
    adjustedSection,
    keptSection,
    matchedSection,
    reasonSection,
    ledgerIraRow,
    footnote,
    signatures,
    docFooter(),
  ].join('');

  openPrintWindow(wrapA4Doc(`محضر جرد ${d.code}`, body));
}

// ═══════════════════════════════════════════════════════════════════════════════
// ٢. قوائم العدّ الورقية — صفحة لكل عامل (أعمى: بلا أرصدة دفترية)
// ═══════════════════════════════════════════════════════════════════════════════

export interface CountSheetItem {
  productName: string;
  variantName?: string | null;
  sku?: string | null;
  barcode?: string | null;
  baseUnit?: string | null;
}

export interface CountSheetsPrintData {
  code: string;
  name?: string | null;
  branchName: string;
  /** تاريخ الجلسة (الإنشاء). */
  date?: string | Date | null;
  sheets: {
    workerName: string;
    zone?: string | null;
    items: CountSheetItem[];
  }[];
}

export function printCountSheets(d: CountSheetsPrintData): void {
  const dateStr = dOnly(d.date ?? new Date());
  const total = d.sheets.length;

  const th = `padding:1.5mm 2mm;font-size:8.5px;font-weight:800;text-align:right;
    border-top:2px solid #000;border-bottom:2px solid #000;white-space:nowrap;`;
  const td = `padding:2mm;font-size:9px;border-bottom:1px solid #ddd;vertical-align:middle;text-align:right;`;
  const emptyBox = `<div style="height:7mm;border:1px solid #999;border-radius:1.5mm;"></div>`;
  const noteLine = `<div style="height:7mm;border-bottom:1px dashed #aaa;"></div>`;

  const pages = d.sheets.map((sh, ai) => {
    const rows = sh.items.map((it, i) => {
      let barCell = '—';
      if (it.barcode) {
        try {
          barCell = code128Svg(it.barcode, { moduleWidth: 0.9, height: 24, quietZone: 4, showText: true }).svg;
        } catch {
          barCell = `<span style="font-family:monospace;font-size:8px;" dir="ltr">${esc(it.barcode)}</span>`;
        }
      }
      return `<tr>
        <td style="${td}text-align:center;color:#555;font-size:8px;width:7mm;">${fmt(i + 1)}</td>
        <td style="${td}font-weight:700;">${esc(it.productName)}</td>
        <td style="${td}color:#333;width:22mm;">${esc(it.variantName ?? '—')}</td>
        <td style="${td}width:20mm;"><span style="font-family:monospace;font-size:8px;" dir="ltr">${esc(it.sku ?? '—')}</span></td>
        <td style="${td}text-align:center;width:36mm;">${barCell}</td>
        <td style="${td}text-align:center;width:14mm;font-size:8.5px;">${esc(it.baseUnit ?? '—')}</td>
        <td style="${td}width:19mm;">${emptyBox}</td>
        <td style="${td}width:19mm;">${emptyBox}</td>
        <td style="${td}width:26mm;">${noteLine}</td>
      </tr>`;
    }).join('');

    // ثلاث خانات توقيع — سلسلة عهدة الورقة: عدّ ← استلم وأدخل البيانات ← دقّق (مرجع jrd-countsheet.jsx).
    const sigBoxes = ['عدّ (العامل)', 'استلم وأدخل البيانات', 'راجع ودقّق (المشرف)'].map((k, i) => `<div style="text-align:center;">
      <div style="font-size:9.5px;font-weight:800;">${esc(k)}</div>
      ${i === 0 ? `<div style="font-size:8.5px;color:#555;margin-top:1mm;">${esc(sh.workerName)}</div>` : `<div style="font-size:8.5px;color:#555;margin-top:1mm;">&nbsp;</div>`}
      <div style="margin-top:9mm;border-top:1px solid #000;padding-top:1mm;font-size:8px;color:#555;">الاسم والتوقيع</div>
    </div>`).join('');

    return `<div style="width:210mm;min-height:297mm;background:#fff;color:#000;direction:rtl;
      font-family:'Cairo',sans-serif;padding:12mm 14mm;box-sizing:border-box;
      ${ai < total - 1 ? 'page-break-after:always;' : ''}">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;
        border-bottom:2px solid #000;padding-bottom:3mm;">
        <div>
          <p style="font-size:13px;font-weight:800;margin:0;">الرؤية العربية — قائمة عدّ ميداني</p>
          <p style="font-size:9px;color:#333;margin:1mm 0 0 0;">
            ${esc(d.branchName)} · جلسة <span dir="ltr" style="font-family:monospace;">${esc(d.code)}</span> · ${esc(dateStr)}${d.name ? ` · ${esc(d.name)}` : ''}
          </p>
        </div>
        <div style="text-align:left;">
          <p style="font-size:10.5px;font-weight:800;margin:0;">العامل: ${esc(sh.workerName)}</p>
          <p style="font-size:9px;color:#333;margin:0.5mm 0 0 0;">المنطقة: ${esc(sh.zone ?? '—')} · ورقة ${fmt(ai + 1)} من ${fmt(total)}</p>
          <p style="font-size:7.5px;color:#555;margin:0.5mm 0 0 0;">رمز الدخول (PIN) لا يُطبع — يُسلَّم للعامل مباشرة</p>
        </div>
      </div>

      <table style="width:100%;border-collapse:collapse;margin-top:4mm;">
        <thead><tr>
          <th style="${th}text-align:center;width:7mm;">#</th>
          <th style="${th}">المنتج</th>
          <th style="${th}width:22mm;">المتغيّر</th>
          <th style="${th}width:20mm;">SKU</th>
          <th style="${th}text-align:center;width:36mm;">الباركود</th>
          <th style="${th}text-align:center;width:14mm;">الوحدة الأساس</th>
          <th style="${th}text-align:center;width:19mm;">العدّ 1</th>
          <th style="${th}text-align:center;width:19mm;">العدّ 2</th>
          <th style="${th}width:26mm;">ملاحظات</th>
        </tr></thead>
        <tbody>${rows || `<tr><td colspan="9" style="${td}text-align:center;color:#555;">لا منتجات في هذا التكليف.</td></tr>`}</tbody>
      </table>

      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10mm;margin-top:10mm;">${sigBoxes}</div>

      <p style="font-size:8px;color:#555;margin-top:4mm;line-height:1.8;">
        تعليمات: عُدَّ ما على الرف فعلياً فقط · لا تنقل أرقاماً من النظام أو من زميل ·
        أي منتج غير موجود اكتب «0» · الكميات بوحدة الأساس المذكورة.
      </p>
    </div>`;
  }).join('');

  const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<title>قوائم عدّ — ${esc(d.code)}</title>
${CAIRO_FONT}
<style>
  *,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
  html,body{font-family:'Cairo',sans-serif;background:#fff;color:#000}
  @page{size:A4;margin:0}
</style>
</head>
<body>${pages}</body></html>`;

  openPrintWindow(html);
}
