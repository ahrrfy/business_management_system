// بند 11 (٧/٧): شاشة «الإقفال الشهري» — صورة الشهر المالية الموحّدة بنقرة (تبويب في محور
// الإقفال والرقابة): مبيعات/ربح إجمالي/مشتريات/مصاريف/خزينة/لقطة ذمم/أوامر مُسلَّمة + طباعة A4.
import { useState } from "react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { MonthPicker } from "@/components/form/MonthPicker";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadingState, ErrorState } from "@/components/PageState";
import { fmtAr, D } from "@/lib/money";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { Printer, FileSpreadsheet, TrendingUp, ShoppingCart, Wallet, ReceiptText, Scale, Wrench, CircleAlert, CircleCheck, TriangleAlert } from "lucide-react";

const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** الشهر الحالي YYYY-MM. */
function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/** الشهر السابق لشهرٍ بصيغة YYYY-MM. */
function previousMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** نسبة تغيّر مئوية بدقّة decimal — null إن كان الأساس صفراً (لا معنى للنسبة). */
function deltaPct(curr: string, prev: string): string | null {
  const p = D(prev);
  if (p.isZero()) return null;
  return D(curr).sub(p).div(p).times(100).toDecimalPlaces(1).toString();
}

type ClosePack = RouterOutputs["reports"]["monthlyClosePack"];
/** ذمم مبنيّة من الدفتر حتى نهاية الشهر (reports.financialPosition.asOf) — بديل «لقطة الآن». */
type HistoricalAR = { ar: string; ap: string } | null;

/** صفوف حزمة الشهر المسطّحة — مصدر واحد يُشارَك بين الطباعة والتصدير.
 *  hist: إن توفّرت لقطة الذمم كما في نهاية الشهر (asOf) تحلّ محلّ لقطة الآن الافتراضية. */
function closePackRows(d: ClosePack, hist: HistoricalAR): { section: string; value: string }[] {
  return [
    { section: "عدد فواتير المبيعات", value: String(d.sales.invoiceCount) },
    { section: "المبيعات (صافٍ قبل الضريبة)", value: fmtAr(d.sales.subtotal) },
    { section: "الضريبة", value: fmtAr(d.sales.tax) },
    { section: "إجمالي المبيعات", value: fmtAr(d.sales.total) },
    { section: "المرتجعات", value: fmtAr(d.sales.returnedTotal) },
    { section: "صافي المبيعات بعد المرتجعات", value: fmtAr(d.sales.netAfterReturns) },
    { section: "تكلفة البضاعة المباعة", value: fmtAr(d.profit.cost) },
    { section: "الربح الإجمالي", value: fmtAr(d.profit.profit) },
    { section: "المشتريات (عدد الأوامر)", value: String(d.purchases.orderCount) },
    { section: "قيمة المشتريات", value: fmtAr(d.purchases.total) },
    { section: "المصروفات", value: fmtAr(d.expenses.total) },
    { section: "مقبوضات الخزينة", value: fmtAr(d.treasury.totalIn) },
    { section: "مدفوعات الخزينة", value: fmtAr(d.treasury.totalOut) },
    { section: "صافي حركة الخزينة", value: fmtAr(d.treasury.net) },
    {
      section: hist ? "ذمم العملاء (كما في نهاية الشهر)" : "ذمم العملاء الحالية (لقطة الآن)",
      value: fmtAr(hist ? hist.ar : d.receivablesSnapshot.arTotal),
    },
    {
      section: hist ? "ذمم الموردين (كما في نهاية الشهر)" : "ذمم الموردين الحالية (لقطة الآن)",
      value: fmtAr(hist ? hist.ap : d.receivablesSnapshot.apTotal),
    },
    { section: "أوامر شغل مُسلَّمة", value: String(d.workOrdersDelivered) },
  ];
}

/** بنود المقارنة بالشهر السابق — رباعية (مفتاح/تسمية/هذا الشهر/الشهر السابق). */
const COMPARE_METRICS: { key: string; label: string; pick: (d: ClosePack) => string }[] = [
  { key: "netSales", label: "صافي المبيعات", pick: (d) => d.sales.netAfterReturns },
  { key: "profit", label: "الربح الإجمالي", pick: (d) => d.profit.profit },
  { key: "purchases", label: "المشتريات", pick: (d) => d.purchases.total },
  { key: "expenses", label: "المصروفات", pick: (d) => d.expenses.total },
  { key: "treasuryNet", label: "صافي حركة الخزينة", pick: (d) => d.treasury.net },
];

