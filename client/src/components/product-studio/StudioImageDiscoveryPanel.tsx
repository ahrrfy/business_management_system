/**
 * لوحةُ كشف فجوات الصور — للمدير فقط.
 *
 * الحاجة (المالك ٢٦/٨): «منظومة ذكيّة تقترح وتبحث عن المنتجات التي لا تحتوي على صور،
 * أو بدائل بلا صور، أو بكج، أو نحو ذلك — لتقليل هدر الوقت».
 *
 * التصميم:
 *   • ستّة عدّادات KPI لكل حالة (بلا صور، بكج بلا صورة، صورةٌ واحدة، بدائل ناقصة، …).
 *   • فلترٌ بحالةٍ واحدة أو أكثر + بحث بالاسم + خيارُ «البكج فقط».
 *   • جدولُ منتجاتٍ مصنَّفة بالحالة، مع أعمدة «صور معتمدة» و «بدائل بلا صور».
 *   • اختيارٌ جماعيّ + زرٌّ «أنشئ حملة تصوير من المحدَّد» — يفتح المنشئ مُعبَّأً.
 *   • «أعلى الفئات فيها فجوات» — اقتراحاتٌ استباقيّة بضغطةٍ واحدة.
 */
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { notify } from "@/lib/notify";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { CheckCircle2, ImageOff, Layers, Package, Search, Sparkles, TrendingDown } from "lucide-react";
import { useMemo, useState } from "react";

type Health = RouterOutputs["productStudio"]["discoverImageGaps"]["items"][number]["state"];

const STATE_LABEL: Record<Health, string> = {
  NO_IMAGES: "بلا صور",
  BUNDLE_NO_IMAGE: "بكج بلا صورة",
  SINGLE_IMAGE: "صورةٌ واحدة",
  PARENT_ONLY_HAS_VARIANTS: "الأمّ فقط · بدائل ناقصة",
  VARIANTS_INCOMPLETE: "بدائل ناقصة",
  HEALTHY: "سليم",
};

const STATE_VARIANT: Record<Health, "danger" | "warning" | "info" | "success" | "neutral"> = {
  NO_IMAGES: "danger",
  BUNDLE_NO_IMAGE: "danger",
  SINGLE_IMAGE: "warning",
  PARENT_ONLY_HAS_VARIANTS: "info",
  VARIANTS_INCOMPLETE: "info",
  HEALTHY: "success",
};

