/**
 * BannerManager — لوحة البنرات الإعلانية المبسّطة ومركز التصميم الذكي المدمج (تبويب «البنرات»).
 *
 * تشمل:
 * - مساحة عمل موحّدة بدون نوافذ متداخلة لتصميم بنرات مفردة أو حملات متعددة الشرائح.
 * - أزرار ترتيب أولوية الظهور بنقرة واحدة (↑ ↓) وتفعيل/إيقاف فوري.
 * - كشف آلي للبنرات المرتبطة بعروض متوقفة أو منتهية الصلاحية (محجوبة تلقائياً عن الزبائن).
 */

import { useEffect, useMemo, useState } from "react";
import { useLocation, useSearch } from "wouter";
import {
  ArrowDown,
  ArrowUp,
  Eye,
  ImagePlus,
  Loader2,
  MousePointerClick,
  Palette,
  Pencil,
  Power,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { confirm } from "@/lib/confirm";
import { fmtInt } from "@/lib/money";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  BannerStudioComposer,
  type BannerPlacementOption,
  type BannerSavePayload,
  type EditableBannerRecord,
} from "@/components/store/BannerStudioComposer";

const PLACEMENT_BADGE: Record<BannerPlacementOption, string> = {
  HERO: "رئيسي — أعلى المتجر",
  INLINE: "فاصل — بين المنتجات",
  SIDE: "جانبي محوّل",
};

