/**
 * لوحةُ كشف فجوات الصور — للمدير فقط.
 *
 * الحاجة (المالك ٢٦/٨): «منظومة ذكيّة تقترح وتبحث عن المنتجات التي لا تحتوي على صور،
 * أو بدائل بلا صور، أو بكج، أو نحو ذلك — لتقليل هدر الوقت».
 *
 * التصميم:
 *   • ستّة عدّادات KPI لكل حالة (بلا صور، بكج بلا صورة، صورةٌ واحدة، بدائل ناقصة، …).
 *   • فلترٌ بحالةٍ واحدة أو أكثر + بحث بالاسم + خيارُ «البكج فقط».
 *   • بطاقة رادار التدخل السريع وزر بطل لإطلاق حملة تصوير فورية لكامل الفجوة.
 *   • نافذة الإطلاق السريع وتوزيع المهام العادل على المصورين.
 *   • جدولُ منتجاتٍ مصنَّفة بالحالة مع دعم التصفح والصفحات والتحديد الشامل.
 */
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AppSelect } from "@/components/ui/AppSelect";
import { Label } from "@/components/ui/label";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import { notify } from "@/lib/notify";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ArrowUpDown, CheckCircle2, ChevronLeft, ChevronRight, ImageOff, Info, Layers, Package, Sparkles, TrendingDown, UserCheck, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { StudioInstantCampaignLauncher } from "./StudioInstantCampaignLauncher";

type Health = RouterOutputs["productStudio"]["discoverImageGaps"]["items"][number]["state"];

const STATE_LABEL: Record<Health, string> = {
  HIGH_VALUE_NO_IMAGE: "منتجات ذات أولوية بلا صور",
  CONSIGNMENT_NO_IMAGE: "بضائع أمانة بلا صور",
  HAS_IMAGE_NO_BARCODE: "صور بلا باركود للوحدات",
  CORRUPTED_OR_UNPROCESSED_IMAGE: "صور غير معالجة أو تالفة",
  REDUNDANT_VARIANT_IMAGE: "صور بدائل مكررة",
  NO_IMAGES: "منتجات بلا أي صور",
  BUNDLE_NO_IMAGE: "حزم وبكجات بلا صور",
  SINGLE_IMAGE: "صورة واحدة للأصل",
  PARENT_ONLY_HAS_VARIANTS: "صورة للأصل، وبدائل ناقصة",
  VARIANTS_INCOMPLETE: "بدائل ناقصة صوراً",
  HEALTHY: "مكتمل وسليم",
};

const STATE_VARIANT: Record<Health, "danger" | "warning" | "info" | "success" | "neutral"> = {
  HIGH_VALUE_NO_IMAGE: "danger",
  CONSIGNMENT_NO_IMAGE: "danger",
  HAS_IMAGE_NO_BARCODE: "danger",
  CORRUPTED_OR_UNPROCESSED_IMAGE: "warning",
  REDUNDANT_VARIANT_IMAGE: "warning",
  NO_IMAGES: "danger",
  BUNDLE_NO_IMAGE: "danger",
  SINGLE_IMAGE: "warning",
  PARENT_ONLY_HAS_VARIANTS: "info",
  VARIANTS_INCOMPLETE: "info",
  HEALTHY: "success",
};

const STATE_TOOLTIP: Record<Health, string> = {
  HIGH_VALUE_NO_IMAGE: "منتجات مطلوبة ومهمة لكنها بلا أي صور معتمدة. التدخل الفوري هنا ينقذ مبيعات مؤكدة!",
  CONSIGNMENT_NO_IMAGE: "بضاعة أمانة مهملة بلا صور، مما يعطل مبيعاتها ويضر بالعلاقة مع الموردين.",
  HAS_IMAGE_NO_BARCODE: "المنتج له صورة معتمدة ولكن وحداته تفتقر لباركود، مما يعطل البيع والمخزن.",
  CORRUPTED_OR_UNPROCESSED_IMAGE: "الصورة معطوبة أو فقدت بياناتها الوصفية وتسبب بطئاً أو تظهر مكسورة للزبون.",
  REDUNDANT_VARIANT_IMAGE: "تم استخدام نفس الصورة الجماعية لكل بدائل المنتج. يجب تصوير كل بديل على حدة.",
  NO_IMAGES: "منتجات نشطة بلا أي صورة معتمدة — أنشئ حملة تصوير أو أطلق حملة فورية.",
  BUNDLE_NO_IMAGE: "حزم وبكجات مجمعة بلا صور موحدة — تتطلب تصوير المجموعة معاً.",
  SINGLE_IMAGE: "منتج له صورة واحدة للأصل — تحقق من البدائل إن كانت تحتاج زوايا وصوراً مستقلة.",
  PARENT_ONLY_HAS_VARIANTS: "المنتج الأصل له صورة ولكن بدائله تفتقر لصور خاصة بها.",
  VARIANTS_INCOMPLETE: "أحد بدائل هذا المنتج ينقصه صور خاصة — أنشئ حملة تشمله.",
  HEALTHY: "المنتج مكتمل صوراً بحسب التوجيه الحالي ولا يحتاج تدخلاً.",
};

