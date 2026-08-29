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
import { AppSelect } from "@/components/ui/AppSelect";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { notify } from "@/lib/notify";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ArrowUpDown, CheckCircle2, ImageOff, Info, Layers, Package, Search, Sparkles, TrendingDown } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

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

/**
 * تلميحاتٌ توضيحية لبطاقات KPI — يعرض المدير الجديدُ معنى كل حالة ومسار إصلاحها فوراً
 * بلا فتح توثيقٍ خارجيّ. يُقرأ عبر السمة `title` على البطاقة (تعطيه المتصفح كتلميح hover)
 * بالإضافة إلى إمكانية عرضه في وضع تفصيليّ لاحقاً.
 */
const STATE_TOOLTIP: Record<Health, string> = {
  NO_IMAGES: "منتجٌ نشط بلا أيّ صورةٍ معتمَدة — أنشئ حملة تصوير أو ارفع صورةً محلياً.",
  BUNDLE_NO_IMAGE: "بكجٌ (منتجٌ مركَّب) بلا صورة موحَّدة — يمكن رفعُ صورةٍ خاصّةٍ به أو التركيب من صور مكوّناته لاحقاً.",
  // Codex P2: `healthCaseSql()` يُصنّف حالة SINGLE_IMAGE قبل التحقّق من صور البدائل،
  // فالمنتج ذو صورةٍ واحدة وبدائلَ غير مُغطّاة يظهر هنا. النصّ الأوّل «أضف زوايا إن استحقّ»
  // كان يوهم أنّ العمل اختياريّ، بينما قد يكون مطلوباً لكلّ بديلٍ منفصل. النصّ المصحَّح
  // يذكر كلا المسارَين ويوجّه المدير للتحقّق من عمود «بدائل بصور».
  SINGLE_IMAGE: "منتجٌ بصورةٍ معتمَدةٍ واحدة — قد تكون كافية للأمّ، لكن تحقّق من عمود «بدائل بصور» أدناه: إن كان أحد البدائل بلا صورةٍ خاصّةٍ به فأنشئ حملةً بديلاً-بديلاً.",
  PARENT_ONLY_HAS_VARIANTS: "الأمّ لها صورة لكنّ بعض البدائل بلا صورةٍ خاصّة — أنشئ حملةً بديلاً-بديلاً.",
  VARIANTS_INCOMPLETE: "أحد بدائل هذا المنتج ينقصه صورةٌ خاصّة — أنشئ حملةً تشمله.",
  HEALTHY: "المنتج مكتمل صوراً بحسب توجيه الحملة الحاليّ. لا فعلَ مطلوب.",
};

/** خيارات فرز جدول الفجوات. القيمة الافتراضية «الأقلّ صوراً» تُبرز الأحوج للعمل. */
type SortOption = "MISSING_MOST" | "NAME_ASC" | "APPROVED_ASC" | "VARIANTS_MISSING_MOST";
const SORT_LABEL: Record<SortOption, string> = {
  MISSING_MOST: "الأحوج (بدائل ناقصة أولاً)",
  APPROVED_ASC: "الأقلّ صوراً معتمَدة",
  NAME_ASC: "الاسم أ ↔ ي",
  VARIANTS_MISSING_MOST: "الأكثر بدائلَ بلا صور",
};

/**
 * مفتاحُ التخزين المحلّي لحفظ فلاتر الكاشف. النسخة (v1) تسمح بترقيةٍ لاحقة إن غيّرنا
 * شكلَ الحالة (إضافة/إزالة حقول) بلا كسرِ مستخدم يحمل شكلاً قديماً — نعيد الافتراضيّ
 * بصمت. المفتاح خاصٌّ بالكاشف؛ لا نلوّث namespace التطبيق.
 */
const STORAGE_KEY = "studio.discovery.filters.v1";
type PersistedFilters = { states: Health[]; search: string; bundleOnly: boolean; sort: SortOption };
const DEFAULT_FILTERS: PersistedFilters = {
  states: ["NO_IMAGES", "BUNDLE_NO_IMAGE"],
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
    // تحقّقٌ ضيّق: مصدرٌ خارجيّ (localStorage) قد يحمل شكلاً غير صحيح — نرفض بلا كسر.
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
  } catch {
    // Storage قد يكون معطَّلاً (Private mode/Safari) — تخطٍّ صامت (النقطة ليست حاسمة).
  }
}