export default function BannerManager() {
  const [loc, navigate] = useLocation();
  const search = useSearch();
  const [composerOpen, setComposerOpen] = useState(false);
  const [editingBanner, setEditingBanner] = useState<EditableBannerRecord | null>(null);
  const [initialPromoId, setInitialPromoId] = useState<number | null>(null);

  const utils = trpc.useUtils();
  const listQ = trpc.storeAdmin.banners.list.useQuery();
  const metricsQ = trpc.storeAdmin.banners.metrics.useQuery({ days: 30 });

  const metricsByBanner = useMemo(() => {
    const map = new Map<number, { impressions: number; clicks: number; ctr: number }>();
    for (const row of metricsQ.data?.byBanner ?? []) {
      map.set(row.bannerId, row);
    }
    return map;
  }, [metricsQ.data]);

  useEffect(() => {
    const params = new URLSearchParams(search);
    const promoParam = Number(params.get("studioPromo"));
    if (Number.isInteger(promoParam) && promoParam > 0) {
      setEditingBanner(null);
      setInitialPromoId(promoParam);
      setComposerOpen(true);
      params.delete("studioPromo");
      const qs = params.toString();
      const basePath = loc.split("?")[0] || "/store-admin";
      navigate(qs ? `${basePath}?${qs}` : basePath, { replace: true });
    }
  }, [loc, navigate, search]);

  const invalidate = () => {
    void utils.storeAdmin.banners.list.invalidate();
    void utils.storeAdmin.banners.metrics.invalidate();
  };

  const createM = trpc.storeAdmin.banners.create.useMutation({
    onSuccess: () => {
      notify.ok("نُشر البنر في المتجر بنجاح");
      setComposerOpen(false);
      setEditingBanner(null);
      setInitialPromoId(null);
      invalidate();
    },
    onError: (e) => notify.err(e),
  });

  const updateM = trpc.storeAdmin.banners.update.useMutation({
    onSuccess: () => {
      notify.ok("حُفظت تعديلات البنر");
      setComposerOpen(false);
      setEditingBanner(null);
      setInitialPromoId(null);
      invalidate();
    },
    onError: (e) => notify.err(e),
  });

  const removeM = trpc.storeAdmin.banners.remove.useMutation({
    onSuccess: () => {
      notify.ok("حُذف البنر");
      invalidate();
    },
    onError: (e) => notify.err(e),
  });

  function handleSave(payload: BannerSavePayload) {
    if (payload.id != null) {
      updateM.mutate({ ...payload, id: payload.id });
    } else {
      const { id: _unused, ...createInput } = payload;
      createM.mutate(createInput);
    }
  }

  function handleQuickReorder(index: number, delta: -1 | 1) {
    const list = listQ.data ?? [];
    const target = list[index];
    const neighbor = list[index + delta];
    if (!target || !neighbor) return;
    const targetOrder = target.sortOrder ?? 0;
    const neighborOrder = neighbor.sortOrder ?? 0;
    const nextOrder =
      targetOrder === neighborOrder ? neighborOrder + delta : neighborOrder;
    updateM.mutate({ id: target.id, sortOrder: nextOrder });
  }

  async function handleDelete(id: number, title: string) {
    const ok = await confirm({ title: "حذف البنر؟", description: title });
    if (ok) removeM.mutate({ id });
  }

  const banners = listQ.data ?? [];
  const saving = createM.isPending || updateM.isPending;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold">البنرات الإعلانية واستوديو الإخراج الاحترافي</h2>
          <p className="text-xs text-muted-foreground">
            اختر منتجاً متوفراً أو قسماً أو عرضاً لإخراج بنره الإعلاني بهوية المتجر المعتمدة لمقاسَي سطح المكتب والهاتف.
          </p>
        </div>
        {!composerOpen && (
          <Button
            type="button"
            onClick={() => {
              setEditingBanner(null);
              setInitialPromoId(null);
              setComposerOpen(true);
            }}
            className="gap-2 font-bold"
          >
            <Palette aria-hidden className="size-4" />
            تصميم أو إضافة بنر جديد
          </Button>
        )}
      </div>

      {metricsQ.data && metricsQ.data.totalImpressions > 0 && (
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          <Card>
            <CardContent className="flex items-center justify-between px-3.5 py-2.5 text-xs">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Eye aria-hidden className="size-4 text-primary" /> إجمالي مشاهدات البنرات (30 يوماً)
              </span>
              <span className="text-base font-bold tabular-nums">{fmtInt(metricsQ.data.totalImpressions)}</span>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center justify-between px-3.5 py-2.5 text-xs">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <MousePointerClick aria-hidden className="size-4 text-primary" /> النقرات ومعدل التفاعل CTR
              </span>
              <span className="text-base font-bold tabular-nums">
                {fmtInt(metricsQ.data.totalClicks)} ({(metricsQ.data.overallCtr * 100).toFixed(1)}%)
              </span>
            </CardContent>
          </Card>
        </div>
      )}

      {composerOpen && (
        <BannerStudioComposer
          key={editingBanner ? `edit-${editingBanner.id}` : `new-${initialPromoId ?? 0}`}
          editingBanner={editingBanner}
          initialPromoId={initialPromoId}
          saving={saving}
          onCancel={() => {
            setComposerOpen(false);
            setEditingBanner(null);
            setInitialPromoId(null);
          }}
          onSubmit={handleSave}
        />
      )}

      {listQ.isLoading ? (
        <div className="flex justify-center py-14 text-muted-foreground">
          <Loader2 aria-hidden className="size-6 animate-spin" />
        </div>
      ) : banners.length === 0 ? (
        <Card>
          <CardContent className="py-14 text-center text-sm text-muted-foreground">
            لا توجد بنرات منشورة حالياً — اضغط «تصميم أو إضافة بنر جديد» للبدء في ثوانٍ.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {banners.map((b, idx) => {
            const stat = metricsByBanner.get(b.id);
            const slideCount = Array.isArray(b.images) && b.images.length > 0 ? b.images.length : 1;
            const missingTarget = Boolean(b.isActive && !b.ctaUrl);
            const placementKey = (b.placement as BannerPlacementOption) ?? "HERO";
            return (
              <Card key={b.id} className="overflow-hidden">
                <CardContent className="space-y-2.5 p-3">
                  <div className="relative aspect-[2.5/1] w-full overflow-hidden rounded-xl border border-border bg-muted/40">
                    {b.imageUrl ? (
                      <img src={b.imageUrl} alt={b.title} className="size-full object-cover" />
                    ) : (
                      <div className="flex size-full items-center justify-center text-muted-foreground">
                        <ImagePlus aria-hidden className="size-7 opacity-40" />
                      </div>
                    )}
                    <div className="absolute right-2 top-2 flex flex-wrap gap-1">
                      <span className="rounded-full bg-background/90 px-2.5 py-0.5 text-[10px] font-bold text-foreground shadow-xs">
                        {PLACEMENT_BADGE[placementKey] ?? PLACEMENT_BADGE.HERO}
                      </span>
                      {slideCount > 1 && (
                        <span className="rounded-full bg-background/90 px-2 py-0.5 text-[10px] font-bold text-muted-foreground shadow-xs">
                          {slideCount} شرائح
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <p className="truncate text-sm font-bold">{b.title}</p>
                      {!b.isActive && (
                        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-bold text-muted-foreground">
                          متوقف
                        </span>
                      )}
                      {b.linkedPromoInactive && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-[var(--sem-warn-bg)] px-2 py-0.5 text-[10px] font-bold text-[var(--sem-warn)]">
                          <TriangleAlert aria-hidden className="size-2.5" /> محجوب لانتهاء العرض
                        </span>
                      )}
                      {missingTarget && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-[var(--sem-warn-bg)] px-2 py-0.5 text-[10px] font-bold text-[var(--sem-warn)]">
                          <TriangleAlert aria-hidden className="size-2.5" /> بلا رابط وجهة
                        </span>
                      )}
                    </div>
                    {b.subtitle && <p className="mt-0.5 truncate text-xs text-muted-foreground">{b.subtitle}</p>}
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2 text-[11px] text-muted-foreground">
                    <div className="flex flex-wrap items-center gap-2">
                      {stat ? (
                        <span className="font-semibold text-foreground tabular-nums">
                          {fmtInt(stat.impressions)} مشاهدة · {fmtInt(stat.clicks)} نقرة ({(stat.ctr * 100).toFixed(1)}%)
                        </span>
                      ) : (
                        <span>جاهز لتتبّع المشاهدات والنقرات</span>
                      )}
                      {b.ctaUrl && <code dir="ltr" className="text-[10px] opacity-80">{b.ctaUrl}</code>}
                    </div>

                    <div className="flex items-center gap-1">
                      {banners.length > 1 && (
                        <>
                          <button
                            type="button"
                            onClick={() => handleQuickReorder(idx, -1)}
                            disabled={idx === 0 || updateM.isPending}
                            title="تقديم البنر في الظهور"
                            aria-label="تقديم البنر"
                            className="rounded-lg border border-border p-1 text-muted-foreground hover:bg-accent disabled:opacity-35"
                          >
                            <ArrowUp aria-hidden className="size-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleQuickReorder(idx, 1)}
                            disabled={idx === banners.length - 1 || updateM.isPending}
                            title="تأخير البنر في الظهور"
                            aria-label="تأخير البنر"
                            className="rounded-lg border border-border p-1 text-muted-foreground hover:bg-accent disabled:opacity-35"
                          >
                            <ArrowDown aria-hidden className="size-3" />
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        onClick={() => updateM.mutate({ id: b.id, isActive: !b.isActive })}
                        disabled={updateM.isPending}
                        className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs font-semibold transition ${
                          b.isActive
                            ? "border-[var(--sem-pos)]/35 bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]"
                            : "border-border bg-muted/40 text-muted-foreground hover:bg-accent"
                        }`}
                      >
                        <Power aria-hidden className="size-3" />
                        {b.isActive ? "مفعّل" : "تفعيل"}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingBanner(b);
                          setInitialPromoId(null);
                          setComposerOpen(true);
                        }}
                        className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs font-medium text-foreground hover:bg-accent"
                      >
                        <Pencil aria-hidden className="size-3" /> تعديل
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(b.id, b.title)}
                        className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-[var(--sem-neg)] hover:bg-[var(--sem-neg-bg)]"
                      >
                        <Trash2 aria-hidden className="size-3" /> حذف
                      </button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
