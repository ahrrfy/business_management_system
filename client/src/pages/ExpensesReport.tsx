// تقرير المصروفات — المصروفات الفعّالة مصنّفةً حسب الفئة + أكبر جهات الصرف.
// عرض (تبويبان) + تصدير Excel + طباعة A4 (ReportShell + PeriodFilter + printReportDoc).
// ⚠️ يشمل المصروفات الفعّالة فقط (expenseStatus='ACTIVE') ضمن تاريخ المصروف.
import { useMemo, useState } from "react";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { AppSelect } from "@/components/ui/AppSelect";
import { Link } from "wouter";
import { ExternalLink } from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { PeriodFilter, DEFAULT_PERIOD, type PeriodValue } from "@/components/reports/PeriodFilter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

import { fmtAr, formatIqd } from "@/lib/money";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";

type ER = RouterOutputs["reports"]["expensesReport"];
type Tab = "category" | "payee";

// حدّ جهات الصرف — كان صلباً ٢٠ صامتاً؛ الآن أعلى بكثير (الخادم يقبل حتى ٢٠٠).
const PAYEE_LIMIT = 100;

const NOTE = `يشمل المصروفات الفعّالة (غير الملغاة) ضمن تاريخ المصروف. حسب الفرع المحدّد. أعلى ${PAYEE_LIMIT} جهة صرف.`;
const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export default function ExpensesReport() {
  const [period, setPeriod] = useState<PeriodValue>(DEFAULT_PERIOD);
  const [branchId, setBranchId] = useState<number | "">("");
  const [tab, setTab] = useState<Tab>("category");
  const branches = trpc.branches.list.useQuery();
  const q = trpc.reports.expensesReport.useQuery({
    from: period.from,
    to: period.to,
    branchId: branchId ? Number(branchId) : undefined,
    payeeLimit: PAYEE_LIMIT,
  });
  const er: ER | undefined = q.data;

  const kpis: KpiItem[] = er
    ? [
        { label: "إجمالي المصروفات", value: fmtAr(er.total), tone: "warning" },
        { label: "عدد الفئات", value: String(er.byCategory.length), tone: "info" },
        { label: `جهات الصرف (أعلى ${PAYEE_LIMIT})`, value: String(er.byPayee.length), tone: "info" },
      ]
    : [];

  const branchLabel = branchId ? (branches.data?.find((b) => b.id === branchId)?.name ?? String(branchId)) : "الكل";

  const activeRows = useMemo(() => {
    if (!er) return [] as { label: string; amount: string; count: number }[];
    return tab === "category"
      ? er.byCategory.map((c) => ({ label: c.label, amount: c.amount, count: c.count }))
      : er.byPayee.map((p) => ({ label: p.payee, amount: p.amount, count: p.count }));
  }, [er, tab]);

  function onExport() {
    if (!er) return;
    const isCat = tab === "category";
    exportRows(activeRows, {
      filename: `المصروفات-${isCat ? "حسب-الفئة" : "حسب-جهة-الصرف"}-${period.from}-${period.to}`,
      columns: [
        { key: "label", header: isCat ? "الفئة" : "جهة الصرف" },
        { key: "amount", header: "المبلغ", map: (r) => Number(r.amount) },
        { key: "count", header: "العدد", map: (r) => r.count },
      ],
    });
  }

  function onPrint() {
    if (!er) return;
    const isCat = tab === "category";
    printReportDoc({
      title: isCat ? "تقرير المصروفات — حسب الفئة" : "تقرير المصروفات — حسب جهة الصرف",
      headerExtra: [
        { label: "الفترة", value: `${period.from} — ${period.to}` },
        { label: "الفرع", value: branchLabel },
      ],
      note: NOTE,
      columns: [
        { key: "label", label: isCat ? "الفئة" : "جهة الصرف" },
        { key: "amount", label: "المبلغ", align: "left" },
        { key: "count", label: "العدد", align: "left" },
      ],
      rows: activeRows.map((r) => ({ label: r.label, amount: fmtAr(r.amount), count: String(r.count) })),
      showIndex: true,
      summary: [{ label: "إجمالي المصروفات", value: formatIqd(er.total), large: true, bold: true }],
    });
  }
  /**
   * أعمدة تقرير المصروفات + ذيل الإجماليات.
   * الرأس الأوّل يتبدّل مع التبويب (فئة / جهة صرف) — لذلك الأعمدة تعتمد على `tab`.
   */
  const expenseColumns = useMemo<ColumnDef<(typeof activeRows)[number], unknown>[]>(() => [
    {
      id: "label", header: tab === "category" ? "الفئة" : "جهة الصرف",
      accessorFn: (r) => r.label,
      footer: () => (er ? "الإجمالي" : null),
      meta: { kind: "text", wrap: true },
    },
    {
      id: "amount", header: "المبلغ",
      accessorFn: (r) => Number(r.amount),
      cell: ({ row }) => <span className="text-money-negative">{fmtAr(row.original.amount)}</span>,
      footer: () => (er ? fmtAr(er.total) : null),
      meta: { kind: "money" },
    },
    {
      id: "count", header: "العدد",
      accessorFn: (r) => Number(r.count),
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.count}</span>,
      meta: { kind: "number" },
    },
  ], [tab, er]);

  return (
    <ReportShell
      title="تقرير المصروفات"
      description="المصروفات الفعّالة مصنّفةً حسب الفئة وأكبر جهات الصرف."
      note={NOTE}
      kpis={kpis}
      onExport={onExport}
      onPrint={onPrint}
      exportDisabled={!er}
      printDisabled={!er}
      actions={
        // شاشة سجلّ المصروفات لا تقرأ فلاتر من الرابط (لا q/from/to في URL) — رابطٌ بسيط بلا
        // تمرير معاملات بدل ادّعاء «فتح مفلتَر» لا يعمل فعلياً.
        <Link href="/expenses">
          <Button variant="outline" size="sm" className="gap-1.5">
            <ExternalLink aria-hidden className="size-3.5" />
            فتح سجلّ المصروفات
          </Button>
        </Link>
      }
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
      {/* تبويبا العرض */}
      <div className="flex gap-1">
        {([
          { key: "category" as Tab, label: "حسب الفئة" },
          { key: "payee" as Tab, label: "حسب جهة الصرف" },
        ]).map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`rounded-md px-3 py-1.5 text-xs transition ${
              tab === t.key
                ? "bg-primary text-primary-foreground font-medium"
                : "bg-muted/60 text-foreground/70 hover:bg-accent"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <Card>
        <CardContent className="p-0">
          <DataTable
            columns={expenseColumns}
            data={activeRows}
            loading={q.isLoading}
            searchable={false}
            errorState={{ isError: q.isError, message: q.error?.message, onRetry: () => void q.refetch() }}
            emptyText="لا مصروفات في الفترة."
          />
        </CardContent>
      </Card>
    </ReportShell>
  );
}
