// تحليل ABC — تصنيف المنتجات حسب مساهمتها في الإيراد (باريتو) إلى فئات A/B/C.
// فلتر فترة + فرع + بحث/فئة محلّيان + مؤشّرات (عدد A/B/C + إجمالي الإيراد) + جدول مُرقَّم محلياً
// (المنتج/الإيراد/النسبة التراكمية/شارة الفئة).
import { useMemo, useState } from "react";
import { type ColumnDef } from "@tanstack/react-table";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { PeriodFilter, DEFAULT_PERIOD, type PeriodValue } from "@/components/reports/PeriodFilter";
import { AppSelect } from "@/components/ui/AppSelect";
import { Input } from "@/components/ui/input";
import { DataTable } from "@/components/data-table/DataTable";
import { ErrorState } from "@/components/PageState";
import { fmtAr } from "@/lib/money";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { selectCls } from "@/lib/ui/formStyles";

type Row = RouterOutputs["reports"]["abcAnalysis"]["rows"][number];
type ClassFilter = "" | "A" | "B" | "C";

const CLASS_CLS: Record<string, string> = {
  A: "badge-status-active",
  B: "badge-stock-low",
  C: "bg-muted text-foreground/70",
};
const CLASS_LABEL: Record<string, string> = {
  A: "أ (عالية)",
  B: "ب (متوسطة)",
  C: "ج (منخفضة)",
};


