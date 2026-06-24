import { BranchBalanceCard } from "@/components/treasury/BranchBalanceCard";
import { BranchComparisonChart } from "@/components/treasury/BranchComparisonChart";
import { CashFlowChart } from "@/components/treasury/CashFlowChart";
import { OpenShiftsPanel } from "@/components/treasury/OpenShiftsPanel";
import { PaymentMethodDonut } from "@/components/treasury/PaymentMethodDonut";
import { TreasuryKpiCard } from "@/components/treasury/TreasuryKpiCard";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/DataTable";
import { fmtAr } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import { type ColumnDef } from "@tanstack/react-table";
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Building2,
  Layers,
  Receipt as ReceiptIcon,
  RefreshCcw,
  Vault,
  Wallet,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "wouter";

type Period = "today" | "yesterday" | "week" | "month";

const PERIOD_AR: Record<Period, string> = {
  today: "اليوم",
  yesterday: "أمس",
  week: "آخر ٧ أيام",
  month: "آخر ٣٠ يوماً",
};

const selectCls =
  "h-8 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const fmtDT = (d: string | number | Date | null | undefined) =>
  d ? new Date(d).toLocaleString("ar-IQ-u-nu-latn", { dateStyle: "short", timeStyle: "short" }) : "—";

const fmtRelativeShort = (iso: string) => {
  const then = new Date(iso).getTime();
  const diff = Math.max(0, Date.now() - then);
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "للتوّ";
  if (m < 60) return `منذ ${m.toLocaleString("ar-IQ-u-nu-latn")} د`;
  const h = Math.floor(m / 60);
  if (h < 24) return `منذ ${h.toLocaleString("ar-IQ-u-nu-latn")} س`;
  return fmtDT(iso);
};

interface MovementRow {
  id: string;
  source: "RECEIPT" | "EXPENSE";
  direction: "IN" | "OUT";
  amount: string;
  paymentMethod: string;
  paymentMethodLabel: string;
  cashBucket: "DRAWER" | "TREASURY" | null;
  branchId: number | null;
  branchName: string | null;
  description: string | null;
  voucherNumber: string | null;
  createdAt: string;
}

