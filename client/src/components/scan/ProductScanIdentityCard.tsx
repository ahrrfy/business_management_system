import * as React from "react";
import { useEffect, useState } from "react";
import { Barcode, CheckCircle2, ImageOff, PackageSearch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ProductBarcodeMatch } from "@shared/productScan";

export type ProductScanIdentityCardProps = {
  productName: string;
  variantName?: string | null;
  sku: string;
  barcode?: string | null;
  imageUrl?: string | null;
  scanMatch?: ProductBarcodeMatch | null;
  scanned?: boolean;
  loading?: boolean;
  actionLabel?: string;
  onAction?: () => void;
  className?: string;
};

/**
 * بطاقة تحقق موحّدة لمسارات الجرد والتسوية.
 * تجمع القرائن الثلاث في نظرة واحدة: الصورة + الاسم/المتغيّر + الباركود الفعلي، كي لا يبدأ
 * العامل إدخال الكمية اعتماداً على الاسم وحده. الصورة مورد HTTP مستقل فلا تُثقّل حمولة الكتالوج.
 */
export function ProductScanIdentityCard({
  productName,
  variantName,
  sku,
  barcode,
  imageUrl,
  scanMatch,
  scanned = false,
  loading = false,
  actionLabel,
  onAction,
  className,
}: ProductScanIdentityCardProps) {
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => setImageFailed(false), [imageUrl]);

  const shownCode = scanMatch?.scannedBarcode.trim() || barcode?.trim() || sku;
  const showImage = Boolean(imageUrl) && !imageFailed && !loading;
  const showAliasPrimaryBarcode =
    scanMatch?.kind === "ALIAS" &&
    Boolean(scanMatch.primaryBarcode?.trim()) &&
    scanMatch.primaryBarcode?.trim() !== scanMatch.scannedBarcode.trim();

  return (
    <section
      aria-live="polite"
      aria-busy={loading || undefined}
      className={cn(
        "overflow-hidden rounded-lg border border-primary/35 bg-primary/[0.04]",
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b border-primary/20 bg-primary/10 px-3 py-2 text-xs font-bold text-primary sm:px-4">
        {loading ? (
          <PackageSearch aria-hidden className="size-4 shrink-0 animate-pulse" />
        ) : (
          <CheckCircle2 aria-hidden className="size-4 shrink-0" />
        )}
        <span>
          {loading
            ? "جارٍ التعرّف على الباركود…"
            : scanned
              ? "تم التعرّف على المادة — طابق الصورة والاسم قبل المتابعة"
              : "المادة المحددة — تحقق منها قبل إدخال الكمية"}
        </span>
      </div>

      <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-3 p-3 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-4 sm:p-4">
        <div className="flex aspect-square items-center justify-center overflow-hidden rounded-md border bg-background">
          {showImage ? (
            <img
              src={imageUrl ?? undefined}
              alt={`صورة ${productName}`}
              className="size-full object-contain p-1"
              loading="eager"
              decoding="async"
              onError={() => setImageFailed(true)}
            />
          ) : (
            <div className="flex size-full flex-col items-center justify-center gap-1 bg-muted/50 px-1 text-center text-muted-foreground">
              {loading ? (
                <PackageSearch aria-hidden className="size-6 animate-pulse" />
              ) : (
                <ImageOff aria-hidden className="size-6" />
              )}
              <span className="text-[10px] font-semibold leading-4">
                {loading
                  ? "جارٍ تحميل الهوية"
                  : imageFailed
                    ? "تعذّر تحميل الصورة"
                    : "لا توجد صورة مسجّلة"}
              </span>
            </div>
          )}
        </div>

        <div className="flex min-w-0 flex-col justify-center">
          <h3 className="text-base font-extrabold leading-7 text-foreground sm:text-lg">
            {loading ? "جارٍ جلب بيانات المادة" : productName}
          </h3>
          {!loading && variantName ? (
            <p className="mt-0.5 text-sm font-semibold text-muted-foreground">{variantName}</p>
          ) : null}

          {!loading && scanMatch ? (
            <div
              aria-label="تفاصيل مطابقة الباركود"
              className="mt-2 flex flex-wrap items-center gap-1.5 text-xs"
            >
              <span
                className={cn(
                  "inline-flex min-h-6 items-center rounded-md border px-2 py-0.5 font-bold",
                  scanMatch.kind === "PRIMARY"
                    ? "border-[var(--sem-pos)]/30 bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]"
                    : "border-[var(--sem-warn)]/30 bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]",
                )}
              >
                {scanMatch.kind === "PRIMARY" ? "باركود أساسي" : "باركود بديل"}
              </span>
              <span className="inline-flex min-h-6 max-w-full items-center rounded-md border bg-background px-2 py-0.5 font-semibold text-foreground">
                الوحدة الممسوحة: <span className="ms-1 font-bold">{scanMatch.unitName}</span>
              </span>
              {scanMatch.factor > 1 ? (
                <span className="inline-flex min-h-6 items-center rounded-md border bg-muted/50 px-2 py-0.5 font-semibold text-muted-foreground">
                  × {scanMatch.factor} من وحدة الأساس
                </span>
              ) : null}
            </div>
          ) : null}

          <div className="mt-2 rounded-md border bg-background px-2.5 py-2">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
              <Barcode aria-hidden className="size-3.5" />
              {barcode || scanMatch ? "الباركود الممسوح" : "رمز المادة"}
            </p>
            <p className="mt-1 break-all font-mono text-sm font-bold tracking-wide text-foreground" dir="ltr">
              {shownCode || "—"}
            </p>
          </div>

          {!loading && showAliasPrimaryBarcode ? (
            <div className="mt-2 rounded-md border bg-background px-2.5 py-2">
              <p className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
                <Barcode aria-hidden className="size-3.5" />
                الباركود الأساسي للوحدة
              </p>
              <p className="mt-1 break-all font-mono text-sm font-bold tracking-wide text-foreground" dir="ltr">
                {scanMatch?.primaryBarcode}
              </p>
            </div>
          ) : null}

          {!loading && sku !== shownCode ? (
            <p className="mt-1.5 truncate font-mono text-[11px] text-muted-foreground" dir="ltr">
              SKU: {sku}
            </p>
          ) : null}

          {!loading && actionLabel && onAction ? (
            <Button type="button" size="sm" className="mt-3 w-full sm:w-auto sm:self-start" onClick={onAction}>
              <CheckCircle2 aria-hidden className="size-4" />
              {actionLabel}
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
