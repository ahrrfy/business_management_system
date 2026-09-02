// «لوحة الإنجاز» — تبويب في hub التقارير (وحدة الأهداف والعمولات، S5).
//
// عرض حيّ لشهرٍ مُنتقى بلا حاجة لتشغيلة: ترتيب البائعين بصافي المبيعات (نفس محرّك
// التشغيلات قراءةً — رقم اللوحة = رقم التشغيلة لحظتها). العمولة «تقديرية» حتى الاعتماد.
// البوّابة: تقرير قراءة (مدير/محاسب/مدقّق + منح صريح) — الخادم هو الحاكم.
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AppSelect } from "@/components/ui/AppSelect";
import { MonthPicker, thisMonth } from "@/components/form/MonthPicker";
import { PageHeader } from "@/components/PageHeader";


import { exportRows } from "@/lib/export";
import { iqd } from "@/lib/hr/ui";
import { trpc } from "@/lib/trpc";
import { useUrlFilters } from "@/hooks/useUrlFilters";
import { Crown, FileDown, Search, Target, TrendingDown, Wallet, X } from "lucide-react";
import { useMemo, useState } from "react";

function StatCard({ label, value, sub, accent, icon }: { label: string; value: string; sub?: string; accent?: string; icon: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div className="text-muted-foreground text-xs">{label}</div>
          <span style={{ color: accent }}>{icon}</span>
        </div>
        <div className="mt-1 text-2xl font-bold tabular-nums" dir="ltr" style={{ color: accent }}>{value}</div>
        {sub && <div className="text-muted-foreground text-xs mt-0.5">{sub}</div>}
      </CardContent>
    </Card>
  );
}

function Bar({ pct }: { pct: number }) {
  const reached = pct >= 100;
  return (
    <div className="min-w-28">
      <div className="text-[11px] tabular-nums" dir="ltr">
        <span className={reached ? "text-money-positive font-bold" : "text-muted-foreground"}>{pct.toFixed(1)}%</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        <div className={`h-full rounded-full ${reached ? "bg-[var(--money-positive,#059669)]" : "bg-primary"}`} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
    </div>
  );
}

