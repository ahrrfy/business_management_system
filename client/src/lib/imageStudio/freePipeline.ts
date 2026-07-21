/**
 * خطّ الاستوديو المجاني — يحوّل صورة منتج إلى نسخة استوديو (خلفية بيضاء + قالب موحّد + ظلّ).
 * - **FLATTEN** (المسار الآمن): الأصل موسَّطاً على أبيض + ظلّ (canvas بحت ⇒ يستحيل أكل بكسلة منتج؛
 *   أسوأ حالة = أبيض نظيف بلا قصّ).
 * - **CUT**: عزل الخلفية بـ@imgly ⇒ قناع ⇒ `analyzeMask` يقرّر ⇒ تركيب القصاصة (أو FLATTEN عند الشكّ).
 * **تدهور سلس:** فشل العزل (نموذج غير محمَّل/متصفّح عاجز) ⇒ FLATTEN. راجع docs/product-image-studio-design-2026-07-21.md §٥.
 */
import { compressImageDataUrl } from "@/components/form/ImageUploader";
import { STUDIO_TEMPLATE } from "@shared/imageStudio/template";
import { compositeOnTemplate, loadImageEl } from "./compositor";
import { analyzeMask, type ConfidenceResult, type StudioMode } from "./confidence";

export interface StudioResult {
  /** الناتج المعالَج (data URL) مرمَّزاً ≤700KB. */
  dataUrl: string;
  sizeKB: number;
  mode: StudioMode;
  /** نتيجة تحليل القناع (مسار CUT فقط؛ null في FLATTEN بلا عزل). */
  confidence: ConfidenceResult | null;
  /** نسخة القالب المُطبَّقة (للتخزين في stylePresetVersion). */
  templateVersion: number;
}

async function encodeCanvas(canvas: HTMLCanvasElement): Promise<{ dataUrl: string; sizeKB: number }> {
  // الترميز النهائيّ عبر مسار ImageUploader المُثبَت (WebP/JPEG الأصغر فعلياً، ≤700KB، على أبيض).
  return compressImageDataUrl(canvas.toDataURL("image/png"));
}

/** المسار الآمن (FLATTEN): الأصل موسَّطاً على أبيض + ظلّ. لا عزل ⇒ صفر خطر على المنتج. */
export async function runFreeStudioFlatten(sourceDataUrl: string): Promise<StudioResult> {
  const img = await loadImageEl(sourceDataUrl);
  const canvas = compositeOnTemplate(img, img.naturalWidth, img.naturalHeight);
  const { dataUrl, sizeKB } = await encodeCanvas(canvas);
  return { dataUrl, sizeKB, mode: "FLATTEN", confidence: null, templateVersion: STUDIO_TEMPLATE.version };
}

/** يستخرج قناع الألفا من قصاصة (مصغّراً للتحليل السريع — القرار لا يحتاج دقّة كاملة). */
function extractAlpha(img: HTMLImageElement, maxDim = 512): { alpha: Uint8ClampedArray; width: number; height: number } {
  const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("extractAlpha: تعذّر إنشاء سياق canvas");
  ctx.drawImage(img, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height).data;
  const alpha = new Uint8ClampedArray(width * height);
  for (let i = 0; i < width * height; i++) alpha[i] = data[i * 4 + 3];
  return { alpha, width, height };
}

/**
 * يُكمل مسار CUT من قصاصةٍ جاهزة (قناع ⇒ قرار ⇒ تركيب). منفصلٌ عن العزل ليُختبَر بقصاصةٍ اصطناعية.
 * CUT ⇒ تركيب القصاصة الشفّافة؛ FLATTEN (ثقة ضعيفة/قسر) ⇒ تركيب الأصل — كلاهما على القالب الأبيض.
 */
export async function finishCutFromCutout(
  cutoutDataUrl: string,
  sourceDataUrl: string,
  opts: { forceFlatten?: boolean } = {},
): Promise<StudioResult> {
  const cutImg = await loadImageEl(cutoutDataUrl);
  const { alpha, width, height } = extractAlpha(cutImg);
  const confidence = analyzeMask(alpha, width, height, { forceFlatten: opts.forceFlatten });
  let canvas: HTMLCanvasElement;
  if (confidence.mode === "CUT") {
    canvas = compositeOnTemplate(cutImg, cutImg.naturalWidth, cutImg.naturalHeight);
  } else {
    const orig = await loadImageEl(sourceDataUrl);
    canvas = compositeOnTemplate(orig, orig.naturalWidth, orig.naturalHeight);
  }
  const { dataUrl, sizeKB } = await encodeCanvas(canvas);
  return { dataUrl, sizeKB, mode: confidence.mode, confidence, templateVersion: STUDIO_TEMPLATE.version };
}

/** مسار CUT الكامل: عزل الخلفية بـ@imgly ثم إكمال التركيب. يرمي إن تعذّر العزل (يلتقطه runFreeStudio). */
export async function runFreeStudioCut(sourceDataUrl: string, opts: { forceFlatten?: boolean } = {}): Promise<StudioResult> {
  // تحميل كسول لـsegment/@imgly (النموذج الثقيل) — لا يدخل حزمة المسار الآمن FLATTEN.
  const { removeBackgroundToDataUrl } = await import("./segment");
  const cutoutDataUrl = await removeBackgroundToDataUrl(sourceDataUrl);
  return finishCutFromCutout(cutoutDataUrl, sourceDataUrl, opts);
}

/**
 * الواجهة العليا: يجرّب CUT ثم **يتدهور بسلاسة لـFLATTEN** عند فشل العزل (نموذج غير محمَّل/متصفّح عاجز).
 * `safeOnly` ⇒ FLATTEN مباشرةً (بلا محاولة عزل). `forceFlatten` (قرطاسية) ⇒ يُمرَّر لتحليل القناع.
 */
export async function runFreeStudio(
  sourceDataUrl: string,
  opts: { safeOnly?: boolean; forceFlatten?: boolean } = {},
): Promise<StudioResult> {
  if (opts.safeOnly) return runFreeStudioFlatten(sourceDataUrl);
  try {
    return await runFreeStudioCut(sourceDataUrl, { forceFlatten: opts.forceFlatten });
  } catch (e) {
    console.warn("[imageStudio] تعذّر مسار CUT (عزل)، السقوط للمسار الآمن FLATTEN:", e);
    return runFreeStudioFlatten(sourceDataUrl);
  }
}
