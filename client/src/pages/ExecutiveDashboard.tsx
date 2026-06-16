// لوحة المؤشّرات التنفيذية — لقطة قيادية تجمع أهمّ الأرقام من تقارير قائمة (بلا خلفية جديدة):
// قائمة الأرباح والخسائر (إيراد/ربح/هامش + مقارنة الفترة) + المركز المالي (نقد/ذمم/مخزون) +
// مقاييس اللوحة (تنبيهات مخزون + ذمم متأخّرة) + أبرز المنتجات (٥ بالإيراد، شريط SVG خفيف).
// تُركّب endpoints موجودة عبر ReportShell + PeriodFilter + reportDoc + export — نمط بقيّة التقارير.
import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import {
  PeriodFilter, DEFAULT_PERIOD, comparativeRange,
  type PeriodValue, type CompareMode,
} from "@/components/reports/PeriodFilter";
import { Card, CardContent } from "@/components/ui/card";
import { fmtAr, formatIqd, D } from "@/lib/money";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";

const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const NOTE =
  "لقطة قيادية تجمع أهمّ المؤشّرات من تقارير النظام (أرباح/خسائر، المركز المالي، التنبيهات، أبرز المنتجات). للتفصيل افتح التقرير المعنيّ من مركز التقارير. التكلفة = آخر تكلفة، الضريبة 0%.";

/** تغيّر نسبي % بين الحالي والسابق (decimal-safe، بلا parseFloat على المال). null عند تعذّر الحساب. */
function deltaPct(current: string | number, previous: string | number): number | null {
  const cur = D(current);
  const prev = D(previous);
  if (prev.isZero()) return cur.isZero() ? 0 : null; // من صفر ⇒ لا نسبة ذات معنى
  return cur.sub(prev).div(prev).times(100).toDecimalPlaces(1).toNumber();
}

/** تلميح المقارنة للمؤشّر (سهم + نسبة) — أخضر للصعود، أحمر للهبوط. */
function deltaHint(d: number | null): { text: string; up: boolean } | null {
  if (d === null) return null;
  const arrow = d > 0 ? "▲" : d < 0 ? "▼" : "▬";
  const sign = d > 0 ? "+" : "";
  return { text: `${arrow} ${sign}${d}% مقابل السابقة`, up: d >= 0 };
}

