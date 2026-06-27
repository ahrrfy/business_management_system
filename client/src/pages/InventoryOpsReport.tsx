// تقارير المخزون التشغيلية — قرارات لا كميات.
// عروض: إعادة الطلب · راكد عالي القيمة · خطر النفاد · فروقات الجرد. + رابط الكاردكس (بطاقة المنتج).
// يُركّب endpoints (stockStatus/deadStockValue/reorderRisk/stocktakeVariance). عرض + Excel + طباعة A4.
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { FolderOpen } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { Card, CardContent } from "@/components/ui/card";
import { LoadingState, TableEmptyRow } from "@/components/PageState";
import { exportRows, type ExportColumn } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { fmtInt, fmtAr, formatIqd } from "@/lib/money";
import { fmtDate } from "@/lib/date";

type View = "reorder" | "dead" | "risk" | "variance";

const VIEW_LABEL: Record<View, string> = {
  reorder: "إعادة الطلب",
  dead: "راكد عالي القيمة",
  risk: "خطر النفاد",
  variance: "فروقات الجرد",
};
const VIEW_DESC: Record<View, string> = {
  reorder: "أصناف نفدت أو تحت حدّ الطلب — اطلبها الآن.",
  dead: "رصيد بلا بيع منذ مدّة — رأس مال مجمّد يجب تحريره.",
  risk: "مبيعات عالية ومخزون منخفض — اطلب عاجلاً قبل النفاد.",
  variance: "فروقات الجرد المعتمدة حسب الفرع والتاريخ.",
};
const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const STATUS_LABEL: Record<string, string> = { out: "نفد", low: "منخفض", ok: "طبيعي" };
const STATUS_CLS: Record<string, string> = { out: "badge-stock-out", low: "badge-stock-low", ok: "bg-muted text-muted-foreground" };

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export default function InventoryOpsReport() {
  const [view, setView] = useState<View>("reorder");
  const [branchId, setBranchId] = useState<number | "">("");
  const [deadDays, setDeadDays] = useState(90);
  const [riskDays, setRiskDays] = useState(30);
  const today = ymd(new Date());
  const monthAgo = useMemo(() => { const d = new Date(); d.setDate(d.getDate() - 90); return ymd(d); }, []);
  const [from, setFrom] = useState(monthAgo);
  const [to, setTo] = useState(today);
  const branchArg = branchId ? Number(branchId) : undefined;

  const branches = trpc.branches.list.useQuery();
  const reorder = trpc.reports.stockStatus.useQuery({ branchId: branchArg, onlyAlerts: true }, { enabled: view === "reorder", staleTime: 60_000 });
  const dead = trpc.reports.deadStockValue.useQuery({ branchId: branchArg, sinceDays: deadDays }, { enabled: view === "dead", staleTime: 60_000 });
  const risk = trpc.reports.reorderRisk.useQuery({ branchId: branchArg, sinceDays: riskDays }, { enabled: view === "risk", staleTime: 60_000 });
  const variance = trpc.reports.stocktakeVariance.useQuery({ branchId: branchArg, from, to }, { enabled: view === "variance", staleTime: 60_000 });

  const loading =
    (view === "reorder" && reorder.isLoading) ||
    (view === "dead" && dead.isLoading) ||
    (view === "risk" && risk.isLoading) ||
    (view === "variance" && variance.isLoading);

  const branchLabel = branchId ? (branches.data?.find((b) => b.id === branchId)?.name ?? String(branchId)) : "الكل";

  const kpis: KpiItem[] = useMemo(() => {
    if (view === "reorder" && reorder.data) {
      return [
        { label: "نفد", value: fmtInt(reorder.data.totals.outCount), tone: "negative" },
        { label: "منخفض", value: fmtInt(reorder.data.totals.lowCount), tone: "warning" },
        { label: "السطور", value: fmtInt(reorder.data.rows.length), tone: "info" },
      ];
    }
    if (view === "dead" && dead.data) {
      return [
        { label: "أصناف راكدة", value: fmtInt(dead.data.summary.count), tone: "warning" },
        { label: "رأس المال المجمّد", value: formatIqd(dead.data.summary.totalValue), tone: "negative" },
      ];
    }
    if (view === "risk" && risk.data) {
      return [{ label: "أصناف بخطر نفاد", value: fmtInt(risk.data.summary.count), tone: "warning" }];
    }
    if (view === "variance" && variance.data) {
      return [
        { label: "فروقات", value: fmtInt(variance.data.summary.count), tone: "info" },
        { label: "صافي القيمة", value: formatIqd(variance.data.summary.netValue), tone: Number(variance.data.summary.netValue) < 0 ? "negative" : "positive" },
        { label: "إجمالي مطلق", value: formatIqd(variance.data.summary.absValue), tone: "warning" },
      ];
    }
    return [];
  }, [view, reorder.data, dead.data, risk.data, variance.data]);

  // ── التصدير + الطباعة لكل عرض ──
  type AnyRow = Record<string, unknown>;
  function exportConfig(): { rows: AnyRow[]; columns: ExportColumn<AnyRow>[]; printCols: { key: string; label: string; align?: "left" }[] } {
    if (view === "reorder") {
      const rows = (reorder.data?.rows ?? []) as unknown as AnyRow[];
      return {
        rows,
        columns: [
          { key: "productName", header: "المنتج" },
          { key: "variantLabel", header: "المتغيّر" },
          { key: "branchName", header: "الفرع", map: (r) => (r.branchName as string) ?? "" },
          { key: "quantity", header: "الكمية", map: (r) => Number(r.quantity) },
          { key: "minStock", header: "حدّ الطلب", map: (r) => Number(r.minStock) },
          { key: "status", header: "الحالة", map: (r) => STATUS_LABEL[r.status as string] ?? (r.status as string) },
        ],
        printCols: [
          { key: "productName", label: "المنتج" }, { key: "variantLabel", label: "المتغيّر" },
          { key: "branchName", label: "الفرع" }, { key: "quantity", label: "الكمية", align: "left" },
          { key: "minStock", label: "حدّ الطلب", align: "left" }, { key: "status", label: "الحالة" },
        ],
      };
    }
    if (view === "dead") {
      const rows = (dead.data?.rows ?? []) as unknown as AnyRow[];
      return {
        rows,
        columns: [
          { key: "productName", header: "المنتج" },
          { key: "variantLabel", header: "المتغيّر" },
          { key: "qtyInStock", header: "الرصيد", map: (r) => Number(r.qtyInStock) },
          { key: "stockValue", header: "قيمة المخزون", money: true, map: (r) => Number(r.stockValue) },
          { key: "daysSinceLastSale", header: "أيام بلا بيع", map: (r) => (r.daysSinceLastSale == null ? "لا بيع" : Number(r.daysSinceLastSale)) },
          { key: "lastSaleDate", header: "آخر بيع", map: (r) => (r.lastSaleDate as string) ?? "—" },
        ],
        printCols: [
          { key: "productName", label: "المنتج" }, { key: "variantLabel", label: "المتغيّر" },
          { key: "qtyInStock", label: "الرصيد", align: "left" }, { key: "stockValue", label: "قيمة المخزون", align: "left" },
          { key: "days", label: "أيام بلا بيع", align: "left" }, { key: "lastSaleDate", label: "آخر بيع" },
        ],
      };
    }
    if (view === "risk") {
      const rows = (risk.data?.rows ?? []) as unknown as AnyRow[];
      return {
        rows,
        columns: [
          { key: "productName", header: "المنتج" },
          { key: "variantLabel", header: "المتغيّر" },
          { key: "qtyInStock", header: "الرصيد", map: (r) => Number(r.qtyInStock) },
          { key: "threshold", header: "حدّ الطلب", map: (r) => Number(r.threshold) },
          { key: "qtySoldRecent", header: `مبيع ${riskDays}ي`, map: (r) => Number(r.qtySoldRecent) },
          { key: "coverDays", header: "أيام تغطية", map: (r) => (r.coverDays == null ? "" : Number(r.coverDays)) },
        ],
        printCols: [
          { key: "productName", label: "المنتج" }, { key: "variantLabel", label: "المتغيّر" },
          { key: "qtyInStock", label: "الرصيد", align: "left" }, { key: "threshold", label: "حدّ الطلب", align: "left" },
          { key: "qtySoldRecent", label: "المبيع", align: "left" }, { key: "coverDays", label: "أيام تغطية", align: "left" },
        ],
      };
    }
    const rows = (variance.data?.rows ?? []) as unknown as AnyRow[];
    return {
      rows,
      columns: [
        { key: "approvedDate", header: "التاريخ", map: (r) => (r.approvedDate as string) ?? "" },
        { key: "branchName", header: "الفرع", map: (r) => (r.branchName as string) ?? "" },
        { key: "approvedByName", header: "المعتمِد", map: (r) => (r.approvedByName as string) ?? "" },
        { key: "productName", header: "المنتج" },
        { key: "variantLabel", header: "المتغيّر" },
        { key: "diffQty", header: "الفرق", map: (r) => Number(r.diffQty) },
        { key: "value", header: "القيمة", money: true, map: (r) => Number(r.value) },
        { key: "reason", header: "السبب" },
      ],
      printCols: [
        { key: "approvedDate", label: "التاريخ" }, { key: "branchName", label: "الفرع" },
        { key: "productName", label: "المنتج" }, { key: "diffQty", label: "الفرق", align: "left" },
        { key: "value", label: "القيمة", align: "left" }, { key: "reason", label: "السبب" },
      ],
    };
  }

  function onExport() {
    const cfg = exportConfig();
    exportRows(cfg.rows, {
      filename: `مخزون-${VIEW_LABEL[view]}`,
      title: `المخزون التشغيلي — ${VIEW_LABEL[view]}`,
      meta: [{ label: "الفرع", value: branchLabel }, { label: "تاريخ الإصدار", value: fmtDate(new Date()) }],
      columns: cfg.columns,
    });
  }

  function onPrint() {
    const cfg = exportConfig();
    printReportDoc({
      title: `المخزون التشغيلي — ${VIEW_LABEL[view]}`,
      note: VIEW_DESC[view],
      headerExtra: [
        { label: "الفرع", value: branchLabel },
        ...(view === "variance" ? [{ label: "الفترة", value: `${from} — ${to}` }] : []),
        { label: "كما في", value: fmtDate(new Date()) },
      ],
      columns: cfg.printCols,
      rows: cfg.rows.map((r) => {
        const o: Record<string, string> = {};
        for (const pc of cfg.printCols) {
          const raw = pc.key === "days" ? (r.daysSinceLastSale == null ? "لا بيع" : fmtAr(Number(r.daysSinceLastSale)))
            : pc.key === "status" ? (STATUS_LABEL[r.status as string] ?? String(r.status ?? ""))
            : (r as Record<string, unknown>)[pc.key];
          const v = raw == null ? "" : typeof raw === "number" ? fmtAr(raw) : String(raw);
          o[pc.key] = ["quantity", "minStock", "qtyInStock", "threshold", "qtySoldRecent", "coverDays", "stockValue", "value", "diffQty"].includes(pc.key)
            ? fmtAr(Number((r as Record<string, unknown>)[pc.key] ?? 0))
            : v;
        }
        return o;
      }),
    });
  }

  const rowCount = exportConfig().rows.length;

  return (
    <ReportShell
      title="تقارير المخزون التشغيلية"
      description="قرارات تقلّل النفاد وتجميد رأس المال."
      note={VIEW_DESC[view]}
      kpis={kpis}
      onExport={onExport}
      onPrint={onPrint}
      exportDisabled={!rowCount}
      printDisabled={!rowCount}
      actions={
        <Link href="/reports/item-ledger" className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
          <FolderOpen className="size-4" aria-hidden /> كاردكس المنتج
        </Link>
      }
      filters={
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">العرض</label>
            <select className={selectCls} value={view} onChange={(e) => setView(e.target.value as View)}>
              {(Object.keys(VIEW_LABEL) as View[]).map((v) => (<option key={v} value={v}>{VIEW_LABEL[v]}</option>))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">الفرع</label>
            <select className={selectCls} value={branchId} onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : "")}>
              <option value="">الكل</option>
              {branches.data?.map((b) => (<option key={b.id} value={b.id}>{b.name}</option>))}
            </select>
          </div>
          {view === "dead" && (
            <div className="flex flex-col gap-1">
              <label className="text-[11px] text-muted-foreground">راكد منذ</label>
              <select className={selectCls} value={deadDays} onChange={(e) => setDeadDays(Number(e.target.value))}>
                <option value={90}>٩٠ يوماً</option>
                <option value={180}>١٨٠ يوماً</option>
                <option value={365}>٣٦٥ يوماً</option>
              </select>
            </div>
          )}
          {view === "risk" && (
            <div className="flex flex-col gap-1">
              <label className="text-[11px] text-muted-foreground">مبيعات آخر</label>
              <select className={selectCls} value={riskDays} onChange={(e) => setRiskDays(Number(e.target.value))}>
                <option value={30}>٣٠ يوماً</option>
                <option value={60}>٦٠ يوماً</option>
                <option value={90}>٩٠ يوماً</option>
              </select>
            </div>
          )}
          {view === "variance" && (
            <>
              <div className="flex flex-col gap-1">
                <label className="text-[11px] text-muted-foreground">من</label>
                <input type="date" className={selectCls} value={from} onChange={(e) => setFrom(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[11px] text-muted-foreground">إلى</label>
                <input type="date" className={selectCls} value={to} onChange={(e) => setTo(e.target.value)} />
              </div>
            </>
          )}
        </div>
      }
    >
      <Card>
        <CardContent className="p-0">
          {loading ? <LoadingState /> : <ViewTable view={view} reorder={reorder.data} dead={dead.data} risk={risk.data} variance={variance.data} riskDays={riskDays} />}
        </CardContent>
      </Card>
    </ReportShell>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="p-2.5 text-right font-medium">{children}</th>;
}
function NumTd({ children, cls }: { children: React.ReactNode; cls?: string }) {
  return <td className={`p-2.5 text-right tabular-nums ${cls ?? ""}`} dir="ltr">{children}</td>;
}

function ViewTable({
  view, reorder, dead, risk, variance, riskDays,
}: {
  view: View;
  reorder: any; dead: any; risk: any; variance: any; riskDays: number;
}) {
  if (view === "reorder") {
    const rows = reorder?.rows ?? [];
    return (
      <Table head={<><Th>المنتج</Th><Th>المتغيّر</Th><Th>الفرع</Th><Th>الكمية</Th><Th>حدّ الطلب</Th><Th>الحالة</Th></>} empty={!rows.length} colSpan={6} emptyMsg="لا تنبيهات مخزون في هذا النطاق.">
        {rows.map((r: any, i: number) => (
          <tr key={`${r.variantId}-${i}`} className="border-b last:border-0 hover:bg-accent/40">
            <td className="p-2.5 text-right">{r.productName}</td>
            <td className="p-2.5 text-right text-muted-foreground">{r.variantLabel}</td>
            <td className="p-2.5 text-right text-muted-foreground">{r.branchName ?? "—"}</td>
            <NumTd>{fmtInt(r.quantity)}</NumTd>
            <NumTd cls="text-muted-foreground">{fmtInt(r.minStock)}</NumTd>
            <td className="p-2.5 text-right"><span className={`inline-block rounded-full px-2 py-0.5 text-xs ${STATUS_CLS[r.status] ?? "bg-muted"}`}>{STATUS_LABEL[r.status] ?? r.status}</span></td>
          </tr>
        ))}
      </Table>
    );
  }
  if (view === "dead") {
    const rows = dead?.rows ?? [];
    return (
      <Table head={<><Th>المنتج</Th><Th>المتغيّر</Th><Th>الرصيد</Th><Th>قيمة المخزون</Th><Th>أيام بلا بيع</Th><Th>آخر بيع</Th></>} empty={!rows.length} colSpan={6} emptyMsg="لا مخزون راكد في هذا النطاق.">
        {rows.map((r: any) => (
          <tr key={r.variantId} className="border-b last:border-0 hover:bg-accent/40">
            <td className="p-2.5 text-right font-medium">{r.productName}</td>
            <td className="p-2.5 text-right text-muted-foreground">{r.variantLabel}</td>
            <NumTd>{fmtInt(r.qtyInStock)}</NumTd>
            <NumTd cls="text-money-negative">{fmtAr(r.stockValue)}</NumTd>
            <NumTd cls="text-stock-low">{r.daysSinceLastSale == null ? "لا بيع" : fmtAr(r.daysSinceLastSale)}</NumTd>
            <td className="p-2.5 text-right text-muted-foreground">{r.lastSaleDate ?? "—"}</td>
          </tr>
        ))}
      </Table>
    );
  }
  if (view === "risk") {
    const rows = risk?.rows ?? [];
    return (
      <Table head={<><Th>المنتج</Th><Th>المتغيّر</Th><Th>الرصيد</Th><Th>حدّ الطلب</Th><Th>{`مبيع ${riskDays}ي`}</Th><Th>أيام تغطية</Th></>} empty={!rows.length} colSpan={6} emptyMsg="لا أصناف بخطر نفاد في هذا النطاق.">
        {rows.map((r: any) => (
          <tr key={r.variantId} className="border-b last:border-0 hover:bg-accent/40">
            <td className="p-2.5 text-right font-medium">{r.productName}</td>
            <td className="p-2.5 text-right text-muted-foreground">{r.variantLabel}</td>
            <NumTd cls="text-stock-low">{fmtInt(r.qtyInStock)}</NumTd>
            <NumTd cls="text-muted-foreground">{fmtInt(r.threshold)}</NumTd>
            <NumTd cls="text-money-positive">{fmtInt(r.qtySoldRecent)}</NumTd>
            <NumTd>{r.coverDays == null ? "—" : fmtAr(r.coverDays)}</NumTd>
          </tr>
        ))}
      </Table>
    );
  }
  const rows = variance?.rows ?? [];
  return (
    <Table head={<><Th>التاريخ</Th><Th>الفرع</Th><Th>المعتمِد</Th><Th>المنتج</Th><Th>الفرق</Th><Th>القيمة</Th><Th>السبب</Th></>} empty={!rows.length} colSpan={7} emptyMsg="لا فروقات جرد معتمدة في هذا النطاق.">
      {rows.map((r: any, i: number) => (
        <tr key={`${r.sessionId}-${i}`} className="border-b last:border-0 hover:bg-accent/40">
          <td className="p-2.5 text-right text-muted-foreground">{r.approvedDate ?? "—"}</td>
          <td className="p-2.5 text-right text-muted-foreground">{r.branchName ?? "—"}</td>
          <td className="p-2.5 text-right text-muted-foreground">{r.approvedByName ?? "—"}</td>
          <td className="p-2.5 text-right">{r.productName}<span className="text-xs text-muted-foreground"> · {r.variantLabel}</span></td>
          <NumTd cls={r.diffQty < 0 ? "text-money-negative" : "text-money-positive"}>{fmtAr(r.diffQty)}</NumTd>
          <NumTd cls={Number(r.value) < 0 ? "text-money-negative" : "text-money-positive"}>{fmtAr(r.value)}</NumTd>
          <td className="p-2.5 text-right text-muted-foreground">{r.reason}</td>
        </tr>
      ))}
    </Table>
  );
}

function Table({ head, children, empty, colSpan, emptyMsg }: { head: React.ReactNode; children: React.ReactNode; empty: boolean; colSpan: number; emptyMsg: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead><tr className="border-b text-xs text-muted-foreground">{head}</tr></thead>
        <tbody>{empty ? <TableEmptyRow colSpan={colSpan} message={emptyMsg} /> : children}</tbody>
      </table>
    </div>
  );
}
