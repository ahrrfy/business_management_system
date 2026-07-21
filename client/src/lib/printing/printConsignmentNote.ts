// بضاعة الأمانة (ش٢) — طباعة سند حركة أمانة (إيداع/سحب/استبدال) A4. نمط قوالب V2.
// بلا أيّ مجموع ماليّ (بضاعة لا فاتورة) — عدد القطع فقط + توقيعان. esc() على كل حقل حرّ.
import { BRAND, CAIRO_FONT, CO, esc, logoUrl, openPrintWindow } from "./brand";

export interface ConsignmentNoteForPrint {
  noteNumber: string;
  noteType: "DEPOSIT" | "WITHDRAW" | "EXCHANGE";
  consignorName: string;
  consignorPhone?: string | null;
  notes?: string | null;
  createdAt: string | Date;
  lines: Array<{
    lineDirection: "IN" | "OUT";
    productName: string;
    sku: string | null;
    quantity: string;
    baseQuantity: number;
  }>;
}

const TYPE_AR: Record<string, string> = { DEPOSIT: "إيداع بضاعة", WITHDRAW: "سحب بضاعة", EXCHANGE: "استبدال بضاعة" };

export function printConsignmentNote(note: ConsignmentNoteForPrint): boolean {
  const showDir = note.noteType === "EXCHANGE";
  const totalBase = note.lines.reduce((s, l) => s + (l.lineDirection === "IN" ? l.baseQuantity : -l.baseQuantity), 0);
  const rows = note.lines
    .map(
      (l, i) => `<tr>
        <td class="c">${i + 1}</td>
        ${showDir ? `<td class="c"><span class="dir ${l.lineDirection === "IN" ? "in" : "out"}">${l.lineDirection === "IN" ? "إيداع" : "سحب"}</span></td>` : ""}
        <td>${esc(l.productName)}</td>
        <td class="mono">${esc(l.sku ?? "")}</td>
        <td class="c">${esc(l.quantity)}</td>
      </tr>`,
    )
    .join("");
  const d = new Date(note.createdAt);
  const dateStr = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;

  const html = `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8">
<title>سند أمانة ${esc(note.noteNumber)}</title>${CAIRO_FONT}
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Cairo',sans-serif;color:${BRAND.text};background:${BRAND.page};font-size:13px;line-height:1.8}
  .page{width:210mm;min-height:297mm;margin:0 auto;background:${BRAND.paper};padding:16mm}
  .hd{display:flex;align-items:center;gap:12px;border-bottom:2px solid ${BRAND.green};padding-bottom:10px}
  .hd img{height:52px;width:52px;object-fit:contain}
  .hd .co{font-weight:800;font-size:16px;color:${BRAND.green}}
  .hd .co small{display:block;font-weight:600;font-size:11px;color:${BRAND.text}}
  .title{margin:14px 0;text-align:center;font-weight:900;font-size:18px}
  .title .band{display:inline-block;border:1.5px solid ${BRAND.orange};color:${BRAND.orange};border-radius:6px;padding:3px 16px}
  .meta{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px}
  .box{border:1px solid ${BRAND.borderDk};border-radius:8px;padding:8px 12px;font-size:12px}
  .box b{color:${BRAND.green}}
  table{width:100%;border-collapse:collapse;margin-top:6px}
  th,td{border:1px solid ${BRAND.borderDk};padding:6px 8px;text-align:right}
  th{background:${BRAND.greenPale};font-size:11px}
  td.c,th.c{text-align:center}
  .mono{font-family:monospace;font-size:11px;direction:ltr}
  .dir{display:inline-block;border-radius:4px;padding:1px 6px;font-size:10px;font-weight:700}
  .dir.in{background:#DCFCE7;color:#166534}.dir.out{background:#FEE2E2;color:#991B1B}
  .tot{margin-top:6px;text-align:left;font-weight:700;font-size:12px}
  .notes{margin-top:10px;font-size:12px}
  .sign{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:34px}
  .sign .s{border-top:1.5px solid ${BRAND.ink};padding-top:6px;text-align:center;font-weight:700;font-size:12px}
  .ft{margin-top:20px;border-top:1px solid ${BRAND.border};padding-top:8px;text-align:center;font-size:10px;color:${BRAND.textFaint}}
  @media print{body{background:#fff}.page{margin:0}@page{size:A4;margin:0}}
</style></head>
<body><div class="page">
  <div class="hd"><img src="${logoUrl()}" alt=""><div class="co">${esc(CO.name)}<small>${esc(CO.sub)}</small></div></div>
  <div class="title"><span class="band">سند ${esc(TYPE_AR[note.noteType])}</span></div>
  <div class="meta">
    <div class="box"><b>المودِع:</b> ${esc(note.consignorName)}${note.consignorPhone ? ` — ${esc(note.consignorPhone)}` : ""}</div>
    <div class="box"><b>رقم السند:</b> <span class="mono">${esc(note.noteNumber)}</span> · <b>التاريخ:</b> ${dateStr}</div>
  </div>
  <table>
    <thead><tr><th class="c">#</th>${showDir ? '<th class="c">الاتجاه</th>' : ""}<th>الصنف</th><th>الرمز</th><th class="c">الكمية</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="tot">إجمالي القطع (بالوحدة الأساس): ${showDir ? `صافي ${totalBase}` : Math.abs(totalBase)}</div>
  ${note.notes ? `<div class="notes"><b>ملاحظات:</b> ${esc(note.notes)}</div>` : ""}
  <div class="sign"><div class="s">أمين المخزن / المستلِم</div><div class="s">المودِع</div></div>
  <div class="ft">هذه البضاعة أمانة برسم البيع — ملكيتها للمودِع حتى بيعها · ${esc(CO.footerLine)}</div>
</div>
<script>window.onload=function(){setTimeout(function(){window.print()},300)}</script>
</body></html>`;
  return openPrintWindow(html);
}
