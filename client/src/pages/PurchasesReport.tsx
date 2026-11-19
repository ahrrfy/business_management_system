// تقرير المشتريات — ملخّص حسب المورّد (مرآة تقرير المبيعات). عرض + بحث مورّد + تصدير Excel + طباعة A4.
// المصدر: reports.purchasesReport (أوامر شراء ملتزمة CONFIRMED/RECEIVED ضمن الفترة).
import { useMemo, useState } from "react";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { Link } from "wouter";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { DEFAULT_PERIOD } from "@/components/reports/PeriodFilter";
import { StatementPeriodDetailBar, type StatementDetailLevel } from "@/components/statements/PartyCommandBar";
import { AppSelect } from "@/components/ui/AppSelect";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import { Card, CardContent } from "@/components/ui/card";
import { fmtDate } from "@/lib/date";
import { D, fmtAr } from "@/lib/money";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";
import type { StatementLineItem } from "@/lib/statementPeriodLedger";
import { fmtQty } from "@shared/quantityFormat";

type Row = RouterOutputs["reports"]["purchasesReport"]["rows"][number];

interface PurchaseOrderDetail {
  purchaseOrderId: number;
  id?: number;
  poNumber: string;
  orderDate: string | Date;
  total: string;
  items: StatementLineItem[];
}

function formatOrdersDetailText(orders: PurchaseOrderDetail[] | undefined): string {
  if (!orders?.length) return "";
  return orders
    .map((o) => {
      const itemsStr = o.items
        .map((it) => `${it.productName} × ${fmtQty(it.quantity)} = ${fmtAr(it.total)}`)
        .join("، ");
      return `${o.poNumber} (${fmtDate(o.orderDate)}): ${itemsStr || fmtAr(o.total)}`;
    })
    .join(" | ");
}

