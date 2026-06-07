/**
 * مكوّنات HTML المشتركة لقوالب الطباعة — مكتبة العربية
 * تُولّد سلاسل HTML خالصة تُضمَّن في نوافذ الطباعة.
 */
import { BRAND, CO, esc, logoUrl, CAIRO_FONT } from './brand';

// ─── غلاف صفحة A4 ────────────────────────────────────────────────────────────

export function a4PageOpen(): string {
  return `<div style="width:210mm;min-height:297mm;background:#fff;display:flex;flex-direction:column;
position:relative;overflow:hidden;font-family:Cairo,sans-serif;color:#000;direction:rtl;
font-size:10.5px;line-height:1.7;padding:10mm 14mm 10mm 14mm;box-sizing:border-box;">
<div style="position:absolute;top:0;right:0;bottom:0;width:4mm;
  background:linear-gradient(to bottom,${BRAND.green},${BRAND.greenDark} 40%,${BRAND.orange} 100%);"></div>
<div style="position:absolute;top:0;right:4mm;left:0;height:5.5mm;
  background:linear-gradient(135deg,${BRAND.green} 0%,${BRAND.greenDark} 60%,${BRAND.greenDeep} 100%);"></div>`;
}

export function a4PageClose(): string {
  return `<div style="position:absolute;bottom:0;right:4mm;left:0;height:3.5mm;
  background:linear-gradient(135deg,${BRAND.greenDark} 0%,${BRAND.green} 100%);"></div>
</div>`;
}

