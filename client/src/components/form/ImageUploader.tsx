import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Camera, ImagePlus, Trash2, WandSparkles } from "lucide-react";
import { useCallback, useRef, useState } from "react";

/**
 * رفع صور متعدّد بسحب-وإفلات + اختيار الصورة الرئيسية.
 *
 * - يستقبل/يخرج قيم `ImageItem[]` (data URLs محلية + url نهائي اختياري).
 * - يحدّ من العدد (افتراضي ١٠) والحجم (٨ ميغا/صورة قبل الضغط) والصيغ (PNG/JPG/WEBP).
 * - الصورة الأولى تكون «رئيسية» افتراضياً، وللمستخدم تعيين أيّ صورة كرئيسية.
 *
 * v3-add-screens: يُستعمل في إضافة منتج (صور المنتج) وأمر الشغل (نموذج العمل المطلوب)
 * ودفع البطاقة (إيصال التحويل). للأخيرتين لا نحتاج «رئيسية» — يمكن إخفاء الزرّ بـ`singlePrimary={false}`.
 *
 * import-integration: تُضغط الصور تلقائياً قبل التخزين (canvas، بُعد أقصى ١٦٠٠px،
 * **WebP** 0.82 على خلفية بيضاء (وJPEG لمن لا يدعمها)، وإعادة محاولة 0.7 ثم 0.6/١٢٨٠
 * حتى ≤٧٠٠KB) — العلاج الجذري لعلّة «قيمة أطول من المسموح» عند حفظ data URLs كبيرة.
 */
export interface ImageItem {
  id: string;
  /** dataURL مؤقّت من القارئ المحلي — يُستبدل بـ`url` نهائي عند الحفظ. */
  dataUrl: string;
  /** url نهائي (بعد رفع للخادم) — قد يكون فارغاً قبل الحفظ. */
  url?: string;
  isPrimary: boolean;
  name?: string;
  sizeKB?: number;
}

export interface ImageUploaderProps {
  value: ImageItem[];
  onChange: (next: ImageItem[]) => void;
  maxItems?: number;
  /** الحد الأقصى لحجم الملف الخام بالميغا قبل الضغط (افتراضي ٨ — الضغط التلقائي يتكفّل بحجم التخزين). */
  maxSizeMB?: number;
  /** قبول صيغ — افتراضي PNG/JPG/WEBP. */
  accept?: string;
  /** إن كان `false`، لا يُظهر زرّ «اجعلها رئيسية» (مثل: إيصال دفع). */
  singlePrimary?: boolean;
  /** نصّ توضيحي يظهر تحت منطقة الإفلات. */
  hint?: string;
  className?: string;
  /**
   * إن مُرِّر، يظهر زرّ «استوديو» على كل صورة لاستهدافها بالتعديل بعينها (يُستعمل من ImageStudioUploader).
   * الاستهداف الفرديّ يحلّ علّة «تعديل كل الصور دفعةً» — لكل صورة استوديوها المستقل.
   */
  onEditImage?: (id: string) => void;
  /** معرّفات الصور المُستهدَفة حالياً بالتعديل في الاستوديو — تُبرَز بإطار/شارة مميّزة. */
  activeEditIds?: Set<string>;
}