type SortOption = "MISSING_MOST" | "NAME_ASC" | "APPROVED_ASC" | "VARIANTS_MISSING_MOST";
const SORT_LABEL: Record<SortOption, string> = {
  MISSING_MOST: "الأحوج (بدائل ناقصة أولاً)",
  APPROVED_ASC: "الأقلّ صوراً معتمَدة",
  NAME_ASC: "الاسم أ ↔ ي",
  VARIANTS_MISSING_MOST: "الأكثر بدائلَ بلا صور",
};

const STORAGE_KEY = "studio.discovery.filters.v1";
type PersistedFilters = { states: Health[]; search: string; bundleOnly: boolean; sort: SortOption };
const DEFAULT_FILTERS: PersistedFilters = {
  states: ["HIGH_VALUE_NO_IMAGE", "CONSIGNMENT_NO_IMAGE", "HAS_IMAGE_NO_BARCODE", "NO_IMAGES", "BUNDLE_NO_IMAGE"],
  search: "",
  bundleOnly: false,
  sort: "MISSING_MOST",
};

function loadPersistedFilters(): PersistedFilters {
  if (typeof window === "undefined") return DEFAULT_FILTERS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_FILTERS;
    const parsed = JSON.parse(raw) as Partial<PersistedFilters>;
    const states = Array.isArray(parsed.states) ? parsed.states.filter((s): s is Health => typeof s === "string" && s in STATE_LABEL) : DEFAULT_FILTERS.states;
    const search = typeof parsed.search === "string" ? parsed.search.slice(0, 80) : "";
    const bundleOnly = parsed.bundleOnly === true;
    const sort = typeof parsed.sort === "string" && parsed.sort in SORT_LABEL ? (parsed.sort as SortOption) : DEFAULT_FILTERS.sort;
    return { states, search, bundleOnly, sort };
  } catch {
    return DEFAULT_FILTERS;
  }
}

function persistFilters(filters: PersistedFilters): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(filters));
  } catch {}
}

