// كوكبِت القرار — قلب مركز التقارير. يجيب في ثوانٍ على أسئلة المالك الخمسة:
// أين الربح؟ (النبض) · أين النقد؟ (النبض) · أين الخطر؟ وماذا أفعل الآن؟ (لوحة الإجراءات) · من المتأخر؟ (الصدارة).
// يُركّب endpoints موجودة (profitAndLoss/financialPosition/managementAlerts/arAging/apAging) — بلا خلفية ثقيلة جديدة.
import { useMemo, useState } from "react";
import { Link } from "wouter";
import {
  AlertTriangle, ArrowLeft, CheckCircle2, TrendingUp, TrendingDown, Minus,
  Wallet, Coins, Percent, Users, Truck, ChevronLeft,
} from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { Card, CardContent } from "@/components/ui/card";
import { LoadingState } from "@/components/PageState";
import { fmtAr, formatIqd, D } from "@/lib/money";

type Period = "today" | "month" | "last30";
type Alert = RouterOutputs["reports"]["managementAlerts"]["alerts"][number];

const PERIOD_AR: Record<Period, string> = { today: "اليوم", month: "هذا الشهر", last30: "آخر ٣٠ يوماً" };
const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** نطاق الفترة + الفترة السابقة المساوية لها طولاً (للمقارنة). */
function ranges(period: Period): { from: string; to: string; cmpFrom: string; cmpTo: string } {
  const now = new Date();
  const to = new Date(now);
  let from: Date;
  if (period === "today") from = new Date(now);
  else if (period === "month") from = new Date(now.getFullYear(), now.getMonth(), 1);
  else { from = new Date(now); from.setDate(from.getDate() - 29); }
  const lenMs = to.getTime() - from.getTime();
  const cmpTo = new Date(from.getTime() - 86_400_000);
  const cmpFrom = new Date(cmpTo.getTime() - lenMs);
  return { from: ymd(from), to: ymd(to), cmpFrom: ymd(cmpFrom), cmpTo: ymd(cmpTo) };
}

/** تغيّر نسبي % decimal-safe (null إن تعذّر). */
function deltaPct(cur: string | number, prev: string | number): number | null {
  const c = D(cur), p = D(prev);
  if (p.isZero()) return c.isZero() ? 0 : null;
  return c.sub(p).div(p).times(100).toDecimalPlaces(1).toNumber();
}

function DeltaBadge({ d }: { d: number | null }) {
  if (d === null) return null;
  const Icon = d > 0 ? TrendingUp : d < 0 ? TrendingDown : Minus;
  const cls = d > 0 ? "text-money-positive" : d < 0 ? "text-money-negative" : "text-muted-foreground";
  return (
    <span className={`inline-flex items-center gap-0.5 ${cls}`} dir="ltr">
      <Icon className="size-3" aria-hidden />
      {d > 0 ? "+" : ""}{fmtAr(d)}%
    </span>
  );
}

const SEV_DOT: Record<string, string> = {
  critical: "bg-[var(--stock-out)]",
  warning: "bg-[var(--stock-low)]",
  info: "bg-[var(--status-pending)]",
};
const SEV_BORDER: Record<string, string> = {
  critical: "border-r-[var(--stock-out)]",
  warning: "border-r-[var(--stock-low)]",
  info: "border-r-[var(--status-pending)]",
};

