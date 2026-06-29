// سجلّ المبيعات المفصّل — كل بنود الفواتير (سطر-سطر) بفلاتر (تاريخ/فرع) + إجماليات + ترقيم صفحات.
// عرض + تصدير Excel + طباعة A4 (ReportShell + printReportDoc). ترقيم صفحات بالخادم (limit/offset).
import { useState } from "react";
import { Link } from "wouter";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { PeriodFilter, DEFAULT_PERIOD, type PeriodValue } from "@/components/reports/PeriodFilter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { fmtAr } from "@/lib/money";
import { exportRows } from "@/lib/export";
import { fetchAllPaged } from "@/lib/fetchAllRows";
import { printReportDoc } from "@/lib/printing/reportDoc";

type Row = RouterOutputs["reports"]["salesRegister"]["rows"][number];

const PAGE = 200;
const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export default function SalesRegister() {
  const utils = trpc.useUtils();
  const [period, setPeriod] = useState<PeriodValue>(DEFAULT_PERIOD);
  const [branchId, setBranchId] = useState<number | "">("");
  const [page, setPage] = useState(0);
  const [exporting, setExporting] = useState(false);

  const branches = trpc.branches.list.useQuery();
  const q = trpc.reports.salesRegister.useQuery({
    from: period.from,
    to: period.to,
    branchId: branchId ? Number(branchId) : undefined,
    limit: PAGE,
    offset: page * PAGE,
  });

  const rows = q.data?.rows ?? [];
  const totals = q.data?.totals;
  const total = q.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));

  const kpis: KpiItem[] = totals
    ? [
        { label: "عدد البنود", value: total },
        { label: "إجمالي الإيراد", value: fmtAr(totals.revenue), tone: "info" },
        { label: "إجمالي التكلفة", value: fmtAr(totals.cost), tone: "warning" },
        { label: "صافي الربح", value: fmtAr(totals.profit), tone: "positive" },
      ]
    : [];

  const periodLabel = `${period.from} — ${period.to}`;

  // إعادة ضبط الصفحة عند تغيّر الفلاتر.
  function changePeriod(p: PeriodValue) { setPeriod(p); setPage(0); }

  async function onExport() {
    setExporting(true);
    try {
      // فلتر الاستعلام الحالي (بلا limit/offset) — يُكرَّر عبر offset لجلب كامل المطابق لا الصفحة فقط.
      const filterInput = {
        from: period.from,
        to: period.to,
        branchId: branchId ? Number(branchId) : undefined,
      };
      const all = await fetchAllPaged<Row>(
        (offset, limit) =>
          utils.reports.salesRegister
            .fetch({ ...filterInput, limit, offset })
            .then((r) => ({ rows: r.rows, total: r.total })),
        { pageSize: 500 },
      );
      exportRows(all, {
        filename: `سجلّ-المبيعات-${period.from}-${period.to}`,
        columns: [
          { key: "invoiceDate", header: "التاريخ" },
          { key: "invoiceNumber", header: "الفاتورة" },
          { key: "customerName", header: "العميل", map: (r) => r.customerName ?? "" },
          { key: "productName", header: "المنتج" },
          { key: "quantity", header: "الكمية", map: (r) => Number(r.quantity) },
          { key: "unitPrice", header: "سعر الوحدة", map: (r) => Number(r.unitPrice) },
          { key: "unitCost", header: "تكلفة الوحدة", map: (r) => Number(r.unitCost) },
          { key: "total", header: "الإجمالي", map: (r) => Number(r.total) },
          { key: "profit", header: "الربح", map: (r) => Number(r.profit) },
        ],
      });
    } finally {
      setExporting(false);
    }
  }

  function onPrint() {
    printReportDoc({
      title: "سجلّ المبيعات المفصّل",
      headerExtra: [
        { label: "الفترة", value: periodLabel },
        { label: "الفرع", value: branchId ? (branches.data?.find((b) => b.id === branchId)?.name ?? String(branchId)) : "الكل" },
      ],
      columns: [
        { key: "date", label: "التاريخ" },
        { key: "invoice", label: "الفاتورة" },
        { key: "customer", label: "العميل" },
        { key: "product", label: "المنتج" },
        { key: "qty", label: "الكمية", align: "left" },
        { key: "price", label: "السعر", align: "left" },
        { key: "total", label: "الإجمالي", align: "left" },
        { key: "profit", label: "الربح", align: "left" },
      ],
      rows: rows.map((r) => ({
        date: r.invoiceDate,
        invoice: r.invoiceNumber,
        customer: r.customerName ?? "—",
        product: r.productName,
        qty: fmtAr(r.quantity),
        price: fmtAr(r.unitPrice),
        total: fmtAr(r.total),
        profit: fmtAr(r.profit),
      })),
      summary: totals
        ? [
            { label: "إجمالي الإيراد", value: fmtAr(totals.revenue) },
            { label: "إجمالي التكلفة", value: fmtAr(totals.cost) },
            { label: "صافي الربح", value: fmtAr(totals.profit), large: true, bold: true },
          ]
        : undefined,
    });
  }

  return (
    <ReportShell
      title="سجلّ المبيعات المفصّل"
      description="كل بنود الفواتير سطراً سطراً بفلاتر وتنقّل لمستند المصدر."
      kpis={kpis}
      onExport={onExport}
      onPrint={onPrint}
      exportDisabled={!rows.length || exporting}
      printDisabled={!rows.length}
      filters={
        <div className="flex flex-wrap items-end gap-3">
          <PeriodFilter value={period} onChange={changePeriod} />
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">الفرع</label>
            <select className={selectCls} value={branchId} onChange={(e) => { setBranchId(e.target.value ? Number(e.target.value) : ""); setPage(0); }}>
              <option value="">الكل</option>
              {branches.data?.map((b) => (<option key={b.id} value={b.id}>{b.name}</option>))}
            </select>
          </div>
        </div>
      }
    >
      <Card>
        <CardContent className="p-0">
          {q.isLoading ? (
            <p className="p-8 text-center text-sm text-muted-foreground">جارٍ التحميل…</p>
          ) : !rows.length ? (
            <p className="p-8 text-center text-sm text-muted-foreground">لا مبيعات في هذا النطاق.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="p-2.5 text-end font-medium">التاريخ</th>
                    <th className="p-2.5 text-end font-medium">الفاتورة</th>
                    <th className="p-2.5 text-end font-medium">العميل</th>
                    <th className="p-2.5 text-end font-medium">المنتج</th>
                    <th className="p-2.5 text-right font-medium">الكمية</th>
                    <th className="p-2.5 text-right font-medium">السعر</th>
                    <th className="p-2.5 text-right font-medium">الإجمالي</th>
                    <th className="p-2.5 text-right font-medium">الربح</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b last:border-0 hover:bg-accent/40">
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{r.invoiceDate}</td>
                      <td className="p-2.5 text-end">
                        <Link href={`/invoices/${r.invoiceId}`} className="text-primary underline-offset-2 hover:underline">
                          {r.invoiceNumber}
                        </Link>
                      </td>
                      <td className="p-2.5 text-end">{r.customerName ?? "—"}</td>
                      <td className="p-2.5 text-end">{r.productName}</td>
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{fmtAr(r.quantity)}</td>
                      <td className="p-2.5 text-right tabular-nums text-muted-foreground" dir="ltr">{fmtAr(r.unitPrice)}</td>
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{fmtAr(r.total)}</td>
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{fmtAr(r.profit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {pages > 1 && (
        <div className="flex items-center justify-center gap-3 text-sm">
          <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>السابق</Button>
          <span className="text-muted-foreground tabular-nums">صفحة {page + 1} من {pages}</span>
          <Button variant="outline" size="sm" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>التالي</Button>
        </div>
      )}
    </ReportShell>
  );
}
