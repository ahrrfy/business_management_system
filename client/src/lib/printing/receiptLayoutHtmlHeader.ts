import { CO, esc, logoUrl } from "./brand";
import type { ReceiptBrowserData } from "./printTemplates";

export function receiptHeaderHtml(
  data: ReceiptBrowserData,
  barcode: string,
): string {
  return `<style>
    .receipt-brand{display:flex;align-items:center;gap:1.5mm;text-align:center;margin-bottom:1mm}
    .receipt-brand img{width:8mm;height:8mm;object-fit:contain;filter:grayscale(100%)}
    .receipt-brand div{flex:1;line-height:1.3}
    .receipt-meta{width:100%;border-collapse:collapse;font-size:10px;margin:1mm 0}
    .receipt-meta td{border:0.2mm solid #000;padding:0.5mm;overflow-wrap:anywhere}
    .receipt-barcode{text-align:center;margin:1mm 0}
    .receipt-barcode svg{max-width:100%;height:7mm}
  </style><header>
    <div class="receipt-brand"><img src="${logoUrl()}" alt="" onerror="this.style.display='none'">
      <div><b style="font-size:12px">${esc(CO.short || CO.sub)}</b><div style="font-size:9px">${esc(CO.subtitle)}</div><div style="font-size:8px">${esc(CO.name)}</div></div>
    </div>
    <div class="receipt-barcode">${barcode}</div>
    <table class="receipt-meta"><tbody>
      <tr><td>إيصال مبيعات <b dir="ltr">#${esc(data.receiptNumber)}</b></td><td dir="ltr">${esc(data.date)}${data.time ? ` · ${esc(data.time)}` : ""}</td></tr>
      ${data.cashierName || data.shiftId != null ? `<tr><td>${data.cashierName ? `الكاشير: ${esc(data.cashierName)}` : ""}</td><td>${data.shiftId != null ? `الوردية: #${data.shiftId}` : ""}</td></tr>` : ""}
      ${data.customerName ? `<tr><td colspan="2">العميل: <b>${esc(data.customerName)}</b></td></tr>` : ""}
    </tbody></table>
  </header>`;
}
