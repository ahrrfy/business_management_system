// أعمار الإرساليات المفتوحة (١٠/٨) — نظير «أعمار الذمم» لعُهد المناديب: كل جهةٍ بدلاء زمنية
// من تاريخ الإرسال (٠-٧ / ٨-١٤ / ١٥-٣٠ / +٣٠ يوماً) بقيمة متبقّي COD. كان الموجود «أقدم
// مستحق» لكل جهة فقط — بلا توزيع مركزي يوجّه أولوية المتابعة.
import { useMemo, useState } from "react";
import { AppSelect } from "@/components/ui/AppSelect";
import { type ColumnDef } from "@tanstack/react-table";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { DataTable } from "@/components/data-table/DataTable";
import { ErrorState } from "@/components/PageState";
import { exportRows } from "@/lib/export";
import { fmtAr, formatIqd } from "@/lib/money";
import { fmtDate } from "@/lib/date";

type Row = RouterOutputs["reports"]["consignmentAging"]["rows"][number];

const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const NOTE =
  "لقطة حالةٍ راهنة للإرساليات المفتوحة (بالطريق/حُصِّل جزئياً): القيمة = متبقّي COD، والعمر من تاريخ الإرسال. الأقدم أولاً — كل ما زاد العمر زادت أولوية التوريد أو الإرجاع أو الشطب الموجَّه.";

const PARTY_TYPE_LABEL: Record<string, string> = { INDIVIDUAL: "مندوب", COMPANY: "شركة توصيل" };

