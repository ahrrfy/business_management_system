// تقرير التغييرات الوظيفية — قائمتا الترقيات وإنهاء الخدمات في قسمين.
// عرض + تصدير Excel + طباعة A4 (ReportShell + printReportDoc). يكشف رواتب/تسويات ⇒ صلاحية hr/READ خادمياً.
import { useMemo, useState } from "react";
import { FILTER_LABELS } from "@shared/uiContracts";
import { Link } from "wouter";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell } from "@/components/reports/ReportShell";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { FilterField } from "@/components/list";
import { fmtAr } from "@/lib/money";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";

type Data = RouterOutputs["promotions"]["report"];
type Promo = Data["promotions"][number];
type Term = Data["terminations"][number];

const PROMO_STATUS_LABEL: Record<string, string> = { pending: "معلّق", approved: "معتمد" };
const TERM_STATUS_LABEL: Record<string, string> = { pending: "معلّق", completed: "مكتمل" };
const STATUS_CLS: Record<string, string> = {
  pending: "badge-stock-low",
  approved: "badge-status-active",
  completed: "badge-status-active",
};

/** شارة الحالة — مصدرُ التسمية والصنف واحدٌ للقائمتين. */
function StatusBadge({ status, label }: { status: string; label: string }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${STATUS_CLS[status] ?? "bg-muted text-muted-foreground"}`}>
      {label}
    </span>
  );
}

/** جدولان مُضمَّنان في بطاقتَين تحملان عنوانَيهما — البحث في شريط الفلاتر أعلى الشاشة. */
const EMBEDDED_TABLE = { embedded: true, searchable: false, bounded: false, pageSize: Infinity } as const;

const promotionColumns: ColumnDef<Promo, unknown>[] = [
  {
    id: "employee",
    header: "الموظف",
    accessorFn: (p) => p.employeeName,
    meta: { width: "wide" },
    cell: ({ row }) => (
      <Link href={`/hr/employees/${row.original.employeeId}`} className="font-medium hover:underline">
        {row.original.employeeName}
      </Link>
    ),
  },
  {
    id: "fromTitle",
    header: "المسمّى السابق",
    accessorFn: (p) => p.fromTitle ?? "—",
    cell: ({ row }) => <span className="text-muted-foreground">{row.original.fromTitle ?? "—"}</span>,
  },
  {
    id: "toTitle",
    header: "المسمّى الجديد",
    accessorFn: (p) => p.toTitle,
    cell: ({ row }) => <span className="font-medium">{row.original.toTitle}</span>,
  },
  { id: "effectiveDate", header: "تاريخ النفاذ", accessorFn: (p) => p.effectiveDate, meta: { kind: "date" }, cell: ({ row }) => row.original.effectiveDate },
  {
    id: "status",
    header: "الحالة",
    // التسمية العربية لا الرمز الخامّ: «نسخ القيمة» يجب أن يطابق ما يقرأه المستعمِل.
    accessorFn: (p) => PROMO_STATUS_LABEL[p.status] ?? p.status,
    meta: { kind: "status" },
    cell: ({ row }) => <StatusBadge status={row.original.status} label={PROMO_STATUS_LABEL[row.original.status] ?? row.original.status} />,
  },
];

const terminationColumns: ColumnDef<Term, unknown>[] = [
  {
    id: "employee",
    header: "الموظف",
    accessorFn: (t) => t.employeeName,
    meta: { width: "wide" },
    cell: ({ row }) => (
      <Link href={`/hr/employees/${row.original.employeeId}`} className="font-medium hover:underline">
        {row.original.employeeName}
      </Link>
    ),
  },
  { id: "type", header: "النوع", accessorFn: (t) => t.type, cell: ({ row }) => row.original.type },
  { id: "lastDay", header: "آخر يوم عمل", accessorFn: (t) => t.lastDay, meta: { kind: "date" }, cell: ({ row }) => row.original.lastDay },
  { id: "settlement", header: "التسوية", accessorFn: (t) => fmtAr(t.settlement), meta: { kind: "money" }, cell: ({ row }) => fmtAr(row.original.settlement) },
  {
    id: "status",
    header: "الحالة",
    accessorFn: (t) => TERM_STATUS_LABEL[t.status] ?? t.status,
    meta: { kind: "status" },
    cell: ({ row }) => <StatusBadge status={row.original.status} label={TERM_STATUS_LABEL[row.original.status] ?? row.original.status} />,
  },
];

export default function HrChangesReport() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [query, setQuery] = useState("");
  const q = trpc.promotions.report.useQuery({ from: from || undefined, to: to || undefined });

  const allPromotions = q.data?.promotions ?? [];
  const allTerminations = q.data?.terminations ?? [];

  const matches = (v: string) => v.toLocaleLowerCase("ar").includes(query.trim().toLocaleLowerCase("ar"));
  const promotions = useMemo(
    () => (query.trim() ? allPromotions.filter((p) => [p.employeeName, p.fromTitle, p.toTitle].some((v) => matches(v ?? ""))) : allPromotions),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allPromotions, query],
  );
  const terminations = useMemo(
    () => (query.trim() ? allTerminations.filter((t) => [t.employeeName, t.type].some((v) => matches(v ?? ""))) : allTerminations),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allTerminations, query],
  );
  const hasAny = promotions.length > 0 || terminations.length > 0;
  /* فلاترُ الشاشة (بحث/مدى تاريخ) تُغذّي الجدولين من خارجهما — لا بحثَ داخليّ فيهما. */
  const filtersActive = query.trim() !== "" || from !== "" || to !== "";

  function onExport() {
    // ورقة واحدة موحَّدة: عمود «النوع» يميّز الترقية عن إنهاء الخدمة.
    type ExportRow = {
      kind: string;
      employeeName: string;
      detail: string;
      date: string;
      amount: string;
      status: string;
    };
    const merged: ExportRow[] = [
      ...promotions.map((p) => ({
        kind: "ترقية",
        employeeName: p.employeeName,
        detail: `${p.fromTitle ?? "—"} ← ${p.toTitle}`,
        date: p.effectiveDate,
        amount: "",
        status: PROMO_STATUS_LABEL[p.status] ?? p.status,
      })),
      ...terminations.map((t) => ({
        kind: "إنهاء خدمة",
        employeeName: t.employeeName,
        detail: t.type,
        date: t.lastDay,
        amount: String(Number(t.settlement)),
        status: TERM_STATUS_LABEL[t.status] ?? t.status,
      })),
    ];
    exportRows(merged, {
      filename: "التغييرات-الوظيفية",
      columns: [
        { key: "kind", header: "النوع" },
        { key: "employeeName", header: "الموظف" },
        { key: "detail", header: "التفاصيل" },
        { key: "date", header: "التاريخ" },
        { key: "amount", header: "التسوية", map: (r) => (r.amount === "" ? "" : Number(r.amount)) },
        { key: "status", header: "الحالة" },
      ],
    });
  }

  function onPrint() {
    printReportDoc({
      title: "تقرير التغييرات الوظيفية",
      columns: [
        { key: "kind", label: "النوع" },
        { key: "employeeName", label: "الموظف" },
        { key: "detail", label: "التفاصيل" },
        { key: "date", label: "التاريخ" },
        { key: "amount", label: "التسوية", align: "left" },
        { key: "status", label: "الحالة" },
      ],
      rows: [
        ...promotions.map((p) => ({
          kind: "ترقية",
          employeeName: p.employeeName,
          detail: `${p.fromTitle ?? "—"} ← ${p.toTitle}`,
          date: p.effectiveDate,
          amount: "—",
          status: PROMO_STATUS_LABEL[p.status] ?? p.status,
        })),
        ...terminations.map((t) => ({
          kind: "إنهاء خدمة",
          employeeName: t.employeeName,
          detail: t.type,
          date: t.lastDay,
          amount: fmtAr(t.settlement),
          status: TERM_STATUS_LABEL[t.status] ?? t.status,
        })),
      ],
    });
  }

  return (
    <ReportShell
      title="تقرير التغييرات الوظيفية"
      description="الترقيات وإنهاء الخدمات للموظفين."
      backHref="/reports"
      onExport={onExport}
      onPrint={onPrint}
      exportDisabled={!hasAny}
      printDisabled={!hasAny}
    >
      {/* الفلاتر */}
      <Card>
        <CardContent className="p-3 flex flex-wrap items-end gap-2">
          <FilterField label="بحث" className="min-w-48">
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="اسم الموظف أو المسمّى/النوع…" className="h-8" aria-label="بحث" />
          </FilterField>
          <FilterField label="من تاريخ">
            <Input type="date" dir="ltr" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 w-36" aria-label="من تاريخ" />
          </FilterField>
          <FilterField label="إلى تاريخ">
            <Input type="date" dir="ltr" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 w-36" aria-label="إلى تاريخ" />
          </FilterField>
          {(query || from || to) && (
            <button
              type="button"
              className="text-xs text-muted-foreground hover:underline"
              onClick={() => { setQuery(""); setFrom(""); setTo(""); }}
            >
              {FILTER_LABELS.reset}
            </button>
          )}
        </CardContent>
      </Card>

      {/* الترقيات */}
      <Card>
        <CardContent className="p-0">
          <div className="border-b px-4 py-2.5 text-sm font-semibold">الترقيات</div>
          <DataTable<Promo>
            {...EMBEDDED_TABLE}
            columns={promotionColumns}
            data={promotions}
            externalFiltersActive={filtersActive}
            loading={q.isLoading}
            errorState={{ isError: q.isError, message: "تعذّر تحميل التقرير.", onRetry: () => void q.refetch() }}
            emptyText="لا ترقيات مسجّلة."
          />
        </CardContent>
      </Card>

      {/* إنهاء الخدمات */}
      <Card>
        <CardContent className="p-0">
          <div className="border-b px-4 py-2.5 text-sm font-semibold">إنهاء الخدمات</div>
          <DataTable<Term>
            {...EMBEDDED_TABLE}
            columns={terminationColumns}
            data={terminations}
            externalFiltersActive={filtersActive}
            loading={q.isLoading}
            errorState={{ isError: q.isError, message: "تعذّر تحميل التقرير.", onRetry: () => void q.refetch() }}
            emptyText="لا حالات إنهاء خدمة مسجّلة."
          />
        </CardContent>
      </Card>
    </ReportShell>
  );
}