function AlertsPanel({ alerts, loading }: { alerts: Alert[]; loading: boolean }) {
  if (loading) return <Card><CardContent className="p-6"><LoadingState /></CardContent></Card>;
  if (!alerts.length) {
    return (
      <Card>
        <CardContent className="flex items-center gap-3 p-6 text-money-positive">
          <CheckCircle2 className="size-6 shrink-0" aria-hidden />
          <div>
            <p className="font-semibold">كل المؤشّرات سليمة</p>
            <p className="text-xs text-muted-foreground">لا توجد مخاطر تحتاج إجراءً الآن.</p>
          </div>
        </CardContent>
      </Card>
    );
  }
  return (
    <div className="space-y-2">
      {alerts.map((a) => (
        <Link key={a.key} href={a.href}>
          <Card className={`cursor-pointer border-r-4 ${SEV_BORDER[a.severity] ?? ""} transition hover:bg-accent/40`}>
            <CardContent className="flex items-center gap-3 p-3">
              <span className={`size-2.5 shrink-0 rounded-full ${SEV_DOT[a.severity] ?? "bg-muted"}`} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{a.title}</p>
                <p className="text-xs text-muted-foreground">
                  <span className="tabular-nums" dir="ltr">{fmtAr(a.count)}</span>
                  {a.amount && Number(a.amount) > 0 && <> · <span className="tabular-nums" dir="ltr">{formatIqd(a.amount)}</span></>}
                </p>
              </div>
              <span className="inline-flex shrink-0 items-center gap-1 rounded-md border px-2.5 py-1 text-xs text-muted-foreground">
                {a.actionLabel}
                <ChevronLeft className="size-3.5" aria-hidden />
              </span>
            </CardContent>
          </Card>
        </Link>
      ))}
    </div>
  );
}

