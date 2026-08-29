import { AlertTriangle, CheckCircle2, ImagePlus, Loader2, Sparkles, X } from "lucide-react";
import { useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { compressImageDataUrl } from "@/components/form/ImageUploader";
import { describeAiError } from "@/lib/aiProductError";
import { trpc } from "@/lib/trpc";
import type { ExtractedProductFacts } from "@shared/productContentAi";

/**
 * ImageFirstProductAssistant — التدفّق العكسيّ (م٣): الموظّف يرفع صورة أوّلاً، والنظام
 * يستخرج ما يظهر بوضوح (اسم مقترح، نوع، ماركة، موديل، وصف قصير) ثمّ يعرضها للمراجعة.
 * الاعتماد بيد الموظّف — «طبّق» يملأ الحقول **الفارغة فقط** ولا يطمس ما كتبه بيده.
 * لا حفظ للصورة على الخادم ولا للمنتج — هذا مدخل تعبئةٍ لا مسار نشر.
 */

type CurrentFields = {
  name: string;
  productType: string;
  brand: string;
  modelName: string;
  description: string;
};

type ApplyPayload = {
  suggestedName: string | null;
  productType: string | null;
  brand: string | null;
  modelHint: string | null;
  description: string;
};

type Props = {
  currentFields: CurrentFields;
  onApply: (payload: ApplyPayload) => void;
};

const ACCEPTED_MIMES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"] as const;
type AcceptedMime = (typeof ACCEPTED_MIMES)[number];

function parseDataUrl(dataUrl: string): { mime: AcceptedMime; base64: string } | null {
  const m = /^data:([a-z0-9.+/-]+);base64,([\s\S]+)$/i.exec(dataUrl.trim());
  if (!m) return null;
  const mime = m[1].toLowerCase() as AcceptedMime;
  if (!ACCEPTED_MIMES.includes(mime)) return null;
  return { mime, base64: m[2] };
}

export function ImageFirstProductAssistant({ currentFields, onApply }: Props) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewSizeKB, setPreviewSizeKB] = useState<number>(0);
  const [pendingUpload, setPendingUpload] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [facts, setFacts] = useState<ExtractedProductFacts | null>(null);
  const [applied, setApplied] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const extract = trpc.catalog.extractFactsFromImage.useMutation({
    onSuccess: (result) => {
      setFacts(result.facts);
      setApplied(false);
    },
  });

  function reset() {
    setPreviewUrl(null);
    setPreviewSizeKB(0);
    setUploadError(null);
    setFacts(null);
    setApplied(false);
    extract.reset();
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleFileChosen(file: File) {
    setUploadError(null);
    setFacts(null);
    setApplied(false);
    extract.reset();
    setPendingUpload(true);
    try {
      const raw = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ""));
        reader.onerror = () => reject(reader.error ?? new Error("read failed"));
        reader.readAsDataURL(file);
      });
      // نضغط دائماً: صور الجوّال قد تبلغ عدّة ميغابايت. compressImageDataUrl يعود بالأصل حين
      // يكون الأصل أصغر من الناتج (صور مضغوطة أصلاً) — فلا فقدَ جودة بلا داعٍ.
      const { dataUrl, sizeKB } = await compressImageDataUrl(raw);
      const parsed = parseDataUrl(dataUrl);
      if (!parsed) {
        setUploadError("نوع الصورة غير مدعوم (استعمل JPEG/PNG/WEBP/GIF/AVIF).");
        return;
      }
      // هامش أمانٍ ٥٪ فوق سقف الخادم (900KB) — يعطي نافذةً لخطأ قياسٍ صغير.
      if (sizeKB > 945) {
        setUploadError(`الصورة كبيرة (${sizeKB}KB) — استعمل صورةً أصغر أو قصّها قبل الرفع.`);
        return;
      }
      setPreviewUrl(dataUrl);
      setPreviewSizeKB(sizeKB);
    } catch (err: any) {
      setUploadError(err?.message ?? "تعذّرت قراءة الصورة.");
    } finally {
      setPendingUpload(false);
    }
  }

  function runExtract() {
    if (!previewUrl) return;
    const parsed = parseDataUrl(previewUrl);
    if (!parsed) return;
    extract.mutate({
      imageBase64: parsed.base64,
      mime: parsed.mime,
      contextName: currentFields.name.trim() || null,
    });
  }

  function applyToForm() {
    if (!facts) return;
    onApply({
      suggestedName: facts.suggestedName,
      productType: facts.productType,
      brand: facts.brand,
      modelHint: facts.modelHint,
      description: facts.description,
    });
    setApplied(true);
  }

  const extractError = extract.error ? describeAiError(extract.error) : null;
  const anyFieldFilled = Boolean(
    currentFields.name.trim() ||
      currentFields.productType.trim() ||
      currentFields.brand.trim() ||
      currentFields.modelName.trim() ||
      currentFields.description.trim(),
  );

  const confidenceLabel =
    facts?.confidence === "high"
      ? "مرتفعة"
      : facts?.confidence === "medium"
        ? "متوسطة"
        : "منخفضة";

  return (
    <Card
      dir="rtl"
      className="border-violet-300/60 bg-gradient-to-bl from-violet-50/70 to-fuchsia-50/40 dark:border-violet-800/60 dark:from-violet-950/20 dark:to-fuchsia-950/10"
    >
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <ImagePlus aria-hidden className="size-4 text-violet-600" />
            بدء من صورة
          </CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            التقط صورة المنتج أو ارفعها — يقترح النظام الاسم والنوع والماركة والوصف، وأنت تراجع وتعتمد.
          </p>
        </div>
        {previewUrl && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={reset}
            className="text-muted-foreground"
          >
            <X aria-hidden className="size-4" />
            بدء من جديد
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {!previewUrl && (
          <label
            htmlFor="image-first-file"
            className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed border-violet-300/70 bg-background/60 px-4 py-8 text-center text-sm transition hover:bg-violet-50/50 dark:border-violet-800/60 dark:hover:bg-violet-950/20"
          >
            {pendingUpload ? (
              <Loader2 aria-hidden className="size-6 animate-spin text-violet-500" />
            ) : (
              <ImagePlus aria-hidden className="size-6 text-violet-500" />
            )}
            <span className="font-medium">
              {pendingUpload ? "جارٍ تحضير الصورة" : "اختر أو التقط صورة المنتج"}
            </span>
            <span className="text-[11px] text-muted-foreground">
              JPEG أو PNG أو WEBP — حتى 900KB (يُضغَط تلقائياً).
            </span>
            <input
              id="image-first-file"
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
              capture="environment"
              className="sr-only"
              disabled={pendingUpload}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFileChosen(file);
              }}
            />
          </label>
        )}

        {uploadError && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
          >
            <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
            <span>{uploadError}</span>
          </div>
        )}

        {previewUrl && (
          <div className="flex items-start gap-3 rounded-md border bg-background/70 p-3">
            <img
              src={previewUrl}
              alt="معاينة"
              className="size-24 shrink-0 rounded object-cover"
            />
            <div className="flex-1 space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="outline">{previewSizeKB}KB</Badge>
                {anyFieldFilled && (
                  <Badge variant="secondary" className="text-[10px]">
                    سيُملأ الفارغ فقط — لن يُطمَس ما كتبتَه
                  </Badge>
                )}
              </div>
              {!facts && (
                <Button
                  type="button"
                  size="sm"
                  onClick={runExtract}
                  disabled={extract.isPending}
                >
                  {extract.isPending ? (
                    <Loader2 aria-hidden className="size-4 animate-spin" />
                  ) : (
                    <Sparkles aria-hidden className="size-4" />
                  )}
                  {extract.isPending ? "جارٍ التحليل" : "حلّل الصورة"}
                </Button>
              )}
            </div>
          </div>
        )}

        {extractError && (
          <div
            role="alert"
            aria-live="assertive"
            className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
          >
            <p className="font-semibold">{extractError.title}</p>
            <p>{extractError.message}</p>
            {extractError.action && (
              <p className="mt-1 text-[11px] opacity-90">{extractError.action}</p>
            )}
          </div>
        )}

        {facts && (
          <div className="space-y-3 rounded-md border bg-background/80 p-3">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge variant="secondary" className="border-violet-400/40 bg-violet-100/60 text-violet-800 dark:bg-violet-900/30 dark:text-violet-200">
                اقتراحات بصريّة
              </Badge>
              <Badge variant="outline">الثقة: {confidenceLabel}</Badge>
              {applied && (
                <Badge variant="secondary" className="border-emerald-400/40 bg-emerald-100/60 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200">
                  طُبِّقَت الحقول الفارغة
                </Badge>
              )}
            </div>

            <dl className="grid gap-2 sm:grid-cols-2">
              <SuggestionRow label="الاسم المقترح" value={facts.suggestedName} />
              <SuggestionRow label="النوع" value={facts.productType} />
              <SuggestionRow label="الماركة" value={facts.brand} />
              <SuggestionRow label="الموديل" value={facts.modelHint} />
              <div className="sm:col-span-2">
                <SuggestionRow label="الوصف" value={facts.description || null} multiline />
              </div>
            </dl>

            {facts.keywords.length > 0 && (
              <div className="rounded border bg-muted/30 p-2 text-xs">
                <span className="font-semibold">كلمات بحث محتملة: </span>
                <span>{facts.keywords.join(" · ")}</span>
              </div>
            )}

            {facts.unsupportedGuesses.length > 0 && (
              <div className="rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)]/70 px-3 py-2 text-xs text-[var(--sem-warn)]">
                <p className="font-semibold">لم تُدرَج تلقائياً (اعتمدها يدوياً إن أردت):</p>
                <ul className="mt-1 list-disc space-y-1 pe-5">
                  {facts.unsupportedGuesses.map((g) => (
                    <li key={`${g.text}-${g.reason}`}>
                      {g.text}
                      <span className="text-muted-foreground"> — {g.reason}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex items-center justify-between gap-2 border-t pt-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <CheckCircle2 aria-hidden className="size-4 text-[var(--sem-pos)]" />
                راجع القيم أعلاه — الحقول الفارغة فقط تُملأ.
              </div>
              <Button type="button" onClick={applyToForm} disabled={applied}>
                {applied ? "طُبِّقَت" : "طبّق على النموذج"}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SuggestionRow({
  label,
  value,
  multiline,
}: {
  label: string;
  value: string | null;
  multiline?: boolean;
}) {
  return (
    <div className="space-y-0.5 rounded border bg-muted/20 p-2">
      <div className="text-[10px] font-semibold text-muted-foreground">{label}</div>
      {value ? (
        <div className={multiline ? "text-sm leading-relaxed" : "text-sm"}>{value}</div>
      ) : (
        <div className="text-xs text-muted-foreground">— لم يتبيّن —</div>
      )}
    </div>
  );
}
