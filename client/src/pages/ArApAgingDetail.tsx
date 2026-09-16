// تفصيل أعمار الذمم — فاتورةً بفاتورة (مدينة AR) / أمرَ شراء بأمر (دائنة AP).
// يكمّل تقريرَي الملخّص (أعمار الذمم المدينة/الدائنة): بدل تجميع كل عميل/مورد في صفّ، يسرد
// كل مستندٍ مستحقّ منفرداً بعدد أيّام تأخّره وشريحته ومتبقّيه — مرتّباً من الأقدم تأخّراً.
// عرض + KPIs بالشرائح + تصدير Excel + طباعة A4 (ReportShell + printReportDoc).
import { useMemo, useState } from "react";
import { AppSelect } from "@/components/ui/AppSelect";
import { Link } from "wouter";
import { Search } from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { fmtAr } from "@/lib/money";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";

type Side = "AR" | "AP";
type Row = RouterOutputs["reports"]["arApAgingDetail"]["rows"][number];


const SIDE_LABEL: Record<Side, string> = { AR: "ذمم مدينة (لنا)", AP: "ذمم دائنة (علينا)" };

const BUCKET_CLS: Record<string, string> = {
  "0-30": "badge-status-active",
  "31-60": "badge-stock-low",
  "61-90": "badge-stock-low",
  "90+": "badge-stock-out",
};

const BUCKET_OPTIONS = ["0-30", "31-60", "61-90", "90+"];

