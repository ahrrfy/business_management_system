import { CheckCircle2, Layers, Loader2, Wand2 } from "lucide-react";
import { Label } from "@/components/ui/label";
import { ACTION_LABELS } from "@shared/actionLabels";
import type { QuickStudioController } from "./useQuickStudioController";

export function QuickStudioImageResult({
  controller,
}: {
  controller: QuickStudioController;
}) {
  const {
    rawImage,
    processedImage,
    activeMode,
    isProcessingAi,
    handleModeChange,
    aiAvailable,
    proAvailable,
    aiConfig,
    aiUnavailableMessage,
    proUnavailableMessage,
  } = controller;
  return (
    <>
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">
          وضع المعالجة في الاستوديو:
        </Label>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <button
            type="button"
            onClick={() => handleModeChange("AI")}
            disabled={isProcessingAi || !aiAvailable}
            title={!aiAvailable ? aiUnavailableMessage : undefined}
            className={`flex flex-col items-center justify-center rounded-lg border p-2 text-center transition ${
              !aiAvailable
                ? "border-dashed border-border/60 bg-muted/20 text-muted-foreground/60 cursor-not-allowed opacity-60"
                : activeMode === "AI"
                  ? "border-primary bg-primary/10 text-primary font-bold shadow-xs"
                  : "border-border bg-background text-muted-foreground hover:bg-accent/40"
            }`}
          >
            <span className="text-xs flex items-center gap-1">
              <Wand2 aria-hidden className="size-3 text-primary" />
              استوديو الذكاء (API)
            </span>
            <span className="text-[10px] opacity-75">
              {aiAvailable
                ? "تحسين توليدي وخلفية استوديو"
                : !aiConfig.data?.hasAiKey
                  ? "المفتاح غير مدخل"
                  : !aiConfig.data?.aiEnabled
                    ? "معطل بالإعدادات"
                    : "غير متاح"}
            </span>
          </button>

          <button
            type="button"
            onClick={() => handleModeChange("REMOVEBG")}
            disabled={isProcessingAi || !proAvailable}
            title={!proAvailable ? proUnavailableMessage : undefined}
            className={`flex flex-col items-center justify-center rounded-lg border p-2 text-center transition ${
              !proAvailable
                ? "border-dashed border-border/60 bg-muted/20 text-muted-foreground/60 cursor-not-allowed opacity-60"
                : activeMode === "REMOVEBG"
                  ? "border-primary bg-primary/10 text-primary font-bold shadow-xs"
                  : "border-border bg-background text-muted-foreground hover:bg-accent/40"
            }`}
          >
            <span className="text-xs flex items-center gap-1">
              <Layers aria-hidden className="size-3 text-primary" />
              عزل بالذكاء (remove.bg)
            </span>
            <span className="text-[10px] opacity-75">
              {proAvailable
                ? "عزل دقيق واحترافي"
                : !aiConfig.data?.hasProKey
                  ? "المفتاح غير مدخل"
                  : !aiConfig.data?.proEnabled
                    ? "معطل بالإعدادات"
                    : "غير متاح"}
            </span>
          </button>

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
            <span className="text-xs">خلفية بيضاء سريعة</span>
            <span className="text-[10px] opacity-75">
              سريع 100% ومناسب للهواتف
            </span>
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
            <p className="text-xs text-muted-foreground">
              {ACTION_LABELS.processing}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {activeMode === "AI"
                ? "جاري معالجة الصورة وتحسينها عبر مزود الذكاء الاصطناعي..."
                : activeMode === "REMOVEBG"
                  ? "جاري عزل خلفية الصورة عبر remove.bg..."
                  : "جاري معالجة الصورة..."}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="space-y-1 text-center">
              <span className="text-[11px] font-medium text-muted-foreground">
                الصورة الأصلية
              </span>
              <div className="flex h-48 items-center justify-center rounded-lg border bg-white p-1">
                <img
                  src={rawImage || undefined}
                  alt="الأصل"
                  className="max-h-full max-w-full object-contain"
                />
              </div>
            </div>

            <div className="space-y-1 text-center">
              <span className="text-[11px] font-bold text-primary flex items-center justify-center gap-1">
                <CheckCircle2 aria-hidden className="size-3" />
                الناتج النهائي للاستوديو (
                {activeMode === "AI"
                  ? "استوديو الذكاء"
                  : activeMode === "REMOVEBG"
                    ? "عزل remove.bg"
                    : activeMode === "FLATTEN"
                      ? "خلفية بيضاء سريعة"
                      : "اللقطة الأصلية"}
                )
              </span>
              <div className="flex h-48 items-center justify-center rounded-lg border border-primary/30 bg-white p-1 shadow-xs">
                <img
                  src={processedImage || rawImage || undefined}
                  alt="الناتج"
                  className="max-h-full max-w-full object-contain"
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
