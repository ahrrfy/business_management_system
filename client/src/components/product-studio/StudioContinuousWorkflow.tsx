import React, { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  Camera,
  Check,
  CheckCircle2,
  Loader2,
  RotateCcw,
  ScanLine,
  Search,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { createProductDisplayThumbnail } from "@/lib/productImageThumbnail";
import { dataUrlSizeKB } from "@/components/form/imageCompression";
import { CameraScanner } from "@/components/scan/CameraScanner";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import {
  StudioProductCardStatus,
  type StudioActiveJob,
  type StudioProductDetails,
  type StudioProductImage,
  type StudioProductLock,
} from "./StudioProductCardStatus";
import {
  StudioCameraCapture,
  type CapturedImageData,
} from "./StudioCameraCapture";
import { StudioPreviewSubmitBar } from "./StudioPreviewSubmitBar";

export type WorkflowStep = "SCAN" | "CAPTURE" | "PREVIEW";

export interface StudioContinuousWorkflowProps {
  initialBarcode?: string | null;
  initialProductId?: number | null;
  initialVariantId?: number | null;
  onProductHandled?: (productId: number) => void;
  /** تجاوز بيانات الاستعلام للاختبارات الآلية أو الحالات المعزولة */
  mockLookupData?: {
    product?: StudioProductDetails | null;
    images?: StudioProductImage[];
    activeJob?: StudioActiveJob | null;
    lock?: StudioProductLock | null;
    canAutoApprove?: boolean;
    isUnregistered?: boolean;
  } | null;
  /** تجاوز عملية الحفظ للاختبارات الآلية */
  mockOnSave?: (data: any) => Promise<any>;
  /** تجاوز عملية معالجة الذكاء الاصطناعي للاختبارات الآلية */
  mockOnAiTransform?: (data: any) => Promise<any>;
  className?: string;
}

export function StudioContinuousWorkflow({
  initialBarcode = null,
  initialProductId = null,
  initialVariantId = null,
  onProductHandled,
  mockLookupData = null,
  mockOnSave,
  mockOnAiTransform,
  className = "",
}: StudioContinuousWorkflowProps) {
  const utils = trpc.useUtils?.();

  // الحالة الرئيسية لمسار الخطوات الثلاث المتصل
  const [step, setStep] = useState<WorkflowStep>("SCAN");
  const [barcodeInput, setBarcodeInput] = useState<string>(initialBarcode || "");
  const [submittedBarcode, setSubmittedBarcode] = useState<string | null>(
    initialBarcode || null,
  );
  const [scannerOpen, setScannerOpen] = useState(false);
  const [selectedAction, setSelectedAction] = useState<"ADD" | "REPLACE" | null>(
    null,
  );
  const [capturedImage, setCapturedImage] = useState<CapturedImageData | null>(
    null,
  );
  const [aiEnhancedDataUrl, setAiEnhancedDataUrl] = useState<string | null>(null);
  const [aiEnhancedSizeKB, setAiEnhancedSizeKB] = useState<number | null>(null);
  const [previewMode, setPreviewMode] = useState<"AI" | "ORIGINAL">("AI");
  const [isAiEnhancing, setIsAiEnhancing] = useState<boolean>(false);
  const [fallbackApplied, setFallbackApplied] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState(false);
  const [successBanner, setSuccessBanner] = useState<string | null>(null);

  const [targetProductId, setTargetProductId] = useState<number | null | undefined>(
    initialProductId,
  );
  const [targetVariantId, setTargetVariantId] = useState<number | null | undefined>(
    initialVariantId,
  );

  const searchInputRef = useRef<HTMLInputElement>(null);
  const savingRef = useRef(false);
  const captureGenRef = useRef(0);
  const lockedProductIdRef = useRef<number | null>(null);

  useEffect(() => {
    setTargetProductId(initialProductId);
    setTargetVariantId(initialVariantId);
  }, [initialProductId, initialVariantId]);

  // استعلام المنتج بالباركود أو المعرف
  const hasLookupInput = Boolean(
    submittedBarcode?.trim() ||
      (targetProductId != null && Number(targetProductId) > 0),
  );

  // tRPC query الحقيقي (يتعطل عند توفر mockLookupData لتسريع الاختبارات أو العزل)
  const realLookupQuery = trpc.productStudio.quickBarcodeLookup.useQuery(
    {
      barcode: submittedBarcode?.trim() || undefined,
      productId: targetProductId ?? undefined,
      variantId: targetVariantId ?? undefined,
    },
    {
      enabled: hasLookupInput && mockLookupData === null,
      retry: false,
    },
  );

  // دمج بيانات الاستعلام الحقيقية أو المحاكاة للاختبارات
  const isQueryLoading = mockLookupData
    ? false
    : Boolean(realLookupQuery.isLoading);
  const productData = mockLookupData
    ? mockLookupData.product
    : realLookupQuery.data?.product;
  const imagesData = mockLookupData
    ? mockLookupData.images || []
    : realLookupQuery.data?.images || [];
  const activeJobData = mockLookupData
    ? mockLookupData.activeJob
    : realLookupQuery.data?.activeJob;
  const lockData = mockLookupData
    ? mockLookupData.lock
    : realLookupQuery.data?.lock;
  const canAutoApprove = mockLookupData
    ? Boolean(mockLookupData.canAutoApprove)
    : Boolean(realLookupQuery.data?.canAutoApprove);

  // فحص الباركود غير المسجل
  const isUnregistered = mockLookupData
    ? Boolean(mockLookupData.isUnregistered)
    : Boolean(
        submittedBarcode &&
          !isQueryLoading &&
          (realLookupQuery.isError || !realLookupQuery.data?.product),
      );

  // طفرة الحفظ الفوري
  const saveMutation =
    trpc.productStudio.quickSaveBarcodeProductImage.useMutation?.();

  // طفرة المعالجة الذكية بالذكاء الاصطناعي
  const aiTransformMutation =
    trpc.productStudio.quickAiTransform?.useMutation?.();

  // طفرات قفل التصوير التعاوني
  const acquireLockMutation =
    trpc.productStudio.acquireOrCheckLock?.useMutation?.();
  const heartbeatLockMutation =
    trpc.productStudio.heartbeatLock?.useMutation?.();
  const releaseLockMutation =
    trpc.productStudio.releaseLock?.useMutation?.();

  const releaseActiveLock = () => {
    const pid = lockedProductIdRef.current;
    if (pid && releaseLockMutation) {
      lockedProductIdRef.current = null;
      releaseLockMutation.mutate({ productId: pid });
    }
  };

  useEffect(() => {
    if (step !== "CAPTURE" && step !== "PREVIEW") return;
    const pid = lockedProductIdRef.current;
    if (!pid || !heartbeatLockMutation) return;
    const timer = window.setInterval(() => {
      heartbeatLockMutation.mutate({ productId: pid });
    }, 45_000);
    return () => window.clearInterval(timer);
  }, [step, heartbeatLockMutation]);

  useEffect(() => {
    return () => {
      releaseActiveLock();
    };
  }, []);

  // تنفيذ المعالجة الذكية بالذكاء الاصطناعي مع الحماية والبديل المحلي الآمن
  const triggerAiEnhancement = async (
    sourceDataUrl: string,
    productId?: number,
    barcode?: string | null,
  ) => {
    const gen = captureGenRef.current;
    setIsAiEnhancing(true);
    setFallbackApplied(false);

    try {
      if (mockOnAiTransform) {
        const res = await mockOnAiTransform({
          imageDataUrl: sourceDataUrl,
          mode: "AI",
          productId,
          barcode,
        });
        if (captureGenRef.current !== gen) return;
        const enhancedUrl = res?.imageDataUrl || sourceDataUrl;
        setAiEnhancedDataUrl(enhancedUrl);
        setAiEnhancedSizeKB(res?.sizeKB || dataUrlSizeKB(enhancedUrl));
        setFallbackApplied(Boolean(res?.fallbackApplied));
      } else if (aiTransformMutation) {
        const res = await aiTransformMutation.mutateAsync({
          imageDataUrl: sourceDataUrl,
          mode: "AI",
          productId,
          barcode: barcode || undefined,
        });
        if (captureGenRef.current !== gen) return;
        const enhancedUrl = res?.imageDataUrl || sourceDataUrl;
        setAiEnhancedDataUrl(enhancedUrl);
        setAiEnhancedSizeKB(dataUrlSizeKB(enhancedUrl));
        setFallbackApplied(Boolean(res?.fallbackApplied));
      } else {
        if (captureGenRef.current !== gen) return;
        // بديل محلي سريع في غياب الطفرة
        setAiEnhancedDataUrl(sourceDataUrl);
        setAiEnhancedSizeKB(dataUrlSizeKB(sourceDataUrl));
        setFallbackApplied(true);
      }
    } catch (err: unknown) {
      if (captureGenRef.current !== gen) return;
      // الاستمرارية عند تعطل الذكاء الاصطناعي (Graceful Fallback):
      // لا يتوقف العمل ولا تضيع الصورة عند تعطل المزود
      console.warn("AI studio enhancement fallback applied:", err);
      setAiEnhancedDataUrl(sourceDataUrl);
      setAiEnhancedSizeKB(dataUrlSizeKB(sourceDataUrl));
      setFallbackApplied(true);
    } finally {
      if (captureGenRef.current === gen) {
        setIsAiEnhancing(false);
      }
    }
  };

  // معالجة بدء البحث بالباركود
  const handleStartSearch = (code: string) => {
    const trimmed = code.trim();
    if (!trimmed) return;
    captureGenRef.current += 1;
    releaseActiveLock();
    setTargetProductId(null);
    setTargetVariantId(null);
    setSuccessBanner(null);
    setSubmittedBarcode(trimmed);
    setBarcodeInput(trimmed);
    setSelectedAction(null);
    setCapturedImage(null);
    setAiEnhancedDataUrl(null);
    setAiEnhancedSizeKB(null);
    setIsAiEnhancing(false);
    setStep("SCAN");
  };

  // معالجة كشف الباركود عبر الكاميرا
  const handleBarcodeDetected = (code: string) => {
    setScannerOpen(false);
    handleStartSearch(code);
  };

  // الانتقال إلى خطوة التصوير
  const handleStartCapture = async () => {
    captureGenRef.current += 1;
    if (productData?.id && !mockLookupData && acquireLockMutation) {
      try {
        const lockRes = await acquireLockMutation.mutateAsync({
          productId: productData.id,
          variantId: productData.variantId ?? undefined,
        });
        if (lockRes && lockRes.acquired === false) {
          toast.error(
            lockRes.activePhotographerName
              ? `المنتج قيد التصوير حالياً من قبل ${lockRes.activePhotographerName}`
              : "المنتج قيد التصوير حالياً من قبل مصوّر آخر",
          );
          return;
        }
        lockedProductIdRef.current = productData.id;
      } catch (err: unknown) {
        const msg =
          err instanceof Error ? err.message : "تعذّر حجز قفل التصوير للمنتج";
        toast.error(msg);
        return;
      }
    }
    setSuccessBanner(null);
    setCapturedImage(null);
    setAiEnhancedDataUrl(null);
    setAiEnhancedSizeKB(null);
    setStep("CAPTURE");
  };

  // اكتمال تجهيز الصورة من الكاميرا
  const handleImageCaptured = (data: CapturedImageData) => {
    setCapturedImage(data);
    setAiEnhancedDataUrl(null);
    setAiEnhancedSizeKB(null);
    setPreviewMode("AI");
    setFallbackApplied(false);
    setStep("PREVIEW");

    // تشغيل المعالجة بالذكاء الاصطناعي تلقائياً وفورياً بمجرد الالتقاط
    void triggerAiEnhancement(
      data.processedDataUrl,
      productData?.id,
      submittedBarcode || productData?.barcode,
    );
  };

  // التبديل بين وضع الذكاء الاصطناعي والصورة الأصلية
  const handleTogglePreviewMode = (mode: "AI" | "ORIGINAL") => {
    setPreviewMode(mode);
    // إذا اختار الذكاء الاصطناعي ولم تكن قد عولجت بعد
    if (mode === "AI" && !aiEnhancedDataUrl && !isAiEnhancing && capturedImage) {
      void triggerAiEnhancement(
        capturedImage.processedDataUrl,
        productData?.id,
        submittedBarcode || productData?.barcode,
      );
    }
  };

  // إعادة التصوير
  const handleRetake = () => {
    captureGenRef.current += 1;
    setCapturedImage(null);
    setAiEnhancedDataUrl(null);
    setAiEnhancedSizeKB(null);
    setIsAiEnhancing(false);
    setFallbackApplied(false);
    setPreviewMode("AI");
    setStep("CAPTURE");
  };

  // الإرسال والاعتماد بنقرة واحدة
  const handleSubmitImage = async () => {
    if (savingRef.current || isSaving || !capturedImage || !productData?.id) {
      return;
    }
    savingRef.current = true;
    setIsSaving(true);

    try {
      const isAi = previewMode === "AI";
      const finalProcessedUrl = isAi
        ? aiEnhancedDataUrl || capturedImage.processedDataUrl
        : capturedImage.processedDataUrl;

      // توليد مصغرة خفيفة
      let thumbnailDataUrl: string;
      try {
        thumbnailDataUrl = await createProductDisplayThumbnail(finalProcessedUrl);
      } catch {
        thumbnailDataUrl = finalProcessedUrl;
      }

      const clientRequestId = `studio-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

      const safeOriginalDataUrl =
        capturedImage.originalDataUrl && capturedImage.originalDataUrl.length <= 1_250_000
          ? capturedImage.originalDataUrl
          : capturedImage.processedDataUrl;

      const payload = {
        productId: productData.id,
        variantId: productData.variantId ?? undefined,
        barcode: submittedBarcode || productData.barcode || undefined,
        originalDataUrl: safeOriginalDataUrl,
        processedDataUrl: finalProcessedUrl,
        thumbnailDataUrl,
        mode: (isAi ? "AI" : "FLATTEN") as "AI" | "FLATTEN",
        setAsPrimary: selectedAction === "REPLACE" || imagesData.length === 0,
        clientRequestId,
      };

      if (mockOnSave) {
        await mockOnSave(payload);
      } else if (saveMutation) {
        await saveMutation.mutateAsync(payload);
      }

      // إبطال كاش المنتجات والاستوديو لتنعكس الصورة فورياً
      if (utils) {
        void utils.productStudio.invalidate();
        void utils.catalog.adminList.invalidate();
        void utils.catalog.posList.invalidate();
      }

      onProductHandled?.(productData.id);

      // إعادة التوجيه للخطوة الأولى مع راية النجاح لتحقيق التدفق المستمر
      setSuccessBanner(
        canAutoApprove
          ? `تم اعتماد ونشر صورة «${productData.name}» بنجاح في الكتالوج ونقاط البيع.`
          : `تم إرسال صورة «${productData.name}» بنجاح إلى طابور الاعتماد الإداري.`,
      );
      lockedProductIdRef.current = null;
      setCapturedImage(null);
      setAiEnhancedDataUrl(null);
      setAiEnhancedSizeKB(null);
      setSelectedAction(null);
      setStep("SCAN");

      // إعادة الاستعلام لتحديث معرض الصور المعتمدة
      if (!mockLookupData && realLookupQuery.refetch) {
        void realLookupQuery.refetch();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "تعذر حفظ واعتماد الصورة";
      toast.error(msg);
      throw err;
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  };

  return (
    <div
      dir="rtl"
      data-testid="studio-continuous-workflow"
      className={`w-full max-w-xl mx-auto space-y-4 px-2 sm:px-4 py-3 sm:py-5 transition-all ${className}`}
    >
      {/* 1. مؤشر خطوات التدفق المتصل الثلاث (Single-screen 3-step breadcrumb) */}
      <div
        data-testid="workflow-step-indicator"
        className="rounded-xl border border-border bg-card p-2.5 sm:p-3 shadow-sm"
      >
        <div className="flex items-center justify-between text-xs sm:text-sm font-semibold">
          {/* الخطوة 1: مسح المنتج */}
          <button
            type="button"
            onClick={() => setStep("SCAN")}
            className={`flex items-center gap-1.5 transition-colors ${
              step === "SCAN"
                ? "text-primary font-bold"
                : productData
                ? "text-foreground hover:text-primary"
                : "text-muted-foreground"
            }`}
          >
            <span
              className={`flex size-6 items-center justify-center rounded-full text-xs font-bold ${
                step === "SCAN"
                  ? "bg-primary text-primary-foreground"
                  : productData
                  ? "bg-emerald-500/20 text-emerald-600 dark:text-emerald-400"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              1
            </span>
            <span>مسح المنتج</span>
          </button>

          <span className="text-muted-foreground/40">/</span>

          {/* الخطوة 2: التقاط الصورة */}
          <button
            type="button"
            disabled={!productData}
            onClick={() => productData && setStep("CAPTURE")}
            className={`flex items-center gap-1.5 transition-colors ${
              step === "CAPTURE"
                ? "text-primary font-bold"
                : capturedImage
                ? "text-foreground hover:text-primary"
                : "text-muted-foreground"
            }`}
          >
            <span
              className={`flex size-6 items-center justify-center rounded-full text-xs font-bold ${
                step === "CAPTURE"
                  ? "bg-primary text-primary-foreground"
                  : capturedImage
                  ? "bg-emerald-500/20 text-emerald-600 dark:text-emerald-400"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              2
            </span>
            <span>التقاط الكاميرا</span>
          </button>

          <span className="text-muted-foreground/40">/</span>

          {/* الخطوة 3: المعاينة والإرسال */}
          <div
            className={`flex items-center gap-1.5 ${
              step === "PREVIEW"
                ? "text-primary font-bold"
                : "text-muted-foreground"
            }`}
          >
            <span
              className={`flex size-6 items-center justify-center rounded-full text-xs font-bold ${
                step === "PREVIEW"
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              3
            </span>
            <span>معاينة وإرسال</span>
          </div>
        </div>
      </div>

      {/* راية نجاح العملية السابقة لمتابعة التدفق المستمر */}
      {successBanner && (
        <div
          data-testid="studio-success-banner"
          className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 sm:p-4 text-emerald-700 dark:text-emerald-300 flex items-start gap-2.5 animate-in fade-in"
        >
          <CheckCircle2 aria-hidden className="size-5 shrink-0 mt-0.5 text-emerald-600 dark:text-emerald-400" />
          <div className="text-xs sm:text-sm space-y-0.5 flex-1">
            <p className="font-bold">عاشت إيدك!</p>
            <p className="text-emerald-800/90 dark:text-emerald-200/90 leading-relaxed">
              {successBanner}
            </p>
          </div>
        </div>
      )}

      {/* ==================== الخطوة 1: مسح واستعلام المنتج ==================== */}
      {step === "SCAN" && (
        <div className="space-y-4" data-testid="workflow-step-scan">
          {/* شريط المسح والبحث السريع */}
          <Card className="border-border bg-card shadow-sm">
            <CardContent className="p-3 sm:p-4 space-y-3">
              <div className="flex items-center justify-between gap-2 border-b border-border/70 pb-2">
                <span className="text-xs sm:text-sm font-bold text-foreground flex items-center gap-1.5">
                  <ScanLine aria-hidden className="size-4 text-primary" />
                  <span>مسح واستعلام الباركود</span>
                </span>
                <span className="text-xs text-muted-foreground">
                  كاميرا الهاتف أو القارئ اليدوي
                </span>
              </div>

              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                <div className="flex-1">
                  <UnifiedSearchInput
                    ref={searchInputRef}
                    value={barcodeInput}
                    onChange={(val) => setBarcodeInput(val)}
                    onScan={(scanned) => handleStartSearch(scanned)}
                    onSubmit={() => handleStartSearch(barcodeInput)}
                    barcode={true}
                    disabled={isQueryLoading}
                    placeholder="امسح الباركود أو اكتبه ثم اضغط Enter..."
                    className="w-full min-h-11"
                  />
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    type="button"
                    variant="outline"
                    size="default"
                    onClick={() => setScannerOpen(true)}
                    data-testid="btn-open-barcode-scanner"
                    className="min-h-11 flex-1 sm:flex-initial gap-1.5 font-semibold text-xs sm:text-sm"
                    title="مسح باركود المنتج بكاميرا الهاتف"
                  >
                    <Camera aria-hidden className="size-4 text-primary" />
                    <span>كاميرا الباركود</span>
                  </Button>

                  <Button
                    type="button"
                    variant="default"
                    size="default"
                    disabled={!barcodeInput.trim() || isQueryLoading}
                    onClick={() => handleStartSearch(barcodeInput)}
                    data-testid="btn-query-barcode"
                    className="min-h-11 px-4 font-semibold text-xs sm:text-sm"
                  >
                    {isQueryLoading ? (
                      <Loader2 aria-hidden className="size-4 animate-spin" />
                    ) : (
                      "استعلام"
                    )}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* ماسح كاميرا الباركود الحي */}
          {scannerOpen && (
            <CameraScanner
              open={scannerOpen}
              onClose={() => setScannerOpen(false)}
              onDetect={handleBarcodeDetected}
            />
          )}

          {/* بطاقة تفاصيل المنتج وشارات الحالة الثلاث */}
          <StudioProductCardStatus
            product={productData}
            barcode={submittedBarcode || barcodeInput}
            isUnregistered={isUnregistered}
            images={imagesData}
            activeJob={activeJobData}
            lock={lockData}
            selectedAction={selectedAction}
            onSelectAction={setSelectedAction}
            onStartCapture={handleStartCapture}
            onManualSearch={() => {
              setSubmittedBarcode(null);
              setBarcodeInput("");
              searchInputRef.current?.focus();
            }}
          />
        </div>
      )}

      {/* ==================== الخطوة 2: التقاط صورة الكاميرا ==================== */}
      {step === "CAPTURE" && productData && (
        <div className="space-y-4" data-testid="workflow-step-capture">
          {/* شريط معلومات المنتج المختصر للرجوع */}
          <div className="flex items-center justify-between rounded-xl border border-border bg-card p-3 shadow-sm">
            <div className="text-right">
              <p className="text-xs text-muted-foreground">المنتج المحدد:</p>
              <h4 className="text-sm font-bold text-foreground truncate max-w-[240px] sm:max-w-md">
                {productData.name}
              </h4>
            </div>

            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setStep("SCAN")}
              data-testid="btn-back-to-scan"
              className="min-h-10 text-xs text-muted-foreground gap-1.5"
            >
              <span>تغيير المنتج</span>
              <ArrowRight aria-hidden className="size-3.5" />
            </Button>
          </div>

          {/* مكون التقاط الكاميرا المباشر وتصحيح EXIF والضغط المحلي */}
          <StudioCameraCapture
            onImageCaptured={handleImageCaptured}
            isProcessing={isSaving}
          />
        </div>
      )}

      {/* ==================== الخطوة 3: المعاينة والإرسال بنقرة واحدة ==================== */}
      {step === "PREVIEW" && productData && capturedImage && (
        <div className="space-y-4" data-testid="workflow-step-preview">
          {/* تفاصيل المنتج المحدد */}
          <div className="flex items-center justify-between rounded-xl border border-border bg-card p-3 shadow-sm">
            <div className="text-right">
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">معاينة لقطة:</span>
                <span className="text-sm font-bold text-foreground truncate max-w-[220px] sm:max-w-sm">
                  {productData.name}
                </span>
              </div>
              {selectedAction && (
                <Badge variant="outline" className="mt-1 text-[11px]">
                  {selectedAction === "ADD" ? "إضافة كصورة إضافية" : "استبدال الصورة الحالية"}
                </Badge>
              )}
            </div>

            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleRetake}
              data-testid="btn-back-to-capture"
              className="min-h-10 text-xs text-muted-foreground gap-1"
            >
              <RotateCcw aria-hidden className="size-3.5" />
              <span>إعادة اللقطة</span>
            </Button>
          </div>

          {/* شريط المعاينة والتبديل وزر الإرسال بنقرة واحدة */}
          <StudioPreviewSubmitBar
            previewUrl={
              previewMode === "AI"
                ? aiEnhancedDataUrl || capturedImage.processedDataUrl
                : capturedImage.processedDataUrl
            }
            sizeKB={
              previewMode === "AI"
                ? aiEnhancedSizeKB || capturedImage.sizeKB
                : capturedImage.sizeKB
            }
            originalUrl={capturedImage.originalDataUrl}
            originalSizeKB={capturedImage.sizeKB}
            isSaving={isSaving}
            isAiEnhancing={isAiEnhancing}
            fallbackApplied={fallbackApplied}
            previewMode={previewMode}
            onTogglePreviewMode={handleTogglePreviewMode}
            canAutoApprove={canAutoApprove}
            onRetake={handleRetake}
            onSubmit={handleSubmitImage}
            praiseMessage="عاشت إيدك!"
          />
        </div>
      )}
    </div>
  );
}
