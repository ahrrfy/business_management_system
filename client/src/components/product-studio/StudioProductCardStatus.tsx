import React from "react";
import {
  AlertCircle,
  Camera,
  Check,
  Clock,
  Image as ImageIcon,
  Lock,
  Plus,
  RefreshCw,
  Search,
  Star,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { resolveStudioImageSrc } from "@/lib/productImages";

export interface StudioProductImage {
  id: number;
  url: string;
  displayUrl?: string | null;
  contentHash?: string | null;
  thumbDataUrl?: string | null;
  isPrimary?: boolean;
  sortOrder?: number;
  reviewStatus?: string;
}

export interface StudioProductDetails {
  id: number;
  name: string;
  description?: string | null;
  brand?: string | null;
  modelName?: string | null;
  categoryName?: string | null;
  variantId?: number | null;
  variantName?: string | null;
  unitId?: number | null;
  unitName?: string | null;
  barcode?: string | null;
  isActive?: boolean;
}

export interface StudioProductLock {
  isLocked: boolean;
  activePhotographerName?: string;
  remainingSeconds?: number;
}

export interface StudioActiveJob {
  id: number;
  status: string;
  candidateThumb?: string | null;
  rejectionReason?: string;
}

export type StudioBadgeStatus = "PREVIOUSLY_PHOTOGRAPHED" | "PENDING_REVIEW" | "NO_IMAGE";

export interface StudioLookupError {
  code?: string;
  message: string;
}

export interface StudioProductCardStatusProps {
  product?: StudioProductDetails | null;
  barcode?: string | null;
  isUnregistered?: boolean;
  lookupError?: StudioLookupError | null;
  images?: StudioProductImage[];
  activeJob?: StudioActiveJob | null;
  lock?: StudioProductLock | null;
  selectedAction?: "ADD" | "REPLACE" | null;
  onSelectAction?: (action: "ADD" | "REPLACE") => void;
  onStartCapture?: () => void;
  onManualSearch?: () => void;
  className?: string;
}

/**
 * تحديد شارة الحالة للمنتج:
 * 1. «بانتظار الاعتماد»: إن كانت هناك مهمة أو صورة قيد المراجعة الإدارية
 * 2. «مصور مسبقاً»: إن كانت هناك صور معتمدة سابقة
 * 3. «بلا صورة»: إن لم تكن هناك صور ولا مراجعة معلقة
 */
export function deriveProductStudioStatus(
  images: StudioProductImage[] = [],
  activeJob?: StudioActiveJob | null,
): StudioBadgeStatus {
  if (activeJob && (activeJob.status === "PENDING_REVIEW" || activeJob.candidateThumb)) {
    return "PENDING_REVIEW";
  }
  if (images.length > 0) {
    return "PREVIOUSLY_PHOTOGRAPHED";
  }
  return "NO_IMAGE";
}

export function StudioProductCardStatus({
  product,
  barcode,
  isUnregistered = false,
  lookupError = null,
  images = [],
  activeJob = null,
  lock = null,
  selectedAction = null,
  onSelectAction,
  onStartCapture,
  onManualSearch,
  className = "",
}: StudioProductCardStatusProps) {
  // حالة خطأ محدد من الخادم (صلاحية، منتج معطّل، باركود مكرر، أو خطأ اتصال)
  if (lookupError && !product) {
    const errorTitle =
      lookupError.code === "FORBIDDEN"
        ? "تعذّر الاستعلام — صلاحية غير متوفرة"
        : lookupError.code === "CONFLICT"
          ? "تضارب في الباركود"
          : lookupError.code === "NOT_FOUND"
            ? "تعذّر فتح عمل تصوير لهذا المنتج"
            : "تعذّر الاستعلام عن الباركود";

    return (
      <div
        dir="rtl"
        data-testid="studio-lookup-error-card"
        className={`w-full max-w-xl mx-auto rounded-xl border border-destructive/30 bg-destructive/5 p-4 sm:p-5 text-right space-y-3.5 shadow-sm transition-all ${className}`}
      >
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-destructive/15 p-2 text-destructive shrink-0 mt-0.5">
            <AlertCircle aria-hidden className="size-5" />
          </div>
          <div className="space-y-1.5 min-w-0">
            <h3
              data-testid="lookup-error-feedback"
              className="text-base font-bold text-destructive"
            >
              {errorTitle}
            </h3>
            {barcode && (
              <div>
                <span className="font-mono text-xs font-semibold text-foreground dir-ltr inline-block px-1.5 py-0.5 bg-muted rounded">
                  {barcode}
                </span>
              </div>
            )}
            <p className="text-xs sm:text-sm text-muted-foreground leading-relaxed whitespace-pre-line">
              {lookupError.message}
            </p>
          </div>
        </div>

        {onManualSearch && (
          <div className="pt-1 flex justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onManualSearch}
              className="min-h-10 text-xs sm:text-sm font-semibold gap-1.5"
            >
              <Search aria-hidden className="size-4" />
              <span>البحث اليدوي عن المنتج</span>
            </Button>
          </div>
        )}
      </div>
    );
  }

  // حالة الباركود غير المسجل بالنظام
  if (isUnregistered || (!product && barcode)) {
    return (
      <div
        dir="rtl"
        data-testid="studio-unregistered-barcode-card"
        className={`w-full max-w-xl mx-auto rounded-xl border border-destructive/30 bg-destructive/5 p-4 sm:p-5 text-right space-y-3.5 shadow-sm transition-all ${className}`}
      >
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-destructive/15 p-2 text-destructive shrink-0 mt-0.5">
            <AlertCircle aria-hidden className="size-5" />
          </div>
          <div className="space-y-1">
            <h3
              data-testid="unregistered-barcode-feedback"
              className="text-base font-bold text-destructive"
            >
              هذا الباركود غير مسجل بالنظام
            </h3>
            <p className="text-xs sm:text-sm text-muted-foreground leading-relaxed">
              لم نعثر على أي منتج مطابق للرمز{" "}
              {barcode && (
                <span className="font-mono font-semibold text-foreground dir-ltr inline-block px-1.5 py-0.5 bg-muted rounded">
                  {barcode}
                </span>
              )}
              . يمكنك التأكد من صحة الرمز أو البحث يدوياً بالاسم.
            </p>
          </div>
        </div>

        {onManualSearch && (
          <div className="pt-1 flex justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onManualSearch}
              className="min-h-10 text-xs sm:text-sm font-semibold gap-1.5"
            >
              <Search aria-hidden className="size-4" />
              <span>البحث اليدوي عن المنتج</span>
            </Button>
          </div>
        )}
      </div>
    );
  }

  // في حال لم يتم اختيار أي منتج بعد
  if (!product) {
    return null;
  }

  const status = deriveProductStudioStatus(images, activeJob);
  const isLocked = Boolean(lock?.isLocked);

  return (
    <div
      dir="rtl"
      data-testid="studio-product-card-status"
      className={`w-full max-w-xl mx-auto rounded-xl border border-border bg-card p-4 sm:p-5 text-right space-y-4 shadow-sm transition-all ${className}`}
    >
      {/* 1. راية القفل التزامني المؤقت */}
      {isLocked && (
        <div
          data-testid="studio-lock-warning-banner"
          className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-amber-700 dark:text-amber-300 flex items-start gap-2.5"
        >
          <Lock aria-hidden className="size-5 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
          <div className="text-xs sm:text-sm space-y-0.5">
            <p className="font-bold">
              المنتج قيد التصوير حالياً بواسطة:{" "}
              <span className="underline decoration-amber-500/50">
                {lock?.activePhotographerName || "موظف آخر"}
              </span>
            </p>
            {lock?.remainingSeconds != null && lock.remainingSeconds > 0 && (
              <p className="text-[11px] sm:text-xs text-amber-600/90 dark:text-amber-400/90">
                ينتهي القفل التزامني تلقائياً خلال {lock.remainingSeconds} ثانية في حال عدم إتمام الرفع.
              </p>
            )}
          </div>
        </div>
      )}

      {/* 2. رأس البطاقة وتفاصيل المنتج */}
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2.5 border-b border-border/70 pb-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h2
              data-testid="product-card-name"
              className="text-base sm:text-lg font-bold text-foreground leading-snug"
            >
              {product.name}
            </h2>
            {product.variantName && (
              <Badge variant="secondary" className="text-xs font-semibold">
                {product.variantName}
              </Badge>
            )}
            {product.unitName && (
              <span className="text-xs text-muted-foreground">({product.unitName})</span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {product.categoryName && <span>التصنيف: {product.categoryName}</span>}
            {product.brand && (
              <>
                <span>•</span>
                <span>الماركة: {product.brand}</span>
              </>
            )}
            {product.barcode && (
              <>
                <span>•</span>
                <span className="font-mono text-foreground dir-ltr">
                  {product.barcode}
                </span>
              </>
            )}
          </div>
        </div>

        {/* شارة الحالة الديناميكية */}
        <div className="shrink-0 self-start">
          {status === "PREVIOUSLY_PHOTOGRAPHED" && (
            <Badge
              data-testid="status-badge-previously-photographed"
              className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30 gap-1.5 py-1 px-2.5 text-xs font-bold"
            >
              <Check aria-hidden className="size-3.5" />
              <span>مصور مسبقاً</span>
            </Badge>
          )}

          {status === "PENDING_REVIEW" && (
            <Badge
              data-testid="status-badge-pending-review"
              className="bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30 gap-1.5 py-1 px-2.5 text-xs font-bold"
            >
              <Clock aria-hidden className="size-3.5" />
              <span>بانتظار الاعتماد</span>
            </Badge>
          )}

          {status === "NO_IMAGE" && (
            <Badge
              data-testid="status-badge-no-image"
              variant="outline"
              className="bg-muted text-muted-foreground border-border gap-1.5 py-1 px-2.5 text-xs font-bold"
            >
              <ImageIcon aria-hidden className="size-3.5" />
              <span>بلا صورة</span>
            </Badge>
          )}
        </div>
      </div>

      {/* 3. جسم الحالة وفق النمط */}

      {/* الحالة أ: مصور مسبقاً */}
      {status === "PREVIOUSLY_PHOTOGRAPHED" && (
        <div className="space-y-3.5" data-testid="previously-photographed-details">
          {/* شريط مصغرات الصور السابقة */}
          <div className="space-y-1.5">
            <span className="text-xs font-semibold text-muted-foreground block">
              الصور المعتمدة السابقة ({images.length}):
            </span>
            <div
              data-testid="previous-photos-strip"
              className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-thin"
            >
              {images.map((img, idx) => {
                const src = resolveStudioImageSrc(img);
                return (
                <div
                  key={img.id || idx}
                  className="relative shrink-0 rounded-lg border border-border bg-muted/40 p-0.5 group overflow-hidden"
                >
                  {src ? (
                    <img
                      src={src}
                      alt={product.name}
                      className="w-14 h-14 sm:w-16 sm:h-16 object-cover rounded-md"
                      loading="lazy"
                    />
                  ) : (
                    <div className="flex w-14 h-14 sm:w-16 sm:h-16 items-center justify-center rounded-md text-muted-foreground">
                      <ImageIcon aria-hidden className="size-4" />
                    </div>
                  )}
                  {/* مؤشر صورة الغلاف الرئيسية */}
                  {img.isPrimary && (
                    <div
                      data-testid="primary-cover-indicator"
                      title="صورة الغلاف الرئيسية"
                      className="absolute top-1 right-1 rounded-full bg-primary text-primary-foreground p-0.5 shadow"
                    >
                      <Star aria-hidden className="size-3 fill-current" />
                    </div>
                  )}
                </div>
                );
              })}
            </div>
          </div>

          {/* خيارا إضافة صورة إضافية أو استبدال الحالية */}
          <div className="rounded-lg bg-muted/40 p-3 space-y-2.5 border border-border/50">
            <span className="text-xs font-bold text-foreground block">
              ما الإجراء المطلوب تنفيذه؟
            </span>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <Button
                type="button"
                variant={selectedAction === "ADD" ? "default" : "outline"}
                size="sm"
                onClick={() => {
                  onSelectAction?.("ADD");
                  onStartCapture?.();
                }}
                data-testid="btn-add-additional-photo"
                className="min-h-11 h-auto py-2 text-xs sm:text-sm font-bold gap-2 justify-center"
              >
                <Plus aria-hidden className="size-4" />
                <span>إضافة صورة إضافية</span>
              </Button>

              <Button
                type="button"
                variant={selectedAction === "REPLACE" ? "default" : "outline"}
                size="sm"
                onClick={() => {
                  onSelectAction?.("REPLACE");
                  onStartCapture?.();
                }}
                data-testid="btn-replace-current-photo"
                className="min-h-11 h-auto py-2 text-xs sm:text-sm font-bold gap-2 justify-center"
              >
                <RefreshCw aria-hidden className="size-4" />
                <span>استبدال الصورة الحالية</span>
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* الحالة ب: بانتظار الاعتماد */}
      {status === "PENDING_REVIEW" && (
        <div
          data-testid="pending-review-details"
          className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-3.5 space-y-3"
        >
          <div className="flex items-center gap-3">
            {activeJob?.candidateThumb ? (
              <img
                src={activeJob.candidateThumb}
                alt="الصورة قيد المراجعة"
                className="w-16 h-16 object-cover rounded-lg border border-amber-500/30 shrink-0"
              />
            ) : (
              <div className="w-16 h-16 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center shrink-0 text-amber-600">
                <Clock aria-hidden className="size-6" />
              </div>
            )}
            <div className="space-y-1 text-xs sm:text-sm">
              <p className="font-bold text-amber-700 dark:text-amber-300">
                توجد لقطة جديدة مرفوعة بانتظار موافقة الإدارة
              </p>
              <p className="text-muted-foreground text-xs leading-relaxed">
                ستظهر الصورة في الكتالوج ونقاط البيع فور اعتمادها من قبل المدير، ويمكنك إضافة صور إضافية أخرى للمنتج.
              </p>
            </div>
          </div>

          <div className="pt-1 flex justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onStartCapture}
              data-testid="btn-reshoot-pending"
              className="min-h-10 text-xs sm:text-sm font-semibold gap-1.5"
            >
              <Plus aria-hidden className="size-4" />
              <span>إضافة صورة أخرى للمنتج</span>
            </Button>
          </div>
        </div>
      )}

      {/* الحالة ج: بلا صورة */}
      {status === "NO_IMAGE" && (
        <div data-testid="no-image-details" className="space-y-3 pt-1">
          <p className="text-xs sm:text-sm text-muted-foreground">
            هذا المنتج لا يحتوي على أي صور معتمدة في النظام حالياً.
          </p>

          <Button
            type="button"
            variant="default"
            size="lg"
            onClick={onStartCapture}
            data-testid="btn-shoot-now"
            className="w-full min-h-12 text-sm sm:text-base font-bold gap-2 shadow-sm"
          >
            <Camera aria-hidden className="size-5" />
            <span>التقاط صورة المنتج الآن</span>
          </Button>
        </div>
      )}
    </div>
  );
}