export function StudioImageDiscoveryPanel({
  onCreateCampaignFromProducts,
  onCreateCampaignFromCategory,
}: {
  onCreateCampaignFromProducts: (productIds: number[]) => void;
  onCreateCampaignFromCategory: (categoryId: number) => void;
}) {
  const utils = trpc.useUtils();
  const initialFilters = useMemo(() => loadPersistedFilters(), []);
  const [selectedStates, setSelectedStates] = useState<Health[]>(initialFilters.states);
  const [search, setSearch] = useState(initialFilters.search);
  const [bundleOnly, setBundleOnly] = useState(initialFilters.bundleOnly);
  const [sort, setSort] = useState<SortOption>(initialFilters.sort);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [expandedHint, setExpandedHint] = useState<Health | null>(null);
  const [multiSelectMode, setMultiSelectMode] = useState<boolean>(false);
  const [bulkAssigneeId, setBulkAssigneeId] = useState<string>("");

  // Pagination state
  const [page, setPage] = useState(1);
  const pageSize = 50;

  // Instant Campaign Launcher Modal state
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [launcherScope, setLauncherScope] = useState<"HIGH_VALUE" | "CURRENT_FILTER" | "SELECTED_ROWS">("HIGH_VALUE");

  useEffect(() => {
    persistFilters({ states: selectedStates, search, bundleOnly, sort });
  }, [selectedStates, search, bundleOnly, sort]);

  // Reset page when filters change
  const handleStateChange = (newStates: Health[]) => {
    setSelectedStates(newStates);
    setPage(1);
  };

  const handleSearchChange = (newSearch: string) => {
    setSearch(newSearch);
    setPage(1);
  };

  const handleBundleToggle = () => {
    setBundleOnly((prev) => !prev);
    setPage(1);
  };

  const handleSortChange = (newSort: SortOption) => {
    setSort(newSort);
    setPage(1);
  };

  const counts = trpc.productStudio.imageHealthCounts.useQuery(undefined, { staleTime: 60_000 });
  const topCategories = trpc.productStudio.topGapCategories.useQuery({ limit: 8 }, { staleTime: 120_000 });
  const assignees = trpc.productStudio.assignees.useQuery(undefined, { staleTime: 120_000 });

  const bulkAssignMutation = trpc.productStudio.bulkAssign.useMutation({
    onSuccess: async (res) => {
      notify.ok(`تم إسناد ${res.createdCount} منتج بنجاح`);
      setSelectedIds(new Set());
      setBulkAssigneeId("");
      await Promise.all([
        utils.productStudio.imageHealthCounts.invalidate(),
        utils.productStudio.discoverImageGaps.invalidate(),
        utils.productStudio.tasks.invalidate(),
      ]);
    },
    onError: (err) => {
      notify.err(err);
    },
  });

  const handleCardClick = (state: Health) => {
    if (multiSelectMode) {
      handleStateChange(selectedStates.includes(state) ? selectedStates.filter((s) => s !== state) : [...selectedStates, state]);
    } else {
      if (selectedStates.length === 1 && selectedStates[0] === state) {
        handleStateChange(DEFAULT_FILTERS.states);
      } else {
        handleStateChange([state]);
      }
    }
  };

  const gaps = trpc.productStudio.discoverImageGaps.useQuery(
    {
      states: selectedStates.length > 0 ? selectedStates : undefined,
      isBundle: bundleOnly || undefined,
      search: search.trim() || undefined,
      limit: pageSize,
      cursor: (page - 1) * pageSize,
      sort,
    },
    { staleTime: 30_000, placeholderData: (prev) => prev },
  );

  const items = gaps.data?.items ?? [];
  const allShownSelected = items.length > 0 && items.every((i) => selectedIds.has(i.productId));

  const kpiCards: Array<{ label: string; value: number; state: Health; icon: React.ReactNode }> = useMemo(() => {
    const c = counts.data?.counts;
    if (!c) return [];
    return [
      { label: STATE_LABEL.HIGH_VALUE_NO_IMAGE, value: c.HIGH_VALUE_NO_IMAGE, state: "HIGH_VALUE_NO_IMAGE", icon: <TrendingDown aria-hidden className="size-4 text-destructive" /> },
      { label: STATE_LABEL.CONSIGNMENT_NO_IMAGE, value: c.CONSIGNMENT_NO_IMAGE, state: "CONSIGNMENT_NO_IMAGE", icon: <Package aria-hidden className="size-4" /> },
      { label: STATE_LABEL.HAS_IMAGE_NO_BARCODE, value: c.HAS_IMAGE_NO_BARCODE, state: "HAS_IMAGE_NO_BARCODE", icon: <ImageOff aria-hidden className="size-4 text-destructive" /> },
      { label: STATE_LABEL.CORRUPTED_OR_UNPROCESSED_IMAGE, value: c.CORRUPTED_OR_UNPROCESSED_IMAGE, state: "CORRUPTED_OR_UNPROCESSED_IMAGE", icon: <ImageOff aria-hidden className="size-4" /> },
      { label: STATE_LABEL.REDUNDANT_VARIANT_IMAGE, value: c.REDUNDANT_VARIANT_IMAGE, state: "REDUNDANT_VARIANT_IMAGE", icon: <Layers aria-hidden className="size-4" /> },
      { label: STATE_LABEL.NO_IMAGES, value: c.NO_IMAGES, state: "NO_IMAGES", icon: <ImageOff aria-hidden className="size-4" /> },
      { label: STATE_LABEL.BUNDLE_NO_IMAGE, value: c.BUNDLE_NO_IMAGE, state: "BUNDLE_NO_IMAGE", icon: <Package aria-hidden className="size-4" /> },
      { label: STATE_LABEL.SINGLE_IMAGE, value: c.SINGLE_IMAGE, state: "SINGLE_IMAGE", icon: <TrendingDown aria-hidden className="size-4" /> },
      { label: STATE_LABEL.PARENT_ONLY_HAS_VARIANTS, value: c.PARENT_ONLY_HAS_VARIANTS, state: "PARENT_ONLY_HAS_VARIANTS", icon: <Layers aria-hidden className="size-4" /> },
      { label: STATE_LABEL.VARIANTS_INCOMPLETE, value: c.VARIANTS_INCOMPLETE, state: "VARIANTS_INCOMPLETE", icon: <Layers aria-hidden className="size-4" /> },
      { label: STATE_LABEL.HEALTHY, value: c.HEALTHY, state: "HEALTHY", icon: <CheckCircle2 aria-hidden className="size-4" /> },
    ];
  }, [counts.data]);

  const highValueCount = counts.data?.counts.HIGH_VALUE_NO_IMAGE ?? 0;
  const noImagesCount = counts.data?.counts.NO_IMAGES ?? 0;

  return (
    <>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm text-muted-foreground">
            <Sparkles aria-hidden className="size-4" /> كشف فجوات الصور — منظومة الرصد والتدخل السريع
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* رادار التدخل السريع البطل — إطلاق فوري لحملة تغطي كامل الفجوة */}
          {counts.data && (highValueCount > 0 || noImagesCount > 0) && (
            <div className="relative overflow-hidden rounded-lg border-2 border-primary/40 bg-gradient-to-l from-primary/10 via-primary/5 to-background p-4 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <Badge variant="danger" className="animate-pulse px-2 py-0.5 text-xs font-bold">
                      رادار الفجوات الحرجة
                    </Badge>
                    <span className="text-sm font-semibold">
                      {highValueCount > 0
                        ? `${highValueCount} منتج ذو أولوية بلا صور بحاجة لتدخل فوري`
                        : `${noImagesCount} منتج بلا صور`}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    يمكنك تحويل كامل هذه الفجوة إلى حملة تصوير نشطة وتوزيعها بالتساوي على المصورين فوراً دون إدخال يدوي.
                  </p>
                </div>

                <Button
                  type="button"
                  size="default"
                  className="gap-2 bg-primary font-bold shadow-md hover:bg-primary/90 min-h-11"
                  onClick={() => {
                    setLauncherScope(highValueCount > 0 ? "HIGH_VALUE" : "CURRENT_FILTER");
                    setLauncherOpen(true);
                  }}
                >
                  <Zap className="size-4" />
                  إطلاق حملة تصوير فورية لكامل الفجوة (
                  {highValueCount > 0 ? highValueCount : noImagesCount} منتج)
                </Button>
              </div>
            </div>
          )}

          {counts.data && (
            <div className="rounded-md border bg-muted/20 p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  <strong>{counts.data.total}</strong> منتج نشط · <strong>{counts.data.healthyPercent}%</strong> سليم
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant={multiSelectMode ? "secondary" : "ghost"}
                    size="sm"
                    className="h-8 text-xs"
                    onClick={() => setMultiSelectMode((v) => !v)}
                    title="التبديل بين العزل الفردي والنقر المتعدد"
                  >
                    {multiSelectMode ? "نمط: تحديد متعدّد" : "نمط: عزل فرديّ (سريع)"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => handleStateChange(DEFAULT_FILTERS.states)}
                    title="استعادة الفجوات الشائعة"
                  >
                    عرض الفجوات الشائعة
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* عدّادات KPI — نقرةٌ على البطاقة تعزل الحالة */}
          <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {kpiCards.map((k) => {
              const active = selectedStates.includes(k.state);
              const isSoleActive = selectedStates.length === 1 && selectedStates[0] === k.state;
              const expanded = expandedHint === k.state;
              return (
                <div
                  key={k.state}
                  className={`relative rounded-md border p-2 transition-all ${
                    isSoleActive
                      ? "border-primary bg-primary/10 ring-2 ring-primary shadow-sm"
                      : active
                      ? "border-primary/70 bg-primary/5 ring-1 ring-primary/40"
                      : "hover:bg-muted/50 border-border"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => handleCardClick(k.state)}
                    className="block w-full min-h-11 text-start"
                    aria-pressed={active}
                  >
                    <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      {k.icon} <span className="min-w-0 truncate">{k.label}</span>
                      <span
                        role="button"
                        tabIndex={0}
                        aria-label={expanded ? "إخفاء الشرح" : "شرح هذه الحالة"}
                        aria-expanded={expanded}
                        onClick={(e) => { e.stopPropagation(); setExpandedHint(expanded ? null : k.state); }}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); setExpandedHint(expanded ? null : k.state); } }}
                        className="ms-auto flex size-5 shrink-0 items-center justify-center rounded-full hover:bg-muted focus:bg-muted focus:outline-none focus:ring-2 focus:ring-primary"
                      >
                        <Info aria-hidden className="size-3 opacity-70" />
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-baseline justify-between gap-1">
                      <span className="text-base font-bold">{k.value}</span>
                      {isSoleActive && (
                        <Badge variant="default" className="h-4 px-1 text-[9px]">معزول</Badge>
                      )}
                    </div>
                  </button>
                  {expanded && (
                    <p className="mt-1.5 rounded bg-muted/40 p-1.5 text-[10.5px] leading-snug text-muted-foreground">
                      {STATE_TOOLTIP[k.state]}
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          {/* «أعلى الفئات فيها فجوات» */}
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
                الرقم = مجموع حالات النقص في الفئة. النقر يفتح منشئ الحملة على هذه الفئة.
              </p>
            </div>
          )}

          {/* فلاترُ البحث والفرز */}
          <div className="grid gap-3 md:grid-cols-4">
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="discovery-search">بحث باسم المنتج</Label>
              <UnifiedSearchInput
                id="discovery-search"
                value={search}
                onChange={handleSearchChange}
                placeholder="اكتب جزءاً من الاسم أو SKU أو امسح الباركود… (F2)"
                debounceMs={250}
                barcode={true}
                size="default"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="discovery-bundle">تصفية</Label>
              <Button
                id="discovery-bundle"
                type="button"
                variant={bundleOnly ? "default" : "outline"}
                className="min-h-11 w-full"
                onClick={handleBundleToggle}
              >
                <Package aria-hidden className="size-4" /> البكج فقط{bundleOnly ? " (مفعَّل)" : ""}
              </Button>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="discovery-sort" className="flex items-center gap-1">
                <ArrowUpDown aria-hidden className="size-3" /> فرز
              </Label>
              <AppSelect
                id="discovery-sort"
                className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={sort}
                onValueChange={(v) => handleSortChange(v as SortOption)}
              >
                {(Object.keys(SORT_LABEL) as SortOption[]).map((k) => (
                  <option key={k} value={k}>{SORT_LABEL[k]}</option>
                ))}
              </AppSelect>
            </div>
          </div>

          {/* شريط الإجراءات — يظهر عند التحديد */}
          {selectedIds.size > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-primary/5 p-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">
                  <strong>{selectedIds.size}</strong> منتج مُحدَّد
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2 text-xs"
                  onClick={() => setSelectedIds(new Set())}
                >
                  إلغاء التحديد
                </Button>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {/* إسنادٌ مباشر لمصوّر */}
                <div className="flex items-center gap-1.5">
                  <div className="min-w-44">
                    <AppSelect
                      id="discovery-bulk-assignee"
                      className="h-9 w-full rounded-md border border-input bg-background px-3 text-xs"
                      value={bulkAssigneeId}
                      onValueChange={setBulkAssigneeId}
                      disabled={bulkAssignMutation.isPending}
                    >
                      <option value="">اختر موظفاً للإسناد المباشر…</option>
                      {(assignees.data ?? []).map((u: any) => (
                        <option key={u.id} value={String(u.id)}>
                          {u.name}
                        </option>
                      ))}
                    </AppSelect>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    className="min-h-9"
                    disabled={!bulkAssigneeId || bulkAssignMutation.isPending}
                    onClick={() => {
                      const ids = Array.from(selectedIds).slice(0, 100);
                      bulkAssignMutation.mutate({
                        productIds: ids,
                        assigneeId: Number(bulkAssigneeId),
                      });
                    }}
                  >
                    <UserCheck aria-hidden className="size-3.5" />
                    {bulkAssignMutation.isPending ? "جارٍ الإسناد…" : "إسناد مباشر"}
                  </Button>
                </div>

                <div className="h-6 w-px bg-border" />

                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  className="min-h-9 gap-1"
                  onClick={() => {
                    setLauncherScope("SELECTED_ROWS");
                    setLauncherOpen(true);
                  }}
                >
                  <Zap aria-hidden className="size-3.5" /> إطلاق حملة وتوزيع المحدَّد
                </Button>

                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="min-h-9"
                  onClick={() => {
                    const ids = Array.from(selectedIds);
                    onCreateCampaignFromProducts(ids);
                  }}
                >
                  <Sparkles aria-hidden className="size-3.5" /> فتح في منشئ الحملة
                </Button>
              </div>
            </div>
          )}

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
                {allShownSelected ? "إلغاء تحديد المعروض" : `تحديد كل المعروض في الصفحة (${items.length})`}
              </button>
              <span>{gaps.isFetching ? "جارٍ البحث…" : `${items.length} منتج في الصفحة`}</span>
            </div>

            {/* شريط التحديد الشامل للمنظومة */}
            {allShownSelected && items.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/60 p-2.5 text-xs">
                <span>
                  تم تحديد كافة الـ <strong>{items.length}</strong> منتجاً المعروضة في هذه الصفحة.
                </span>
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-xs font-bold text-primary underline"
                  onClick={() => {
                    setLauncherScope("CURRENT_FILTER");
                    setLauncherOpen(true);
                  }}
                >
                  إطلاق حملة وتوزيع لكافة المنتجات المطابقة للتصفية عبر المنظومة فوراً
                </Button>
              </div>
            )}

            {gaps.isLoading && <p className="py-6 text-center text-sm text-muted-foreground">جارٍ التحميل…</p>}
            {gaps.isError && (
              <p role="alert" className="text-sm text-destructive">
                تعذّر جلب النتائج — {gaps.error?.message ?? "خطأ غير متوقّع"}
              </p>
            )}

            {!gaps.isLoading && !gaps.isError && items.length === 0 && (
              <div className="space-y-2 py-6 text-center text-sm text-muted-foreground">
                {bundleOnly ? (
                  <>
                    <p>لا بكجات مطابقة لحالاتك المختارة.</p>
                    <p className="text-xs">
                      البكج بصورةٍ واحدة يُصنَّف «صورةٌ واحدة» — فعِّل حالاتٍ إضافيةً أعلاه أو أطفئ «البكج فقط» لرؤية كلّ الكتالوج.
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="min-h-11"
                      onClick={() => handleStateChange(["NO_IMAGES", "BUNDLE_NO_IMAGE", "SINGLE_IMAGE", "PARENT_ONLY_HAS_VARIANTS", "VARIANTS_INCOMPLETE", "HEALTHY"])}
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
                          <span className="flex min-w-0 flex-1 items-center gap-2">
                            <span className="min-w-0 truncate text-sm font-medium">{item.name}</span>
                            {item.isBundle && (
                              <span className="inline-flex shrink-0 items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-400" title="بكج مركَّب من مكوّناتٍ متعدّدة">
                                <Package aria-hidden className="size-3" /> بكج
                              </span>
                            )}
                          </span>
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
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {/* أدوات التحكم بالصفحات Pagination */}
            {items.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-xs text-muted-foreground">
                <div>
                  صفحة <strong>{page}</strong> (عرض {((page - 1) * pageSize) + 1} إلى {((page - 1) * pageSize) + items.length})
                </div>
                <div className="flex items-center gap-1.5">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1 px-2.5 text-xs"
                    disabled={page <= 1}
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
                    disabled={items.length < pageSize}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    التالي
                    <ChevronLeft className="size-3.5" />
                  </Button>
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* نافذة الإطلاق الفوري للحملة وتوزيع المهام */}
      <StudioInstantCampaignLauncher
        open={launcherOpen}
        onOpenChange={setLauncherOpen}
        defaultScope={launcherScope}
        selectedRowIds={Array.from(selectedIds)}
        activeFilterStates={selectedStates}
        counts={counts.data?.counts}
        onSuccess={() => {
          setSelectedIds(new Set());
        }}
      />
    </>
  );
}
