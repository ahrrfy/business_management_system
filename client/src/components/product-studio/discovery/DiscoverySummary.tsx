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
import { useMemo } from "react";
import {
  CheckCircle2,
  ImageOff,
  Info,
  Layers,
  Package,
  TrendingDown,
  Zap,
} from "lucide-react";
export function DiscoverySummary({ model }: { model: DiscoveryModel }) {
  const {
    counts,
    topCategories,
    selectedStates,
    multiSelectMode,
    setMultiSelectMode,
    handleStateChange,
    handleCardClick,
    expandedHint,
    setExpandedHint,
    setLauncherScope,
    setLauncherOpen,
    onCreateCampaignFromCategory,
  } = model;
  const kpiCards: Array<{
    label: string;
    value: number;
    state: Health;
    icon: React.ReactNode;
  }> = useMemo(() => {
    const c = counts.data?.counts;
    if (!c) return [];
    return [
      {
        label: STATE_LABEL.HIGH_VALUE_NO_IMAGE,
        value: c.HIGH_VALUE_NO_IMAGE,
        state: "HIGH_VALUE_NO_IMAGE",
        icon: <TrendingDown aria-hidden className="size-4 text-destructive" />,
      },
      {
        label: STATE_LABEL.CONSIGNMENT_NO_IMAGE,
        value: c.CONSIGNMENT_NO_IMAGE,
        state: "CONSIGNMENT_NO_IMAGE",
        icon: <Package aria-hidden className="size-4" />,
      },
      {
        label: STATE_LABEL.HAS_IMAGE_NO_BARCODE,
        value: c.HAS_IMAGE_NO_BARCODE,
        state: "HAS_IMAGE_NO_BARCODE",
        icon: <ImageOff aria-hidden className="size-4 text-destructive" />,
      },
      {
        label: STATE_LABEL.CORRUPTED_OR_UNPROCESSED_IMAGE,
        value: c.CORRUPTED_OR_UNPROCESSED_IMAGE,
        state: "CORRUPTED_OR_UNPROCESSED_IMAGE",
        icon: <ImageOff aria-hidden className="size-4" />,
      },
      {
        label: STATE_LABEL.REDUNDANT_VARIANT_IMAGE,
        value: c.REDUNDANT_VARIANT_IMAGE,
        state: "REDUNDANT_VARIANT_IMAGE",
        icon: <Layers aria-hidden className="size-4" />,
      },
      {
        label: STATE_LABEL.NO_IMAGES,
        value: c.NO_IMAGES,
        state: "NO_IMAGES",
        icon: <ImageOff aria-hidden className="size-4" />,
      },
      {
        label: STATE_LABEL.BUNDLE_NO_IMAGE,
        value: c.BUNDLE_NO_IMAGE,
        state: "BUNDLE_NO_IMAGE",
        icon: <Package aria-hidden className="size-4" />,
      },
      {
        label: STATE_LABEL.SINGLE_IMAGE,
        value: c.SINGLE_IMAGE,
        state: "SINGLE_IMAGE",
        icon: <TrendingDown aria-hidden className="size-4" />,
      },
      {
        label: STATE_LABEL.PARENT_ONLY_HAS_VARIANTS,
        value: c.PARENT_ONLY_HAS_VARIANTS,
        state: "PARENT_ONLY_HAS_VARIANTS",
        icon: <Layers aria-hidden className="size-4" />,
      },
      {
        label: STATE_LABEL.VARIANTS_INCOMPLETE,
        value: c.VARIANTS_INCOMPLETE,
        state: "VARIANTS_INCOMPLETE",
        icon: <Layers aria-hidden className="size-4" />,
      },
      {
        label: STATE_LABEL.HEALTHY,
        value: c.HEALTHY,
        state: "HEALTHY",
        icon: <CheckCircle2 aria-hidden className="size-4" />,
      },
    ];
  }, [counts.data]);

  const highValueCount = counts.data?.counts.HIGH_VALUE_NO_IMAGE ?? 0;
  const noImagesCount = counts.data?.counts.NO_IMAGES ?? 0;
  return (
    <>
      {/* رادار التدخل السريع البطل — إطلاق فوري لحملة تغطي كامل الفجوة */}
      {counts.data && (highValueCount > 0 || noImagesCount > 0) && (
        <div className="rounded-md border bg-muted/20 p-3">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Badge
                  variant="danger"
                  className="px-2 py-0.5 text-xs font-bold"
                >
                  رادار الفجوات الحرجة
                </Badge>
                <span className="text-sm font-semibold">
                  {highValueCount > 0
                    ? `${highValueCount} منتج ذو أولوية بلا صور بحاجة لتدخل فوري`
                    : `${noImagesCount} منتج بلا صور`}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                يمكنك تحويل كامل هذه الفجوة إلى حملة تصوير نشطة وتوزيعها
                بالتساوي على المصورين فوراً دون إدخال يدوي.
              </p>
            </div>

            <Button
              type="button"
              size="default"
              className="h-auto min-h-11 max-w-full whitespace-normal gap-2 bg-primary font-bold hover:bg-primary/90"
              onClick={() => {
                setLauncherScope(
                  highValueCount > 0 ? "HIGH_VALUE" : "NO_IMAGES",
                );
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
              <strong>{counts.data.total}</strong> منتج نشط ·{" "}
              <strong>{counts.data.healthyPercent}%</strong> سليم
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
                {multiSelectMode
                  ? "نمط: تحديد متعدّد"
                  : "نمط: عزل فرديّ (سريع)"}
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
          const isSoleActive =
            selectedStates.length === 1 && selectedStates[0] === k.state;
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
                className="block w-full min-h-11 pe-6 text-start"
                aria-pressed={active}
              >
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  {k.icon}{" "}
                  <span className="min-w-0 break-words">{k.label}</span>
                </div>
                <div className="mt-0.5 flex items-baseline justify-between gap-1">
                  <span className="text-base font-bold">{k.value}</span>
                  {isSoleActive && (
                    <Badge variant="default" className="h-4 px-1 text-[9px]">
                      معزول
                    </Badge>
                  )}
                </div>
              </button>
              <button
                type="button"
                aria-label={expanded ? "إخفاء الشرح" : "شرح هذه الحالة"}
                aria-expanded={expanded}
                onClick={(e) => {
                  e.stopPropagation();
                  setExpandedHint(expanded ? null : k.state);
                }}
                className="absolute end-1 top-1 flex size-6 shrink-0 items-center justify-center rounded-full hover:bg-muted focus:bg-muted focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <Info aria-hidden className="size-3 opacity-70" />
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
          <p className="text-xs font-medium text-muted-foreground">
            أعلى الفئات فيها فجوات صور
          </p>
          <div className="flex flex-wrap gap-2">
            {(topCategories.data ?? []).slice(0, 8).map((c) => (
              <Button
                key={c.categoryId ?? -1}
                type="button"
                variant="outline"
                size="sm"
                className="h-auto min-h-11 max-w-full whitespace-normal"
                onClick={() =>
                  c.categoryId && onCreateCampaignFromCategory(c.categoryId)
                }
                disabled={c.categoryId == null}
                title="افتح منشئ الحملة على هذه الفئة"
              >
                {c.categoryName}
                <Badge variant="warning" className="ms-1">
                  {c.gapTotal}
                </Badge>
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            الرقم = مجموع حالات النقص في الفئة. النقر يفتح منشئ الحملة على هذه
            الفئة.
          </p>
        </div>
      )}
    </>
  );
}