export default function MonthlyClosePack() {
  const [month, setMonth] = useState<string>(currentMonth());
  const [branchId, setBranchId] = useState<number | "">("");

  const me = trpc.auth.me.useQuery();
  const isAdmin = me.data?.role === "admin";
  const branches = trpc.branches.list.useQuery(undefined, { enabled: isAdmin });

  const q = trpc.reports.monthlyClosePack.useQuery({
    month,
    branchId: branchId ? Number(branchId) : undefined,
  });
  const d = q.data;

  // ش٥: جاهزية الإقفال — استعلامٌ مستقلّ يظهر ولو كانت الحزمة ما زالت تُحمَّل (هو البوّابة لا الملخّص).
  const readiness = trpc.reports.monthCloseReadiness.useQuery({
    month,
    branchId: branchId ? Number(branchId) : undefined,
  });
  const rd = readiness.data;

  // لقطة الذمم كما في نهاية الشهر المختار — تستبدل «لقطة الآن» بالحسّاسة للتاريخ (reports.financialPosition
  // اكتسبت asOf لهذا الغرض بالضبط). لا تُطلَب إلا بعد توفّر period.to من الاستعلام الأول.
  const posAsOf = trpc.reports.financialPosition.useQuery(
    { branchId: branchId ? Number(branchId) : undefined, asOf: d?.period.to },
    { enabled: !!d?.period.to },
  );
  const hist: { ar: string; ap: string } | null = posAsOf.data
    ? { ar: posAsOf.data.arDebit, ap: posAsOf.data.apCredit }
    : null;

  // مقارنة بالشهر السابق: نداءٌ ثانٍ بنفس الفرع لشهرٍ أقدم بواحد — يُغذّي جدول المقارنة أدناه.
  const prevMonth = previousMonth(month);
  const qPrev = trpc.reports.monthlyClosePack.useQuery({
    month: prevMonth,
    branchId: branchId ? Number(branchId) : undefined,
  });
  const dPrev = qPrev.data;

  const branchLabel = branchId
    ? branches.data?.find((b) => b.id === branchId)?.name ?? String(branchId)
    : "كل الفروع";

  function onExport() {
    if (!d) return;
    exportRows(closePackRows(d, hist), {
      filename: `حزمة-الإقفال-الشهري-${month}`,
      title: `حزمة الإقفال الشهري — ${month}`,
      meta: [
        { label: "الفترة", value: `${d.period.from} — ${d.period.to}` },
        { label: "الفرع", value: branchLabel },
      ],
      columns: [
        { key: "section", header: "البند" },
        { key: "value", header: "القيمة" },
      ],
    });
  }

  function onPrint() {
    if (!d) return;
    printReportDoc({
      title: `حزمة الإقفال الشهري — ${month}`,
      headerExtra: [
        { label: "الفترة", value: `${d.period.from} — ${d.period.to}` },
        { label: "الفرع", value: branchLabel },
      ],
      columns: [
        { key: "section", label: "البند" },
        { key: "value", label: "القيمة", align: "left" },
      ],
      rows: closePackRows(d, hist),
      summary: [
        { label: "المصروفات", value: fmtAr(d.expenses.total) },
        { label: "صافي المبيعات", value: fmtAr(d.sales.netAfterReturns) },
        { label: "الربح الإجمالي", value: fmtAr(d.profit.profit), large: true, bold: true },
      ],
    });
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="الإقفال الشهري"
        description="صورة الشهر المالية الموحّدة: مبيعات وربح ومشتريات ومصاريف وخزينة وذمم — للمراجعة والطباعة."
        actions={
          <>
            <Button variant="outline" onClick={onExport} disabled={!d} className="gap-1.5">
              <FileSpreadsheet aria-hidden className="size-4" />
              تصدير Excel
            </Button>
            <Button onClick={onPrint} disabled={!d} className="gap-1.5">
              <Printer aria-hidden className="size-4" />
              طباعة / PDF
            </Button>
          </>
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground">الشهر</span>
          <MonthPicker value={month} onChange={setMonth} max={currentMonth()} ariaLabel="شهر الإقفال" />
        </div>
        {isAdmin && (
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">الفرع</label>
            <select className={selectCls} value={branchId} onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : "")}>
              <option value="">كل الفروع</option>
              {branches.data?.map((b) => (<option key={b.id} value={b.id}>{b.name}</option>))}
            </select>
          </div>
        )}
      </div>

      {rd && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              {rd.blocked ? (
                <CircleAlert aria-hidden className="size-4 text-destructive" />
              ) : (
                <CircleCheck aria-hidden className="size-4" />
              )}
              جاهزية الإقفال
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {rd.items.map((it) => (
              <div key={it.key} className="flex items-start gap-2">
                {it.status === "BLOCK" ? (
                  <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
                ) : it.status === "WARN" ? (
                  <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                )}
                <div>
                  <div className={it.status === "BLOCK" ? "font-medium text-destructive" : "font-medium"}>
                    {it.label}
                  </div>
                  <div className="text-xs text-muted-foreground">{it.detail}</div>
                </div>
              </div>
            ))}
            <p className="pt-1 text-xs text-muted-foreground">
              {rd.blocked
                ? "لا يُقفَل الشهر ما دام بندٌ حاجزٌ قائماً — عالجه ثم أعِد الفحص."
                : "لا مانع من الإقفال. بنود التنبيه لا تحجب."}
            </p>
          </CardContent>
        </Card>
      )}

      {q.isLoading ? (
        <LoadingState />
      ) : q.error ? (
        <ErrorState message={q.error.message} onRetry={() => q.refetch()} />
      ) : d ? (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
            <StatCard label="صافي المبيعات بعد المرتجعات" value={fmtAr(d.sales.netAfterReturns)} sub={`${d.sales.invoiceCount} فاتورة — مرتجعات ${fmtAr(d.sales.returnedTotal)}`} icon={ReceiptText} tone="info" />
            <StatCard label="الربح الإجمالي" value={fmtAr(d.profit.profit)} sub={`تكلفة ${fmtAr(d.profit.cost)}`} icon={TrendingUp} tone={Number(d.profit.profit) < 0 ? "negative" : "positive"} />
            <StatCard label="المشتريات" value={fmtAr(d.purchases.total)} sub={`${d.purchases.orderCount} أمراً — متبقٍّ ${fmtAr(d.purchases.unpaid)}`} icon={ShoppingCart} />
            <StatCard label="المصروفات" value={fmtAr(d.expenses.total)} icon={Wallet} tone="warning" />
            <StatCard label="صافي حركة الخزينة" value={fmtAr(d.treasury.net)} sub={`دخل ${fmtAr(d.treasury.totalIn)} — خرج ${fmtAr(d.treasury.totalOut)}`} icon={Scale} />
            <StatCard
              label={hist ? "ذمم العملاء (كما في نهاية الشهر)" : "ذمم العملاء (لقطة الآن)"}
              value={fmtAr(hist ? hist.ar : d.receivablesSnapshot.arTotal)}
              icon={ReceiptText}
            />
            <StatCard
              label={hist ? "ذمم الموردين (كما في نهاية الشهر)" : "ذمم الموردين (لقطة الآن)"}
              value={fmtAr(hist ? hist.ap : d.receivablesSnapshot.apTotal)}
              icon={ReceiptText}
            />
            <StatCard label="أوامر شغل مُسلَّمة" value={String(d.workOrdersDelivered)} icon={Wrench} />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">تفصيل المبيعات والضريبة</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
              <div><div className="text-xs text-muted-foreground">صافٍ قبل الضريبة</div><div className="tabular-nums" dir="ltr">{fmtAr(d.sales.subtotal)}</div></div>
              <div><div className="text-xs text-muted-foreground">الضريبة</div><div className="tabular-nums" dir="ltr">{fmtAr(d.sales.tax)}</div></div>
              <div><div className="text-xs text-muted-foreground">الإجمالي</div><div className="tabular-nums" dir="ltr">{fmtAr(d.sales.total)}</div></div>
              <div><div className="text-xs text-muted-foreground">المرتجعات</div><div className="tabular-nums text-money-negative" dir="ltr">{fmtAr(d.sales.returnedTotal)}</div></div>
            </CardContent>
          </Card>

          {d.expenses.topCategories.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">أعلى فئات المصروفات</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1.5 text-sm">
                {d.expenses.topCategories.map((c) => (
                  <div key={c.category} className="flex items-center justify-between">
                    <span>{c.category}</span>
                    <span className="tabular-nums" dir="ltr">{fmtAr(c.total)}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">مقارنة بالشهر السابق ({prevMonth})</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {qPrev.isLoading ? (
                <LoadingState />
              ) : !dPrev ? (
                <p className="p-4 text-center text-sm text-muted-foreground">تعذّر تحميل بيانات الشهر السابق للمقارنة.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-xs text-muted-foreground">
                      <th className="p-2.5 text-end font-medium">البند</th>
                      <th className="p-2.5 text-right font-medium">{month}</th>
                      <th className="p-2.5 text-right font-medium">{prevMonth}</th>
                      <th className="p-2.5 text-right font-medium">التغيّر %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {COMPARE_METRICS.map((m) => {
                      const curr = m.pick(d);
                      const prev = m.pick(dPrev);
                      const pct = deltaPct(curr, prev);
                      const up = pct != null && Number(pct) > 0;
                      const down = pct != null && Number(pct) < 0;
                      return (
                        <tr key={m.key} className="border-b last:border-0">
                          <td className="p-2.5 text-end">{m.label}</td>
                          <td className="p-2.5 text-right tabular-nums" dir="ltr">{fmtAr(curr)}</td>
                          <td className="p-2.5 text-right tabular-nums text-muted-foreground" dir="ltr">{fmtAr(prev)}</td>
                          <td className={`p-2.5 text-right tabular-nums font-medium ${up ? "text-money-positive" : down ? "text-money-negative" : ""}`} dir="ltr">
                            {pct == null ? "—" : `${up ? "+" : ""}${pct}%`}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>

          <p className="text-[11px] text-muted-foreground">
            {hist
              ? "ذمم العملاء/الموردين أعلاه مبنيّة من الدفتر حتى نهاية الشهر المختار (لا الآن)."
              : posAsOf.isLoading
                ? "جارٍ بناء لقطة الذمم كما في نهاية الشهر…"
                : "تعذّر بناء لقطة الذمم كما في نهاية الشهر — تُعرض الأرصدة الحالية لحظة توليد التقرير مؤقّتاً."}{" "}
            أقسام الشهر (مبيعات/ربح/مشتريات/مصاريف/خزينة) محسوبة على نطاق {d.period.from} إلى {d.period.to}.
          </p>
        </>
      ) : null}
    </div>
  );
}
