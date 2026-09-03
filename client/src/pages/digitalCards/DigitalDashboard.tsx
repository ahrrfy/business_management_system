// داشبورد البطاقات الرقمية (ش١١). كل الأرقام مُجمَّعة خادمياً على فترة **نصف مفتوحة**،
// والحصة/الربح يظهران فقط لمن يملك رؤية التكلفة (الخادم يُصفّرهما لغيره — لا إخفاء بالعرض).
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { AppSelect } from "@/components/ui/AppSelect";
import { Button } from "@/components/ui/button";
import { fmtAr } from "@/lib/money";
import { RowActions } from "@/components/list/RowActions";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { AlertTriangle, CreditCard, TrendingUp, Wallet } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";

const selectCls = "flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm";

/** يوم بصيغة YYYY-MM-DD بإزاحة أيام. */
function dayOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/** اليوم التالي (UTC تقويمياً) — يحوّل تاريخاً مُختاراً كنهايةٍ **شاملة** إلى الصيغة نصف
 *  المفتوحة [from, to) التي تتوقّعها كل نقاط هذا الداشبورد (انظر §٩.٤ أعلى الخدمة). */
function nextDayUtc(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const RANGES = [
  { key: "today", label: "اليوم" },
  { key: "week", label: "7 أيام" },
  { key: "month", label: "30 يوماً" },
  { key: "custom", label: "مدى مخصّص" },
] as const;
type RangeKey = (typeof RANGES)[number]["key"];

const MODE_LABEL: Record<string, string> = { PREPAID: "مسبق الدفع", POSTPAID: "آجل" };
const AVAIL_LABEL: Record<string, string> = {
  NO_PRICE: "لم يُنشر سعر البيع",
  STALE_PRICE: "سعر البيع يحتاج تحديثاً",
  NO_WALLET: "لم تُربط بمحفظة المزوّد",
  WALLET_MISMATCH: "المحفظة مرتبطة بمزوّد أو فرع آخر",
  WALLET_INACTIVE: "محفظة المزوّد معطّلة",
  INSUFFICIENT_BALANCE: "رصيد المزوّد لا يكفي لبيع كرت واحد",
};
const INTENT_LABEL: Record<string, string> = {
  PREPARED: "بانتظار الإصدار", EXECUTING: "يجري إصدار الكرت", EXECUTED: "صدر الكرت ولم تُنشأ الفاتورة", NEEDS_REVIEW: "تحتاج معالجة",
};

/** الخصائص المشتركة لجداول اللوحة: مُضمَّنة في بطاقةٍ تحمل عنوانَها وإجماليَّها. */
const PANEL_TABLE = { embedded: true, searchable: false, bounded: false, pageSize: Infinity } as const;

type TopColumn = ColumnDef<NonNullable<RouterOutputs["digitalCards"]["dashboard"]["topOfferings"]>[number], unknown>;
type ModeColumn = ColumnDef<NonNullable<RouterOutputs["digitalCards"]["dashboard"]["summary"]["byMode"]>[number], unknown>;

export default function DigitalDashboard() {
  const [, navigate] = useLocation();
  const me = trpc.auth.me.useQuery();
  // عزل مدير الفرع (قرار المالك ١٢/٨): المالك/الأدمن فقط يختاران فرعاً (owner مُطبَّع ⇒ admin).
  const canPickBranch = me.data?.role === "admin";
  const branches = trpc.branches.list.useQuery(undefined, { enabled: canPickBranch });

  const [range, setRange] = useState<RangeKey>("today");
  // مدى مخصّص: الحقلان يُدخَلان بمعنى «شامل» (نمط PeriodFilter) — يُحوَّل customTo إلى اليوم
  // التالي عند البناء كي يطابق الفترة نصف المفتوحة [from, to) في كل نقاط هذا الداشبورد.
  const [customFrom, setCustomFrom] = useState(() => dayOffset(-6));
  const [customTo, setCustomTo] = useState(() => dayOffset(0));
  const [branchId, setBranchId] = useState<number | "">("");

  // مدير الفرع يرى فرعه فوراً؛ لا نعرض له «كل الفروع» بينما الخادم يفرض فرعه في الخلفية.
  useEffect(() => {
    if (branchId === "" && me.data?.branchId != null) {
      setBranchId(Number(me.data.branchId));
    }
  }, [branchId, me.data?.branchId]);

  const period = useMemo(() => {
    if (range === "today") return { from: dayOffset(0), to: dayOffset(1) };
    if (range === "week") return { from: dayOffset(-6), to: dayOffset(1) };
    if (range === "month") return { from: dayOffset(-29), to: dayOffset(1) };
    return { from: customFrom, to: nextDayUtc(customTo) };
  }, [range, customFrom, customTo]);

  const branchArg = branchId
    ? Number(branchId)
    : me.data?.branchId != null
      ? Number(me.data.branchId)
      : undefined;

  const summary = trpc.digitalCards.dashboard.summary.useQuery({ ...period, branchId: branchArg });
  const balances = trpc.digitalCards.dashboard.providerBalances.useQuery({ branchId: branchArg });
  const dues = trpc.digitalCards.dashboard.postpaidDues.useQuery();
  const health = trpc.digitalCards.dashboard.priceHealth.useQuery({ branchId: branchArg });
  const pending = trpc.digitalCards.dashboard.pendingExecutions.useQuery({ branchId: branchArg });
  const top = trpc.digitalCards.dashboard.topOfferings.useQuery({ ...period, branchId: branchArg, limit: 8 });
  const recon = trpc.digitalCards.dashboard.reconciliationStatus.useQuery({ ...period, branchId: branchArg });

  const s = summary.data;
  const showCost = s?.profit != null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="جاهزية بيع البطاقات والاشتراكات"
        description="ابدأ بما يمنع البيع، ثم راقب المبيعات والأرصدة. كل بطاقة تُعدّ جاهزة فقط عندما يكون سعرها صالحاً وربط المزوّد ومحفظته ورصيده سليماً."
        actions={
          <div className="flex flex-wrap items-end gap-2">
            {canPickBranch && (
              <AppSelect
                value={String(branchId)}
                onValueChange={(v) => setBranchId(v ? Number(v) : "")}
                aria-label="الفرع"
                className="w-40"
              >
                <option value="">— كل الفروع —</option>
                {(branches.data ?? []).map((b) => (
                  <option key={b.id} value={String(b.id)}>{b.name}</option>
                ))}
              </AppSelect>
            )}
            {range === "custom" && (
              <>
                <input
                  type="date"
                  dir="ltr"
                  value={customFrom}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  className={selectCls}
                  aria-label="من تاريخ"
                />
                <input
                  type="date"
                  dir="ltr"
                  value={customTo}
                  onChange={(e) => setCustomTo(e.target.value)}
                  className={selectCls}
                  aria-label="إلى تاريخ"
                />
              </>
            )}
            <AppSelect
              value={range}
              onValueChange={(v) => setRange(v as typeof range)}
              aria-label="الفترة"
              className="w-32"
            >
              {RANGES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
            </AppSelect>
          </div>
        }
      />

      {/* بطاقات الملخّص */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="كروت مُباعة" value={String(s?.cards ?? 0)} sub={`${s?.invoices ?? 0} فاتورة`} icon={CreditCard} />
        <StatCard label="إجمالي المبيعات" value={fmtAr(s?.sales ?? "0")} icon={TrendingUp} />
        {showCost && (
          <>
            <StatCard label="تكلفة الكروت المباعة" value={fmtAr(s!.providerShare!)} />
            <StatCard label="ربح المكتبة" value={fmtAr(s!.profit!)} tone="positive" />
          </>
        )}
        {!showCost && (
          <StatCard label="أرصدة لدى المزوّدين" value={fmtAr(balances.data?.totalAsset ?? "0")} icon={Wallet} />
        )}
      </div>

      {/* تنبيهات تشغيلية */}
      {((pending.data?.needsReview ?? 0) > 0 || (health.data?.needsAttention.length ?? 0) > 0) && (
        <Card>
          <CardHeader className="flex flex-row items-center gap-2 text-sm font-medium">
            <AlertTriangle aria-hidden className="size-4" /> يحتاج تدخّلاً
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2 pb-4 text-sm">
            {(pending.data?.needsReview ?? 0) > 0 && (
              <span className="rounded-md border px-3 py-1.5">
                {pending.data?.needsReview} عملية كروت لم تكتمل — افتح «عمليات تحتاج معالجة»
              </span>
            )}
            {(health.data?.needsAttention.length ?? 0) > 0 && (
              <span className="rounded-md border px-3 py-1.5">
                {health.data?.needsAttention.length} بطاقة غير جاهزة للبيع — افتح جدول الجاهزية لمعرفة السبب والإجراء
              </span>
            )}
            {(recon.data?.open ?? 0) > 0 && (
              <span className="rounded-md border px-3 py-1.5">
                {recon.data?.open} اختلاف في رصيد جهاز يحتاج معالجة ({fmtAr(recon.data?.openVarianceTotal ?? "0")})
              </span>
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* أرصدة المحافظ */}
        <Card>
          <CardHeader className="text-sm font-medium">
            أرصدة المحافظ — الإجمالي {fmtAr(balances.data?.totalAsset ?? "0")}
          </CardHeader>
          <CardContent className="p-0">
            <DataTable
              {...PANEL_TABLE}
              data={balances.data?.wallets ?? []}
              loading={balances.isLoading}
              emptyText="لا محافظ مفعّلة."
              columns={[
                { id: "wallet", header: "حساب رصيد الجهاز", cell: ({ row }) => row.original.walletName },
                { id: "provider", header: "المزوّد", cell: ({ row }) => <span className="text-muted-foreground">{row.original.providerName}</span> },
                {
                  id: "available",
                  header: "المتاح",
                  meta: { kind: "money" },
                  cell: ({ row }) => (
                    <span className={row.original.isLow ? "text-destructive font-medium" : undefined}>{fmtAr(row.original.available)}</span>
                  ),
                },
              ]}
            />
          </CardContent>
        </Card>

        {/* ذمم المزوّدين الآجلين */}
        <Card>
          <CardHeader className="text-sm font-medium">
            مستحقّات المزوّدين الآجلين — الإجمالي {fmtAr(dues.data?.totalDue ?? "0")}
          </CardHeader>
          <CardContent className="p-0">
            <DataTable
              {...PANEL_TABLE}
              data={dues.data?.providers ?? []}
              loading={dues.isLoading}
              emptyText="لا مزوّدين آجلين."
              columns={[
                { id: "provider", header: "المزوّد", cell: ({ row }) => row.original.providerName },
                { id: "due", header: "المستحقّ", meta: { kind: "money" }, cell: ({ row }) => <span className="font-medium">{fmtAr(row.original.due)}</span> },
              ]}
            />
          </CardContent>
        </Card>
      </div>

      {/* الأكثر مبيعاً */}
      <Card>
        <CardHeader className="text-sm font-medium">الأكثر مبيعاً في الفترة</CardHeader>
        <CardContent className="p-0">
          <DataTable
            {...PANEL_TABLE}
            data={top.data ?? []}
            loading={top.isLoading}
            emptyText="لا مبيعات في هذه الفترة."
            columns={[
              { id: "offering", header: "البطاقة", cell: ({ row }) => <span className="font-medium">{row.original.offeringName}</span> },
              { id: "provider", header: "المزوّد", cell: ({ row }) => <span className="text-muted-foreground">{row.original.providerName}</span> },
              { id: "cards", header: "العدد", meta: { kind: "number" }, cell: ({ row }) => row.original.cards },
              { id: "sales", header: "المبيعات", meta: { kind: "money" }, cell: ({ row }) => fmtAr(row.original.sales) },
              // عمود الربح يتبع صلاحية رؤية الكلفة — مرآةُ الحارس نفسه في بقيّة اللوحة.
              ...(showCost
                ? [{ id: "profit", header: "الربح", meta: { kind: "money" }, cell: ({ row }) => fmtAr(row.original.profit ?? "0") } as TopColumn]
                : []),
            ]}
          />
        </CardContent>
      </Card>

      {/* الحالات المعلّقة */}
      <Card>
        <CardHeader className="text-sm font-medium">
          عمليات بيع لم تكتمل ({pending.data?.total ?? 0})
        </CardHeader>
        <CardContent className="p-0">
          <DataTable
            {...PANEL_TABLE}
            data={pending.data?.items ?? []}
            loading={pending.isLoading}
            emptyText="لا عمليات معلّقة — كل البيوع مُثبَّتة."
            getRowClassName={(p) => (p.status === "NEEDS_REVIEW" ? "bg-destructive/5" : undefined)}
            columns={[
              { id: "id", header: "رقم", meta: { kind: "number", width: "id" }, cell: ({ row }) => row.original.id },
              { id: "branch", header: "الفرع", cell: ({ row }) => <span className="text-muted-foreground">{row.original.branchName}</span> },
              { id: "status", header: "الحالة", cell: ({ row }) => INTENT_LABEL[row.original.status] ?? row.original.status },
              { id: "expected", header: "قيمة البيع", meta: { kind: "money" }, cell: ({ row }) => fmtAr(row.original.expectedTotal) },
            ]}
          />
        </CardContent>
      </Card>

      {/* جاهزية البيع + تفصيل طريقة سداد المزوّد */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="text-sm font-medium">
            جاهزية البيع — {health.data?.ready ?? 0} من {health.data?.total ?? 0} جاهزة
          </CardHeader>
          <CardContent className="p-0">
            <DataTable
              {...PANEL_TABLE}
              data={health.data?.needsAttention ?? []}
              loading={health.isLoading}
              emptyText="كل البطاقات جاهزة للبيع في النطاق المحدد."
              columns={[
                { id: "offering", header: "البطاقة", cell: ({ row }) => row.original.offeringName },
                { id: "branch", header: "الفرع", cell: ({ row }) => <span className="text-muted-foreground">{row.original.branchName}</span> },
                { id: "reason", header: "ما الذي يمنع البيع؟", meta: { wrap: true }, cell: ({ row }) => AVAIL_LABEL[row.original.availability] ?? row.original.availability },
                {
                  id: "action",
                  header: "الإجراء",
                  meta: { kind: "actions" },
                  cell: ({ row }) => {
                    const h = row.original;
                    const pricingIssue = h.availability === "NO_PRICE" || h.availability === "STALE_PRICE";
                    const balanceIssue = h.availability === "INSUFFICIENT_BALANCE" || h.availability === "WALLET_INACTIVE";
                    return (
                      <RowActions
                        mode="inline"
                        actions={[{
                          key: "fix-readiness",
                          kind: "edit",
                          label: pricingIssue ? "فتح التسعير" : balanceIssue ? "فتح رصيد المزوّد" : "إصلاح الربط",
                          gate: { module: "digital_cards", level: "READ" },
                          onSelect: () => {
                            const params = new URLSearchParams({ tab: pricingIssue ? "pricing" : balanceIssue ? "wallets" : "offerings" });
                            params.set("branchId", String(h.branchId));
                            params.set("providerId", String(h.providerId));
                            navigate(`/digital-cards?${params.toString()}`);
                          },
                        }]}
                      />
                    );
                  },
                },
              ]}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="text-sm font-medium">حسب طريقة سداد المزوّد</CardHeader>
          <CardContent className="p-0">
            <DataTable
              {...PANEL_TABLE}
              data={s?.byMode ?? []}
              loading={summary.isLoading}
              emptyText="لا مبيعات في هذه الفترة."
              columns={[
                { id: "mode", header: "طريقة السداد", cell: ({ row }) => MODE_LABEL[row.original.settlementMode] ?? row.original.settlementMode },
                { id: "cards", header: "كروت", meta: { kind: "number" }, cell: ({ row }) => row.original.cards },
                { id: "sales", header: "المبيعات", meta: { kind: "money" }, cell: ({ row }) => fmtAr(row.original.sales) },
                ...(showCost
                  ? [{ id: "profit", header: "الربح", meta: { kind: "money" }, cell: ({ row }) => fmtAr(row.original.profit ?? "0") } as ModeColumn]
                  : []),
              ]}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
