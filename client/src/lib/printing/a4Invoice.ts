// فاتورة A4 رسمية (للحكومة/الشركات) — تُطبع عبر المتصفّح (تشكيل عربي مثالي + «حفظ كـPDF»).
// نُفضّلها على @react-pdf/renderer لأنّ الأخير لا يصل/يشكّل الحروف العربية صحيحاً.
import { CAIRO_FONT } from "./brand";

export type A4InvoiceItem = {
  productName: string;
  unitName?: string | null;
  quantity: string | number;
  unitPrice: string | number;
  total: string | number;
};
export type A4Invoice = {
  invoiceNumber: string;
  invoiceDate?: string | Date | null;
  customerName?: string | null;
  subtotal: string | number;
  discountAmount?: string | number | null;
  taxAmount?: string | number | null;
  total: string | number;
  paidAmount?: string | number | null;
  items: A4InvoiceItem[];
};

const SHOP = "الرؤية العربية للتجارة العامة — المكتبة العربية للطباعة والقرطاسية";
const money = (v: string | number | null | undefined) =>
  Number(v ?? 0).toLocaleString("ar-IQ-u-nu-latn", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

function buildHtml(inv: A4Invoice): string {
  const remaining = Number(inv.total ?? 0) - Number(inv.paidAmount ?? 0);
  const date = inv.invoiceDate ? new Date(inv.invoiceDate).toLocaleString("ar-IQ-u-nu-latn") : new Date().toLocaleString("ar-IQ-u-nu-latn");
  const rows = inv.items
    .map(
      (it, i) => `<tr>
      <td class="c">${i + 1}</td>
      <td>${esc(it.productName)}${it.unitName ? ` <span class="u">(${esc(it.unitName)})</span>` : ""}</td>
      <td class="c">${esc(it.quantity)}</td>
      <td class="l">${money(it.unitPrice)}</td>
      <td class="l">${money(it.total)}</td>
    </tr>`,
    )
    .join("");
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<title>فاتورة ${esc(inv.invoiceNumber)}</title>
${CAIRO_FONT}
<style>
  *{box-sizing:border-box}
  body{font-family:'Cairo',system-ui,sans-serif;color:#111;margin:0;padding:0}
  @page{size:A4;margin:15mm}
  .head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #111;padding-bottom:10px;margin-bottom:14px}
  .shop{font-size:15px;font-weight:700;max-width:60%}
  .title{font-size:22px;font-weight:700}
  .meta{font-size:12px;color:#444;line-height:1.9;text-align:left}
  .meta b{color:#111}
  .cust{margin:10px 0 14px;font-size:13px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{border:1px solid #ccc;padding:7px 8px;text-align:right}
  th{background:#f3f4f6;font-weight:600}
  td.c,th.c{text-align:center}
  td.l,th.l{text-align:left;font-variant-numeric:tabular-nums}
  .u{color:#666;font-size:11px}
  .totals{margin-top:14px;margin-inline-start:auto;width:46%;font-size:13px}
  .totals .row{display:flex;justify-content:space-between;padding:5px 2px;border-bottom:1px dashed #ddd}
  .totals .grand{font-weight:700;font-size:15px;border-bottom:2px solid #111}
  .l-num{font-variant-numeric:tabular-nums;direction:ltr}
  .sign{display:flex;justify-content:space-between;margin-top:48px;font-size:12px;color:#333}
  .sign div{width:40%;border-top:1px solid #999;padding-top:6px;text-align:center}
  .foot{margin-top:20px;text-align:center;color:#666;font-size:11px}
</style></head><body>
  <div class="head">
    <div class="shop">${SHOP}</div>
    <div style="text-align:left">
      <div class="title">فاتورة</div>
      <div class="meta">رقم: <b>${esc(inv.invoiceNumber)}</b><br>التاريخ: ${esc(date)}</div>
    </div>
  </div>
  <div class="cust">العميل: <b>${esc(inv.customerName ?? "عميل عابر")}</b></div>
  <table>
    <thead><tr><th class="c">#</th><th>الصنف</th><th class="c">الكمية</th><th class="l">السعر</th><th class="l">الإجمالي</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="totals">
    <div class="row"><span>المجموع قبل الخصم/الضريبة</span><span class="l-num">${money(inv.subtotal)}</span></div>
    ${Number(inv.discountAmount ?? 0) > 0 ? `<div class="row"><span>الخصم</span><span class="l-num">${money(inv.discountAmount)}</span></div>` : ""}
    ${Number(inv.taxAmount ?? 0) > 0 ? `<div class="row"><span>الضريبة</span><span class="l-num">${money(inv.taxAmount)}</span></div>` : ""}
    <div class="row grand"><span>الإجمالي</span><span class="l-num">${money(inv.total)} د.ع</span></div>
    <div class="row"><span>المدفوع</span><span class="l-num">${money(inv.paidAmount)}</span></div>
    <div class="row"><span>المتبقّي</span><span class="l-num">${money(remaining)}</span></div>
  </div>
  <div class="sign"><div>توقيع المستلم</div><div>ختم وتوقيع الشركة</div></div>
  <div class="foot">شكراً لتعاملكم معنا — ${SHOP}</div>
</body></html>`;
}

/** يفتح طباعة فاتورة A4 عبر iframe مخفيّ (لا يغادر الصفحة الحالية). */
export function printA4Invoice(inv: A4Invoice): void {
  const html = buildHtml(inv);
  const iframe = document.createElement("iframe");
  iframe.style.position = "fixed";
  iframe.style.right = "-9999px";
  iframe.style.width = "0";
  iframe.style.height = "0";
  document.body.appendChild(iframe);
  const doc = iframe.contentWindow?.document;
  if (!doc) { document.body.removeChild(iframe); return; }
  doc.open();
  doc.write(html);
  doc.close();
  // مهلة لتحميل الخط قبل الطباعة، ثم تنظيف.
  const w = iframe.contentWindow!;
  const fire = () => {
    try { w.focus(); w.print(); } catch { /* تجاهل */ }
    setTimeout(() => { try { document.body.removeChild(iframe); } catch { /* */ } }, 1000);
  };
  setTimeout(fire, 600);
}
