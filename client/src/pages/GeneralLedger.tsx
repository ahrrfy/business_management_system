// دفتر اليومية / الأستاذ — تصفّح قيود الدفتر بفلاتر (تاريخ/فرع/نوع) + إجماليات + تنقّل لمستند المصدر.
// عرض + تصدير Excel + طباعة A4 (ReportShell + printReportDoc). ترقيم صفحات بالخادم (limit/offset).
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { PeriodFilter, DEFAULT_PERIOD, type PeriodValue } from "@/components/reports/PeriodFilter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { LoadingState, ErrorState } from "@/components/PageState";
import { fmtAr } from "@/lib/money";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";

type Row = RouterOutputs["reports"]["generalLedger"]["rows"][number];
type EntryType = "SALE" | "PURCHASE" | "PAYMENT_IN" | "PAYMENT_OUT" | "RETURN" | "ADJUST" | "OPENING" | "INTERNAL_USE" | "WASTAGE";

const TYPE_LABEL: Record<string, string> = {
  SALE: "بيع", PURCHASE: "شراء", PAYMENT_IN: "قبض", PAYMENT_OUT: "صرف",
  RETURN: "مرتجع", ADJUST: "تسوية", OPENING: "افتتاحي", INTERNAL_USE: "نثرية", WASTAGE: "تلف",
};
const TYPE_CLS: Record<string, string> = {
  SALE: "badge-status-active", PURCHASE: "badge-status-pending",
  PAYMENT_IN: "badge-status-active", PAYMENT_OUT: "badge-stock-low",
  RETURN: "badge-stock-out", ADJUST: "bg-muted text-muted-foreground",
  OPENING: "badge-status-done", INTERNAL_USE: "badge-stock-low",
  WASTAGE: "badge-stock-out",
};
const TYPE_OPTIONS = Object.keys(TYPE_LABEL);
const PAGE = 200;
const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function refLabel(r: Row): { text: string; href?: string } {
  if (r.invoiceId) return { text: r.invoiceNumber ?? `#${r.invoiceId}`, href: `/invoices/${r.invoiceId}` };
  if (r.purchaseOrderId) return { text: `أمر شراء #${r.purchaseOrderId}`, href: `/purchases/${r.purchaseOrderId}` };
  return { text: r.notes ?? "—" };
}

