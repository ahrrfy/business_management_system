// تقرير «مطابقة إقفال اليوم للنقد» — يوازن نقد الدرج لكل وردية في يومٍ وفرع:
//   المتوقَّع (من الدفتر) مقابل المعدود (نقد الإغلاق) مقابل الفرق (drift = variance الوردية).
// تسليمات الخزينة تُعرَض منفصلةً (لا تُطرَح من المتوقَّع) — راجع reportsDayCloseService للتعليل.
import { useState } from "react";
import { CheckCircle2, AlertTriangle, Wallet, Building2, Clock, ArrowLeftRight } from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { Card, CardContent } from "@/components/ui/card";
import { LoadingState } from "@/components/PageState";
import { fmtAr, formatIqd } from "@/lib/money";
import { fmtDate } from "@/lib/date";
import { exportRows } from "@/lib/export";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";

type DC = RouterOutputs["reports"]["dayCloseReconciliation"];

const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const NOTE =
  "المتوقَّع = الرصيد الافتتاحي + المقبوضات النقدية − المرتجعات والمصروفات النقدية (النقد فقط، درج الكاشير). " +
  "تسليمات الخزينة تُعرَض منفصلةً ولا تُطرَح من المتوقَّع (هي نقلٌ للنقد المعدود بعد العدّ) — «المتبقّي في الدرج» = المعدود − التسليمات. " +
  "الفرق = المعدود − المتوقَّع (يطابق فرق الوردية في تقرير Z): موجب = فائض، سالب = عجز.";