export default function PurchasesReport() {
  const [period, setPeriod] = useState<{ from: string; to: string }>(() => {
    const initial = DEFAULT_PERIOD();
    return { from: initial.from, to: initial.to };
  });
  const [detailLevel, setDetailLevel] = useState<StatementDetailLevel>("normal");
  const [branchId, setBranchId] = useState<number | "">("");
  const [search, setSearch] = useState("");

  const branches = trpc.branches.list.useQuery();
  const q = trpc.reports.purchasesReport.useQuery({
    from: period.from,
    to: period.to,
    branchId: branchId ? Number(branchId) : undefined,
    includeItems: detailLevel === "detailed",
  });

  const allRows = q.data?.rows ?? [];
  const rows = useMemo(() => {
    if (!search) return allRows;
    const lower = search.toLowerCase();
    return allRows.filter((r) => (r.supplierName ?? "").toLowerCase().includes(lower));
  }, [allRows, search]);
  const totals = q.data?.totals;
  const displayTotals = useMemo(() => {
    if (!totals) return undefined;
    if (!search) return totals;
    let count = 0;
    let total = D(0);
    let paid = D(0);
    let unpaid = D(0);
    for (const r of rows) {
      count += Number(r.orders || 0);
      total = total.plus(D(r.total || 0));
      paid = paid.plus(D(r.paid || 0));
      unpaid = unpaid.plus(D(r.unpaid || 0));
    }
    return { count, total: total.toFixed(2), paid: paid.toFixed(2), unpaid: unpaid.toFixed(2) };
  }, [totals, search, rows]);

  const kpis: KpiItem[] = displayTotals
    ? [
        { label: "عدد الأوامر", value: displayTotals.count },
        { label: "الإجمالي", value: fmtAr(displayTotals.total), tone: "info" },
        { label: "المدفوع", value: fmtAr(displayTotals.paid), tone: "positive" },
        { label: "المتبقي", value: fmtAr(displayTotals.unpaid), tone: "warning" },
      ]
    : [];

  const periodLabel = `${period.from} — ${period.to}`;

  function onExport() {
    exportRows(rows, {
      filename: `تقرير-المشتريات-${period.from}-${period.to}`,
      columns: [
        { key: "supplierName", header: "المورد", map: (r) => r.supplierName ?? "—" },
        { key: "orders", header: "عدد الأوامر", map: (r) => r.orders },
        { key: "total", header: "الإجمالي", map: (r) => D(r.total).toNumber() },
        { key: "paid", header: "المدفوع", map: (r) => D(r.paid).toNumber() },
        { key: "unpaid", header: "المتبقي", map: (r) => D(r.unpaid).toNumber() },
        ...(detailLevel === "detailed"
          ? [
              {
                key: "ordersDetail" as const,
                header: "تفاصيل الأوامر والبنود",
                map: (r: Row) => formatOrdersDetailText((r as Row & { ordersDetail?: PurchaseOrderDetail[] }).ordersDetail),
              },
            ]
          : []),
      ],
    });
  }

  function onPrint() {
    const detailed = detailLevel === "detailed";
    printReportDoc({
      title: "تقرير المشتريات (حسب المورد)",
      headerExtra: [
        { label: "الفترة", value: periodLabel },
        { label: "الفرع", value: branchId ? (branches.data?.find((b) => b.id === branchId)?.name ?? String(branchId)) : "الكل" },
      ],
      columns: [
        { key: "supplier", label: "المورد" },
        ...(detailed ? [{ key: "details", label: "تفاصيل الأوامر والبنود" }] : []),
        { key: "orders", label: "عدد الأوامر", align: "left" },
        { key: "total", label: "الإجمالي", align: "left" },
        { key: "paid", label: "المدفوع", align: "left" },
        { key: "unpaid", label: "المتبقي", align: "left" },
      ],
      rows: rows.map((r) => ({
        supplier: r.supplierName ?? "—",
        ...(detailed
          ? { details: formatOrdersDetailText((r as Row & { ordersDetail?: PurchaseOrderDetail[] }).ordersDetail) || "—" }
          : {}),
        orders: String(r.orders),
        total: fmtAr(r.total),
        paid: fmtAr(r.paid),
        unpaid: fmtAr(r.unpaid),
      })),
      summary: displayTotals
        ? [
            { label: "عدد الأوامر", value: String(displayTotals.count) },
            { label: "المدفوع", value: fmtAr(displayTotals.paid) },
            { label: "المتبقي", value: fmtAr(displayTotals.unpaid) },
            { label: "الإجمالي", value: fmtAr(displayTotals.total), large: true, bold: true },
          ]
        : undefined,
    });
  }
  /** أعمدة تقرير المشتريات حسب المورد. */
  const purchaseColumns = useMemo<ColumnDef<Row, unknown>[]>(() => [
    {
      id: "supplier",
      header: "المورد",
      accessorFn: (r) => r.supplierName ?? "—",
      cell: ({ row }) => {
        const ordersDetail = (row.original as Row & { ordersDetail?: PurchaseOrderDetail[] }).ordersDetail;
        return (
          <div className="space-y-1.5">
            {row.original.supplierId ? (
              <Link href={`/suppliers-statement?id=${row.original.supplierId}`} className="text-primary hover:underline font-medium">
                {row.original.supplierName ?? "—"}
              </Link>
            ) : (
              <span>{row.original.supplierName ?? "—"}</span>
            )}
            {detailLevel === "detailed" && ordersDetail && ordersDetail.length > 0 && (
              <div className="space-y-1 rounded border border-border/50 bg-muted/30 p-2 text-[11px]">
                {ordersDetail.map((ord) => {
                  const orderId = ord.purchaseOrderId ?? ord.id;
                  return (
                  <div key={orderId ?? ord.poNumber} className="space-y-0.5">
                    <div className="flex items-center justify-between gap-2 font-semibold text-foreground">
                      <Link href={`/purchases/${orderId}`} className="font-mono text-primary hover:underline" dir="ltr">
                        {ord.poNumber}
                      </Link>
                      <span className="text-muted-foreground tabular-nums" dir="ltr">
                        {fmtDate(ord.orderDate)} · {fmtAr(ord.total)}
                      </span>
                    </div>
                    {ord.items.map((it, idx) => (
                      <div key={idx} className="flex items-center justify-between gap-2 text-muted-foreground ps-2">
                        <span>{it.productName}{it.unitName ? ` (${it.unitName})` : ""}</span>
                        <span className="tabular-nums" dir="ltr">
                          {fmtQty(it.quantity)} × {fmtAr(it.unitPrice)} = {fmtAr(it.total)}
                        </span>
                      </div>
                    ))}
                  </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      },
      meta: { kind: "text", width: detailLevel === "detailed" ? "wide" : undefined, wrap: true },
    },
    { id: "orders", header: "عدد الأوامر", accessorFn: (r) => Number(r.orders), meta: { kind: "number" } },
    {
      id: "total",
      header: "الإجمالي",
      accessorFn: (r) => D(r.total).toNumber(),
      sortingFn: (a, b) => D(a.original.total).cmp(D(b.original.total)),
      cell: ({ row }) => fmtAr(row.original.total),
      meta: { kind: "money" },
    },
    {
      id: "paid",
      header: "المدفوع",
      accessorFn: (r) => D(r.paid).toNumber(),
      sortingFn: (a, b) => D(a.original.paid).cmp(D(b.original.paid)),
      cell: ({ row }) => <span className="text-money-positive">{fmtAr(row.original.paid)}</span>,
      meta: { kind: "money" },
    },
    {
      id: "unpaid",
      header: "المتبقي",
      accessorFn: (r) => D(r.unpaid).toNumber(),
      sortingFn: (a, b) => D(a.original.unpaid).cmp(D(b.original.unpaid)),
      cell: ({ row }) => <span className="text-[var(--stock-low)]">{fmtAr(row.original.unpaid)}</span>,
      meta: { kind: "money" },
    },
  ], [detailLevel]);

  return (
    <ReportShell
      title="تقرير المشتريات"
      description="إجمالي المشتريات حسب المورد (أوامر شراء مؤكدة/مستلمة)."
      kpis={kpis}
      onExport={onExport}
      onPrint={onPrint}
      exportDisabled={!rows.length}
      printDisabled={!rows.length}
      filters={
        <div className="space-y-2.5">
          <StatementPeriodDetailBar
            allowAllEmpty={false}
            from={period.from}
            to={period.to}
            onRangeChange={setPeriod}
            detailLevel={detailLevel}
            onDetailLevelChange={setDetailLevel}
          />
          <div className="flex flex-wrap items-end gap-3">
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
              <label className="text-[11px] text-muted-foreground">بحث مورد</label>
              <UnifiedSearchInput
                debounceMs={0}
                value={search}
                onChange={setSearch}
                placeholder="اسم المورد…"
                aria-label="بحث مورد"
                className="w-48"
                barcode={false}
              />
            </div>
          </div>
        </div>
      }
    >
      <Card>
        <CardContent className="p-0">
          <DataTable
            columns={purchaseColumns}
            data={rows}
            loading={q.isLoading}
            searchable={false}
            errorState={{ isError: q.isError, message: "تعذّر تحميل تقرير المشتريات.", onRetry: () => void q.refetch() }}
            emptyText={allRows.length ? "لا مورّد مطابق للبحث." : "لا مشتريات في هذا النطاق."}
          />
        </CardContent>
      </Card>
    </ReportShell>
  );
}