export default function GeneralLedger() {
  const [period, setPeriod] = useState<PeriodValue>(DEFAULT_PERIOD);
  const [branchId, setBranchId] = useState<number | "">("");
  const [entryType, setEntryType] = useState("");
  const [page, setPage] = useState(0);

  const branches = trpc.branches.list.useQuery();
  const q = trpc.reports.generalLedger.useQuery({
    from: period.from,
    to: period.to,
    branchId: branchId ? Number(branchId) : undefined,
    entryTypes: entryType ? [entryType as EntryType] : undefined,
    limit: PAGE,
    offset: page * PAGE,
  });

  const rows = q.data?.rows ?? [];
  const totals = q.data?.totals;
  const total = q.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));

  const kpis: KpiItem[] = totals
    ? [
        { label: "عدد القيود", value: total },
        { label: "إجمالي الإيراد", value: fmtAr(totals.revenue), tone: "info" },
        { label: "إجمالي التكلفة", value: fmtAr(totals.cost), tone: "warning" },
        { label: "صافي الربح", value: fmtAr(totals.profit), tone: "positive" },
      ]
    : [];

  const periodLabel = `${period.from} — ${period.to}`;

  // إعادة ضبط الصفحة عند تغيّر الفلاتر.
  function changePeriod(p: PeriodValue) { setPeriod(p); setPage(0); }

  function onExport() {
    exportRows(rows, {
      filename: `دفتر-الأستاذ-${period.from}-${period.to}`,
      columns: [
        { key: "entryDate", header: "التاريخ" },
        { key: "entryType", header: "النوع", map: (r) => TYPE_LABEL[r.entryType] ?? r.entryType },
        { key: "partyName", header: "الطرف", map: (r) => r.partyName ?? "" },
        { key: "branchName", header: "الفرع", map: (r) => r.branchName ?? "" },
        { key: "revenue", header: "الإيراد", map: (r) => Number(r.revenue) },
        { key: "cost", header: "التكلفة", map: (r) => Number(r.cost) },
        { key: "profit", header: "الربح", map: (r) => Number(r.profit) },
        { key: "amount", header: "المبلغ", map: (r) => Number(r.amount) },
        { key: "ref", header: "المرجع", map: (r) => refLabel(r).text },
      ],
    });
  }

  function onPrint() {
    printReportDoc({
      title: "دفتر اليومية / الأستاذ",
      headerExtra: [
        { label: "الفترة", value: periodLabel },
        { label: "الفرع", value: branchId ? (branches.data?.find((b) => b.id === branchId)?.name ?? String(branchId)) : "الكل" },
        { label: "النوع", value: entryType ? TYPE_LABEL[entryType] : "الكل" },
      ],
      columns: [
        { key: "date", label: "التاريخ" },
        { key: "type", label: "النوع" },
        { key: "party", label: "الطرف" },
        { key: "revenue", label: "الإيراد", align: "left" },
        { key: "cost", label: "التكلفة", align: "left" },
        { key: "amount", label: "المبلغ", align: "left" },
        { key: "ref", label: "المرجع" },
      ],
      rows: rows.map((r) => ({
        date: r.entryDate,
        type: TYPE_LABEL[r.entryType] ?? r.entryType,
        party: r.partyName ?? "—",
        revenue: fmtAr(r.revenue),
        cost: fmtAr(r.cost),
        amount: fmtAr(r.amount),
        ref: refLabel(r).text,
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
      title="دفتر اليومية / الأستاذ"
      description="كل القيود المحاسبية بفلاتر وتنقّل لمستند المصدر."
      kpis={kpis}
      onExport={onExport}
      onPrint={onPrint}
      exportDisabled={!rows.length}
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
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">نوع القيد</label>
            <select className={selectCls} value={entryType} onChange={(e) => { setEntryType(e.target.value); setPage(0); }}>
              <option value="">الكل</option>
              {TYPE_OPTIONS.map((t) => (<option key={t} value={t}>{TYPE_LABEL[t]}</option>))}
            </select>
          </div>
        </div>
      }
    >
      <Card>
        <CardContent className="p-0">
          {q.isLoading ? (
            <LoadingState />
          ) : q.isError ? (
            <ErrorState message="تعذّر تحميل دفتر الأستاذ." onRetry={() => q.refetch()} />
          ) : !rows.length ? (
            <p className="p-8 text-center text-sm text-muted-foreground">لا قيود في هذا النطاق.</p>
          ) : (
            <ScrollTableShell bordered={false}>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="p-2.5 text-end font-medium">التاريخ</th>
                    <th className="p-2.5 text-end font-medium">النوع</th>
                    <th className="p-2.5 text-end font-medium">الطرف</th>
                    <th className="p-2.5 text-end font-medium">الفرع</th>
                    <th className="p-2.5 text-start font-medium">الإيراد</th>
                    <th className="p-2.5 text-start font-medium">التكلفة</th>
                    <th className="p-2.5 text-start font-medium">المبلغ</th>
                    <th className="p-2.5 text-end font-medium">المرجع</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const ref = refLabel(r);
                    return (
                      <tr key={r.id} className="border-b last:border-0 hover:bg-accent/40">
                        <td className="p-2.5 text-right tabular-nums" dir="ltr">{r.entryDate}</td>
                        <td className="p-2.5 text-end">
                          <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${TYPE_CLS[r.entryType] ?? "bg-muted text-muted-foreground"}`}>
                            {TYPE_LABEL[r.entryType] ?? r.entryType}
                          </span>
                        </td>
                        <td className="p-2.5 text-end">{r.partyName ?? "—"}</td>
                        <td className="p-2.5 text-end text-muted-foreground">{r.branchName ?? "—"}</td>
                        <td className="p-2.5 text-right tabular-nums" dir="ltr">{fmtAr(r.revenue)}</td>
                        <td className="p-2.5 text-right tabular-nums text-muted-foreground" dir="ltr">{fmtAr(r.cost)}</td>
                        <td className="p-2.5 text-right tabular-nums" dir="ltr">{fmtAr(r.amount)}</td>
                        <td className="p-2.5 text-end">
                          {ref.href ? (
                            <Link href={ref.href} className="text-primary underline-offset-2 hover:underline">{ref.text}</Link>
                          ) : (
                            <span className="text-muted-foreground">{ref.text}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </ScrollTableShell>
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
