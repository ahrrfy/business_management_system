// قائمة التدفّقات النقدية المبسّطة (أساس نقدي مباشر) — مقبوضات/مدفوعات حسب طريقة الدفع.
// عرض + Excel + طباعة A4. ⚠️ أساس نقدي: من المقبوضات المكتملة (receipts COMPLETED) لا الاستحقاق.
import { useMemo, useState } from "react";
import { AppSelect } from "@/components/ui/AppSelect";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { PeriodFilter, DEFAULT_PERIOD, type PeriodValue } from "@/components/reports/PeriodFilter";
import { Card, CardContent } from "@/components/ui/card";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { fmtAr, D } from "@/lib/money";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { selectCls } from "@/lib/ui/formStyles";

type CF = RouterOutputs["reports"]["cashFlow"];

/** سطرُ القائمة — عنوانُ قسمٍ (amount فارغ) أو بندٌ أو إجماليّ. */
type CashFlowLine = { label: string; amount: string; neg?: boolean };

/** نصُّ القيمة كما يُقرأ: المدفوعاتُ بين قوسين (عُرفٌ محاسبيّ) وعنوانُ القسم بلا قيمة. */
function amountText(r: CashFlowLine): string {
  if (r.amount === "") return "";
  return r.neg ? `(${fmtAr(r.amount)})` : fmtAr(r.amount);
}

/** عنوانُ قسمٍ أو صفُّ إجمالي — يُبرَز كما كان في الجدول الخامّ. */
function isEmphasizedLine(r: CashFlowLine): boolean {
  return r.amount === "" || r.label.startsWith("إجمالي") || r.label.startsWith("صافي");
}

/*
 * ⛔ الفرز مُعطَّل: هذه **قائمةٌ ماليّة مرتَّبة** (عنوان قسم ← بنوده ← إجماليّه)، وأيّ
 * إعادة ترتيبٍ تفصل الإجماليّ عن بنوده فتُنتج مستنداً يكذب.
 */
const cashFlowColumns: ColumnDef<CashFlowLine, unknown>[] = [
  {
    id: "label",
    header: "البند",
    accessorFn: (r) => r.label,
    enableSorting: false,
    meta: { width: "wide" },
    cell: ({ row }) => row.original.label,
  },
  {
    id: "amount",
    header: "القيمة",
    accessorFn: (r) => amountText(r),
    enableSorting: false,
    meta: { kind: "money" },
    cell: ({ row }) => (
      <span className={row.original.neg ? "text-money-negative" : undefined}>{amountText(row.original)}</span>
    ),
  },
];

const NOTE = "أساس نقدي مباشر: من المقبوضات/المدفوعات المكتملة (لا أساس الاستحقاق). النقد حسب الفرع المحدّد.";

export default function CashFlow() {
  const [period, setPeriod] = useState<PeriodValue>(DEFAULT_PERIOD);
  const [branchId, setBranchId] = useState<number | "">("");
  const branches = trpc.branches.list.useQuery();
  const q = trpc.reports.cashFlow.useQuery({ from: period.from, to: period.to, branchId: branchId ? Number(branchId) : undefined });
  const cf = q.data;

  const kpis: KpiItem[] = cf
    ? [
        { label: "المقبوضات", value: fmtAr(cf.totalIn), tone: "positive" },
        { label: "المدفوعات", value: fmtAr(cf.totalOut), tone: "negative" },
        { label: "صافي التدفّق", value: fmtAr(cf.net), tone: D(cf.net).gte(0) ? "positive" : "negative" },
      ]
    : [];

  const flat = useMemo<CashFlowLine[]>(() => {
    if (!cf) return [];
    return [
      { label: "المقبوضات (داخل)", amount: "" },
      ...cf.inflows.map((l) => ({ label: `— ${l.label}`, amount: l.amount })),
      { label: "إجمالي المقبوضات", amount: cf.totalIn },
      { label: "المدفوعات (خارج)", amount: "" },
      ...cf.outflows.map((l) => ({ label: `— ${l.label}`, amount: l.amount, neg: true })),
      { label: "إجمالي المدفوعات", amount: cf.totalOut, neg: true },
      { label: "صافي التدفّق النقدي", amount: cf.net },
    ];
  }, [cf]);

  const branchLabel = branchId ? (branches.data?.find((b) => b.id === branchId)?.name ?? String(branchId)) : "الكل";

  function onExport() {
    exportRows(flat, {
      filename: `التدفّق-النقدي-${period.from}-${period.to}`,
      columns: [
        { key: "label", header: "البند" },
        { key: "amount", header: "القيمة", map: (r) => (r.amount === "" ? "" : Number(r.amount)) },
      ],
    });
  }

  function onPrint() {
    if (!cf) return;
    printReportDoc({
      title: "قائمة التدفّقات النقدية",
      headerExtra: [
        { label: "الفترة", value: `${period.from} — ${period.to}` },
        { label: "الفرع", value: branchLabel },
      ],
      note: NOTE,
      columns: [
        { key: "label", label: "البند" },
        { key: "amount", label: "القيمة", align: "left" },
      ],
      rows: flat.map((r) => ({ label: r.label, amount: r.amount === "" ? "" : (r.neg ? `(${fmtAr(r.amount)})` : fmtAr(r.amount)) })),
      showIndex: false,
      summary: [{ label: "صافي التدفّق النقدي", value: fmtAr(cf.net), large: true, bold: true }],
    });
  }

  return (
    <ReportShell
      title="قائمة التدفّقات النقدية"
      description="مقبوضات/مدفوعات حسب طريقة الدفع (أساس نقدي)."
      note={NOTE}
      kpis={kpis}
      onExport={onExport}
      onPrint={onPrint}
      exportDisabled={!cf}
      printDisabled={!cf}
      filters={
        <div className="flex flex-wrap items-end gap-3">
          <PeriodFilter value={period} onChange={setPeriod} />
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">الفرع</label>
            <AppSelect className="h-9" value={String(branchId)} onValueChange={(value) => setBranchId(value ? Number(value) : "")}>
              <option value="">الكل</option>
              {branches.data?.map((b) => (<option key={b.id} value={b.id}>{b.name}</option>))}
            </AppSelect>
          </div>
        </div>
      }
    >
      <Card>
        <CardContent className="p-0">
          {/* مُضمَّن: العنوان والملاحظة في ReportShell أعلاه، فشريطُ «س من ص صفّ» ضجيجٌ هنا. */}
          <DataTable<CashFlowLine>
            embedded
            searchable={false}
            bounded={false}
            pageSize={Infinity}
            columns={cashFlowColumns}
            data={flat}
            loading={q.isLoading}
            errorState={{ isError: q.isError, message: "تعذّر تحميل التقرير.", onRetry: () => void q.refetch() }}
            /* `!` مقصود: صفّ الجدول يحمل `odd:bg-background` وخصوصيّتُه (صنف + :nth-child)
               أعلى من صنفٍ مجرّد ⇒ بلا !important يختفي التمييز على الصفوف الفردية. */
            getRowClassName={(r) => (isEmphasizedLine(r) ? "font-bold !bg-muted/30" : undefined)}
            emptyText="لا بيانات."
          />
        </CardContent>
      </Card>
    </ReportShell>
  );
}
