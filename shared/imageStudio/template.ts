/**
 * القالب البيتيّ (house style) لاستوديو صور المنتجات — النواة الحتميّة المشتركة (عميل + خادم).
 *
 * جوهر «المظهر الاحترافي» ليس فلتراً على صورة واحدة بل **قالبٌ موحّد** يُطبَّق على كل الكتالوج:
 * قماش مربّع، خلفية بيضاء نقيّة (قرار المالك ٣)، حجم منتج موحّد ضمن منطقة آمنة، وظلّ تماس حتميّ.
 * دوالٌّ نقيّة (بلا DOM/canvas) ⇒ قابلة للفحص، ويستهلكها راسم العميل (freePipeline).
 * راجع docs/product-image-studio-design-2026-07-21.md §٥.
 */

/** نسخة القالب — تُخزَّن في stylePresetVersion؛ رفعها يُوسم لإعادة المعالجة (لا يُعاد تلقائياً). */
export const STUDIO_TEMPLATE_VERSION = 1;

export const STUDIO_TEMPLATE = {
  version: STUDIO_TEMPLATE_VERSION,
  /** قماش مربّع (px) — الأساس. المشتقّات أدناه. */
  canvasSize: 1600,
  /** خلفية بيضاء نقيّة (قرار المالك ٣ — لا مشاهد مولَّدة). */
  background: "#FFFFFF",
  /** أكبر بُعد للمنتج = هذه النسبة من القماش ⇒ هامش موحّد (~٩٪) وحجمٌ ثابت عبر الكتالوج. */
  productMaxRatio: 0.82,
  /** ظلّ تماس بيضاويّ أسفل-وسط، حتميّ (معاملات ثابتة). */
  shadow: {
    opacity: 0.18,
    /** عرض البيضاوي = هذه النسبة من عرض المنتج. */
    widthRatio: 0.72,
    /** ارتفاع البيضاوي = هذه النسبة من عرض المنتج (مسطّح). */
    heightRatio: 0.08,
    /** نصف قطر تمويه الظلّ = هذه النسبة من القماش. */
    blurRatio: 0.03,
    /** فجوة بين قاع المنتج وحافة الظلّ العليا = هذه النسبة من القماش. */
    gapRatio: 0.01,
  },
  /** مقاسات العرض المشتقّة (px، مربّعة): بطاقة/قائمة/مصغّرة عرض. */
  derivedSizes: [1200, 600, 240],
  /** مقاس مصغّرة الـDB (px) — شبكة أمان العرض، تبقى في MySQL. */
  thumbSize: 64,
} as const;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Ellipse {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

/**
 * مستطيل وضع المنتج داخل قماش مربّع: مُحافظ على النسبة، مركزيّ، **أكبر بُعد = productMaxRatio×canvas**
 * (يصغّر أو يكبّر ⇒ حجم منتج موحّد عبر الكتالوج — جوهر القالب). يرمي على أبعاد مصدرٍ غير صحيحة.
 */
export function computeProductRect(
  srcW: number,
  srcH: number,
  canvasSize: number = STUDIO_TEMPLATE.canvasSize,
  maxRatio: number = STUDIO_TEMPLATE.productMaxRatio,
): Rect {
  if (!(srcW > 0) || !(srcH > 0)) throw new Error("computeProductRect: أبعاد مصدر غير صحيحة");
  const target = canvasSize * maxRatio;
  const scale = target / Math.max(srcW, srcH); // أكبر بُعد ⇒ target
  const width = srcW * scale;
  const height = srcH * scale;
  return { x: (canvasSize - width) / 2, y: (canvasSize - height) / 2, width, height };
}

/**
 * ظلّ التماس البيضاويّ أسفل مستطيل المنتج (حتميّ): مركزيّ أفقياً، حافته العليا أسفل قاع المنتج بفجوة.
 * يُشتقّ من صندوق الإحاطة لا يُخترَع (يحفظ أمانة «الوضع على سطح» بلا توليد).
 */
export function computeShadowEllipse(
  rect: Rect,
  canvasSize: number = STUDIO_TEMPLATE.canvasSize,
  cfg: { widthRatio: number; heightRatio: number; gapRatio: number } = STUDIO_TEMPLATE.shadow,
): Ellipse {
  const rx = (rect.width * cfg.widthRatio) / 2;
  const ry = (rect.width * cfg.heightRatio) / 2;
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height + canvasSize * cfg.gapRatio + ry;
  return { cx, cy, rx, ry };
}
