import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useCallback, useRef, useState } from "react";

/**
 * رفع صور متعدّد بسحب-وإفلات + اختيار الصورة الرئيسية.
 *
 * - يستقبل/يخرج قيم `ImageItem[]` (data URLs محلية + url نهائي اختياري).
 * - يحدّ من العدد (افتراضي ١٠) والحجم (٢ ميغا/صورة) والصيغ (PNG/JPG/WEBP).
 * - الصورة الأولى تكون «رئيسية» افتراضياً، وللمستخدم تعيين أيّ صورة كرئيسية.
 *
 * v3-add-screens: يُستعمل في إضافة منتج (صور المنتج) وأمر الشغل (نموذج العمل المطلوب)
 * ودفع البطاقة (إيصال التحويل). للأخيرتين لا نحتاج «رئيسية» — يمكن إخفاء الزرّ بـ`singlePrimary={false}`.
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
  /** الحد الأقصى للحجم بالميغا (افتراضي ٢). */
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
  maxSizeMB = 2,
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
        const dataUrl = await readFileAsDataUrl(f);
        out.push({
          id: makeId(),
          dataUrl,
          isPrimary: false,
          name: f.name,
          sizeKB: Math.round(f.size / 1024),
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
          {hint || `PNG · JPG · WEBP — حتى ${maxItems} صور، ${maxSizeMB}MB لكل صورة`}
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
