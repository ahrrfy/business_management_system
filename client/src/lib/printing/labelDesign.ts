// مصدر الحقيقة الوحيد لتصميم ملصق الباركود — يُستعمل في الطباعة المباشرة (نافذة المتصفّح/تعريف
// Windows) وفي المعاينة الحيّة على الشاشة، فلا يتفاوت الشكل بين المعاينة والمطبوع.
//
// مبادئ التصميم (وفق طلب المالك):
//  • **تصميم متّجه مباشر** — HTML + SVG، بلا أيّ تحويل إلى صورة نقطية قبل الطباعة.
//  • **ديناميكيّ على طول اسم الصنف** — حجم خطّ الاسم يتكيّف مع طوله حتى يظهر كاملاً واضحاً
//    (يلتفّ سطرين عند اللزوم)، والباركود يملأ العرض والارتفاع المتاحَين تلقائياً.
//  • **الاسم والباركود مفصولان** بكتلٍ وفراغٍ صريح — **بلا خطوط رفيعة** تَضيع في الطباعة الحرارية.
//  • **خطوط ثقيلة فقط** (700–900) — لا كتابة ناعمة/رفيعة.
//  • يبقى ضمن حدود القياس المختار (أقصاه 50×25مم = 2×1 إنش) عبر box-sizing + overflow.
import { CAIRO_FONT, esc, fmtC } from "./brand";
import { code128Svg } from "./barcode";
import { type LabelRenderItem, type LabelRenderOpts } from "./labelRaster";
import { type LabelSize } from "./labelSize";

/** معامل تصغير حسب عرض الملصق (مرجعه 50مم) — الملصقات الأضيق تأخذ خطوطاً أصغر تناسبياً. */
function widthScale(widthMm: number): number {
  return Math.min(1, Math.max(0.6, widthMm / 50));
}

/**
 * حجم خطّ اسم الصنف (نقطة) متكيّفاً مع طوله وعرض الملصق: الأسماء القصيرة كبيرة وبارزة،
 * والطويلة تصغُر تدريجياً (وتلتفّ حتى سطرين) لتبقى مقروءة بلا قصٍّ مبكّر — مع حدٍّ أدنى ثقيل واضح.
 */
function nameFontPt(name: string, widthMm: number): number {
  const n = name.trim().length;
  const base = n <= 18 ? 12 : n <= 28 ? 10 : n <= 40 ? 8.5 : 7.5;
  return Math.round(base * widthScale(widthMm) * 10) / 10;
}

/** حجم خطّ ثانويّ (أرقام الباركود/الرمز/السعر) مقيّساً بعرض الملصق وبحدٍّ أدنى واضح. */
function scaledPt(pt: number, widthMm: number, floor = 6): number {
  return Math.max(floor, Math.round(pt * widthScale(widthMm) * 10) / 10);
}

const PT_MM = 0.3528; // نقطة طباعية = 0.3528مم
/** الحجم الأساس لخطّ السعر (نقطة) قبل القياس بالعرض — كبيرٌ عمداً ليلاحظه كبار السنّ. */
const PRICE_PT = 15;

/** تقدير عدد أسطر الاسم (1 أو 2) بطوله مقابل سعة السطر — منحازٌ احترازياً للسطرين لمنع التداخل. */
function estNameLines(name: string, widthMm: number, fsPt: number): number {
  const usableW = Math.max(10, widthMm - 3); // ناقص هامشي 1.5مم
  const capChars = usableW / (fsPt * PT_MM * 0.5); // ~0.5مم عرض الحرف لكلّ نقطة (تقدير عربي محافظ)
  return name.trim().length > capChars * 0.9 ? 2 : 1;
}

/**
 * ارتفاع رسم الباركود (مم) محسوباً حتمياً من أحجامٍ مُمرَّرة (تُحسَب مرّة في labelInnerHtml):
 * يملأ ما تبقّى **بعد حجز** ارتفاع الاسم (بعدد أسطره ١ أو ٢) + أرقام الباركود + الصفّ السفليّ +
 * الفواصل ⇒ **لا يطغى الباركود على الاسم** ويتّسع دائماً للسطر الثاني. محصورٌ بحدٍّ أدنى قابلٍ
 * للمسح وحدٍّ أعلى معقول.
 */
function barcodeHeightMm(
  heightMm: number,
  p: { nameFs: number; nameLines: number; digitsPt: number; bottomPt: number },
): number {
  const usable = heightMm - 2; // ناقص هامش 1مم أعلى/أسفل
  const gaps = 1.2; // مجموع الفواصل بين الكتل
  const nameMm = p.nameLines * p.nameFs * PT_MM * 1.18;
  const digitsMm = p.digitsPt * PT_MM * 1.1;
  const bottomMm = p.bottomPt * PT_MM * 1.12;
  const bar = usable - nameMm - digitsMm - bottomMm - gaps;
  const max = Math.round(heightMm * 0.6 * 10) / 10;
  return Math.min(max, Math.max(6, Math.round(bar * 10) / 10));
}

/** قضبان Code128 متّجهة تملأ صندوقها (أثخن قضبان ممكنة). فارغ إن تعذّر ترميز القيمة. */
function barcodeSvg(barcode: string): string {
  try {
    // moduleWidth/height للـviewBox فقط؛ التمدّد الفعليّ عبر fitToBox=true (width/height=100%).
    return code128Svg(barcode, { moduleWidth: 2, height: 80, showText: false, fitToBox: true }).svg;
  } catch {
    return ""; // قيمة غير قابلة للترميز ⇒ ملصق بلا قضبان (يبقى الاسم/الرمز/السعر)
  }
}

