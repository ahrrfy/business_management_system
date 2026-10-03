import { lazy, Suspense, useRef, useState, useTransition } from "react";
import {
  AlertCircle,
  Camera,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Eye,
  Image as ImageIcon,
  Loader2,
  Package,
  Plus,
  RefreshCw,
  ScanLine,
  Send,
  Sparkles,
  Upload,
  X,
  ZoomIn,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { ACTION_LABELS } from "@shared/actionLabels";
import { runFreeStudioCut, runFreeStudioFlatten } from "@/lib/imageStudio/freePipeline";
import { createProductDisplayThumbnail } from "@/lib/productImageThumbnail";
import { compressCanvas } from "@/components/form/ImageUploader";

const CameraScanner = lazy(() =>
  import("@/components/scan/CameraScanner").then((module) => ({ default: module.CameraScanner })),
);

type StudioMode = "FLATTEN" | "CUT" | "ORIGINAL";

interface Props {
  className?: string;
  onProductHandled?: (productId: number) => void;
  offline?: boolean;
}

/**
 * مقياس ضغط آمن ومحكوم لتجهيز صور كاميرا الهاتف (خصوصاً أجهزة أندرويد القديمة)
 * دون استنزاف الذاكرة أو التسبب في انهيار المتصفح.
 */
async function prepareMobileCapturedImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("تعذّر قراءة ملف الصورة"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("تعذّر تحميل بيانات الصورة"));
      img.onload = () => {
        const MAX_DIM = 1600;
        let { width, height } = img;
        if (width > MAX_DIM || height > MAX_DIM) {
          if (width > height) {
            height = Math.round((height * MAX_DIM) / width);
            width = MAX_DIM;
          } else {
            width = Math.round((width * MAX_DIM) / height);
            height = MAX_DIM;
          }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) {
          resolve(reader.result as string);
          return;
        }
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, width, height);

        // ترميز WebP أو JPEG بحجم خفيف
        try {
          const dataUrl = canvas.toDataURL("image/jpeg", 0.88);
          resolve(dataUrl);
        } catch {
          resolve(reader.result as string);
        }
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

export function StudioQuickBarcodeSearch({ className = "", onProductHandled, offline = false }: Props) {
  const utils = trpc.useUtils();
  const [barcodeInput, setBarcodeInput] = useState("");
  const [cameraScannerOpen, setCameraScannerOpen] = useState(false);
  const [lookupBarcode, setLookupBarcode] = useState<string | null>(null);
  const [productModalOpen, setProductModalOpen] = useState(false);

  // حالة الصورة الجديدة الملتقطة
  const [rawImage, setRawImage] = useState<string | null>(null);
  const [processedImage, setProcessedImage] = useState<string | null>(null);
  const [activeMode, setActiveMode] = useState<StudioMode>("FLATTEN");
  const [setAsPrimary, setSetAsPrimary] = useState(true);
  const [isProcessingAi, setIsProcessingAi] = useState(false);
  const [previewZoomImage, setPreviewZoomImage] = useState<string | null>(null);

  const cameraInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // استعلام بيانات المنتج بالباركود
  const lookupQuery = trpc.productStudio.quickBarcodeLookup.useQuery(
    { barcode: lookupBarcode! },
    {
      enabled: Boolean(lookupBarcode) && !offline,
      retry: false,
    },
  );

  // حفظ واعتماد الصورة المباشرة
  const saveMutation = trpc.productStudio.quickSaveBarcodeProductImage.useMutation({
    onSuccess: (data) => {
      notify.ok(data.message);
      utils.productStudio.invalidate();
      if (lookupBarcode) {
        lookupQuery.refetch();
      }
      if (data.imageId && onProductHandled && lookupQuery.data?.product?.id) {
        onProductHandled(lookupQuery.data.product.id);
      }
      // تصفير الصورة الملتقطة بعد الحفظ الناجح
      setRawImage(null);
      setProcessedImage(null);
    },
    onError: (err) => {
      notify.err(err.message || "تعذّر حفظ الصورة");
    },
  });

  const handleStartSearch = (code: string) => {
    const trimmed = code.trim();
    if (!trimmed || offline) return;
    setLookupBarcode(trimmed);
    setProductModalOpen(true);
    // تصفير مدخلات الصورة القديمة
    setRawImage(null);
    setProcessedImage(null);
  };

  const handleCameraDetect = (detected: string) => {
    setCameraScannerOpen(false);
    setBarcodeInput(detected);
    handleStartSearch(detected);
  };

  // معالجة الصورة في المتصفح حسب الوضع المختار
  const processImageInMode = async (sourceDataUrl: string, mode: StudioMode) => {
    setIsProcessingAi(true);
    try {
      if (mode === "ORIGINAL") {
        setProcessedImage(sourceDataUrl);
      } else if (mode === "FLATTEN") {
        const result = await runFreeStudioFlatten(sourceDataUrl);
        setProcessedImage(result.dataUrl);
      } else if (mode === "CUT") {
        try {
          const result = await runFreeStudioCut(sourceDataUrl);
          setProcessedImage(result.dataUrl);
        } catch {
          // التدهور السلس إذا لم يدعم الهاتف نموذج العزل
          notify.warn("تعذّر العزل التلقائي بالذكاء، تم تطبيق المعالجة البيضاء النقية.");
          const fallbackResult = await runFreeStudioFlatten(sourceDataUrl);
          setProcessedImage(fallbackResult.dataUrl);
        }
      }
    } catch (err: any) {
      notify.err(err.message || "تعذّر تطبيق معالجة الاستوديو");
      setProcessedImage(sourceDataUrl);
    } finally {
      setIsProcessingAi(false);
    }
  };

  // عند اختيار أو التقاط صورة جديدة من الكاميرا
  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      setIsProcessingAi(true);
      const optimizedDataUrl = await prepareMobileCapturedImage(file);
      setRawImage(optimizedDataUrl);
      await processImageInMode(optimizedDataUrl, activeMode);
    } catch (err: any) {
      notify.err(err.message || "تعذّر تجهيز الصورة");
    } finally {
      setIsProcessingAi(false);
      // إعادة تصفير مدخل الملف للسماح باختيار نفس الصورة مجدداً
      event.target.value = "";
    }
  };

  // تبديل وضع المعالجة للصورة الحالية
  const handleModeChange = async (newMode: StudioMode) => {
    setActiveMode(newMode);
    if (rawImage) {
      await processImageInMode(rawImage, newMode);
    }
  };

  // إرسال وحفظ الصورة (اعتماد مباشر للمدير، أو إرسال للمراجعة لغير المدير)
  const handleSubmitImage = async () => {
    if (!processedImage || !lookupQuery.data?.product?.id) return;

    try {
      const thumb = await createProductDisplayThumbnail(processedImage);
      saveMutation.mutate({
        productId: lookupQuery.data.product.id,
        variantId: lookupQuery.data.product.variantId ?? undefined,
        barcode: lookupBarcode ?? undefined,
        originalDataUrl: rawImage,
        processedDataUrl: processedImage,
        thumbnailDataUrl: thumb,
        mode: activeMode,
        setAsPrimary,
      });
    } catch (err: any) {
      notify.err(err.message || "تعذّر تجهيز المصغّرة وإرسال الصورة");
    }
  };

  const product = lookupQuery.data?.product;
  const existingImages = lookupQuery.data?.images ?? [];
  const canAutoApprove = lookupQuery.data?.canAutoApprove === true;
  const hasImages = existingImages.length > 0;

  return (
    <>
      <Card className={`border-primary/25 bg-gradient-to-br from-primary/[0.03] via-card to-background shadow-sm ${className}`}>
        <CardContent className="p-3 sm:p-4">
          <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <ScanLine aria-hidden className="size-5" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-foreground">مسح واستعلام المنتجات بالباركود</h3>
                <p className="text-xs text-muted-foreground">
                  مسح فوري بالكاميرا أو القارئ لمعاينة الصور وإضافة لقطات جديدة ومعالجتها واعتمادها مباشرة.
                </p>
              </div>
            </div>

            <div className="flex w-full items-center gap-2 sm:w-auto sm:max-w-md sm:flex-1 sm:justify-end">
              <div className="w-full flex-1">
                <UnifiedSearchInput
                  ref={searchInputRef}
                  value={barcodeInput}
                  onChange={(val) => setBarcodeInput(val)}
                  onScan={(scanned) => {
                    setBarcodeInput(scanned);
                    handleStartSearch(scanned);
                  }}
                  onSubmit={() => handleStartSearch(barcodeInput)}
                  barcode={true}
                  disabled={offline || lookupQuery.isLoading}
                  placeholder="امسح الباركود أو اكتبه ثم اضغط Enter..."
                  className="w-full"
                />
              </div>

              <Button
                type="button"
                variant="outline"
                size="default"
                disabled={offline}
                onClick={() => setCameraScannerOpen(true)}
                className="shrink-0 gap-1.5 border-dashed font-semibold"
                title="مسح باركود المنتج بكاميرا الهاتف"
              >
                <Camera aria-hidden className="size-4 text-primary" />
                <span className="hidden xs:inline">كاميرا الهاتف</span>
                <span className="xs:hidden">مسح</span>
              </Button>

              <Button
                type="button"
                size="default"
                disabled={offline || !barcodeInput.trim() || lookupQuery.isLoading}
                onClick={() => handleStartSearch(barcodeInput)}
                className="shrink-0 font-semibold"
              >
                {lookupQuery.isLoading && lookupBarcode === barcodeInput.trim() ? (
                  <Loader2 aria-hidden className="size-4 animate-spin" />
                ) : (
                  "استعلام"
                )}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ماسح باركود كاميرا الهاتف المتطور والمتجاوب */}
      {cameraScannerOpen && (
        <Suspense fallback={null}>
          <CameraScanner
            open={cameraScannerOpen}
            onClose={() => setCameraScannerOpen(false)}
            onDetect={handleCameraDetect}
          />
        </Suspense>
      )}

      {/* نافذة معاينة المنتج وإضافة ومعالجة الصور المباشرة */}
      <Dialog open={productModalOpen} onOpenChange={(open) => {
        if (!open) {
          setProductModalOpen(false);
          setLookupBarcode(null);
          setRawImage(null);
          setProcessedImage(null);
        }
      }}>
        <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2 text-base sm:text-lg">
              <Package aria-hidden className="size-5 text-primary" />
              <span>معاينة وتصوير المنتج السريع</span>
              {lookupBarcode && (
                <Badge variant="outline" className="font-mono text-xs" dir="ltr">
                  {lookupBarcode}
                </Badge>
              )}
            </DialogTitle>
            <DialogDescription className="text-xs">
              استعرض الصور الحالية للمنتج، أو التقط صورة جديدة بكاميرا هاتفك وعالجها بالذكاء فوراً.
            </DialogDescription>
          </DialogHeader>

          {lookupQuery.isLoading ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Loader2 aria-hidden className="size-8 animate-spin text-primary" />
              <p className="mt-3 text-sm text-muted-foreground">{ACTION_LABELS.loading}</p>
            </div>
          ) : lookupQuery.isError ? (
            <div className="space-y-3 py-6 text-center">
              <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
                <AlertCircle aria-hidden className="size-6" />
              </div>
              <p className="text-sm font-medium text-foreground">
                {lookupQuery.error?.message || "تعذّر العثور على المنتج بالرمز الممسوح."}
              </p>
              <div className="flex justify-center gap-2 pt-2">
                <Button variant="outline" size="sm" onClick={() => setProductModalOpen(false)}>
                  إغلاق
                </Button>
                <Button size="sm" onClick={() => setCameraScannerOpen(true)}>
                  <Camera aria-hidden className="size-3.5 me-1" /> مسح رمز آخر
                </Button>
              </div>
            </div>
          ) : product ? (
            <div className="space-y-4">
              {/* بطاقة معلومات المنتج السريعة */}
              <div className="rounded-lg border bg-muted/20 p-3 sm:p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h4 className="text-base font-bold text-foreground">{product.name}</h4>
                    {product.variantName && (
                      <p className="text-xs font-semibold text-primary">{product.variantName}</p>
                    )}
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {product.categoryName && <span>التصنيف: {product.categoryName}</span>}
                      {product.brand && <span>الماركة: {product.brand}</span>}
                      {product.modelName && <span>الموديل: {product.modelName}</span>}
                      {product.unitName && <span>الوحدة: {product.unitName}</span>}
                    </div>
                  </div>

                  <div>
                    {hasImages ? (
                      <Badge variant="outline" className="border-emerald-600/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300">
                        <CheckCircle2 aria-hidden className="size-3 me-1" />
                        {existingImages.length} صور معتمدة
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="border-amber-600/40 bg-amber-500/10 text-amber-800 dark:text-amber-300">
                        <AlertCircle aria-hidden className="size-3 me-1" />
                        فجوة صور — بلا صور
                      </Badge>
                    )}
                  </div>
                </div>
              </div>

              {/* معرض الصور السابقة المعتمدة إن وجدت */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-foreground flex items-center gap-1.5">
                    <ImageIcon aria-hidden className="size-4 text-primary" />
                    الصور الحالية في الكتالوج ({existingImages.length})
                  </span>
                  <span className="text-muted-foreground text-[11px]">
                    انقر على أي صورة لمعاينتها بحجم كامل
                  </span>
                </div>

                {hasImages ? (
                  <div className="flex flex-wrap items-center gap-2.5 overflow-x-auto rounded-lg border bg-card p-2.5">
                    {existingImages.map((img, idx) => (
                      <button
                        key={img.id}
                        type="button"
                        onClick={() => setPreviewZoomImage(img.url || img.thumbDataUrl)}
                        className="group relative size-20 shrink-0 overflow-hidden rounded-md border bg-white shadow-xs transition hover:border-primary hover:ring-2 hover:ring-primary/20"
                        title={`معاينة الصورة ${idx + 1}`}
                      >
                        <img
                          src={img.thumbDataUrl || img.url}
                          alt={`صورة ${idx + 1}`}
                          className="size-full object-contain p-1"
                          loading="lazy"
                        />
                        {img.isPrimary && (
                          <span className="absolute bottom-0 inset-x-0 bg-primary/90 text-[9px] font-medium text-primary-foreground text-center py-0.5 leading-tight">
                            رئيسية
                          </span>
                        )}
                        <span className="absolute top-1 left-1 rounded bg-black/60 p-0.5 opacity-0 transition group-hover:opacity-100 text-white">
                          <ZoomIn aria-hidden className="size-3" />
                        </span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-lg border border-dashed border-amber-500/30 bg-amber-500/5 p-4 text-center">
                    <p className="text-xs font-medium text-amber-800 dark:text-amber-300">
                      هذا المنتج لا يمتلك أي صورة معتمدة في الكتالوج حتى الآن.
                    </p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      استخدم كاميرا الهاتف بالأسفل لالتقاط الصورة الأولى مباشرة.
                    </p>
                  </div>
                )}
              </div>

              {/* قسم التقاط وإضافة صورة جديدة */}
              <div className="space-y-3 rounded-xl border border-primary/25 bg-card p-3 sm:p-4">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-2.5">
                  <span className="text-sm font-bold text-foreground flex items-center gap-1.5">
                    <Sparkles aria-hidden className="size-4 text-primary" />
                    إضافة صورة جديدة ومعالجتها بستوديو الذكاء
                  </span>
                  {rawImage && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setRawImage(null);
                        setProcessedImage(null);
                      }}
                      className="h-8 text-xs text-muted-foreground"
                    >
                      إلغاء اللقطة
                    </Button>
                  )}
                </div>

                {/* خيارات الإدخال (كاميرا الهاتف المباشرة أو المعرض) */}
                <input
                  ref={cameraInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  onChange={handleFileChange}
                />
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleFileChange}
                />

                {!rawImage ? (
                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 pt-1">
                    <Button
                      type="button"
                      variant="default"
                      size="lg"
                      onClick={() => cameraInputRef.current?.click()}
                      className="min-h-12 gap-2 text-sm font-bold shadow-sm"
                    >
                      <Camera aria-hidden className="size-5" />
                      التقاط بكاميرا الهاتف الآن
                    </Button>

                    <Button
                      type="button"
                      variant="outline"
                      size="lg"
                      onClick={() => fileInputRef.current?.click()}
                      className="min-h-12 gap-2 text-sm font-semibold"
                    >
                      <Upload aria-hidden className="size-5" />
                      اختيار من صور الجهاز أو المعرض
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {/* شريط اختيار وضع معالجة الاستوديو */}
                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">وضع المعالجة في الاستوديو:</Label>
                      <div className="grid grid-cols-3 gap-2">
                        <button
                          type="button"
                          onClick={() => handleModeChange("FLATTEN")}
                          disabled={isProcessingAi}
                          className={`flex flex-col items-center justify-center rounded-lg border p-2 text-center transition ${
                            activeMode === "FLATTEN"
                              ? "border-primary bg-primary/10 text-primary font-bold shadow-xs"
                              : "border-border bg-background text-muted-foreground hover:bg-accent/40"
                          }`}
                        >
                          <span className="text-xs">خلفية بيضاء نقية</span>
                          <span className="text-[10px] opacity-75">سريع 100% ومناسب للهواتف</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => handleModeChange("CUT")}
                          disabled={isProcessingAi}
                          className={`flex flex-col items-center justify-center rounded-lg border p-2 text-center transition ${
                            activeMode === "CUT"
                              ? "border-primary bg-primary/10 text-primary font-bold shadow-xs"
                              : "border-border bg-background text-muted-foreground hover:bg-accent/40"
                          }`}
                        >
                          <span className="text-xs flex items-center gap-1">
                            <Sparkles aria-hidden className="size-3" />
                            عزل بالذكاء
                          </span>
                          <span className="text-[10px] opacity-75">تفريغ الخلفية تلقائياً</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => handleModeChange("ORIGINAL")}
                          disabled={isProcessingAi}
                          className={`flex flex-col items-center justify-center rounded-lg border p-2 text-center transition ${
                            activeMode === "ORIGINAL"
                              ? "border-primary bg-primary/10 text-primary font-bold shadow-xs"
                              : "border-border bg-background text-muted-foreground hover:bg-accent/40"
                          }`}
                        >
                          <span className="text-xs">اللقطة الأصلية</span>
                          <span className="text-[10px] opacity-75">بدون عزل أو تفريغ</span>
                        </button>
                      </div>
                    </div>

                    {/* معاينة الصورة المجهزة والمعالجة */}
                    <div className="relative overflow-hidden rounded-xl border bg-muted/10 p-2">
                      {isProcessingAi ? (
                        <div className="flex h-56 flex-col items-center justify-center gap-2">
                          <Loader2 aria-hidden className="size-7 animate-spin text-primary" />
                          <p className="text-xs text-muted-foreground">{ACTION_LABELS.processing}</p>
                        </div>
                      ) : (
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                          <div className="space-y-1 text-center">
                            <span className="text-[11px] font-medium text-muted-foreground">الصورة الأصلية</span>
                            <div className="flex h-48 items-center justify-center rounded-lg border bg-white p-1">
                              <img
                                src={rawImage}
                                alt="الأصل"
                                className="max-h-full max-w-full object-contain"
                              />
                            </div>
                          </div>

                          <div className="space-y-1 text-center">
                            <span className="text-[11px] font-bold text-primary flex items-center justify-center gap-1">
                              <CheckCircle2 aria-hidden className="size-3" />
                              الناتج النهائي للاستوديو
                            </span>
                            <div className="flex h-48 items-center justify-center rounded-lg border border-primary/30 bg-white p-1 shadow-xs">
                              <img
                                src={processedImage || rawImage}
                                alt="الناتج"
                                className="max-h-full max-w-full object-contain"
                              />
                            </div>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* خيار تعيين كصورة رئيسية */}
                    <div className="flex items-center gap-2 pt-1">
                      <input
                        id="quick-studio-primary-check"
                        type="checkbox"
                        checked={setAsPrimary}
                        onChange={(e) => setSetAsPrimary(e.target.checked)}
                        className="size-4 rounded border-border text-primary focus:ring-primary"
                      />
                      <Label htmlFor="quick-studio-primary-check" className="cursor-pointer text-xs font-medium">
                        تعيين هذه اللقطة كصورة رئيسية للمنتج في الكتالوج والمتجر
                      </Label>
                    </div>

                    {/* أزرار الإجراء الذكي المبني على الصلاحية والرتبة */}
                    <div className="pt-2">
                      {canAutoApprove ? (
                        <div className="space-y-1.5">
                          <Button
                            type="button"
                            size="lg"
                            disabled={saveMutation.isPending || isProcessingAi || !processedImage}
                            onClick={handleSubmitImage}
                            className="min-h-12 w-full gap-2 font-bold bg-emerald-700 hover:bg-emerald-800 text-white shadow-md active:bg-emerald-900"
                          >
                            {saveMutation.isPending ? (
                              <Loader2 aria-hidden className="size-5 animate-spin" />
                            ) : (
                              <CheckCircle2 aria-hidden className="size-5" />
                            )}
                            اعتماد ونشر الصورة فوراً في الكتالوج
                          </Button>
                          <p className="text-[11px] text-center text-muted-foreground">
                            بصفتك مديراً، يتم اعتماد الصورة ونشرها في الكتالوج فوراً دون الحاجة لموافقة أو روتين لاحق.
                          </p>
                        </div>
                      ) : (
                        <div className="space-y-1.5">
                          <Button
                            type="button"
                            size="lg"
                            disabled={saveMutation.isPending || isProcessingAi || !processedImage}
                            onClick={handleSubmitImage}
                            className="min-h-12 w-full gap-2 font-bold shadow-md"
                          >
                            {saveMutation.isPending ? (
                              <Loader2 aria-hidden className="size-5 animate-spin" />
                            ) : (
                              <Send aria-hidden className="size-5" />
                            )}
                            إرسال الصورة للاعتماد والمراجعة الإدارية
                          </Button>
                          <p className="text-[11px] text-center text-muted-foreground">
                            سيتم رفع الصورة وإرسالها لمدير الاستوديو لاعتمادها ونشرها في الكتالوج.
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : null}

          <DialogFooter className="flex flex-row justify-between sm:justify-end gap-2 pt-2 border-t">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setProductModalOpen(false)}
            >
              إغلاق
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* نافذة تكبير الصورة المنفصلة */}
      {previewZoomImage && (
        <Dialog open={Boolean(previewZoomImage)} onOpenChange={(open) => !open && setPreviewZoomImage(null)}>
          <DialogContent className="sm:max-w-lg sm:max-w-xl">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-sm">
                <ImageIcon aria-hidden className="size-4 text-primary" />
                معاينة الصورة بكامل الدقة
              </DialogTitle>
            </DialogHeader>
            <div className="flex max-h-[75dvh] items-center justify-center overflow-hidden rounded-lg bg-white p-2">
              <img
                src={previewZoomImage}
                alt="معاينة كاملة"
                className="max-h-full max-w-full object-contain"
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" size="sm" onClick={() => setPreviewZoomImage(null)}>
                إغلاق
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
