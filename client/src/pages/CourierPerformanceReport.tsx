// أداء المناديب / جهات التوصيل — من الأنشط؟ من الأعلى تحصيلاً؟ من الأعلى معدّل تعذّر؟
// لطلبات المتجر الإلكتروني (COD) خلال فترة بتاريخ الطلب: مُسنَد/مُسلَّم/قيد التوصيل/متعذّر +
// قيمة المُسلَّم + COD المُحصَّل + معدّل التعذّر + العهدة القائمة. عرض + تصدير Excel + طباعة A4.
import { useMemo, useState } from "react";
import { AppSelect } from "@/components/ui/AppSelect";
import { type ColumnDef } from "@tanstack/react-table";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { DataTable } from "@/components/data-table/DataTable";
import { ErrorState } from "@/components/PageState";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { fmtAr, formatIqd } from "@/lib/money";
import { fmtDate } from "@/lib/date";
import { selectCls } from "@/lib/ui/formStyles";

type Row = RouterOutputs["reports"]["courierPerformance"]["rows"][number];

const dateCls = selectCls;

const NOTE =
  "قناتان لكل جهة: طلبات المتجر الإلكتروني (بتاريخ الطلب) وإرساليات الاستقبال/الفواتير (بتاريخ الإرسال). «المتعذّر» = طلب متجر سجّل له المندوب «تعذّر التسليم». زمن الدوران = متوسط الساعات من الإرسال إلى التوريد للإرساليات المُسوّاة. «العهدة القائمة» لقطة لحظية (لا تخصّ الفترة).";

function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
function defaultFrom(): string {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return ymdLocal(d);
}

const PARTY_TYPE_LABEL: Record<string, string> = { INDIVIDUAL: "مندوب", COMPANY: "شركة توصيل" };