/** تاريخ اليوم YYYY-MM-DD (UTC) — قيمة ابتدائية لمنتقي التاريخ. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function DayCloseReport() {
  const [date, setDate] = useState<string>(todayUtc);
  const [branchId, setBranchId] = useState<number | "">("");
  const branches = trpc.branches.list.useQuery();

  const q = trpc.reports.dayCloseReconciliation.useQuery({
    date,
    branchId: branchId ? Number(branchId) : undefined,
  });
  const dc: DC | undefined = q.data;

  const branchLabel = branchId
    ? branches.data?.find((b) => b.id === branchId)?.name ?? String(branchId)
    : "كل الفروع";

  const driftTone = (drift: string | null): "positive" | "negative" | "warning" | "default" => {
    if (drift == null) return "default";
    const n = Number(drift);
    if (n === 0) return "positive";
    return n > 0 ? "warning" : "negative";
  };

  const kpis: KpiItem[] = dc
    ? [
        { label: "المتوقَّع في الدرج", value: fmtAr(dc.totals.expected), tone: "info", hint: "الرصيد الافتتاحي + المقبوضات − المرتجعات والمصروفات" },
        { label: "المعدود عند الإغلاق", value: fmtAr(dc.totals.counted), tone: "default", hint: `${dc.totals.closedCount} وردية مغلقة` },
        { label: "الفرق (فائض/عجز)", value: fmtAr(dc.totals.drift), tone: driftTone(dc.totals.drift), hint: dc.driftCount === 0 ? "كل الورديات مطابقة" : `${dc.driftCount} وردية بفرق` },
        { label: "سُلّم للخزينة", value: fmtAr(dc.totals.handoversCash), tone: "default", hint: `المتبقّي في الأدراج: ${fmtAr(dc.totals.retainedInDrawer)}` },
      ]
    : [];

  function onExport() {
    if (!dc) return;
    exportRows(dc.shifts, {
      filename: `مطابقة-إقفال-اليوم-${date}-${branchId || "الكل"}`,
      columns: [
        { key: "shiftId", header: "الوردية", map: (r) => `#${r.shiftId}` },
        { key: "branchName", header: "الفرع", map: (r) => r.branchName ?? "" },
        { key: "userName", header: "الكاشير", map: (r) => r.userName ?? "" },
        { key: "shiftType", header: "النوع", map: (r) => (r.shiftType === "RECEPTION" ? "استقبال" : "تجزئة") },
        { key: "status", header: "الحالة", map: (r) => (r.status === "CLOSED" ? "مغلقة" : "مفتوحة") },
        { key: "opening", header: "افتتاحي", map: (r) => Number(r.opening) },
        { key: "salesCash", header: "مبيعات نقدية", map: (r) => Number(r.salesCash) },
        { key: "collectionsCash", header: "تحصيلات", map: (r) => Number(r.collectionsCash) },
        { key: "otherIn", header: "مقبوضات أخرى", map: (r) => Number(r.otherIn) },
        { key: "cashIn", header: "إجمالي الداخل", map: (r) => Number(r.cashIn) },
        { key: "returnsCash", header: "مرتجعات", map: (r) => Number(r.returnsCash) },
        { key: "expensesCash", header: "مصروفات/سندات", map: (r) => Number(r.expensesCash) },
        { key: "otherOut", header: "مصروفات أخرى", map: (r) => Number(r.otherOut) },
        { key: "cashDrops", header: "سحب أثناء الوردية", map: (r) => Number(r.cashDrops) },
        { key: "operatingOut", header: "إجمالي الخارج التشغيلي", map: (r) => Number(r.operatingOut) },
        { key: "expected", header: "المتوقَّع", map: (r) => Number(r.expected) },
        { key: "counted", header: "المعدود", map: (r) => (r.counted == null ? "" : Number(r.counted)) },
        { key: "drift", header: "الفرق", map: (r) => (r.drift == null ? "" : Number(r.drift)) },
        { key: "handoversCash", header: "سُلّم للخزينة", map: (r) => Number(r.handoversCash) },
        { key: "retainedInDrawer", header: "المتبقّي بالدرج", map: (r) => (r.retainedInDrawer == null ? "" : Number(r.retainedInDrawer)) },
      ],
    });
  }

  return (
    <ReportShell
      title="مطابقة إقفال اليوم للنقد"
      description="مطابقة نقد درج الكاشير لكل وردية: المتوقَّع مقابل المعدود مقابل الفرق — بحبيبة الوردية والفرع."
      note={NOTE}
      kpis={kpis}
      onExport={onExport}
      exportDisabled={!dc || dc.shifts.length === 0}
      filters={
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">تاريخ اليوم</label>
            <input
              type="date"
              className={selectCls}
              value={date}
              max={todayUtc()}
              onChange={(e) => setDate(e.target.value || todayUtc())}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">الفرع</label>
            <select
              className={selectCls}
              value={branchId}
              onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : "")}
            >
              <option value="">كل الفروع</option>
              {branches.data?.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      }
    >
      {q.isLoading || !dc ? (
        <LoadingState />
      ) : dc.shifts.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            لا ورديات في {fmtDate(date)} لـ{branchLabel}.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          <ReconciliationHero dc={dc} />
          <ShiftTable dc={dc} />
        </div>
      )}
    </ReportShell>
  );
}

/** لوحة «المتوقَّع مقابل المعدود مقابل الفرق» — بلونٍ دلاليّ واضح على مجموع اليوم. */
function ReconciliationHero({ dc }: { dc: DC }) {
  const drift = Number(dc.totals.drift);
  const balanced = dc.driftCount === 0 && dc.totals.counted !== "0.00";
  const driftCls = drift === 0 ? "text-money-positive" : drift > 0 ? "text-stock-low" : "text-money-negative";
  const driftLabel = drift === 0 ? "مطابق" : drift > 0 ? "فائض" : "عجز";

  return (
    <Card className={balanced ? "border-money-positive/40" : dc.driftCount > 0 ? "border-money-negative/40" : undefined}>
      <CardContent className="p-4">
        <div className="grid grid-cols-1 items-center gap-3 sm:grid-cols-[1fr_auto_1fr_auto_1fr]">
          {/* المتوقَّع */}
          <div className="text-center">
            <p className="text-xs text-muted-foreground">المتوقَّع في الدرج</p>
            <p className="text-2xl font-bold tabular-nums text-[var(--sem-info)]" dir="ltr">{fmtAr(dc.totals.expected)}</p>
          </div>
          <div className="hidden text-muted-foreground sm:block" aria-hidden>
            <ArrowLeftRight className="size-5" />
          </div>
          {/* المعدود */}
          <div className="text-center">
            <p className="text-xs text-muted-foreground">المعدود عند الإغلاق</p>
            <p className="text-2xl font-bold tabular-nums" dir="ltr">{fmtAr(dc.totals.counted)}</p>
          </div>
          <div className="hidden text-muted-foreground sm:block" aria-hidden>=</div>
          {/* الفرق */}
          <div className="text-center">
            <p className="text-xs text-muted-foreground">الفرق</p>
            <p className={`inline-flex items-center justify-center gap-1 text-2xl font-bold tabular-nums ${driftCls}`} dir="ltr">
              {drift === 0 ? (
                <CheckCircle2 aria-hidden className="size-5" />
              ) : (
                <AlertTriangle aria-hidden className="size-5" />
              )}
              {fmtAr(dc.totals.drift)}
            </p>
            <p className={`mt-0.5 text-[11px] font-medium ${driftCls}`}>{driftLabel}</p>
          </div>
        </div>

        {/* سطر جسر التسليم (إن وُجد) */}
        {dc.totals.handoversCash !== "0.00" && (
          <p className="mt-3 border-t pt-2 text-center text-xs text-muted-foreground">
            منها سُلّم للخزينة: <span className="font-semibold tabular-nums text-foreground" dir="ltr">{fmtAr(dc.totals.handoversCash)}</span>
            {"  —  "}المتبقّي فعلاً في الأدراج: <span className="font-semibold tabular-nums text-foreground" dir="ltr">{fmtAr(dc.totals.retainedInDrawer)}</span>
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** جدول تفصيل الورديات. */
function ShiftTable({ dc }: { dc: DC }) {
  return (
    <Card>
      <CardContent className="p-0">
        <ScrollTableShell bordered={false}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/30 text-xs text-muted-foreground">
                <th className="p-3 text-right font-medium">الوردية</th>
                <th className="p-3 text-right font-medium">الكاشير</th>
                <th className="p-3 text-right font-medium">افتتاحي</th>
                <th className="p-3 text-right font-medium">داخل نقدي</th>
                <th className="p-3 text-right font-medium">خارج تشغيلي</th>
                <th className="p-3 text-right font-medium">المتوقَّع</th>
                <th className="p-3 text-right font-medium">المعدود</th>
                <th className="p-3 text-right font-medium">الفرق</th>
                <th className="p-3 text-right font-medium">سُلّم للخزينة</th>
              </tr>
            </thead>
            <tbody>
              {dc.shifts.map((sh) => {
                const drift = sh.drift == null ? null : Number(sh.drift);
                const driftCls =
                  drift == null ? "text-muted-foreground" : drift === 0 ? "text-money-positive" : drift > 0 ? "text-stock-low" : "text-money-negative";
                return (
                  <tr key={sh.shiftId} className="border-b last:border-0">
                    <td className="p-3 text-right">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-xs" dir="ltr">#{sh.shiftId}</span>
                        {sh.shiftType === "RECEPTION" && (
                          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">استقبال</span>
                        )}
                        {sh.status === "OPEN" ? (
                          <span className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[9px] badge-status-pending">
                            <Clock aria-hidden className="size-2.5" />مفتوحة
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
                        <Building2 aria-hidden className="size-2.5" />
                        {sh.branchName ?? "—"}
                      </div>
                    </td>
                    <td className="p-3 text-right text-xs">{sh.userName ?? "—"}</td>
                    <td className="p-3 text-right tabular-nums text-xs" dir="ltr">{fmtAr(sh.opening)}</td>
                    <td className="p-3 text-right tabular-nums text-xs text-money-positive" dir="ltr" title={`مبيعات ${fmtAr(sh.salesCash)} · تحصيلات ${fmtAr(sh.collectionsCash)} · أخرى ${fmtAr(sh.otherIn)}`}>
                      {fmtAr(sh.cashIn)}
                    </td>
                    <td className="p-3 text-right tabular-nums text-xs text-money-negative" dir="ltr" title={`مرتجعات ${fmtAr(sh.returnsCash)} · مصروفات ${fmtAr(sh.expensesCash)} · سحب أثناء الوردية ${fmtAr(sh.cashDrops)} · أخرى ${fmtAr(sh.otherOut)}`}>
                      {fmtAr(sh.operatingOut)}
                    </td>
                    <td className="p-3 text-right font-semibold tabular-nums text-[var(--sem-info)]" dir="ltr">{fmtAr(sh.expected)}</td>
                    <td className="p-3 text-right tabular-nums" dir="ltr">{sh.counted == null ? "—" : fmtAr(sh.counted)}</td>
                    <td className={`p-3 text-right font-semibold tabular-nums ${driftCls}`} dir="ltr">
                      {sh.drift == null ? (
                        <span className="text-[10px] text-muted-foreground">مفتوحة</span>
                      ) : (
                        <span className="inline-flex items-center justify-end gap-1">
                          {drift === 0 ? <CheckCircle2 aria-hidden className="size-3.5" /> : <AlertTriangle aria-hidden className="size-3.5" />}
                          {fmtAr(sh.drift)}
                        </span>
                      )}
                    </td>
                    <td className="p-3 text-right tabular-nums text-xs text-muted-foreground" dir="ltr">
                      {sh.handoversCash === "0.00" ? "—" : fmtAr(sh.handoversCash)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t-2 bg-muted/30 font-bold">
                <td className="p-3 text-right" colSpan={2}>
                  الإجمالي ({dc.totals.shiftCount} وردية · {dc.balancedCount} مطابقة · {dc.driftCount} بفرق)
                </td>
                <td className="p-3 text-right tabular-nums text-xs" dir="ltr">{fmtAr(dc.totals.opening)}</td>
                <td className="p-3 text-right tabular-nums text-xs text-money-positive" dir="ltr">{fmtAr(dc.totals.cashIn)}</td>
                <td className="p-3 text-right tabular-nums text-xs text-money-negative" dir="ltr">{fmtAr(dc.totals.operatingOut)}</td>
                <td className="p-3 text-right tabular-nums text-[var(--sem-info)]" dir="ltr">{fmtAr(dc.totals.expected)}</td>
                <td className="p-3 text-right tabular-nums" dir="ltr">{fmtAr(dc.totals.counted)}</td>
                <td className={`p-3 text-right tabular-nums ${Number(dc.totals.drift) === 0 ? "text-money-positive" : Number(dc.totals.drift) > 0 ? "text-stock-low" : "text-money-negative"}`} dir="ltr">
                  {fmtAr(dc.totals.drift)}
                </td>
                <td className="p-3 text-right tabular-nums text-xs text-muted-foreground" dir="ltr">{fmtAr(dc.totals.handoversCash)}</td>
              </tr>
            </tfoot>
          </table>
        </ScrollTableShell>
      </CardContent>
    </Card>
  );
}
