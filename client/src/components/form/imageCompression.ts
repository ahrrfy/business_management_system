/* ============================ ضغط الصور قبل التخزين (import-integration) ============================ */

/** الحجم المستهدف للناتج المضغوط بالكيلوبايت — يتّسع له MEDIUMTEXT بهامش واسع. */
export const COMPRESSION_TARGET_KB = 700;

/** سلّم محاولات الضغط: تنازلٌ في الجودة ثم في البُعد حتى بلوغ الحجم المستهدف. */
export const COMPRESSION_LADDER: ReadonlyArray<{ maxDim: number; quality: number }> = [
  { maxDim: 1600, quality: 0.82 },
  { maxDim: 1600, quality: 0.7 },
  { maxDim: 1280, quality: 0.6 },
];

/** حجم data URL بالكيلوبايت — حساب نصّي خالص على base64 (دالة نقية قابلة للاختبار بلا DOM). */
export function dataUrlSizeKB(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  // كل ٤ محارف base64 = ٣ بايتات، مع خصم حشوة «=» النهائية.
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.round(((b64.length * 3) / 4 - padding) / 1024);
}

/** يقصر البُعد الأطول على `maxDim` بحفظ نسبة الأبعاد (دالة نقية قابلة للاختبار بلا DOM). */
export function fitDimensions(
  width: number,
  height: number,
  maxDim: number
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxDim || longest <= 0) return { width, height };
  const scale = maxDim / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("تعذّرت قراءة الصورة"));
    img.src = dataUrl;
  });
}

/**
 * هل يدعم المتصفّح ترميز WebP؟ — يُفحَص مرّةً على canvas ١×١ ويُخبّأ.
 *
 * ⚠️ **الفخّ:** `toDataURL("image/webp")` في متصفّحٍ لا يدعمها **لا يفشل ولا يرمي** — بل يعود
 * بـ**PNG** (السلوك المُواصَف: نوعٌ غير مدعوم ⇒ الافتراضي `image/png`). وPNG لصورةٍ فوتوغرافية
 * **أكبر من JPEG بأضعاف** ⇒ «تحسينٌ» يُضاعف الحجم على سفاري القديم. الحكم على **بادئة الناتج**
 * لا على نجاح النداء. (والفحص المسبق يمنع أيضاً ترميز PNG ضخمٍ يُرمى — بطءٌ وذاكرةٌ بلا مقابل.)
 */
let webpSupportCache: boolean | null = null;
export function webpSupported(): boolean {
  if (webpSupportCache !== null) return webpSupportCache;
  try {
    const probe = document.createElement("canvas");
    probe.width = 1;
    probe.height = 1;
    webpSupportCache = probe.toDataURL("image/webp").startsWith("data:image/webp");
  } catch {
    webpSupportCache = false;
  }
  return webpSupportCache;
}

/** للاختبار فقط — يُصفّر الكاش كي تُعاد المحاولة تحت بيئةٍ مختلفة. */
export function __resetEncoderCache(): void {
  webpSupportCache = null;
}

/**
 * `canvas.toBlob` مُوعَّداً. الفارق عن `toDataURL` ليس أسلوبياً:
 * `toDataURL` يُرمّز **متزامناً على الخيط الرئيسي** ويبني نصّ base64 كاملاً قبل أن يعود،
 * فترميز لوحةٍ ١٦٠٠×١٦٠٠ يُجمّد الصفحة. و`toBlob` يُرمّز خارج الخيط ويستدعي رجوعه لاحقاً.
 * الرجوع إلى `toDataURL` يبقى لبيئةٍ بلا `toBlob` (jsdom والمتصفّحات القديمة).
 */
function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    if (typeof canvas.toBlob !== "function") {
      try {
        const dataUrl = canvas.toDataURL(type, quality);
        const comma = dataUrl.indexOf(",");
        const binary = atob(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        resolve(new Blob([bytes], { type: dataUrl.slice(5, comma > 0 ? dataUrl.indexOf(";") : undefined) || type }));
      } catch {
        resolve(null);
      }
      return;
    }
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error ?? new Error("تعذّرت قراءة الصورة المرمَّزة"));
    reader.readAsDataURL(blob);
  });
}

/**
 * يُرمّز اللوحة بأصغر ناتجٍ فعليّ: **يُجرّب WebP وJPEG ويأخذ الأصغر قياساً لا ترجيحاً.**
 *
 * **القياس على صور الإنتاج الحقيقية (١٦/٧، بنراتك الأربعة):** WebP أصغر **٢٦٪** (١٠٥٤ ⇐ ٧٨٥ ك.ب،
 * متّسقاً ٢٣–٢٧٪ لكلٍّ). والخادم يقبلها أصلاً (`imageValidation` يُجيز webp ويتحقّق من بصمة
 * `RIFF…WEBP`، ونقطة `/api/img` تُدرجها في قائمتها البيضاء)، ولا jsPDF ⇒ الطباعة ترسمها أصلاً.
 *
 * ⚠️ **ولماذا نقيس بدل أن نفترض:** WebP **ليس أصغر دائماً**. قِيس فعلياً على صورةٍ عالية
 * الضوضاء: WebP **أكبر ٤٨٪** من JPEG بنفس الجودة (٣٧٧ مقابل ٢٥٥ ك.ب) — الضوضاء البكسليّة تُبطل
 * تنبّؤ WebP. مثل هذه الصور نادرة في كتالوج قرطاسية، لكنّ «الأصغر فعلياً» يجعل التحسين **مُبرهناً
 * لا مُرجَّحاً**: مستحيلٌ أن يُخرج هذا المسار ملفاً أكبر ممّا كان قبله.
 *
 * القياس على **حجم الـblob** لا على طول النصّ: هو الحجم الحقيقيّ، ويُجنّبنا بناء نصَّي base64
 * ضخمَين لمجرّد المقارنة — لا يُحوَّل إلى نصّ إلا الفائز. مُصدَّرةٌ للاختبار.
 */
