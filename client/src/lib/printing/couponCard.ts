import { BRAND, CAIRO_FONT, CO, esc, logoUrl } from "./brand";
import { qrCodeSvg } from "./qr";

export const COUPON_CARD_SIZE = { widthMm: 54, heightMm: 84 } as const;

export interface CouponCardData {
  code: string;
  title?: string | null;
  subtitle?: string | null;
  terms?: string | null;
  validTo?: string | Date | null;
  color?: string | null;
}

function validDate(value: string | Date | null | undefined) {
  if (!value) return "حتى نفاد/انتهاء الحملة";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value).slice(0, 10) : date.toLocaleDateString("ar-IQ-u-nu-latn");
}

export async function couponCardsHtml(cards: CouponCardData[]): Promise<string> {
  if (!cards.length) throw new Error("لا توجد كوبونات للطباعة");
  const rendered = await Promise.all(cards.map(async (card) => {
    const accent = /^#[0-9a-fA-F]{6}$/.test(card.color ?? "") ? card.color! : BRAND.green;
    const qr = await qrCodeSvg(card.code, { size: 220, margin: 1, errorCorrectionLevel: "H", dark: "#000000" });
    return `<article class="coupon" style="--accent:${accent}">
      <div class="frame">
        <header><img src="${esc(logoUrl())}" alt=""><div><strong>${esc(CO.short)}</strong><small>${esc(CO.subtitle)}</small></div></header>
        <div class="rule"></div>
        <main>
          <div class="eyebrow">كوبون خصم</div>
          <h1>${esc(card.title || "هدية خاصة لك")}</h1>
          ${card.subtitle ? `<p class="subtitle">${esc(card.subtitle)}</p>` : ""}
          <div class="qr">${qr}</div>
          <div class="code" dir="ltr">${esc(card.code)}</div>
          <div class="valid">صالح ${esc(validDate(card.validTo))}</div>
        </main>
        <footer>${esc(card.terms || "يُستخدم وفق شروط العرض، ولمرة واحدة ما لم يُذكر خلاف ذلك.")}</footer>
      </div>
    </article>`;
  }));
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>كوبونات CRM — 54×84mm</title>${CAIRO_FONT}<style>
    @page{size:54mm 84mm;margin:0}
    *{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff;font-family:'Cairo',Arial,sans-serif;color:#111}
    .coupon{width:54mm;height:84mm;overflow:hidden;page-break-after:always;break-after:page;padding:2.2mm;background:linear-gradient(145deg,#fff 0%,#fff 65%,color-mix(in srgb,var(--accent) 8%,#fff) 100%)}
    .coupon:last-child{page-break-after:auto;break-after:auto}.frame{height:100%;border:.45mm solid var(--accent);border-radius:2.4mm;padding:2.2mm;display:flex;flex-direction:column;position:relative}
    .frame:after{content:'';position:absolute;inset:1.1mm;border:.18mm solid color-mix(in srgb,var(--accent) 32%,transparent);border-radius:1.7mm;pointer-events:none}
    header{display:flex;align-items:center;gap:1.6mm;min-height:9mm;position:relative;z-index:1}header img{width:8mm;height:8mm;object-fit:contain}header div{display:flex;flex-direction:column;line-height:1.15}header strong{font-size:3mm;color:var(--accent)}header small{font-size:1.7mm}
    .rule{height:.4mm;background:var(--accent);margin:1mm 0 1.4mm}main{text-align:center;display:flex;flex-direction:column;align-items:center;flex:1;position:relative;z-index:1}.eyebrow{font-size:2mm;font-weight:800;color:var(--accent);letter-spacing:.3mm}h1{font-size:4.2mm;line-height:1.25;margin:1mm 0 .7mm}.subtitle{font-size:2.05mm;line-height:1.4;margin:0;min-height:4mm}.qr{width:25mm;height:25mm;margin:1.4mm auto .8mm}.qr svg{display:block;width:100%;height:100%}.code{font-family:ui-monospace,Consolas,monospace;font-size:3.1mm;font-weight:900;letter-spacing:.2mm;border:.3mm dashed var(--accent);border-radius:1mm;padding:.8mm 1.3mm;background:#fff}.valid{font-size:1.8mm;margin-top:.8mm;font-weight:700}
    footer{border-top:.2mm solid #bbb;padding-top:1.2mm;font-size:1.55mm;line-height:1.45;text-align:center;min-height:8mm;position:relative;z-index:1}
    @media screen{body{background:#ddd;padding:10mm}.coupon{margin:0 auto 8mm;box-shadow:0 2mm 8mm #0003}}
    @media print{body{background:#fff}.coupon{margin:0;box-shadow:none}}
  </style></head><body>${rendered.join("")}<script>Promise.all(Array.from(document.images).map(i=>i.complete?Promise.resolve():new Promise(r=>{i.onload=i.onerror=r}))).then(()=>setTimeout(()=>window.print(),100));window.addEventListener('afterprint',()=>window.close());</script></body></html>`;
}

/** يفتح النافذة فور النقر ثم يملؤها بعد توليد QR، كي لا يحجبها المتصفح. */
export async function printCouponCards(cards: CouponCardData[]): Promise<boolean> {
  if (typeof window === "undefined") return false;
  const win = window.open("", "_blank", "width=520,height=820");
  if (!win) return false;
  win.document.write('<p dir="rtl" style="font-family:sans-serif;padding:2rem">جارٍ تجهيز الكوبونات…</p>');
  try {
    const html = await couponCardsHtml(cards);
    win.document.open(); win.document.write(html); win.document.close(); win.focus();
    return true;
  } catch (error) {
    win.close();
    throw error;
  }
}
