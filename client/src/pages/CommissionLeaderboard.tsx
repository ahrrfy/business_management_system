// «لوحة الإنجاز» — تبويب في hub التقارير (وحدة الأهداف والعمولات، S5).
//
// عرض حيّ لشهرٍ مُنتقى بلا حاجة لتشغيلة: ترتيب البائعين بصافي المبيعات (نفس محرّك
// التشغيلات قراءةً — رقم اللوحة = رقم التشغيلة لحظتها). العمولة «تقديرية» حتى الاعتماد.
// البوّابة: تقرير قراءة (مدير/محاسب/مدقّق + منح صريح) — الخادم هو الحاكم.
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MonthPicker, thisMonth } from "@/components/form/MonthPicker";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, TableEmptyRow } from "@/components/PageState";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { exportRows } from "@/lib/export";
import { iqd } from "@/lib/hr/ui";
import { trpc } from "@/lib/trpc";
import { Crown, FileDown, Target, TrendingDown, Wallet } from "lucide-react";
import { useState } from "react";

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

  const targetRatio =
    totals && Number(totals.target) > 0
      ? `${((Number(totals.effectiveBase) / Number(totals.target)) * 100).toFixed(0)}%`
      : "—";

  function exportExcel() {
    exportRows(rows, {
      filename: `لوحة-الإنجاز-${period}`,
      title: `لوحة إنجاز المبيعات ${period} (أرقام حيّة — العمولة تقديرية)`,
      columns: [
        { key: "rank", header: "#" },
        { key: "employeeName", header: "الموظف" },
        { key: "branchName", header: "الفرع" },
        { key: "planName", header: "الخطة" },
        { key: "sales", header: "المبيعات", money: true },
        { key: "returns", header: "المرتجعات", money: true },
        { key: "effectiveBase", header: "القاعدة الفعلية", money: true },
        { key: "target", header: "الهدف", money: true },
        { key: "achievementPct", header: "الإنجاز ٪" },
        { key: "projectedCommission", header: "العمولة المتوقّعة", money: true },
      ],
    });
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="لوحة الإنجاز"
        description="ترتيب البائعين بصافي المبيعات الحيّ (بعد المرتجعات والمرحَّل) مقابل أهدافهم الشهرية. العمولة هنا تقديرية — الصرف من تشغيلة معتمدة فقط."
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            <MonthPicker value={period} onChange={setPeriod} ariaLabel="شهر اللوحة" />
            <Button size="sm" variant="outline" onClick={exportExcel} disabled={rows.length === 0}>
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
          label="حقّقوا الهدف"
          value={totals ? `${totals.reached}/${totals.withTarget}` : "—"}
          sub="موظف بلغ 100%"
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
        <CardHeader>
          <CardTitle>ترتيب شهر {period} — {rows.length} بائعاً</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollTableShell bordered={false}>
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2.5 text-center w-10">#</th>
                  <th className="p-2.5">الموظف</th>
                  <th className="p-2.5">الفرع</th>
                  <th className="p-2.5 text-right">المبيعات</th>
                  <th className="p-2.5 text-right">المرتجعات</th>
                  <th className="p-2.5 text-right">القاعدة الفعلية</th>
                  <th className="p-2.5 text-right">الهدف</th>
                  <th className="p-2.5">الإنجاز</th>
                  <th className="p-2.5 text-right">العمولة المتوقّعة</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.employeeId} className={`border-t ${r.rank <= 3 ? "bg-accent/30" : ""}`}>
                    <td className="p-2.5 text-center">
                      <span className={`inline-flex size-6 items-center justify-center rounded-full text-xs font-bold ${r.rank === 1 ? "bg-[var(--money-positive,#059669)] text-white" : r.rank <= 3 ? "bg-primary/15 text-primary" : "text-muted-foreground"}`}>
                        {r.rank}
                      </span>
                    </td>
                    <td className="p-2.5">
                      <div className="font-medium">{r.employeeName}</div>
                      <div className="text-[11px] text-muted-foreground">{r.planName}</div>
                    </td>
                    <td className="p-2.5 text-muted-foreground">{r.branchName || "—"}</td>
                    <td className="p-2.5 text-right tabular-nums" dir="ltr">{iqd(r.sales)}</td>
                    <td className="p-2.5 text-right tabular-nums text-money-negative" dir="ltr">
                      {Number(r.returns) > 0 ? `−${iqd(r.returns)}` : "—"}
                    </td>
                    <td className="p-2.5 text-right tabular-nums font-medium" dir="ltr">{iqd(r.effectiveBase)}</td>
                    <td className="p-2.5 text-right tabular-nums text-muted-foreground" dir="ltr">{r.target != null ? iqd(r.target) : "—"}</td>
                    <td className="p-2.5">
                      {r.achievementPct != null ? <Bar pct={Number(r.achievementPct)} /> : <span className="inline-block rounded-full px-2 py-0.5 text-[11px] badge-stock-low">بلا هدف</span>}
                    </td>
                    <td className="p-2.5 text-right tabular-nums font-bold" dir="ltr">{iqd(r.projectedCommission)}</td>
                  </tr>
                ))}
                {q.isLoading && (
                  <tr><td colSpan={9}><LoadingState /></td></tr>
                )}
                {!q.isLoading && rows.length === 0 && (
                  <TableEmptyRow colSpan={9} message="لا بائعين بإسناد خطة فعّال لهذا الشهر — أسند الخطط من الموارد البشرية ← خطط العمولات." />
                )}
              </tbody>
            </table>
          </ScrollTableShell>
        </CardContent>
      </Card>
    </div>
  );
}
