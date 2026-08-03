// تقرير الخزينة — مقبوضات/مدفوعات حسب طريقة الدفع (أساس نقدي) + ملخّص فروقات الورديات.
// عرض + تصدير Excel + طباعة A4 (ReportShell + PeriodFilter + printReportDoc).
// ⚠️ أساس نقدي: من المقبوضات/المدفوعات المكتملة (receipts COMPLETED) لا الاستحقاق.
import { useMemo, useState } from "react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { PeriodFilter, DEFAULT_PERIOD, type PeriodValue } from "@/components/reports/PeriodFilter";
import { Card, CardContent } from "@/components/ui/card";
import { fmtAr, formatIqd, D } from "@/lib/money";
import { exportSheets, type SheetSpec } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { CopyButton, CopyInline } from "@/components/CopyButton";
import { LoadingState, ErrorState, TableEmptyRow } from "@/components/PageState";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { fmtDateTime } from "@/lib/date";

type TS = RouterOutputs["reports"]["treasurySummary"];

const NOTE =
  "أساس نقدي مباشر: من المقبوضات/المدفوعات المكتملة (لا أساس الاستحقاق). الفروقات حسب الورديات المفتوحة في الفترة (تاريخ الفتح). النقد حسب الفرع المحدّد.";
const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const SHIFT_TYPE_LABEL: Record<string, string> = {
  RETAIL: "تجزئة",
  RECEPTION: "استقبال",
  PRINT_SERVICES: "خدمات طباعة",
};
const RECONCILIATION_LABEL: Record<string, string> = {
  MATCHED: "مطابقة",
  EXPLAINED: "فرق مفسّر",
  MANAGER_APPROVED: "معتمدة إدارياً",
};

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
    () => (ts ? ts.methods.map((m) => ({ ...m, settlementLabel: m.settlement === "DRAWER" ? "درج الكاشير" : "إلكتروني / خارج الدرج" })) : []),
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
    exportSheets(`الخزينة-${period.from}-${period.to}`, [
      {
        sheetName: "طرق الدفع",
        title: "تقرير الخزينة — طرق الدفع",
        meta: [{ label: "الفترة", value: `${period.from} — ${period.to}` }, { label: "الفرع", value: branchLabel }],
        rows,
        columns: [
          { key: "label", header: "طريقة الدفع" },
          { key: "settlementLabel", header: "مكان التسوية" },
          { key: "in", header: "مقبوضات", money: true, map: (r) => Number(r.in) },
          { key: "out", header: "مدفوعات", money: true, map: (r) => Number(r.out) },
          { key: "net", header: "الصافي", money: true, map: (r) => Number(r.net) },
        ],
        totalsRow: { label: "الإجمالي", in: Number(ts.totalIn), out: Number(ts.totalOut), net: Number(ts.net) },
      } as SheetSpec<any>,
      {
        sheetName: "تسوية الورديات",
        title: "تقرير الخزينة — تسوية الورديات النقدية",
        meta: [{ label: "الفترة", value: `${period.from} — ${period.to}` }, { label: "الفرع", value: branchLabel }],
        rows: ts.shifts.rows,
        columns: [
          { key: "id", header: "رقم الوردية" },
          { key: "branchName", header: "الفرع" },
          { key: "cashierName", header: "الكاشير" },
          { key: "shiftType", header: "النوع", map: (r) => SHIFT_TYPE_LABEL[r.shiftType] ?? r.shiftType },
          { key: "status", header: "الحالة", map: (r) => r.status === "CLOSED" ? "مغلقة" : "مفتوحة" },
          { key: "openedAt", header: "فُتحت", map: (r) => fmtDateTime(r.openedAt) },
          { key: "closedAt", header: "أُغلقت", map: (r) => r.closedAt ? fmtDateTime(r.closedAt) : "—" },
          { key: "openingBalance", header: "افتتاحي", money: true, map: (r) => Number(r.openingBalance) },
          { key: "expectedCash", header: "نقد متوقّع", money: true, map: (r) => r.expectedCash == null ? "" : Number(r.expectedCash) },
          { key: "countedCash", header: "نقد معدود", money: true, map: (r) => r.countedCash == null ? "" : Number(r.countedCash) },
          { key: "variance", header: "الفرق", money: true, map: (r) => r.variance == null ? "" : Number(r.variance) },
          { key: "reconciliationStatus", header: "التسوية", map: (r) => r.reconciliationStatus ? (RECONCILIATION_LABEL[r.reconciliationStatus] ?? r.reconciliationStatus) : "بانتظار الإغلاق" },
        ],
        totalsRow: { id: "الإجمالي", countedCash: Number(ts.shifts.totalCounted), variance: Number(ts.shifts.totalVariance) },
      } as SheetSpec<any>,
    ]);
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
        { key: "settlement", label: "مكان التسوية" },
        { key: "in", label: "مقبوضات", align: "left" },
        { key: "out", label: "مدفوعات", align: "left" },
        { key: "net", label: "الصافي", align: "left" },
      ],
      rows: [
        ...ts.methods.map((m) => ({ label: m.label, settlement: m.settlement === "DRAWER" ? "درج الكاشير" : "إلكتروني / خارج الدرج", in: fmtAr(m.in), out: fmtAr(m.out), net: fmtAr(m.net) })),
        { label: "الإجمالي", settlement: "—", in: fmtAr(ts.totalIn), out: fmtAr(ts.totalOut), net: fmtAr(ts.net) },
      ],
      showIndex: false,
      orientation: "landscape",
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
          {q.isLoading ? (
            <LoadingState />
          ) : q.isError ? (
            <ErrorState message="تعذّر تحميل التقرير." onRetry={() => void q.refetch()} />
          ) : !ts ? (
            <p className="p-8 text-center text-sm text-muted-foreground">لا بيانات.</p>
          ) : (
            <ScrollTableShell bordered={false}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="p-3 text-right font-medium">طريقة الدفع</th>
                  <th className="p-3 text-right font-medium">مكان التسوية</th>
                  <th className="p-3 text-right font-medium">مقبوضات</th>
                  <th className="p-3 text-right font-medium">مدفوعات</th>
                  <th className="p-3 text-right font-medium">الصافي</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <TableEmptyRow colSpan={5} message="لا حركات في الفترة." />
                ) : (
                  rows.map((r, i) => (
                    <tr key={i} className="border-b last:border-0">
                      <td className="p-3 text-right font-medium">{r.label}</td>
                      <td className="p-3 text-right text-xs text-muted-foreground">
                        <span className={`inline-flex rounded-full px-2 py-0.5 ${r.settlement === "DRAWER" ? "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]" : "bg-[var(--sem-info-bg)] text-[var(--sem-info)]"}`}>
                          {r.settlementLabel}
                        </span>
                      </td>
                      <td className="p-3 text-right tabular-nums text-money-positive" dir="ltr">
                        <CopyInline value={String(r.in)} display={fmtAr(r.in)} mono={false} />
                      </td>
                      <td className="p-3 text-right tabular-nums text-money-negative" dir="ltr">
                        <CopyInline value={String(r.out)} display={fmtAr(r.out)} mono={false} />
                      </td>
                      <td className={`p-3 text-right tabular-nums font-semibold ${D(r.net).lt(0) ? "text-money-negative" : "text-money-positive"}`} dir="ltr">
                        <CopyInline value={String(r.net)} display={fmtAr(r.net)} mono={false} />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              <tfoot>
                <tr className="border-t font-bold bg-muted/30">
                  <td className="p-3 text-right">الإجمالي</td>
                  <td className="p-3 text-right text-muted-foreground">—</td>
                  <td className="p-3 text-right tabular-nums" dir="ltr">
                    <CopyInline value={String(ts.totalIn)} display={fmtAr(ts.totalIn)} mono={false} />
                  </td>
                  <td className="p-3 text-right tabular-nums" dir="ltr">
                    <CopyInline value={String(ts.totalOut)} display={fmtAr(ts.totalOut)} mono={false} />
                  </td>
                  <td className="p-3 text-right tabular-nums" dir="ltr">
                    <CopyInline value={String(ts.net)} display={fmtAr(ts.net)} mono={false} />
                  </td>
                </tr>
              </tfoot>
            </table>
            </ScrollTableShell>
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

      {ts && (
        <Card>
          <CardContent className="p-0">
            <div className="border-b px-4 py-3">
              <h2 className="text-sm font-bold">تفاصيل تسوية الورديات النقدية</h2>
              <p className="mt-1 text-xs text-muted-foreground">المتوقّع والمعدود هنا للنقد الموجود في الدرج فقط؛ لا تدخل البطاقة أو التحويل في مبلغ إغلاق الكاشير.</p>
            </div>
            <ScrollTableShell bordered={false} maxHeightClass="max-h-[calc(100dvh-19rem)]">
              <table className="w-full text-sm">
                <thead><tr className="border-b text-xs text-muted-foreground">
                  <th className="p-3 text-right font-medium">#</th><th className="p-3 text-right font-medium">الفرع</th><th className="p-3 text-right font-medium">الكاشير</th><th className="p-3 text-right font-medium">النوع</th><th className="p-3 text-right font-medium">الفترة</th><th className="p-3 text-right font-medium">الحالة</th><th className="p-3 text-right font-medium">المتوقّع النقدي</th><th className="p-3 text-right font-medium">المعدود</th><th className="p-3 text-right font-medium">الفرق</th><th className="p-3 text-right font-medium">التسوية</th>
                </tr></thead>
                <tbody>
                  {ts.shifts.rows.length === 0 ? <TableEmptyRow colSpan={10} message="لا ورديات فُتحت في الفترة." /> : ts.shifts.rows.map((s) => (
                    <tr key={s.id} className="border-b last:border-0">
                      <td className="p-3 tabular-nums" dir="ltr">{s.id}</td><td className="p-3">{s.branchName ?? "—"}</td><td className="p-3">{s.cashierName ?? "—"}</td><td className="p-3 text-xs">{SHIFT_TYPE_LABEL[s.shiftType] ?? s.shiftType}</td>
                      <td className="p-3 text-xs whitespace-nowrap" dir="ltr">{fmtDateTime(s.openedAt)}<br />{s.closedAt ? fmtDateTime(s.closedAt) : "مفتوحة"}</td>
                      <td className="p-3"><span className={`inline-flex rounded-full px-2 py-0.5 text-xs ${s.status === "CLOSED" ? "bg-muted text-muted-foreground" : "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]"}`}>{s.status === "CLOSED" ? "مغلقة" : "مفتوحة"}</span></td>
                      <td className="p-3 tabular-nums" dir="ltr">{s.expectedCash == null ? "—" : <CopyInline value={s.expectedCash} display={fmtAr(s.expectedCash)} mono={false} />}</td>
                      <td className="p-3 tabular-nums" dir="ltr">{s.countedCash == null ? "—" : <CopyInline value={s.countedCash} display={fmtAr(s.countedCash)} mono={false} />}</td>
                      <td className={`p-3 tabular-nums font-semibold ${s.variance != null && D(s.variance).lt(0) ? "text-money-negative" : "text-money-positive"}`} dir="ltr">{s.variance == null ? "—" : <CopyInline value={s.variance} display={fmtAr(s.variance)} mono={false} />}</td>
                      <td className="p-3 text-xs">{s.reconciliationStatus ? (RECONCILIATION_LABEL[s.reconciliationStatus] ?? s.reconciliationStatus) : "بانتظار الإغلاق"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollTableShell>
            {ts.shifts.count > ts.shifts.shownCount && <p className="border-t px-4 py-2 text-xs text-muted-foreground">تُعرض أحدث {ts.shifts.shownCount} وردية من أصل {ts.shifts.count}. صدّر Excel للحصول على الصفوف المعروضة.</p>}
          </CardContent>
        </Card>
      )}
    </ReportShell>
  );
}
