// تحليل ABC — تصنيف المنتجات حسب مساهمتها في الإيراد (باريتو) إلى فئات A/B/C.
// فلتر فترة + فرع + مؤشّرات (عدد A/B/C + إجمالي الإيراد) + جدول (المنتج/الإيراد/النسبة التراكمية/شارة الفئة).
import { useState } from "react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { PeriodFilter, DEFAULT_PERIOD, type PeriodValue } from "@/components/reports/PeriodFilter";
import { Card, CardContent } from "@/components/ui/card";
import { LoadingState, ErrorState } from "@/components/PageState";
import { fmtAr } from "@/lib/money";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";

type Row = RouterOutputs["reports"]["abcAnalysis"]["rows"][number];

const CLASS_CLS: Record<string, string> = {
  A: "badge-status-active",
  B: "badge-stock-low",
  C: "bg-muted text-foreground/70",
};
const CLASS_LABEL: Record<string, string> = {
  A: "أ (عالية)",
  B: "ب (متوسطة)",
  C: "ج (منخفضة)",
};

const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export default function AbcAnalysis() {
  const me = trpc.auth.me.useQuery();
  const role = me.data?.role ?? "";
  const canPickBranch = role === "admin" || role === "manager";

  const [period, setPeriod] = useState<PeriodValue>(DEFAULT_PERIOD);
  const [branchId, setBranchId] = useState<number | "">("");

  const branches = trpc.branches.list.useQuery(undefined, { enabled: canPickBranch });
  const q = trpc.reports.abcAnalysis.useQuery({
    from: period.from,
    to: period.to,
    branchId: branchId ? Number(branchId) : undefined,
  });

  const rows: Row[] = q.data?.rows ?? [];
  const totals = q.data?.totals;

  const kpis: KpiItem[] = totals
    ? [
        { label: "إجمالي الإيراد", value: fmtAr(totals.revenue), tone: "info" },
        { label: "منتجات فئة A", value: totals.aCount, tone: "positive" },
        { label: "منتجات فئة B", value: totals.bCount, tone: "warning" },
        { label: "منتجات فئة C", value: totals.cCount },
      ]
    : [];

  const periodLabel = `${period.from} — ${period.to}`;
  const branchLabel = branchId
    ? (branches.data?.find((b) => Number(b.id) === Number(branchId))?.name ?? String(branchId))
    : "الكل";

  function onExport() {
    if (!rows.length) return;
    exportRows(rows, {
      filename: `تحليل-ABC-${period.from}-${period.to}`,
      columns: [
        { key: "productName", header: "المنتج" },
        { key: "revenue", header: "الإيراد", map: (r) => Number(r.revenue) },
        { key: "cumulativePct", header: "النسبة التراكمية %", map: (r) => Number(r.cumulativePct) },
        { key: "class", header: "الفئة" },
      ],
    });
  }

  function onPrint() {
    if (!rows.length) return;
    printReportDoc({
      title: "تحليل ABC",
      headerExtra: [
        { label: "الفترة", value: periodLabel },
        { label: "الفرع", value: branchLabel },
      ],
      columns: [
        { key: "product", label: "المنتج" },
        { key: "revenue", label: "الإيراد", align: "left" },
        { key: "cum", label: "التراكمي %", align: "left" },
        { key: "cls", label: "الفئة" },
      ],
      rows: rows.map((r) => ({
        product: r.productName,
        revenue: fmtAr(r.revenue),
        cum: `${r.cumulativePct}%`,
        cls: r.class,
      })),
      summary: totals
        ? [
            { label: "إجمالي الإيراد", value: fmtAr(totals.revenue), large: true, bold: true },
            { label: "منتجات A / B / C", value: `${totals.aCount} / ${totals.bCount} / ${totals.cCount}` },
          ]
        : undefined,
    });
  }

  return (
    <ReportShell
      title="تحليل ABC"
      description="تصنيف المنتجات حسب مساهمتها في الإيراد (باريتو): A ≤ 80٪ تراكمي، B ≤ 95٪، C الباقي."
      kpis={kpis}
      onExport={onExport}
      onPrint={onPrint}
      exportDisabled={!rows.length}
      printDisabled={!rows.length}
      filters={
        <div className="flex flex-wrap items-end gap-3">
          <PeriodFilter value={period} onChange={setPeriod} />
          {canPickBranch && (
            <div className="flex flex-col gap-1">
              <label className="text-[11px] text-muted-foreground">الفرع</label>
              <select
                className={selectCls}
                value={branchId}
                onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : "")}
              >
                <option value="">الكل</option>
                {(branches.data ?? []).map((b) => (
                  <option key={Number(b.id)} value={Number(b.id)}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      }
    >
      <Card>
        <CardContent className="p-0">
          {q.isLoading ? (
            <LoadingState />
          ) : q.isError ? (
            <ErrorState message={q.error?.message} onRetry={() => q.refetch()} />
          ) : !rows.length ? (
            <p className="p-8 text-center text-sm text-muted-foreground">لا مبيعات في هذا النطاق.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="p-2.5 text-right font-medium">#</th>
                    <th className="p-2.5 text-right font-medium">المنتج</th>
                    <th className="p-2.5 text-right font-medium">الإيراد</th>
                    <th className="p-2.5 text-right font-medium">النسبة التراكمية</th>
                    <th className="p-2.5 text-center font-medium">الفئة</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.productId} className="border-b last:border-0 hover:bg-accent/40">
                      <td className="p-2.5 text-right tabular-nums text-muted-foreground" dir="ltr">{i + 1}</td>
                      <td className="p-2.5 text-right">{r.productName}</td>
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{fmtAr(r.revenue)}</td>
                      <td className="p-2.5 text-right tabular-nums text-muted-foreground" dir="ltr">{r.cumulativePct}%</td>
                      <td className="p-2.5 text-center">
                        <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${CLASS_CLS[r.class] ?? "bg-muted"}`}>
                          {CLASS_LABEL[r.class] ?? r.class}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </ReportShell>
  );
}
