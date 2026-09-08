/**
 * مسار الذكاء الاصطناعي (عميل) — ينظّف ويعزّز ناتج المزوّد ليطابق مقاس/صيغة بقيّة الاستوديو.
 *
 * يحتوي على معالجة حِدة وألوان لضمان عدم جمود أو بهاتة الصورة الناتجة،
 * ومطابقة كادر 1600² المربع مع خلفية بيضاء ناصعة 100% (#FFFFFF).
 */
import { compressCanvas } from "@/components/form/ImageUploader";
import { STUDIO_TEMPLATE } from "@shared/imageStudio/template";
import { loadImageEl } from "./compositor";
import { applyUnsharpMask, enhanceVibranceAndContrast } from "./studioEnhancer";

export interface AiStudioResult {
  /** الناتج المعالَج (data URL) مرمَّزاً ≤700KB. */
  dataUrl: string;
  sizeKB: number;
  mode: "AI";
}

/** ينظّف ناتج الذكاء الاصطناعي: contain-fit على مربّع أبيض 1600² ثمّ تعزيز الحيوية والحدة والترميز. */
export async function normalizeAiStudioImage(
  aiDataUrl: string,
  options: { enhance?: boolean } = {},
): Promise<AiStudioResult> {
  const { enhance = true } = options;
  const img = await loadImageEl(aiDataUrl);
  const size = STUDIO_TEMPLATE.canvasSize; // 1600
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("normalizeAiStudioImage: تعذّر إنشاء سياق canvas");

  ctx.fillStyle = STUDIO_TEMPLATE.background; // #FFFFFF
  ctx.fillRect(0, 0, size, size);

  // contain-fit: أكبر بُعد يملأ النطاق الآمن 83%، ويُوسَّط
  const nW = img.naturalWidth || size;
  const nH = img.naturalHeight || size;
  const maxDim = size * STUDIO_TEMPLATE.productMaxRatio;
  const scale = Math.min(maxDim / nW, maxDim / nH);
  const w = Math.max(1, Math.round(nW * scale));
  const h = Math.max(1, Math.round(nH * scale));
  const x = Math.round((size - w) / 2);
  const y = Math.round((size - h) / 2);

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, x, y, w, h);

  if (enhance) {
    const imgData = ctx.getImageData(0, 0, size, size);
    enhanceVibranceAndContrast(imgData, { vibrance: 0.20, contrast: 0.10, shadowLift: 0.05 });
    applyUnsharpMask(imgData, size, size, 0.25);
    ctx.putImageData(imgData, 0, 0);
  }

  const { dataUrl, sizeKB } = await compressCanvas(canvas);
  return { dataUrl, sizeKB, mode: "AI" };
}
