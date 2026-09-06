/**
 * راسم الاستوديو الاحترافي (Canvas Studio Compositor):
 * يركّب قصاصة المنتج على قماش مربّع بخلفية بيضاء ناصعة 100% (#FFFFFF)،
 * مع توسيط ذكي وفق الصندوق المحيط الفعلي للمنتج، وتوليد نظام الظل الثلاثي
 * (تماس أرضي داكن + ظل ناعم منتشر + انعكاس أرضي اختياري للأجهزة)،
 * ومعالجة الألوان والإنارة والحِدة دون المساس ببكسلات وماركات المنتج.
 */
import { STUDIO_TEMPLATE, computeProductRect, computeShadowEllipse, type Rect } from "@shared/imageStudio/template";
import {
  autoWhiteBalance,
  applyUnsharpMask,
  enhanceVibranceAndContrast,
  findProductBoundingBox,
  renderMultiTierStudioShadow,
  type BoundingBox,
  type StudioPreset,
} from "./studioEnhancer";

/**
 * يحمّل data URL إلى عنصر صورة جاهز للرسم.
 */
export async function loadImageEl(dataUrl: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.decoding = "async";
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("loadImageEl: تعذّر تحميل الصورة"));
    img.src = dataUrl;
  });
  return img;
}

export interface CompositeStudioOptions {
  preset?: StudioPreset;
  boundingBox?: BoundingBox;
  enhanceColors?: boolean;
  sharpen?: boolean;
  withReflection?: boolean;
  shadowIntensity?: number;
  size?: number;
}

/**
 * يركّب المصدر على قماش استوديو أبيض مربّع + ظلّ تماس حتميّ أو ثلاثي متقدم، ويعيد اللوحة.
 */
export function compositeOnTemplate(
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  size: number = STUDIO_TEMPLATE.canvasSize,
  options: CompositeStudioOptions = {},
): HTMLCanvasElement {
  const {
    preset = "PURE_WHITE",
    enhanceColors = true,
    sharpen = true,
    withReflection = preset === "LUXURY_MIRROR",
    shadowIntensity = 1.0,
  } = options;

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("compositeOnTemplate: تعذّر إنشاء سياق canvas");

  // خلفية بيضاء ناصعة 100% (#FFFFFF)
  ctx.fillStyle = STUDIO_TEMPLATE.background;
  ctx.fillRect(0, 0, size, size);

  // ١. تجهيز قماش مؤقت لفحص واقتصاص وتعديل المنتج إن وُجدت شفافية
  const tempCanvas = document.createElement("canvas");
  tempCanvas.width = srcW;
  tempCanvas.height = srcH;
  const tempCtx = tempCanvas.getContext("2d", { willReadFrequently: true });
  if (!tempCtx) throw new Error("compositeOnTemplate: تعذّر إنشاء سياق مؤقت");

  tempCtx.drawImage(source, 0, 0, srcW, srcH);
  const imgData = tempCtx.getImageData(0, 0, srcW, srcH);
  const data = imgData.data;

  // فحص هل الصورة شفافة (قصاصة) أم معتمة
  let transparentPixels = 0;
  for (let i = 3; i < data.length; i += 16) {
    if (data[i] < 240) transparentPixels++;
  }
  const isCutout = transparentPixels > (data.length / 16) * 0.05;

  let sx = 0;
  let sy = 0;
  let sw = srcW;
  let sh = srcH;

  if (isCutout) {
    // استخراج ألفا وتحديد صندوق المحيط الفعلي
    const alpha = new Uint8ClampedArray(srcW * srcH);
    for (let i = 0; i < srcW * srcH; i++) {
      alpha[i] = data[i * 4 + 3];
    }
    const bbox = options.boundingBox ?? findProductBoundingBox(alpha, srcW, srcH);
    if (bbox.hasContent && bbox.width > 20 && bbox.height > 20) {
      sx = bbox.minX;
      sy = bbox.minY;
      sw = bbox.width;
      sh = bbox.height;
    }

    // تطبيق معالجة الألوان والإنارة على بكسلات القصاصة
    if (enhanceColors) {
      autoWhiteBalance(imgData);
      const vibrance = preset === "VIBRANT_COMMERCIAL" ? 0.32 : 0.22;
      const contrast = preset === "VIBRANT_COMMERCIAL" ? 0.18 : 0.12;
      enhanceVibranceAndContrast(imgData, { vibrance, contrast, shadowLift: 0.08 });
    }
    if (sharpen) {
      applyUnsharpMask(imgData, srcW, srcH, 0.3);
    }
    tempCtx.putImageData(imgData, 0, 0);
  }

  // ٢. حساب الأبعاد والتوسيط في الكادر المربع (83% نسبة الأمان)
  const targetMaxDim = size * STUDIO_TEMPLATE.productMaxRatio;
  const scale = targetMaxDim / Math.max(sw, sh);
  const destW = Math.max(1, Math.round(sw * scale));
  const destH = Math.max(1, Math.round(sh * scale));

  // التوسيط الأفقي بدقة، والعمودي مع مراعاة ظل التماس في الأسفل
  const destX = Math.round((size - destW) / 2);
  const destY = Math.round((size - destH) / 2 - size * 0.015);
  const rect: Rect = { x: destX, y: destY, width: destW, height: destH };

  // ٣. رسم الظلال قبل رسم المنتج
  if (isCutout) {
    renderMultiTierStudioShadow(ctx, rect, size, {
      preset,
      intensity: shadowIntensity,
      withReflection,
      sourceElement: tempCanvas,
      cropRect: { sx, sy, sw, sh },
    });
  } else {
    // للوضع المسطح الاحتياطي
    const shEllipse = computeShadowEllipse(rect, size);
    ctx.save();
    ctx.filter = `blur(${Math.max(1, Math.round(size * STUDIO_TEMPLATE.shadow.blurRatio))}px)`;
    ctx.globalAlpha = STUDIO_TEMPLATE.shadow.opacity;
    ctx.fillStyle = "#1e2430";
    ctx.beginPath();
    ctx.ellipse(shEllipse.cx, shEllipse.cy, shEllipse.rx, shEllipse.ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // ٤. رسم المنتج المعالج بدقة فائقة
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(tempCanvas, sx, sy, sw, sh, destX, destY, destW, destH);

  return canvas;
}
