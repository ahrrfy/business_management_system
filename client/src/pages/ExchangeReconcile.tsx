// تبويب «مطابقة الأرصدة» — مقارنة رصيدنا الدفتري (حتى تاريخ قطع) برصيد كشف الصيرفة + البنود المعلّقة.
// قراءة فقط: أي فرق حقيقي يُسوّى لاحقاً بقيد تصحيح يدوي صريح (لا تسوية صامتة).
import { useState } from "react";
import { Scale as ScaleIcon, CheckCircle2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { D, fmtAr } from "@/lib/money";
import { isSignedMoneyStr, selectCls, type ExchangeRow } from "@/components/exchange/shared";

const TYPE_AR: Record<string, string> = {
  DEPOSIT: "إيداع", WITHDRAW: "سحب", FX_BUY: "شراء دولار", SETTLE: "تسديد مورد", OPENING: "رصيد افتتاحي",
};

type Params = { exchangeHouseId: number; statedBalanceIqd: string; statedBalanceUsd: string; asOfDate?: string };

export default function ExchangeReconcile() {
  const houses = trpc.exchange.list.useQuery({ limit: 200, offset: 0 });
  const [houseId, setHouseId] = useState(0);
  const [statedIqd, setStatedIqd] = useState("");
  const [statedUsd, setStatedUsd] = useState("");
  const [asOf, setAsOf] = useState("");
  const [params, setParams] = useState<Params | null>(null);

  const houseRows = (houses.data ?? []) as ExchangeRow[];
  const rec = trpc.exchange.reconcile.useQuery(params!, { enabled: !!params });

  const run = () => {
    if (!houseId) { notify.err("اختر صيرفة"); return; }
    if (!isSignedMoneyStr(statedIqd || "0") || !isSignedMoneyStr(statedUsd || "0")) { notify.err("أدخل أرصدة صحيحة (يُقبل السالب حين نَدين للصيرفة)"); return; }
    setParams({
      exchangeHouseId: houseId,
      statedBalanceIqd: statedIqd || "0",
      statedBalanceUsd: statedUsd || "0",
      asOfDate: asOf || undefined,
    });
  };

  const r = rec.data;

  return (
    <div className="space-y-4" dir="rtl">
      <PageHeader
        icon={<ScaleIcon className="h-5 w-5 text-primary" />}
        title="مطابقة أرصدة الصيرفة"
        description="قارن رصيدك الدفتري برصيد كشف الصيرفة لديهم، واكشف البنود المعلّقة (فروق التوقيت)."
      />

      <Card className="p-4 space-y-3">
        <div className="grid gap-4 sm:grid-cols-4">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">الصيرفة</label>
            <select className={`${selectCls} w-full`} value={houseId} onChange={(e) => setHouseId(Number(e.target.value))}>
              <option value={0}>— اختر —</option>
              {houseRows.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">رصيد كشفهم (دينار)</label>
            <Input value={statedIqd} onChange={(e) => setStatedIqd(e.target.value)} dir="ltr" inputMode="decimal" placeholder="0.00" className="tabular-nums" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">رصيد كشفهم (دولار)</label>
            <Input value={statedUsd} onChange={(e) => setStatedUsd(e.target.value)} dir="ltr" inputMode="decimal" placeholder="0.00" className="tabular-nums" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">حتى تاريخ (اختياري)</label>
            <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className="h-9" dir="ltr" />
          </div>
        </div>
        <Button onClick={run} disabled={rec.isFetching} className="gap-1.5">
          <ScaleIcon className="h-4 w-4" />{rec.isFetching ? "جارٍ…" : "تحقّق من المطابقة"}
        </Button>
      </Card>

      {r && (
        <>
          <Card className={`p-4 ${r.matched ? "border-money-positive/40" : "border-money-negative/40"}`}>
            <div className="text-sm font-semibold mb-3 flex items-center gap-1.5">
              {r.matched ? (
                <><CheckCircle2 className="h-4 w-4 text-money-positive" /> الأرصدة مطابقة</>
              ) : (
                <><AlertTriangle className="h-4 w-4 text-money-negative" /> يوجد فرق — راجِع البنود المعلّقة أدناه قبل أي تسوية</>
              )}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              <StatCard label="رصيدنا (دينار)" value={fmtAr(r.ourBalanceIqd)} />
              <StatCard label="رصيدهم (دينار)" value={fmtAr(r.statedBalanceIqd)} />
              <StatCard label="الفرق (دينار)" value={fmtAr(r.diffIqd)} tone={D(r.diffIqd).isZero() ? "default" : "negative"} />
              <StatCard label="رصيدنا (دولار)" value={fmtAr(r.ourBalanceUsd)} />
              <StatCard label="رصيدهم (دولار)" value={fmtAr(r.statedBalanceUsd)} />
              <StatCard label="الفرق (دولار)" value={fmtAr(r.diffUsd)} tone={D(r.diffUsd).isZero() ? "default" : "negative"} />
            </div>
          </Card>

          {r.pending.length > 0 && (
            <Card className="p-4">
              <div className="text-sm font-semibold mb-2">بنود معلّقة بعد تاريخ القطع ({r.pending.length}) — تفسّر فروق التوقيت</div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-right text-muted-foreground border-b">
                      <th className="py-2 font-medium">الرقم</th>
                      <th className="py-2 font-medium">النوع</th>
                      <th className="py-2 font-medium">دينار</th>
                      <th className="py-2 font-medium">دولار</th>
                      <th className="py-2 font-medium">التاريخ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(r.pending as Array<Record<string, string>>).map((p, i) => (
                      <tr key={i} className="border-b last:border-0">
                        <td className="py-2" dir="ltr">{p.txnNumber}</td>
                        <td className="py-2">{TYPE_AR[p.type] ?? p.type}</td>
                        <td className="py-2 tabular-nums" dir="ltr">{D(p.iqdAmount).isZero() ? "—" : fmtAr(p.iqdAmount)}</td>
                        <td className="py-2 tabular-nums" dir="ltr">{D(p.usdAmount).isZero() ? "—" : fmtAr(p.usdAmount)}</td>
                        <td className="py-2 text-xs text-muted-foreground" dir="ltr">{new Date(p.createdAt).toLocaleString("ar-IQ-u-nu-latn", { dateStyle: "short", timeStyle: "short" })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