export default function ArApAgingDetail() {
  const [side, setSide] = useState<Side>("AR");
  const [branchId, setBranchId] = useState<number | "">("");
  // فلتر الشريحة العمرية + البحث النصّي — عميليّان بحتان (كل الصفوف مُحمَّلة أصلاً بلا ترقيم خادميّ).
  const [bucket, setBucket] = useState("");
  const [query, setQuery] = useState("");

  const branches = trpc.branches.list.useQuery();
  const q = trpc.reports.arApAgingDetail.useQuery({
    side,
    branchId: branchId ? Number(branchId) : undefined,
  });

  const allRows = q.data?.rows ?? [];
  const totals = q.data?.totals;
  const isAR = side === "AR";

  const rows = useMemo(() => {
    const qq = query.trim().toLowerCase();
    return allRows.filter((r) => {
      if (bucket && r.bucket !== bucket) return false;
      if (qq && !r.partyName.toLowerCase().includes(qq) && !r.number.toLowerCase().includes(qq)) return false;
      return true;
    });
  }, [allRows, bucket, query]);

  const kpis: KpiItem[] = totals
    ? [
        { label: "0–30 يوم", value: fmtAr(totals.d0_30), tone: "positive" },
        { label: "31–60 يوم", value: fmtAr(totals.d31_60), tone: "warning" },
        { label: "61–90 يوم", value: fmtAr(totals.d61_90), tone: "warning" },
        { label: "أكثر من 90", value: fmtAr(totals.d91p), tone: "negative" },
        { label: `الإجمالي (${totals.count})`, value: fmtAr(totals.unpaid), tone: "info" },
      ]
    : [];

  const branchLabel = useMemo(
    () => (branchId ? branches.data?.find((b) => b.id === branchId)?.name ?? String(branchId) : "الكل"),
    [branchId, branches.data],
  );

  // الفلترة عميليّة (شريحة + بحث) ⇒ الجدول بلا بحثٍ داخليّ، ونُعلمه بنشاط الفلاتر كي
  // يفرّق بين «لا مستندات مستحقّة أصلاً» و«لا مطابق للفلتر» بدل رسالةٍ واحدة تُضلّل.
  const clientFiltersActive = bucket !== "" || query.trim() !== "";

  const columns = useMemo<ColumnDef<Row, unknown>[]>(
    () => [
      {
        id: "number",
        header: isAR ? "رقم الفاتورة" : "رقم أمر الشراء",
        accessorFn: (r) => r.number,
        meta: { kind: "code" },
        cell: ({ row }) => (
          <Link
            href={isAR ? `/invoices/${row.original.id}` : `/purchases/${row.original.id}`}
            className="text-primary underline-offset-2 hover:underline"
          >
            {row.original.number}
          </Link>
        ),
      },
      {
        id: "partyName",
        header: isAR ? "العميل" : "المورد",
        accessorFn: (r) => r.partyName,
        meta: { width: "wide" },
        cell: ({ row }) => row.original.partyName,
      },
      { id: "date", header: "التاريخ", accessorFn: (r) => r.date, meta: { kind: "date" }, cell: ({ row }) => row.original.date },
      // الاستحقاق للذمم المدينة وحدها — كما كان العمود مشروطاً في الجدول الخامّ.
      ...(isAR
        ? ([
            {
              id: "dueDate",
              header: "الاستحقاق",
              accessorFn: (r) => r.dueDate ?? "—",
              meta: { kind: "date" },
              cell: ({ row }) => <span className="text-muted-foreground">{row.original.dueDate ?? "—"}</span>,
            },
          ] as ColumnDef<Row, unknown>[])
        : []),
      {
        id: "daysOverdue",
        header: "أيام التأخّر",
        accessorFn: (r) => r.daysOverdue,
        meta: { kind: "number" },
        cell: ({ row }) => row.original.daysOverdue,
      },
      {
        id: "bucket",
        header: "الشريحة",
        accessorFn: (r) => r.bucket,
        meta: { kind: "status" },
        cell: ({ row }) => (
          <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${BUCKET_CLS[row.original.bucket] ?? "bg-muted text-muted-foreground"}`}>
            {row.original.bucket}
          </span>
        ),
      },
      {
        id: "unpaid",
        header: "المتبقّي",
        accessorFn: (r) => fmtAr(r.unpaid),
        meta: { kind: "money" },
        cell: ({ row }) => <span className="font-semibold">{fmtAr(row.original.unpaid)}</span>,
      },
    ],
    [isAR],
  );

  function onExport() {
    exportRows(rows, {
      filename: `تفصيل-أعمار-${isAR ? "الذمم-المدينة" : "الذمم-الدائنة"}`,
      columns: [
        { key: "number", header: isAR ? "رقم الفاتورة" : "رقم أمر الشراء" },
        { key: "partyName", header: isAR ? "العميل" : "المورد" },
        { key: "date", header: "التاريخ" },
        ...(isAR ? [{ key: "dueDate", header: "الاستحقاق", map: (r: Row) => r.dueDate ?? "" }] : []),
        { key: "daysOverdue", header: "أيام التأخّر", map: (r) => r.daysOverdue },
        { key: "bucket", header: "الشريحة" },
        { key: "unpaid", header: "المتبقّي", map: (r) => Number(r.unpaid) },
      ],
    });
  }

  function onPrint() {
    printReportDoc({
      title: isAR ? "تفصيل أعمار الذمم المدينة" : "تفصيل أعمار الذمم الدائنة",
      headerExtra: [
        { label: "النوع", value: SIDE_LABEL[side] },
        { label: "الفرع", value: branchLabel },
      ],
      columns: [
        { key: "number", label: isAR ? "رقم الفاتورة" : "رقم الأمر" },
        { key: "party", label: isAR ? "العميل" : "المورد" },
        { key: "date", label: "التاريخ" },
        { key: "days", label: "أيام التأخّر", align: "left" },
        { key: "bucket", label: "الشريحة" },
        { key: "unpaid", label: "المتبقّي", align: "left" },
      ],
      rows: rows.map((r) => ({
        number: r.number,
        party: r.partyName,
        date: r.date,
        days: String(r.daysOverdue),
        bucket: r.bucket,
        unpaid: fmtAr(r.unpaid),
      })),
      summary: totals
        ? [
            { label: "0–30", value: fmtAr(totals.d0_30) },
            { label: "31–60", value: fmtAr(totals.d31_60) },
            { label: "61–90", value: fmtAr(totals.d61_90) },
            { label: "+90", value: fmtAr(totals.d91p) },
            { label: "إجمالي المتبقّي", value: fmtAr(totals.unpaid), large: true, bold: true },
          ]
        : undefined,
    });
  }

  return (
    <ReportShell
      title="تفصيل أعمار الذمم"
      description="كل مستندٍ مستحقّ منفرداً (فاتورة/أمر شراء) بعدد أيّام تأخّره وشريحته العمرية ومتبقّيه."
      kpis={kpis}
      onExport={onExport}
      onPrint={onPrint}
      exportDisabled={!rows.length}
      printDisabled={!rows.length}
      filters={
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">النوع</label>
            <AppSelect
              className="h-9"
              value={side}
              onValueChange={(value) => setSide(value as Side)}
            >
              <option value="AR">مدينة — لنا على العملاء</option>
              <option value="AP">دائنة — لهم علينا</option>
            </AppSelect>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">الفرع</label>
            <AppSelect
              className="h-9"
              value={String(branchId)}
              onValueChange={(value) => setBranchId(value ? Number(value) : "")}
            >
              <option value="">الكل</option>
              {branches.data?.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </AppSelect>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">الشريحة العمرية</label>
            <AppSelect className="h-9" value={bucket} onValueChange={(value) => setBucket(value)}>
              <option value="">الكل</option>
              {BUCKET_OPTIONS.map((b) => (<option key={b} value={b}>{b}</option>))}
            </AppSelect>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">بحث</label>
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 right-2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={isAR ? "العميل أو رقم الفاتورة…" : "المورد أو رقم الأمر…"}
                className="h-9 w-56 pr-8"
              />
            </div>
          </div>
        </div>
      }
    >
      <Card>
        <CardContent className="p-0">
          <DataTable<Row>
            columns={columns}
            data={rows}
            /* البحث في شريط الفلاتر أعلاه (يغذّي rows) — بلا هذا يظهر حقلا بحثٍ متجاوران. */
            searchable={false}
            externalFiltersActive={clientFiltersActive}
            loading={q.isLoading}
            errorState={{ isError: q.isError, message: q.error?.message, onRetry: () => q.refetch() }}
            emptyText="لا مستندات مستحقّة في هذا النطاق."
            emptyFilteredState="لا مستندات مطابقة للفلتر/البحث."
          />
        </CardContent>
      </Card>
    </ReportShell>
  );
}
