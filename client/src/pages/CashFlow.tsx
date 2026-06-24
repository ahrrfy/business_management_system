// قائمة التدفّقات النقدية المبسّطة (أساس نقدي مباشر) — مقبوضات/مدفوعات حسب طريقة الدفع.
// عرض + Excel + طباعة A4. ⚠️ أساس نقدي: من المقبوضات المكتملة (receipts COMPLETED) لا الاستحقاق.
import { useMemo, useState } from "react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { PeriodFilter, DEFAULT_PERIOD, type PeriodValue } from "@/components/reports/PeriodFilter";
import { Card, CardContent } from "@/components/ui/card";
import { LoadingState } from "@/components/PageState";
import { fmtAr, D } from "@/lib/money";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";

type CF = RouterOutputs["reports"]["cashFlow"];

const NOTE = "أساس نقدي مباشر: من المقبوضات/المدفوعات المكتملة (لا أساس الاستحقاق). النقد حسب الفرع المحدّد.";
const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export default function CashFlow() {
  const [period, setPeriod] = useState<PeriodValue>(DEFAULT_PERIOD);
  const [branchId, setBranchId] = useState<number | "">("");
  const branches = trpc.branches.list.useQuery();
  const q = trpc.reports.cashFlow.useQuery({ from: period.from, to: period.to, branchId: branchId ? Number(branchId) : undefined });
  const cf = q.data;

  const kpis: KpiItem[] = cf
    ? [
        { label: "المقبوضات", value: fmtAr(cf.totalIn), tone: "positive" },
        { label: "المدفوعات", value: fmtAr(cf.totalOut), tone: "negative" },
        { label: "صافي التدفّق", value: fmtAr(cf.net), tone: D(cf.net).gte(0) ? "positive" : "negative" },
      ]
    : [];

  const flat = useMemo(() => {
    if (!cf) return [] as { label: string; amount: string; neg?: boolean }[];
    return [
      { label: "المقبوضات (داخل)", amount: "" },
      ...cf.inflows.map((l) => ({ label: `— ${l.label}`, amount: l.amount })),
      { label: "إجمالي المقبوضات", amount: cf.totalIn },
      { label: "المدفوعات (خارج)", amount: "" },
      ...cf.outflows.map((l) => ({ label: `— ${l.label}`, amount: l.amount, neg: true })),
      { label: "إجمالي المدفوعات", amount: cf.totalOut, neg: true },
      { label: "صافي التدفّق النقدي", amount: cf.net },
    ];
  }, [cf]);

  const branchLabel = branchId ? (branches.data?.find((b) => b.id === branchId)?.name ?? String(branchId)) : "الكل";

  function onExport() {
    exportRows(flat, {
      filename: `التدفّق-النقدي-${period.from}-${period.to}`,
      columns: [
        { key: "label", header: "البند" },
        { key: "amount", header: "القيمة", map: (r) => (r.amount === "" ? "" : Number(r.amount)) },
      ],
    });
  }

  function onPrint() {
    if (!cf) return;
    printReportDoc({
      title: "قائمة التدفّقات النقدية",
      headerExtra: [
        { label: "الفترة", value: `${period.from} — ${period.to}` },
        { label: "الفرع", value: branchLabel },
      ],
      note: NOTE,
      columns: [
        { key: "label", label: "البند" },
        { key: "amount", label: "القيمة", align: "left" },
      ],
      rows: flat.map((r) => ({ label: r.label, amount: r.amount === "" ? "" : (r.neg ? `(${fmtAr(r.amount)})` : fmtAr(r.amount)) })),
      showIndex: false,
      summary: [{ label: "صافي التدفّق النقدي", value: fmtAr(cf.net), large: true, bold: true }],
    });
  }

  return (
    <ReportShell
      title="قائمة التدفّقات النقدية"
      description="مقبوضات/مدفوعات حسب طريقة الدفع (أساس نقدي)."
      note={NOTE}
      kpis={kpis}
      onExport={onExport}
      onPrint={onPrint}
      exportDisabled={!cf}
      printDisabled={!cf}
      filters={
        <div className="flex flex-wrap items-end gap-3">
          <PeriodFilter value={period} onChange={setPeriod} />
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">الفرع</label>
            <select className={selectCls} value={branchId} onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : "")}>
              <option value="">الكل</option>
              {branches.data?.map((b) => (<option key={b.id} value={b.id}>{b.name}</option>))}
            </select>
          </div>
        </div>
      }
    >
      <Card>
        <CardContent className="p-0">
          {q.isLoading || !cf ? (
            q.isLoading ? (
              <LoadingState />
            ) : (
              <p className="p-8 text-center text-sm text-muted-foreground">لا بيانات.</p>
            )
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="p-3 text-end font-medium">البند</th>
                  <th className="p-3 text-right font-medium">القيمة</th>
                </tr>
              </thead>
              <tbody>
                {flat.map((r, i) => {
                  const isHeader = r.amount === "";
                  const isTotal = r.label.startsWith("إجمالي") || r.label.startsWith("صافي");
                  return (
                    <tr key={i} className={`border-b last:border-0 ${isHeader || isTotal ? "font-bold bg-muted/30" : ""}`}>
                      <td className="p-3 text-end">{r.label}</td>
                      <td className={`p-3 text-right tabular-nums ${r.neg ? "text-money-negative" : ""}`} dir="ltr">
                        {r.amount === "" ? "" : r.neg ? `(${fmtAr(r.amount)})` : fmtAr(r.amount)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </ReportShell>
  );
}
