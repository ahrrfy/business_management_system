import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import {
  AlertTriangle,
  Barcode,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Image as ImageIcon,
  Layers,
  Loader2,
  ScanLine,
} from "lucide-react";
import { useState } from "react";

interface Props {
  productId: number;
  activeVariantId?: number | null;
  onSelectBarcode?: (barcode: string) => void;
  disabled?: boolean;
}

/**
 * بطاقة مصفوفة بدائل وباركودات المنتج الفيزيائية في الاستوديو.
 *
 * تضمن عدم الاكتفاء بمسح باركود بديل واحد وتعميمه خطأً على بقية البدائل:
 * ١. ترصد كافة بدائل المنتج الـ (N) وباركوداتها الفيزيائية المسجلة.
 * ٢. توضح نسبة التغطية (كم بديل صُوِّر، وكم بديل ما زال ناقصاً).
 * ٣. تبرز البديل النشط الممسوح حالياً مع تمييزه فيزيائياً.
 * ٤. تتيح للمصور الانتقال الفوري لمسح أو بدء تصوير البديل التالي بنقرة واحدة.
 */
export function StudioProductVariantMatrixCard({
  productId,
  activeVariantId,
  onSelectBarcode,
  disabled,
}: Props) {
  const [expanded, setExpanded] = useState(true);

  const matrixQuery = trpc.productStudio.variantMatrix.useQuery(
    { productId },
    { enabled: productId > 0, staleTime: 10_000 }
  );

  if (matrixQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/20 p-3 text-xs text-muted-foreground">
        <Loader2 aria-hidden className="size-4 animate-spin text-primary" />
        جاري جلب مصفوفة بدائل وباركودات المنتج...
      </div>
    );
  }

  const data = matrixQuery.data;
  if (!data || data.totalVariants === 0) {
    return null;
  }

  // إذا كان المنتج بسيطاً بدون بدائل متعددة ومكتمل
  if (data.totalVariants <= 1 && data.isFullyCovered) {
    return null;
  }

  const coveragePercent = Math.round(
    (data.variantsWithImages / Math.max(1, data.totalVariants)) * 100
  );

  return (
    <Card className="border-primary/30 bg-card/60 shadow-xs">
      <CardHeader className="p-3.5 pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="rounded-md bg-primary/10 p-1.5 text-primary">
              <Layers aria-hidden className="size-4" />
            </div>
            <div>
              <CardTitle className="text-sm font-semibold">
                مصفوفة بدائل وباركودات المنتج ({data.variantsWithImages} من {data.totalVariants} مصوّرة)
              </CardTitle>
              <p className="text-[11px] text-muted-foreground">
                إجمالي {data.totalBarcodes} باركود فيزيائي مسجل لهذا المنتج عبر كافة البدائل والوحدات
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge
              variant={data.isFullyCovered ? "default" : "outline"}
              className={`text-xs ${
                data.isFullyCovered
                  ? "bg-[var(--sem-pos)] text-background hover:bg-[var(--sem-pos)]"
                  : "border-amber-500/40 text-amber-700 bg-amber-500/10"
              }`}
            >
              {data.isFullyCovered
                ? "مكتمل التغطية"
                : `${data.variantsMissingImages} بدائل تحتاج تصوير`}
            </Badge>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={() => setExpanded(!expanded)}
              aria-label={expanded ? "طي المصفوفة" : "توسيع المصفوفة"}
            >
              {expanded ? (
                <ChevronUp aria-hidden className="size-4" />
              ) : (
                <ChevronDown aria-hidden className="size-4" />
              )}
            </Button>
          </div>
        </div>

        {/* شريط نسبة التغطية */}
        <div className="mt-2 space-y-1">
          <div className="flex justify-between text-[11px] text-muted-foreground">
            <span>نسبة إنجاز باركودات البدائل</span>
            <span className="font-mono font-medium">{coveragePercent}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full transition-all duration-300 ${
                data.isFullyCovered ? "bg-[var(--sem-pos)]" : "bg-primary"
              }`}
              style={{ width: `${coveragePercent}%` }}
            />
          </div>
        </div>
      </CardHeader>

      {expanded && (
        <CardContent className="space-y-3 p-3.5 pt-1">
          {/* تنبيه تحذيري بارز لمنع فخ تصوير باركود واحد فقط */}
          {data.totalVariants > 1 && data.variantsMissingImages > 0 && (
            <div className="flex items-start gap-2.5 rounded-md border border-amber-500/30 bg-amber-500/[0.08] p-2.5 text-xs text-amber-900">
              <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-amber-600" />
              <div className="min-w-0 flex-1 leading-relaxed">
                <span className="font-semibold text-amber-800">
                  تنبيه تشغيلي حاسم (بروتوكول الباركود):{" "}
                </span>
                يحتوي هذا المنتج على {data.totalVariants} بدائل بباركودات مستقلة. تصوير باركود واحد لا يُغني عن بقية البدائل! يرجى مسح وتصوير كل بديل فيزيائي على حدة لضمان اكتمال الكتالوج.
              </div>
            </div>
          )}

          {/* قائمة البدائل والباركودات */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {data.items.map((item) => {
              const isCurrent = activeVariantId != null && activeVariantId === item.variantId;
              const hasImages = item.approvedImagesCount > 0;
              const hasBarcode = item.primaryBarcode != null && item.primaryBarcode.trim() !== "";

              return (
                <div
                  key={item.variantId}
                  className={`relative flex flex-col justify-between rounded-lg border p-2.5 transition-colors ${
                    isCurrent
                      ? "border-primary bg-primary/[0.05] ring-1 ring-primary/40"
                      : hasImages
                      ? "border-border/70 bg-card"
                      : "border-amber-500/30 bg-amber-500/[0.02]"
                  }`}
                >
                  <div className="space-y-1.5">
                    {/* رأس بطاقة البديل */}
                    <div className="flex items-start justify-between gap-1.5">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          {item.colorHex && (
                            <span
                              className="size-2.5 shrink-0 rounded-full border border-black/20"
                              style={{ backgroundColor: item.colorHex }}
                              title={item.color ?? ""}
                            />
                          )}
                          <span className="truncate text-xs font-semibold text-foreground">
                            {item.variantName}
                          </span>
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                          <span>رمز SKU: {item.sku}</span>
                          {item.size && <span>· حجم: {item.size}</span>}
                          {item.color && !item.colorHex && <span>· لون: {item.color}</span>}
                        </div>
                      </div>

                      {/* شارة حالة البديل */}
                      {isCurrent ? (
                        <Badge variant="default" className="text-[10px] shrink-0">
                          قيد التصوير الآن
                        </Badge>
                      ) : hasImages ? (
                        <Badge
                          variant="outline"
                          className="text-[10px] shrink-0 border-[var(--sem-pos)]/40 bg-[var(--sem-pos)]/10 text-[var(--sem-pos)]"
                        >
                          <CheckCircle2 aria-hidden className="ml-1 size-3" />
                          {item.approvedImagesCount} صور
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="text-[10px] shrink-0 border-amber-500/40 bg-amber-500/10 text-amber-700"
                        >
                          ناقص
                        </Badge>
                      )}
                    </div>

                    {/* الباركودات المسجلة للبديل */}
                    <div className="space-y-1 pt-1">
                      {item.units.map((unit) => (
                        <div
                          key={unit.unitId}
                          className="flex items-center justify-between rounded bg-muted/40 px-2 py-1 text-[11px]"
                        >
                          <span className="text-muted-foreground font-medium">{unit.unitName}:</span>
                          {unit.barcode ? (
                            <button
                              type="button"
                              disabled={disabled || !onSelectBarcode}
                              onClick={() => onSelectBarcode?.(unit.barcode!)}
                              className="group flex items-center gap-1 font-mono font-semibold text-foreground hover:text-primary transition-colors focus-visible:outline-none"
                              title="انقر لمسح واختيار هذا الباركود"
                            >
                              <Barcode aria-hidden className="size-3 text-muted-foreground group-hover:text-primary" />
                              <span className="underline decoration-dotted decoration-muted-foreground/50 group-hover:decoration-primary">
                                {unit.barcode}
                              </span>
                            </button>
                          ) : (
                            <span className="italic text-muted-foreground/60 text-[10px]">
                              بدون باركود
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* تذييل البطاقة وإجراء الانتقال */}
                  <div className="mt-2.5 flex items-center justify-between gap-1 border-t border-border/40 pt-2">
                    {item.primaryImageThumb ? (
                      <div className="flex items-center gap-1.5">
                        <img
                          src={item.primaryImageThumb}
                          alt={item.variantName}
                          className="size-7 rounded border object-contain bg-white p-0.5"
                        />
                        <span className="text-[10px] text-muted-foreground">صورة البديل</span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                        <ImageIcon aria-hidden className="size-3.5 text-muted-foreground/60" />
                        <span>لا توجد صورة خاصة</span>
                      </div>
                    )}

                    {!isCurrent && hasBarcode && onSelectBarcode && (
                      <Button
                        type="button"
                        size="sm"
                        variant={hasImages ? "ghost" : "outline"}
                        className={`h-7 px-2 text-[11px] gap-1 font-medium ${
                          !hasImages
                            ? "border-amber-500/40 text-amber-800 hover:bg-amber-500/10"
                            : ""
                        }`}
                        disabled={disabled}
                        onClick={() => onSelectBarcode(item.primaryBarcode!)}
                      >
                        <ScanLine aria-hidden="true" className="size-3" />
                        {hasImages ? "إعادة تصوير" : "بدء تصوير البديل"}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      )}
    </Card>
  );
}
