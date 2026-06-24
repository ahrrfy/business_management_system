// تقرير الخزينة — مقبوضات/مدفوعات حسب طريقة الدفع (أساس نقدي) + ملخّص فروقات الورديات.
// عرض + تصدير Excel + طباعة A4 (ReportShell + PeriodFilter + printReportDoc).
// ⚠️ أساس نقدي: من المقبوضات/المدفوعات المكتملة (receipts COMPLETED) لا الاستحقاق.
import { useMemo, useState } from "react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { PeriodFilter, DEFAULT_PERIOD, type PeriodValue } from "@/components/reports/PeriodFilter";
import { Card, CardContent } from "@/components/ui/card";
import { fmtAr, formatIqd, D } from "@/lib/money";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { CopyButton, CopyInline } from "@/components/CopyButton";
import { LoadingState, TableEmptyRow } from "@/components/PageState";

type TS = RouterOutputs["reports"]["treasurySummary"];

const NOTE =
  "أساس نقدي مباشر: من المقبوضات/المدفوعات المكتملة (لا أساس الاستحقاق). الفروقات حسب الورديات المفتوحة في الفترة (تاريخ الفتح). النقد حسب الفرع المحدّد.";
const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export default function TreasuryReport() {
  const [period, setPeriod] = useState<PeriodValue>(DEFAULT_PERIOD);
  const [branchId, setBranchId] = useState<number | "">("");
  const branches = trpc.branches.list.useQuery();
  const q = trpc.reports.treasurySummary.useQuery({
    from: period.from,
    to: period.to,
    branchId: branchId ? Number(branchId) : undefined,
  });
  const ts: TS | undefined = q.data;

  const kpis: KpiItem[] = ts
    ? [
        { label: "المقبوضات", value: fmtAr(ts.totalIn), tone: "positive" },
        { label: "المدفوعات", value: fmtAr(ts.totalOut), tone: "negative" },
        { label: "صافي الصندوق", value: fmtAr(ts.net), tone: D(ts.net).gte(0) ? "positive" : "negative" },
        {
          label: "فروقات الورديات",
          value: fmtAr(ts.shifts.totalVariance),
          tone: D(ts.shifts.totalVariance).gte(0) ? "info" : "negative",
          hint: `${ts.shifts.count} وردية`,
        },
      ]
    : [];

  // صفوف جدول طرق الدفع لإعادة الاستعمال (عرض/تصدير/طباعة).
  const rows = useMemo(
    () => (ts ? ts.methods.map((m) => ({ label: m.label, in: m.in, out: m.out })) : []),
    [ts],
  );

  const branchLabel = branchId ? (branches.data?.find((b) => b.id === branchId)?.name ?? String(branchId)) : "الكل";

  // نص مُلخَّص قابل للنسخ (للترويسة).
  const summaryText = useMemo(() => {
    if (!ts) return "";
    const lines = [
      "تقرير الخزينة",
      `الفترة: ${period.from} — ${period.to}`,
      `الفرع: ${branchLabel}`,
      "",
      `المقبوضات: ${fmtAr(ts.totalIn)}`,
      `المدفوعات: ${fmtAr(ts.totalOut)}`,
      `صافي الصندوق: ${fmtAr(ts.net)}`,
      "",
      `عدد الورديات: ${ts.shifts.count}`,
      `النقد المعدود: ${fmtAr(ts.shifts.totalCounted)}`,
      `إجمالي الفروقات: ${fmtAr(ts.shifts.totalVariance)}`,
    ];
    return lines.join("\n");
  }, [ts, period.from, period.to, branchLabel]);

  function onExport() {
    if (!ts) return;
    const data = [
      ...ts.methods.map((m) => ({ label: m.label, in: m.in, out: m.out })),
      { label: "الإجمالي", in: ts.totalIn, out: ts.totalOut },
    ];
    exportRows(data, {
      filename: `الخزينة-${period.from}-${period.to}`,
      columns: [
        { key: "label", header: "طريقة الدفع" },
        { key: "in", header: "مقبوضات", map: (r) => Number(r.in) },
        { key: "out", header: "مدفوعات", map: (r) => Number(r.out) },
      ],
    });
  }

  function onPrint() {
    if (!ts) return;
    printReportDoc({
      title: "تقرير الخزينة",
      headerExtra: [
        { label: "الفترة", value: `${period.from} — ${period.to}` },
        { label: "الفرع", value: branchLabel },
      ],
      note: NOTE,
      columns: [
        { key: "label", label: "طريقة الدفع" },
        { key: "in", label: "مقبوضات", align: "left" },
        { key: "out", label: "مدفوعات", align: "left" },
      ],
      rows: [
        ...ts.methods.map((m) => ({ label: m.label, in: fmtAr(m.in), out: fmtAr(m.out) })),
        { label: "الإجمالي", in: fmtAr(ts.totalIn), out: fmtAr(ts.totalOut) },
      ],
      showIndex: false,
      summary: [
        { label: "صافي الصندوق", value: formatIqd(ts.net), large: true, bold: true },
        { label: "النقد المعدود (الورديات)", value: formatIqd(ts.shifts.totalCounted) },
        { label: "فروقات الورديات", value: formatIqd(ts.shifts.totalVariance) },
      ],
    });
  }

  return (
    <ReportShell
      title="تقرير الخزينة"
      description="مقبوضات/مدفوعات حسب طريقة الدفع (أساس نقدي) + فروقات الورديات."
      note={NOTE}
      kpis={kpis}
      actions={
        ts ? (
          <CopyButton value={summaryText} title="نسخ المُلخَّص" size="sm" variant="outline" />
        ) : null
      }
      onExport={onExport}
      onPrint={onPrint}
      exportDisabled={!ts}
      printDisabled={!ts}
      filters={
        <div className="flex flex-wrap items-end gap-3">
          <PeriodFilter value={period} onChange={setPeriod} />
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">الفرع</label>
            <select className={selectCls} value={branchId} onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : "")}>
              <option value="">الكل</option>
              {branches.data?.map((b) => (<option key={b.id} value={b.id}>{b.name}</option>))}
            </select>
          </div>
        </div>
      }
    >
      <Card>
        <CardContent className="p-0">
          {q.isLoading || !ts ? (
            q.isLoading ? (
              <LoadingState />
            ) : (
              <p className="p-8 text-center text-sm text-muted-foreground">لا بيانات.</p>
            )
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="p-3 text-right font-medium">طريقة الدفع</th>
                  <th className="p-3 text-left font-medium">مقبوضات</th>
                  <th className="p-3 text-left font-medium">مدفوعات</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <TableEmptyRow colSpan={3} message="لا حركات في الفترة." />
                ) : (
                  rows.map((r, i) => (
                    <tr key={i} className="border-b last:border-0">
                      <td className="p-3 text-right">{r.label}</td>
                      <td className="p-3 text-left tabular-nums text-money-positive" dir="ltr">
                        <CopyInline value={String(r.in)} display={fmtAr(r.in)} mono={false} />
                      </td>
                      <td className="p-3 text-left tabular-nums text-money-negative" dir="ltr">
                        <CopyInline value={String(r.out)} display={fmtAr(r.out)} mono={false} />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              <tfoot>
                <tr className="border-t font-bold bg-muted/30">
                  <td className="p-3 text-right">الإجمالي</td>
                  <td className="p-3 text-left tabular-nums" dir="ltr">
                    <CopyInline value={String(ts.totalIn)} display={fmtAr(ts.totalIn)} mono={false} />
                  </td>
                  <td className="p-3 text-left tabular-nums" dir="ltr">
                    <CopyInline value={String(ts.totalOut)} display={fmtAr(ts.totalOut)} mono={false} />
                  </td>
                </tr>
              </tfoot>
            </table>
          )}
        </CardContent>
      </Card>

      {/* ملخّص فروقات الورديات */}
      {ts && (
        <Card>
          <CardContent className="pt-4 pb-3">
            <h2 className="mb-3 text-sm font-bold">ملخّص الورديات في الفترة</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="rounded-md border p-3 text-center">
                <p className="text-xs text-muted-foreground">عدد الورديات</p>
                <p className="text-lg font-bold tabular-nums" dir="ltr">
                  <CopyInline value={String(ts.shifts.count)} display={String(ts.shifts.count)} mono={false} />
                </p>
              </div>
              <div className="rounded-md border p-3 text-center">
                <p className="text-xs text-muted-foreground">النقد المعدود</p>
                <p className="text-lg font-bold tabular-nums" dir="ltr">
                  <CopyInline
                    value={String(ts.shifts.totalCounted)}
                    display={fmtAr(ts.shifts.totalCounted)}
                    mono={false}
                  />
                </p>
              </div>
              <div className="rounded-md border p-3 text-center">
                <p className="text-xs text-muted-foreground">إجمالي الفروقات</p>
                <p
                  className={`text-lg font-bold tabular-nums ${D(ts.shifts.totalVariance).lt(0) ? "text-money-negative" : "text-money-positive"}`}
                  dir="ltr"
                >
                  <CopyInline
                    value={String(ts.shifts.totalVariance)}
                    display={fmtAr(ts.shifts.totalVariance)}
                    mono={false}
                  />
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </ReportShell>
  );
}
