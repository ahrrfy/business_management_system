import { BRAND, CAIRO_FONT, CO, esc, logoUrl } from "./brand";
import { fmtDate } from "../date";
import { qrCodeSvg } from "./qr";
import { publicStorefrontUrl } from "../siteHosts";

export const COUPON_CARD_SIZE = { widthMm: 54, heightMm: 84 } as const;
/** المساحة القصوى المطلوبة للرمز المقروء بشرياً — لا تشمل QR المنفصل. */
export const COUPON_CODE_FIELD_SIZE = { widthMm: 40, heightMm: 8 } as const;

export type CouponPrintLayout = "CARD" | "A4";

export interface CouponCardData {
  code: string;
  title?: string | null;
  subtitle?: string | null;
  heroDiscount?: string | null;
  discountCap?: string | null;
  minSpend?: string | null;
  terms?: string | null;
  validTo?: string | Date | null;
  activeDaysText?: string | null;
  color?: string | null;
  storeUrl?: string | null;
}

function validDate(value: string | Date | null | undefined) {
  if (!value) return "صالح حتى نفاد/انتهاء الحملة";
  const date = value instanceof Date ? value : new Date(value);
  const formatted = Number.isNaN(date.getTime()) ? String(value).slice(0, 10) : fmtDate(date);
  return `صالح لغاية ${formatted}`;
}

function termsAdaptiveStyle(termsText: string): string {
  const len = termsText.length;
  if (len > 200) return "font-size:1.1mm;line-height:1.15";
  if (len > 120) return "font-size:1.25mm;line-height:1.2";
  if (len > 60) return "font-size:1.4mm;line-height:1.25";
  return "font-size:1.55mm;line-height:1.3";
}

