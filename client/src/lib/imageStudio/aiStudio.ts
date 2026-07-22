/**
 * مسار الذكاء الاصطناعي (عميل) — ينظّف ناتج المزوّد ليطابق مقاس/صيغة بقيّة الاستوديو.
 *
 * المزوّد يُعيد صورة استوديو مُركّبة كاملةً (خلفية بيضاء + إضاءة + ظلّ). هنا فقط **نطابق العلبة**:
 * contain-fit على مربّع أبيض 1600² (بلا قصّ ⇒ لا يُقتطَع المنتج، وبلا ظلٍّ/إطارٍ إضافيّ ⇒ يُحفَظ
 * تكوين المزوّد) ثمّ ترميز ≤700KB عبر مسار ImageUploader المُثبَت (WebP/JPEG الأصغر). الأصل لا يُمسّ:
 * هذا ناتج **مرشّح** للمعاينة والاعتماد البشريّ قبل استبدال الأصل. راجع README.md وaiPrompt.ts.
 */
import { compressImageDataUrl } from "@/components/form/ImageUploader";
import { STUDIO_TEMPLATE } from "@shared/imageStudio/template";
import { loadImageEl } from "./compositor";

export interface AiStudioResult {
  /** الناتج المعالَج (data URL) مرمَّزاً ≤700KB. */
  dataUrl: string;
  sizeKB: number;
  mode: "AI";
}

/** ينظّف ناتج الذكاء الاصطناعي: contain-fit على مربّع أبيض 1600² ثمّ ترميز مضغوط. */
export async function normalizeAiStudioImage(aiDataUrl: string): Promise<AiStudioResult> {
  const img = await loadImageEl(aiDataUrl);
  const size = STUDIO_TEMPLATE.canvasSize; // 1600
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("normalizeAiStudioImage: تعذّر إنشاء سياق canvas");
  ctx.fillStyle = STUDIO_TEMPLATE.background; // #FFFFFF
  ctx.fillRect(0, 0, size, size);
  // contain-fit: أكبر بُعد يملأ 1600، ويُوسَّط (لا قصّ — لا يُقتطَع المنتج).
  const nW = img.naturalWidth || size;
  const nH = img.naturalHeight || size;
  const scale = Math.min(size / nW, size / nH);
  const w = Math.max(1, Math.round(nW * scale));
  const h = Math.max(1, Math.round(nH * scale));
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, Math.round((size - w) / 2), Math.round((size - h) / 2), w, h);
  const { dataUrl, sizeKB } = await compressImageDataUrl(canvas.toDataURL("image/png"));
  return { dataUrl, sizeKB, mode: "AI" };
}
