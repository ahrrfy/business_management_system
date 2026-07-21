// مصدر الحقيقة الوحيد لتصميم ملصق الباركود المتّجه — يُستعمل في الطباعة المباشرة (نافذة المتصفّح/
// تعريف Windows) وفي المعاينة الحيّة على الشاشة، فلا يتفاوت الشكل بين المعاينة والمطبوع.
//
// التخطيط الرأسيّ (أيّ جزءٍ يظهر وبأيّ حجم) يُحسَب في `labelLayout.solveLabelLayout` — **مصدر
// واحد مشترك مع المسار الحراريّ** (§٥). هنا نحوّل قرار الحلّال إلى HTML/SVG فقط. لا يعتمد هذا
// المسار على `overflow:hidden` ليُخفي الفائض (كان يَقُصّ الاسم صامتاً)؛ الحلّال يضمن الملاءمة،
// ويُسقط الأجزاء صراحةً حسب سُلَّم الأولوية فلا يُطبع جزءٌ مبتور.
//
// مبادئ التصميم (وفق طلب المالك):
//  • **تصميم متّجه مباشر** — HTML + SVG، بلا أيّ تحويل إلى صورة نقطية قبل الطباعة.
//  • **ديناميكيّ على طول اسم المنتج ومقاس الملصق** — حجم الخطوط وارتفاع الباركود يتكيّفان معاً.
//  • **الاسم والباركود مفصولان** بكتلٍ وفراغٍ صريح — **بلا خطوط رفيعة** تَضيع في الطباعة الحرارية.
//  • **خطوط ثقيلة فقط** (700–900) — لا كتابة ناعمة/رفيعة.
import { CAIRO_FONT, esc, fmtC } from "./brand";
import { code128Svg } from "./barcode";
import { attrsLineText } from "./labelItem";
import { type LabelRenderItem, type LabelRenderOpts } from "./labelRaster";
import { type LabelSize } from "./labelSize";
import { GAP_MM, PAD_Y_MM, labelContentOf, solveLabelLayout } from "./labelLayout";

