// تقرير طلبات خدمة العملاء — توزيع الحالات (كلها بما فيها الملغاة) + قنوات الاستلام + ربحية المُسلَّم.
// المصدر: reports.workOrdersReport. عرض + تصدير Excel (توزيع الحالات) + طباعة A4.
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { PeriodFilter, DEFAULT_PERIOD, type PeriodValue } from "@/components/reports/PeriodFilter";
import { Card, CardContent } from "@/components/ui/card";
import { fmtAr } from "@/lib/money";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { LoadingState, ErrorState, TableEmptyRow } from "@/components/PageState";

const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const STATUS_CLS: Record<string, string> = {
  RECEIVED: "badge-status-pending",
  IN_PROGRESS: "badge-stock-low",
  READY: "badge-status-done",
  DELIVERED: "badge-status-active",
  CANCELLED: "badge-stock-out",
};

export default function WorkOrdersReport() {
  const [period, setPeriod] = useState<PeriodValue>(DEFAULT_PERIOD);
  const [branchId, setBranchId] = useState<number | "">("");

  const branches = trpc.branches.list.useQuery();
  const q = trpc.reports.workOrdersReport.useQuery({
    from: period.from,
    to: period.to,
    branchId: branchId ? Number(branchId) : undefined,
  });

  const statusRows = q.data?.statusDistribution ?? [];
  const channelRows = q.data?.byChannel ?? [];
  const delivered = q.data?.delivered;
  const totalCount = statusRows.reduce((acc, r) => acc + r.count, 0);
  const hasData = !!q.data && (totalCount > 0 || channelRows.length > 0);

  const kpis: KpiItem[] = delivered
    ? [
        { label: "أوامر مُسلَّمة", value: delivered.count, tone: "positive" },
        { label: "إيراد المُسلَّم", value: fmtAr(delivered.totalRevenue), tone: "info" },
        { label: "مجمل ربح الأشغال", value: fmtAr(delivered.grossProfit), tone: "positive" },
      ]
    : [];

  const periodLabel = `${period.from} — ${period.to}`;
  const branchLabel = branchId
    ? (branches.data?.find((b) => b.id === branchId)?.name ?? String(branchId))
    : "الكل";

  function onExport() {
    exportRows(statusRows, {
      filename: `تقرير-طلبات-خدمة-العملاء-${period.from}-${period.to}`,
      columns: [
        { key: "label", header: "الحالة" },
        { key: "count", header: "عدد الأوامر", map: (r) => r.count },
      ],
    });
  }

  function onPrint() {
    printReportDoc({
      title: "تقرير طلبات خدمة العملاء",
      headerExtra: [
        { label: "الفترة", value: periodLabel },
        { label: "الفرع", value: branchLabel },
      ],
      columns: [
        { key: "status", label: "الحالة" },
        { key: "count", label: "عدد الأوامر", align: "left" },
      ],
      rows: statusRows.map((r) => ({ status: r.label, count: String(r.count) })),
      summary: delivered
        ? [
            { label: "إجمالي الأوامر", value: String(totalCount) },
            { label: "أوامر مُسلَّمة", value: String(delivered.count) },
            { label: "إيراد المُسلَّم", value: fmtAr(delivered.totalRevenue) },
            { label: "تكلفة المواد", value: fmtAr(delivered.totalMaterials) },
            { label: "تكلفة العمالة", value: fmtAr(delivered.totalLabor) },
            { label: "مجمل ربح الأشغال", value: fmtAr(delivered.grossProfit), large: true, bold: true },
          ]
        : undefined,
    });
  }

  return (
    <ReportShell
      title="تقرير طلبات خدمة العملاء"
      description="توزيع طلبات خدمة العملاء حسب الحالة وقناة الاستلام مع ربحية الطلبات المُسلَّمة."
      kpis={kpis}
      onExport={onExport}
      onPrint={onPrint}
      exportDisabled={!statusRows.length}
      printDisabled={!hasData}
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
      {q.isLoading ? (
        <Card><CardContent><LoadingState /></CardContent></Card>
      ) : q.isError ? (
        <Card><CardContent><ErrorState message={q.error.message} onRetry={() => q.refetch()} /></CardContent></Card>
      ) : !hasData ? (
        <Card><CardContent><p className="p-8 text-center text-sm text-muted-foreground">لا طلبات خدمة في هذا النطاق.</p></CardContent></Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {/* توزيع الحالات */}
          <Card>
            <CardContent className="p-0">
              <div className="border-b px-4 py-3 text-sm font-medium">توزيع الحالات</div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-xs text-muted-foreground">
                      <th className="p-2.5 text-right font-medium">الحالة</th>
                      <th className="p-2.5 text-left font-medium">عدد الأوامر</th>
                    </tr>
                  </thead>
                  <tbody>
                    {statusRows.map((r) => (
                      <tr key={r.status} className="border-b last:border-0 hover:bg-accent/40">
                        <td className="p-2.5 text-right">
                          <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${STATUS_CLS[r.status] ?? "bg-muted"}`}>
                            {r.label}
                          </span>
                        </td>
                        <td className="p-2.5 text-left tabular-nums" dir="ltr">{r.count}</td>
                      </tr>
                    ))}
                    <tr className="border-t bg-muted/40 font-medium">
                      <td className="p-2.5 text-right">الإجمالي</td>
                      <td className="p-2.5 text-left tabular-nums" dir="ltr">{totalCount}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {/* قنوات الاستلام */}
          <Card>
            <CardContent className="p-0">
              <div className="border-b px-4 py-3 text-sm font-medium">قنوات الاستلام</div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-xs text-muted-foreground">
                      <th className="p-2.5 text-right font-medium">القناة</th>
                      <th className="p-2.5 text-left font-medium">عدد الأوامر</th>
                    </tr>
                  </thead>
                  <tbody>
                    {channelRows.length ? (
                      channelRows.map((r) => (
                        <tr key={r.channel} className="border-b last:border-0 hover:bg-accent/40">
                          <td className="p-2.5 text-right">{r.label}</td>
                          <td className="p-2.5 text-left tabular-nums" dir="ltr">{r.count}</td>
                        </tr>
                      ))
                    ) : (
                      <TableEmptyRow colSpan={2} message="لا بيانات قنوات." />
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </ReportShell>
  );
}