export function StudioImageDiscoveryPanel({
  onCreateCampaignFromProducts,
  onCreateCampaignFromCategory,
}: {
  onCreateCampaignFromProducts: (productIds: number[]) => void;
  onCreateCampaignFromCategory: (categoryId: number) => void;
}) {
  // فلاتر مُحمَّلةٌ من التخزين المحلّي مرّةً واحدةً عند التركيب (`useState(loader)` يُحسَب مرّة).
  // بدون هذا كان المدير يُعيد ضبط الفلاتر كل زيارة، ما يُضيّع الوقت على مسحٍ يوميّ للحالة نفسها.
  const initialFilters = useMemo(() => loadPersistedFilters(), []);
  const [selectedStates, setSelectedStates] = useState<Health[]>(initialFilters.states);
  const [search, setSearch] = useState(initialFilters.search);
  const [bundleOnly, setBundleOnly] = useState(initialFilters.bundleOnly);
  const [sort, setSort] = useState<SortOption>(initialFilters.sort);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  // شرحُ بطاقة KPI الموسَّع — بطاقةٌ واحدةٌ في كلّ وقت تكفي وتمنع تراكمَ شروحٍ داخل الشبكة.
  const [expandedHint, setExpandedHint] = useState<Health | null>(null);
  // أثرُ الحفظ: يُطلَق كلّما تغيّر أيٌّ من الفلاتر. `selectedIds` **لا يُحفَظ** — التحديد
  // مرتبطٌ بالجلسة الحاليّة، وإعادةُ فتح المتصفح لاحقاً لا تعني نفس نيّة العمل.
  useEffect(() => {
    persistFilters({ states: selectedStates, search, bundleOnly, sort });
  }, [selectedStates, search, bundleOnly, sort]);

  const counts = trpc.productStudio.imageHealthCounts.useQuery(undefined, { staleTime: 60_000 });
  const topCategories = trpc.productStudio.topGapCategories.useQuery({ limit: 8 }, { staleTime: 120_000 });
  // الفرز يُرسَل إلى الخادم كي يُطبَّق قبل التقطيع (Codex P2): الفرز على الواجهة كان
  // يمسّ ١٠٠ صفٍّ فقط، فيُقصّ الأولويّ إن كان معرّفه فوق النطاق.
  const gaps = trpc.productStudio.discoverImageGaps.useQuery(
    {
      states: selectedStates.length > 0 ? selectedStates : undefined,
      isBundle: bundleOnly || undefined,
      search: search.trim() || undefined,
      limit: 100,
      sort,
    },
    { staleTime: 30_000, placeholderData: (prev) => prev },
  );

  // الفرز يقع على الخادم قبل التقطيع (Codex P2 على PR #865) — نستهلك الترتيب كما يعود.
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

        {/* عدّادات KPI — نقرةٌ على البطاقة تُبدّل الفلتر، والـInfo زرٌّ مستقلّ داخل البطاقة
            يفتح/يُغلق شرحاً منظوراً (Codex P2 — الاعتماد على `title` وحده يعطّل الشرح على
            اللمس). الشرحُ داخل نفس البطاقة كي لا يُبعِد البصر. e.stopPropagation ضروريّ
            كي لا يوسّع أو يوسّع الفلتر بالخطأ عند طلب الشرح. */}
        <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {kpiCards.map((k) => {
            const active = selectedStates.includes(k.state);
            const expanded = expandedHint === k.state;
            return (
              <div key={k.state} className={`rounded-md border p-2 transition-colors ${active ? "border-primary bg-primary/5" : "hover:bg-muted/50"}`}>
                <button
                  type="button"
                  onClick={() => setSelectedStates((cur) => (active ? cur.filter((s) => s !== k.state) : [...cur, k.state]))}
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
                  <div className="mt-0.5 text-base font-bold">{k.value}</div>
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

        {/* فلاترُ البحث والفرز — تُحفَظ في localStorage عند التغيير وتُستعاد عند فتح الشاشة
            لاحقاً كي لا يُعيد المدير ضبطها كلّ زيارة (مسحٌ يوميّ للحالة نفسها). */}
        <div className="grid gap-3 md:grid-cols-4">
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
          <div className="space-y-1.5">
            <Label htmlFor="discovery-sort" className="flex items-center gap-1">
              <ArrowUpDown aria-hidden className="size-3" /> فرز
            </Label>
            {/* AppSelect (Radix Portal) بدل select عاريّ (Codex P2) — بعض بيئات Chromium
                تقصّ الـpopup الأصيل داخل الحاويات المُدارة، والـPortal يحلّ ذلك مع دعم RTL
                وthemeing الموحَّد. */}
            <AppSelect
              id="discovery-sort"
              className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={sort}
              onValueChange={(v) => setSort(v as SortOption)}
            >
              {(Object.keys(SORT_LABEL) as SortOption[]).map((k) => (
                <option key={k} value={k}>{SORT_LABEL[k]}</option>
              ))}
            </AppSelect>
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
          {gaps.isError && (
            <p role="alert" className="text-sm text-destructive">
              تعذّر جلب النتائج — {gaps.error?.message ?? "خطأ غير متوقّع"}
            </p>
          )}
          {/* الرسالة الفارغة تُعرَض فقط عند غياب الخطأ (بلاغ المالك ٢٩/٨: كانت رسالة الخطأ
              ورسالة «لا نتائج» تظهران معاً فتُوهم الخطأَ نتيجةً فارغة). ورسالةٌ خاصّة بحالة
              «البكج فقط» تُوجّه المستخدم لتوسيع الحالات: البكج بصورةٍ واحدة أو أكثر يُصنَّف
              SINGLE_IMAGE/HEALTHY وليس BUNDLE_NO_IMAGE، ومن ثمّ لا يظهر إن كانت الفلاتر
              الافتراضية مُختارةً وحدها. */}
          {!gaps.isLoading && !gaps.isError && items.length === 0 && (
            <div className="space-y-2 py-6 text-center text-sm text-muted-foreground">
              {bundleOnly ? (
                <>
                  <p>لا بكجات مطابقة لحالاتك المختارة.</p>
                  <p className="text-xs">
                    البكج بصورةٍ واحدة يُصنَّف «صورةٌ واحدة» (لا «بكج بلا صورة») — فعِّل حالاتٍ إضافيةً أعلاه أو أطفئ «البكج فقط» لرؤية كلّ الكتالوج.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="min-h-11"
                    onClick={() => setSelectedStates(["NO_IMAGES", "BUNDLE_NO_IMAGE", "SINGLE_IMAGE", "PARENT_ONLY_HAS_VARIANTS", "VARIANTS_INCOMPLETE", "HEALTHY"])}
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
        </div>
      </CardContent>
    </Card>
  );
}
