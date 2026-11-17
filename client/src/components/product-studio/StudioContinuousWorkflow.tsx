import React, { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  Camera,
  Check,
  CheckCircle2,
  Loader2,
  Plus,
  RotateCcw,
  ScanLine,
  Search,
  Sparkles,
  X,
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
  type StudioLookupError,
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
    lookupError?: StudioLookupError | null;
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
  type QueuedCaptureItem = {
    id: string;
    captured: CapturedImageData;
    aiEnhancedDataUrl: string | null;
    aiEnhancedSizeKB: number | null;
    isAiEnhancing: boolean;
    fallbackApplied: boolean;
    previewMode: "AI" | "ORIGINAL";
  };

  const [capturedQueue, setCapturedQueue] = useState<QueuedCaptureItem[]>([]);
  const [activeQueueIndex, setActiveQueueIndex] = useState<number>(0);
  const [isSaving, setIsSaving] = useState(false);
  const [successBanner, setSuccessBanner] = useState<string | null>(null);

  const activeItem = capturedQueue[activeQueueIndex] ?? null;
  const capturedImage = activeItem?.captured ?? null;
  const aiEnhancedDataUrl = activeItem?.aiEnhancedDataUrl ?? null;
  const aiEnhancedSizeKB = activeItem?.aiEnhancedSizeKB ?? null;
  const previewMode = activeItem?.previewMode ?? "AI";
  const isAiEnhancing = capturedQueue.some((it) => it.isAiEnhancing);
  const fallbackApplied = activeItem?.fallbackApplied ?? false;

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

  // فصل خطأ الباركود غير المسجل فعلاً عن أخطاء الصلاحية/التعطيل/التضارب/الشبكة
  const rawLookupError = !mockLookupData && realLookupQuery.isError ? realLookupQuery.error : null;
  const rawLookupErrorCode = (rawLookupError as { data?: { code?: string } } | null)?.data?.code;
  const rawLookupErrorMessage = rawLookupError?.message?.trim() || "";
  const isTrulyUnregisteredError =
    rawLookupErrorCode === "NOT_FOUND" &&
    (!rawLookupErrorMessage || rawLookupErrorMessage.includes("لا يطابق باركود"));

  const lookupError: StudioLookupError | null = mockLookupData
    ? (mockLookupData.lookupError ?? null)
    : rawLookupError && !isTrulyUnregisteredError
      ? {
          code: rawLookupErrorCode,
          message:
            rawLookupErrorMessage ||
            "تعذّر الاستعلام عن الباركود حالياً، يرجى المحاولة مرة أخرى.",
        }
      : null;

  // فحص الباركود غير المسجل
  const isUnregistered = mockLookupData
    ? Boolean(mockLookupData.isUnregistered)
    : Boolean(
        submittedBarcode &&
          !isQueryLoading &&
          !lookupError &&
          (isTrulyUnregisteredError || !realLookupQuery.data?.product),
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
    itemId: string,
    sourceDataUrl: string,
    productId?: number,
    barcode?: string | null,
  ) => {
    const gen = captureGenRef.current;
    const patchItem = (patch: Partial<QueuedCaptureItem>) => {
      setCapturedQueue((prev) =>
        prev.map((it) => (it.id === itemId ? { ...it, ...patch } : it)),
      );
    };

    patchItem({ isAiEnhancing: true, fallbackApplied: false });

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
        patchItem({
          aiEnhancedDataUrl: enhancedUrl,
          aiEnhancedSizeKB: res?.sizeKB || dataUrlSizeKB(enhancedUrl),
          fallbackApplied: Boolean(res?.fallbackApplied),
        });
      } else if (aiTransformMutation) {
        const res = await aiTransformMutation.mutateAsync({
          imageDataUrl: sourceDataUrl,
          mode: "AI",
          productId,
          barcode: barcode || undefined,
        });
        if (captureGenRef.current !== gen) return;
        const enhancedUrl = res?.imageDataUrl || sourceDataUrl;
        patchItem({
          aiEnhancedDataUrl: enhancedUrl,
          aiEnhancedSizeKB: dataUrlSizeKB(enhancedUrl),
          fallbackApplied: Boolean(res?.fallbackApplied),
        });
      } else {
        if (captureGenRef.current !== gen) return;
        // بديل محلي سريع في غياب الطفرة
        patchItem({
          aiEnhancedDataUrl: sourceDataUrl,
          aiEnhancedSizeKB: dataUrlSizeKB(sourceDataUrl),
          fallbackApplied: true,
        });
      }
    } catch (err: unknown) {
      if (captureGenRef.current !== gen) return;
      // الاستمرارية عند تعطل الذكاء الاصطناعي (Graceful Fallback):
      // لا يتوقف العمل ولا تضيع الصورة عند تعطل المزود
      console.warn("AI studio enhancement fallback applied:", err);
      patchItem({
        aiEnhancedDataUrl: sourceDataUrl,
        aiEnhancedSizeKB: dataUrlSizeKB(sourceDataUrl),
        fallbackApplied: true,
      });
    } finally {
      if (captureGenRef.current === gen) {
        patchItem({ isAiEnhancing: false });
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
    setCapturedQueue([]);
    setActiveQueueIndex(0);
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
    setCapturedQueue([]);
    setActiveQueueIndex(0);
    setStep("CAPTURE");
  };

  const enqueueCapturedImages = (items: CapturedImageData[]) => {
    if (items.length === 0) return;
    const created: QueuedCaptureItem[] = items.map((data, idx) => ({
      id: `cap-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 7)}`,
      captured: data,
      aiEnhancedDataUrl: null,
      aiEnhancedSizeKB: null,
      isAiEnhancing: true,
      fallbackApplied: false,
      previewMode: "AI",
    }));

    setCapturedQueue((prev) => {
      const next = [...prev, ...created];
      setActiveQueueIndex(prev.length);
      return next;
    });
    setStep("PREVIEW");

    const barcode = submittedBarcode || productData?.barcode;
    void (async () => {
      for (const item of created) {
        await triggerAiEnhancement(
          item.id,
          item.captured.processedDataUrl,
          productData?.id,
          barcode,
        );
      }
    })();
  };

  // اكتمال تجهيز الصورة من الكاميرا
  const handleImageCaptured = (data: CapturedImageData) => {
    enqueueCapturedImages([data]);
  };

  // اكتمال تجهيز عدة صور من المعرض دفعة واحدة
  const handleImagesCaptured = (items: CapturedImageData[]) => {
    enqueueCapturedImages(items);
  };

  // التبديل بين وضع الذكاء الاصطناعي والصورة الأصلية للصورة النشطة
  const handleTogglePreviewMode = (mode: "AI" | "ORIGINAL") => {
    if (!activeItem) return;
    setCapturedQueue((prev) =>
      prev.map((it) =>
        it.id === activeItem.id ? { ...it, previewMode: mode } : it,
      ),
    );
    if (mode === "AI" && !activeItem.aiEnhancedDataUrl && !activeItem.isAiEnhancing) {
      void triggerAiEnhancement(
        activeItem.id,
        activeItem.captured.processedDataUrl,
        productData?.id,
        submittedBarcode || productData?.barcode,
      );
    }
  };

  // حذف صورة من الدفعة قبل الإرسال
  const handleRemoveQueuedItem = (indexToRemove: number) => {
    setCapturedQueue((prev) => {
      const next = prev.filter((_, idx) => idx !== indexToRemove);
      if (next.length === 0) {
        setActiveQueueIndex(0);
        setStep("CAPTURE");
      } else if (activeQueueIndex >= next.length) {
        setActiveQueueIndex(next.length - 1);
      } else if (indexToRemove < activeQueueIndex) {
        setActiveQueueIndex((idx) => Math.max(0, idx - 1));
      }
      return next;
    });
  };

  // إعادة التصوير
  const handleRetake = () => {
    captureGenRef.current += 1;
    setCapturedQueue((prev) => {
      const next = prev.filter((_, idx) => idx !== activeQueueIndex);
      setActiveQueueIndex(Math.max(0, next.length - 1));
      return next;
    });
    setStep("CAPTURE");
  };

  // الإرسال والاعتماد بنقرة واحدة (يدعم صورة واحدة أو عدة صور متتالية لنفس المنتج)
  const handleSubmitImage = async () => {
    if (savingRef.current || isSaving || capturedQueue.length === 0 || !productData?.id) {
      return;
    }
    savingRef.current = true;
    setIsSaving(true);
    let savedCount = 0;

    try {
      for (let i = 0; i < capturedQueue.length; i++) {
        const item = capturedQueue[i];
        const isAi = item.previewMode === "AI";
        const finalProcessedUrl = isAi
          ? item.aiEnhancedDataUrl || item.captured.processedDataUrl
          : item.captured.processedDataUrl;

        // توليد مصغرة خفيفة
        let thumbnailDataUrl: string;
        try {
          thumbnailDataUrl = await createProductDisplayThumbnail(finalProcessedUrl);
        } catch {
          thumbnailDataUrl = finalProcessedUrl;
        }

        const clientRequestId = `studio-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 9)}`;

        const safeOriginalDataUrl =
          item.captured.originalDataUrl && item.captured.originalDataUrl.length <= 1_250_000
            ? item.captured.originalDataUrl
            : item.captured.processedDataUrl;

        const payload = {
          productId: productData.id,
          variantId: productData.variantId ?? undefined,
          barcode: submittedBarcode || productData.barcode || undefined,
          originalDataUrl: safeOriginalDataUrl,
          processedDataUrl: finalProcessedUrl,
          thumbnailDataUrl,
          mode: (isAi ? "AI" : "FLATTEN") as "AI" | "FLATTEN",
          setAsPrimary:
            i === 0 && (selectedAction === "REPLACE" || imagesData.length === 0),
          clientRequestId,
        };

        if (mockOnSave) {
          await mockOnSave(payload);
        } else if (saveMutation) {
          await saveMutation.mutateAsync(payload);
        }
        savedCount += 1;
      }

      // إبطال كاش المنتجات والاستوديو لتنعكس الصور فورياً
      if (utils) {
        void utils.productStudio.invalidate();
        void utils.catalog.adminList.invalidate();
        void utils.catalog.posList.invalidate();
      }

      onProductHandled?.(productData.id);

      const totalCount = capturedQueue.length;
      setSuccessBanner(
        canAutoApprove
          ? totalCount > 1
            ? `تم اعتماد ونشر ${totalCount} صور لـ «${productData.name}» بنجاح في الكتالوج ونقاط البيع.`
            : `تم اعتماد ونشر صورة «${productData.name}» بنجاح في الكتالوج ونقاط البيع.`
          : totalCount > 1
            ? `تم إرسال ${totalCount} صور لـ «${productData.name}» بنجاح إلى طابور الاعتماد الإداري.`
            : `تم إرسال صورة «${productData.name}» بنجاح إلى طابور الاعتماد الإداري.`,
      );
      lockedProductIdRef.current = null;
      setCapturedQueue([]);
      setActiveQueueIndex(0);
      setSelectedAction(null);
      setStep("SCAN");

      // إعادة الاستعلام لتحديث معرض الصور المعتمدة
      if (!mockLookupData && realLookupQuery.refetch) {
        void realLookupQuery.refetch();
      }
    } catch (err: unknown) {
      if (savedCount > 0) {
        setCapturedQueue((prev) => prev.slice(savedCount));
        setActiveQueueIndex(0);
      }
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
            lookupError={lookupError}
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
            onImagesCaptured={handleImagesCaptured}
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
                {capturedQueue.length > 1 && (
                  <Badge variant="secondary" className="text-[11px] font-bold">
                    {capturedQueue.length} صور
                  </Badge>
                )}
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

          {/* شريط الصور الملتقطة + زر إضافة صورة أخرى لنفس المنتج */}
          <div
            data-testid="captured-queue-strip"
            className="flex items-center gap-2 overflow-x-auto rounded-xl border border-border bg-card/70 p-2.5 shadow-xs"
          >
            {capturedQueue.map((item, idx) => {
              const thumbSrc =
                item.previewMode === "AI"
                  ? item.aiEnhancedDataUrl || item.captured.processedDataUrl
                  : item.captured.processedDataUrl;
              const isSelected = idx === activeQueueIndex;
              return (
                <div
                  key={item.id}
                  className={`relative shrink-0 rounded-lg border-2 transition-all ${
                    isSelected
                      ? "border-primary ring-2 ring-primary/25"
                      : "border-border opacity-80 hover:opacity-100"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setActiveQueueIndex(idx)}
                    data-testid={`queue-thumb-${idx}`}
                    className="block w-14 h-14 overflow-hidden rounded-md bg-muted"
                    title={`معاينة الصورة ${idx + 1}`}
                  >
                    <img
                      src={thumbSrc}
                      alt={`${productData.name} - ${idx + 1}`}
                      className="w-full h-full object-cover"
                    />
                  </button>
                  <span className="absolute bottom-0.5 right-0.5 rounded bg-background/85 px-1 text-[10px] font-bold text-foreground">
                    {idx + 1}
                  </span>
                  {capturedQueue.length > 1 && !isSaving && (
                    <button
                      type="button"
                      onClick={() => handleRemoveQueuedItem(idx)}
                      data-testid={`queue-remove-${idx}`}
                      className="absolute -top-1.5 -left-1.5 rounded-full bg-destructive text-destructive-foreground p-0.5 shadow"
                      title="إزالة هذه الصورة"
                    >
                      <X aria-hidden className="size-3" />
                    </button>
                  )}
                </div>
              );
            })}

            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isSaving}
              onClick={() => setStep("CAPTURE")}
              data-testid="btn-add-another-capture"
              className="h-14 shrink-0 px-3 text-xs font-bold gap-1.5 border-dashed"
            >
              <Plus aria-hidden className="size-4 text-primary" />
              <span>إضافة صورة أخرى</span>
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
            submitLabel={
              capturedQueue.length > 1
                ? canAutoApprove
                  ? `اعتماد ونشر ${capturedQueue.length} صور فوراً`
                  : `إرسال ${capturedQueue.length} صور للاعتماد`
                : undefined
            }
            onRetake={handleRetake}
            onSubmit={handleSubmitImage}
            praiseMessage="عاشت إيدك!"
          />
        </div>
      )}
    </div>
  );
}