export async function couponCardsHtml(
  cards: CouponCardData[],
  options: { layout?: CouponPrintLayout } = {},
): Promise<string> {
  if (!cards.length) throw new Error("لا توجد كوبونات للطباعة");
  const layout = options.layout ?? "CARD";
  const rendered = await Promise.all(cards.map(async (card) => {
    const accent = /^#[0-9a-fA-F]{6}$/.test(card.color ?? "") ? card.color! : BRAND.green;
    const trimmedCode = card.code.trim();
    const qrPayload = card.storeUrl?.trim() || publicStorefrontUrl(trimmedCode);
    const qr = await qrCodeSvg(qrPayload, { size: 220, margin: 1, errorCorrectionLevel: "H", dark: "#000000" });
    const termsContent = card.terms?.trim() || "يُستخدم وفق شروط العرض، ولمرة واحدة ما لم يُذكر خلاف ذلك.";
    const termsStyle = termsAdaptiveStyle(termsContent);
    return `<article class="coupon" style="--accent:${accent}">
      <div class="frame">
        <header><img src="${esc(logoUrl())}" alt=""><div><strong>${esc(CO.short)}</strong><small>${esc(CO.subtitle)}</small></div></header>
        <div class="rule"></div>
        <main>
          <div class="eyebrow">قسيمة خصم رسمية</div>
          <h1>${esc(card.title || "عرض ترويجي حصري")}</h1>
          ${card.heroDiscount ? `<div class="hero-discount">${esc(card.heroDiscount)}</div>` : ""}
          ${card.discountCap ? `<div class="discount-cap">${esc(card.discountCap)}</div>` : ""}
          ${card.minSpend ? `<div class="min-spend">${esc(card.minSpend)}</div>` : ""}
          ${card.activeDaysText ? `<div class="active-days">${esc(card.activeDaysText)}</div>` : ""}
          ${card.subtitle && card.subtitle !== card.heroDiscount && card.subtitle !== card.title ? `<p class="subtitle">${esc(card.subtitle)}</p>` : ""}
          <div class="qr">${qr}</div>
          <div class="code" dir="ltr">${esc(card.code)}</div>
          <div class="valid">${esc(validDate(card.validTo))}</div>
        </main>
        <footer style="${termsStyle}">${esc(termsContent)}</footer>
      </div>
    </article>`;
  }));
  const body = layout === "A4"
    ? Array.from({ length: Math.ceil(rendered.length / 9) }, (_, page) =>
        `<section class="sheet">${rendered.slice(page * 9, page * 9 + 9).join("")}</section>`,
      ).join("")
    : rendered.join("");
  const pageCss = layout === "A4"
    ? "@page{size:A4 portrait;margin:18.5mm 20mm}"
    : "@page{size:54mm 84mm;margin:0}";
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>كوبونات CRM — ${layout === "A4" ? "A4 3×3" : "54×84mm"}</title>${CAIRO_FONT}<style>
    ${pageCss}
    *{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff;font-family:'Cairo',Arial,sans-serif;color:#111}
    .sheet{width:170mm;height:260mm;display:grid;grid-template-columns:repeat(3,54mm);grid-template-rows:repeat(3,84mm);gap:4mm;break-after:page;page-break-after:always}.sheet:last-child{break-after:auto;page-break-after:auto}
    .coupon{width:54mm;height:84mm;overflow:hidden;padding:1.6mm;background:linear-gradient(145deg,#fff 0%,#fff 65%,color-mix(in srgb,var(--accent) 8%,#fff) 100%)}
    body:not(:has(.sheet))>.coupon{page-break-after:always;break-after:page}body:not(:has(.sheet))>.coupon:last-child{page-break-after:auto;break-after:auto}.frame{height:100%;border:.4mm solid var(--accent);border-radius:2mm;padding:1.6mm;display:flex;flex-direction:column;position:relative}
    .frame:after{content:'';position:absolute;inset:.8mm;border:.15mm solid color-mix(in srgb,var(--accent) 30%,transparent);border-radius:1.5mm;pointer-events:none}
    header{display:flex;align-items:center;gap:1.4mm;min-height:7.5mm;position:relative;z-index:1}header img{width:6.5mm;height:6.5mm;object-fit:contain}header div{display:flex;flex-direction:column;line-height:1.15}header strong{font-size:2.9mm;font-weight:900;color:var(--accent)}header small{font-size:1.7mm;font-weight:800;color:#111}
    .rule{height:.35mm;background:var(--accent);margin:.6mm 0 .8mm}main{text-align:center;display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;min-height:0;position:relative;z-index:1}.eyebrow{font-size:1.9mm;font-weight:900;color:var(--accent);letter-spacing:.25mm;line-height:1}h1{font-size:3.3mm;line-height:1.2;margin:.5mm 0 .3mm;font-weight:900;color:#000;max-height:6.5mm;overflow:hidden}.hero-discount{font-size:3.4mm;font-weight:900;color:#000;line-height:1.1;margin:.3mm 0;padding:.35mm 1.8mm;border-radius:.8mm;background:color-mix(in srgb,var(--accent) 15%,#fff);border:.25mm solid color-mix(in srgb,var(--accent) 45%,#000)}.discount-cap{font-size:1.7mm;font-weight:900;color:#000;margin:.2mm 0;line-height:1.1}.min-spend{font-size:1.7mm;font-weight:800;color:#111;margin:.2mm 0;line-height:1.1}.active-days{font-size:1.7mm;font-weight:900;color:var(--accent);margin:.2mm 0;line-height:1.1}.subtitle{font-size:1.8mm;line-height:1.2;margin:.2mm 0;max-height:3.6mm;overflow:hidden;font-weight:700;color:#222}.qr{width:21mm;height:21mm;margin:.7mm auto .5mm}.qr svg{display:block;width:100%;height:100%}.code{width:40mm;height:8mm;max-width:40mm;max-height:8mm;display:flex;align-items:center;justify-content:center;white-space:nowrap;overflow:hidden;font-family:ui-monospace,Consolas,monospace;font-size:3.2mm;line-height:1;font-weight:900;letter-spacing:.18mm;border:.35mm dashed var(--accent);border-radius:1mm;padding:0 1mm;background:#fff;color:#000}.valid{font-size:1.7mm;margin-top:.6mm;font-weight:800;color:#000;line-height:1}
    footer{border-top:.25mm solid color-mix(in srgb,var(--accent) 30%,#aaa);padding-top:.8mm;text-align:center;word-break:break-word;position:relative;z-index:1;font-weight:700;color:#111}
    @media screen{body{background:#ddd;padding:10mm}.coupon{box-shadow:0 2mm 8mm #0003}body:not(:has(.sheet))>.coupon{margin:0 auto 8mm}.sheet{margin:0 auto 10mm;background:#fff}}
    @media print{body{background:#fff}.coupon{margin:0;box-shadow:none}.sheet{margin:0}}
  </style></head><body>${body}<script>Promise.all(Array.from(document.images).map(i=>i.complete?Promise.resolve():new Promise(r=>{i.onload=i.onerror=r}))).then(()=>setTimeout(()=>window.print(),100));window.addEventListener('afterprint',()=>window.close());</script></body></html>`;
}

/** يفتح النافذة فور النقر ثم يملؤها بعد توليد QR، كي لا يحجبها المتصفح. */
export async function printCouponCards(
  cards: CouponCardData[],
  options: { layout?: CouponPrintLayout } = {},
): Promise<boolean> {
  if (typeof window === "undefined") return false;
  const win = window.open("", "_blank", "width=520,height=820");
  if (!win) return false;
  win.document.write('<p dir="rtl" style="font-family:sans-serif;padding:2rem">جارٍ تجهيز الكوبونات…</p>');
  try {
    const html = await couponCardsHtml(cards, options);
    win.document.open(); win.document.write(html); win.document.close(); win.focus();
    return true;
  } catch (error) {
    win.close();
    throw error;
  }
}
