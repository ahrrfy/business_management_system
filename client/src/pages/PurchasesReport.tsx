// تقرير المشتريات — ملخّص حسب المورّد (مرآة تقرير المبيعات). عرض + بحث مورّد + تصدير Excel + طباعة A4.
// المصدر: reports.purchasesReport (أوامر شراء ملتزمة CONFIRMED/RECEIVED ضمن الفترة).
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { PeriodFilter, DEFAULT_PERIOD, type PeriodValue } from "@/components/reports/PeriodFilter";
import { AppSelect } from "@/components/ui/AppSelect";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { fmtAr } from "@/lib/money";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { LoadingState, ErrorState } from "@/components/PageState";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";

type Row = RouterOutputs["reports"]["purchasesReport"]["rows"][number];

export default function PurchasesReport() {
  const [period, setPeriod] = useState<PeriodValue>(DEFAULT_PERIOD);
  const [branchId, setBranchId] = useState<number | "">("");
  const [search, setSearch] = useState("");

  const branches = trpc.branches.list.useQuery();
  const q = trpc.reports.purchasesReport.useQuery({
    from: period.from,
    to: period.to,
    branchId: branchId ? Number(branchId) : undefined,
  });

  const allRows = q.data?.rows ?? [];
  // بحث مورّد محلّي — القائمة كاملة محمَّلة من الخادم أصلاً (ملخّص مُجمَّع لا سجلّاً طويلاً).
  const rows = useMemo(() => {
    const s = search.trim();
    if (!s) return allRows;
    return allRows.filter((r) => (r.supplierName ?? "").includes(s));
  }, [allRows, search]);
  const totals = q.data?.totals;

  const kpis: KpiItem[] = totals
    ? [
        { label: "عدد الأوامر", value: totals.count },
        { label: "الإجمالي", value: fmtAr(totals.total), tone: "info" },
        { label: "المدفوع", value: fmtAr(totals.paid), tone: "positive" },
        { label: "المتبقّي", value: fmtAr(totals.unpaid), tone: "warning" },
      ]
    : [];

  const periodLabel = `${period.from} — ${period.to}`;

  function onExport() {
    exportRows(rows, {
      filename: `تقرير-المشتريات-${period.from}-${period.to}`,
      columns: [
        { key: "supplierName", header: "المورّد", map: (r) => r.supplierName ?? "—" },
        { key: "orders", header: "عدد الأوامر", map: (r) => r.orders },
        { key: "total", header: "الإجمالي", map: (r) => Number(r.total) },
        { key: "paid", header: "المدفوع", map: (r) => Number(r.paid) },
        { key: "unpaid", header: "المتبقّي", map: (r) => Number(r.unpaid) },
      ],
    });
  }

  function onPrint() {
    printReportDoc({
      title: "تقرير المشتريات (حسب المورّد)",
      headerExtra: [
        { label: "الفترة", value: periodLabel },
        { label: "الفرع", value: branchId ? (branches.data?.find((b) => b.id === branchId)?.name ?? String(branchId)) : "الكل" },
      ],
      columns: [
        { key: "supplier", label: "المورّد" },
        { key: "orders", label: "عدد الأوامر", align: "left" },
        { key: "total", label: "الإجمالي", align: "left" },
        { key: "paid", label: "المدفوع", align: "left" },
        { key: "unpaid", label: "المتبقّي", align: "left" },
      ],
      rows: rows.map((r) => ({
        supplier: r.supplierName ?? "—",
        orders: String(r.orders),
        total: fmtAr(r.total),
        paid: fmtAr(r.paid),
        unpaid: fmtAr(r.unpaid),
      })),
      summary: totals
        ? [
            { label: "عدد الأوامر", value: String(totals.count) },
            { label: "المدفوع", value: fmtAr(totals.paid) },
            { label: "المتبقّي", value: fmtAr(totals.unpaid) },
            { label: "الإجمالي", value: fmtAr(totals.total), large: true, bold: true },
          ]
        : undefined,
    });
  }

  return (
    <ReportShell
      title="تقرير المشتريات"
      description="إجمالي المشتريات حسب المورّد (أوامر شراء مؤكَّدة/مستلَمة)."
      kpis={kpis}
      onExport={onExport}
      onPrint={onPrint}
      exportDisabled={!rows.length}
      printDisabled={!rows.length}
      filters={
        <div className="flex flex-wrap items-end gap-3">
          <PeriodFilter value={period} onChange={setPeriod} />
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">الفرع</label>
            <AppSelect
              className="w-40"
              value={branchId ? String(branchId) : ""}
              onValueChange={(v) => setBranchId(v ? Number(v) : "")}
            >
              <option value="">الكل</option>
              {branches.data?.map((b) => (<option key={b.id} value={b.id}>{b.name}</option>))}
            </AppSelect>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">بحث مورّد</label>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="اسم المورّد…"
              aria-label="بحث مورّد"
              className="h-9 w-48"
            />
          </div>
        </div>
      }
    >
      <Card>
        <CardContent className="p-0">
          {q.isLoading ? (
            <LoadingState />
          ) : q.isError ? (
            <ErrorState message="تعذّر تحميل تقرير المشتريات." onRetry={() => q.refetch()} />
          ) : !rows.length ? (
            <p className="p-8 text-center text-sm text-muted-foreground">
              {allRows.length ? "لا مورّد مطابق للبحث." : "لا مشتريات في هذا النطاق."}
            </p>
          ) : (
            <ScrollTableShell bordered={false}>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="p-2.5 text-right font-medium">المورّد</th>
                    <th className="p-2.5 text-right font-medium">عدد الأوامر</th>
                    <th className="p-2.5 text-right font-medium">الإجمالي</th>
                    <th className="p-2.5 text-right font-medium">المدفوع</th>
                    <th className="p-2.5 text-right font-medium">المتبقّي</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r: Row, i: number) => (
                    <tr key={r.supplierId ?? `no-supplier-${i}`} className="border-b last:border-0 hover:bg-accent/40">
                      <td className="p-2.5 text-right">
                        {r.supplierId ? (
                          <Link href={`/suppliers-statement?id=${r.supplierId}`} className="text-primary hover:underline">
                            {r.supplierName ?? "—"}
                          </Link>
                        ) : (
                          r.supplierName ?? "—"
                        )}
                      </td>
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{r.orders}</td>
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{fmtAr(r.total)}</td>
                      <td className="p-2.5 text-right tabular-nums text-money-positive" dir="ltr">{fmtAr(r.paid)}</td>
                      <td className="p-2.5 text-right tabular-nums text-[var(--stock-low)]" dir="ltr">{fmtAr(r.unpaid)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollTableShell>
          )}
        </CardContent>
      </Card>
    </ReportShell>
  );
}
