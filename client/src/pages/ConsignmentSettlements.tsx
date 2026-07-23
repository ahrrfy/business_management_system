import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
    </div>
  );
}
