import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { DiscoveryModel } from "./useStudioDiscovery";
import {
  STUDIO_IMAGE_HEALTH_LABELS as STATE_LABEL,
  STUDIO_DISCOVERY_SORT_LABELS as SORT_LABEL,
} from "@shared/terms";
import {
  DEFAULT_FILTERS,
  STATE_VARIANT,
  STATE_TOOLTIP,
  type Health,
  type SortOption,
} from "./discoverySettings";
import { ChevronLeft, ChevronRight, Package } from "lucide-react";
export function DiscoveryResults({ model }: { model: DiscoveryModel }) {
  const {
    items,
    allShownSelected,
    selectedIds,
    setSelectedIds,
    gaps,
    bundleOnly,
    handleStateChange,
    page,
    pageSize,
    setPage,
    setLauncherScope,
    setLauncherOpen,
  } = model;
  return (
    <>
      {/* جدول النتائج */}
      <div className="min-w-0 space-y-2">
        <div className="flex items-center justify-between gap-2 border-b pb-2 text-xs text-muted-foreground">
          <button
            type="button"
            className="underline underline-offset-2 hover:text-foreground"
            onClick={() => {
              if (allShownSelected) {
                setSelectedIds((cur) => {
                  const next = new Set(cur);
                  items.forEach((i) => next.delete(i.productId));
                  return next;
                });
              } else {
                setSelectedIds((cur) => {
                  const next = new Set(cur);
                  items.forEach((i) => next.add(i.productId));
                  return next;
                });
              }
            }}
          >
            {allShownSelected
              ? "إلغاء تحديد المعروض"
              : `تحديد كل المعروض في الصفحة (${items.length})`}
          </button>
          <span>
            {gaps.isFetching ? "جارٍ البحث…" : `${items.length} منتج في الصفحة`}
          </span>
        </div>

        {/* شريط التحديد الشامل للمنظومة */}
        {allShownSelected && items.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/60 p-2.5 text-xs">
            <span>
              تم تحديد كافة الـ <strong>{items.length}</strong> منتجاً المعروضة
              في هذه الصفحة.
            </span>
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto max-w-full whitespace-normal p-0 text-start text-xs font-bold text-primary underline"
              onClick={() => {
                setLauncherScope("CURRENT_FILTER");
                setLauncherOpen(true);
              }}
            >
              إطلاق حملة وتوزيع لكافة المنتجات المطابقة للتصفية عبر المنظومة
              فوراً
            </Button>
          </div>
        )}

        {(gaps.isLoading || gaps.isFetching) && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            جارٍ التحميل…
          </p>
        )}
        {gaps.isError && (
          <p role="alert" className="text-sm text-destructive">
            تعذّر جلب النتائج — {gaps.error?.message ?? "خطأ غير متوقّع"}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => gaps.refetch()}
            >
              إعادة المحاولة
            </Button>
          </p>
        )}

        {!gaps.isLoading && !gaps.isError && items.length === 0 && (
          <div className="space-y-2 py-6 text-center text-sm text-muted-foreground">
            {bundleOnly ? (
              <>
                <p>لا بكجات مطابقة لحالاتك المختارة.</p>
                <p className="text-xs">
                  البكج بصورةٍ واحدة يُصنَّف «صورةٌ واحدة» — فعِّل حالاتٍ
                  إضافيةً أعلاه أو أطفئ «البكج فقط» لرؤية كلّ الكتالوج.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-11"
                  onClick={() =>
                    handleStateChange([
                      "NO_IMAGES",
                      "BUNDLE_NO_IMAGE",
                      "SINGLE_IMAGE",
                      "PARENT_ONLY_HAS_VARIANTS",
                      "VARIANTS_INCOMPLETE",
                      "HEALTHY",
                    ])
                  }
                >
                  وسّع الحالات كلّها
                </Button>
              </>
            ) : (
              <p>لا نتائج بهذه الفلاتر — جرّب توسيع الحالات أو حذف البحث.</p>
            )}
          </div>
        )}

        {items.length > 0 && (
          <ul className="space-y-1">
            {items.map((item) => {
              const checked = selectedIds.has(item.productId);
              return (
                <li
                  key={item.productId}
                  className="flex items-start gap-2 rounded-md border p-2"
                >
                  <input
                    type="checkbox"
                    aria-label={`تحديد ${item.name}`}
                    className="mt-2 size-4 shrink-0"
                    checked={checked}
                    onChange={() =>
                      setSelectedIds((cur) => {
                        const next = new Set(cur);
                        if (checked) next.delete(item.productId);
                        else next.add(item.productId);
                        return next;
                      })
                    }
                  />
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="flex w-full min-w-0 items-center gap-2 sm:flex-1">
                        <span className="min-w-0 break-words text-sm font-medium">
                          {item.name}
                        </span>
                        {item.isBundle && (
                          <span
                            className="inline-flex shrink-0 items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-400"
                            title="بكج مركَّب من مكوّناتٍ متعدّدة"
                          >
                            <Package aria-hidden className="size-3" /> بكج
                          </span>
                        )}
                      </span>
                      <Badge variant={STATE_VARIANT[item.state]}>
                        {STATE_LABEL[item.state]}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {item.approvedImages} صورة معتمدة
                      {item.variantCount > 0 && (
                        <>
                          {" · "}
                          {item.variantsWithImages}/{item.variantCount} بديل
                          بصور
                          {item.variantsMissing > 0 && (
                            <span className="text-[var(--sem-warn)]">
                              {" "}
                              · {item.variantsMissing} بدون
                            </span>
                          )}
                        </>
                      )}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {/* أدوات التحكم بالصفحات Pagination */}
        {(items.length > 0 || page > 1) && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-xs text-muted-foreground">
            <div>
              صفحة <strong>{page}</strong> · {items.length} منتج
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 gap-1 px-2.5 text-xs"
                disabled={page <= 1 || gaps.isFetching}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                <ChevronRight className="size-3.5" />
                السابق
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 gap-1 px-2.5 text-xs"
                disabled={items.length < pageSize || gaps.isFetching}
                onClick={() => setPage((p) => p + 1)}
              >
                التالي
                <ChevronLeft className="size-3.5" />
              </Button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