const ACCEPT_DEFAULT = "image/png,image/jpeg,image/webp";

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

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function makeId() {
  return `img_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
}

export function ImageUploader({
  value,
  onChange,
  maxItems = 10,
  maxSizeMB = 8,
  accept = ACCEPT_DEFAULT,
  singlePrimary = true,
  hint,
  className,
  onEditImage,
  activeEditIds,
}: ImageUploaderProps) {
  const galleryInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string>("");
  const [replaceId, setReplaceId] = useState<string | null>(null);

  const intake = useCallback(
    async (files: File[], replacingId: string | null = null) => {
      setError("");
      if (!files.length) return;
      const retained = replacingId ? value.filter((item) => item.id !== replacingId) : value;
      const remaining = Math.max(0, maxItems - retained.length);
      if (remaining <= 0) {
        setError(`بلغت الحد الأقصى (${maxItems} صور).`);
        return;
      }
      const accepted = files
        .filter((f) => f.type.startsWith("image/"))
        .filter((f) => f.size <= maxSizeMB * 1024 * 1024)
        .slice(0, remaining);
      if (!accepted.length) {
        setError(`صيغ غير مدعومة أو حجم أكبر من ${maxSizeMB}MB.`);
        return;
      }
      const out: ImageItem[] = [];
      for (const f of accepted) {
        const raw = await readFileAsDataUrl(f);
        // ضغط قبل التخزين: الناتج الفعلي (وحجمه) هو ما يُحفظ — لا الملف الخام.
        const { dataUrl, sizeKB } = await compressImageDataUrl(raw);
        out.push({
          id: makeId(),
          dataUrl,
          isPrimary: false,
          name: f.name,
          sizeKB,
        });
      }
      const merged = [...retained, ...out];
      // اضبط الرئيسية: إن كانت أوّل إضافة، الأولى = رئيسية.
      if (singlePrimary && !merged.some((m) => m.isPrimary) && merged[0]) {
        merged[0].isPrimary = true;
      }
      onChange(merged);
    },
    [maxItems, maxSizeMB, onChange, singlePrimary, value]
  );

  function makePrimary(id: string) {
    if (!singlePrimary) return;
    onChange(value.map((v) => ({ ...v, isPrimary: v.id === id })));
  }

  function remove(id: string) {
    const next = value.filter((v) => v.id !== id);
    if (singlePrimary && next.length && !next.some((m) => m.isPrimary)) {
      next[0].isPrimary = true;
    }
    onChange(next);
  }

  function openRearCamera(id?: string) {
    setReplaceId(id ?? null);
    cameraInputRef.current?.click();
  }

  return (
    <div className={cn("space-y-2", className)}>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void intake(Array.from(e.dataTransfer.files));
        }}
        onClick={() => galleryInputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            galleryInputRef.current?.click();
          }
        }}
        className={cn(
          "relative cursor-pointer rounded-md border-2 border-dashed bg-muted/30 hover:bg-muted/50 transition-colors p-4 text-center",
          dragging ? "border-primary bg-primary/5" : "border-input"
        )}
        role="button"
        tabIndex={0}
        aria-label="منطقة رفع الصور"
      >
        <div className="text-sm font-medium">اسحب صوراً هنا أو انقر للاختيار</div>
        <div className="text-xs text-muted-foreground mt-1">
          {hint || `PNG · JPG · WEBP — حتى ${maxItems} صور، ${maxSizeMB}MB لكل صورة (تُضغط تلقائياً قبل الحفظ)`}
        </div>
        <input
          ref={galleryInputRef}
          type="file"
          accept={accept}
          multiple
          className="hidden"
          onChange={(e) => void intake(Array.from(e.target.files || []))}
        />
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Button type="button" variant="outline" className="min-h-11" onClick={() => openRearCamera()}>
          <Camera aria-hidden className="size-4" /> التقاط بالكاميرا الخلفية
        </Button>
        <Button type="button" variant="outline" className="min-h-11" onClick={() => galleryInputRef.current?.click()}>
          <ImagePlus aria-hidden className="size-4" /> اختيار من المعرض
        </Button>
      </div>
      <input
        ref={cameraInputRef}
        type="file"
        accept={accept}
        capture="environment"
        className="sr-only"
        onChange={(e) => {
          void intake(Array.from(e.target.files || []), replaceId);
          setReplaceId(null);
          e.currentTarget.value = "";
        }}
      />

      {error && <p className="text-xs text-destructive">{error}</p>}

      {value.length > 0 && (
        <div className="grid grid-cols-1 gap-2 min-[360px]:grid-cols-2 sm:grid-cols-4 md:grid-cols-5">
          {value.map((img) => (
            <div
              key={img.id}
              className={cn(
                "overflow-hidden rounded-md border bg-card",
                activeEditIds?.has(img.id)
                  ? "ring-2 ring-violet-500"
                  : img.isPrimary && singlePrimary && "ring-2 ring-primary"
              )}
            >
              <div className="relative aspect-square bg-muted/30">
                <img src={img.dataUrl || img.url} alt={img.name || "صورة"} className="size-full object-cover" />
                {img.isPrimary && singlePrimary && (
                  <div className="absolute top-1 right-1 rounded bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground">
                    رئيسية
                  </div>
                )}
                {activeEditIds?.has(img.id) && (
                  <div className="absolute top-1 left-1 rounded bg-violet-600 px-1.5 py-0.5 text-[10px] font-medium text-white">
                    قيد التعديل
                  </div>
                )}
              </div>
              <div className="grid grid-cols-2 gap-px border-t bg-border">
                {onEditImage && (
                  <Button
                    type="button"
                    variant="secondary"
                    className="min-h-11 rounded-none bg-card px-2 text-xs"
                    onClick={() => {
                      onEditImage(img.id);
                    }}
                  >
                    <WandSparkles aria-hidden className="size-3.5" /> معالجة في الاستوديو
                  </Button>
                )}
                <Button type="button" variant="outline" className="min-h-11 rounded-none border-0 bg-card px-2 text-xs" onClick={() => openRearCamera(img.id)}>
                  <Camera aria-hidden className="size-3.5" /> إعادة الالتقاط
                </Button>
                {singlePrimary && !img.isPrimary && (
                  <Button
                    type="button"
                    variant="secondary"
                    className="min-h-11 rounded-none bg-card px-2 text-xs"
                    onClick={() => {
                      makePrimary(img.id);
                    }}
                  >
                    اجعلها رئيسية
                  </Button>
                )}
                <Button
                  type="button"
                  variant="destructive"
                  className="min-h-11 rounded-none px-2 text-xs"
                  onClick={() => {
                    remove(img.id);
                  }}
                >
                  <Trash2 aria-hidden className="size-3.5" /> إزالة
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
