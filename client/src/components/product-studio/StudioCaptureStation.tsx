import { BarcodeSearchCue, barcodeSearchInputClass } from "@/components/scan/BarcodeSearchCue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useBarcodeInput } from "@/hooks/useBarcodeInput";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { ArrowDown, Camera, CheckCircle2, Eye, Image as ImageIcon, Info, Loader2, ScanLine, Sparkles, ZoomIn } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { StudioUnknownBarcodeResolver } from "./StudioUnknownBarcodeResolver";
import { isUnknownStudioBarcodeFailure, shouldSubmitManualBarcode } from "./studioUnknownBarcode";

const CameraScanner = lazy(() => import("@/components/scan/CameraScanner").then((module) => ({ default: module.CameraScanner })));

export interface StudioPreviousImage {
  id: number;
  isPrimary: boolean;
  sortOrder: number;
  thumbDataUrl: string | null;
  contentHash: string | null;
  createdAt: string | null;
}

export interface ClaimedStudioProduct {
  taskId: number;
  productName: string;
  revision: number;
  approvedImages: number;
  requiredImages: number;
  previousImages?: StudioPreviousImage[];
}

/**
 * محطّة التصوير السريعة المتكاملة — أوّل ما يراه المصوّر ونقطة بدء كل دورة تصوير.
 *
 * تتضمن:
 * ١. مسح باركود المنتج (سلكي أو كاميرا أو كتابة).
 * ٢. عرض المعرض المصغر للصور السابقة المعتمدة للمنتج لمنع التكرار مع تكبير فوري.
 * ٣. دليل الزوايا والمواضع المطلوب تصويرها تالياً.
 * ٤. أزرار إجراء فوري للانتقال السريع لمحرر الاستوديو والتقاط الكاميرا.
 */
