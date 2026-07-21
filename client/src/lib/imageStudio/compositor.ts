/**
 * راسم الاستوديو (canvas): يركّب مصدراً على قماش مربّع أبيض وفق القالب البيتيّ + ظلّ تماس حتميّ.
 * يُستهلَك من freePipeline (FLATTEN بالأصل؛ CUT بقناع العزل لاحقاً — نفس الراسم). يعتمد هندسة
 * template.ts المُتحقَّقة. راجع docs/product-image-studio-design-2026-07-21.md §٥.
 */
import { STUDIO_TEMPLATE, computeProductRect, computeShadowEllipse } from "@shared/imageStudio/template";

/**
 * يحمّل data URL إلى عنصر صورة جاهز للرسم. **لا نستعمل `fetch(dataUrl)`**: سياسة CSP
 * (`connect-src 'self'`) تحجب جلب `data:`، بينما `img-src ... data:` تُجيز `<img src=data:>`.
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

/**
 * يركّب المصدر على قماش استوديو أبيض مربّع + ظلّ تماس حتميّ، ويعيد اللوحة.
 * المصدر ذو الخلفية الشفّافة (مسار CUT) يظهر منتجه فقط؛ الأصل المعتم (FLATTEN) يظهر كما هو موسَّطاً.
 */
export function compositeOnTemplate(
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  size: number = STUDIO_TEMPLATE.canvasSize,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("compositeOnTemplate: تعذّر إنشاء سياق canvas");

  // خلفية بيضاء نقيّة (قرار المالك ٣).
  ctx.fillStyle = STUDIO_TEMPLATE.background;
  ctx.fillRect(0, 0, size, size);

  const rect = computeProductRect(srcW, srcH, size);

  // ظلّ التماس البيضاويّ الحتميّ أولاً (تحت المنتج).
  const sh = computeShadowEllipse(rect, size);
  ctx.save();
  ctx.filter = `blur(${Math.max(1, Math.round(size * STUDIO_TEMPLATE.shadow.blurRatio))}px)`;
  ctx.globalAlpha = STUDIO_TEMPLATE.shadow.opacity;
  ctx.fillStyle = "#000000";
  ctx.beginPath();
  ctx.ellipse(sh.cx, sh.cy, sh.rx, sh.ry, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // المنتج فوق الظلّ.
  ctx.drawImage(source, rect.x, rect.y, rect.width, rect.height);
  return canvas;
}