function Leaderboard<T>({
  title, icon: Icon, rows, empty, render, href, hrefLabel,
}: {
  title: string;
  icon: typeof Users;
  rows: T[];
  empty: string;
  render: (r: T) => { name: string; amount: string; sub: string };
  href: string;
  hrefLabel: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Icon className="size-4 text-muted-foreground" aria-hidden />
            {title}
          </h3>
          <Link href={href} className="inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground hover:underline">
            {hrefLabel}<ArrowLeft className="size-3" aria-hidden />
          </Link>
        </div>
        {!rows.length ? (
          <p className="py-4 text-center text-xs text-muted-foreground">{empty}</p>
        ) : (
          <ul className="space-y-1.5">
            {rows.map((r, i) => {
              const x = render(r);
              return (
                <li key={i} className="flex items-center justify-between gap-2 text-sm">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] tabular-nums text-muted-foreground">{fmtAr(i + 1)}</span>
                    <span className="truncate">{x.name}</span>
                  </span>
                  <span className="shrink-0 text-left">
                    <span className="block tabular-nums text-money-negative" dir="ltr">{formatIqd(x.amount)}</span>
                    <span className="block text-[10px] text-muted-foreground">{x.sub}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export default function ReportsOverview() {
  const [period, setPeriod] = useState<Period>("month");
  const [branchId, setBranchId] = useState<number | "">("");
  const branchArg = branchId ? Number(branchId) : undefined;
  const r = useMemo(() => ranges(period), [period]);

  const branches = trpc.branches.list.useQuery();
  const pl = trpc.reports.profitAndLoss.useQuery(
    { from: r.from, to: r.to, branchId: branchArg, compareFrom: r.cmpFrom, compareTo: r.cmpTo },
    { staleTime: 60_000 },
  );
  const fin = trpc.reports.financialPosition.useQuery(branchArg ? { branchId: branchArg } : undefined, { staleTime: 60_000 });
  const alerts = trpc.reports.managementAlerts.useQuery(branchArg ? { branchId: branchArg } : undefined, { staleTime: 60_000 });
  const ar = trpc.reports.arAging.useQuery(branchArg ? { branchId: branchArg } : undefined, { staleTime: 60_000 });
  const ap = trpc.reports.apAging.useQuery(branchArg ? { branchId: branchArg } : undefined, { staleTime: 60_000 });

  const cur = pl.data?.current;
  const prev = pl.data?.previous;
  const fp = fin.data;
  const netPosition = fp ? D(fp.cash).add(D(fp.arDebit)).sub(D(fp.apCredit)).toFixed(2) : null;
  const topAr = (ar.data ?? []).filter((x) => Number(x.unpaidTotal) > 0).slice(0, 5);
  const topAp = (ap.data ?? []).filter((x) => Number(x.unpaidTotal) > 0).slice(0, 5);

  return (
    <div className="space-y-5">
      <PageHeader
        title="مركز التقارير والكشوفات"
        description="نظرة واحدة تجيب: أين الخطر؟ أين الربح؟ أين النقد؟ من المتأخر؟"
        actions={
          <div className="flex items-center gap-2">
            <select className={selectCls} value={branchId} onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : "")}>
              <option value="">كل الفروع</option>
              {branches.data?.map((b) => (<option key={b.id} value={b.id}>{b.name}</option>))}
            </select>
            <select className={selectCls} value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
              {(["today", "month", "last30"] as Period[]).map((p) => (<option key={p} value={p}>{PERIOD_AR[p]}</option>))}
            </select>
          </div>
        }
      />

      {/* ① النبض المالي — أين الربح؟ أين النقد؟ */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <StatCard
          label={`الإيراد · ${PERIOD_AR[period]}`}
          value={cur ? formatIqd(cur.revenue) : (pl.isLoading ? "…" : "—")}
          icon={Coins}
          tone="info"
          sub={cur && prev ? <DeltaBadge d={deltaPct(cur.revenue, prev.revenue)} /> : undefined}
        />
        <StatCard
          label="صافي الربح"
          value={cur ? formatIqd(cur.netProfit) : (pl.isLoading ? "…" : "—")}
          icon={TrendingUp}
          tone={cur && Number(cur.netProfit) < 0 ? "negative" : "positive"}
          sub={cur && prev ? <DeltaBadge d={deltaPct(cur.netProfit, prev.netProfit)} /> : undefined}
        />
        <StatCard
          label="هامش الربح"
          value={cur ? `${fmtAr(cur.netMarginPct)}%` : (pl.isLoading ? "…" : "—")}
          icon={Percent}
        />
        <StatCard
          label="النقد المتاح"
          value={fp ? formatIqd(fp.cash) : (fin.isLoading ? "…" : "—")}
          icon={Wallet}
          tone="info"
        />
        <StatCard
          label="صافي المركز"
          value={netPosition != null ? formatIqd(netPosition) : (fin.isLoading ? "…" : "—")}
          icon={Coins}
          tone="positive"
          sub="نقد + ذمم مدينة − دائنة"
        />
        <StatCard
          label="مستحقّ التحصيل"
          value={fp ? formatIqd(fp.arDebit) : (fin.isLoading ? "…" : "—")}
          icon={Users}
          tone="warning"
        />
      </div>

      {/* ② لوحة الإجراءات ذات الأولوية — أين الخطر؟ وماذا أفعل الآن؟ */}
      <section className="space-y-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
          <AlertTriangle className="size-4 text-stock-low" aria-hidden />
          ما يحتاج انتباهك الآن
        </h2>
        <AlertsPanel alerts={alerts.data?.alerts ?? []} loading={alerts.isLoading} />
      </section>

      {/* ③ من المتأخر؟ — لوحتا صدارة */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Leaderboard
          title="أعلى العملاء تأخّراً (لنا عليهم)"
          icon={Users}
          rows={topAr}
          empty="لا ذمم مدينة متأخّرة."
          href="/reports/ar-reminders"
          hrefLabel="تذكيرات الذمم"
          render={(x) => ({ name: x.customerName, amount: x.unpaidTotal, sub: x.oldestInvoiceDate ? `أقدم: ${x.oldestInvoiceDate}` : "" })}
        />
        <Leaderboard
          title="أعلى الموردين استحقاقاً (لهم علينا)"
          icon={Truck}
          rows={topAp}
          empty="لا ذمم دائنة قائمة."
          href="/suppliers?tab=aging"
          hrefLabel="أعمار الموردين"
          render={(x) => ({ name: x.supplierName, amount: x.unpaidTotal, sub: x.oldestPoDate ? `أقدم: ${x.oldestPoDate}` : "" })}
        />
      </div>
    </div>
  );
}