export default function AbcAnalysis() {
  const me = trpc.auth.me.useQuery();
  const role = me.data?.role ?? "";
  const canPickBranch = role === "admin"; // عزل مدير الفرع (قرار المالك ١٢/٨): المالك/الأدمن فقط يختاران فرعاً

  const [period, setPeriod] = useState<PeriodValue>(DEFAULT_PERIOD);
  const [branchId, setBranchId] = useState<number | "">("");
  const [search, setSearch] = useState("");
  const [cls, setCls] = useState<ClassFilter>("");

  const branches = trpc.branches.list.useQuery(undefined, { enabled: canPickBranch });
  const q = trpc.reports.abcAnalysis.useQuery({
    from: period.from,
    to: period.to,
    branchId: branchId ? Number(branchId) : undefined,
  });

  const allRows: Row[] = q.data?.rows ?? [];
  const totals = q.data?.totals;

  // بحث/فئة محلّيان فوق النتيجة المُحمَّلة أصلاً (التصنيف كلّه يُبنى دفعةً واحدة على الخادم).
  const rows: Row[] = useMemo(() => {
    const s = search.trim();
    return allRows.filter((r) => (!s || r.productName.includes(s)) && (!cls || r.class === cls));
  }, [allRows, search, cls]);

  const kpis: KpiItem[] = totals
    ? [
        { label: "إجمالي الإيراد", value: fmtAr(totals.revenue), tone: "info" },
        { label: "منتجات فئة A", value: totals.aCount, tone: "positive" },
        { label: "منتجات فئة B", value: totals.bCount, tone: "warning" },
        { label: "منتجات فئة C", value: totals.cCount },
      ]
    : [];

  const periodLabel = `${period.from} — ${period.to}`;
  const branchLabel = branchId
    ? (branches.data?.find((b) => Number(b.id) === Number(branchId))?.name ?? String(branchId))
    : "الكل";

  // أعمدة DataTable — الإيراد/النسبة التراكمية بفرزٍ رقميّ (accessorFn ⇒ Number). عمود «#» عرضٌ
  // بحت (بلا accessorFn ⇒ غير قابل للفرز) يعكس ترتيب الخادم الأصلي (تنازلياً حسب الإيراد) دوماً
  // بصرف النظر عن فرز الواجهة — لأنّه رتبة باريتو لا قيمة عمود.
  const cols = useMemo<ColumnDef<Row>[]>(
    () => [
      {
        id: "rank",
        header: "#",
        cell: ({ row }) => (
          <span dir="ltr" className="tabular-nums text-muted-foreground">
            {row.index + 1}
          </span>
        ),
      },
      { header: "المنتج", accessorKey: "productName" },
      {
        id: "revenue",
        header: "الإيراد",
        accessorFn: (r) => Number(r.revenue),
        cell: ({ row }) => <span dir="ltr" className="tabular-nums">{fmtAr(row.original.revenue)}</span>,
      },
      {
        id: "cumulativePct",
        header: "النسبة التراكمية",
        accessorFn: (r) => Number(r.cumulativePct),
        cell: ({ row }) => (
          <span dir="ltr" className="tabular-nums text-muted-foreground">{row.original.cumulativePct}%</span>
        ),
      },
      {
        header: "الفئة",
        accessorKey: "class",
        cell: ({ row }) => (
          <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${CLASS_CLS[row.original.class] ?? "bg-muted"}`}>
            {CLASS_LABEL[row.original.class] ?? row.original.class}
          </span>
        ),
      },
    ],
    [],
  );

  function onExport() {
    if (!rows.length) return;
    exportRows(rows, {
      filename: `تحليل-ABC-${period.from}-${period.to}`,
      columns: [
        { key: "productName", header: "المنتج" },
        { key: "revenue", header: "الإيراد", map: (r) => Number(r.revenue) },
        { key: "cumulativePct", header: "النسبة التراكمية %", map: (r) => Number(r.cumulativePct) },
        { key: "class", header: "الفئة" },
      ],
    });
  }

  function onPrint() {
    if (!rows.length) return;
    printReportDoc({
      title: "تحليل ABC",
      headerExtra: [
        { label: "الفترة", value: periodLabel },
        { label: "الفرع", value: branchLabel },
      ],
      columns: [
        { key: "product", label: "المنتج" },
        { key: "revenue", label: "الإيراد", align: "left" },
        { key: "cum", label: "التراكمي %", align: "left" },
        { key: "cls", label: "الفئة" },
      ],
      rows: rows.map((r) => ({
        product: r.productName,
        revenue: fmtAr(r.revenue),
        cum: `${r.cumulativePct}%`,
        cls: r.class,
      })),
      summary: totals
        ? [
            { label: "إجمالي الإيراد", value: fmtAr(totals.revenue), large: true, bold: true },
            { label: "منتجات A / B / C", value: `${totals.aCount} / ${totals.bCount} / ${totals.cCount}` },
          ]
        : undefined,
    });
  }

  return (
    <ReportShell
      title="تحليل ABC"
      description="تصنيف المنتجات حسب مساهمتها في الإيراد (باريتو): A ≤ 80٪ تراكمي، B ≤ 95٪، C الباقي."
      kpis={kpis}
      onExport={onExport}
      onPrint={onPrint}
      exportDisabled={!rows.length}
      printDisabled={!rows.length}
      filters={
        <div className="flex flex-wrap items-end gap-3">
          <PeriodFilter value={period} onChange={setPeriod} />
          {canPickBranch && (
            <div className="flex flex-col gap-1">
              <label className="text-[11px] text-muted-foreground">الفرع</label>
              <AppSelect
                className="h-9"
                value={String(branchId)}
                onValueChange={(next) => setBranchId(next ? Number(next) : "")}
              >
                <option value="">الكل</option>
                {(branches.data ?? []).map((b) => (
                  <option key={Number(b.id)} value={Number(b.id)}>
                    {b.name}
                  </option>
                ))}
              </AppSelect>
            </div>
          )}
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">بحث منتج</label>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="اسم المنتج…"
              aria-label="بحث منتج"
              className="h-9 w-44"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">الفئة</label>
            <AppSelect value={cls} onValueChange={(v) => setCls(v as ClassFilter)} className="w-28">
              <option value="">الكل</option>
              <option value="A">أ</option>
              <option value="B">ب</option>
              <option value="C">ج</option>
            </AppSelect>
          </div>
        </div>
      }
    >
      {q.isError ? (
        <ErrorState message="تعذّر تحميل التقرير." onRetry={() => void q.refetch()} />
      ) : (
        <DataTable
          columns={cols}
          data={rows}
          loading={q.isLoading}
          searchable={false}
          emptyText={allRows.length ? "لا منتج مطابق للفلاتر." : "لا مبيعات في هذا النطاق."}
        />
      )}
    </ReportShell>
  );
}
