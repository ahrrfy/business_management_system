/**
 * مكوّنات HTML المشتركة لقوالب الطباعة — «مطبوعات مكتبة العربية» (تسليم ٥/٧/٢٦).
 *
 * التصميم المرجعي: صفحة A4 بمقاسات نقاطية صلبة (794×1123px @96dpi) بإطار زخرفة داخلي على بُعد 24px،
 * ترويسة موحّدة (شعار 96×96 + اسم شركة + ٣ أرقام قانونية) وتذييل مثبَّت أسفل الصفحة. جدول بحدود
 * خارجية سوداء 2px وداخلية 6B6E66 بسماكة 1.5px. الحبر أسود خالص. الأخضر رمز هوية. الأحمر للمتبقّي.
 *
 * كل الدوال هنا تُنتج سلاسل HTML مفصولة عن wrapA4Doc/wrapReceiptDoc — التغليف يوفّر @page وخط Cairo.
 * الأسماء القديمة (docHeader / docMeta / docTable / docSummary / docFooter / agingSummaryBars) مُبقاة
 * وأُعيد تشكيلها لتُخرج التصميم الجديد نفسه، فتلتقط شاشات التقارير القديمة اللمسة الجديدة تلقائياً.
 */
import { BRAND as B, CO, esc, logoUrl, CAIRO_FONT } from './brand';

// ─── ثوابت التصميم ────────────────────────────────────────────────────────────

/** أبعاد الورقة A4 عند 96dpi (يعادل 210×297مم بالمرجع). */
export const PAGE_W = 794;
export const PAGE_H = 1123;
/** هامش أمان لإطار الزخرفة الداخلي (24px من كل جانب) — لا تُقلَّص وإلا ضاع النص في منطقة الطباعة الميتة. */
export const SAFETY_INSET = 24;

// ─── مغلّفات صفحة كاملة ──────────────────────────────────────────────────────

/**
 * غلاف HTML كامل لصفحة A4 بالتصميم المرجعي. المحتوى الوارد `body` = HTML شريحة‎ الصفحة
 * (تُنتج عبر `pageOpen()` … `pageClose()`) — نُبقي هذا الاسم للتوافق مع النداءات القائمة.
 */
