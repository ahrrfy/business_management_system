import { useOperationPermission } from "@/hooks/useOperationPermission";
/**
 * معرضُ صور المنتج القائمة — للمدير والمشاهدين المخوّلين.
 *
 * يتيح للمدير: تعيين الرئيسيّة، استبدال صورةٍ بعينها ذرّياً (`replaceImageId`)،
 * إعادة الترتيب، والإزالة حتّى لآخر صورة بعد التأكيد.
 * كل صورةٍ تُعرَض ببديلها المرتبط (إن كانت variant-scoped) مع تمييز صور الصفّ الحاليّ.
 */
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { confirm } from "@/lib/confirm";
import { runFreeStudioFlatten } from "@/lib/imageStudio/freePipeline";
import { notify } from "@/lib/notify";
import { createProductDisplayThumbnail } from "@/lib/productImageThumbnail";
import { resolveStudioImageSrc } from "@/lib/productImages";
import { trpc } from "@/lib/trpc";
import { ArrowDown, ArrowUp, Image as ImageIcon, RefreshCw, Star, Trash2 } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { prepareMobileCapturedImage } from "./quick-lookup/prepareMobileCapturedImage";

export interface GalleryImageReplaceTarget {
  id: number;
  variantId: number | null;
  variantName?: string | null;
  isPrimary: boolean;
}