/**
 * HTML الداخليّ لملصق واحد (محتوى div.lbl). أحجام الخطوط وارتفاع الباركود مضمّنة سطريّاً لأنّها
 * تُحسَب لكلّ صنف حسب طول اسمه. التخطيط: [اسم اختياري] ← [قضبان Code128 بارتفاعٍ محسوب يفسح
 * للاسم] ← [أرقام الباركود] ← [صفّ سفليّ: الرمز يميناً | السعر يساراً بخطٍّ كبير].
 */
function labelInnerHtml(item: LabelRenderItem, size: LabelSize, opts: LabelRenderOpts = {}): string {
  const w = size.widthMm;
  const showName = opts.showName !== false && !!item.name;
  const showPrice = opts.showPrice !== false && item.price != null && item.price !== "";

  // أحجام الخطوط تُحسَب مرّة وتُعاد استعمالها (في الحجز الرأسيّ وفي الترميز السطريّ معاً).
  const pt8 = scaledPt(8, w); // أرقام الباركود + الرمز
  const pricePt = scaledPt(PRICE_PT, w);
  const nameFs = showName ? nameFontPt(String(item.name), w) : 0;
  const nameLines = showName ? estNameLines(String(item.name), w, nameFs) : 0;
  const showBottom = showPrice || !!item.sku;
  const bottomPt = showBottom ? (showPrice ? pricePt : pt8) : 0;

  const nameHtml = showName
    ? `<div class="lbl-nm" style="font-size:${nameFs}pt">${esc(item.name)}</div>`
    : "";

  const bc = barcodeSvg(item.barcode);
  const barMm = barcodeHeightMm(size.heightMm, { nameFs, nameLines, digitsPt: pt8, bottomPt });
  const bcHtml = bc ? `<div class="lbl-bc" style="height:${barMm}mm">${bc}</div>` : "";
  const bnHtml = `<div class="lbl-bn" style="font-size:${pt8}pt">${esc(item.barcode)}</div>`;

  const skuHtml = item.sku ? `<span class="lbl-sk" style="font-size:${pt8}pt">${esc(item.sku)}</span>` : "";
  const priceHtml = showPrice
    ? `<span class="lbl-pr" style="font-size:${pricePt}pt">${esc(fmtC(item.price))}</span>`
    : "";
  const bottomHtml =
    skuHtml || priceHtml
      ? `<div class="lbl-bt">${skuHtml || "<span></span>"}${priceHtml || "<span></span>"}</div>`
      : "";

  return `${nameHtml}${bcHtml}${bnHtml}${bottomHtml}`;
}

/**
 * قواعد CSS للملصق. الانتقاء بصنف `.lbl` (وأبناؤه `.lbl-*`) ⇒ قابل للحقن في وثيقة الطباعة
 * أو داخل iframe المعاينة بلا تسريب. كلّ المقاييس بالمليمتر/النقطة ⇒ مطابقة للمطبوع.
 */
function labelCss(size: LabelSize): string {
  const { widthMm, heightMm } = size;
  return `
    .lbl{box-sizing:border-box;width:${widthMm}mm;height:${heightMm}mm;padding:1mm 1.5mm;
      display:flex;flex-direction:column;align-items:stretch;justify-content:center;gap:0.5mm;
      overflow:hidden;font-family:'Cairo',sans-serif;color:#000;background:#fff;direction:rtl}
    .lbl *{box-sizing:border-box;margin:0;padding:0}
    .lbl-nm{font-weight:800;text-align:center;line-height:1.12;word-break:break-word;
      display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
    .lbl-bc{flex:0 0 auto;display:flex;align-items:center;justify-content:center}
    .lbl-bc svg{width:100%;height:100%;display:block}
    .lbl-bn{font-weight:700;text-align:center;line-height:1.05;letter-spacing:0.6px;
      font-variant-numeric:tabular-nums}
    .lbl-bt{display:flex;justify-content:space-between;align-items:baseline;gap:2mm;
      width:100%;line-height:1.05}
    .lbl-sk{font-weight:700} .lbl-pr{font-weight:900}
  `;
}

/**
 * وثيقة HTML كاملة للملصقات. `autoPrint=true` ⇒ تَطبع تلقائياً ثم تُغلق (مسار الطباعة المباشر).
 * `autoPrint=false` ⇒ وثيقة معاينة صرفة (تُحقَن في iframe على الشاشة بنفس التصميم تماماً).
 */
export function labelDocHtml(
  items: LabelRenderItem[],
  size: LabelSize,
  opts: LabelRenderOpts = {},
  autoPrint = false,
): string {
  const { widthMm, heightMm } = size;
  const labels = items.map((it) => `<div class="lbl">${labelInnerHtml(it, size, opts)}</div>`).join("");
  const onload = autoPrint ? ` onload="window.print();setTimeout(function(){window.close()},500)"` : "";
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>ملصقات الباركود</title>
  ${CAIRO_FONT}
  <style>
    html,body{margin:0;padding:0;background:#fff;color:#000}
    body{font-family:'Cairo',sans-serif;direction:rtl}
    @page{size:${widthMm}mm ${heightMm}mm;margin:0}
    ${labelCss(size)}
    .lbl{page-break-after:always}
    .lbl:last-child{page-break-after:auto}
  </style></head>
  <body${onload}>${labels}</body></html>`;
}
