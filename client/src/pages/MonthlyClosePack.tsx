// بند 11 (٧/٧): شاشة «الإقفال الشهري» — صورة الشهر المالية الموحّدة بنقرة (تبويب في محور
// الإقفال والرقابة): مبيعات/ربح إجمالي/مشتريات/مصاريف/خزينة/لقطة ذمم/أوامر مُسلَّمة + طباعة A4.
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { MonthPicker } from "@/components/form/MonthPicker";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadingState, ErrorState } from "@/components/PageState";
import { fmtAr } from "@/lib/money";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { Printer, TrendingUp, ShoppingCart, Wallet, ReceiptText, Scale, Wrench } from "lucide-react";

const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** الشهر الحالي YYYY-MM. */
function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

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

  function onPrint() {
    if (!d) return;
    const branchLabel = branchId
      ? branches.data?.find((b) => b.id === branchId)?.name ?? String(branchId)
      : "كل الفروع";
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
      rows: [
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
        { section: "ذمم العملاء الجارية (لقطة الآن)", value: fmtAr(d.receivablesSnapshot.arTotal) },
        { section: "ذمم الموردين الجارية (لقطة الآن)", value: fmtAr(d.receivablesSnapshot.apTotal) },
        { section: "أوامر شغل مُسلَّمة", value: String(d.workOrdersDelivered) },
      ],
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
          <Button onClick={onPrint} disabled={!d} className="gap-1.5">
            <Printer aria-hidden className="size-4" />
            طباعة / PDF
          </Button>
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
            <StatCard label="ذمم العملاء (لقطة الآن)" value={fmtAr(d.receivablesSnapshot.arTotal)} icon={ReceiptText} />
            <StatCard label="ذمم الموردين (لقطة الآن)" value={fmtAr(d.receivablesSnapshot.apTotal)} icon={ReceiptText} />
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

          <p className="text-[11px] text-muted-foreground">
            لقطة الذمم تعكس الأرصدة الجارية لحظة توليد التقرير لا نهاية الشهر التاريخية. أقسام الشهر
            (مبيعات/ربح/مشتريات/مصاريف/خزينة) محسوبة على نطاق {d.period.from} إلى {d.period.to}.
          </p>
        </>
      ) : null}
    </div>
  );
}