export default function Treasury() {
  const [branchId, setBranchId] = useState<number | "">("");
  const [period, setPeriod] = useState<Period>("today");

  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const branches = trpc.branches.list.useQuery();
  const dashboard = trpc.treasury.getDashboard.useQuery(
    { branchId: branchId ? Number(branchId) : undefined },
    { refetchInterval: 30_000 },
  );
  const trends = trpc.treasury.getKpiTrends.useQuery(
    { branchId: branchId ? Number(branchId) : undefined },
    { staleTime: 60_000 },
  );
  const cashFlow = trpc.treasury.getCashFlowSeries.useQuery(
    { days: 30, branchId: branchId ? Number(branchId) : undefined },
    { staleTime: 5 * 60_000 },
  );
  const breakdown = trpc.treasury.getPaymentMethodBreakdown.useQuery(
    { period, branchId: branchId ? Number(branchId) : undefined },
    { staleTime: 5 * 60_000 },
  );
  const movements = trpc.treasury.getRecentMovements.useQuery(
    { limit: 20, branchId: branchId ? Number(branchId) : undefined },
    { refetchInterval: 30_000 },
  );
  const openShifts = trpc.treasury.getOpenShifts.useQuery(
    { branchId: branchId ? Number(branchId) : undefined },
    { refetchInterval: 30_000 },
  );

  const userRole = me.data?.role ?? "";
  const isAdmin = userRole === "admin";
  const isManager = userRole === "manager";
  const canChooseBranch = isAdmin || isManager;
  const hideTreasury = dashboard.data?.hideTreasury ?? false;

  const refreshAll = () => {
    void utils.treasury.getDashboard.invalidate();
    void utils.treasury.getKpiTrends.invalidate();
    void utils.treasury.getCashFlowSeries.invalidate();
    void utils.treasury.getPaymentMethodBreakdown.invalidate();
    void utils.treasury.getRecentMovements.invalidate();
    void utils.treasury.getOpenShifts.invalidate();
  };

  const movementCols: ColumnDef<MovementRow>[] = useMemo(
    () => [
      {
        header: "الاتجاه",
        accessorKey: "direction",
        cell: ({ row }) => (
          <span
            className={
              row.original.direction === "IN"
                ? "inline-flex items-center gap-1 text-money-positive"
                : "inline-flex items-center gap-1 text-money-negative"
            }
          >
            {row.original.direction === "IN" ? (
              <ArrowDownLeft className="h-3.5 w-3.5" />
            ) : (
              <ArrowUpRight className="h-3.5 w-3.5" />
            )}
            {row.original.direction === "IN" ? "وارد" : "صادر"}
          </span>
        ),
      },
      {
        header: "المبلغ",
        accessorKey: "amount",
        cell: ({ row }) => (
          <span className="tabular-nums font-medium" dir="ltr">
            {fmtAr(row.original.amount)}
          </span>
        ),
      },
      { header: "الطريقة", accessorKey: "paymentMethodLabel" },
      {
        header: "الدلو",
        accessorKey: "cashBucket",
        cell: ({ row }) =>
          row.original.cashBucket ? (
            <span
              className={
                row.original.cashBucket === "DRAWER"
                  ? "text-[11px] badge-status-active rounded px-1.5 py-0.5"
                  : "text-[11px] badge-status-done rounded px-1.5 py-0.5"
              }
            >
              {row.original.cashBucket === "DRAWER" ? "درج" : "خزينة"}
            </span>
          ) : (
            <span className="text-muted-foreground text-xs">—</span>
          ),
      },
      { header: "الفرع", accessorKey: "branchName", cell: ({ row }) => row.original.branchName ?? "—" },
      {
        header: "الوصف",
        accessorKey: "description",
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground line-clamp-1">
            {row.original.voucherNumber ? `${row.original.voucherNumber} — ` : ""}
            {row.original.description ?? "—"}
          </span>
        ),
      },
      {
        header: "الوقت",
        accessorKey: "createdAt",
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground tabular-nums" dir="ltr">
            {fmtRelativeShort(row.original.createdAt)}
          </span>
        ),
      },
    ],
    [],
  );

  const totalDrawerAll = useMemo(
    () => dashboard.data?.drawerBalances.reduce((s, r) => s + Number(r.expectedCash), 0) ?? 0,
    [dashboard.data],
  );
  const totalTreasuryAll = useMemo(
    () => dashboard.data?.treasuryBalances.reduce((s, r) => s + Number(r.balance), 0) ?? 0,
    [dashboard.data],
  );

  const comparisonRows = useMemo(() => {
    if (!dashboard.data) return [];
    const t = new Map<number, number>();
    for (const r of dashboard.data.treasuryBalances) t.set(r.branchId, Number(r.balance));
    return dashboard.data.drawerBalances.map((r) => ({
      branchId: r.branchId,
      branchName: r.branchName,
      drawer: Number(r.expectedCash),
      treasury: t.get(r.branchId) ?? 0,
    }));
  }, [dashboard.data]);

  return (
    <div className="space-y-4 max-w-[1400px] mx-auto" dir="rtl">
      {/* ═══ Header / Toolbar ═══ */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
            <Vault className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-bold leading-tight">لوحة الخزينة</h1>
            <div className="text-[11px] text-muted-foreground flex items-center gap-1.5">
              {dashboard.data?.generatedAt && (
                <span className="tabular-nums" dir="ltr">
                  آخر تحديث: {fmtRelativeShort(dashboard.data.generatedAt)}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="mr-auto flex flex-wrap items-center gap-2">
          {canChooseBranch && (branches.data?.length ?? 0) > 1 && (
            <select
              className={selectCls}
              value={branchId}
              onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : "")}
            >
              <option value="">كل الفروع</option>
              {branches.data?.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          )}
          <select className={selectCls} value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
            {(["today", "yesterday", "week", "month"] as const).map((p) => (
              <option key={p} value={p}>
                {PERIOD_AR[p]}
              </option>
            ))}
          </select>
          <Button size="sm" variant="outline" onClick={refreshAll} title="تحديث">
            <RefreshCcw className="h-3.5 w-3.5 me-1" />
            تحديث
          </Button>
        </div>
      </div>

      {/* ═══ شريط أزرار سريعة ═══ */}
      <div className="flex flex-wrap gap-2">
        <Link href="/vouchers/receipt/new">
          <Button size="sm" variant="default" className="gap-1.5">
            <ArrowDownLeft className="h-4 w-4" />
            سند قبض
          </Button>
        </Link>
        <Link href="/vouchers/payment/new">
          <Button size="sm" variant="outline" className="gap-1.5">
            <ArrowUpRight className="h-4 w-4" />
            سند صرف
          </Button>
        </Link>
        <Link href="/expenses/new">
          <Button size="sm" variant="outline" className="gap-1.5">
            <ReceiptIcon className="h-4 w-4" />
            مصروف يومي
          </Button>
        </Link>
        <Link href="/shifts">
          <Button size="sm" variant="ghost" className="gap-1.5">
            <Layers className="h-4 w-4" />
            الورديات
            <ArrowRight className="h-3 w-3" />
          </Button>
        </Link>
      </div>

      {/* ═══ صف ١: KPI cards ═══ */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        <TreasuryKpiCard
          icon={Wallet}
          label="النقد في الدروج"
          value={String(totalDrawerAll)}
          deltaPct={trends.data?.drawerTotal.deltaPct ?? null}
          deltaLabel="عن أمس"
          accent="green"
          loading={dashboard.isLoading || trends.isLoading}
        />
        {!hideTreasury && (
          <TreasuryKpiCard
            icon={Vault}
            label="النقد في الخزينة"
            value={String(totalTreasuryAll)}
            deltaPct={trends.data?.treasuryTotal.deltaPct ?? null}
            deltaLabel="مقابل قبل اليوم"
            accent="purple"
            loading={dashboard.isLoading || trends.isLoading}
          />
        )}
        <TreasuryKpiCard
          icon={Layers}
          label="ورديات مفتوحة"
          value={String(dashboard.data?.openShiftsCount ?? 0)}
          rawNumeric
          deltaPct={trends.data?.openShifts.deltaPct ?? null}
          deltaLabel="مقابل أمس"
          accent="blue"
          suffix="وردية"
          loading={dashboard.isLoading || trends.isLoading}
        />
        <TreasuryKpiCard
          icon={ArrowDownLeft}
          label="مقبوضات اليوم"
          value={dashboard.data?.todayReceiptsTotal ?? "0"}
          deltaPct={trends.data?.todayReceipts.deltaPct ?? null}
          deltaLabel="عن أمس"
          accent="green"
          sparkline={trends.data?.todayReceipts.sparkline}
          loading={dashboard.isLoading || trends.isLoading}
        />
        <TreasuryKpiCard
          icon={ArrowUpRight}
          label="مصروفات اليوم"
          value={dashboard.data?.todayExpensesTotal ?? "0"}
          deltaPct={trends.data?.todayExpenses.deltaPct ?? null}
          deltaLabel="عن أمس"
          accent="red"
          sparkline={trends.data?.todayExpenses.sparkline}
          loading={dashboard.isLoading || trends.isLoading}
        />
      </div>

      {/* ═══ صف ٢: المخطّط الزمني + الدونات ═══ */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="lg:col-span-2">
          <CashFlowChart data={cashFlow.data ?? []} loading={cashFlow.isLoading} />
        </div>
        <div>
          <PaymentMethodDonut data={breakdown.data ?? []} loading={breakdown.isLoading} direction="in" />
        </div>
      </div>

      {/* ═══ صف ٣: بطاقات الفروع ═══ */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {dashboard.isLoading
          ? [1, 2].map((i) => (
              <div key={i} className="rounded-md border p-5 animate-pulse">
                <div className="h-9 w-9 rounded-lg bg-muted mb-3" />
                <div className="h-3 w-32 bg-muted rounded mb-3" />
                <div className="h-16 bg-muted rounded" />
              </div>
            ))
          : (dashboard.data?.drawerBalances ?? []).map((dr) => {
              const tr = dashboard.data?.treasuryBalances.find((t) => t.branchId === dr.branchId);
              const branchType = (branches.data?.find((b) => b.id === dr.branchId)?.type ?? null) as
                | "MAIN"
                | "SALES"
                | null;
              const alerts: Array<{ severity: "warning" | "danger" | "info"; text: string }> = [];
              if (dr.openShiftsCount === 0) {
                alerts.push({ severity: "info", text: "لا ورديات مفتوحة في هذا الفرع الآن" });
              }
              if (!hideTreasury && tr && Number(tr.balance) < 0) {
                alerts.push({
                  severity: "danger",
                  text: `رصيد الخزينة سالب (${fmtAr(tr.balance)})`,
                });
              }
              return (
                <BranchBalanceCard
                  key={dr.branchId}
                  branchId={dr.branchId}
                  branchName={dr.branchName}
                  branchTypeBadge={branchType ?? undefined}
                  drawer={{
                    expected: dr.expectedCash,
                    opening: dr.totalOpening,
                    openShifts: dr.openShiftsCount,
                  }}
                  treasury={!hideTreasury && tr ? { balance: tr.balance } : null}
                  alerts={alerts}
                />
              );
            })}
      </div>

      {/* ═══ صف ٤: مقارنة الفروع ═══ */}
      {comparisonRows.length >= 2 && (
        <BranchComparisonChart
          data={comparisonRows}
          showTreasury={!hideTreasury}
          loading={dashboard.isLoading}
        />
      )}

      {/* ═══ صف ٥: جدول الحركات + الورديات ═══ */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
        <div className="lg:col-span-7 rounded-md border bg-card p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold">آخر الحركات النقدية</h3>
            <span className="text-xs text-muted-foreground">
              <Building2 className="inline h-3 w-3" />{" "}
              {branchId ? branches.data?.find((b) => b.id === branchId)?.name : "كل الفروع المرئيّة"}
            </span>
          </div>
          <DataTable
            data={movements.data ?? []}
            columns={movementCols}
            loading={movements.isLoading}
            emptyText="لا حركات بعد."
            showFilter={false}
            pageSize={20}
          />
        </div>
        <div className="lg:col-span-5">
          <OpenShiftsPanel shifts={openShifts.data ?? []} loading={openShifts.isLoading} />
        </div>
      </div>
    </div>
  );
}
