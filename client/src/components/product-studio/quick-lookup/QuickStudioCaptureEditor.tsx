import {
  Camera,
  CheckCircle2,
  Loader2,
  Send,
  Sparkles,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { QuickStudioProviderStatus } from "./QuickStudioProviderStatus";
import { QuickStudioImageResult } from "./QuickStudioImageResult";
import type { QuickStudioController } from "./useQuickStudioController";

export function QuickStudioCaptureEditor({
  controller,
}: {
  controller: QuickStudioController;
}) {
  const {
    canQuickSave,
    rawImage,
    resetImageState,
    cameraInputRef,
    fileInputRef,
    handleFileChange,
    isProcessingAi,
    product,
    canAutoApprove,
    setAsPrimary,
    setSetAsPrimary,
    saveForVariantOnly,
    setSaveForVariantOnly,
    processedImage,
    isSaving,
    handleSubmitImage,
  } = controller;
  if (!product) return null;
  return (
    <>
      {canQuickSave ? (
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
                onClick={resetImageState}
                className="h-8 text-xs text-muted-foreground"
              >
                إلغاء اللقطة
              </Button>
            )}
          </div>

          <QuickStudioProviderStatus controller={controller} />

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
                disabled={isProcessingAi}
                onClick={() => cameraInputRef.current?.click()}
                className="h-auto whitespace-normal py-2 min-h-12 gap-2 text-sm font-bold shadow-sm"
              >
                <Camera aria-hidden className="size-5" />
                التقاط بكاميرا الهاتف الآن
              </Button>

              <Button
                type="button"
                variant="outline"
                size="lg"
                disabled={isProcessingAi}
                onClick={() => fileInputRef.current?.click()}
                className="h-auto whitespace-normal py-2 min-h-12 gap-2 text-sm font-semibold"
              >
                <Upload aria-hidden className="size-5" />
                اختيار من صور الجهاز أو المعرض
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              {/* شريط اختيار وضع معالجة الاستوديو */}
              <QuickStudioImageResult controller={controller} />

              {/* خيارات ربط الصورة وتعيينها كرئيسية */}
              <div className="space-y-2 pt-1">
                {canAutoApprove && (
                  <div className="flex items-center gap-2">
                    <input
                      id="quick-studio-primary-check"
                      type="checkbox"
                      checked={setAsPrimary}
                      onChange={(e) => setSetAsPrimary(e.target.checked)}
                      className="size-4 rounded border-border text-primary focus:ring-primary"
                    />
                    <Label
                      htmlFor="quick-studio-primary-check"
                      className="cursor-pointer text-xs font-medium"
                    >
                      تعيين هذه اللقطة كصورة رئيسية للمنتج في الكتالوج والمتجر
                    </Label>
                  </div>
                )}
                {product.variantId != null && (
                  <div className="flex items-center gap-2">
                    <input
                      id="quick-studio-variant-scope-check"
                      type="checkbox"
                      checked={saveForVariantOnly}
                      onChange={(e) => setSaveForVariantOnly(e.target.checked)}
                      className="size-4 rounded border-border text-primary focus:ring-primary"
                    />
                    <Label
                      htmlFor="quick-studio-variant-scope-check"
                      className="cursor-pointer text-xs font-medium text-muted-foreground"
                    >
                      تخصيص الصورة لهذا الصف/المتغير تحديدا (
                      {product.variantName || `#${product.variantId}`}) — ألغ
                      التحديد لجعلها صورة عامة للمنتج الأب
                    </Label>
                  </div>
                )}
              </div>

              {/* أزرار الإجراء الذكي المبني على الصلاحية والرتبة */}
              <div className="pt-2">
                {canAutoApprove ? (
                  <div className="space-y-1.5">
                    <Button
                      type="button"
                      size="lg"
                      disabled={isSaving || isProcessingAi || !processedImage}
                      onClick={handleSubmitImage}
                      className="h-auto whitespace-normal py-2 min-h-12 w-full gap-2 font-bold bg-emerald-700 hover:bg-emerald-800 text-white shadow-md active:bg-emerald-900"
                    >
                      {isSaving ? (
                        <Loader2 aria-hidden className="size-5 animate-spin" />
                      ) : (
                        <CheckCircle2 aria-hidden className="size-5" />
                      )}
                      اعتماد ونشر الصورة فورا في الكتالوج
                    </Button>
                    <p className="text-[11px] text-center text-muted-foreground">
                      بصفتك مديرا، يتم اعتماد الصورة ونشرها في الكتالوج فورا دون
                      الحاجة لموافقة أو روتين لاحق.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <Button
                      type="button"
                      size="lg"
                      disabled={isSaving || isProcessingAi || !processedImage}
                      onClick={handleSubmitImage}
                      className="h-auto whitespace-normal py-2 min-h-12 w-full gap-2 font-bold shadow-md"
                    >
                      {isSaving ? (
                        <Loader2 aria-hidden className="size-5 animate-spin" />
                      ) : (
                        <Send aria-hidden className="size-5" />
                      )}
                      إرسال الصورة للاعتماد والمراجعة الإدارية
                    </Button>
                    <p className="text-[11px] text-center text-muted-foreground">
                      سيتم رفع الصورة وإرسالها لمدير الاستوديو لاعتمادها ونشرها
                      في الكتالوج.
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed bg-muted/20 p-3 text-center">
          <p className="text-xs text-muted-foreground">
            لديك صلاحية معاينة صور المنتج فقط. لإضافة أو تعديل الصور يرجى
            التواصل مع مسؤول الاستوديو.
          </p>
        </div>
      )}
    </>
  );
}