export default function DeliveryAgingReport() {
  const [branchId, setBranchId] = useState<number | "">("");
  const branches = trpc.branches.list.useQuery();
  const q = trpc.reports.consignmentAging.useQuery(
    { branchId: branchId ? Number(branchId) : undefined },
    { staleTime: 60_000 },
  );

  const rows = q.data?.rows ?? [];
  const totals = q.data?.totals;
  const branchLabel = branchId ? (branches.data?.find((b) => b.id === branchId)?.name ?? String(branchId)) : "الكل";

  const kpis: KpiItem[] = totals
    ? [
        { label: "إرساليات مفتوحة", value: fmtAr(totals.openCount), tone: "info" },
        { label: "إجمالي المتبقّي", value: formatIqd(totals.totalOutstanding), tone: Number(totals.totalOutstanding) > 0 ? "warning" : "default" },
        // قاعدة مالك (٢٥/٨): كل رقمٍ لاتينيّ — كانت هذه التسميات مكتوبةً حرفياً بأرقامٍ هندية
        // (٠-٧/٨-١٤/+١٥)، وهي سلسلةٌ نصّية ثابتة لا تمرّ عبر toLocaleString فيفوتها حارس
        // check:locale-numbers الآليّ. صُحِّحت لاتينياً مطابقةً لبقية أرقام الشاشة.
        { label: "0-7 أيام", value: formatIqd(totals.d0_7), tone: "default" },
        { label: "8-14 يوماً", value: formatIqd(totals.d8_14), tone: Number(totals.d8_14) > 0 ? "warning" : "default" },
        { label: "+15 يوماً", value: formatIqd(String(Number(totals.d15_30) + Number(totals.d31p))), tone: Number(totals.d15_30) + Number(totals.d31p) > 0 ? "negative" : "default" },
      ]
    : [];

  const cols = useMemo<ColumnDef<Row>[]>(
    () => [
      {
        header: "الجهة",
        accessorKey: "partyName",
        cell: ({ row }) => (
          <>
            <span className="font-medium">{row.original.partyName}</span>
            <div className="text-[11px] text-muted-foreground">{PARTY_TYPE_LABEL[row.original.partyType] ?? row.original.partyType}</div>
          </>
        ),
      },
      { id: "openCount", header: "مفتوحة", accessorFn: (r) => r.openCount, cell: ({ row }) => <span dir="ltr" className="tabular-nums">{fmtAr(row.original.openCount)}</span> },
      // bidi: ترويسة «0-7» رقمان لاتينيّان بشرطة — تحتاج dir="ltr" صريحاً مثل أيّ مدىً رقميّ
      // آخر (نفس عطب حزمة/ReportShell أعلاه)؛ `header` هنا سلسلة خامّة تُعرَض بلا عزلٍ تلقائيّ.
      { id: "d0_7", header: () => <span dir="ltr">0-7</span>, accessorFn: (r) => Number(r.d0_7), cell: ({ row }) => <span dir="ltr" className="tabular-nums">{Number(row.original.d0_7) > 0 ? fmtAr(row.original.d0_7) : "—"}</span> },
      { id: "d8_14", header: () => <span dir="ltr">8-14</span>, accessorFn: (r) => Number(r.d8_14), cell: ({ row }) => <span dir="ltr" className="tabular-nums text-[var(--sem-warn)]">{Number(row.original.d8_14) > 0 ? fmtAr(row.original.d8_14) : "—"}</span> },
      { id: "d15_30", header: () => <span dir="ltr">15-30</span>, accessorFn: (r) => Number(r.d15_30), cell: ({ row }) => <span dir="ltr" className="tabular-nums text-money-negative">{Number(row.original.d15_30) > 0 ? fmtAr(row.original.d15_30) : "—"}</span> },
      { id: "d31p", header: () => <span dir="ltr">+31</span>, accessorFn: (r) => Number(r.d31p), cell: ({ row }) => <span dir="ltr" className="tabular-nums font-bold text-money-negative">{Number(row.original.d31p) > 0 ? fmtAr(row.original.d31p) : "—"}</span> },
      { id: "totalOutstanding", header: "الإجمالي", accessorFn: (r) => Number(r.totalOutstanding), cell: ({ row }) => <span dir="ltr" className="tabular-nums font-bold">{fmtAr(row.original.totalOutstanding)}</span> },
      { id: "oldestDays", header: "أقدم (يوم)", accessorFn: (r) => r.oldestDays, cell: ({ row }) => <span dir="ltr" className={`tabular-nums ${row.original.oldestDays > 14 ? "font-bold text-money-negative" : ""}`}>{fmtAr(row.original.oldestDays)}</span> },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: ({ row }) => (
          <a className="text-xs font-bold text-primary hover:underline" href={`/delivery?tab=parties&detail=${row.original.partyId}`}>
            كشف الجهة
          </a>
        ),
      },
    ],
    [],
  );

  function onExport() {
    exportRows(rows, {
      filename: `أعمار-الإرساليات${branchId ? `-${branchLabel}` : ""}`,
      title: "أعمار الإرساليات المفتوحة",
      meta: [
        { label: "الفرع", value: branchLabel },
        { label: "كما في", value: fmtDate(new Date()) },
      ],
      columns: [
        { key: "partyName", header: "الجهة" },
        { key: "partyType", header: "النوع", map: (r) => PARTY_TYPE_LABEL[r.partyType] ?? r.partyType },
        { key: "openCount", header: "مفتوحة" },
        { key: "d0_7", header: "0-7 أيام", money: true, map: (r) => Number(r.d0_7) },
        { key: "d8_14", header: "8-14 يوماً", money: true, map: (r) => Number(r.d8_14) },
        { key: "d15_30", header: "15-30 يوماً", money: true, map: (r) => Number(r.d15_30) },
        { key: "d31p", header: "+31 يوماً", money: true, map: (r) => Number(r.d31p) },
        { key: "totalOutstanding", header: "الإجمالي", money: true, map: (r) => Number(r.totalOutstanding) },
        { key: "oldestDays", header: "أقدم (يوم)" },
      ],
      totalsRow: totals
        ? {
            partyName: "الإجمالي",
            openCount: totals.openCount,
            d0_7: Number(totals.d0_7),
            d8_14: Number(totals.d8_14),
            d15_30: Number(totals.d15_30),
            d31p: Number(totals.d31p),
            totalOutstanding: Number(totals.totalOutstanding),
          }
        : undefined,
    });
  }

  return (
    <ReportShell
      title="أعمار الإرساليات المفتوحة"
      description="عُهد المناديب الموزّعة زمنياً — بوصلة أولوية التوريد والمتابعة."
      note={NOTE}
      kpis={kpis}
      onExport={onExport}
      exportDisabled={!rows.length}
      filters={
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">الفرع</label>
            <AppSelect className="h-9" value={String(branchId)} onValueChange={(next) => setBranchId(next ? Number(next) : "")}>
              <option value="">الكل</option>
              {branches.data?.map((b) => (<option key={b.id} value={b.id}>{b.name}</option>))}
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
          emptyText="لا إرساليات مفتوحة الآن — كل العُهد مسوّاة."
          pageSize={Infinity}
        />
      )}
    </ReportShell>
  );
}
