/**
 * خطّ الاستوديو المجاني — يحوّل صورة منتج إلى نسخة استوديو (خلفية بيضاء + قالب موحّد + ظلّ).
 * المسار الآمن الافتراضي = **FLATTEN** (canvas بحت، بلا عزل ML ⇒ يستحيل أن يأكل بكسلة منتج؛
 * أسوأ حالة = أبيض نظيف بلا قصّ). مسار CUT (عزل خلفية @imgly ثم تركيب القناع) يُضاف في خطوةٍ
 * لاحقة فوق نفس الراسم، ويقرّره analyzeMask (confidence.ts). راجع docs/product-image-studio-design-2026-07-21.md §٥.
 */
import { compressImageDataUrl } from "@/components/form/ImageUploader";
import { STUDIO_TEMPLATE } from "@shared/imageStudio/template";
import { compositeOnTemplate, loadImageEl } from "./compositor";
import type { ConfidenceResult, StudioMode } from "./confidence";

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

/**
 * المسار الآمن (FLATTEN): الأصل موسَّطاً على أبيض + ظلّ، مرمَّزاً ≤700KB. لا عزل ⇒ صفر خطر على المنتج.
 */
export async function runFreeStudioFlatten(sourceDataUrl: string): Promise<StudioResult> {
  const img = await loadImageEl(sourceDataUrl);
  const canvas = compositeOnTemplate(img, img.naturalWidth, img.naturalHeight);
  // الترميز النهائيّ عبر مسار ImageUploader المُثبَت (WebP/JPEG الأصغر فعلياً، ≤700KB، على أبيض).
  const intermediate = canvas.toDataURL("image/png");
  const { dataUrl, sizeKB } = await compressImageDataUrl(intermediate);
  return { dataUrl, sizeKB, mode: "FLATTEN", confidence: null, templateVersion: STUDIO_TEMPLATE.version };
}
