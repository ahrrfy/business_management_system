// client/src/pages/Offers.tsx
// RBAC: مدير+ فقط (campaignsManagerProcedure / campaignsReadProcedure).
import { Download, FileEdit, Plus, RotateCcw, Copy, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import { PageHeader } from "@/components/PageHeader";
import { AppSelect } from "@/components/ui/AppSelect";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { confirm } from "@/lib/confirm";
import { trpc } from "@/lib/trpc";
import { canSeeGate } from "@/lib/navVisibility";
import { D, fmtAr, formatIqd } from "@/lib/money";
import { ACTION_LABELS } from "@shared/actionLabels";
import { formatPromotionSummary } from "@shared/promotionEngine";
import { exportRows } from "@/lib/export";
import {
  CHANNEL_LABELS,
  APPLICATION_LABELS,
  PROMO_TYPE_LABELS,
  todayYmd,
  toYmd,
  type OfferRow,
} from "@/components/offers/offersTypes";
import { OfferKpiSummary } from "@/components/offers/OfferKpiSummary";
import { OfferForm } from "@/components/offers/OfferForm";

// Strict marketing wing static contracts preserved verbatim:
type ValidityFilter = "ALL" | "CURRENT" | "SCHEDULED" | "EXPIRED";
type ChannelFilter = "ALL" | "SHARED" | "POS_ONLY" | "STORE_ONLY";

function resolveOfferChannel(p: { channel?: string | null; isStoreManaged?: boolean | null }): "ALL" | "POS_ONLY" | "STORE_ONLY" {
  if (p.channel === "POS_ONLY" || p.channel === "STORE_ONLY") return p.channel;
  return p.isStoreManaged ? "STORE_ONLY" : "ALL";
}

function offerActivationState(offer: { isActive: boolean; effectiveFrom: unknown; effectiveTo: unknown }, today: string) {
  if (!offer.isActive) return { label: "متوقف", className: "bg-muted text-muted-foreground border-border", note: "غير مفعّل" };
  const startsOn = toYmd(offer.effectiveFrom);
  const endsOn = offer.effectiveTo ? toYmd(offer.effectiveTo) : "";
  if (startsOn > today) return { label: "يبدأ قريباً", className: "bg-[var(--sem-info-bg)] text-[var(--sem-info)] border-[var(--sem-info)]/30", note: `يبدأ ${startsOn}` };
  if (endsOn && endsOn < today) return { label: "منتهي", className: "bg-[var(--sem-neg-bg)] text-[var(--sem-neg)] border-[var(--sem-neg)]/30", note: `انتهى يوم ${endsOn}` };
  if (endsOn && endsOn === today) return { label: "ينتهي اليوم", className: "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)] border-[var(--sem-warn)]/30", note: "آخر يوم للعرض" };
  return { label: "فعّال الآن", className: "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)] border-[var(--sem-pos)]/30", note: "شغّال بالبيع" };
}

export default function Offers() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const canManage = canSeeGate(
    { roles: ["manager"], module: "campaigns", level: "FULL" },
    me.data?.role,
    (me.data?.permissionsOverride ?? null) as any
  );

  const [includeInactive, setIncludeInactive] = useState(false);
  const listQ = trpc.salesPromotions.list.useQuery({ includeInactive });
  const performanceQ = trpc.salesPromotions.performance.useQuery();
  const campaignsQ = trpc.crm.campaigns.list.useQuery();
  const campaignById = useMemo(() => new Map((campaignsQ.data ?? []).map((c) => [c.id, c])), [campaignsQ.data]);

  const [channelFilter, setChannelFilter] = useState<ChannelFilter>("ALL");
  const [validityFilter, setValidityFilter] = useState<ValidityFilter>("ALL");
  const [searchQuery, setSearchQuery] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const today = todayYmd();

  const deactivateM = trpc.salesPromotions.deactivate.useMutation({ onSuccess: async () => { await utils.salesPromotions.list.invalidate(); } });
  const reactivateM = trpc.salesPromotions.reactivate.useMutation({ onSuccess: async () => { await utils.salesPromotions.list.invalidate(); } });
  const duplicateM = trpc.salesPromotions.duplicate.useMutation({ onSuccess: async () => { await utils.salesPromotions.list.invalidate(); } });

  const performanceById = useMemo(
    () => new Map((performanceQ.data?.rows ?? []).map((row) => [row.promotionId, row])),
    [performanceQ.data?.rows]
  );

  const operationalSignals = useMemo(() => {
    const rows = listQ.data ?? [];
    const activeNow = rows.filter((p) => p.isActive && toYmd(p.effectiveFrom) <= today && (!p.effectiveTo || toYmd(p.effectiveTo) >= today));
    const scheduled = rows.filter((p) => p.isActive && toYmd(p.effectiveFrom) > today);
    const expiredActive = rows.filter((p) => p.isActive && p.effectiveTo && toYmd(p.effectiveTo) < today);
    const unusedActive = activeNow.filter((p) => (performanceById.get(p.id)?.invoiceCount ?? 0) === 0);
    const negative = rows.filter((p) => D(performanceById.get(p.id)?.grossProfit).isNegative());
    return { activeNow, scheduled, expiredActive, unusedActive, negative };
  }, [listQ.data, performanceById, today]);

  const list = useMemo(() => {
    const needle = searchQuery.trim().toLocaleLowerCase("ar");
    return (listQ.data ?? []).filter((p: any) => {
      if (needle && !String(p.name ?? "").toLocaleLowerCase("ar").includes(needle) && !String(p.description ?? "").toLocaleLowerCase("ar").includes(needle)) return false;
      if (channelFilter !== "ALL") {
        const ch = resolveOfferChannel(p);
        if (channelFilter === "SHARED" ? ch !== "ALL" : ch !== channelFilter) return false;
      }
      if (validityFilter !== "ALL") {
        const from = toYmd(p.effectiveFrom);
        const to = p.effectiveTo ? toYmd(p.effectiveTo) : null;
        const scheduled = from > today;
        const expired = to != null && to < today;
        if (validityFilter === "SCHEDULED" && (!p.isActive || !scheduled)) return false;
        if (validityFilter === "EXPIRED" && !expired) return false;
        if (validityFilter === "CURRENT" && (!p.isActive || scheduled || expired)) return false;
      }
      return true;
    });
  }, [listQ.data, channelFilter, validityFilter, searchQuery, today]);

  const marginOf = (promotionId: number): string | null => {
    const performance = performanceById.get(promotionId);
    if (D(performance?.netSales).isZero()) return null;
    return D(performance?.grossProfit).div(performance?.netSales ?? 1).times(100).toDecimalPlaces(1).toString();
  };

  const handleExport = (format: "xlsx" | "csv") => {
    exportRows(list, {
      filename: `العروض_والتخفيضات_${today}`,
      format,
      title: "سجل العروض والتخفيضات",
      columns: [
        { key: "name", header: "اسم العرض" },
        { key: "type", header: "نوع الخصم", map: (r: any) => `${PROMO_TYPE_LABELS[r.type as keyof typeof PROMO_TYPE_LABELS] ?? r.type} (${formatPromotionSummary(r)})` },
        { key: "scope", header: "النطاق", map: (r: any) => (r.scope === "ALL" ? "جميع المنتجات" : r.scope === "CATEGORIES" ? "فئات محددة" : "منتجات محددة") },
        { key: "channel", header: "القناة", map: (r: any) => CHANNEL_LABELS[resolveOfferChannel(r)] },
        { key: "applicationMode", header: "طريقة التطبيق", map: (r: any) => (r.applicationMode === "COUPON" ? "بكوبون" : "تلقائي") },
        { key: "effectiveFrom", header: "سارٍ من", map: (r: any) => toYmd(r.effectiveFrom) },
        { key: "effectiveTo", header: "سارٍ إلى", map: (r: any) => (r.effectiveTo ? toYmd(r.effectiveTo) : "مستمر") },
        { key: "status", header: "الحالة", map: (r: any) => offerActivationState(r, today).label },
        { key: "invoiceCount", header: "الفواتير المرتبطة", map: (r: any) => performanceById.get(r.id)?.invoiceCount ?? 0 },
        { key: "netSales", header: "المبيعات المرتبطة", money: true, map: (r: any) => D(performanceById.get(r.id)?.netSales ?? "0").toNumber() },
        { key: "margin", header: "الهامش", map: (r: any) => (marginOf(r.id) != null ? `${marginOf(r.id)}٪` : "—") },
      ],
    });
  };

  async function doDeactivate(p: any) {
    const ok = await confirm({
      variant: "warning",
      title: "تعطيل العرض",
      description: `سيتوقّف تطبيق «${p.name}» على مبيعات جديدة فوراً. يمكن إعادة تفعيله لاحقاً.`,
      confirmText: "تعطيل",
    });
    if (!ok) return;
    deactivateM.mutate({ promotionId: Number(p.id) });
  }

  const offerActionsColumn: ColumnDef<OfferRow, unknown> = {
    id: "actions",
    header: "إجراء",
    meta: { kind: "actions", width: "wide" },
    cell: ({ row }) => {
      const p = row.original;
      return (
        <div className="flex items-center justify-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => { setEditingId(Number(p.id)); setShowForm(true); }}>
            <FileEdit aria-hidden className="size-3.5" /> تعديل
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              const res = await duplicateM.mutateAsync({ promotionId: Number(p.id) });
              setIncludeInactive(true);
              await utils.salesPromotions.list.invalidate();
              setEditingId(res.promotionId);
              setShowForm(true);
            }}
            disabled={duplicateM.isPending}
            title={duplicateM.isPending ? ACTION_LABELS.saving : "تكرار العرض لإنشاء مسودة مطابقة"}
          >
            <Copy aria-hidden className="size-3.5" /> تكرار
          </Button>
          {p.isActive ? (
            <Button size="sm" variant="ghost" onClick={() => doDeactivate(p)} disabled={deactivateM.isPending}>
              تعطيل
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => reactivateM.mutate({ promotionId: Number(p.id) })} disabled={reactivateM.isPending}>
              <RotateCcw aria-hidden className="size-3.5" /> تفعيل
            </Button>
          )}
        </div>
      );
    },
  };

  const columns = useMemo<ColumnDef<OfferRow, unknown>[]>(() => [
    {
      id: "name",
      header: "الاسم",
      accessorFn: (p) => p.name,
      meta: { width: "wide" },
      cell: ({ row }) => <div><div className="font-medium">{row.original.name}</div><div className="text-xs text-muted-foreground">أولوية {row.original.priority}</div></div>,
    },
    {
      id: "type",
      header: "النوع",
      accessorFn: (p) => PROMO_TYPE_LABELS[p.type as keyof typeof PROMO_TYPE_LABELS] ?? p.type,
      cell: ({ row }) => PROMO_TYPE_LABELS[row.original.type as keyof typeof PROMO_TYPE_LABELS] ?? row.original.type,
    },
    {
      id: "value",
      header: "قيمة العرض",
      accessorFn: (p) => formatPromotionSummary(p as any),
      cell: ({ row }) => formatPromotionSummary(row.original as any),
    },
    {
      id: "scope",
      header: "النطاق",
      accessorFn: (p) => (p.scope === "ALL" ? "الكل" : p.scope === "CATEGORIES" ? "فئات" : "منتجات"),
      cell: ({ row }) => <div><div>{row.original.scope === "ALL" ? "الكل" : row.original.scope === "CATEGORIES" ? "فئات" : "منتجات"}</div><div className="text-xs text-muted-foreground">{row.original.scope === "ALL" ? "كل المنتجات المؤهلة" : "أهداف محفوظة"}</div></div>,
    },
    {
      id: "campaign",
      header: "الحملة",
      accessorFn: (p) => (p.campaignId == null ? "عرض مستقل" : campaignById.get(Number(p.campaignId))?.name ?? "حملة مرتبطة"),
      cell: ({ row }) => <span className="text-xs">{row.original.campaignId == null ? "عرض مستقل" : campaignById.get(Number(row.original.campaignId))?.name ?? "حملة مرتبطة"}</span>,
    },
    {
      id: "channel",
      header: "القناة",
      accessorFn: (p) => CHANNEL_LABELS[resolveOfferChannel(p)],
      cell: ({ row }) => <span className="text-xs">{CHANNEL_LABELS[resolveOfferChannel(row.original)]}</span>,
    },
    {
      id: "applicationMode",
      header: "التطبيق",
      accessorFn: (p) => APPLICATION_LABELS[p.applicationMode as keyof typeof APPLICATION_LABELS] ?? p.applicationMode,
      cell: ({ row }) => <span className="text-xs">{APPLICATION_LABELS[row.original.applicationMode as keyof typeof APPLICATION_LABELS] ?? row.original.applicationMode}</span>,
    },
    {
      id: "period",
      header: "من — إلى",
      accessorFn: (p) => `${toYmd(p.effectiveFrom)} — ${p.effectiveTo ? toYmd(p.effectiveTo) : "مستمرّ"}`,
      meta: { kind: "date", width: "wide" },
      cell: ({ row }) => <span className="text-xs text-muted-foreground">{toYmd(row.original.effectiveFrom)} — {row.original.effectiveTo ? toYmd(row.original.effectiveTo) : "مستمرّ"}</span>,
    },
    {
      id: "invoiceCount",
      header: "الفواتير",
      accessorFn: (p) => performanceById.get(p.id)?.invoiceCount ?? 0,
      meta: { kind: "number" },
      cell: ({ row }) => performanceById.get(row.original.id)?.invoiceCount ?? 0,
    },
    {
      id: "netSales",
      header: "المبيعات",
      accessorFn: (p) => formatIqd(performanceById.get(p.id)?.netSales ?? "0"),
      meta: { kind: "money" },
      cell: ({ row }) => formatIqd(performanceById.get(row.original.id)?.netSales ?? "0"),
    },
    {
      id: "discount",
      header: "خصم محقق",
      accessorFn: (p) => formatIqd(performanceById.get(p.id)?.discount ?? "0"),
      meta: { kind: "money" },
      cell: ({ row }) => formatIqd(performanceById.get(row.original.id)?.discount ?? "0"),
    },
    {
      id: "grossProfit",
      header: "الربح",
      accessorFn: (p) => formatIqd(performanceById.get(p.id)?.grossProfit ?? "0"),
      meta: { kind: "money" },
      cell: ({ row }) => {
        const val = performanceById.get(row.original.id)?.grossProfit;
        return <span className={D(val).isNegative() ? "text-destructive" : undefined}>{formatIqd(val ?? "0")}</span>;
      },
    },
    {
      id: "margin",
      header: "الهامش",
      accessorFn: (p) => marginOf(p.id) ?? "—",
      meta: { kind: "number" },
      cell: ({ row }) => {
        const m = marginOf(row.original.id);
        return <span className={m != null && D(m).isNegative() ? "text-destructive" : undefined}>{m != null ? `${m}٪` : "—"}</span>;
      },
    },
    {
      id: "status",
      header: "الحالة",
      accessorFn: (p) => offerActivationState(p, today).label,
      meta: { kind: "status" },
      cell: ({ row }) => {
        const state = offerActivationState(row.original, today);
        return <div><Badge variant="outline" className={state.className}>{state.label}</Badge><div className="mt-1 text-xs text-muted-foreground">{state.note}</div></div>;
      },
    },
    ...(canManage ? [offerActionsColumn] : []),
  ], [performanceById, canManage, deactivateM.isPending, reactivateM.isPending, duplicateM.isPending, campaignById, today]);

  return (
    <div className="max-w-7xl mx-auto space-y-4 pb-8">
      <PageHeader
        title="العروض والتخفيضات"
        description="إدارة عروض وتخفيضات المحل والمتجر الإلكتروني والكوبونات والتوصيل المجاني من مكان واحد."
        actions={
          canManage ? (
            <Button onClick={() => { if (showForm) { setShowForm(false); setEditingId(null); } else { setEditingId(null); setShowForm(true); } }}>
              {showForm ? <><X aria-hidden className="size-4" /> إلغاء</> : <><Plus aria-hidden className="size-4" /> عرض جديد</>}
            </Button>
          ) : undefined
        }
      />

      <OfferKpiSummary summary={performanceQ.data?.summary} signals={operationalSignals} />

      {showForm && (
        <OfferForm
          editingId={editingId}
          onSuccess={async () => {
            await utils.salesPromotions.list.invalidate();
            await utils.salesPromotions.performance.invalidate();
            setShowForm(false);
            setEditingId(null);
          }}
          onDuplicated={async (newPromotionId) => {
            setIncludeInactive(true);
            await utils.salesPromotions.list.invalidate();
            setEditingId(newPromotionId);
            setShowForm(true);
          }}
          onCancel={() => { setShowForm(false); setEditingId(null); }}
        />
      )}

      <Card>
        <CardHeader className="flex items-center justify-between flex-row">
          <CardTitle className="text-base">العروض ({list.length})</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <UnifiedSearchInput
              debounceMs={0}
              className="w-48"
              inputClassName="h-8"
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder="بحث بالاسم…"
              barcode={false}
            />
            <AppSelect value={channelFilter} onValueChange={(v) => setChannelFilter(v as ChannelFilter)} className="h-8 w-44" size="sm">
              <option value="ALL">كل القنوات</option>
              <option value="SHARED">مشترك (نقطة البيع والمتجر)</option>
              <option value="POS_ONLY">نقطة البيع فقط</option>
              <option value="STORE_ONLY">المتجر الإلكتروني فقط</option>
            </AppSelect>
            <AppSelect value={validityFilter} onValueChange={(v) => setValidityFilter(v as ValidityFilter)} className="h-8 w-36" size="sm">
              <option value="ALL">كل الحالات</option>
              <option value="CURRENT">ساري الآن</option>
              <option value="SCHEDULED">يبدأ لاحقاً</option>
              <option value="EXPIRED">منتهٍ تاريخياً</option>
            </AppSelect>
            <label className="text-xs text-muted-foreground flex items-center gap-2">
              <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
              تضمين المعطَّلة
            </label>
            <div className="flex items-center gap-1.5">
              <Button size="sm" variant="outline" onClick={() => handleExport("xlsx")} className="gap-1.5 h-8">
                <Download aria-hidden className="size-3.5" /> Excel
              </Button>
              <Button size="sm" variant="outline" onClick={() => handleExport("csv")} className="gap-1.5 h-8">
                <Download aria-hidden className="size-3.5" /> CSV
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <DataTable<OfferRow>
            columns={columns}
            data={list}
            searchable={false}
            externalFiltersActive={searchQuery.trim() !== "" || channelFilter !== "ALL" || validityFilter !== "ALL"}
            loading={listQ.isLoading}
            errorState={{ isError: listQ.isError, message: listQ.error?.message, onRetry: () => void listQ.refetch() }}
            emptyText="لا عروض مطابقة للفلاتر."
          />
        </CardContent>
      </Card>
    </div>
  );
}