export default function CourierPerformanceReport() {
  const [from, setFrom] = useState<string>(defaultFrom);
  const [to, setTo] = useState<string>(() => ymdLocal(new Date()));
  const [branchId, setBranchId] = useState<number | "">("");
  const branches = trpc.branches.list.useQuery();
  const q = trpc.reports.courierPerformance.useQuery(
    { from, to, branchId: branchId ? Number(branchId) : undefined },
    { staleTime: 60_000 },
  );

  const rows = q.data?.rows ?? [];
  const summary = q.data?.summary;
  const branchLabel = branchId ? (branches.data?.find((b) => b.id === branchId)?.name ?? String(branchId)) : "الكل";

  const kpis: KpiItem[] = summary
    ? [
        { label: "جهات نشطة", value: fmtAr(summary.parties), tone: "info", hint: "في الفترة" },
        { label: "متجر: مُسلَّمة", value: fmtAr(summary.delivered), tone: "positive", hint: `قيد التوصيل ${fmtAr(summary.inTransit)} · متعذّر ${fmtAr(summary.failed)} (${summary.failRate}%)` },
        { label: "استقبال: إرساليات", value: fmtAr(summary.cnAssigned), tone: "info", hint: `سُلِّم ${fmtAr(summary.cnDelivered)} · مفتوح ${fmtAr(summary.cnOpen)}` },
        { label: "عجز توريدات الفترة", value: formatIqd(summary.remitShortfall), tone: Number(summary.remitShortfall) > 0 ? "negative" : "default" },
        { label: "عهدة قائمة الآن", value: formatIqd(summary.custodyOutstanding), tone: Number(summary.custodyOutstanding) > 0 ? "warning" : "default" },
      ]
    : [];

  // أعمدة DataTable — كل أعمدة الأرقام/المال بفرزٍ رقميّ (accessorFn ⇒ Number لا فرز نصّيّ).
  const cols = useMemo<ColumnDef<Row>[]>(
    () => [
      {
        header: "الجهة",
        accessorKey: "partyName",
        cell: ({ row }) => (
          <>
            <span className="font-medium">{row.original.partyName}</span>
            {!row.original.isActive && (
              <span className="ms-1.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">معطَّلة</span>
            )}
            {row.original.linkedUser && (
              <div className="text-[11px] text-muted-foreground">{row.original.linkedUser}</div>
            )}
          </>
        ),
      },
      {
        header: "النوع",
        accessorKey: "partyType",
        cell: ({ row }) => (
          <span className="text-muted-foreground">{PARTY_TYPE_LABEL[row.original.partyType] ?? row.original.partyType}</span>
        ),
      },
      {
        id: "assigned",
        header: "مُسنَد",
        accessorFn: (r) => Number(r.assigned),
        cell: ({ row }) => <span dir="ltr" className="tabular-nums">{fmtAr(row.original.assigned)}</span>,
      },
      {
        id: "delivered",
        header: "مُسلَّم",
        accessorFn: (r) => Number(r.delivered),
        cell: ({ row }) => (
          <span dir="ltr" className="tabular-nums text-money-positive">{fmtAr(row.original.delivered)}</span>
        ),
      },
      {
        id: "inTransit",
        header: "قيد التوصيل",
        accessorFn: (r) => Number(r.inTransit),
        cell: ({ row }) => (
          <span dir="ltr" className="tabular-nums text-muted-foreground">
            {row.original.inTransit > 0 ? fmtAr(row.original.inTransit) : "—"}
          </span>
        ),
      },
      {
        id: "failed",
        header: "متعذّر",
        accessorFn: (r) => Number(r.failed),
        cell: ({ row }) => (
          <span dir="ltr" className="tabular-nums text-money-negative">
            {row.original.failed > 0 ? fmtAr(row.original.failed) : "—"}
          </span>
        ),
      },
      {
        id: "failRate",
        header: "معدّل التعذّر",
        accessorFn: (r) => Number(r.failRate),
        cell: ({ row }) => (
          <span dir="ltr" className="tabular-nums">
            {Number(row.original.failRate) > 0 ? `${row.original.failRate}%` : "—"}
          </span>
        ),
      },
      {
        id: "deliveredValue",
        header: "قيمة المُسلَّم",
        accessorFn: (r) => Number(r.deliveredValue),
        cell: ({ row }) => (
          <span dir="ltr" className="tabular-nums text-muted-foreground">{fmtAr(row.original.deliveredValue)}</span>
        ),
      },
      {
        id: "codCollected",
        header: "COD المُحصَّل",
        accessorFn: (r) => Number(r.codCollected),
        cell: ({ row }) => <span dir="ltr" className="tabular-nums">{fmtAr(row.original.codCollected)}</span>,
      },
      {
        id: "cnAssigned",
        header: "إرساليات استقبال",
        accessorFn: (r) => Number(r.cnAssigned),
        cell: ({ row }) => (
          <span dir="ltr" className="tabular-nums">{row.original.cnAssigned > 0 ? fmtAr(row.original.cnAssigned) : "—"}</span>
        ),
      },
      {
        id: "cnDelivered",
        header: "سُلِّم/مرتجع",
        accessorFn: (r) => Number(r.cnDelivered),
        cell: ({ row }) => (
          <span dir="ltr" className="tabular-nums">
            {row.original.cnAssigned > 0
              ? `${fmtAr(row.original.cnDelivered)} / ${fmtAr(row.original.cnReturned + row.original.cnWrittenOff)}`
              : "—"}
          </span>
        ),
      },
      {
        id: "cnAvgTurnHours",
        header: "زمن الدوران",
        accessorFn: (r) => Number(r.cnAvgTurnHours ?? 0),
        cell: ({ row }) => {
          const h = row.original.cnAvgTurnHours;
          if (h == null) return <span className="text-muted-foreground">—</span>;
          return <span dir="ltr" className="tabular-nums">{h >= 48 ? `${fmtAr(Math.round(h / 24))} يوم` : `${fmtAr(h)} س`}</span>;
        },
      },
      {
        id: "remitShortfall",
        header: "عجز التوريد",
        accessorFn: (r) => Number(r.remitShortfall),
        cell: ({ row }) => (
          <span dir="ltr" className="tabular-nums text-money-negative">
            {Number(row.original.remitShortfall) > 0
              ? `${fmtAr(row.original.remitShortfall)} (${fmtAr(row.original.remitShortCount)})`
              : "—"}
          </span>
        ),
      },
      {
        id: "custodyOutstanding",
        header: "عهدة قائمة",
        accessorFn: (r) => Number(r.custodyOutstanding),
        cell: ({ row }) => (
          <span dir="ltr" className="tabular-nums">
            {Number(row.original.custodyOutstanding) > 0 ? fmtAr(row.original.custodyOutstanding) : "—"}
          </span>
        ),
      },
    ],
    [],
  );

  function onExport() {
    exportRows(rows, {
      filename: `أداء-المناديب${branchId ? `-${branchLabel}` : ""}`,
      title: "أداء المناديب / جهات التوصيل",
      meta: [
        { label: "الفترة", value: `${from} — ${to}` },
        { label: "الفرع", value: branchLabel },
        { label: "تاريخ الإصدار", value: fmtDate(new Date()) },
      ],
      columns: [
        { key: "partyName", header: "الجهة" },
        { key: "partyType", header: "النوع", map: (r) => PARTY_TYPE_LABEL[r.partyType] ?? r.partyType },
        { key: "assigned", header: "مُسنَد", map: (r) => r.assigned },
        { key: "delivered", header: "مُسلَّم", map: (r) => r.delivered },
        { key: "inTransit", header: "قيد التوصيل", map: (r) => r.inTransit },
        { key: "failed", header: "متعذّر", map: (r) => r.failed },
        { key: "failRate", header: "معدّل التعذّر %", map: (r) => r.failRate },
        { key: "deliveredValue", header: "قيمة المُسلَّم", money: true, map: (r) => Number(r.deliveredValue) },
        { key: "codCollected", header: "COD المُحصَّل", money: true, map: (r) => Number(r.codCollected) },
        { key: "cnAssigned", header: "إرساليات استقبال", map: (r) => r.cnAssigned },
        { key: "cnDelivered", header: "سُلِّم (استقبال)", map: (r) => r.cnDelivered },
        { key: "cnReturned", header: "مرتجع/مشطوب", map: (r) => r.cnReturned + r.cnWrittenOff },
        { key: "cnOpen", header: "مفتوح (استقبال)", map: (r) => r.cnOpen },
        { key: "cnValue", header: "قيمة إرساليات الفترة", money: true, map: (r) => Number(r.cnValue) },
        { key: "cnAvgTurnHours", header: "زمن الدوران (ساعة)", map: (r) => r.cnAvgTurnHours ?? "" },
        { key: "remitShortfall", header: "عجز التوريد", money: true, map: (r) => Number(r.remitShortfall) },
        { key: "custodyOutstanding", header: "عهدة قائمة", money: true, map: (r) => Number(r.custodyOutstanding) },
        { key: "phone", header: "الهاتف", map: (r) => r.phone ?? "" },
      ],
      totalsRow: summary
        ? {
            partyName: "الإجمالي",
            assigned: summary.assigned,
            delivered: summary.delivered,
            inTransit: summary.inTransit,
            failed: summary.failed,
            deliveredValue: Number(summary.deliveredValue),
            codCollected: Number(summary.codCollected),
            custodyOutstanding: Number(summary.custodyOutstanding),
          }
        : undefined,
    });
  }

  function onPrint() {
    printReportDoc({
      title: "أداء المناديب / جهات التوصيل",
      note: NOTE,
      headerExtra: [
        { label: "الفترة", value: `${from} — ${to}` },
        { label: "الفرع", value: branchLabel },
        { label: "كما في", value: fmtDate(new Date()) },
      ],
      columns: [
        { key: "party", label: "الجهة" },
        { key: "type", label: "النوع" },
        { key: "assigned", label: "مُسنَد", align: "left" },
        { key: "delivered", label: "مُسلَّم", align: "left" },
        { key: "failed", label: "متعذّر", align: "left" },
        { key: "rate", label: "معدّل %", align: "left" },
        { key: "cod", label: "COD المُحصَّل", align: "left" },
        { key: "custody", label: "عهدة قائمة", align: "left" },
      ],
      rows: rows.map((r) => ({
        party: r.partyName,
        type: PARTY_TYPE_LABEL[r.partyType] ?? r.partyType,
        assigned: fmtAr(r.assigned),
        delivered: fmtAr(r.delivered),
        failed: r.failed > 0 ? fmtAr(r.failed) : "—",
        rate: `${r.failRate}%`,
        cod: fmtAr(r.codCollected),
        custody: Number(r.custodyOutstanding) > 0 ? fmtAr(r.custodyOutstanding) : "—",
      })),
      summary: summary
        ? [
            { label: "عدد الجهات", value: fmtAr(summary.parties) },
            { label: "المُسلَّم", value: fmtAr(summary.delivered) },
            { label: "COD المُحصَّل", value: formatIqd(summary.codCollected), large: true, bold: true },
          ]
        : undefined,
    });
  }

  return (
    <ReportShell
      title="أداء المناديب / جهات التوصيل"
      description="أداء توصيل طلبات المتجر — الأنشط، الأعلى تحصيلاً، والأعلى معدّل تعذّر."
      note={NOTE}
      kpis={kpis}
      onExport={onExport}
      onPrint={onPrint}
      exportDisabled={!rows.length}
      printDisabled={!rows.length}
      filters={
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">من</label>
            <input type="date" className={dateCls} value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">إلى</label>
            <input type="date" className={dateCls} value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </div>
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
          emptyText="لا جهات توصيل نشطة في هذا النطاق."
          pageSize={Infinity}
        />
      )}
    </ReportShell>
  );
}