export function ProductImageGallery({
  productId,
  variantId,
  onClose,
  onReplaceImage,
  readOnly = false,
}: {
  productId: number;
  variantId?: number | null;
  onClose?: () => void;
  onReplaceImage?: (img: GalleryImageReplaceTarget) => void;
  readOnly?: boolean;
}) {
  const studioCan = {
    deleteImage: useOperationPermission("productStudio.deleteImage").allowed,
    managerImages: useOperationPermission("productStudio.managerImages").allowed,
    productImages: useOperationPermission("productStudio.productImages").allowed,
    reorderImages: useOperationPermission("productStudio.reorderImages").allowed,
    setImagePrimary: useOperationPermission("productStudio.setImagePrimary").allowed,
    quickSave: useOperationPermission("productStudio.quickSaveBarcodeProductImage").allowed,
  };
  readOnly = readOnly || !studioCan.managerImages;
  const hasGalleryPermission = readOnly ? studioCan.productImages : studioCan.managerImages;
  const utils = trpc.useUtils();
  const managerImages = trpc.productStudio.managerImages.useQuery(
    { productId },
    { staleTime: 30_000, enabled: studioCan.managerImages && !readOnly },
  );
  const viewerImages = trpc.productStudio.productImages.useQuery(
    { productId },
    { staleTime: 30_000, enabled: studioCan.productImages && readOnly },
  );
  const images = readOnly ? viewerImages : managerImages;

  const invalidateAllImageCaches = useCallback(async () => {
    await Promise.all([
      utils.productStudio.managerImages.invalidate({ productId }),
      utils.productStudio.productImages.invalidate({ productId }),
      utils.productStudio.quickBarcodeLookup?.invalidate?.(),
      utils.productStudio.variantMatrix?.invalidate?.({ productId }),
      utils.productStudio.tasks?.invalidate?.(),
      utils.catalog.adminList?.invalidate?.(),
      utils.catalog.posList?.invalidate?.(),
      utils.catalog.getForVariantEdit?.invalidate?.({ productId }),
      utils.storeAdmin?.catalog?.list?.invalidate?.(),
    ]);
  }, [productId, utils]);

  const [localOrder, setLocalOrder] = useState<number[] | null>(null);
  const [replacingId, setReplacingId] = useState<number | null>(null);
  const pendingReplaceRef = useRef<GalleryImageReplaceTarget | null>(null);
  const replaceInputRef = useRef<HTMLInputElement | null>(null);

  const displayImages = useMemo(() => {
    const rows = images.data ?? [];
    if (localOrder == null) {
      if (variantId === undefined) return rows;
      const scopeRank = (rowVariantId: number | null) => {
        if (variantId != null) {
          if (rowVariantId === variantId) return 0;
          if (rowVariantId == null) return 1;
          return 2;
        }
        return rowVariantId == null ? 0 : 1;
      };
      return [...rows].sort((a, b) => scopeRank(a.variantId) - scopeRank(b.variantId));
    }
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ordered = localOrder.map((id) => byId.get(id)).filter((x): x is NonNullable<typeof x> => x != null);
    // ألحق أيّ صفٍّ لم يظهر في الترتيب المحلّي (وقاية من دفعةٍ تخسر عناصر).
    for (const r of rows) if (!localOrder.includes(r.id)) ordered.push(r);
    return ordered;
  }, [images.data, localOrder, variantId]);

  const setPrimary = trpc.productStudio.setImagePrimary.useMutation({
    onSuccess: async () => {
      notify.ok("عُيِّنت الصورة رئيسيّةً");
      await invalidateAllImageCaches();
    },
    onError: (e) => notify.err(e),
  });
  const deleteImg = trpc.productStudio.deleteImage.useMutation({
    onSuccess: async (r) => {
      notify.ok(r.promotedNewPrimary ? "حُذفت الصورة ورُقّيت الصورةُ التالية رئيسيّةً" : "حُذفت الصورة");
      setLocalOrder(null);
      await invalidateAllImageCaches();
    },
    onError: (e) => notify.err(e),
  });
  const reorder = trpc.productStudio.reorderImages.useMutation({
    onSuccess: async () => {
      notify.ok("حُفظ الترتيب");
      setLocalOrder(null);
      await invalidateAllImageCaches();
    },
    onError: (e) => notify.err(e),
  });
  const quickSave = trpc.productStudio.quickSaveBarcodeProductImage.useMutation();

  const handleBuiltInReplaceFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.target;
    const file = input.files?.[0];
    input.value = "";
    const target = pendingReplaceRef.current;
    pendingReplaceRef.current = null;
    if (!file || !target) return;
    setReplacingId(target.id);
    try {
      const rawDataUrl = await prepareMobileCapturedImage(file);
      const flattened = await runFreeStudioFlatten(rawDataUrl);
      const thumbnailDataUrl = await createProductDisplayThumbnail(flattened.dataUrl);
      await quickSave.mutateAsync({
        productId,
        variantId: target.variantId,
        originalDataUrl: rawDataUrl,
        processedDataUrl: flattened.dataUrl,
        thumbnailDataUrl,
        mode: "FLATTEN",
        setAsPrimary: target.isPrimary,
        replaceImageId: target.id,
      });
      notify.ok("تمّ استبدال الصورة بنجاح");
      setLocalOrder(null);
      await invalidateAllImageCaches();
    } catch (err) {
      notify.err(err);
    } finally {
      setReplacingId(null);
    }
  };

  const moveLocal = (index: number, delta: -1 | 1) => {
    const current = localOrder ?? displayImages.map((r) => r.id);
    const next = [...current];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    setLocalOrder(next);
  };
  const isDirty = localOrder != null;
  const isMutating = setPrimary.isPending || deleteImg.isPending || reorder.isPending || replacingId != null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="flex items-center gap-2 text-muted-foreground">
            <ImageIcon aria-hidden className="size-4" /> معرض صور المنتج — إدارة يدويّة
          </span>
          {onClose && (
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              إغلاق
            </Button>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <input
          ref={replaceInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleBuiltInReplaceFile}
        />
        {!hasGalleryPermission ? (
          <p role="alert" className="py-4 text-center text-sm text-muted-foreground">
            لا تملك صلاحية عرض معرض صور هذا المنتج.
          </p>
        ) : images.isLoading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">جارٍ التحميل…</p>
        ) : images.isError ? (
          <p role="alert" className="text-sm text-destructive">تعذّر جلب الصور — أعد المحاولة.</p>
        ) : displayImages.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">لا صور معتمَدة لهذا المنتج بعد.</p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              كل صورةٍ تُعرَض ببديلها المرتبط. رتِّب بأزرار السهم واحفظ. الصورة الرئيسيّة هي التي تظهر في المتجر والفواتير.
            </p>
            <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {displayImages.map((img, index) => {
                const isCurrentVariant = variantId != null && img.variantId === variantId;
                const isSiblingVariant = variantId != null && img.variantId != null && img.variantId !== variantId;
                const hasSiblingInSameScope = displayImages.some(
                  (other) => other.id !== img.id && (other.variantId ?? null) === (img.variantId ?? null),
                );
                const imgSrc = resolveStudioImageSrc(img);
                return (
                <li
                  key={img.id}
                  className={`min-w-0 rounded-md border p-2 ${
                    img.isPrimary
                      ? "border-primary"
                      : isCurrentVariant
                        ? "border-sky-500/50 bg-sky-500/5"
                        : ""
                  }`}
                >
                  <div className="relative aspect-square overflow-hidden rounded bg-muted/30">
                    {imgSrc ? (
                      <img
                        src={imgSrc}
                        alt={img.variantName ? `صورة بديل ${img.variantName}` : "صورة المنتج"}
                        className="size-full object-contain"
                        loading="lazy"
                      />
                    ) : (
                      <div className="flex size-full items-center justify-center text-muted-foreground">
                        <ImageIcon aria-hidden className="size-6" />
                      </div>
                    )}
                    {img.isPrimary && (
                      <Badge variant="success" className="absolute top-1 start-1">
                        <Star aria-hidden className="size-3" /> رئيسيّة
                      </Badge>
                    )}
                    {variantId !== undefined && (
                      <Badge
                        variant="outline"
                        className={`absolute bottom-1 start-1 bg-background/90 text-[10px] ${
                          isCurrentVariant
                            ? "border-sky-500 text-sky-700"
                            : isSiblingVariant
                              ? "border-amber-500/50 text-amber-700"
                              : ""
                        }`}
                      >
                        {isCurrentVariant
                          ? "هذا الصف"
                          : img.variantId == null
                            ? "الأمّ"
                            : (img.variantName || "متغيّر آخر")}
                      </Badge>
                    )}
                  </div>
                  <div className="mt-2 min-w-0 space-y-1 text-xs">
                    <p className="truncate text-muted-foreground">
                      {img.variantName ? `بديل: ${img.variantName}` : "على مستوى المنتج"}
                      {img.origin && img.origin !== "ORIGINAL" ? ` · ${img.origin.replace("STUDIO_", "")}` : ""}
                    </p>
                    {img.width && img.height && (
                      <p className="text-muted-foreground">{img.width}×{img.height}px {img.bytes ? `· ${Math.round((img.bytes ?? 0) / 1024)}KB` : ""}</p>
                    )}
                  </div>
                  {!readOnly && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      <Button type="button" size="sm" variant="ghost" className="min-h-10 px-2" title="حرّك لأعلى" disabled={!studioCan.reorderImages || isMutating || index === 0} onClick={() => moveLocal(index, -1)}>
                        <ArrowUp aria-hidden className="size-4" />
                      </Button>
                      <Button type="button" size="sm" variant="ghost" className="min-h-10 px-2" title="حرّك لأسفل" disabled={!studioCan.reorderImages || isMutating || index === displayImages.length - 1} onClick={() => moveLocal(index, 1)}>
                        <ArrowDown aria-hidden className="size-4" />
                      </Button>
                      {!img.isPrimary && (
                        <Button type="button" size="sm" variant="outline" className="min-h-10" disabled={!studioCan.setImagePrimary || isMutating} onClick={() => setPrimary.mutate({ imageId: img.id })}>
                          <Star aria-hidden className="size-4" /> تعيين رئيسية
                        </Button>
                      )}
                      {studioCan.quickSave && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="min-h-10"
                          disabled={isMutating}
                          onClick={() => {
                            const target: GalleryImageReplaceTarget = {
                              id: img.id,
                              variantId: img.variantId,
                              variantName: img.variantName,
                              isPrimary: img.isPrimary,
                            };
                            if (onReplaceImage) {
                              onReplaceImage(target);
                            } else {
                              pendingReplaceRef.current = target;
                              replaceInputRef.current?.click();
                            }
                          }}
                        >
                          <RefreshCw aria-hidden className={`size-4 ${replacingId === img.id ? "animate-spin" : ""}`} />
                          {replacingId === img.id ? "جارٍ الاستبدال…" : "استبدال بصورة جديدة"}
                        </Button>
                      )}
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        className="min-h-10"
                        disabled={!studioCan.deleteImage || isMutating}
                        onClick={async () => {
                          const ok = await confirm({
                            variant: "danger",
                            title: "إزالة الصورة نهائياً",
                            description: hasSiblingInSameScope
                              ? "لن تظهر هذه الصورة بعد الآن في المتجر أو الفواتير، وسيتم ترقية الصورة التالية في نفس النطاق كرئيسية إن لزم."
                              : "هذه آخر صورة معتمدة في هذا النطاق؛ إزالتها ستترك النطاق بلا صورة حتى تُضاف صورة جديدة.",
                            confirmText: "إزالة",
                          });
                          if (!ok) return;
                          deleteImg.mutate({ imageId: img.id });
                        }}
                      >
                        <Trash2 aria-hidden className="size-4" /> إزالة
                      </Button>
                    </div>
                  )}
                </li>
                );
              })}
            </ul>
            <div className="flex flex-wrap items-center gap-2 border-t pt-3">
              {!readOnly && (
                <>
                  <Button
                    type="button"
                    className="min-h-11"
                    disabled={!studioCan.reorderImages || !isDirty || isMutating}
                    onClick={() => reorder.mutate({ productId, orderedImageIds: (localOrder ?? []).slice() })}
                  >
                    احفظ الترتيب الجديد
                  </Button>
                  {isDirty && (
                    <Button type="button" variant="ghost" className="min-h-11" onClick={() => setLocalOrder(null)}>
                      إلغاء التعديل
                    </Button>
                  )}
                </>
              )}
              <span className="text-xs text-muted-foreground">
                {displayImages.length} صورة · {displayImages.filter((i) => i.isPrimary).length} رئيسيّة (حسب البديل)
              </span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
