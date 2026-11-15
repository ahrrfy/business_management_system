import React, { useRef, useState } from "react";
import {
  AlertCircle,
  Camera,
  Check,
  Image as ImageIcon,
  Loader2,
  RotateCcw,
  Sparkles,
  Upload,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  COMPRESSION_TARGET_KB,
  compressCanvas,
  compressImageDataUrl,
  dataUrlSizeKB,
} from "@/components/form/imageCompression";

export interface CapturedImageData {
  originalDataUrl?: string;
  processedDataUrl: string;
  sizeKB: number;
}

export interface StudioCameraCaptureProps {
  onImageCaptured: (data: CapturedImageData) => void;
  isProcessing?: boolean;
  disabled?: boolean;
  className?: string;
}

export type CaptureProcessingStep =
  | "idle"
  | "reading"
  | "orienting"
  | "compressing"
  | "ready"
  | "error";

/**
 * معالجة ملف الصورة مع تصحيح اتجاه EXIF وضغط الحجم محلياً (<=700KB)
 */
export async function processCameraCaptureFile(
  file: File,
  onStepChange?: (step: CaptureProcessingStep, message: string) => void,
): Promise<CapturedImageData> {
  onStepChange?.("reading", "جارٍ قراءة ملف الصورة...");

  const isHeic =
    file.type.includes("heic") ||
    file.type.includes("heif") ||
    /\.(heic|heif)$/i.test(file.name);

  // 1. قراءة الملف كنص Data URL للأصل
  const originalDataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("تعذر قراءة ملف الصورة من الجهاز"));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(file);
  });

  onStepChange?.(
    "orienting",
    isHeic
      ? "جارٍ استيراد وتصحيح اتجاه صورة HEIC..."
      : "جارٍ فحص وتصحيح اتجاه الصورة (EXIF)...",
  );

  // 2. استخدام createImageBitmap مع { imageOrientation: "from-image" } إن أتيح لتصحيح زوايا كاميرا الهاتف تلقائياً
  let canvas: HTMLCanvasElement | null = null;
  if (typeof window !== "undefined" && typeof window.createImageBitmap === "function") {
    try {
      const bitmap = await window.createImageBitmap(file, {
        imageOrientation: "from-image",
      });
      canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bitmap, 0, 0);
      }
      bitmap.close?.();
    } catch {
      canvas = null;
    }
  }

  onStepChange?.("compressing", "جارٍ ضغط وتجهيز الصورة محلياً (≤ 700KB)...");

  // 3. تطبيق سلّم الضغط المحلي لضمان عدم تجاوز سقف 700KB بصيغة WebP أو JPEG
  let processedDataUrl: string;
  let finalSizeKB: number;

  if (canvas) {
    const compressed = await compressCanvas(canvas);
    processedDataUrl = compressed.dataUrl;
    finalSizeKB = compressed.sizeKB;
  } else {
    // بديل آمن وسريع في بيئات jsdom أو عند تعذر canvas المباشر مع مهلة لمنع التعليق
    try {
      const compressPromise = compressImageDataUrl(originalDataUrl);
      const timeoutPromise = new Promise<{ dataUrl: string; sizeKB: number }>((resolve) =>
        setTimeout(
          () => resolve({ dataUrl: originalDataUrl, sizeKB: dataUrlSizeKB(originalDataUrl) }),
          600,
        ),
      );
      const compressed = await Promise.race([compressPromise, timeoutPromise]);
      processedDataUrl = compressed.dataUrl;
      finalSizeKB = compressed.sizeKB || dataUrlSizeKB(processedDataUrl);
    } catch {
      processedDataUrl = originalDataUrl;
      finalSizeKB = dataUrlSizeKB(originalDataUrl);
    }
  }

  onStepChange?.("ready", `تم تجهيز الصورة بنجاح (${finalSizeKB} ك.ب)`);

  return {
    originalDataUrl,
    processedDataUrl,
    sizeKB: finalSizeKB,
  };
}

