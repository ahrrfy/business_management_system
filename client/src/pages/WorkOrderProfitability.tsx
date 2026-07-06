// ربحية أوامر الشغل (Job Costing) — أيّ أنواع الأعمال تربح فعلاً؟
// أمرٌ-أمراً: الإيراد (صافٍ قبل الضريبة من الفاتورة المرتبطة) − تكلفة المواد (لقطة
// startWorkOrder) − كلفة عملٍ اختيارية بالزمن الفعلي المُقاس (workSeconds × كلفة الساعة).
// حقل «كلفة ساعة العمل» ماذا-لو: تغييره يُعيد الاستعلام فيعيد حساب الربح/الهامش فوراً.
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Clock3, FileSpreadsheet, Loader2 } from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { PageHeader } from "@/components/PageHeader";
import { DateRangeFilter, type DateRange } from "@/components/table/DateRangeFilter";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { MoneyInput } from "@/components/form/MoneyInput";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { fmtAr } from "@/lib/money";
import { exportRows } from "@/lib/export";
import { fetchAllPaged } from "@/lib/fetchAllRows";

type Row = RouterOutputs["reports"]["workOrderProfitability"]["rows"][number];

const PAGE = 100;
const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** YYYY-MM-DD محلّياً (نفس نمط DateRangeFilter — لا toISOString/UTC). */
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function monthStart(): string {
  const now = new Date();
  return ymd(new Date(now.getFullYear(), now.getMonth(), 1));
}

