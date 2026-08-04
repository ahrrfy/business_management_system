// سجلّ المشتريات — تفصيل بنود أوامر الشراء (مرآة السجلّ التفصيلي للمبيعات). عرض + تصدير + طباعة.
// المصدر: reports.purchaseRegister (كل البنود عدا الملغاة ضمن الفترة) — ترقيم صفحات بالخادم (limit/offset).
import { useState } from "react";
import { Link } from "wouter";
import { Search } from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { PeriodFilter, DEFAULT_PERIOD, type PeriodValue } from "@/components/reports/PeriodFilter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AppSelect } from "@/components/ui/AppSelect";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { LoadingState, ErrorState } from "@/components/PageState";
import { fmtAr, fmtInt } from "@/lib/money";
import { exportRows } from "@/lib/export";
import { fetchAllPaged } from "@/lib/fetchAllRows";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";

type Row = RouterOutputs["reports"]["purchaseRegister"]["rows"][number];
const PAGE = 200;
const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export default function PurchaseRegister() {
  const [period, setPeriod] = useState<PeriodValue>(DEFAULT_PERIOD);
  const [branchId, setBranchId] = useState<number | "">("");
  const [supplierId, setSupplierId] = useState<number | "">("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [printing, setPrinting] = useState(false);

  const dq = useDebouncedValue(query, 250);
  const utils = trpc.useUtils();
  const branches = trpc.branches.list.useQuery();
  const suppliers = trpc.reports.suppliersIndex.useQuery();
  const q = trpc.reports.purchaseRegister.useQuery({
    from: period.from,
    to: period.to,
    branchId: branchId ? Number(branchId) : undefined,
    supplierId: supplierId ? Number(supplierId) : undefined,
    q: dq.trim() || undefined,
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
        { label: "الإجمالي", value: fmtAr(totals.amount), tone: "info" },
      ]
    : [];

  const periodLabel = `${period.from} — ${period.to}`;

  // إعادة ضبط الصفحة عند تغيّر الفلاتر.
  function changePeriod(p: PeriodValue) { setPeriod(p); setPage(0); }

  // فلتر الاستعلام الحالي (بلا limit/offset) — مشترك بين التصدير والطباعة (يبقى المطبوع مطابقاً للمُصدَّر).
  function currentFilter() {
    return {
      from: period.from,
      to: period.to,
      branchId: branchId ? Number(branchId) : undefined,
      supplierId: supplierId ? Number(supplierId) : undefined,
      q: dq.trim() || undefined,
    };
  }

  async function onExport() {
    setExporting(true);
    try {
      // جلب كل البنود المطابقة للفلاتر الحالية (لا الصفحة المعروضة فقط).
      const all = await fetchAllPaged<Row>(
        (offset, limit) =>
          utils.reports.purchaseRegister
            .fetch({ ...currentFilter(), limit, offset })
            .then((r) => ({ rows: (r.rows ?? []) as Row[], total: r.total })),
        { pageSize: 500 },
      );
      exportRows(all, {
        filename: `سجلّ-المشتريات-${period.from}-${period.to}`,
        columns: [
          { key: "orderDate", header: "التاريخ" },
          { key: "poNumber", header: "أمر الشراء", map: (r) => r.poNumber ?? `#${r.poId}` },
          { key: "supplierName", header: "المورّد", map: (r) => r.supplierName ?? "" },
          { key: "productName", header: "المنتج", map: (r) => r.productName ?? "" },
          { key: "quantity", header: "الكمية", map: (r) => Number(r.quantity) },
          { key: "unitPrice", header: "سعر الوحدة", map: (r) => Number(r.unitPrice) },
          { key: "total", header: "الإجمالي", map: (r) => Number(r.total) },
        ],
      });
    } finally {
      setExporting(false);
    }
  }

  // كانت الطباعة تطبع الصفحة المعروضة فقط (limit=200) — الآن تجلب كل الصفحات المطابقة (نمط onExport).
  async function onPrint() {
    setPrinting(true);
    try {
      const all = await fetchAllPaged<Row>(
        (offset, limit) =>
          utils.reports.purchaseRegister
            .fetch({ ...currentFilter(), limit, offset })
            .then((r) => ({ rows: (r.rows ?? []) as Row[], total: r.total })),
        { pageSize: 500 },
      );
      printReportDoc({
        title: "سجلّ المشتريات (تفصيل البنود)",
        headerExtra: [
          { label: "الفترة", value: periodLabel },
          { label: "الفرع", value: branchId ? (branches.data?.find((b) => b.id === branchId)?.name ?? String(branchId)) : "الكل" },
        ],
        columns: [
          { key: "date", label: "التاريخ" },
          { key: "po", label: "أمر الشراء" },
          { key: "supplier", label: "المورّد" },
          { key: "product", label: "المنتج" },
          { key: "qty", label: "الكمية", align: "left" },
          { key: "unitPrice", label: "سعر الوحدة", align: "left" },
          { key: "total", label: "الإجمالي", align: "left" },
        ],
        rows: all.map((r) => ({
          date: r.orderDate,
          po: r.poNumber ?? `#${r.poId}`,
          supplier: r.supplierName ?? "—",
          product: r.productName ?? "—",
          qty: r.quantity,
          unitPrice: fmtAr(r.unitPrice),
          total: fmtAr(r.total),
        })),
        summary: totals
          ? [{ label: "إجمالي البنود", value: fmtAr(totals.amount), large: true, bold: true }]
          : undefined,
      });
    } finally {
      setPrinting(false);
    }
  }

  return (
    <ReportShell
      title="سجلّ المشتريات"
      description="تفصيل بنود أوامر الشراء بفلاتر وتنقّل لأمر الشراء."
      kpis={kpis}
      onExport={onExport}
      onPrint={onPrint}
      exportDisabled={!total || exporting}
      printDisabled={!rows.length || printing}
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
            <label className="text-[11px] text-muted-foreground">المورّد</label>
            <AppSelect
              className="w-48"
              value={supplierId ? String(supplierId) : ""}
              onValueChange={(v) => { setSupplierId(v ? Number(v) : ""); setPage(0); }}
              placeholder="الكل"
            >
              <option value="">الكل</option>
              {suppliers.data?.map((s) => (<option key={s.id} value={s.id}>{s.name}</option>))}
            </AppSelect>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">بحث</label>
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 right-2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                value={query}
                onChange={(e) => { setQuery(e.target.value); setPage(0); }}
                placeholder="رقم الأمر أو المورّد أو المنتج…"
                className="h-9 w-56 pr-8"
              />
            </div>
          </div>
        </div>
      }
    >
      <Card>
        <CardContent className="p-0">
          {q.isLoading ? (
            <LoadingState />
          ) : q.isError ? (
            <ErrorState message="تعذّر تحميل التقرير." onRetry={() => void q.refetch()} />
          ) : !rows.length ? (
            <p className="p-8 text-center text-sm text-muted-foreground">لا بنود مشتريات في هذا النطاق.</p>
          ) : (
            <ScrollTableShell bordered={false}>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="p-2.5 text-end font-medium">التاريخ</th>
                    <th className="p-2.5 text-end font-medium">أمر الشراء</th>
                    <th className="p-2.5 text-end font-medium">المورّد</th>
                    <th className="p-2.5 text-end font-medium">المنتج</th>
                    <th className="p-2.5 text-start font-medium">الكمية</th>
                    <th className="p-2.5 text-start font-medium">سعر الوحدة</th>
                    <th className="p-2.5 text-start font-medium">الإجمالي</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r: Row) => (
                    <tr key={r.id} className="border-b last:border-0 hover:bg-accent/40">
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{r.orderDate}</td>
                      <td className="p-2.5 text-end">
                        <Link href={`/purchases/${r.poId}`} className="text-primary underline-offset-2 hover:underline">
                          {r.poNumber ?? `#${r.poId}`}
                        </Link>
                      </td>
                      <td className="p-2.5 text-end">{r.supplierName ?? "—"}</td>
                      <td className="p-2.5 text-end">{r.productName ?? "—"}</td>
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{fmtInt(r.quantity)}</td>
                      <td className="p-2.5 text-right tabular-nums text-muted-foreground" dir="ltr">{fmtAr(r.unitPrice)}</td>
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{fmtAr(r.total)}</td>
                    </tr>
                  ))}
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