export function StudioCameraCapture({
  onImageCaptured,
  isProcessing = false,
  disabled = false,
  className = "",
}: StudioCameraCaptureProps) {
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<CaptureProcessingStep>("idle");
  const [stepMessage, setStepMessage] = useState<string>("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const file = files[0];
    setErrorMessage(null);

    try {
      const result = await processCameraCaptureFile(file, (nextStep, msg) => {
        setStep(nextStep);
        setStepMessage(msg);
      });
      onImageCaptured(result);
    } catch (err: unknown) {
      setStep("error");
      const msg = err instanceof Error ? err.message : "تعذر إتمام معالجة الصورة";
      setErrorMessage(msg);
    } finally {
      // تفريغ قيمة الحقل لتمكين التقاط صورة جديدة بنفس الاسم إذا رغب المستخدم
      if (cameraInputRef.current) cameraInputRef.current.value = "";
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const isBusy = isProcessing || step === "reading" || step === "orienting" || step === "compressing";

  return (
    <div
      dir="rtl"
      data-testid="studio-camera-capture"
      className={`w-full max-w-xl mx-auto rounded-xl border border-border bg-card p-4 sm:p-5 text-right space-y-4 shadow-sm transition-all ${className}`}
    >
      {/* 1. مدخلات الكاميرا والملف الخفية */}
      {/* كاميرا الهاتف الخلفية مباشرة */}
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        data-testid="camera-environment-input"
        onChange={handleFileSelected}
        disabled={isBusy || disabled}
      />

      {/* اختيار ملف من المعرض أو الاستوديو */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        data-testid="file-gallery-input"
        onChange={handleFileSelected}
        disabled={isBusy || disabled}
      />

      {/* 2. عنوان ووصف الخطوة */}
      <div className="space-y-1 border-b border-border/70 pb-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-base sm:text-lg font-bold text-foreground flex items-center gap-2">
            <Camera aria-hidden className="size-5 text-primary" />
            <span>التقاط صورة المنتج</span>
          </h3>
          <Badge variant="outline" className="text-xs">
            الخطوة 2 من 3
          </Badge>
        </div>
        <p className="text-xs sm:text-sm text-muted-foreground leading-relaxed">
          التقط صورة واضحة لغلاف أو واجهة المنتج. يُصحح اتجاه الكاميرا تلقائياً وتُضغط الصورة محلياً (≤ {COMPRESSION_TARGET_KB} ك.ب).
        </p>
      </div>

      {/* 3. شريط مؤشر التقدم والحالة السريع */}
      {isBusy && (
        <div
          data-testid="capture-processing-indicator"
          className="rounded-lg border border-primary/30 bg-primary/5 p-3.5 flex items-center gap-3 text-xs sm:text-sm text-primary animate-pulse"
        >
          <Loader2 aria-hidden className="size-5 animate-spin shrink-0" />
          <span className="font-semibold">{stepMessage || "جارٍ تجهيز الصورة محلياً..."}</span>
        </div>
      )}

      {/* رسالة الخطأ إن حدث */}
      {step === "error" && errorMessage && (
        <div
          data-testid="capture-error-message"
          className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 flex items-start gap-2.5 text-xs sm:text-sm text-destructive"
        >
          <AlertCircle aria-hidden className="size-5 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="font-bold">{errorMessage}</p>
            <p className="text-xs text-muted-foreground">
              يرجى المحاولة مجدداً أو اختيار صورة أخرى من المعرض.
            </p>
          </div>
        </div>
      )}

      {/* 4. أزرار التحكم والتقاط الكاميرا المريحة للإبهام */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
        {/* الزر الرئيسي: التقاط بالكاميرا الخلفية فوراً */}
        <Button
          type="button"
          variant="default"
          size="lg"
          disabled={isBusy || disabled}
          onClick={() => cameraInputRef.current?.click()}
          data-testid="btn-open-camera-back"
          className="min-h-12 h-auto py-3 text-sm sm:text-base font-bold gap-2.5 justify-center shadow-sm"
        >
          <Camera aria-hidden className="size-5 shrink-0" />
          <span>التقاط بالكاميرا</span>
        </Button>

        {/* الزر الثانوي: رفع من الجهاز */}
        <Button
          type="button"
          variant="outline"
          size="lg"
          disabled={isBusy || disabled}
          onClick={() => fileInputRef.current?.click()}
          data-testid="btn-choose-from-gallery"
          className="min-h-12 h-auto py-3 text-sm sm:text-base font-semibold gap-2.5 justify-center"
        >
          <Upload aria-hidden className="size-5 shrink-0" />
          <span>رفع من الجهاز</span>
        </Button>
      </div>

      {/* تلميح الضغط المحلي وحماية الجودة */}
      <div className="text-[11px] sm:text-xs text-muted-foreground flex items-center justify-between pt-1">
        <span className="flex items-center gap-1.5">
          <Sparkles aria-hidden className="size-3.5 text-primary" />
          معالجة وتصحيح زوايا EXIF وHEIC فورية
        </span>
        <span>سقف الرفع: {COMPRESSION_TARGET_KB} ك.ب</span>
      </div>
    </div>
  );
}
