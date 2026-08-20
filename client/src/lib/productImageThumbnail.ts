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

/**
 * إعادة ترميز مشتق العرض محلياً: 320px، بلا رفع أصلٍ إضافيّ أو معالجةٍ ثقيلة على الخادم.
 *
 * **WebP أوّلاً ثمّ JPEG (٢٠/٨ — بلاغ إنتاج):** كانت الدالّة تفرض WebP فترمي «المتصفح لا
 * يدعم إنشاء مصغّرة WebP آمنة». و`canvas.toDataURL("image/webp")` **غير مدعوم على
 * Safari/iOS** قبل ١٧ — يُرجع PNG بصمتٍ فيشتعل الحارس. النتيجة: مصوّرٌ على iPhone يلتقط
 * الصورة ويعالجها ثمّ **يُمنع من الإرسال نهائياً** بسبب مشتقّ عرضٍ لا علاقة له بجودة عمله.
 *
 * JPEG هو الاحتياطيّ لا PNG: كلّ متصفّحٍ يرمّزه من canvas، وحجمُه لصورة ٣٢٠px يبقى تحت
 * السقف بينما PNG قد يتجاوزه فيرتدّ الرفض من بابٍ آخر. والخادم يتحقّق من الاثنين بنفس
 * الصرامة (مغناطيس + بنية + مطابقة الأبعاد للمرشّح).
 */
export async function createProductDisplayThumbnail(
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
  // الترتيب مقصود: WebP أصغر حجماً فيُجرَّب أوّلاً، وJPEG احتياطيٌّ مضمونٌ في كل متصفّح.
  // Safari يُرجع PNG صامتاً حين لا يدعم الصيغة المطلوبة، فالفحص على **بادئة الناتج**
  // لا على `toDataURL` نفسها — «الدالّة لم ترمِ» ليست دليلاً على أنّها رمّزت ما طُلب.
  const candidates: { mime: "image/webp" | "image/jpeg"; quality: number }[] = [
    { mime: "image/webp", quality: 0.78 },
    { mime: "image/jpeg", quality: 0.82 },
  ];
  let oversized = false;
  for (const candidate of candidates) {
    const dataUrl = canvas.toDataURL(candidate.mime, candidate.quality);
    if (!dataUrl.startsWith(`data:${candidate.mime};base64,`)) continue;
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    if (base64.length * 0.75 > THUMBNAIL_MAX_BYTES) {
      oversized = true;
      continue;
    }
    return dataUrl;
  }
  // تمييزُ السببين مقصود: «كبيرة» قابلةٌ للعلاج بصورةٍ أصغر، و«غير مدعومة» ليست كذلك.
  throw new Error(
    oversized ? "حجم مصغّرة العرض أكبر من المسموح" : "تعذّر على المتصفح إنشاء مصغّرة عرضٍ صالحة",
  );
}

/** @deprecated الاسم القديم — أُبقي لئلّا ينكسر مستدعٍ خارج هذا الملف. */
export const createProductWebpThumbnail = createProductDisplayThumbnail;