/** يتحقّق من لون HEX «#RRGGBB» فقط (يمنع حقن CSS عبر قيمة colorHex) — وإلّا لا لون. */
function safeHex(hex?: string | null): string | null {
  return hex && /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : null;
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
 * HTML الداخليّ لملصق واحد (محتوى div.lbl). الأحجام والإظهار كلّها من `solveLabelLayout` (مضمّنة
 * سطريّاً لأنّها تُحسَب لكلّ منتج حسب طول اسمه ومقاس الملصق). التخطيط: [اسم اختياريّ] ← [قضبان
 * Code128 بارتفاعٍ محسوب] ← [أرقام الباركود اختيارية] ← [صفّ سفليّ: الرمز/الشارة | السعر].
 */
function labelInnerHtml(item: LabelRenderItem, size: LabelSize, opts: LabelRenderOpts = {}): string {
  const L = solveLabelLayout(size, labelContentOf(item), { name: opts.showName, price: opts.showPrice });

  // الاسم: تخطيطٌ **منظّم** (اسمٌ أساس بارز + سطر «اللون · القياس · الوحدة» + رمز لون) حين يتّسع
  // المقاس، وإلّا الاسم **المدموج** (اللون/القياس فيه ⇒ بلا فقد). `-webkit-line-clamp` مقيَّد بعدد
  // الحلّال المحجوز كي لا يتجاوز المرسومُ المساحةَ المحجوزة فيتراكب مع الباركود على الملصق الضيّق.
  let nameHtml = "";
  if (L.name.show) {
    if (L.name.structured && item.attrs) {
      const a = item.attrs;
      nameHtml = `<div class="lbl-nm" style="font-size:${L.name.fsPt}pt;-webkit-line-clamp:${L.name.lines}">${esc(a.baseName)}</div>`;
      if (L.attrs.show) {
        const hex = safeHex(a.colorHex);
        // رمز اللون: دائرة بحدٍّ أسود مملوءة بلون بنك الألوان — تظهر ملوّنة في المعاينة/الطابعة
        // الملوّنة، وتُطبع دائرةً محدَّدة (علامة) على الحراريّ الأحادي.
        const swatch = hex ? `<span class="lbl-sw" style="background:${hex}"></span>` : "";
        const line = attrsLineText(a);
        nameHtml += `<div class="lbl-at" style="font-size:${L.attrs.fsPt}pt">${swatch}${line ? `<span>${esc(line)}</span>` : ""}</div>`;
      }
    } else {
      nameHtml = `<div class="lbl-nm" style="font-size:${L.name.fsPt}pt;-webkit-line-clamp:${L.name.lines}">${esc(item.name)}</div>`;
    }
  }

  const bc = barcodeSvg(item.barcode);
  const bcHtml = bc && L.barcode.show ? `<div class="lbl-bc" style="height:${L.barcode.heightMm}mm">${bc}</div>` : "";
  const bnHtml = L.digits.show ? `<div class="lbl-bn" style="font-size:${L.digits.fsPt}pt">${esc(item.barcode)}</div>` : "";

  // الصفّ السفليّ = مجموعتان: [الرمز + شارة الفئة] يميناً | [السعر القديم مشطوباً + السعر] يساراً.
  const b = L.bottom;
  const skuHtml = b.showSku && item.sku ? `<span class="lbl-sk" style="font-size:${b.secFsPt}pt">${esc(item.sku)}</span>` : "";
  const tierHtml =
    b.showTier && item.tierLabel ? `<span class="lbl-tr" style="font-size:${b.secFsPt}pt">${esc(item.tierLabel)}</span>` : "";
  const startHtml = skuHtml || tierHtml ? `<span class="lbl-gp">${skuHtml}${tierHtml}</span>` : "";

  // السعر القديم يُطبع مشطوباً **فقط** مع سعرٍ فعّال أصغر منه (عرض سارٍ) — يرى الزبون قيمة الخصم.
  const showBase = b.showPrice && item.basePrice != null && item.basePrice !== "";
  const baseHtml = showBase ? `<span class="lbl-ob" style="font-size:${b.secFsPt}pt">${esc(fmtC(item.basePrice))}</span>` : "";
  const priceHtml = b.showPrice ? `<span class="lbl-pr" style="font-size:${b.priceFsPt}pt">${esc(fmtC(item.price))}</span>` : "";
  const endHtml = baseHtml || priceHtml ? `<span class="lbl-gp">${baseHtml}${priceHtml}</span>` : "";

  const bottomHtml =
    startHtml || endHtml
      ? `<div class="lbl-bt">${startHtml || "<span></span>"}${endHtml || "<span></span>"}</div>`
      : "";

  return `${nameHtml}${bcHtml}${bnHtml}${bottomHtml}`;
}

/**
 * قواعد CSS للملصق. الانتقاء بصنف `.lbl` (وأبناؤه `.lbl-*`) ⇒ قابل للحقن في وثيقة الطباعة
 * أو داخل iframe المعاينة بلا تسريب. كلّ المقاييس بالمليمتر/النقطة ⇒ مطابقة للمطبوع. الهامش
 * الرأسيّ والفراغ من الحلّال (`PAD_Y_MM`/`GAP_MM`) ⇒ الحجزُ يطابق التخطيطَ المحسوب تماماً.
 */
function labelCss(size: LabelSize): string {
  const { widthMm, heightMm } = size;
  return `
    .lbl{box-sizing:border-box;width:${widthMm}mm;height:${heightMm}mm;padding:${PAD_Y_MM}mm 1.5mm;
      display:flex;flex-direction:column;align-items:stretch;justify-content:center;gap:${GAP_MM}mm;
      overflow:hidden;font-family:'Cairo',sans-serif;color:#000;background:#fff;direction:rtl}
    .lbl *{box-sizing:border-box;margin:0;padding:0}
    .lbl-nm{font-weight:800;text-align:center;line-height:1.12;word-break:break-word;
      display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
    /* سطر الخصائص المنظّم: رمز لون + «اللون · القياس · الوحدة» في سطرٍ واحد وسطيّ. */
    .lbl-at{font-weight:600;text-align:center;line-height:1.1;display:flex;align-items:center;
      justify-content:center;gap:1mm;white-space:nowrap;overflow:hidden}
    /* رمز اللون: دائرة بحدٍّ أسود سميك (يبقى على 203dpi) مملوءة بلون بنك الألوان. */
    .lbl-sw{display:inline-block;width:2.2mm;height:2.2mm;border-radius:50%;border:0.3mm solid #000;
      flex:0 0 auto;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .lbl-bc{flex:0 0 auto;display:flex;align-items:center;justify-content:center}
    .lbl-bc svg{width:100%;height:100%;display:block}
    .lbl-bn{font-weight:700;text-align:center;line-height:1.05;letter-spacing:0.6px;
      font-variant-numeric:tabular-nums}
    .lbl-bt{display:flex;justify-content:space-between;align-items:baseline;gap:2mm;
      width:100%;line-height:1.05}
    .lbl-gp{display:inline-flex;align-items:baseline;gap:1mm;white-space:nowrap}
    /* الرمز يتقلّص ويُقصّ بـ«…» — السعر لا يتقلّص أبداً (الحقل الحرج على ملصق الرفّ). */
    .lbl-bt>.lbl-gp:first-child{min-width:0;overflow:hidden}
    .lbl-bt>.lbl-gp:last-child{flex:0 0 auto}
    .lbl-sk{font-weight:700;overflow:hidden;text-overflow:ellipsis} .lbl-pr{font-weight:900}
    /* شارة الفئة مطموسة بأسود صافٍ لا بإطارٍ رفيع: الإطار الرفيع يضيع على 203dpi الحراري. */
    .lbl-tr{font-weight:900;background:#000;color:#fff;padding:0 0.8mm;border-radius:0.5mm;
      -webkit-print-color-adjust:exact;print-color-adjust:exact}
    /* شطبٌ سميك صراحةً (~2 نقطة @203dpi) — الافتراضي شعرةٌ تختفي في الطباعة الحرارية. */
    .lbl-ob{font-weight:700;text-decoration:line-through;text-decoration-thickness:0.25mm}
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
