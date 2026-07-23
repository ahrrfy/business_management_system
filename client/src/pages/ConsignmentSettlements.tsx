import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/PageHeader";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { TableEmptyRow } from "@/components/PageState";
import { confirm } from "@/lib/confirm";
import { fmtAr as fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { Link } from "wouter";

/** التاريخ المحلّيّ اليوم/أوّل الشهر بصيغة YYYY-MM-DD (افتراضات منتقي الفترة — يغيّرها المستخدم). */
function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * تسويات الأمانة (ش٥) — لكل مودِع: المستحق + بضاعته المتبقية، وزرّ «تسوية» يُنشئ سند صرف **معلَّقاً**
 * (اعتماد ثنائيّ عبر طابور السندات القائم). راجع design §٩.
 */
export default function ConsignmentSettlements() {
  const me = trpc.auth.me.useQuery();
  const branchId = me.data?.branchId ?? 1;
  const balances = trpc.consignments.balancesReport.useQuery(undefined);
  const utils = trpc.useUtils();

  const now = new Date();
  const [startDate, setStartDate] = useState(ymd(new Date(now.getFullYear(), now.getMonth(), 1)));
  const [endDate, setEndDate] = useState(ymd(now));
  const margins = trpc.consignments.marginsReport.useQuery({ startDate, endDate });
  const marginRows = margins.data?.rows ?? [];
  const marginTotals = margins.data?.totals;

  // كشف تسوية مودِع (معاينة، نفس فترة تقرير الهوامش) — يُفتح بحوار عند اختيار مودِع.
  const [stmtConsignor, setStmtConsignor] = useState<number | null>(null);
  const statement = trpc.consignments.settlementStatement.useQuery(
    { consignorId: stmtConsignor ?? 0, startDate, endDate },
    { enabled: stmtConsignor != null },
  );

  const settle = trpc.consignments.createSettlement.useMutation({
    onSuccess: () => {
      notify.ok("أُنشئت التسوية", "بانتظار اعتماد سند الصرف من مدير آخر (طابور السندات).");
      utils.consignments.balancesReport.invalidate();
    },
    onError: (e) => notify.err(e),
  });

  async function doSettle(consignorId: number, name: string, owed: string) {
    if (Number(owed) <= 0) return;
    const ok = await confirm({
      title: "تسوية مودِع",
      description: `إنشاء سند صرف بمبلغ ${fmt(owed)} د.ع للمودِع «${name}». يُنشأ معلَّقاً ويعتمده مدير آخر. متابعة؟`,
      confirmText: "إنشاء التسوية",
    });
    if (!ok) return;
    settle.mutate({ consignorId, amount: String(owed), paymentMethod: "CASH", branchId });
  }

  const rows = balances.data ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        title="تسويات الأمانة"
        description="المستحقّ لكل مودِع عن مبيعات بضاعته — تُسوّى بسند صرف يعتمده مدير آخر (فصل المهام)."
      />
      <Card>
        <CardHeader><CardTitle className="text-base">أرصدة المودِعين</CardTitle></CardHeader>
        <CardContent className="p-0">
          <ScrollTableShell bordered={false}>
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2">المودِع</th><th className="p-2 text-start">المستحق له</th>
                  <th className="p-2 text-center">بضاعة متبقية</th><th className="p-2 text-start">قيمتها (بالحصة)</th>
                  <th className="p-2 text-center">إجراء</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const owed = Number(r.owed);
                  return (
                    <tr key={r.consignorId} className="border-t">
                      <td className="p-2 font-medium">
                        <Link href={`/suppliers/${r.consignorId}/edit`} className="hover:underline">{r.consignorName}</Link>
                      </td>
                      <td className="p-2 text-start tabular-nums" dir="ltr">{fmt(r.owed)}</td>
                      <td className="p-2 text-center">{r.remainingQty} <span className="text-xs text-muted-foreground">({r.variantCount} صنف)</span></td>
                      <td className="p-2 text-start tabular-nums text-muted-foreground" dir="ltr">{fmt(r.remainingValueByShare)}</td>
                      <td className="p-2 text-center">
                        <div className="flex items-center justify-center gap-2">
                          <Button size="sm" variant="outline" disabled={owed <= 0 || settle.isPending} onClick={() => doSettle(r.consignorId, r.consignorName, r.owed)}>
                            {owed > 0 ? "تسوية" : "لا مستحق"}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setStmtConsignor(r.consignorId)}>كشف تسوية</Button>
                          <Link href={`/suppliers-statement?id=${r.consignorId}`} className="text-xs text-primary underline">كشف حساب</Link>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {!balances.isLoading && rows.length === 0 && (
                  <TableEmptyRow colSpan={5} message="لا مودِعين بعد." />
                )}
              </tbody>
            </table>
          </ScrollTableShell>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">هوامش الأمانة</CardTitle>
          <p className="text-xs text-muted-foreground">ربح المكتبة المُحقَّق من بيع بضاعة كل مودِع خلال الفترة (صافي المرتجعات) = المُباع − حصّة المودِع.</p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm">
              <span className="block text-xs text-muted-foreground mb-1">من</span>
              <Input type="date" value={startDate} max={endDate} onChange={(e) => setStartDate(e.target.value)} className="w-40" />
            </label>
            <label className="text-sm">
              <span className="block text-xs text-muted-foreground mb-1">إلى</span>
              <Input type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} className="w-40" />
            </label>
          </div>
          <ScrollTableShell bordered={false}>
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2">المودِع</th>
                  <th className="p-2 text-center">كمية مباعة</th>
                  <th className="p-2 text-start">المُباع (صافي)</th>
                  <th className="p-2 text-start">حصّة المودِع</th>
                  <th className="p-2 text-start">هامش المكتبة</th>
                  <th className="p-2 text-center">النسبة</th>
                </tr>
              </thead>
              <tbody>
                {marginRows.map((r) => (
                  <tr key={r.consignorId} className="border-t">
                    <td className="p-2 font-medium">
                      <Link href={`/suppliers/${r.consignorId}/edit`} className="hover:underline">{r.consignorName}</Link>
                    </td>
                    <td className="p-2 text-center tabular-nums">{r.soldQty}</td>
                    <td className="p-2 text-start tabular-nums" dir="ltr">{fmt(r.soldValue)}</td>
                    <td className="p-2 text-start tabular-nums text-muted-foreground" dir="ltr">{fmt(r.consignorShare)}</td>
                    <td className="p-2 text-start tabular-nums font-semibold text-emerald-600 dark:text-emerald-400" dir="ltr">{fmt(r.libraryMargin)}</td>
                    <td className="p-2 text-center tabular-nums text-muted-foreground" dir="ltr">{r.marginPct}٪</td>
                  </tr>
                ))}
                {!margins.isLoading && marginRows.length === 0 && (
                  <TableEmptyRow colSpan={6} message="لا مبيعات أمانة في هذه الفترة." />
                )}
                {marginTotals && marginRows.length > 0 && (
                  <tr className="border-t-2 bg-muted/30 font-semibold">
                    <td className="p-2">الإجمالي</td>
                    <td className="p-2"></td>
                    <td className="p-2 text-start tabular-nums" dir="ltr">{fmt(marginTotals.soldValue)}</td>
                    <td className="p-2 text-start tabular-nums" dir="ltr">{fmt(marginTotals.consignorShare)}</td>
                    <td className="p-2 text-start tabular-nums text-emerald-600 dark:text-emerald-400" dir="ltr">{fmt(marginTotals.libraryMargin)}</td>
                    <td className="p-2 text-center tabular-nums" dir="ltr">{marginTotals.marginPct}٪</td>
                  </tr>
                )}
              </tbody>
            </table>
          </ScrollTableShell>
        </CardContent>
      </Card>

      <Dialog open={stmtConsignor != null} onOpenChange={(o) => !o && setStmtConsignor(null)}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>كشف تسوية مودِع{statement.data ? ` — ${statement.data.consignorName}` : ""}</DialogTitle>
          </DialogHeader>
          {statement.isLoading && <p className="text-sm text-muted-foreground py-6 text-center">جارٍ التحميل…</p>}
          {statement.data && (
            <div className="space-y-4">
              <p className="text-xs text-muted-foreground">الفترة من {statement.data.period.startDate} إلى {statement.data.period.endDate}. مستندٌ استرشاديٌّ للمعاينة يرافق سند التسوية.</p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <Kpi label="المستحقّ الحاليّ" value={fmt(statement.data.currentOwed)} strong />
                <Kpi label="مبيعات الفترة" value={fmt(statement.data.period.soldValue)} />
                <Kpi label="حصّة المودِع" value={fmt(statement.data.period.share)} />
                <Kpi label={`هامش المكتبة (${statement.data.period.marginPct}٪)`} value={fmt(statement.data.period.margin)} />
              </div>
              <div>
                <div className="text-sm font-medium mb-1">تفصيل المبيعات (صافي المرتجعات)</div>
                <ScrollTableShell bordered>
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50">
                      <tr>
                        <th className="p-2">الصنف</th><th className="p-2 text-center">كمية</th>
                        <th className="p-2 text-start">مُباع</th><th className="p-2 text-start">حصّة</th><th className="p-2 text-start">هامش</th>
                      </tr>
                    </thead>
                    <tbody>
                      {statement.data.lines.map((l) => (
                        <tr key={l.variantId} className="border-t">
                          <td className="p-2">{l.productName} <span className="text-xs text-muted-foreground">{l.sku}</span></td>
                          <td className="p-2 text-center tabular-nums">{l.soldQty}</td>
                          <td className="p-2 text-start tabular-nums" dir="ltr">{fmt(l.soldValue)}</td>
                          <td className="p-2 text-start tabular-nums text-muted-foreground" dir="ltr">{fmt(l.share)}</td>
                          <td className="p-2 text-start tabular-nums text-emerald-600 dark:text-emerald-400" dir="ltr">{fmt(l.margin)}</td>
                        </tr>
                      ))}
                      {statement.data.lines.length === 0 && <TableEmptyRow colSpan={5} message="لا مبيعات في هذه الفترة." />}
                    </tbody>
                  </table>
                </ScrollTableShell>
              </div>
              <div className="flex items-center gap-6 text-sm border-t pt-3">
                <span>البضاعة المتبقية لدى المكتبة: <b className="tabular-nums">{statement.data.remaining.qty}</b> قطعة</span>
                <span className="text-muted-foreground">قيمتها بالحصّة: <span className="tabular-nums" dir="ltr">{fmt(statement.data.remaining.valueByShare)}</span></span>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Kpi({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="rounded-md border p-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`tabular-nums ${strong ? "text-base font-semibold" : "text-sm"}`} dir="ltr">{value}</div>
    </div>
  );
}
