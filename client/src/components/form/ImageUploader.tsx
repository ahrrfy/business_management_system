import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
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
 * JPEG 0.82 على خلفية بيضاء، وإعادة محاولة 0.7 ثم 0.6/١٢٨٠ حتى ≤٧٠٠KB) — العلاج
 * الجذري لعلّة «قيمة أطول من المسموح» عند حفظ data URLs كبيرة في القاعدة.
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
 * يضغط صورة data URL إلى JPEG على خلفية بيضاء (الشفافية تتحوّل بيضاء لا سوداء)
 * وفق سلّم المحاولات حتى ≤ الحجم المستهدف. يعيد الأصل كما هو إن فشل الضغط
 * أو كان الأصل أصغر من الناتج (صور مضغوطة جيداً أصلاً).
 */
export async function compressImageDataUrl(
  original: string
): Promise<{ dataUrl: string; sizeKB: number }> {
  const originalKB = dataUrlSizeKB(original);
  try {
    const img = await loadImage(original);
    let best: string | null = null;
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
      best = canvas.toDataURL("image/jpeg", step.quality);
      if (dataUrlSizeKB(best) <= COMPRESSION_TARGET_KB) break;
    }
    if (!best) return { dataUrl: original, sizeKB: originalKB };
    const bestKB = dataUrlSizeKB(best);
    return bestKB < originalKB ? { dataUrl: best, sizeKB: bestKB } : { dataUrl: original, sizeKB: originalKB };
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
}: ImageUploaderProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string>("");

  const intake = useCallback(
    async (files: File[]) => {
      setError("");
      if (!files.length) return;
      const remaining = Math.max(0, maxItems - value.length);
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
      const merged = [...value, ...out];
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
          intake(Array.from(e.dataTransfer.files));
        }}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inputRef.current?.click();
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
          ref={inputRef}
          type="file"
          accept={accept}
          multiple
          className="hidden"
          onChange={(e) => intake(Array.from(e.target.files || []))}
        />
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {value.length > 0 && (
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2">
          {value.map((img) => (
            <div
              key={img.id}
              className={cn(
                "group relative aspect-square rounded-md overflow-hidden border bg-card",
                img.isPrimary && singlePrimary && "ring-2 ring-primary"
              )}
            >
              <img src={img.dataUrl || img.url} alt={img.name || "صورة"} className="w-full h-full object-cover" />
              {img.isPrimary && singlePrimary && (
                <div className="absolute top-1 right-1 bg-primary text-primary-foreground text-[10px] font-medium px-1.5 py-0.5 rounded">
                  رئيسية
                </div>
              )}
              <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-1 p-1">
                {singlePrimary && !img.isPrimary && (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="h-6 text-[10px] px-2"
                    onClick={(e) => {
                      e.stopPropagation();
                      makePrimary(img.id);
                    }}
                  >
                    اجعلها رئيسية
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  className="h-6 text-[10px] px-2"
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(img.id);
                  }}
                >
                  حذف
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
