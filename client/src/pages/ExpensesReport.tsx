// تقرير المصروفات — المصروفات الفعّالة مصنّفةً حسب الفئة + أكبر جهات الصرف.
// عرض (تبويبان) + تصدير Excel + طباعة A4 (ReportShell + PeriodFilter + printReportDoc).
// ⚠️ يشمل المصروفات الفعّالة فقط (expenseStatus='ACTIVE') ضمن تاريخ المصروف.
import { useMemo, useState } from "react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { PeriodFilter, DEFAULT_PERIOD, type PeriodValue } from "@/components/reports/PeriodFilter";
import { Card, CardContent } from "@/components/ui/card";
import { fmtAr, formatIqd } from "@/lib/money";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";

type ER = RouterOutputs["reports"]["expensesReport"];
type Tab = "category" | "payee";

const NOTE = "يشمل المصروفات الفعّالة (غير الملغاة) ضمن تاريخ المصروف. حسب الفرع المحدّد. أكبر ٢٠ جهة صرف.";
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
  });
  const er: ER | undefined = q.data;

  const kpis: KpiItem[] = er
    ? [
        { label: "إجمالي المصروفات", value: fmtAr(er.total), tone: "warning" },
        { label: "عدد الفئات", value: String(er.byCategory.length), tone: "info" },
        { label: "جهات الصرف (أعلى ٢٠)", value: String(er.byPayee.length), tone: "info" },
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
          {q.isLoading || !er ? (
            <p className="p-8 text-center text-sm text-muted-foreground">{q.isLoading ? "جارٍ التحميل…" : "لا بيانات."}</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="p-3 text-right font-medium">{tab === "category" ? "الفئة" : "جهة الصرف"}</th>
                  <th className="p-3 text-left font-medium">المبلغ</th>
                  <th className="p-3 text-left font-medium">العدد</th>
                </tr>
              </thead>
              <tbody>
                {activeRows.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="p-6 text-center text-sm text-muted-foreground">لا مصروفات في الفترة.</td>
                  </tr>
                ) : (
                  activeRows.map((r, i) => (
                    <tr key={i} className="border-b last:border-0">
                      <td className="p-3 text-right">{r.label}</td>
                      <td className="p-3 text-left tabular-nums text-rose-600" dir="ltr">{fmtAr(r.amount)}</td>
                      <td className="p-3 text-left tabular-nums text-muted-foreground" dir="ltr">{r.count}</td>
                    </tr>
                  ))
                )}
              </tbody>
              <tfoot>
                <tr className="border-t font-bold bg-muted/30">
                  <td className="p-3 text-right">الإجمالي</td>
                  <td className="p-3 text-left tabular-nums" dir="ltr">{fmtAr(er.total)}</td>
                  <td className="p-3 text-left" dir="ltr"></td>
                </tr>
              </tfoot>
            </table>
          )}
        </CardContent>
      </Card>
    </ReportShell>
  );
}
