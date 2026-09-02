import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { AppSelect } from "@/components/ui/AppSelect";

import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState } from "@/components/PageState";
import { FilterField, ListToolbar } from "@/components/list";
import { fmtDate } from "@/lib/date";
import { CategoryIcon, StatCard, iqd } from "@/lib/assets/ui";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { trpc } from "@/lib/trpc";
import { useUrlFilters } from "@/hooks/useUrlFilters";
import { assetCategoryLabel } from "@shared/assets";
import { Archive, CircleSlash, TrendingDown, Wallet } from "lucide-react";
import { useMemo } from "react";
import { Link } from "wouter";

export default function AssetDisposalLog() {
  const q = trpc.assets.disposalLog.useQuery();
  const [f, setF, resetF] = useUrlFilters({ q: "", type: "", from: "", to: "" });

  const allRows = q.data ?? [];
  const rows = useMemo(() => {
    const needle = f.q.trim().toLowerCase();
    return allRows.filter((r) => {
      if (f.type && r.status !== f.type) return false;
      if (f.from && (r.disposalDate ?? "") < f.from) return false;
      if (f.to && (r.disposalDate ?? "") > f.to) return false;
      if (needle && !(r.name.toLowerCase().includes(needle) || (r.code ?? "").toLowerCase().includes(needle))) return false;
      return true;
    });
  }, [allRows, f.q, f.type, f.from, f.to]);
  const filtersActive = f.q.trim() !== "" || f.type !== "" || f.from !== "" || f.to !== "";

  if (q.isLoading) return <LoadingState />;
  if (q.error) return <ErrorState message={q.error.message} onRetry={() => q.refetch()} />;

  const disposed = rows.filter((r) => r.status === "disposed");
  const retired = rows.filter((r) => r.status === "retired");
  const totalProceeds = disposed.reduce((s, r) => s + Number(r.proceeds ?? 0), 0);
  const netGain = disposed.reduce((s, r) => s + Number(r.gain ?? 0), 0);
  /** أعمدة سجلّ استبعاد الأصول. */
  const disposalColumns = useMemo<ColumnDef<(typeof rows)[number], unknown>[]>(() => [
    {
      id: "asset", header: "الأصل",
      accessorFn: (r) => r.name,
      cell: ({ row }) => {
        const r = row.original;
        return (
          <Link href={`/assets/${r.id}`} className="flex items-center gap-1.5 hover:text-primary">
            <CategoryIcon category={r.category} />
            <span>
              <span className="font-medium">{r.name}</span>{" "}
              <span className="text-xs text-muted-foreground" dir="ltr">{r.code}</span>
              <div className="text-xs text-muted-foreground">{assetCategoryLabel(r.category)}</div>
            </span>
          </Link>
        );
      },
      meta: { kind: "text", wrap: true },
    },
    {
      id: "status", header: "النوع",
      accessorFn: (r) => (r.status === "disposed" ? "مُستبعَد" : "خارج الخدمة"),
      cell: ({ row }) => (
        <span className={`rounded-full px-2 py-0.5 text-xs ${row.original.status === "disposed" ? "badge-stock-out" : "badge-status-cancelled"}`}>
          {row.original.status === "disposed" ? "مُستبعَد" : "خارج الخدمة"}
        </span>
      ),
      meta: { kind: "status" },
    },
    {
      id: "disposalDate", header: "التاريخ",
      accessorFn: (r) => String(r.disposalDate ?? ""),
      cell: ({ row }) => fmtDate(row.original.disposalDate),
      meta: { kind: "date" },
    },
    { id: "purchaseValue", header: "قيمة الشراء", accessorFn: (r) => Number(r.purchaseValue), cell: ({ row }) => iqd(row.original.purchaseValue), meta: { kind: "money" } },
    { id: "bookValue", header: "الدفترية عند الإخراج", accessorFn: (r) => Number(r.bookValue), cell: ({ row }) => iqd(row.original.bookValue), meta: { kind: "money" } },
    {
      id: "proceeds", header: "العائد",
      accessorFn: (r) => (r.proceeds == null ? -1 : Number(r.proceeds)),
      cell: ({ row }) => row.original.proceeds != null ? iqd(row.original.proceeds) : "—",
      meta: { kind: "money" },
    },
    {
      id: "gain", header: "ربح/خسارة",
      accessorFn: (r) => (r.gain == null ? 0 : Number(r.gain)),
      cell: ({ row }) => row.original.gain != null ? (
        <span className={Number(row.original.gain) >= 0 ? "text-money-positive" : "text-money-negative"}>
          {Number(row.original.gain) >= 0 ? "+" : ""}{iqd(row.original.gain)}
        </span>
      ) : "—",
      meta: { kind: "money" },
    },
  ], []);

  return (
    <div className="space-y-4">
      <PageHeader
        title="سجلّ الاستبعاد والإخراج"
        actions={<Link href="/assets/register"><Button variant="outline" size="sm">سجلّ الأصول</Button></Link>}
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="مُستبعَد (بيع/خردة)" value={iqd(disposed.length)} icon={Archive} />
        <StatCard label="خارج الخدمة" value={iqd(retired.length)} icon={CircleSlash} />
        <StatCard label="إجمالي العائد" value={iqd(totalProceeds)} icon={Wallet} sub="د.ع" />
        <StatCard label="صافي الربح/الخسارة" value={iqd(netGain)} icon={TrendingDown} sub="للمُستبعَد (بيع/خردة) مقابل الدفترية" tone={netGain >= 0 ? "positive" : "negative"} />
      </div>

      <Card>
        <CardHeader>
          <ListToolbar
            title="القائمة"
            count={rows.length}
            search={{ value: f.q, onChange: (v) => setF({ q: v }), placeholder: "بحث بالأصل/الرمز…" }}
            filters={
              <>
                {/* FilterField يُظهر التسمية بصرياً — aria-label وحده لا يُرى (نمط PR #559/#566). */}
                <FilterField label="النوع">
                  <AppSelect value={f.type} onValueChange={(v) => setF({ type: v })} className="h-8 w-40" size="sm">
                    <option value="">كل الأنواع</option>
                    <option value="disposed">مُستبعَد (بيع/خردة)</option>
                    <option value="retired">خارج الخدمة</option>
                  </AppSelect>
                </FilterField>
                <FilterField label="من تاريخ">
                  <Input type="date" value={f.from} max={f.to || undefined} onChange={(e) => setF({ from: e.target.value })} className="h-8 w-36" />
                </FilterField>
                <FilterField label="إلى تاريخ">
                  <Input type="date" value={f.to} min={f.from || undefined} onChange={(e) => setF({ to: e.target.value })} className="h-8 w-36" />
                </FilterField>
              </>
            }
            onResetFilters={filtersActive ? resetF : undefined}
            onPrint={
              rows.length
                ? () =>
                    printReportDoc({
                      title: "سجلّ الاستبعاد والإخراج",
                      headerExtra: [
                        { label: "تاريخ التقرير", value: fmtDate(new Date()) },
                        { label: "الفترة", value: f.from || f.to ? `${f.from || "…"} — ${f.to || "…"}` : "الكل" },
                        { label: "النوع", value: f.type === "disposed" ? "مُستبعَد (بيع/خردة)" : f.type === "retired" ? "خارج الخدمة" : "الكل" },
                      ],
                      columns: [
                        { key: "asset", label: "الأصل" },
                        { key: "type", label: "النوع" },
                        { key: "date", label: "التاريخ" },
                        { key: "purchase", label: "قيمة الشراء", align: "left" },
                        { key: "book", label: "القيمة الدفترية", align: "left" },
                        { key: "proceeds", label: "العوائد", align: "left" },
                        { key: "gain", label: "ربح/خسارة", align: "left" },
                      ],
                      rows: rows.map((r) => ({
                        asset: r.name,
                        type: r.status === "disposed" ? "مُستبعَد" : "خارج الخدمة",
                        date: fmtDate(r.disposalDate),
                        purchase: iqd(r.purchaseValue),
                        book: iqd(r.bookValue),
                        proceeds: r.proceeds != null ? iqd(r.proceeds) : "—",
                        gain: r.gain != null ? `${Number(r.gain) >= 0 ? "+" : ""}${iqd(r.gain)}` : "—",
                      })),
                      summary: [
                        { label: "مُستبعَد (بيع/خردة)", value: iqd(disposed.length) },
                        { label: "خارج الخدمة", value: iqd(retired.length) },
                        { label: "إجمالي العوائد", value: `${iqd(totalProceeds)} د.ع` },
                        {
                          label: "صافي الربح/الخسارة",
                          value: `${netGain >= 0 ? "+" : ""}${iqd(netGain)} د.ع`,
                          large: true,
                          bold: true,
                        },
                      ],
                    })
                : undefined
            }
            printLabel="طباعة / PDF"
            exportSpec={{
              filename: "سجل_الاستبعاد",
              rows,
              columns: [
                { key: "code", header: "الرمز" },
                { key: "name", header: "الأصل" },
                { key: "status", header: "النوع", map: (r) => (r.status === "disposed" ? "مُستبعَد" : "خارج الخدمة") },
                { key: "disposalDate", header: "التاريخ", map: (r) => String(r.disposalDate ?? "") },
                { key: "purchaseValue", header: "قيمة الشراء", map: (r) => Number(r.purchaseValue) },
                { key: "bookValue", header: "الدفترية عند الإخراج", map: (r) => r.bookValue },
                { key: "proceeds", header: "العائد", map: (r) => (r.proceeds ?? "") },
                { key: "gain", header: "ربح/خسارة", map: (r) => (r.gain ?? "") },
              ],
            }}
          />
        </CardHeader>
        <CardContent className="p-0">
          <DataTable
            columns={disposalColumns}
            data={rows}
            searchable={false}
            emptyText={allRows.length === 0 ? "لا أصول مُستبعَدة أو خارج الخدمة." : "لا نتائج مطابقة للفلاتر."}
          />
        </CardContent>
      </Card>
    </div>
  );
}