export default function CommissionLeaderboard() {
  const [period, setPeriod] = useState(thisMonth());
  const q = trpc.commissions.performance.leaderboard.useQuery({ period }, { staleTime: 30_000 });
  const rows = q.data?.rows ?? [];
  const totals = q.data?.totals;

  // فلتر فرع + بحث موظف — عميليان بحتان (اللوحة تُرجَع كاملةً للشهر دفعةً واحدة، بلا endpoint
  // مُفلتِر خادمياً). لا يمسّان بطاقات الملخّص (targetRatio/totals) — تبقى إجمالي الشهر كاملاً.
  const [f, setF] = useUrlFilters({ q: "", branch: "" });
  const filteredRows = useMemo(() => {
    const needle = f.q.trim().toLowerCase();
    return rows.filter((r) => {
      if (f.branch && r.branchName !== f.branch) return false;
      if (needle && !r.employeeName.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [rows, f.q, f.branch]);
  const branchOptions = useMemo(() => {
    const names = new Set<string>();
    for (const r of rows) if (r.branchName) names.add(r.branchName);
    return Array.from(names).sort((a, b) => a.localeCompare(b, "ar"));
  }, [rows]);

  const targetRatio =
    totals && Number(totals.target) > 0
      ? `${((Number(totals.effectiveBase) / Number(totals.target)) * 100).toFixed(0)}%`
      : "—";

  function exportExcel() {
    exportRows(filteredRows, {
      filename: `لوحة-الإنجاز-${period}`,
      title: `لوحة إنجاز المبيعات ${period} (أرقام حيّة — العمولة تقديرية)`,
      columns: [
        { key: "rank", header: "#" },
        { key: "employeeName", header: "الموظف" },
        { key: "branchName", header: "الفرع" },
        { key: "planName", header: "الخطة" },
        { key: "sales", header: "المبيعات", money: true },
        { key: "returns", header: "المرتجعات", money: true },
        { key: "effectiveBase", header: "المبلغ المحتسَب عليه", money: true },
        { key: "target", header: "الهدف", money: true },
        { key: "achievementPct", header: "نسبة التحقيق ٪" },
        { key: "projectedCommission", header: "العمولة المتوقّعة", money: true },
      ],
    });
  }
  /** أعمدة لوحة صدارة العمولات — الترتيب من الخادم (rank)، فلا فرزَ يعيد ترتيب اللوحة. */
  const leaderboardColumns = useMemo<ColumnDef<(typeof filteredRows)[number], unknown>[]>(() => [
    {
      id: "rank", header: "#", enableSorting: false,
      accessorFn: (r) => r.rank,
      cell: ({ row }) => (
        <span className={`inline-flex size-6 items-center justify-center rounded-full text-xs font-bold ${row.original.rank === 1 ? "bg-[var(--money-positive,#059669)] text-white" : row.original.rank <= 3 ? "bg-primary/15 text-primary" : "text-muted-foreground"}`}>
          {row.original.rank}
        </span>
      ),
      meta: { kind: "number", width: "id" },
    },
    {
      id: "employee", header: "الموظف", enableSorting: false,
      accessorFn: (r) => r.employeeName,
      cell: ({ row }) => (
        <div>
          <div className="font-medium whitespace-nowrap">{row.original.employeeName}</div>
          <div className="max-w-[11rem] truncate text-[11px] text-muted-foreground" title={row.original.planName}>{row.original.planName}</div>
        </div>
      ),
      meta: { kind: "text", wrap: true },
    },
    {
      id: "branch", header: "الفرع", enableSorting: false,
      accessorFn: (r) => r.branchName || "—",
      cell: ({ row }) => <span className="whitespace-nowrap text-muted-foreground">{row.original.branchName || "—"}</span>,
      meta: { kind: "text" },
    },
    { id: "sales", header: "المبيعات", enableSorting: false, accessorFn: (r) => Number(r.sales), cell: ({ row }) => iqd(row.original.sales), meta: { kind: "money" } },
    {
      id: "returns", header: "المرتجعات", enableSorting: false,
      accessorFn: (r) => Number(r.returns),
      cell: ({ row }) => <span className="text-money-negative">{Number(row.original.returns) > 0 ? `−${iqd(row.original.returns)}` : "—"}</span>,
      meta: { kind: "money" },
    },
    {
      id: "effectiveBase", header: "المبلغ المحتسَب عليه", enableSorting: false,
      accessorFn: (r) => Number(r.effectiveBase),
      cell: ({ row }) => <span className="font-medium">{iqd(row.original.effectiveBase)}</span>,
      meta: { kind: "money" },
    },
    {
      id: "target", header: "هدفه", enableSorting: false,
      accessorFn: (r) => (r.target == null ? -1 : Number(r.target)),
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.target != null ? iqd(row.original.target) : "—"}</span>,
      meta: { kind: "money" },
    },
    {
      id: "achievementPct", header: "نسبة التحقيق", enableSorting: false,
      accessorFn: (r) => (r.achievementPct == null ? -1 : Number(r.achievementPct)),
      cell: ({ row }) => row.original.achievementPct != null
        ? <Bar pct={Number(row.original.achievementPct)} />
        : <span className="inline-block rounded-full px-2 py-0.5 text-[11px] badge-stock-low">بلا هدف</span>,
      meta: { kind: "text" },
    },
    {
      id: "projectedCommission", header: "العمولة المتوقّعة", enableSorting: false,
      accessorFn: (r) => Number(r.projectedCommission),
      cell: ({ row }) => <span className="font-bold">{iqd(row.original.projectedCommission)}</span>,
      meta: { kind: "money" },
    },
  ], []);

  return (
    <div className="space-y-4">
      <PageHeader
        title="لوحة الإنجاز"
        description="ترتيب البائعين بمبيعاتهم المحتسَبة حتى هذه اللحظة (بعد المرتجعات والمرحَّل) مقابل أهدافهم الشهرية. أرقام العمولة هنا تقديرية للمتابعة فقط — لا يُصرَف شيء إلا من كشف شهري معتمد."
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            <MonthPicker value={period} onChange={setPeriod} ariaLabel="شهر اللوحة" />
            <Button size="sm" variant="outline" onClick={exportExcel} disabled={filteredRows.length === 0}>
              <FileDown className="size-4" /> Excel
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="المبيعات مقابل الأهداف"
          value={targetRatio}
          sub={totals ? `${iqd(totals.effectiveBase)} من ${iqd(totals.target)} د.ع` : undefined}
          icon={<Target className="size-4" />}
        />
        <StatCard
          label="الأفضل أداءً"
          value={rows[0] ? rows[0].employeeName.split(" ").slice(0, 2).join(" ") : "—"}
          sub={rows[0] ? `${iqd(rows[0].effectiveBase)} د.ع` : undefined}
          accent="var(--status-active, #2563eb)"
          icon={<Crown className="size-4" />}
        />
        <StatCard
          label="حقّقوا هدفهم"
          value={totals ? `${totals.reached}/${totals.withTarget}` : "—"}
          sub="موظف بلغ 100% من هدفه"
          accent="var(--status-done, #059669)"
          icon={<Wallet className="size-4" />}
        />
        <StatCard
          label="دون 50%"
          value={totals ? String(totals.below50) : "—"}
          sub="يحتاجون متابعة"
          accent="var(--money-negative, #dc2626)"
          icon={<TrendingDown className="size-4" />}
        />
      </div>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <CardTitle>ترتيب شهر {period} — {filteredRows.length} بائعاً</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-40">
              <Search aria-hidden className="pointer-events-none absolute top-1/2 right-2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={f.q} onChange={(e) => setF({ q: e.target.value })} placeholder="بحث بالموظف…" aria-label="بحث بالموظف" className="h-8 w-full pr-8 sm:w-44" />
            </div>
            <AppSelect value={f.branch} onValueChange={(v) => setF({ branch: v })} className="h-8 w-36" size="sm" placeholder="كل الفروع">
              <option value="">كل الفروع</option>
              {branchOptions.map((name) => <option key={name} value={name}>{name}</option>)}
            </AppSelect>
            {(f.q.trim() !== "" || f.branch !== "") && (
              <Button variant="ghost" size="sm" onClick={() => setF({ q: "", branch: "" })} className="text-muted-foreground">
                <X aria-hidden className="size-4" /> مسح
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <DataTable
            columns={leaderboardColumns}
            data={filteredRows}
            loading={q.isLoading}
            searchable={false}
            getRowClassName={(r) => (r.rank <= 3 ? "bg-accent/30" : undefined)}
            emptyText={rows.length === 0
              ? "لا بائعين مرتبطين بخطة فعّالة لهذا الشهر — اربطهم بالخطط من: الموارد البشرية ← خطط العمولات."
              : "لا بائعين مطابقين للفلاتر."}
          />
        </CardContent>
      </Card>
    </div>
  );
}