export function StudioImageDiscoveryPanel({
  onCreateCampaignFromProducts,
  onCreateCampaignFromCategory,
}: {
  onCreateCampaignFromProducts: (productIds: number[]) => void;
  onCreateCampaignFromCategory: (categoryId: number) => void;
}) {
  const [selectedStates, setSelectedStates] = useState<Health[]>(["NO_IMAGES", "BUNDLE_NO_IMAGE"]);
  const [search, setSearch] = useState("");
  const [bundleOnly, setBundleOnly] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const counts = trpc.productStudio.imageHealthCounts.useQuery(undefined, { staleTime: 60_000 });
  const topCategories = trpc.productStudio.topGapCategories.useQuery({ limit: 8 }, { staleTime: 120_000 });
  const gaps = trpc.productStudio.discoverImageGaps.useQuery(
    {
      states: selectedStates.length > 0 ? selectedStates : undefined,
      isBundle: bundleOnly || undefined,
      search: search.trim() || undefined,
      limit: 100,
    },
    { staleTime: 30_000, placeholderData: (prev) => prev },
  );

  const items = gaps.data?.items ?? [];
  const allShownSelected = items.length > 0 && items.every((i) => selectedIds.has(i.productId));

  const kpiCards: Array<{ label: string; value: number; state: Health; icon: React.ReactNode }> = useMemo(() => {
    const c = counts.data?.counts;
    if (!c) return [];
    return [
      { label: STATE_LABEL.NO_IMAGES, value: c.NO_IMAGES, state: "NO_IMAGES", icon: <ImageOff aria-hidden className="size-4" /> },
      { label: STATE_LABEL.BUNDLE_NO_IMAGE, value: c.BUNDLE_NO_IMAGE, state: "BUNDLE_NO_IMAGE", icon: <Package aria-hidden className="size-4" /> },
      { label: STATE_LABEL.SINGLE_IMAGE, value: c.SINGLE_IMAGE, state: "SINGLE_IMAGE", icon: <TrendingDown aria-hidden className="size-4" /> },
      { label: STATE_LABEL.PARENT_ONLY_HAS_VARIANTS, value: c.PARENT_ONLY_HAS_VARIANTS, state: "PARENT_ONLY_HAS_VARIANTS", icon: <Layers aria-hidden className="size-4" /> },
      { label: STATE_LABEL.VARIANTS_INCOMPLETE, value: c.VARIANTS_INCOMPLETE, state: "VARIANTS_INCOMPLETE", icon: <Layers aria-hidden className="size-4" /> },
      { label: STATE_LABEL.HEALTHY, value: c.HEALTHY, state: "HEALTHY", icon: <CheckCircle2 aria-hidden className="size-4" /> },
    ];
  }, [counts.data]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm text-muted-foreground">
          <Sparkles aria-hidden className="size-4" /> كشفُ فجوات الصور — اقتراحاتٌ ذكيّة
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {counts.data && (
          <div className="rounded-md border bg-muted/20 p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>
                <strong>{counts.data.total}</strong> منتج نشط · <strong>{counts.data.healthyPercent}%</strong> سليم
              </span>
              <span className="text-xs text-muted-foreground">
                اضغط بطاقةً لتصفية الجدول بحالتها
              </span>
            </div>
          </div>
        )}

        {/* عدّادات KPI — نقرةٌ لتفعيل/إبطال الحالة كفلتر */}
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          {kpiCards.map((k) => {
            const active = selectedStates.includes(k.state);
            return (
              <button
                key={k.state}
                type="button"
                onClick={() => setSelectedStates((cur) => (active ? cur.filter((s) => s !== k.state) : [...cur, k.state]))}
                className={`min-h-11 rounded-md border p-3 text-start transition-colors ${active ? "border-primary bg-primary/5" : "hover:bg-muted/50"}`}
              >
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  {k.icon} {k.label}
                </div>
                <div className="mt-1 text-xl font-bold">{k.value}</div>
              </button>
            );
          })}
        </div>

        {/* «أعلى الفئات فيها فجوات» — نقرةٌ تفتح المنشئ بنطاق تلك الفئة */}
        {(topCategories.data ?? []).length > 0 && (
          <div className="space-y-2 rounded-md border p-3">
            <p className="text-xs font-medium text-muted-foreground">أعلى الفئات فيها فجوات صور</p>
            <div className="flex flex-wrap gap-2">
              {(topCategories.data ?? []).slice(0, 8).map((c) => (
                <Button
                  key={c.categoryId ?? -1}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-11"
                  onClick={() => c.categoryId && onCreateCampaignFromCategory(c.categoryId)}
                  disabled={c.categoryId == null}
                  title="افتح منشئ الحملة على هذه الفئة"
                >
                  {c.categoryName}
                  <Badge variant="warning" className="ms-1">{c.gapTotal}</Badge>
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              الرقم = مجموعُ حالات النقص في الفئة (بلا صور + صورةٌ واحدة + بدائل ناقصة). النقر يفتح منشئ الحملة على هذه الفئة.
            </p>
          </div>
        )}

        {/* فلاترُ البحث */}
        <div className="grid gap-3 md:grid-cols-3">
          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor="discovery-search">بحث باسم المنتج</Label>
            <div className="relative">
              <Search aria-hidden className="pointer-events-none absolute end-2 top-3 size-4 text-muted-foreground" />
              <Input id="discovery-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="اكتب جزءاً من الاسم" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="discovery-bundle">تصفية</Label>
            <Button
              id="discovery-bundle"
              type="button"
              variant={bundleOnly ? "default" : "outline"}
              className="min-h-11 w-full"
              onClick={() => setBundleOnly((v) => !v)}
            >
              <Package aria-hidden className="size-4" /> البكج فقط{bundleOnly ? " (مفعَّل)" : ""}
            </Button>
          </div>
        </div>

        {/* شريط الإجراءات — يظهر عند التحديد */}
        {selectedIds.size > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-primary/5 p-3">
            <span className="text-sm">
              <strong>{selectedIds.size}</strong> منتج مُحدَّد
            </span>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="min-h-11"
                onClick={() => setSelectedIds(new Set())}
              >
                إلغاء التحديد
              </Button>
              <Button
                type="button"
                className="min-h-11"
                onClick={() => {
                  const ids = Array.from(selectedIds);
                  if (ids.length === 0) {
                    notify.err("لا منتجاتٍ مُحدَّدة");
                    return;
                  }
                  onCreateCampaignFromProducts(ids);
                }}
              >
                <Sparkles aria-hidden className="size-4" /> أنشئ حملة تصوير من المحدَّد
              </Button>
            </div>
          </div>
        )}

        {/* جدول النتائج */}
        <div className="min-w-0 space-y-2">
          <div className="flex items-center justify-between gap-2 border-b pb-2 text-xs text-muted-foreground">
            <button
              type="button"
              className="underline underline-offset-2"
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
              {allShownSelected ? "إلغاء تحديد المعروض" : `تحديد كل المعروض (${items.length})`}
            </button>
            <span>{gaps.isFetching ? "جارٍ البحث…" : `${items.length} منتج`}</span>
          </div>

          {gaps.isLoading && <p className="py-6 text-center text-sm text-muted-foreground">جارٍ التحميل…</p>}
          {gaps.isError && <p role="alert" className="text-sm text-destructive">تعذّر جلب النتائج.</p>}
          {!gaps.isLoading && items.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              لا نتائج بهذه الفلاتر — جرّب توسيع الحالات أو حذف البحث.
            </p>
          )}
          {items.length > 0 && (
            <ul className="space-y-1">
              {items.map((item) => {
                const checked = selectedIds.has(item.productId);
                return (
                  <li key={item.productId} className="flex items-start gap-2 rounded-md border p-2">
                    <input
                      type="checkbox"
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
                        <span className="min-w-0 truncate text-sm font-medium">{item.name}</span>
                        <Badge variant={STATE_VARIANT[item.state]}>{STATE_LABEL[item.state]}</Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {item.approvedImages} صورة معتمدة
                        {item.variantCount > 0 && (
                          <>
                            {" · "}
                            {item.variantsWithImages}/{item.variantCount} بديل بصور
                            {item.variantsMissing > 0 && <span className="text-[var(--sem-warn)]"> · {item.variantsMissing} بدون</span>}
                          </>
                        )}
                        {item.isBundle && <> · بكج</>}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
