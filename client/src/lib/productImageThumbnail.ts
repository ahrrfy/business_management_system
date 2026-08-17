const THUMBNAIL_MAX_DIMENSION = 320;
const THUMBNAIL_MAX_BYTES = 128 * 1024;

interface ThumbnailRuntime {
  loadImage(dataUrl: string): Promise<HTMLImageElement>;
  createCanvas(width: number, height: number): HTMLCanvasElement;
}

export function fitProductThumbnailDimensions(width: number, height: number): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("أبعاد الصورة غير صالحة");
  }
  const scale = Math.min(1, THUMBNAIL_MAX_DIMENSION / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

const browserRuntime: ThumbnailRuntime = {
  loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.decoding = "async";
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("تعذّر فتح الصورة لإنشاء المصغّرة"));
      image.src = dataUrl;
    });
  },
  createCanvas(width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  },
};

/** إعادة ترميز مشتق العرض محلياً: 320px WebP، بلا رفع أصل إضافي أو معالجة ثقيلة على الخادم. */
export async function createProductWebpThumbnail(
  sourceDataUrl: string,
  runtime: ThumbnailRuntime = browserRuntime,
): Promise<string> {
  if (!/^data:image\/(png|jpe?g|webp);base64,/.test(sourceDataUrl)) {
    throw new Error("صيغة الصورة النهائية لا تصلح لإنشاء المصغّرة");
  }
  const image = await runtime.loadImage(sourceDataUrl);
  const size = fitProductThumbnailDimensions(image.naturalWidth, image.naturalHeight);
  const canvas = runtime.createCanvas(size.width, size.height);
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) throw new Error("تعذّر تجهيز مساحة رسم المصغّرة");
  // خلفية بيضاء تزيل alpha كي ينتج encoder WebP بسيطاً (VP8/VP8L) يمكن التحقق من إطاره خادمياً.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, size.width, size.height);
  context.drawImage(image, 0, 0, size.width, size.height);
  const dataUrl = canvas.toDataURL("image/webp", 0.78);
  if (!dataUrl.startsWith("data:image/webp;base64,")) {
    throw new Error("المتصفح لا يدعم إنشاء مصغّرة WebP آمنة");
  }
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  if (base64.length * 0.75 > THUMBNAIL_MAX_BYTES) {
    throw new Error("حجم مصغّرة WebP أكبر من المسموح");
  }
  return dataUrl;
}