export default function ExecutiveDashboard() {
  const [period, setPeriod] = useState<PeriodValue>(DEFAULT_PERIOD);
  const [compare, setCompare] = useState<CompareMode>("none");
  const [branchId, setBranchId] = useState<number | "">("");

  const branches = trpc.branches.list.useQuery();
  const cmp = compare !== "none" ? comparativeRange(period.from, period.to, compare) : null;
  const branchArg = branchId ? Number(branchId) : undefined;

  // ───── تركيب التقارير القائمة ─────
  const pl = trpc.reports.profitAndLoss.useQuery({
    from: period.from,
    to: period.to,
    branchId: branchArg,
    compareFrom: cmp?.from,
    compareTo: cmp?.to,
  });
  const fin = trpc.reports.financialPosition.useQuery(branchArg ? { branchId: branchArg } : undefined);
  const metrics = trpc.reports.dashboardMetrics.useQuery(branchArg ? { branchId: branchArg } : undefined);
  const top = trpc.reports.topProducts.useQuery({
    from: period.from,
    to: period.to,
    branchId: branchArg,
    limit: 5,
    by: "revenue",
  });

  const cur = pl.data?.current;
  const prev = pl.data?.previous;
  const fp = fin.data;
  const dm = metrics.data;
  const topRows = top.data ?? [];

  const loading = pl.isLoading || fin.isLoading || metrics.isLoading;

  // ───── دلتا الإيراد/صافي الربح مقابل الفترة السابقة ─────
  const revDelta = cur && prev ? deltaHint(deltaPct(cur.revenue, prev.revenue)) : null;
  const netDelta = cur && prev ? deltaHint(deltaPct(cur.netProfit, prev.netProfit)) : null;

  // ───── شريط المؤشّرات ─────
  const kpis: KpiItem[] = useMemo(() => {
    if (!cur && !fp && !dm) return [];
    const items: KpiItem[] = [];
    if (cur) {
      items.push({
        label: "الإيراد",
        value: fmtAr(cur.revenue),
        tone: "info",
        hint: revDelta?.text,
      });
      items.push({
        label: "مجمل الربح",
        value: fmtAr(cur.grossProfit),
        tone: "positive",
        hint: `هامش ${cur.grossMarginPct}%`,
      });
      items.push({
        label: "صافي الربح",
        value: fmtAr(cur.netProfit),
        tone: D(cur.netProfit).gte(0) ? "positive" : "negative",
        hint: netDelta?.text ?? `هامش ${cur.netMarginPct}%`,
      });
    }
    if (fp) {
      items.push({ label: "النقد", value: fmtAr(fp.cash), tone: "info" });
      items.push({ label: "الذمم المدينة", value: fmtAr(fp.arDebit), tone: "warning" });
      items.push({ label: "قيمة المخزون", value: fmtAr(fp.inventory), tone: "default" });
    }
    if (dm) {
      items.push({
        label: "تنبيهات المخزون",
        value: fmtAr(dm.lowStockCount),
        tone: dm.lowStockCount > 0 ? "warning" : "positive",
        hint: "أصناف تحت الحدّ الأدنى",
      });
      items.push({
        label: "الذمم المتأخّرة",
        value: fmtAr(dm.overdueAR.count),
        tone: dm.overdueAR.count > 0 ? "negative" : "positive",
        hint: dm.overdueAR.count > 0 ? `${fmtAr(dm.overdueAR.total)} د.ع (> ٣٠ يوم)` : "لا متأخّرات",
      });
    }
    return items;
  }, [cur, fp, dm, revDelta, netDelta]);

  // ───── أبرز المنتجات (للمخطّط + الجدول + التصدير/الطباعة) ─────
  const maxRev = topRows.reduce((m, r) => Math.max(m, D(r.revenue).toNumber()), 0);
  const periodLabel = `${period.from} — ${period.to}`;
  const branchLabel = branchId
    ? (branches.data?.find((b) => b.id === branchId)?.name ?? String(branchId))
    : "الكل";

  // صفوف المؤشّرات لإعادة استعمالها في التصدير والطباعة.
  const kpiRows = useMemo(
    () => kpis.map((k) => ({ label: k.label, value: String(k.value), hint: k.hint ?? "" })),
    [kpis],
  );

  function onExport() {
    exportRows(kpiRows, {
      filename: `لوحة-المؤشّرات-التنفيذية-${period.from}-${period.to}`,
      sheetName: "المؤشّرات",
      columns: [
        { key: "label", header: "المؤشّر" },
        { key: "value", header: "القيمة" },
        { key: "hint", header: "تفصيل" },
      ],
    });
  }

  function onPrint() {
    printReportDoc({
      title: "لوحة المؤشّرات التنفيذية",
      headerExtra: [
        { label: "الفترة", value: periodLabel },
        { label: "الفرع", value: branchLabel },
        ...(cmp ? [{ label: "مقارنة بـ", value: `${cmp.from} — ${cmp.to}` }] : []),
      ],
      note: NOTE,
      columns: [
        { key: "label", label: "المؤشّر" },
        { key: "value", label: "القيمة", align: "left" },
        { key: "hint", label: "تفصيل" },
      ],
      rows: kpiRows,
      showIndex: false,
      summary: cur
        ? [{ label: "صافي الربح", value: formatIqd(cur.netProfit), large: true, bold: true }]
        : undefined,
    });
    // أبرز المنتجات في مستند ثانٍ — لإبقاء جدول المؤشّرات نظيفاً.
    if (topRows.length) {
      printReportDoc({
        title: "أبرز المنتجات (بالإيراد)",
        headerExtra: [
          { label: "الفترة", value: periodLabel },
          { label: "الفرع", value: branchLabel },
        ],
        columns: [
          { key: "name", label: "المنتج" },
          { key: "qty", label: "الكمية", align: "left" },
          { key: "revenue", label: "الإيراد", align: "left" },
          { key: "profit", label: "الربح", align: "left" },
        ],
        rows: topRows.map((r) => ({
          name: r.productName,
          qty: fmtAr(r.qtySold),
          revenue: fmtAr(r.revenue),
          profit: fmtAr(r.profit),
        })),
      });
    }
  }

  const hasData = !!(cur || fp || dm);

  return (
    <ReportShell
      title="لوحة المؤشّرات التنفيذية"
      description="لقطة قيادية موحّدة: الأرباح والمركز المالي والتنبيهات وأبرز المنتجات في صفحة واحدة."
      backHref="/reports"
      note={NOTE}
      kpis={kpis}
      onExport={onExport}
      onPrint={onPrint}
      exportDisabled={!kpiRows.length}
      printDisabled={!hasData}
      filters={
        <div className="flex flex-wrap items-end gap-3">
          <PeriodFilter value={period} onChange={setPeriod} compare={compare} onCompareChange={setCompare} />
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">الفرع</label>
            <select
              className={selectCls}
              value={branchId}
              onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : "")}
            >
              <option value="">الكل</option>
              {branches.data?.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>
        </div>
      }
    >
      {/* أبرز المنتجات */}
      <Card>
        <CardContent className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-bold">أبرز المنتجات (الأعلى إيراداً)</h2>
            <span className="text-[11px] text-muted-foreground">{periodLabel}</span>
          </div>

          {top.isLoading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">جارٍ التحميل…</p>
          ) : !topRows.length ? (
            <p className="py-8 text-center text-sm text-muted-foreground">لا مبيعات في هذا النطاق.</p>
          ) : (
            <div className="space-y-3">
              {/* مخطّط شريطي أفقي خفيف (SVG داخلي — لا مكتبة) */}
              <div className="space-y-2">
                {topRows.map((r, i) => {
                  const rev = D(r.revenue).toNumber();
                  const widthPct = maxRev > 0 ? Math.max(2, (rev / maxRev) * 100) : 0;
                  return (
                    <div key={i} className="flex items-center gap-3">
                      <div className="w-40 shrink-0 truncate text-xs font-medium" title={r.productName}>
                        {i + 1}. {r.productName}
                      </div>
                      <div className="relative h-6 flex-1 overflow-hidden rounded-md bg-muted/50">
                        <div
                          className="absolute inset-y-0 right-0 rounded-md bg-sky-500/80"
                          style={{ width: `${widthPct}%` }}
                        />
                      </div>
                      <div className="w-32 shrink-0 text-left text-xs tabular-nums" dir="ltr">
                        {fmtAr(r.revenue)}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* جدول تفصيلي مختصر */}
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="p-2.5 text-right font-medium">المنتج</th>
                    <th className="p-2.5 text-left font-medium">الكمية</th>
                    <th className="p-2.5 text-left font-medium">الإيراد</th>
                    <th className="p-2.5 text-left font-medium">الربح</th>
                  </tr>
                </thead>
                <tbody>
                  {topRows.map((r, i) => (
                    <tr key={i} className="border-b last:border-0">
                      <td className="p-2.5 text-right">{r.productName}</td>
                      <td className="p-2.5 text-left tabular-nums" dir="ltr">{fmtAr(r.qtySold)}</td>
                      <td className="p-2.5 text-left tabular-nums" dir="ltr">{fmtAr(r.revenue)}</td>
                      <td className="p-2.5 text-left tabular-nums text-emerald-600" dir="ltr">{fmtAr(r.profit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {loading && !hasData && (
        <p className="p-8 text-center text-sm text-muted-foreground">جارٍ تحميل المؤشّرات…</p>
      )}
    </ReportShell>
  );
}