export function wrapA4Doc(title: string, bodyContent: string): string {
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<title>${esc(title)}</title>
${CAIRO_FONT}
<style>
  *,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
  *{-webkit-print-color-adjust:exact !important;print-color-adjust:exact !important;color-adjust:exact !important}
  html,body{font-family:'Cairo',sans-serif;background:#fff;color:#000;direction:rtl}
  @page{size:A4;margin:0}
  body{margin:0;padding:0;font-family:'Cairo',sans-serif}
  .page{width:${PAGE_W}px;min-height:${PAGE_H}px;background:#fff;position:relative;
    margin:0 auto;font-family:'Cairo',sans-serif;color:#000;direction:rtl;font-size:11.5px;line-height:1.55;
    display:flex;flex-direction:column;}
  /* إطار الزخرفة الداخلي على بعد 24px من حواف الصفحة. على الشاشة يظهر كإطار واحد؛ على الطباعة
     يُخفى لأن position:absolute مع inset لا يتعامل جيداً مع الصفحات المتعدّدة (يمتدّ سطرياً بين
     الصفحات). في الطباعة يعوّض الإطار بهامش الأمان الطبيعي عبر @page margin. */
  .page-inset{position:absolute;top:${SAFETY_INSET}px;right:${SAFETY_INSET}px;bottom:${SAFETY_INSET}px;left:${SAFETY_INSET}px;border:1px solid ${B.borderMist};pointer-events:none;z-index:2;}
  .page-body{position:relative;z-index:1;padding:32px 42px 0;flex:1 0 auto;}
  /* التذييل يدفعه margin-top:auto لأسفل .page (flex column) ⇒ يبقى ملتصقاً بالحافة السفلى للصفحة
     الأولى للمستند ذي الصفحة الواحدة، ويتدفّق مع نهاية آخر صفحة للمستندات الطويلة (كشف/تقرير). */
  .page-footer{margin-top:auto;padding:14px 42px 24px;z-index:1;position:relative;}
  table{border-collapse:collapse}
  thead{display:table-header-group} tfoot{display:table-footer-group}
  tr,td,th{page-break-inside:avoid;break-inside:avoid}
  /* على الورق الفعلي: لا ظلال، إطار الزخرفة يُلغى (السبب أعلاه)، الحواف كما هي (التصميم مبنيّ عليها). */
  @media print { *{box-shadow:none !important} body{background:#fff} .page-inset{display:none !important} }
</style>
</head>
<body>
<div class="page">
  <div class="page-inset"></div>
  ${bodyContent}
</div>
</body></html>`;
}

/** مغلّف HTML لإيصال حراري 80mm (كما كان — لا تغيير في وحدة نقطة البيع). */
export function wrapReceiptDoc(title: string, bodyContent: string): string {
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<title>${esc(title)}</title>
${CAIRO_FONT}
<style>
  *,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
  *{-webkit-print-color-adjust:exact !important;print-color-adjust:exact !important;color-adjust:exact !important}
  @page{size:80mm auto;margin:0}
  body{font-family:'Cairo',monospace;width:80mm;background:#fff;color:#000;margin:0;padding:3mm;font-size:11px;line-height:1.5}
</style>
</head>
<body onload="window.print();setTimeout(function(){window.close()},400)">${bodyContent}</body></html>`;
}

// ─── إعدادات المستند (يحقنها المُتصل من إعدادات الشركة) ─────────────────────

export interface CompanySettings {
  name?: string;
  sub?: string;
  taxId?: string;
  commercialRegistry?: string;
  chamberLicense?: string;
  address?: string;
  phones?: readonly { l: string; n: string }[];
  footerLine?: string;
  /** يُعرض في يمين التذييل — REF <رقم> أو HASH <بصمة>. القيمة الجاهزة نصيّاً. */
  footerRef?: string;
}

function coFrom(cs?: CompanySettings) {
  return {
    name:   cs?.name   ?? CO.name,
    sub:    cs?.sub    ?? CO.sub,
    taxId:  cs?.taxId  ?? CO.taxId,
    cr:     cs?.commercialRegistry ?? CO.commercialRegistry,
    lic:    cs?.chamberLicense ?? CO.chamberLicense,
    footer: cs?.footerLine ?? CO.footerLine,
  };
}

// ─── ترويسة المستند ──────────────────────────────────────────────────────────

export interface DocHeaderMeta {
  /** عنوان المستند بالعربية — "فاتورة مبيعات"، "سند قبض"، … */
  title: string;
  /** الحقول اليمنى تحت العنوان: رقم المستند، التاريخ، مدة، …. */
  fields: { label: string; value: string }[];
  /** شارة الحالة الاختيارية أسفل الحقول اليمنى — نص + لون. */
  badge?: { label: string; color?: string } | null;
  /** سطر تعريف ثانوي تحت العنوان (مثلاً «بيان تفصيلي — يوضح محتوى كل فاتورة»). */
  subtitle?: string | null;
}

/**
 * ترويسة موحَّدة: شعار 96×96 + اسم الشركة والأرقام القانونية على اليسار، وعنوان المستند بخط سميك
 * مع خط سفلي أخضر + جدول حقول + شارة حالة على اليمين. تنتهي بخط أفقي 1.5px أسود عرض 100%.
 */
export function pageHeader(meta: DocHeaderMeta, cs?: CompanySettings): string {
  const c = coFrom(cs);
  const logo = logoUrl();
  const badgeColor = meta.badge?.color ?? B.orange;

  const fields = meta.fields.map((f) => `
    <div style="display:flex;justify-content:space-between;font-size:11.25px">
      <span style="color:#000;font-weight:600">${esc(f.label)}</span>
      <span style="font-weight:800;color:#000;font-size:12.5px;direction:ltr;unicode-bidi:isolate;white-space:nowrap;font-variant-numeric:tabular-nums">${esc(f.value)}</span>
    </div>`).join('');

  const badge = meta.badge
    ? `<div style="margin-top:8px;display:inline-block;padding:3px 12px;border:1px solid ${badgeColor};border-radius:20px;white-space:nowrap;font-size:10.25px;font-weight:800;color:${badgeColor}">${esc(meta.badge.label)}</div>`
    : '';

  const subtitle = meta.subtitle
    ? `<div style="font-size:10px;color:${B.borderDk};font-weight:700;margin-top:3px">${esc(meta.subtitle)}</div>`
    : '';

  return `<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px">
  <div style="display:flex;gap:16px;align-items:flex-start">
    <img src="${logo}" alt="شعار ${esc(c.sub)}" style="width:96px;height:96px;object-fit:contain;border:1.5px solid ${B.borderLogo};border-radius:6px;padding:6px;flex-shrink:0" onerror="this.style.display='none'" />
    <div>
      <div style="font-size:17.5px;font-weight:800;color:${B.ink};line-height:1.3">${esc(c.sub)}</div>
      <div style="font-size:11.75px;font-weight:700;color:${B.green};margin-top:2px">${esc(c.name)}</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:7px;padding-top:6px;border-top:1px solid #F1F1EC;max-width:340px">
        <span style="font-size:9.25px;color:#000;font-weight:600">الرقم الضريبي <b style="color:#000;font-weight:800">${esc(c.taxId)}</b></span>
        <span style="font-size:9.25px;color:#000;font-weight:600">السجل التجاري <b style="color:#000;font-weight:800">${esc(c.cr)}</b></span>
        <span style="font-size:9.25px;color:#000;font-weight:600">إجازة الغرفة <b style="color:#000;font-weight:800">${esc(c.lic)}</b></span>
      </div>
    </div>
  </div>
  <div style="text-align:left;flex-shrink:0;min-width:300px">
    <div style="font-size:24.5px;font-weight:800;color:${B.ink};display:inline-block;position:relative;padding-bottom:6px;white-space:nowrap">
      ${esc(meta.title)}
      <div style="position:absolute;bottom:0;right:0;left:0;height:3px;background:${B.green}"></div>
    </div>
    ${subtitle}
    <div style="margin-top:10px;display:flex;flex-direction:column;gap:4px">${fields}</div>
    ${badge}
  </div>
</div>
<div style="height:1.5px;background:${B.ink};margin-top:13px"></div>`;
}

// ─── بطاقات معلومات (بطاقتان جنب بعض) ────────────────────────────────────────

export interface InfoCard {
  title: string;
  /** «green» = عنوان أخضر + خطّ داخلي أخضر. «gray» = عنوان أسود + خطّ داخلي رمادي (الطرف الثاني). */
  variant?: 'green' | 'gray';
  fields: { label: string; value: string }[];
  /** خلاصة عريضة بديلة عن الجدول (استعمل هذا لسندات القبض/الدفع). */
  bigLine?: { primary: string; secondary?: string };
}

/** شبكة بطاقتين بمقاس 1fr:1fr. يمين=أخضر (بيانات الطرف)، يسار=رمادي (تفاصيل تشغيلية). */
export function infoCards(cards: InfoCard[]): string {
  const cell = (card: InfoCard) => {
    const isGreen = (card.variant ?? 'green') === 'green';
    const accent = isGreen ? B.green : '#8B8E89';
    const titleColor = isGreen ? B.green : '#000';

    const body = card.bigLine
      ? `<div style="font-size:14.25px;font-weight:900;color:${B.ink};line-height:1.4">${esc(card.bigLine.primary)}</div>${card.bigLine.secondary ? `<div style="font-size:10.75px;color:#000;margin-top:4px">${esc(card.bigLine.secondary)}</div>` : ''}`
      : `<div style="display:flex;flex-direction:column;gap:6px">${
          card.fields.map((f, i, all) => {
            const last = i === all.length - 1;
            const isPhone = /هاتف|رقم/.test(f.label);
            return `<div style="display:flex;justify-content:space-between;font-size:11.75px;${last ? '' : `border-bottom:1px dashed ${B.borderLight};padding-bottom:5px`}">
              <span style="color:#000">${esc(f.label)}</span>
              <span style="font-weight:800;color:#000;font-size:${isPhone ? '12.75px' : '11.75px'};${isPhone ? 'direction:ltr;unicode-bidi:isolate;white-space:nowrap;' : ''}">${esc(f.value)}</span>
            </div>`;
          }).join('')
        }</div>`;

    return `<div style="border:1px solid ${B.border};border-inline-start:3px solid ${accent};border-radius:4px;padding:11px 14px">
      <div style="font-size:10.25px;font-weight:800;color:${titleColor};letter-spacing:.3px;margin-bottom:8px">${esc(card.title)}</div>
      ${body}
    </div>`;
  };

  const cols = cards.length === 1 ? '1fr' : '1fr 1fr';
  return `<div style="display:grid;grid-template-columns:${cols};gap:14px;margin-top:13px">${cards.map(cell).join('')}</div>`;
}

// ─── جدول البنود بالتصميم المرجعي ────────────────────────────────────────────

export interface DocTableCol {
  key: string;
  label: string;
  /** عرض عمود بالبكسل (يقابل width في الـHTML المرجعي). اترك undefined ⇒ يمتدّ. */
  width?: number;
  /** لون النص. اُعتبِر «money» و «amount» و «tax» ألوان معياريّة أدناه. */
  color?: string;
  /** لتمييز عمود الإجمالي بالأخضر السميك. */
  emphasize?: boolean;
  /** حجم الخطّ بالبكسل (11.25/11.75/12/12.75 — يطابق سلّم التصميم). */
  size?: number;
}

export interface DocTableOpts {
  /** عرض عمود الترقيم "م" — يفتراض 32px. */
  indexWidth?: number;
  /** إخفاء عمود الترقيم كلياً (لجداول التقارير الخاصة كأعمار الذمم). */
  hideIndex?: boolean;
  /** تذييل «الإجمالي» (تُدرَج مباشرةً كصف tfoot). */
  totalsRow?: { label: string; cells: { key: string; value: string; color?: string; emphasize?: boolean }[] } | null;
  /** لا يُطبَّق border-bottom على tbody rows (كشف الحساب: صف قيم + صف تفاصيل شفافين على بعضهما). */
  suppressRowBorderBottom?: boolean;
}

/**
 * جدول بنود بالتصميم المرجعي: حدود خارجية سوداء 2px + رأس `#0D3B2E` أبيض 10.75px + خلايا داخلية
 * بسماكة 1.5px لون `#6B6E66` + تناوب صفوف white/`#F6F6F2`. تُمرَّر الصفوف كسجلات مفاتيح النصّية.
 */
export function docTableV2(
  columns: DocTableCol[],
  rows: Record<string, string>[],
  opts: DocTableOpts = {},
): string {
  const idxW = opts.indexWidth ?? 32;
  const showIdx = !opts.hideIndex;

  const th = (label: string, width?: number) =>
    `<th style="vertical-align:middle;padding:7px 8px;text-align:center;font-size:10.75px;font-weight:800;color:#fff;border:1.5px solid rgba(255,255,255,.5);letter-spacing:.2px;${width ? `width:${width}px;` : ''}">${esc(label)}</th>`;

  const head = `<tr style="background:${B.greenDark}">${showIdx ? th('م', idxW) : ''}${columns.map((c) => th(c.label, c.width)).join('')}</tr>`;

  const bodyRows = rows.map((r, ri) => {
    const bg = ri % 2 === 0 ? '#fff' : B.zebra;
    const brdBot = opts.suppressRowBorderBottom ? 'border-bottom:none;' : '';

    const idxCell = showIdx
      ? `<td style="vertical-align:middle;padding:6px;text-align:center;font-size:11.25px;color:#000;font-weight:700;border:1.5px solid ${B.borderDk};${brdBot}">${ri + 1}</td>`
      : '';

    const cells = columns.map((c) => {
      const size = c.size ?? 11.75;
      const color = c.color ?? '#000';
      const isMoney = /price|total|tax|amount|debit|credit|balance|remaining|paid/i.test(c.key);
      const align = 'text-align:center';
      const font = isMoney ? 'direction:ltr;unicode-bidi:isolate;white-space:nowrap;font-variant-numeric:tabular-nums;' : '';
      const weight = c.emphasize ? 'font-weight:800' : (isMoney ? 'font-weight:800' : 'font-weight:700');
      const finalColor = c.emphasize ? B.green : color;
      const finalSize = c.emphasize ? 12.75 : size;
      return `<td style="vertical-align:middle;padding:6px;${align};font-size:${finalSize}px;color:${finalColor};${weight};border:1.5px solid ${B.borderDk};${brdBot}${font}">${esc(r[c.key] ?? '')}</td>`;
    }).join('');

    return `<tr style="background:${bg}">${idxCell}${cells}</tr>`;
  }).join('');

  let foot = '';
  if (opts.totalsRow) {
    // خلايا الإجمالي — نتعامل مع عمود ملخّص (colspan) + خلايا فردية للأعمدة المطابقة.
    const cellByKey = new Map(opts.totalsRow.cells.map((c) => [c.key, c]));
    // نحسب "labelSpan": عدد الأعمدة من البداية التي لا قيمة إجمالي لها = تُدمَج تحت خلية «الإجمالي».
    let labelSpan = 0;
    const totalColsCount = (showIdx ? 1 : 0) + columns.length;
    for (const c of (showIdx ? [{ key: '__idx__' } as { key: string }, ...columns] : columns)) {
      if (!cellByKey.has(c.key)) labelSpan++;
      else break;
    }
    const trailing = totalColsCount - labelSpan - opts.totalsRow.cells.length;
    const emphasize = (c: { emphasize?: boolean; color?: string; value: string }) => {
      const color = c.color ?? B.ink;
      return `<td style="vertical-align:middle;padding:6px;text-align:center;font-size:11.25px;font-weight:900;color:${color};border:1.5px solid ${B.borderDk};border-top:3px solid ${B.ink};direction:ltr;unicode-bidi:isolate;white-space:nowrap;font-variant-numeric:tabular-nums">${esc(c.value)}</td>`;
    };
    foot = `<tfoot><tr style="background:#F2F2EC">
      <td colspan="${labelSpan}" style="vertical-align:middle;padding:6px;text-align:center;font-size:10.75px;font-weight:800;color:${B.ink};border:1.5px solid ${B.borderDk};border-top:3px solid ${B.ink}">${esc(opts.totalsRow.label)}</td>
      ${opts.totalsRow.cells.map(emphasize).join('')}
      ${trailing > 0 ? `<td colspan="${trailing}" style="border:1.5px solid ${B.borderDk};border-top:3px solid ${B.ink}"></td>` : ''}
    </tr></tfoot>`;
  }

  return `<div style="margin-top:13px;border:2px solid ${B.ink};border-radius:4px;overflow:hidden">
    <table style="width:100%;border-collapse:collapse;table-layout:fixed">
      <thead>${head}</thead>
      <tbody>${bodyRows}</tbody>
      ${foot}
    </table>
  </div>`;
}

// ─── صف تفصيلي داخل جدول (لكشف الحساب المفصّل) ────────────────────────────

/** صفٌّ من عمودٍ واحد ممتدّ يشرح محتوى الصف السابق (فاتورة/سند). */
export function docTableDetailRow(zebraIndex: number, typeLabel: string, typeColor: string, details: string, cols: number): string {
  const bg = zebraIndex % 2 === 0 ? '#fff' : B.zebra;
  return `<tr style="background:${bg}">
    <td colspan="${cols}" style="vertical-align:middle;padding:6px 12px 9px;text-align:right;font-size:10px;color:${B.textFaint};border:1.5px solid ${B.borderDk};border-top:none;line-height:1.65">
      <span style="font-weight:800;color:${typeColor}">${esc(typeLabel)} — </span>${esc(details)}
    </td>
  </tr>`;
}

// ─── صندوق الإجماليات (مبلغ فرعي → خصم → ضريبة → شريط الإجمالي) ────────────

export interface TotalsRowLine {
  label: string;
  value: string;
  /** كهرماني للخصم؛ اتركه اسم اللون الجاهز. */
  color?: string;
  /** بادئة ± أمام القيمة. */
  sign?: '+' | '−';
}

export interface TotalsBox {
  lines: TotalsRowLine[];
  /** شريط الإجمالي الأخضر الداكن — يظهر بعد lines. */
  grandTotal: { label: string; value: string };
  /** خلاصة الدفع تحت الشريط: المدفوع + المتبقّي (اختياري) + الرصيد بعد الفاتورة. */
  paid?: { label: string; value: string } | null;
  remaining?: { label: string; value: string } | null;
  balance?: { beforeLabel: string; before: string; afterLabel: string; after: string; direction: string; directionColor?: string } | null;
}

/** يُنتَج على يسار الصفحة (`justify-content:flex-end`) بعرض 290px. */
export function totalsBox(t: TotalsBox): string {
  const line = (l: TotalsRowLine) => `<div style="display:flex;justify-content:space-between;padding:5px 2px;font-size:11.75px;border-bottom:1px dashed ${B.border}">
    <span style="color:#000">${esc(l.label)}</span>
    <span style="font-weight:${l.color ? '700' : '800'};color:${l.color ?? '#000'};font-size:12.75px;direction:ltr;unicode-bidi:isolate;white-space:nowrap;font-variant-numeric:tabular-nums">${l.sign ? `${l.sign} ` : ''}${esc(l.value)}</span>
  </div>`;

  const grandBar = `<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;margin-top:7px;background:${B.greenDark};border-radius:4px">
    <span style="font-size:12.75px;font-weight:700;color:${B.greenAccentText}">${esc(t.grandTotal.label)}</span>
    <span style="font-size:18.5px;font-weight:900;color:#fff;direction:ltr;unicode-bidi:isolate;white-space:nowrap;font-variant-numeric:tabular-nums">${esc(t.grandTotal.value)} <span style="font-size:11.75px;font-weight:700">د.ع</span></span>
  </div>`;

  const paidLine = t.paid ? `<div style="display:flex;justify-content:space-between;padding:6px 2px 0;font-size:11.25px">
    <span style="color:#000">${esc(t.paid.label)}</span>
    <span style="font-weight:800;color:#000;font-size:12.75px;direction:ltr;unicode-bidi:isolate;white-space:nowrap;font-variant-numeric:tabular-nums">${esc(t.paid.value)}</span>
  </div>` : '';

  const remLine = t.remaining ? `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 10px;margin-top:5px;background:${B.alertBg};border:1px solid ${B.alertBorder};border-radius:4px;font-size:11.75px">
    <span style="color:${B.alert};font-weight:800;white-space:nowrap">${esc(t.remaining.label)}</span>
    <span style="font-weight:900;color:${B.alert};direction:ltr;unicode-bidi:isolate;white-space:nowrap;font-variant-numeric:tabular-nums">${esc(t.remaining.value)}</span>
  </div>` : '';

  const balLine = t.balance ? `<div style="margin-top:7px;padding-top:6px;border-top:1px dashed #C9CAC2">
    <div style="display:flex;justify-content:space-between;align-items:baseline">
      <span style="font-size:9.75px;color:${B.textFaint};font-weight:700">${esc(t.balance.afterLabel)}</span>
      <span style="font-size:13.5px;font-weight:900;color:#000;direction:ltr;unicode-bidi:isolate;white-space:nowrap;font-variant-numeric:tabular-nums">${esc(t.balance.after)} <span style="font-size:9.5px;font-weight:800;color:${t.balance.directionColor ?? B.alert}">(${esc(t.balance.direction)})</span></span>
    </div>
    <div style="font-size:8.25px;color:#000;margin-top:1px">${esc(t.balance.beforeLabel)} ${esc(t.balance.before)} قبل هذه الفاتورة</div>
  </div>` : '';

  return `<div style="display:flex;justify-content:flex-end;margin-top:10px">
    <div style="width:290px">
      ${t.lines.map(line).join('')}
      ${grandBar}
      ${paidLine}
      ${remLine}
      ${balLine}
    </div>
  </div>`;
}

/** شريط إجمالي فقط (بلا سطور فرعية) — لأوامر الشغل والعرض المُبسَّط والسندات. */
export function grandTotalBar(label: string, value: string, opts: { big?: boolean } = {}): string {
  const pad = opts.big ? '14px 18px' : '10px 14px';
  const labelSize = opts.big ? '13.75px' : '12.75px';
  const valSize = opts.big ? '21.5px' : '18.5px';
  const unitSize = opts.big ? '12.25px' : '11.75px';
  return `<div style="margin-top:16px;display:flex;justify-content:space-between;align-items:center;padding:${pad};background:${B.greenDark};border-radius:4px">
    <span style="font-size:${labelSize};font-weight:700;color:${B.greenAccentText}">${esc(label)}</span>
    <span style="font-size:${valSize};font-weight:900;color:#fff;direction:ltr;unicode-bidi:isolate;white-space:nowrap;font-variant-numeric:tabular-nums">${esc(value)} <span style="font-size:${unitSize};font-weight:700">د.ع</span></span>
  </div>`;
}

// ─── سطر التفقيط ─────────────────────────────────────────────────────────────

/** صندوق «المبلغ كتابةً (تفقيطاً)» بحدود متقطّعة وخلفية FCFCFA. */
export function tafqitLine(words: string, label = 'المبلغ كتابةً (تفقيطاً):'): string {
  return `<div style="margin-top:8px;padding:6px 14px;border:1px dashed #C9CAC2;border-radius:4px;background:#FCFCFA">
    <span style="font-size:10.75px;font-weight:800;color:#000">${esc(label)} </span>
    <span style="font-size:12.75px;font-weight:800;color:#000">${esc(words)}</span>
  </div>`;
}

// ─── التوقيعات و QR ──────────────────────────────────────────────────────────

/** QR Placeholder ثابت من التصميم (SVG منقوش). في الإنتاج، يستبدله المتّصل بـSVG قياسي عبر qr.ts. */
export function qrPlaceholderSvg(sizePx = 42): string {
  return `<svg width="${sizePx}" height="${sizePx}" viewBox="0 0 8 8" style="border:1px solid ${B.borderMist};border-radius:3px" shape-rendering="crispEdges">
    <rect width="8" height="8" fill="#fff"></rect>
    <rect x="0" y="0" width="3" height="3" fill="${B.ink}"></rect><rect x="1" y="1" width="1" height="1" fill="#fff"></rect>
    <rect x="5" y="0" width="3" height="3" fill="${B.ink}"></rect><rect x="6" y="1" width="1" height="1" fill="#fff"></rect>
    <rect x="0" y="5" width="3" height="3" fill="${B.ink}"></rect><rect x="1" y="6" width="1" height="1" fill="#fff"></rect>
    <rect x="4" y="0" width="1" height="1" fill="${B.ink}"></rect><rect x="4" y="2" width="1" height="1" fill="${B.ink}"></rect>
    <rect x="3" y="3" width="1" height="1" fill="${B.ink}"></rect><rect x="5" y="3" width="1" height="1" fill="${B.ink}"></rect>
    <rect x="6" y="3" width="1" height="1" fill="${B.ink}"></rect><rect x="4" y="4" width="1" height="1" fill="${B.ink}"></rect>
    <rect x="6" y="4" width="1" height="1" fill="${B.ink}"></rect><rect x="3" y="5" width="1" height="1" fill="${B.ink}"></rect>
    <rect x="5" y="5" width="1" height="1" fill="${B.ink}"></rect><rect x="7" y="5" width="1" height="1" fill="${B.ink}"></rect>
    <rect x="4" y="6" width="1" height="1" fill="${B.ink}"></rect><rect x="3" y="7" width="1" height="1" fill="${B.ink}"></rect>
    <rect x="5" y="7" width="1" height="1" fill="${B.ink}"></rect><rect x="7" y="7" width="1" height="1" fill="${B.ink}"></rect>
  </svg>`;
}

export interface SignatureItem {
  kind: 'sig' | 'stamp';
  /** نص التسمية أسفل خط التوقيع. غير مستعمل لـstamp. */
  label?: string;
  /** عرض الخانة بالبكسل. افتراضي 120 للتوقيع، 48 للختم. */
  width?: number;
}

export interface SignatureBlock {
  /** خانات التوقيع/الختم بالترتيب من اليمين إلى اليسار. */
  items: SignatureItem[];
  /** QR على أقصى اليمين (اختياري). ابعث SVG جاهزاً (من qr.ts) أو true للـPlaceholder. */
  qrSvg?: string | true | null;
  /** نص وصف تحت QR. */
  qrCaption?: string | null;
  /** حجم QR بالبكسل — 42 لفواتير عادية، 52 للسندات. */
  qrSize?: number;
  /** ارتفاع «مساحة التوقيع» فوق الخط الأسود بالبكسل. افتراضي 22 (السندات 28). */
  spaceHeight?: number;
  /** حجم خط التسمية. افتراضي 10.25 (السندات 9.75). */
  labelSize?: number;
}

/** يعرض QR (يمين) + خانات التوقيع/الختم. كل خانة = فراغ فوق + خط أفقي 1px أسود + تسمية. */
export function signaturesBlock(b: SignatureBlock): string {
  const qrSize = b.qrSize ?? 42;
  const qr = b.qrSvg === true ? qrPlaceholderSvg(qrSize) : (typeof b.qrSvg === 'string' ? b.qrSvg : '');
  const qrCaption = b.qrCaption
    ? `<div style="font-size:${qrSize >= 52 ? 8.25 : 7.75}px;color:#000;text-align:center;max-width:${qrSize >= 52 ? 80 : 118}px;line-height:1.2">${esc(b.qrCaption)}</div>`
    : '';
  const qrBlock = qr
    ? `<div style="display:flex;flex-direction:column;align-items:center;gap:5px;flex-shrink:0">${qr}${qrCaption}</div>`
    : '<div></div>';

  const spaceH = b.spaceHeight ?? 22;
  const labelSize = b.labelSize ?? 10.25;

  const cells = b.items.map((it) => {
    if (it.kind === 'stamp') {
      const w = it.width ?? 48;
      return `<div style="width:${w}px;height:${w}px;border:1px dashed #C9CAC2;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:9.25px;color:${B.textFaint};text-align:center;line-height:1.4">ختم<br />الشركة</div>`;
    }
    const w = it.width ?? 120;
    return `<div style="text-align:center;width:${w}px">
      <div style="height:${spaceH}px"></div>
      <div style="border-top:1px solid ${B.ink};padding-top:5px;font-size:${labelSize}px;color:#000;font-weight:600">${esc(it.label ?? '')}</div>
    </div>`;
  }).join('');

  return `<div style="display:flex;justify-content:space-between;align-items:flex-end;margin-top:6px;gap:18px">
    ${qrBlock}
    <div style="display:flex;gap:22px;flex:1;justify-content:flex-end;align-items:flex-end">${cells}</div>
  </div>`;
}

// ─── التذييل المثبَّت أسفل الصفحة ────────────────────────────────────────────

/** يُدمَج داخل `.page-footer` تلقائياً في `pageClose(footer)`. */
export function pageFooter(cs?: CompanySettings, opts: { rightText?: string } = {}): string {
  const c = coFrom(cs);
  const right = opts.rightText ?? cs?.footerRef ?? '';
  return `<div class="page-footer">
    <div style="height:1px;background:${B.border};margin-bottom:10px"></div>
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
      <div style="font-size:10.25px;color:#000;font-weight:600">${esc(c.footer)}</div>
      <div style="font-size:9.25px;color:${B.textFaint};font-family:ui-monospace,monospace;direction:ltr;unicode-bidi:isolate;white-space:nowrap">${esc(right)}</div>
    </div>
  </div>`;
}

// ─── مغلّف جسم الصفحة ────────────────────────────────────────────────────────

/** يفتح `.page-body`. المحتوى المُدرج يظهر داخل حشوة 32/42/0. */
export function pageBodyOpen(): string { return `<div class="page-body">`; }
export function pageBodyClose(): string { return `</div>`; }

// ═════════════════════════════════════════════════════════════════════════════
// توافق خلفي: أسماء الدوال القديمة تُبقى لكن تُنتج التصميم الجديد.
// تُستعمل من printTemplates.ts القديم في اتجاهات لم تُعَد كتابتها بعد (aging/production).
// ═════════════════════════════════════════════════════════════════════════════

/** aliased للاسم القديم؛ يفتح `.page-body`. */
export function a4PageOpen(): string { return pageBodyOpen(); }
/** aliased للاسم القديم؛ يُغلق `.page-body` (تذييل الصفحة يُدرَج داخل .page مباشرةً). */
export function a4PageClose(): string { return pageBodyClose(); }

/** توافق خلفي — ترويسة بمعامَلات مسطّحة (title/رقم/تاريخ). */
export function docHeader(
  title: string,
  docNum?: string | null,
  docDate?: string | null,
  extra?: { label: string; value: string }[],
): string {
  const fields: { label: string; value: string }[] = [];
  if (docNum) fields.push({ label: 'رقم المستند', value: docNum });
  if (docDate) fields.push({ label: 'التاريخ', value: docDate });
  if (extra) fields.push(...extra);
  return `${pageBodyOpen()}${pageHeader({ title, fields })}`;
}

/** توافق خلفي — بطاقات المعلومات القديمة (title+fields). */
export interface MetaSection { title?: string; fields: { label: string; value: string }[] }
export function docMeta(sections: MetaSection[]): string {
  return infoCards(sections.map((s, i) => ({
    title: s.title ?? '',
    variant: i === 0 ? 'green' : 'gray',
    fields: s.fields,
  })));
}

/** توافق خلفي — نوع عمود قديم يُترجَم إلى DocTableCol. */
export interface TableCol { key: string; label: string; width?: string; align?: 'right'|'left'|'center'; bold?: boolean }

/** يترجم عرض mm/pt/px إلى عدد بكسل تقريبيّاً. */
function widthToPx(w?: string): number | undefined {
  if (!w) return undefined;
  const m = /([\d.]+)(mm|px|pt)?/.exec(w);
  if (!m) return undefined;
  const n = Number(m[1]);
  switch (m[2]) {
    case 'mm': return Math.round(n * 3.78);
    case 'pt': return Math.round(n * 1.333);
    default:   return Math.round(n);
  }
}

/** توافق خلفي — الجدول القديم بأعمدة وصفوف مبسّطة. */
export function docTable(columns: TableCol[], rows: Record<string, string>[], showIndex = true): string {
  return docTableV2(
    columns.map((c) => ({ key: c.key, label: c.label, width: widthToPx(c.width), emphasize: c.bold })),
    rows,
    { hideIndex: !showIndex },
  );
}

/** توافق خلفي — صندوق الملخّص القديم كسطور بسيطة. الأخير = شريط الإجمالي الأخضر. */
export interface SummaryItem { label: string; value: string; bold?: boolean; large?: boolean }
/** يزيل لاحقة « د.ع» من نصّ مالي مُنسَّق (fmtC)، لأن `totalsBox`/`grandTotalBar` يضيفانها ⇒ نتفادى التكرار. */
function stripIQDSuffix(v: string): string {
  return v.replace(/\s*د\.ع\s*$/, '');
}
export function docSummary(items: SummaryItem[], qrSvg?: string): string {
  const last = items[items.length - 1];
  // المتّصلون القدامى (PO/production/تقارير) يُنسّقون القيم عبر fmtC فتحوي « د.ع» لاحقةً.
  // نسحبها هنا قبل تسليمها لـtotalsBox الجديد الذي يضيفها في شريط الإجمالي الأخضر تلقائياً ⇒ يتفادى «د.ع د.ع».
  const lines = items.slice(0, -1).map((it) => ({ label: it.label, value: stripIQDSuffix(it.value) }));
  const box = totalsBox({
    lines,
    grandTotal: { label: last?.label ?? 'الإجمالي', value: stripIQDSuffix(last?.value ?? '') },
  });
  if (!qrSvg) return box;
  // اذا اُمرَر QR، نضعه على أقصى اليمين تحت الجدول.
  return `<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-top:10px;gap:16px">
    <div style="display:flex;flex-direction:column;align-items:center;gap:5px">${qrSvg}</div>
    <div style="flex:1">${box}</div>
  </div>`;
}

/** توافق خلفي — التذييل القديم كان يُدرَج ضمن `.page-body`؛ الآن يُدرَج مباشرةً في `.page` كتذييل مثبَّت. */
export function docFooter(): string {
  return `${pageBodyClose()}${pageFooter()}`;
}

/** توافق خلفي — أشرطة أعمار الذمم كما كانت (مستعملة في aging reports فقط). */
export function agingSummaryBars(pcts: { label: string; val: number; color: string }[], total: number): string {
  const cards = pcts.map((p) => `
    <div style="flex:1;background:${p.color}12;border:1px solid ${p.color}30;border-radius:4px;padding:2.5mm;text-align:center;">
      <div style="font-size:8px;color:${B.textFaint};margin-bottom:1mm;">${esc(p.label)}</div>
      <div style="font-size:12px;font-weight:700;color:${p.color};">${p.val.toLocaleString('en-US')}</div>
      <div style="font-size:7.5px;color:${B.textFaint};">${total ? Math.round((p.val / total) * 100) : 0}%</div>
    </div>`).join('');

  const totalCard = `<div style="flex:1.2;background:${B.greenPale};border:1px solid ${B.greenLight};border-radius:4px;padding:2.5mm;text-align:center;">
    <div style="font-size:8px;color:${B.textFaint};margin-bottom:1mm;">الإجمالي</div>
    <div style="font-size:13px;font-weight:800;color:${B.green};">${total.toLocaleString('en-US')}</div>
    <div style="font-size:7.5px;color:${B.textFaint};">د.ع</div>
  </div>`;

  const stackBar = pcts.map((p) => {
    const w = total ? (p.val / total) * 100 : 0;
    return w > 0 ? `<div style="width:${w}%;background:${p.color};min-width:2px;" title="${esc(p.label)}"></div>` : '';
  }).join('');

  return `<div style="display:flex;gap:2mm;margin-bottom:5mm;">${cards}${totalCard}</div>
<div style="height:5mm;display:flex;border-radius:3px;overflow:hidden;margin-bottom:5mm;">${stackBar}</div>`;
}
