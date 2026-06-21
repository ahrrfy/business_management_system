// تقييم المخزون بالتكلفة حسب الفئة — قيمة الرصيد الحالي مجمّعةً (للقراءة فقط).
// عرض + تصدير Excel + طباعة A4 (ReportShell + printReportDoc). فلتر فرع.
// ⚠️ القيمة بالتكلفة (آخر تكلفة، قرار المالك)؛ الكمية بالوحدة الأساس.
import { useState } from "react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { Card, CardContent } from "@/components/ui/card";
import { fmtAr, fmtInt } from "@/lib/money";
import { fmtDate } from "@/lib/date";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";

type Row = RouterOutputs["reports"]["inventoryValuation"]["rows"][number];

const NOTE =
  "القيمة بالتكلفة (آخر تكلفة) لكل وحدة أساس × الكمية الحالية في المخزون؛ الكمية بالوحدة الأساس. لقطة لحظية للرصيد الحالي.";
const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export default function InventoryValuation() {
  const [branchId, setBranchId] = useState<number | "">("");
  const branches = trpc.branches.list.useQuery();
  const q = trpc.reports.inventoryValuation.useQuery({ branchId: branchId ? Number(branchId) : undefined });

  const rows = q.data?.rows ?? [];
  const totals = q.data?.totals;

  const kpis: KpiItem[] = totals
    ? [
        { label: "عدد المنتجات", value: totals.items, tone: "info" },
        { label: "إجمالي الكمية", value: fmtInt(totals.totalQty) },
        { label: "إجمالي القيمة (بالتكلفة)", value: fmtAr(totals.totalValue), tone: "positive" },
      ]
    : [];

  const branchLabel = branchId ? (branches.data?.find((b) => b.id === branchId)?.name ?? String(branchId)) : "الكل";

  function onExport() {
    exportRows(rows, {
      filename: `تقييم-المخزون${branchId ? `-${branchLabel}` : ""}`,
      columns: [
        { key: "categoryName", header: "الفئة" },
        { key: "items", header: "عدد المنتجات", map: (r) => r.items },
        { key: "totalQty", header: "إجمالي الكمية", map: (r) => r.totalQty },
        { key: "totalValue", header: "القيمة بالتكلفة", map: (r) => Number(r.totalValue) },
      ],
    });
  }

  function onPrint() {
    printReportDoc({
      title: "تقييم المخزون بالتكلفة",
      headerExtra: [
        { label: "كما في", value: fmtDate(new Date()) },
        { label: "الفرع", value: branchLabel },
      ],
      note: NOTE,
      columns: [
        { key: "category", label: "الفئة" },
        { key: "items", label: "عدد المنتجات", align: "left" },
        { key: "qty", label: "إجمالي الكمية", align: "left" },
        { key: "value", label: "القيمة بالتكلفة", align: "left" },
      ],
      rows: rows.map((r) => ({
        category: r.categoryName,
        items: String(r.items),
        qty: fmtInt(r.totalQty),
        value: fmtAr(r.totalValue),
      })),
      summary: totals
        ? [
            { label: "عدد المنتجات", value: String(totals.items) },
            { label: "إجمالي الكمية", value: fmtInt(totals.totalQty) },
            { label: "إجمالي القيمة (بالتكلفة)", value: fmtAr(totals.totalValue), large: true, bold: true },
          ]
        : undefined,
    });
  }

  return (
    <ReportShell
      title="تقييم المخزون بالتكلفة"
      description="قيمة الرصيد الحالي مجمّعةً حسب الفئة."
      note={NOTE}
      kpis={kpis}
      onExport={onExport}
      onPrint={onPrint}
      exportDisabled={!rows.length}
      printDisabled={!rows.length}
      filters={
        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-muted-foreground">الفرع</label>
          <select className={selectCls} value={branchId} onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : "")}>
            <option value="">الكل</option>
            {branches.data?.map((b) => (<option key={b.id} value={b.id}>{b.name}</option>))}
          </select>
        </div>
      }
    >
      <Card>
        <CardContent className="p-0">
          {q.isLoading ? (
            <p className="p-8 text-center text-sm text-muted-foreground">جارٍ التحميل…</p>
          ) : !rows.length ? (
            <p className="p-8 text-center text-sm text-muted-foreground">لا مخزون في هذا النطاق.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="p-2.5 text-right font-medium">الفئة</th>
                    <th className="p-2.5 text-left font-medium">عدد المنتجات</th>
                    <th className="p-2.5 text-left font-medium">إجمالي الكمية</th>
                    <th className="p-2.5 text-left font-medium">القيمة بالتكلفة</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.categoryId ?? "none"} className="border-b last:border-0 hover:bg-accent/40">
                      <td className="p-2.5 text-right">{r.categoryName}</td>
                      <td className="p-2.5 text-left tabular-nums" dir="ltr">{fmtInt(r.items)}</td>
                      <td className="p-2.5 text-left tabular-nums" dir="ltr">{fmtInt(r.totalQty)}</td>
                      <td className="p-2.5 text-left tabular-nums font-medium" dir="ltr">{fmtAr(r.totalValue)}</td>
                    </tr>
                  ))}
                </tbody>
                {totals && (
                  <tfoot>
                    <tr className="border-t-2 font-bold bg-muted/30">
                      <td className="p-2.5 text-right">الإجمالي</td>
                      <td className="p-2.5 text-left tabular-nums" dir="ltr">{fmtInt(totals.items)}</td>
                      <td className="p-2.5 text-left tabular-nums" dir="ltr">{fmtInt(totals.totalQty)}</td>
                      <td className="p-2.5 text-left tabular-nums" dir="ltr">{fmtAr(totals.totalValue)}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </ReportShell>
  );
}
