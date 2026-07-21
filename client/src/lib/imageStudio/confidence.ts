/**
 * تحليل ثقة قناع العزل ⇒ قرار CUT/FLATTEN — **قلب حواجز الأمانة الصارمة (§٥)**.
 * القاعدة الحاكمة: **عند أيّ شكّ ⇒ FLATTEN** (الأصل موسَّطاً على أبيض بلا قصّ ⇒ يستحيل أكل بكسلة
 * منتج، والانحدار في أسوأ حالة = خلفية بيضاء نظيفة لا تشويه). دالّة **نقيّة** على قناع ألفا (بلا DOM)
 * ⇒ قابلة للفحص، ويستهلكها راسم العميل (freePipeline). راجع docs/product-image-studio-design-2026-07-21.md §٥.
 */

export type StudioMode = "CUT" | "FLATTEN";

export interface ConfidenceResult {
  mode: StudioMode;
  /** 0..1 — ثقة القصّ النظيف (0 في وضع FLATTEN). */
  confidence: number;
  /** نسبة بكسلات المنتج (غير الشفّافة) من الإطار. */
  foregroundRatio: number;
  /** نسبة البكسلات الحدّية شبه-الشفّافة من بكسلات المنتج (حواف مهترئة = شكّ). */
  softEdgeRatio: number;
  /** ثقوب شفّافة محبوسة داخل المنتج (خطر محو محتوى داخليّ كنصّ عربيّ). */
  hasInternalHoles: boolean;
  /** بكسل منتج معتم يلامس حدّ الإطار (منتج مقصوص) — إشارة مراجعة، لا تُجبِر FLATTEN. */
  touchesFrame: boolean;
  /** أسباب اختيار FLATTEN (للعرض/التدقيق/طابور المراجعة). */
  reasons: string[];
}

export interface ConfidenceOptions {
  /** alpha ≤ هذه ⇒ خلفية شفّافة. */
  transparentBelow?: number;
  /** alpha ≥ هذه ⇒ منتج معتم. */
  opaqueAtLeast?: number;
  /** softEdgeRatio فوقها ⇒ FLATTEN (سلوفان/عاكس/شفّاف). */
  softEdgeMax?: number;
  /** foregroundRatio تحتها ⇒ FLATTEN (منتج ضئيل/فشل عزل). */
  minForeground?: number;
  /** foregroundRatio فوقها ⇒ FLATTEN (القناع يغطّي الإطار). */
  maxForeground?: number;
  /** نسبة الثقوب الداخلية فوقها ⇒ hasInternalHoles (تتجاهل الضوضاء). */
  internalHoleMin?: number;
  /** صنف قرطاسية (نصّ عربيّ داخليّ حسّاس) ⇒ إجبار FLATTEN (§٥ #٣). */
  forceFlatten?: boolean;
}

const DEFAULTS: Required<Omit<ConfidenceOptions, "forceFlatten">> = {
  transparentBelow: 32,
  opaqueAtLeast: 224,
  softEdgeMax: 0.35,
  minForeground: 0.03,
  maxForeground: 0.92,
  internalHoleMin: 0.005,
};

/**
 * يحلّل قناع الألفا طوبولوجياً: ثقوب شفّافة داخلية (غير موصولة بحدّ الإطار عبر flood-fill من الحدود)
 * + ملامسة بكسل معتم للإطار. O(w×h).
 */
function analyzeTopology(
  alpha: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  transparentBelow: number,
  opaqueAtLeast: number,
): { internalHoleRatio: number; touchesFrame: boolean } {
  const total = width * height;
  const isTransparent = (i: number) => alpha[i] <= transparentBelow;
  const visited = new Uint8Array(total);
  const stack: number[] = [];
  const pushIf = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = y * width + x;
    if (!visited[i] && isTransparent(i)) {
      visited[i] = 1;
      stack.push(i);
    }
  };
  // ابذر من كل بكسلات الحدّ الشفّافة ثم انشر داخلاً.
  for (let x = 0; x < width; x++) {
    pushIf(x, 0);
    pushIf(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    pushIf(0, y);
    pushIf(width - 1, y);
  }
  while (stack.length) {
    const i = stack.pop() as number;
    const x = i % width;
    const y = (i / width) | 0;
    pushIf(x - 1, y);
    pushIf(x + 1, y);
    pushIf(x, y - 1);
    pushIf(x, y + 1);
  }
  let internalHoles = 0;
  for (let i = 0; i < total; i++) {
    if (isTransparent(i) && !visited[i]) internalHoles++;
  }
  let touchesFrame = false;
  const checkOpaque = (i: number) => {
    if (alpha[i] >= opaqueAtLeast) touchesFrame = true;
  };
  for (let x = 0; x < width && !touchesFrame; x++) {
    checkOpaque(x);
    checkOpaque((height - 1) * width + x);
  }
  for (let y = 0; y < height && !touchesFrame; y++) {
    checkOpaque(y * width);
    checkOpaque(y * width + width - 1);
  }
  return { internalHoleRatio: total > 0 ? internalHoles / total : 0, touchesFrame };
}

/**
 * يقرّر CUT أو FLATTEN من قناع الألفا. أيّ سببٍ للشكّ ⇒ FLATTEN (أسبابه في `reasons`).
 * `alpha` قناع أحاديّ القناة (بكسل/بايت) بطول ≥ width×height.
 */
export function analyzeMask(
  alpha: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  opts: ConfidenceOptions = {},
): ConfidenceResult {
  const o = { ...DEFAULTS, ...opts };
  const total = width * height;
  if (!(width > 0) || !(height > 0) || alpha.length < total) {
    throw new Error("analyzeMask: قناع/أبعاد غير متسقة");
  }

  let semi = 0;
  let nonTransparent = 0;
  for (let i = 0; i < total; i++) {
    const a = alpha[i];
    if (a >= o.opaqueAtLeast) nonTransparent++;
    else if (a > o.transparentBelow) {
      semi++;
      nonTransparent++;
    }
  }
  const foregroundRatio = nonTransparent / total;
  const softEdgeRatio = nonTransparent > 0 ? semi / nonTransparent : 0;

  const { internalHoleRatio, touchesFrame } = analyzeTopology(alpha, width, height, o.transparentBelow, o.opaqueAtLeast);
  const hasInternalHoles = internalHoleRatio > o.internalHoleMin;

  const reasons: string[] = [];
  if (opts.forceFlatten) reasons.push("صنف قرطاسية (نصّ داخليّ حسّاس)");
  if (foregroundRatio < o.minForeground) reasons.push("منتج ضئيل أو فشل عزل");
  if (foregroundRatio > o.maxForeground) reasons.push("القناع يغطّي الإطار كلّه");
  if (softEdgeRatio > o.softEdgeMax) reasons.push("حواف مهترئة (شفّاف/عاكس/سلوفان)");
  if (hasInternalHoles) reasons.push("ثقوب داخلية (خطر محو محتوى)");

  const mode: StudioMode = reasons.length > 0 ? "FLATTEN" : "CUT";
  const confidence = mode === "CUT" ? Math.max(0, Math.min(1, 1 - softEdgeRatio / o.softEdgeMax)) : 0;

  return { mode, confidence, foregroundRatio, softEdgeRatio, hasInternalHoles, touchesFrame, reasons };
}