export async function encodeSmallest(canvas: HTMLCanvasElement, quality: number): Promise<{ blob: Blob; bytes: number } | null> {
  const jpeg = await canvasToBlob(canvas, "image/jpeg", quality);
  if (!webpSupported()) return jpeg ? { blob: jpeg, bytes: jpeg.size } : null;
  const webp = await canvasToBlob(canvas, "image/webp", quality);
  // نفس فخّ `toDataURL`: نوعٌ غير مدعوم يعود بـPNG بلا خطأ ⇒ الحكم على نوع الناتج لا على نجاح النداء.
  if (!webp || webp.type !== "image/webp") return jpeg ? { blob: jpeg, bytes: jpeg.size } : null;
  if (!jpeg) return { blob: webp, bytes: webp.size };
  return webp.size < jpeg.size ? { blob: webp, bytes: webp.size } : { blob: jpeg, bytes: jpeg.size };
}

/**
 * يضغط صورة data URL على خلفية بيضاء (الشفافية تتحوّل بيضاء لا سوداء) بصيغة WebP إن أمكن
 * وإلّا JPEG، وفق سلّم المحاولات حتى ≤ الحجم المستهدف. يعيد الأصل كما هو إن فشل الضغط
 * أو كان الأصل أصغر من الناتج (صور مضغوطة جيداً أصلاً).
 */
/**
 * يضغط **لوحةً** مباشرةً بلا المرور بـPNG وسيط.
 *
 * كان خطّ الاستوديو يفعل `compressImageDataUrl(canvas.toDataURL("image/png"))`: ترميز PNG
 * بلا فقدٍ للوحة ١٦٠٠×١٦٠٠ (الأثقل على الإطلاق ومتزامن)، ثمّ فكّه صورةً، ثمّ رسمه على لوحةٍ
 * جديدة، ثمّ ترميزه من جديد. الوسيط لم يكن له غرضٌ إلا تسليم نصٍّ للدالّة التالية.
 * هنا يبدأ السلّم من اللوحة نفسها ⇒ يسقط الترميز الأثقل وفكّه معاً.
 */
export async function compressCanvas(source: HTMLCanvasElement): Promise<{ dataUrl: string; sizeKB: number }> {
  let best: { blob: Blob; bytes: number } | null = null;
  for (const step of COMPRESSION_LADDER) {
    const { width, height } = fitDimensions(source.width, source.height, step.maxDim);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) break;
    // الخلفية البيضاء لازمة: JPEG بلا قناة شفافية، والشفافية تصير سوداء لا بيضاء.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(source, 0, 0, width, height);
    best = await encodeSmallest(canvas, step.quality);
    if (!best) break;
    if (Math.round(best.bytes / 1024) <= COMPRESSION_TARGET_KB) break;
  }
  if (!best) {
    const fallback = source.toDataURL("image/png");
    return { dataUrl: fallback, sizeKB: dataUrlSizeKB(fallback) };
  }
  return { dataUrl: await blobToDataUrl(best.blob), sizeKB: Math.round(best.bytes / 1024) };
}

export async function compressImageDataUrl(
  original: string
): Promise<{ dataUrl: string; sizeKB: number }> {
  const originalKB = dataUrlSizeKB(original);
  try {
    const img = await loadImage(original);
    let best: { blob: Blob; bytes: number } | null = null;
    for (const step of COMPRESSION_LADDER) {
      const { width, height } = fitDimensions(img.naturalWidth, img.naturalHeight, step.maxDim);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) break;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      best = await encodeSmallest(canvas, step.quality);
      if (!best) break;
      if (Math.round(best.bytes / 1024) <= COMPRESSION_TARGET_KB) break;
    }
    if (!best) return { dataUrl: original, sizeKB: originalKB };
    const bestKB = Math.round(best.bytes / 1024);
    // الأصل أصغر ⇒ لا نُحوّل الفائز إلى نصّ أصلاً (نُوفّر base64 كاملاً لناتجٍ يُرمى).
    if (bestKB >= originalKB) return { dataUrl: original, sizeKB: originalKB };
    return { dataUrl: await blobToDataUrl(best.blob), sizeKB: bestKB };
  } catch {
    // فشل التحميل/الضغط ⇒ نمرّر الأصل ولا نُسقط الصورة (القاعدة تتّسع بعد mediumtext).
    return { dataUrl: original, sizeKB: originalKB };
  }
}