export function StudioCaptureStation({
  active,
  onClaimed,
  onClear,
  offline,
  onJumpToWorkspace,
}: {
  active: ClaimedStudioProduct | null;
  onClaimed: (claimed: ClaimedStudioProduct) => void;
  onClear: () => void;
  offline: boolean;
  onJumpToWorkspace?: () => void;
}) {
  const [code, setCode] = useState("");
  const [scanError, setScanError] = useState("");
  const [linkAllowed, setLinkAllowed] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [previewModalImg, setPreviewModalImg] = useState<{ id: number; url: string; isPrimary: boolean } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const claim = trpc.productStudio.claimByBarcode.useMutation({
    onSuccess: (result) => {
      setCode("");
      setScanError("");
      setLinkAllowed(false);
      onClaimed({
        taskId: result.taskId,
        productName: result.productName,
        revision: result.revision,
        approvedImages: result.approvedImages,
        requiredImages: result.requiredImages,
        previousImages: (result as { previousImages?: StudioPreviousImage[] }).previousImages ?? [],
      });
      notify.ok(result.claimed ? `فُتح «${result.productName}» للتصوير` : `«${result.productName}» بين يديك أصلاً`);
      if (onJumpToWorkspace) {
        onJumpToWorkspace();
      }
    },
    onError: (error, variables) => {
      // أبقِ الرمز مرئياً كي يستطيع المصوّر والمدير مراجعته/نسخه وربطه، ولا نحوله
      // إلى لغز يختفي لحظة ظهور رسالة «لا يطابق».
      setCode(variables.barcode);
      setScanError(error.message);
      setLinkAllowed(isUnknownStudioBarcodeFailure(error.data?.code, error.message));
      notify.err(error);
      inputRef.current?.focus();
    },
  });

  const submitCode = (value: string) => {
    if (!value.trim() || claim.isPending || offline) return;
    setCode(value);
    setScanError("");
    setLinkAllowed(false);
    claim.mutate({ barcode: value });
  };

  const barcodeInput = useBarcodeInput((scanned) => submitCode(scanned), {
    enabled: !offline && !claim.isPending,
    minLength: 2,
  });

  useEffect(() => {
    if (!active) inputRef.current?.focus();
  }, [active]);

  const previousImages = active?.previousImages ?? [];
  const currentSlot = Math.min((active?.approvedImages ?? 0) + 1, active?.requiredImages ?? 1);

  // توجيه الزوايا الذكي للمصور بحسب ترتيب الصورة الحالية
  const angleHint =
    (active?.approvedImages ?? 0) === 0
      ? "ابدأ بالتقاط الواجهة الأمامية للمنتج بشكل متوازن ومستوٍ في منتصف الكادر."
      : (active?.approvedImages ?? 0) === 1
        ? "التقط زاوية جانبية مائلة (3/4) أو لقطة للمنتج وهو مفتوح لإبراز تفاصيله."
        : (active?.approvedImages ?? 0) === 2
          ? "التقط تفاصيل الأزرار، الملحقات، أو الجهة الخلفية وعلامات الاستخدام."
          : "التقط زاوية تسويقية ترويجية إضافية تختلف عن الصور السابقة أعلاه.";

  return (
    <Card className="border-primary/20 bg-card shadow-sm">
      <CardContent className="space-y-4 p-4">
        {/* شريط المسح والإدخال السريع */}
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-56 flex-1 space-y-1.5">
            <Label htmlFor="studio-capture-barcode" className="flex items-center gap-2 font-medium">
              <ScanLine aria-hidden className="size-4 text-primary" /> امسح باركود المنتج لبدء التصوير
            </Label>
            <div className="relative">
              <Input
                id="studio-capture-barcode"
                ref={inputRef}
                className={barcodeSearchInputClass}
                value={code}
                inputMode="text"
                autoComplete="off"
                disabled={offline || claim.isPending}
                placeholder="وجّه الماسح أو اكتب الباركود ثم Enter"
                onChange={(event) => {
                  setCode(event.target.value);
                  setScanError("");
                  setLinkAllowed(false);
                }}
                onKeyDown={(event) => {
                  barcodeInput.handleKeyDown(event, setCode);
                  if (shouldSubmitManualBarcode(event.key, event.defaultPrevented)) {
                    event.preventDefault();
                    submitCode(code);
                  }
                }}
              />
              <BarcodeSearchCue />
            </div>
            {scanError && (
              <StudioUnknownBarcodeResolver
                barcode={code}
                error={scanError}
                linkAllowed={linkAllowed}
                onLinked={submitCode}
              />
            )}
          </div>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 border-dashed"
            disabled={offline || claim.isPending}
            onClick={() => setCameraOpen(true)}
          >
            <Camera aria-hidden className="size-4" /> الكاميرا
          </Button>
          {claim.isPending && <Loader2 aria-hidden className="mb-2 size-5 animate-spin text-primary" />}
        </div>

        {/* لوحة المنتج النشط والصور السابقة المعتمدة */}
        {active ? (
          <div className="space-y-3 rounded-lg border border-primary/30 bg-primary/[0.02] p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-2.5">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-base text-foreground">{active.productName}</span>
                  <Badge variant="outline" className="text-xs">مهمة #{active.taskId}</Badge>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  المطلوب: الصورة <span className="font-bold text-primary">{currentSlot}</span> من {active.requiredImages}
                  {active.approvedImages > 0 ? ` · اعتُمدت سابقاً ${active.approvedImages} صور` : " · أول صورة لهذا المنتج"}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {onJumpToWorkspace && (
                  <Button
                    type="button"
                    size="sm"
                    className="min-h-9 gap-1.5 font-medium"
                    onClick={onJumpToWorkspace}
                  >
                    <ArrowDown aria-hidden className="size-3.5" /> محرر الاستوديو
                  </Button>
                )}
                <Button type="button" variant="ghost" size="sm" className="min-h-9 text-xs" onClick={onClear}>
                  إنهاء المنتج
                </Button>
              </div>
            </div>

            {/* شريط الصور السابقة المعتمدة لمنع تكرار الزوايا */}
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="flex items-center gap-1.5 font-medium text-foreground">
                  <ImageIcon aria-hidden className="size-3.5 text-primary" />
                  الصور السابقة المعتمدة لهذا المنتج ({previousImages.length})
                </span>
                <span className="text-[11px] text-muted-foreground">
                  انقر على أي صورة لتكبيرها ومراجعة زواياها
                </span>
              </div>

              {previousImages.length > 0 ? (
                <div className="flex flex-wrap items-center gap-2.5 pt-1">
                  {previousImages.map((img, idx) => {
                    const src = img.thumbDataUrl || `/api/img/product/${img.id}?v=${img.contentHash?.slice(0, 16) || "thumb"}`;
                    return (
                      <button
                        key={img.id}
                        type="button"
                        onClick={() => setPreviewModalImg({ id: img.id, url: src, isPrimary: img.isPrimary })}
                        className="group relative size-16 shrink-0 overflow-hidden rounded-md border border-border bg-white shadow-xs transition hover:border-primary hover:ring-2 hover:ring-primary/20 focus-visible:outline-none"
                        title={`معاينة الصورة ${idx + 1}`}
                        aria-label={`معاينة الصورة المعتمدة ${idx + 1}`}
                      >
                        <img
                          src={src}
                          alt={`صورة معتمدة ${idx + 1}`}
                          className="size-full object-contain p-0.5"
                          loading="lazy"
                        />
                        {img.isPrimary && (
                          <span className="absolute bottom-0 inset-x-0 bg-primary/90 text-[9px] font-medium text-primary-foreground text-center leading-tight py-0.5">
                            رئيسية
                          </span>
                        )}
                        <span className="absolute top-1 left-1 rounded bg-black/60 p-0.5 opacity-0 transition group-hover:opacity-100 text-white">
                          <ZoomIn aria-hidden className="size-3" />
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-md border border-dashed bg-muted/20 p-2.5 text-xs text-muted-foreground">
                  لا توجد صور معتمدة سابقة لهذا المنتج. التقط الصورة الرئيسية الأولى الآن.
                </div>
              )}

              {/* شارة التوجيه للزاوية التالية */}
              <div className="flex items-start gap-2 rounded-md bg-accent/40 p-2.5 text-xs text-foreground">
                <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <span className="font-semibold text-primary">توجيه الزاوية للصورة {currentSlot}: </span>
                  <span className="text-muted-foreground">{angleHint}</span>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 aria-hidden className="size-4 text-[var(--sem-pos)]" /> الاستوديو جاهز. وجّه الماسح نحو باركود المنتج لفتحه والبدء مباشرة.
          </p>
        )}
      </CardContent>

      {/* نافذة معاينة وتكبير الصورة السابقة */}
      {previewModalImg && (
        <Dialog open onOpenChange={(open) => { if (!open) setPreviewModalImg(null); }}>
          <DialogContent className="max-w-md sm:max-w-lg">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-base">
                <ImageIcon aria-hidden className="size-4 text-primary" />
                معاينة الصورة المعتمدة #{previewModalImg.id}
                {previewModalImg.isPrimary && <Badge variant="default" className="text-xs">رئيسية</Badge>}
              </DialogTitle>
              <DialogDescription className="text-xs">
                استعرض زاوية وتفاصيل هذه الصورة السابقة لتصوير زاوية مكملة وجديدة للمنتج.
              </DialogDescription>
            </DialogHeader>
            <div className="overflow-hidden rounded-lg border bg-white p-2">
              <img
                src={previewModalImg.url}
                alt="معاينة الصورة المعتمدة"
                className="mx-auto max-h-80 w-full object-contain"
              />
            </div>
            <div className="flex justify-end">
              <Button type="button" variant="outline" size="sm" onClick={() => setPreviewModalImg(null)}>
                إغلاق
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* مسح الكاميرا المستمر */}
      {cameraOpen && (
        <Suspense fallback={null}>
          <CameraScanner
            open
            keepOpen
            onClose={() => setCameraOpen(false)}
            onDetect={(barcode) => {
              submitCode(barcode);
            }}
          />
        </Suspense>
      )}
    </Card>
  );
}
