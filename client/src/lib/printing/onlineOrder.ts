import { printDoc } from "./print";
import { CAIRO_FONT, CO, esc, fmt, openPrintWindow } from "./brand";
import { fmtDateTime } from "../date";

export interface OnlineOrderPrintData {
  orderNumber: string;
  customerName: string | null;
  customerPhone: string | null;
  governorate: string | null;
  addressText: string | null;
  status: string;
  subtotal: string;
  deliveryFee: string;
  total: string;
  createdAt: Date | string;
  items: { productName: string; variantLabel: string; imageUrl: string | null; unitName: string; quantity: string; unitPrice: string; total: string }[];
}

const absoluteImage = (src: string | null): string | null => {
  if (!src) return null;
  if (/^(data:|https?:)/i.test(src)) return src;
  return typeof window === "undefined" ? src : `${window.location.origin}${src.startsWith("/") ? src : `/${src}`}`;
};

/** إيصال حراري موجز للطلب، مناسب للمراجعة السريعة أو إرفاقه بالطرد. */
export async function printOnlineOrderThermal(d: OnlineOrderPrintData): Promise<void> {
  await printDoc({
    kind: "receipt",
    title: "طلب المتجر",
    subtitle: d.orderNumber,
    meta: [
      `الزبون: ${d.customerName ?? "—"}`,
      d.customerPhone ? `الهاتف: ${d.customerPhone}` : "",
      d.addressText ? `العنوان: ${d.addressText}` : (d.governorate ? `المحافظة: ${d.governorate}` : ""),
    ].filter(Boolean),
    columns: ["الصنف", "الكمية", "المبلغ"],
    rows: d.items.map((item) => [
      `${item.productName}${item.variantLabel ? ` — ${item.variantLabel}` : ""}${item.unitName ? ` (${item.unitName})` : ""}`,
      `×${fmt(item.quantity)}`,
      fmt(item.total),
    ]),
    totals: [
      { label: "السلع", value: `${fmt(d.subtotal)} د.ع` },
      { label: "التوصيل", value: `${fmt(d.deliveryFee)} د.ع` },
      { label: "المطلوب عند الاستلام", value: `${fmt(d.total)} د.ع` },
    ],
    footer: "طلب متجر — الدفع عند الاستلام",
    barcodeSet: { barcode128: d.orderNumber, qrPayload: d.orderNumber, displayLabel: d.orderNumber },
  });
}

/** ورقة تجهيز A4: الصورة والخصائص والكمية بجانب كل صنف لتقليل خطأ الالتقاط. */
export function printOnlineOrderPreparationA4(d: OnlineOrderPrintData): void {
  const products = d.items.map((item, index) => {
    const image = absoluteImage(item.imageUrl);
    return `<article class="item">
      <div class="num">${index + 1}</div>
      ${image ? `<img src="${esc(image)}" alt="${esc(item.productName)}" />` : `<div class="no-image">لا توجد صورة</div>`}
      <div class="info"><h3>${esc(item.productName)}</h3>${item.variantLabel ? `<p class="variant">${esc(item.variantLabel)}</p>` : ""}<p>الوحدة: ${esc(item.unitName || "قطعة")}</p></div>
      <div class="qty">×${esc(fmt(item.quantity))}</div>
    </article>`;
  }).join("");
  const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>ورقة تجهيز ${esc(d.orderNumber)}</title>${CAIRO_FONT}
  <style>
    @page{size:A4 portrait;margin:10mm}*{box-sizing:border-box}body{font-family:'Cairo',sans-serif;color:#111;margin:0;font-size:12px}.head{border-bottom:3px solid #087f5b;padding-bottom:6mm;display:flex;justify-content:space-between;gap:8mm}.brand{font-size:20px;font-weight:900}.sub{color:#555;font-size:11px}.title{text-align:left}.title h1{margin:0;font-size:22px}.title p{margin:2px 0;font-weight:800}.boxes{display:grid;grid-template-columns:1fr 1fr;gap:4mm;margin:6mm 0}.box{border:1px solid #bfc8c3;border-radius:3mm;padding:4mm}.box b{display:block;color:#087f5b;margin-bottom:1mm}.customer{font-size:14px;font-weight:800}.items-title{font-size:16px;font-weight:900;margin:5mm 0 3mm}.item{display:grid;grid-template-columns:8mm 25mm 1fr 22mm;gap:4mm;align-items:center;border:1.5px solid #222;border-radius:3mm;padding:3mm;margin-bottom:3mm;break-inside:avoid}.item img,.no-image{width:25mm;height:25mm;object-fit:cover;border-radius:2mm;background:#f1f3f2}.no-image{display:grid;place-items:center;text-align:center;font-size:9px;color:#777}.num{font-size:16px;font-weight:900;text-align:center}.info h3{margin:0;font-size:14px}.info p{margin:1mm 0 0;color:#444}.variant{font-weight:900;color:#087f5b}.qty{font-size:24px;font-weight:900;text-align:center;border-right:1px dashed #aaa;padding-right:3mm}.foot{display:flex;justify-content:space-between;border-top:2px solid #111;margin-top:6mm;padding-top:4mm;font-weight:800}.cod{font-size:18px;color:#087f5b}@media print{body{print-color-adjust:exact;-webkit-print-color-adjust:exact}}
  </style></head><body><header class="head"><div><div class="brand">${esc(CO.short)}</div><div class="sub">${esc(CO.address)} · ${esc(CO.phones[1]?.n ?? CO.phones[0]?.n ?? "")}</div></div><div class="title"><h1>ورقة تجهيز الطلب</h1><p dir="ltr">${esc(d.orderNumber)}</p><p>${esc(fmtDateTime(d.createdAt))}</p></div></header>
  <section class="boxes"><div class="box"><b>بيانات المستلم</b><div class="customer">${esc(d.customerName ?? "—")}</div><div dir="ltr">${esc(d.customerPhone ?? "—")}</div></div><div class="box"><b>عنوان التسليم</b><div>${esc([d.governorate, d.addressText].filter(Boolean).join(" — ") || "—")}</div></div></section>
  <h2 class="items-title">الأصناف المطلوب تجهيزها (${d.items.length})</h2>${products}<footer class="foot"><span>الحالة: ${esc(d.status)}</span><span class="cod">المبلغ عند الاستلام: ${esc(fmt(d.total))} د.ع</span></footer>
  <script>window.addEventListener('load',()=>{(document.fonts?.ready||Promise.resolve()).then(()=>setTimeout(()=>window.print(),80))});window.addEventListener('afterprint',()=>window.close())</script></body></html>`;
  openPrintWindow(html, "width=900,height=1100");
}
