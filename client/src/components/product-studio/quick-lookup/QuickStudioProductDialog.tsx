import {
  AlertCircle,
  Camera,
  CheckCircle2,
  Image as ImageIcon,
  Loader2,
  Package,
  ZoomIn,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ACTION_LABELS } from "@shared/actionLabels";
import { QuickStudioCaptureEditor } from "./QuickStudioCaptureEditor";
import type { QuickStudioController } from "./useQuickStudioController";

export function QuickStudioProductDialog({
  controller,
}: {
  controller: QuickStudioController;
}) {
  const {
    productModalOpen,
    closeModal,
    activeBarcodeBadge,
    lookupQuery,
    setCameraScannerOpen,
    product,
    existingImages,
    setPreviewZoomImage,
  } = controller;
  const hasImages = existingImages.length > 0;
  return (
    <Dialog
      open={productModalOpen}
      onOpenChange={(open) => {
        if (!open) {
          closeModal();
        }
      }}
    >
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2 text-base sm:text-lg">
            <Package aria-hidden className="size-5 text-primary" />
            <span>معاينة وتصوير المنتج السريع</span>
            {activeBarcodeBadge && (
              <Badge variant="outline" className="font-mono text-xs" dir="ltr">
                {activeBarcodeBadge}
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription className="text-xs">
            استعرض الصور الحالية للمنتج أو المتغير، أو التقط صورة جديدة بكاميرا
            هاتفك وعالجها بالذكاء فورا.
          </DialogDescription>
        </DialogHeader>

        {lookupQuery.isLoading ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Loader2 aria-hidden className="size-8 animate-spin text-primary" />
            <p className="mt-3 text-sm text-muted-foreground">
              {ACTION_LABELS.loading}
            </p>
          </div>
        ) : lookupQuery.isError ? (
          <div className="space-y-3 py-6 text-center">
            <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
              <AlertCircle aria-hidden className="size-6" />
            </div>
            <p className="text-sm font-medium text-foreground">
              {lookupQuery.error?.message ||
                "تعذر العثور على المنتج بالرمز الممسوح."}
            </p>
            <div className="flex justify-center gap-2 pt-2">
              <Button variant="outline" size="sm" onClick={closeModal}>
                إغلاق
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  closeModal();
                  setCameraScannerOpen(true);
                }}
              >
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
                  <h4 className="text-base font-bold text-foreground">
                    {product.name}
                  </h4>
                  {product.variantName && (
                    <p className="text-xs font-semibold text-primary">
                      المتغير / الصف: {product.variantName}
                    </p>
                  )}
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {product.categoryName && (
                      <span>التصنيف: {product.categoryName}</span>
                    )}
                    {product.brand && <span>الماركة: {product.brand}</span>}
                    {product.modelName && (
                      <span>الموديل: {product.modelName}</span>
                    )}
                    {product.unitName && (
                      <span>الوحدة: {product.unitName}</span>
                    )}
                  </div>
                </div>

                <div>
                  {hasImages ? (
                    <Badge variant="outline" className="badge-status-active">
                      <CheckCircle2 aria-hidden className="size-3 me-1" />
                      {existingImages.length} صور معتمدة
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="badge-stock-low">
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
                      onClick={() =>
                        setPreviewZoomImage(img.url || img.thumbDataUrl)
                      }
                      className="group relative size-20 shrink-0 overflow-hidden rounded-md border bg-white shadow-xs transition hover:border-primary hover:ring-2 hover:ring-primary/20"
                      title={`معاينة الصورة ${idx + 1}`}
                    >
                      <img
                        src={img.thumbDataUrl || img.url}
                        alt={`صورة ${idx + 1}`}
                        className="size-full object-contain p-1"
                        loading="lazy"
                      />
                      {img.variantId != null && (
                        <span className="absolute top-0 start-0 rounded-ee bg-sky-600/90 px-1 py-0.5 text-[8px] font-medium text-white leading-none">
                          خاص بالصف
                        </span>
                      )}
                      {img.isPrimary && (
                        <span className="absolute bottom-0 inset-x-0 bg-primary/90 text-[9px] font-medium text-primary-foreground text-center py-0.5 leading-tight">
                          رئيسية
                        </span>
                      )}
                      <span className="absolute top-1 end-1 rounded bg-black/60 p-0.5 opacity-0 transition group-hover:opacity-100 text-white">
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

            <QuickStudioCaptureEditor controller={controller} />
          </div>
        ) : null}

        <DialogFooter className="flex flex-row justify-between sm:justify-end gap-2 pt-2 border-t">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={closeModal}
          >
            إغلاق
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
