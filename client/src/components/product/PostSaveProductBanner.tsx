import { Link } from "wouter";
import { Barcode, CheckCircle2, ImagePlus, Pencil, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { STOCK_USAGE_LABELS, type StockUsage } from "@shared/stockUsage";

export interface PostSaveProductSummary {
  productId: number;
  name: string;
  sku?: string | null;
  stockUsage?: StockUsage;
}

export function PostSaveProductBanner({
  saved,
  onDismiss,
}: {
  saved: PostSaveProductSummary | null;
  onDismiss: () => void;
}) {
  if (!saved) return null;
  const usageLabel = saved.stockUsage
    ? STOCK_USAGE_LABELS[saved.stockUsage]
    : null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--sem-pos)]/40 bg-[var(--sem-pos-bg)] px-3 py-2 text-xs"
    >
      <div className="flex flex-wrap items-center gap-2">
        <CheckCircle2 aria-hidden className="size-4 text-[var(--sem-pos)]" />
        <span className="font-semibold text-foreground">
          حُفظ «{saved.name}» وأُفرغ النموذج لإضافة صنف جديد
        </span>
        {saved.sku ? (
          <Badge variant="outline" className="font-mono" dir="ltr">
            {saved.sku}
          </Badge>
        ) : null}
        {usageLabel ? <Badge variant="secondary">{usageLabel}</Badge> : null}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button asChild size="sm" variant="outline" className="h-7 px-2 text-xs">
          <Link href={`/products/${saved.productId}/edit`}>
            <Pencil aria-hidden className="size-3.5" />
            تعديل الصنف
          </Link>
        </Button>
        <Button asChild size="sm" variant="outline" className="h-7 px-2 text-xs">
          <Link href={`/barcode-labels?productId=${saved.productId}`}>
            <Barcode aria-hidden className="size-3.5" />
            طباعة ملصق باركود
          </Link>
        </Button>
        <Button asChild size="sm" variant="outline" className="h-7 px-2 text-xs">
          <Link href={`/catalog/image-studio?productId=${saved.productId}`}>
            <ImagePlus aria-hidden className="size-3.5" />
            استوديو الصور
          </Link>
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          onClick={onDismiss}
          aria-label="إخفاء شريط الصنف المحفوظ"
        >
          <X aria-hidden className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
