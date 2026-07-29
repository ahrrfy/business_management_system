// داشبورد البطاقات الرقمية (ش١١). كل الأرقام مُجمَّعة خادمياً على فترة **نصف مفتوحة**،
// والحصة/الربح يظهران فقط لمن يملك رؤية التكلفة (الخادم يُصفّرهما لغيره — لا إخفاء بالعرض).
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, TableEmptyRow } from "@/components/PageState";
import { StatCard } from "@/components/StatCard";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { fmtAr } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import { AlertTriangle, CreditCard, TrendingUp, Wallet } from "lucide-react";
import { useMemo, useState } from "react";

const selectCls = "flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm";

/** يوم بصيغة YYYY-MM-DD بإزاحة أيام. */
function dayOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

const RANGES = [
  { key: "today", label: "اليوم", from: () => dayOffset(0), to: () => dayOffset(1) },
  { key: "week", label: "٧ أيام", from: () => dayOffset(-6), to: () => dayOffset(1) },
  { key: "month", label: "٣٠ يوماً", from: () => dayOffset(-29), to: () => dayOffset(1) },
] as const;

const MODE_LABEL: Record<string, string> = { PREPAID: "مسبق الدفع", POSTPAID: "آجل" };
const AVAIL_LABEL: Record<string, string> = { NO_PRICE: "بلا سعر منشور", STALE_PRICE: "سعر منتهٍ" };
const INTENT_LABEL: Record<string, string> = {
  PREPARED: "مُعدّة", EXECUTING: "قيد التنفيذ", EXECUTED: "نُفِّذت بلا فاتورة", NEEDS_REVIEW: "تحتاج مراجعة",
};

