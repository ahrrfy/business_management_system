import { compressImageDataUrl } from "./imageCompression";
import { acceptsImage, mergeUploadedImages, type ImageItem } from "./imageUploaderModel";
export type { ImageItem } from "./imageUploaderModel";
export { COMPRESSION_TARGET_KB, COMPRESSION_LADDER, dataUrlSizeKB, fitDimensions, webpSupported, __resetEncoderCache, encodeSmallest, compressCanvas, compressImageDataUrl } from "./imageCompression";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Camera, ImagePlus, Trash2, WandSparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";

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

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(r.error ?? new Error("تعذّرت قراءة الصورة"));
    r.onabort = () => reject(new Error("أُلغيت قراءة الصورة"));
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

  const latest = useRef({ value, onChange, maxItems, singlePrimary });
  latest.current = { value, onChange, maxItems, singlePrimary };
  const processing = useRef(false);
  const mounted = useRef(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function publish(next: ImageItem[]) {
    latest.current.value = next;
    latest.current.onChange(next);
  }
  async function intake(files: File[], replacingId: string | null = null) {
    if (processing.current || !files.length) return;
    const remaining = Math.max(0, maxItems - value.length + (replacingId ? 1 : 0));
    if (!remaining) { setError(`بلغت الحد الأقصى (${maxItems} صور).`); return; }
    const valid = files.filter((file) => acceptsImage(file, accept) && file.size <= maxSizeMB * 1024 * 1024);
    const accepted = valid.slice(0, replacingId ? 1 : remaining);
    if (!accepted.length) { setError(`صيغ غير مدعومة أو حجم أكبر من ${maxSizeMB}MB.`); return; }
    processing.current = true; setBusy(true); setError("");
    const out: ImageItem[] = [];
    let failed = files.length - accepted.length;
    try {
      for (const file of accepted) {
        try {
          const raw = await readFileAsDataUrl(file);
          if (!mounted.current) return;
          const { dataUrl, sizeKB } = await compressImageDataUrl(raw);
          out.push({ id: makeId(), dataUrl, sizeKB, name: file.name, isPrimary: false });
        } catch { failed += 1; }
      }
      if (!mounted.current) return;
      if (out.length) {
        const current = latest.current;
        const next = mergeUploadedImages(current.value, out, replacingId, current.maxItems, current.singlePrimary);
        if (next) publish(next);
        else { setError("حُذفت الصورة المستهدفة أثناء القراءة؛ أعد اختيار صورة لإضافتها."); return; }
      }
      if (failed) setError(`تعذّر إرفاق ${failed} من الملفات بسبب الصيغة أو الحجم أو فشل القراءة أو بلوغ الحد. أعد اختيار الملفات المطلوبة.`);
    } finally {
      processing.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  function makePrimary(id: string) {
    if (!singlePrimary) return;
    publish(latest.current.value.map((v) => ({ ...v, isPrimary: v.id === id })));
  }

  function remove(id: string) {
    const next = latest.current.value.filter((image) => image.id !== id).map((image) => ({ ...image }));
    if (singlePrimary && next.length && !next.some((image) => image.isPrimary)) next[0].isPrimary = true;
    publish(next);
  }

  function openRearCamera(id?: string) {
    if (processing.current) return;
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
        onClick={() => { if (!processing.current) galleryInputRef.current?.click(); }}
        onKeyDown={(e) => {
          if (!processing.current && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            galleryInputRef.current?.click();
          }
        }}
        className={cn(
          "relative cursor-pointer rounded-md border-2 border-dashed bg-muted/30 hover:bg-muted/50 transition-colors p-4 text-center",
          dragging ? "border-primary bg-primary/5" : "border-input"
        )}
        role="button"
        tabIndex={busy ? -1 : 0}
        aria-disabled={busy}
        aria-busy={busy}
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
          disabled={busy}
          onChange={(e) => { const files = Array.from(e.target.files || []); e.currentTarget.value = ""; void intake(files); }}
        />
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Button type="button" variant="outline" className="min-h-11 whitespace-normal" disabled={busy} onClick={() => openRearCamera()}>
          <Camera aria-hidden className="size-4" /> التقاط بالكاميرا الخلفية
        </Button>
        <Button type="button" variant="outline" className="min-h-11 whitespace-normal" disabled={busy} onClick={() => galleryInputRef.current?.click()}>
          <ImagePlus aria-hidden className="size-4" /> اختيار من المعرض
        </Button>
      </div>
      <input
        ref={cameraInputRef}
        type="file"
        accept={accept}
        capture="environment"
        disabled={busy}
        className="sr-only"
        onChange={(e) => {
          void intake(Array.from(e.target.files || []), replaceId);
          setReplaceId(null);
          e.currentTarget.value = "";
        }}
      />

      {busy && <p role="status" className="text-xs text-muted-foreground">تجهيز الصور قبل الإرفاق…</p>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}

      {value.length > 0 && (
        <div className="grid grid-cols-1 gap-2 min-[360px]:grid-cols-2 sm:grid-cols-4 md:grid-cols-5">
          {value.map((img) => (
            <div
              key={img.id}
              className={cn(
                "@container min-w-0 overflow-hidden rounded-md border bg-card",
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
              {/* ٢٠/٨ (لقطة المالك): عمودان ثابتان + `whitespace-nowrap` الافتراضيّ في Button
                  ⇒ «معالجة بالذكاء الاصطناعي» و«إعادة الالتقاط» يفيضان عن خليّتيهما فيتراكب النصّان
                  ويصيران غير مقروءَين على الهاتف. عمودٌ واحد في الضيّق، ولفٌّ للنصّ لا اقتطاع
                  (اسم الفعل العربيّ يفقد معناه إذا بُتِر). */}
              <div className="grid grid-cols-1 gap-px border-t bg-border @min-[220px]:grid-cols-2">
                {onEditImage && (
                  <Button
                    type="button"
                    variant="secondary"
                    className="min-h-11 min-w-0 whitespace-normal rounded-none bg-card px-2 text-xs leading-tight"
                    onClick={() => {
                      onEditImage(img.id);
                    }}
                  >
                  <WandSparkles aria-hidden className="size-3.5" /> معالجة بالذكاء الاصطناعي
                  </Button>
                )}
                <Button type="button" variant="outline" className="min-h-11 min-w-0 whitespace-normal rounded-none border-0 bg-card px-2 text-xs leading-tight" onClick={() => openRearCamera(img.id)}>
                  <Camera aria-hidden className="size-3.5" /> إعادة الالتقاط
                </Button>
                {singlePrimary && !img.isPrimary && (
                  <Button
                    type="button"
                    variant="secondary"
                    className="min-h-11 min-w-0 whitespace-normal rounded-none bg-card px-2 text-xs leading-tight"
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
                  className="min-h-11 min-w-0 whitespace-normal rounded-none px-2 text-xs leading-tight"
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
