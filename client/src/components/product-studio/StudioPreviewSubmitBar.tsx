import React, { useRef } from "react";
import {
  Check,
  Image as ImageIcon,
  Loader2,
  RotateCcw,
  Send,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

export interface StudioPreviewSubmitBarProps {
  previewUrl?: string | null;
  sizeKB?: number;
  originalUrl?: string | null;
  originalSizeKB?: number;
  isSaving?: boolean;
  isAiEnhancing?: boolean;
  fallbackApplied?: boolean;
  previewMode?: "AI" | "ORIGINAL";
  onTogglePreviewMode?: (mode: "AI" | "ORIGINAL") => void;
  canAutoApprove?: boolean;
  submitLabel?: string;
  onRetake: () => void;
  onSubmit: () => Promise<void> | void;
  className?: string;
  praiseMessage?: string;
}

export function StudioPreviewSubmitBar({
  previewUrl,
  sizeKB,
  originalUrl,
  originalSizeKB,
  isSaving = false,
  isAiEnhancing = false,
  fallbackApplied = false,
  previewMode = "AI",
  onTogglePreviewMode,
  canAutoApprove = false,
  submitLabel,
  onRetake,
  onSubmit,
  className = "",
  praiseMessage = "عاشت إيدك!",
}: StudioPreviewSubmitBarProps) {
  const savingRef = useRef(false);

  const defaultSubmitLabel = canAutoApprove
    ? "اعتماد ونشر الصورة فوراً"
    : "إرسال الصورة للاعتماد";

  const resolvedSubmitLabel = submitLabel || defaultSubmitLabel;

  const handleClickSubmit = async () => {
    // كبح النقر المتكرر (Client-Side Debouncing / Idempotency Guard)
    if (savingRef.current || isSaving || isAiEnhancing) return;
    savingRef.current = true;

    try {
      await onSubmit();
      // إظهار رسالة الفخر العراقية المعتمدة فور نجاح الرفع
      toast.success(praiseMessage, {
        description: canAutoApprove
          ? "تم اعتماد ونشر صورة المنتج بنجاح في الكتالوج ونقاط البيع."
          : "تم إرسال الصورة بنجاح إلى طابور الاعتماد الإداري.",
      });
    } catch {
      // الأخطاء يتم التقاطها وإدارتها في سياق المستدعي
    } finally {
      savingRef.current = false;
    }
  };

  const isAiActive = previewMode === "AI";

  return (
    <div
      dir="rtl"
      data-testid="studio-preview-submit-bar"
      className={`w-full max-w-xl mx-auto space-y-3 sm:space-y-4 ${className}`}
    >
      {/* 1. خيار النمط بضغطة واحدة: تحسين بالذكاء الاصطناعي vs بدون معالجة (الأصلية) */}
      <div
        data-testid="preview-mode-toggle-group"
        className="grid grid-cols-2 p-1 bg-muted/60 rounded-xl border border-border/70 text-xs sm:text-sm font-semibold gap-1 shadow-xs"
      >
        <button
          type="button"
          disabled={isSaving}
          onClick={() => onTogglePreviewMode?.("AI")}
          data-testid="toggle-preview-ai"
          className={`flex items-center justify-center gap-1.5 py-2.5 px-3 rounded-lg transition-all ${
            isAiActive
              ? "bg-background text-primary shadow-sm font-bold border border-border/50"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <Sparkles aria-hidden className="size-4 shrink-0 text-primary" />
          <span>تحسين بالذكاء الاصطناعي</span>
        </button>

        <button
          type="button"
          disabled={isSaving}
          onClick={() => onTogglePreviewMode?.("ORIGINAL")}
          data-testid="toggle-preview-original"
          className={`flex items-center justify-center gap-1.5 py-2.5 px-3 rounded-lg transition-all ${
            !isAiActive
              ? "bg-background text-foreground shadow-sm font-bold border border-border/50"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <ImageIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span>بدون معالجة (الأصلية)</span>
        </button>
      </div>

      {/* 2. عرض معاينة الصورة الملتقطة / المعالجة */}
      {previewUrl && (
        <div
          data-testid="preview-image-container"
          className="relative rounded-xl border border-border bg-card p-3 sm:p-4 text-center overflow-hidden shadow-sm"
        >
          <div className="flex items-center justify-between border-b border-border/70 pb-2 mb-3">
            <span className="text-xs sm:text-sm font-bold text-foreground flex items-center gap-1.5">
              {isAiActive ? (
                <>
                  <Sparkles aria-hidden className="size-4 text-primary" />
                  <span>معاينة استوديو الذكاء الاصطناعي</span>
                </>
              ) : (
                <>
                  <ImageIcon aria-hidden className="size-4 text-muted-foreground" />
                  <span>معاينة الصورة الأصلية</span>
                </>
              )}
            </span>
            <div className="flex items-center gap-1.5">
              {isAiActive && (
                <Badge variant="outline" className="text-[11px] text-primary border-primary/30">
                  استوديو ذكي
                </Badge>
              )}
              {sizeKB != null && sizeKB > 0 && (
                <Badge variant="secondary" className="text-xs font-mono">
                  {sizeKB} ك.ب
                </Badge>
              )}
            </div>
          </div>

          <div className="relative mx-auto flex min-h-[260px] max-h-[360px] sm:max-h-[420px] items-center justify-center rounded-lg bg-muted/40 p-2 overflow-hidden">
            <img
              src={previewUrl}
              alt={isAiActive ? "معاينة استوديو الذكاء الاصطناعي" : "معاينة الصورة الأصلية"}
              data-testid="preview-captured-image"
              className={`max-h-[340px] sm:max-h-[400px] w-auto max-w-full object-contain rounded-md shadow-sm transition-opacity duration-200 ${
                isAiEnhancing ? "opacity-30 blur-[1px]" : "opacity-100"
              }`}
            />

            {/* مؤشر المعالجة الذكية الأنيق (جاري المعالجة بذكاء الاستوديو...) */}
            {isAiEnhancing && (
              <div
                data-testid="ai-enhancing-loading-indicator"
                className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background/80 backdrop-blur-xs p-4 text-center animate-in fade-in"
              >
                <div className="relative flex items-center justify-center">
                  <div className="size-12 rounded-full border-2 border-primary/20 border-t-primary animate-spin" />
                  <Sparkles aria-hidden className="size-5 text-primary absolute animate-pulse" />
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-bold text-foreground">
                    جاري المعالجة بذكاء الاستوديو...
                  </p>
                  <p className="text-xs text-muted-foreground max-w-xs">
                    تنظيف الخلفية، موازنة الإضاءة والظلال، وحفظ نصوص الأغلفة والملامح تلقائياً
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* تنبيه البديل المحلي الآمن إن طُبق */}
          {fallbackApplied && isAiActive && !isAiEnhancing && (
            <div
              data-testid="ai-fallback-badge"
              className="mt-2 text-[11px] text-muted-foreground bg-muted/50 rounded-lg p-2 px-3 flex items-center justify-between"
            >
              <span>تم تفعيل المعالجة المحلية السريعة (حفظ الأصل بأمان ودون تعطيل)</span>
              <Badge variant="outline" className="text-[10px] font-normal">
                بديل محلي آمن
              </Badge>
            </div>
          )}

          <p className="mt-2 text-xs text-muted-foreground">
            {canAutoApprove
              ? "حسابك يملك صلاحية الاعتماد: سيتم نشر الصورة فوراً وتحديث الكاش في جدول المنتجات ونقاط البيع."
              : "سيتم إرسال الصورة للاعتماد الإداري، وستظهر فور موافقة المدير."}
          </p>
        </div>
      )}

      {/* 3. شريط الأزرار السفلي المريح للإبهام (Thumb-friendly Bottom Bar) */}
      <div
        data-testid="submit-action-bar-container"
        className="sticky bottom-0 left-0 right-0 z-20 rounded-t-xl sm:rounded-xl border border-border bg-background/95 backdrop-blur-md p-3 sm:p-4 shadow-lg sm:shadow-sm"
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 sm:gap-3">
          {/* زر إعادة التصوير البارز */}
          <Button
            type="button"
            variant="outline"
            size="lg"
            disabled={isSaving}
            onClick={onRetake}
            data-testid="btn-retake-photo"
            className="min-h-12 h-auto py-3 text-sm sm:text-base font-bold gap-2 text-muted-foreground hover:text-foreground justify-center"
          >
            <RotateCcw aria-hidden className="size-5 shrink-0" />
            <span>إعادة التصوير</span>
          </Button>

          {/* زر الإرسال / الاعتماد بنقرة واحدة مع منع التكرار ومؤشر التحميل */}
          <Button
            type="button"
            variant="default"
            size="lg"
            disabled={isSaving || isAiEnhancing || !previewUrl}
            onClick={handleClickSubmit}
            data-testid="btn-submit-photo-one-click"
            className="min-h-12 h-auto py-3 text-sm sm:text-base font-bold gap-2 justify-center shadow-md"
          >
            {isSaving ? (
              <>
                <Loader2 aria-hidden className="size-5 animate-spin shrink-0" />
                <span>جارٍ المعالجة والإرسال...</span>
              </>
            ) : isAiEnhancing ? (
              <>
                <Loader2 aria-hidden className="size-5 animate-spin shrink-0 text-primary" />
                <span>جاري المعالجة بذكاء الاستوديو...</span>
              </>
            ) : (
              <>
                {canAutoApprove ? (
                  <Check aria-hidden className="size-5 shrink-0" />
                ) : (
                  <Send aria-hidden className="size-5 shrink-0" />
                )}
                <span>{resolvedSubmitLabel}</span>
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