export default function DigitalDashboard() {
  const [range, setRange] = useState<(typeof RANGES)[number]["key"]>("today");
  const period = useMemo(() => {
    const r = RANGES.find((x) => x.key === range)!;
    return { from: r.from(), to: r.to() };
  }, [range]);

  const summary = trpc.digitalCards.dashboard.summary.useQuery(period);
  const balances = trpc.digitalCards.dashboard.providerBalances.useQuery();
  const dues = trpc.digitalCards.dashboard.postpaidDues.useQuery();
  const health = trpc.digitalCards.dashboard.priceHealth.useQuery();
  const pending = trpc.digitalCards.dashboard.pendingExecutions.useQuery();
  const top = trpc.digitalCards.dashboard.topOfferings.useQuery({ ...period, limit: 8 });
  const recon = trpc.digitalCards.dashboard.reconciliationStatus.useQuery(period);

  const s = summary.data;
  const showCost = s?.profit != null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="لوحة البطاقات الرقمية"
        description="أرقام الفترة مُجمَّعة على الخادم من لقطات البيع المثبَّتة. الفترة نصف مفتوحة — يوم العمل لا يبتلع اليوم التالي."
        actions={
          <select
            className={selectCls}
            value={range}
            onChange={(e) => setRange(e.target.value as typeof range)}
            aria-label="الفترة"
          >
            {RANGES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
          </select>
        }
      />

      {/* بطاقات الملخّص */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="كروت مُباعة" value={String(s?.cards ?? 0)} sub={`${s?.invoices ?? 0} فاتورة`} icon={CreditCard} />
        <StatCard label="إجمالي المبيعات" value={fmtAr(s?.sales ?? "0")} icon={TrendingUp} />
        {showCost && (
          <>
            <StatCard label="حصص المزوّدين" value={fmtAr(s!.providerShare!)} />
            <StatCard label="ربح المكتبة" value={fmtAr(s!.profit!)} tone="positive" />
          </>
        )}
        {!showCost && (
          <StatCard label="أرصدة لدى المزوّدين" value={fmtAr(balances.data?.totalAsset ?? "0")} icon={Wallet} />
        )}
      </div>

      {/* تنبيهات تشغيلية */}
      {((pending.data?.needsReview ?? 0) > 0 || (health.data?.needsAttention.length ?? 0) > 0) && (
        <Card>
          <CardHeader className="flex flex-row items-center gap-2 text-sm font-medium">
            <AlertTriangle aria-hidden className="size-4" /> يحتاج تدخّلاً
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2 pb-4 text-sm">
            {(pending.data?.needsReview ?? 0) > 0 && (
              <span className="rounded-md border px-3 py-1.5">
                {pending.data?.needsReview} عملية بكروت صادرة بلا فاتورة — طابور المراجعة
              </span>
            )}
            {(health.data?.needsAttention.length ?? 0) > 0 && (
              <span className="rounded-md border px-3 py-1.5">
                {health.data?.needsAttention.length} بطاقة بلا سعر نافذ — بيعٌ ضائع حتى تُسعَّر
              </span>
            )}
            {(recon.data?.open ?? 0) > 0 && (
              <span className="rounded-md border px-3 py-1.5">
                {recon.data?.open} مطابقة بفرقٍ مفتوح ({fmtAr(recon.data?.openVarianceTotal ?? "0")})
              </span>
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* أرصدة المحافظ */}
        <Card>
          <CardHeader className="text-sm font-medium">
            أرصدة المحافظ — الإجمالي {fmtAr(balances.data?.totalAsset ?? "0")}
          </CardHeader>
          <CardContent className="p-0">
            <ScrollTableShell bordered={false}>
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="p-2 text-start">المحفظة</th>
                    <th className="p-2 text-start">المزوّد</th>
                    <th className="p-2 text-start">المتاح</th>
                  </tr>
                </thead>
                <tbody>
                  {(balances.data?.wallets ?? []).map((w) => (
                    <tr key={w.walletId} className="border-t">
                      <td className="p-2">{w.walletName}</td>
                      <td className="p-2 text-muted-foreground">{w.providerName}</td>
                      <td className={`p-2 tabular-nums ${w.isLow ? "text-destructive font-medium" : ""}`}>
                        {fmtAr(w.available)}
                      </td>
                    </tr>
                  ))}
                  {balances.isLoading && <tr><td colSpan={3}><LoadingState /></td></tr>}
                  {!balances.isLoading && (balances.data?.wallets.length ?? 0) === 0 && (
                    <TableEmptyRow colSpan={3} message="لا محافظ مفعّلة." />
                  )}
                </tbody>
              </table>
            </ScrollTableShell>
          </CardContent>
        </Card>

        {/* ذمم المزوّدين الآجلين */}
        <Card>
          <CardHeader className="text-sm font-medium">
            مستحقّات المزوّدين الآجلين — الإجمالي {fmtAr(dues.data?.totalDue ?? "0")}
          </CardHeader>
          <CardContent className="p-0">
            <ScrollTableShell bordered={false}>
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="p-2 text-start">المزوّد</th>
                    <th className="p-2 text-start">المستحقّ</th>
                  </tr>
                </thead>
                <tbody>
                  {(dues.data?.providers ?? []).map((p) => (
                    <tr key={p.providerId} className="border-t">
                      <td className="p-2">{p.providerName}</td>
                      <td className="p-2 tabular-nums font-medium">{fmtAr(p.due)}</td>
                    </tr>
                  ))}
                  {dues.isLoading && <tr><td colSpan={2}><LoadingState /></td></tr>}
                  {!dues.isLoading && (dues.data?.providers.length ?? 0) === 0 && (
                    <TableEmptyRow colSpan={2} message="لا مزوّدين آجلين." />
                  )}
                </tbody>
              </table>
            </ScrollTableShell>
          </CardContent>
        </Card>
      </div>

      {/* الأكثر مبيعاً */}
      <Card>
        <CardHeader className="text-sm font-medium">الأكثر مبيعاً في الفترة</CardHeader>
        <CardContent className="p-0">
          <ScrollTableShell bordered={false}>
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2 text-start">البطاقة</th>
                  <th className="p-2 text-start">المزوّد</th>
                  <th className="p-2 text-start">العدد</th>
                  <th className="p-2 text-start">المبيعات</th>
                  {showCost && <th className="p-2 text-start">الربح</th>}
                </tr>
              </thead>
              <tbody>
                {(top.data ?? []).map((t) => (
                  <tr key={t.offeringId} className="border-t">
                    <td className="p-2 font-medium">{t.offeringName}</td>
                    <td className="p-2 text-muted-foreground">{t.providerName}</td>
                    <td className="p-2 tabular-nums">{t.cards}</td>
                    <td className="p-2 tabular-nums">{fmtAr(t.sales)}</td>
                    {showCost && <td className="p-2 tabular-nums">{fmtAr(t.profit ?? "0")}</td>}
                  </tr>
                ))}
                {top.isLoading && <tr><td colSpan={showCost ? 5 : 4}><LoadingState /></td></tr>}
                {!top.isLoading && (top.data?.length ?? 0) === 0 && (
                  <TableEmptyRow colSpan={showCost ? 5 : 4} message="لا مبيعات في هذه الفترة." />
                )}
              </tbody>
            </table>
          </ScrollTableShell>
        </CardContent>
      </Card>

      {/* الحالات المعلّقة */}
      <Card>
        <CardHeader className="text-sm font-medium">
          عمليات لم تُثبَّت ({pending.data?.total ?? 0})
        </CardHeader>
        <CardContent className="p-0">
          <ScrollTableShell bordered={false}>
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2 text-start">رقم</th>
                  <th className="p-2 text-start">الفرع</th>
                  <th className="p-2 text-start">الحالة</th>
                  <th className="p-2 text-start">المبلغ المتوقَّع</th>
                </tr>
              </thead>
              <tbody>
                {(pending.data?.items ?? []).map((p) => (
                  <tr key={p.id} className={`border-t ${p.status === "NEEDS_REVIEW" ? "bg-destructive/5" : ""}`}>
                    <td className="p-2 tabular-nums">{p.id}</td>
                    <td className="p-2 text-muted-foreground">{p.branchName}</td>
                    <td className="p-2">{INTENT_LABEL[p.status] ?? p.status}</td>
                    <td className="p-2 tabular-nums">{fmtAr(p.expectedTotal)}</td>
                  </tr>
                ))}
                {pending.isLoading && <tr><td colSpan={4}><LoadingState /></td></tr>}
                {!pending.isLoading && (pending.data?.items.length ?? 0) === 0 && (
                  <TableEmptyRow colSpan={4} message="لا عمليات معلّقة — كل البيوع مُثبَّتة." />
                )}
              </tbody>
            </table>
          </ScrollTableShell>
        </CardContent>
      </Card>

      {/* صحة الأسعار + تفصيل نمط التسوية */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="text-sm font-medium">
            صحة الأسعار — {health.data?.ready ?? 0} من {health.data?.total ?? 0} جاهزة
          </CardHeader>
          <CardContent className="p-0">
            <ScrollTableShell bordered={false}>
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="p-2 text-start">البطاقة</th>
                    <th className="p-2 text-start">الفرع</th>
                    <th className="p-2 text-start">الحالة</th>
                  </tr>
                </thead>
                <tbody>
                  {(health.data?.needsAttention ?? []).map((h) => (
                    <tr key={`${h.branchId}-${h.offeringId}`} className="border-t">
                      <td className="p-2">{h.offeringName}</td>
                      <td className="p-2 text-muted-foreground">{h.branchName}</td>
                      <td className="p-2">{AVAIL_LABEL[h.availability] ?? h.availability}</td>
                    </tr>
                  ))}
                  {health.isLoading && <tr><td colSpan={3}><LoadingState /></td></tr>}
                  {!health.isLoading && (health.data?.needsAttention.length ?? 0) === 0 && (
                    <TableEmptyRow colSpan={3} message="كل البطاقات مُسعَّرة." />
                  )}
                </tbody>
              </table>
            </ScrollTableShell>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="text-sm font-medium">حسب نمط التسوية</CardHeader>
          <CardContent className="p-0">
            <ScrollTableShell bordered={false}>
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="p-2 text-start">النمط</th>
                    <th className="p-2 text-start">كروت</th>
                    <th className="p-2 text-start">المبيعات</th>
                    {showCost && <th className="p-2 text-start">الربح</th>}
                  </tr>
                </thead>
                <tbody>
                  {(s?.byMode ?? []).map((m) => (
                    <tr key={m.settlementMode} className="border-t">
                      <td className="p-2">{MODE_LABEL[m.settlementMode] ?? m.settlementMode}</td>
                      <td className="p-2 tabular-nums">{m.cards}</td>
                      <td className="p-2 tabular-nums">{fmtAr(m.sales)}</td>
                      {showCost && <td className="p-2 tabular-nums">{fmtAr(m.profit ?? "0")}</td>}
                    </tr>
                  ))}
                  {summary.isLoading && <tr><td colSpan={showCost ? 4 : 3}><LoadingState /></td></tr>}
                  {!summary.isLoading && (s?.byMode.length ?? 0) === 0 && (
                    <TableEmptyRow colSpan={showCost ? 4 : 3} message="لا مبيعات في هذه الفترة." />
                  )}
                </tbody>
              </table>
            </ScrollTableShell>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