export default function WorkOrderProfitability() {
  const utils = trpc.useUtils();
  // الافتراضي: من أول الشهر إلى اليوم (الـAPI يتطلب from/to).
  const [range, setRange] = useState<DateRange>({ from: monthStart(), to: ymd(new Date()) });
  const [branchId, setBranchId] = useState<number | "">("");
  // كلفة ساعة العمل — نصّ مالي؛ يُطبَّق على الاستعلام بعد مهلة قصيرة (debounce) كي لا
  // نقصف الخادم بكل خانة تُكتب، ويبقى «يعيد الاستعلام عند تغييره» محسوساً فورياً.
  const [laborRate, setLaborRate] = useState("");
  const [appliedRate, setAppliedRate] = useState("");
  const [page, setPage] = useState(0);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      setAppliedRate(laborRate);
      setPage(0);
    }, 400);
    return () => clearTimeout(t);
  }, [laborRate]);

  const branches = trpc.branches.list.useQuery();
  const rangeReady = Boolean(range.from && range.to);
  const queryInput = {
    from: range.from,
    to: range.to,
    branchId: branchId ? Number(branchId) : undefined,
    laborRatePerHour: appliedRate || undefined,
  };
  const q = trpc.reports.workOrderProfitability.useQuery(
    { ...queryInput, limit: PAGE, offset: page * PAGE },
    { enabled: rangeReady },
  );

  const rows = q.data?.rows ?? [];
  const totals = q.data?.totals;
  const totalCount = q.data?.totalCount ?? 0;
  const pages = Math.max(1, Math.ceil(totalCount / PAGE));
  const hasRate = Boolean(appliedRate);

  function changeRange(r: DateRange) {
    setRange(r);
    setPage(0);
  }

  async function onExport() {
    setExporting(true);
    try {
      const all = await fetchAllPaged<Row>(
        (offset, limit) =>
          utils.reports.workOrderProfitability
            .fetch({ ...queryInput, limit, offset })
            .then((r) => ({ rows: r.rows, total: r.totalCount })),
        { pageSize: 500 },
      );
      exportRows(all, {
        filename: `ربحية-أوامر-الشغل-${range.from}-${range.to}`,
        title: "ربحية أوامر الشغل (Job Costing)",
        meta: [
          { label: "الفترة", value: `${range.from} — ${range.to}` },
          {
            label: "الفرع",
            value: branchId
              ? (branches.data?.find((b) => b.id === Number(branchId))?.name ?? String(branchId))
              : "الكل",
          },
          { label: "كلفة ساعة العمل", value: hasRate ? `${appliedRate} د.ع` : "غير محدّدة" },
        ],
        columns: [
          { key: "deliveredAt", header: "تاريخ التسليم" },
          { key: "orderNumber", header: "رقم الأمر" },
          { key: "title", header: "العمل" },
          { key: "customerName", header: "العميل", map: (r) => r.customerName ?? "" },
          { key: "branchName", header: "الفرع", map: (r) => r.branchName ?? "" },
          { key: "invoiceNumber", header: "الفاتورة", map: (r) => r.invoiceNumber ?? "" },
          { key: "revenue", header: "الإيراد", money: true, map: (r) => Number(r.revenue) },
          { key: "materialsCost", header: "تكلفة المواد", money: true, map: (r) => Number(r.materialsCost) },
          { key: "hours", header: "ساعات العمل", map: (r) => (r.hours == null ? "" : Number(r.hours)) },
          { key: "laborCost", header: "كلفة العمل", money: true, map: (r) => (r.laborCost == null ? "" : Number(r.laborCost)) },
          { key: "profit", header: "الربح", money: true, map: (r) => Number(r.profit) },
          { key: "marginPct", header: "الهامش %", map: (r) => (r.marginPct == null ? "" : Number(r.marginPct)) },
        ],
        totalsRow: totals
          ? {
              deliveredAt: "الإجمالي",
              orderNumber: `${totals.count} أمر`,
              revenue: Number(totals.revenue),
              materialsCost: Number(totals.materialsCost),
              hours: Number(totals.hours),
              laborCost: totals.laborCost == null ? "" : Number(totals.laborCost),
              profit: Number(totals.profit),
              marginPct: totals.marginPct == null ? "" : Number(totals.marginPct),
            }
          : undefined,
      });
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="ربحية أوامر الشغل"
        description="إيراد كل أمر مُسلَّم مقابل تكلفة مواده وزمن تنفيذه الفعلي — لمعرفة أي الأعمال تربح فعلاً."
        icon={<Clock3 aria-hidden className="size-6 text-muted-foreground" />}
        actions={
          <Button variant="outline" size="sm" disabled={!rows.length || exporting} onClick={onExport}>
            {exporting ? (
              <Loader2 aria-hidden className="size-4 animate-spin" />
            ) : (
              <FileSpreadsheet aria-hidden className="size-4" />
            )}
            تصدير Excel
          </Button>
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <DateRangeFilter value={range} onChange={changeRange} />
        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">الفرع</Label>
          <select
            className={selectCls}
            value={branchId}
            onChange={(e) => {
              setBranchId(e.target.value ? Number(e.target.value) : "");
              setPage(0);
            }}
          >
            <option value="">الكل</option>
            {branches.data?.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">كلفة ساعة العمل (د.ع) — اختياري</Label>
          <MoneyInput
            value={laborRate}
            onChange={setLaborRate}
            placeholder="مثال: 5000"
            className="h-9 w-44"
            ariaLabel="كلفة ساعة العمل بالدينار العراقي"
          />
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {!rangeReady ? (
            <p className="p-8 text-center text-sm text-muted-foreground">حدّد مدى التاريخ (من/إلى) لعرض التقرير.</p>
          ) : q.isLoading ? (
            <p className="p-8 text-center text-sm text-muted-foreground">جارٍ التحميل…</p>
          ) : !rows.length ? (
            <p className="p-8 text-center text-sm text-muted-foreground">لا أوامر مُسلَّمة في هذا النطاق.</p>
          ) : (
            <ScrollTableShell bordered={false}>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="p-2.5 text-end font-medium">تاريخ التسليم</th>
                    <th className="p-2.5 text-end font-medium">رقم الأمر</th>
                    <th className="p-2.5 text-end font-medium">العمل</th>
                    <th className="p-2.5 text-end font-medium">العميل</th>
                    <th className="p-2.5 text-end font-medium">الفاتورة</th>
                    <th className="p-2.5 text-right font-medium">الإيراد</th>
                    <th className="p-2.5 text-right font-medium">تكلفة المواد</th>
                    <th className="p-2.5 text-right font-medium">ساعات العمل</th>
                    <th className="p-2.5 text-right font-medium">كلفة العمل</th>
                    <th className="p-2.5 text-right font-medium">الربح</th>
                    <th className="p-2.5 text-right font-medium">الهامش %</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b last:border-0 hover:bg-accent/40">
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{r.deliveredAt}</td>
                      <td className="p-2.5 text-end">
                        <Link href={`/work-orders/${r.id}`} className="text-primary underline-offset-2 hover:underline">
                          {r.orderNumber}
                        </Link>
                      </td>
                      <td className="p-2.5 text-end max-w-56 truncate" title={r.title}>{r.title}</td>
                      <td className="p-2.5 text-end">{r.customerName ?? "—"}</td>
                      <td className="p-2.5 text-end">
                        {r.invoiceId ? (
                          <Link href={`/invoices/${r.invoiceId}`} className="text-primary underline-offset-2 hover:underline">
                            {r.invoiceNumber ?? String(r.invoiceId)}
                          </Link>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{fmtAr(r.revenue)}</td>
                      <td className="p-2.5 text-right tabular-nums text-muted-foreground" dir="ltr">{fmtAr(r.materialsCost)}</td>
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{r.hours == null ? "—" : fmtAr(r.hours)}</td>
                      <td className="p-2.5 text-right tabular-nums text-muted-foreground" dir="ltr">
                        {r.laborCost == null ? "—" : fmtAr(r.laborCost)}
                      </td>
                      <td
                        className={`p-2.5 text-right tabular-nums font-medium ${r.profit.startsWith("-") ? "text-destructive" : ""}`}
                        dir="ltr"
                      >
                        {fmtAr(r.profit)}
                      </td>
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">
                        {r.marginPct == null ? "—" : `${fmtAr(r.marginPct)}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
                {totals && (
                  <tfoot>
                    <tr className="border-t-2 bg-muted/60 font-semibold">
                      <td className="p-2.5 text-end" colSpan={5}>
                        الإجمالي ({totals.count} أمر)
                      </td>
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{fmtAr(totals.revenue)}</td>
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{fmtAr(totals.materialsCost)}</td>
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{fmtAr(totals.hours)}</td>
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">
                        {totals.laborCost == null ? "—" : fmtAr(totals.laborCost)}
                      </td>
                      <td
                        className={`p-2.5 text-right tabular-nums ${totals.profit.startsWith("-") ? "text-destructive" : ""}`}
                        dir="ltr"
                      >
                        {fmtAr(totals.profit)}
                      </td>
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">
                        {totals.marginPct == null ? "—" : `${fmtAr(totals.marginPct)}%`}
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </ScrollTableShell>
          )}
        </CardContent>
      </Card>

      {!hasRate && rows.length > 0 && (
        <p className="text-xs text-muted-foreground">
          الربح المعروض = الإيراد − تكلفة المواد. أدخل «كلفة ساعة العمل» أعلاه لاحتساب كلفة الزمن الفعلي أيضاً.
        </p>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-center gap-3 text-sm">
          <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
            السابق
          </Button>
          <span className="text-muted-foreground tabular-nums">
            صفحة {page + 1} من {pages}
          </span>
          <Button variant="outline" size="sm" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
            التالي
          </Button>
        </div>
      )}
    </div>
  );
}
