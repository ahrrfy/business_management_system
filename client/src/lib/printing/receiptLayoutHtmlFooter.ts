import { CO, RECEIPT_PHONES, esc } from "./brand";
import type { ReceiptBrowserData } from "./printTemplates";
import {
  receiptStorefrontModel,
  receiptStorefrontSvg,
} from "./receiptStorefront";

export function receiptFooterHtml(data: ReceiptBrowserData): string {
  const store = receiptStorefrontModel();
  const contacts = RECEIPT_PHONES.map(
    (contact) =>
      `<div><div>${esc(contact.l)}</div><b dir="ltr">${esc(contact.n)}</b></div>`,
  ).join("");
  const coupon = data.bounceBackCoupon;
  return `<style>
    .receipt-footer{text-align:center;font-weight:800;border-top:0.2mm solid #000;padding-top:1mm;line-height:1.35}
    .receipt-storefront-qr{margin:1mm auto;width:${store.sizeMm.toFixed(3)}mm;height:${store.sizeMm.toFixed(3)}mm}
    .receipt-storefront-qr svg{display:block;width:100%;height:100%}
    .receipt-contacts{display:grid;grid-template-columns:1fr 1fr;gap:0.5mm 2mm;margin:1mm 0;font-size:8.5px}
    .receipt-contacts b{display:block;font-size:10px;unicode-bidi:isolate}
    .receipt-policy{border-top:0.2mm dashed #000;padding-top:1mm;margin-top:1mm;font-size:8.5px}
    .receipt-coupon{border-top:0.2mm dashed #000;margin-top:1mm;padding-top:1mm;overflow-wrap:anywhere}
  </style><footer class="receipt-footer">
    <div>شكراً لتسوقكم معنا</div>
    <div class="receipt-storefront-qr">${receiptStorefrontSvg()}</div>
    <div style="font-size:9px">امسح الرمز للتسوق عبر متجرنا الإلكتروني</div>
    <div dir="ltr" style="font-size:9.5px;unicode-bidi:isolate">${esc(store.displayUrl)}</div>
    ${contacts ? `<div class="receipt-contacts">${contacts}</div>` : ""}
    <div style="font-size:8.5px">${esc(CO.address)}</div>
    <div class="receipt-policy">نعتذر عن قبول الاسترجاع — والاستبدال متاح<br>خلال 48 ساعة بشرط سلامة المنتج بـ100%</div>
    ${
      coupon
        ? `<div class="receipt-coupon">
      <div>${esc(coupon.headline)}</div><b>خصم ${esc(coupon.discountText)}</b>
      <div dir="ltr" style="font-size:12px">${esc(coupon.code)}</div>
      ${coupon.minSpendText ? `<div>${esc(coupon.minSpendText)}</div>` : ""}
      <div>${esc(coupon.validToText)}</div>
      <div style="font-size:8.5px">احتفظ بهذه القسيمة وقدّمها للكاشير في زيارتك القادمة</div>
    </div>`
        : ""
    }
  </footer>`;
}