/** مغلّف HTML كامل لصفحة A4 */
export function wrapA4Doc(title: string, bodyContent: string): string {
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<title>${esc(title)}</title>
${CAIRO_FONT}
<style>
  *,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
  html,body{font-family:'Cairo',sans-serif;background:#fff;color:#000}
  @page{size:A4;margin:0}
  body{margin:0;padding:0}
</style>
</head>
<body style="background:#fff;">
${a4PageOpen()}
${bodyContent}
${a4PageClose()}
</body></html>`;
}

/** مغلّف HTML لإيصال حراري 80mm */
export function wrapReceiptDoc(title: string, bodyContent: string): string {
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<title>${esc(title)}</title>
${CAIRO_FONT}
<style>
  *,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
  @page{size:80mm auto;margin:0}
  body{font-family:'Cairo',monospace;width:80mm;background:#fff;color:#000;margin:0;padding:3mm;font-size:11px;line-height:1.5}
</style>
</head>
<body>${bodyContent}</body></html>`;
}

// ─── رأس المستند ─────────────────────────────────────────────────────────────

export function docHeader(
  title: string,
  docNum?: string | null,
  docDate?: string | null,
  extra?: { label: string; value: string }[],
): string {
  const logo = logoUrl();
  const extraRows = (extra ?? []).map(e => `
    <div style="display:flex;align-items:center;gap:2mm;justify-content:flex-end;margin-bottom:1mm;">
      <span style="font-size:9px;color:${BRAND.textMuted};">${esc(e.label)}</span>
      <span style="font-size:10px;font-weight:600;color:#000;">${esc(e.value)}</span>
    </div>`).join('');

  return `<div style="padding-top:8mm;padding-right:2mm;">
  <div style="display:flex;align-items:flex-start;justify-content:space-between;
    margin-bottom:5mm;padding-bottom:4.5mm;border-bottom:2.5px solid ${BRAND.green};">
    <div style="display:flex;align-items:center;gap:4.5mm;flex:1;">
      <div style="width:24mm;height:24mm;border-radius:6px;overflow:hidden;
        border:2px solid ${BRAND.green};background:#fff;display:flex;align-items:center;
        justify-content:center;flex-shrink:0;box-shadow:0 2px 8px ${BRAND.green}25;">
        <img src="${logo}" style="width:21mm;height:21mm;object-fit:contain;" alt="" onerror="this.style.display='none'">
      </div>
      <div>
        <p style="font-size:15px;font-weight:900;color:${BRAND.greenDark};line-height:1.35;margin:0;letter-spacing:-0.3px;">مكتبة العربية</p>
        <p style="font-size:10.5px;font-weight:700;color:${BRAND.green};margin:0.5mm 0 0 0;letter-spacing:0.2px;">للطباعة والقرطاسية</p>
        <p style="font-size:8px;color:${BRAND.textFaint};margin:1mm 0 0 0;font-weight:500;
          border-top:1px solid ${BRAND.borderLight};padding-top:1mm;">${esc(CO.name)}</p>
      </div>
    </div>
    <div style="text-align:left;flex-shrink:0;padding-left:4mm;min-width:55mm;">
      <div style="display:inline-block;background:linear-gradient(135deg,${BRAND.green},${BRAND.greenDark});
        color:#fff;padding:1.5mm 5mm;border-radius:4px;font-size:14px;
        font-weight:800;margin-bottom:2.5mm;letter-spacing:-0.3px;">${esc(title)}</div>
      ${docNum ? `<div style="display:flex;align-items:center;gap:2mm;justify-content:flex-end;margin-bottom:1mm;">
        <span style="font-size:9px;color:${BRAND.textMuted};">رقم المستند</span>
        <span style="font-size:10.5px;font-weight:700;color:#000;background:${BRAND.bg};
          padding:0.5mm 3mm;border-radius:3px;border:1px solid ${BRAND.border};
          font-family:monospace;letter-spacing:0.5px;">${esc(docNum)}</span>
      </div>` : ''}
      ${docDate ? `<div style="display:flex;align-items:center;gap:2mm;justify-content:flex-end;margin-bottom:1mm;">
        <span style="font-size:9px;color:${BRAND.textMuted};">التاريخ</span>
        <span style="font-size:10px;font-weight:600;color:#000;">${esc(docDate)}</span>
      </div>` : ''}
      ${extraRows}
    </div>
  </div>
</div>`;
}

// ─── شبكة البيانات الوصفية ────────────────────────────────────────────────────

export interface MetaSection {
  title?: string;
  fields: { label: string; value: string }[];
}

export function docMeta(sections: MetaSection[]): string {
  const cols = sections.length > 1 ? '1fr 1fr' : '1fr';
  const cells = sections.map((sec, si) => {
    const isGreen = si === 0;
    const accentColor = isGreen ? BRAND.green : BRAND.orange;
    const bg = isGreen ? BRAND.greenMist : BRAND.bgWarm;
    const borderColor = isGreen ? BRAND.greenLight : BRAND.border;
    const titleColor = isGreen ? BRAND.green : BRAND.orangeDark;

    const titleHtml = sec.title
      ? `<div style="font-size:10px;font-weight:800;color:${titleColor};margin-bottom:2.5mm;padding-top:1mm;display:flex;align-items:center;gap:2mm;">
           <span style="width:3px;height:12px;border-radius:2px;background:${accentColor};display:inline-block;"></span>
           ${esc(sec.title)}
         </div>`
      : '';

    const fields = sec.fields.map((f, fi) => `
      <div style="display:flex;align-items:baseline;gap:2mm;margin-bottom:1.5mm;
        padding-bottom:${fi < sec.fields.length - 1 ? '1.5mm' : '0'};
        border-bottom:${fi < sec.fields.length - 1 ? `1px dashed ${BRAND.borderLight}` : 'none'};">
        <span style="font-size:8.5px;color:${BRAND.textFaint};min-width:18mm;flex-shrink:0;">${esc(f.label)}</span>
        <span style="font-size:10.5px;font-weight:600;color:#000;">${esc(f.value)}</span>
      </div>`).join('');

    return `<div style="background:${bg};border:1px solid ${borderColor};border-radius:5px;padding:3.5mm 4mm;position:relative;overflow:hidden;">
      <div style="position:absolute;top:0;right:0;left:0;height:2px;background:${accentColor};"></div>
      ${titleHtml}${fields}
    </div>`;
  }).join('');

  return `<div style="display:grid;grid-template-columns:${cols};gap:3.5mm;margin-bottom:5mm;">${cells}</div>`;
}

// ─── جدول البنود ──────────────────────────────────────────────────────────────

export interface TableCol {
  key: string;
  label: string;
  width?: string;
  align?: 'right' | 'left' | 'center';
  bold?: boolean;
}

export function docTable(
  columns: TableCol[],
  rows: Record<string, string>[],
  showIndex = true,
): string {
  const th = `background:${BRAND.orange};color:#fff;padding:3mm;font-weight:700;text-align:right;font-size:9px;white-space:nowrap;letter-spacing:0.2px;`;
  const td = `padding:2.5mm 3mm;text-align:right;vertical-align:middle;border-bottom:1px solid ${BRAND.borderLight};font-size:10px;`;

  const headCols = showIndex
    ? `<th style="${th}text-align:center;width:8mm;">م</th>`
    : '';
  const headCells = columns.map(c =>
    `<th style="${th}text-align:${c.align ?? 'right'};${c.width ? `width:${c.width};` : ''}">${esc(c.label)}</th>`
  ).join('');

  const body = rows.map((r, ri) => {
    const bg = ri % 2 === 0 ? '#fff' : BRAND.bg;
    const idx = showIndex
      ? `<td style="${td}text-align:center;color:${BRAND.textFaint};font-weight:700;font-size:9px;width:8mm;background:${bg};">${ri + 1}</td>`
      : '';
    const cells = columns.map(c =>
      `<td style="${td}text-align:${c.align ?? 'right'};font-weight:${c.bold ? '700' : '400'};color:${c.bold ? BRAND.greenDark : '#000'};background:${bg};">${esc(r[c.key] ?? '')}</td>`
    ).join('');
    return `<tr>${idx}${cells}</tr>`;
  }).join('');

  return `<div style="border-radius:6px;overflow:hidden;border:1px solid ${BRAND.border};margin-bottom:5mm;">
  <table style="width:100%;border-collapse:collapse;">
    <thead><tr>${headCols}${headCells}</tr></thead>
    <tbody>${body}</tbody>
  </table>
</div>`;
}

// ─── صندوق الملخّص المالي ─────────────────────────────────────────────────────

export interface SummaryItem {
  label: string;
  value: string;
  bold?: boolean;
  large?: boolean; // يُعطي الخلفية الخضراء — يجب أن يكون الأخير
}

export function docSummary(items: SummaryItem[], qrSvg?: string): string {
  const totals = items.map((it, i) => {
    const isLast = i === items.length - 1 && !!it.large;
    const bg = isLast
      ? `linear-gradient(135deg,${BRAND.green},${BRAND.greenDark})`
      : i % 2 === 0 ? '#fff' : BRAND.greenMist;
    const color = isLast ? '#fff' : '#000';
    const border = !isLast ? `border-bottom:1px solid ${BRAND.borderLight};` : '';
    return `<div style="display:flex;justify-content:space-between;align-items:center;
      padding:${isLast ? '3mm 4mm' : '2mm 4mm'};background:${bg};color:${color};
      font-size:${isLast ? '14px' : '10px'};font-weight:${it.bold ? '800' : '500'};${border}">
      <span style="font-size:${isLast ? '11px' : '9.5px'};opacity:${isLast ? '0.9' : '0.7'};">${esc(it.label)}</span>
      <span style="font-weight:700;letter-spacing:-0.3px;">${esc(it.value)}</span>
    </div>`;
  }).join('');

  const qrBlock = qrSvg
    ? `<div style="background:#fff;padding:2.5mm;border:1.5px solid ${BRAND.border};border-radius:4px;display:inline-block;text-align:center;">
         ${qrSvg}
         <div style="font-size:6.5px;color:${BRAND.textFaint};margin-top:1mm;letter-spacing:0.3px;">فاتورة إلكترونية — ZATCA</div>
       </div>`
    : '';

  return `<div style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:5mm;gap:10mm;">
  ${qrBlock}
  <div style="min-width:58mm;margin-right:${qrSvg ? '0' : 'auto'};
    border-radius:6px;overflow:hidden;border:1.5px solid ${BRAND.greenLight};">
    ${totals}
  </div>
</div>`;
}

// ─── تذييل المستند ────────────────────────────────────────────────────────────

export function docFooter(): string {
  const phones = CO.phones.map((p, i) => `
    <div style="display:flex;align-items:center;gap:2mm;padding:1.5mm 0;
      border-bottom:${i < 3 ? `1px solid ${BRAND.borderLight}` : 'none'};">
      <span style="font-size:8px;color:#fff;background:${BRAND.green};padding:0.8mm 2.5mm;
        border-radius:3px;font-weight:700;white-space:nowrap;min-width:16mm;text-align:center;">${esc(p.l)}</span>
      <span style="font-weight:700;color:#000;direction:ltr;font-size:10px;
        letter-spacing:0.5px;font-family:Cairo,sans-serif;">${esc(p.n)}</span>
    </div>`).join('');

  return `<div style="margin-top:auto;padding-top:4mm;">
  <div style="text-align:center;padding:3mm;margin-bottom:3mm;
    background:linear-gradient(135deg,${BRAND.greenMist},${BRAND.greenPale});
    border-radius:5px;border:1px solid ${BRAND.greenLight};">
    <span style="font-size:12px;font-weight:800;color:${BRAND.green};letter-spacing:-0.2px;">${esc(CO.footer)}</span>
  </div>
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:2mm 3mm;font-size:8.5px;
    padding:3mm 2mm;background:${BRAND.bg};border-radius:4px;border:1px solid ${BRAND.border};">
    ${phones}
  </div>
</div>`;
}

// ─── أشرطة لوني ──────────────────────────────────────────────────────────────

export function agingSummaryBars(pcts: { label: string; val: number; color: string }[], total: number): string {
  const cards = pcts.map(p => `
    <div style="flex:1;background:${p.color}12;border:1px solid ${p.color}30;border-radius:4px;padding:2.5mm;text-align:center;">
      <div style="font-size:8px;color:${BRAND.textMuted};margin-bottom:1mm;">${esc(p.label)}</div>
      <div style="font-size:12px;font-weight:700;color:${p.color};">${p.val.toLocaleString('en-US')}</div>
      <div style="font-size:7.5px;color:${BRAND.textMuted};">${total ? Math.round(p.val / total * 100) : 0}%</div>
    </div>`).join('');

  const totalCard = `<div style="flex:1.2;background:${BRAND.greenPale};border:1px solid ${BRAND.greenLight};border-radius:4px;padding:2.5mm;text-align:center;">
    <div style="font-size:8px;color:${BRAND.textMuted};margin-bottom:1mm;">الإجمالي</div>
    <div style="font-size:13px;font-weight:800;color:${BRAND.greenDark};">${total.toLocaleString('en-US')}</div>
    <div style="font-size:7.5px;color:${BRAND.textMuted};">د.ع</div>
  </div>`;

  const stackBar = pcts.map(p => {
    const w = total ? (p.val / total * 100) : 0;
    return w > 0 ? `<div style="width:${w}%;background:${p.color};min-width:2px;" title="${p.label}"></div>` : '';
  }).join('');

  return `<div style="display:flex;gap:2mm;margin-bottom:5mm;">${cards}${totalCard}</div>
<div style="height:5mm;display:flex;border-radius:3px;overflow:hidden;margin-bottom:5mm;">${stackBar}</div>`;
}
