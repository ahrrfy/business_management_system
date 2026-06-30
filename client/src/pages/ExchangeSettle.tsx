// تبويب «تسديد مورد» — تسديد ذمّة مورد عبر الصيرفة (دولار أو دينار) مع معاينة فرق الصرف والعمولة.
// لا يمسّ الخزينة (النقد غادر عند الإيداع): يخفض محفظة الصيرفة ودين المورد فقط.
import { useMemo, useState } from "react";
import { HandCoins } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/PageHeader";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { D, fmtAr, formatIqd } from "@/lib/money";
import { BalanceTag, isMoneyStr, isRateStr, newClientRequestId, selectCls, type ExchangeRow } from "@/components/exchange/shared";

type Currency = "USD" | "IQD";

export default function ExchangeSettle() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const branches = trpc.branches.list.useQuery();
  const houses = trpc.exchange.list.useQuery({ activeOnly: true, limit: 200, offset: 0 });
  const suppliers = trpc.suppliers.list.useQuery();

  const [houseId, setHouseId] = useState(0);
  const [supplierId, setSupplierId] = useState(0);
  const [branchId, setBranchId] = useState(0);
  const [currency, setCurrency] = useState<Currency>("USD");
  const [walletAmount, setWalletAmount] = useState("");
  const [settledIqd, setSettledIqd] = useState("");
  const [commission, setCommission] = useState("");
  const [rate, setRate] = useState("");
  const [warn, setWarn] = useState<string | null>(null);

  const houseRows = (houses.data ?? []) as ExchangeRow[];
  const house = houseRows.find((h) => h.id === houseId) ?? null;
  const supRows = (suppliers.data ?? []) as Array<{ id: number; name: string; currentBalance: string }>;
  const supplier = supRows.find((s) => s.id === supplierId) ?? null;
  const isAdmin = me.data?.role === "admin";
  const effBranch = isAdmin ? branchId : (me.data?.branchId ?? branchId);

  // معاينة فرق الصرف = الدين المُسوّى − كلفة ما خرج من المحفظة.
  // فرق الصرف يَنشأ بالدولار فقط (بالدينار: المسحوب = المُسوّى ⇒ صفر دائماً).
  const fxPreview = useMemo(() => {
    if (currency !== "USD" || !walletAmount || !settledIqd) return null;
    try {
      const walletCostIqd = D(walletAmount).times(D(house?.usdCostRate ?? 0));
      return D(settledIqd).minus(walletCostIqd).toFixed(2);
    } catch { return null; }
  }, [walletAmount, settledIqd, currency, house]);

  const reset = () => { setWalletAmount(""); setSettledIqd(""); setCommission(""); setRate(""); setWarn(null); };
  const settle = trpc.exchange.settle.useMutation({
    onSuccess: (r) => {
      const fx = D(r.fxDiff);
      notify.ok(fx.isZero() ? "تمّ التسديد" : `تمّ التسديد — ${fx.isPositive() ? "مكسب" : "خسارة"} صرف ${fmtAr(fx.abs().toFixed(2))} د.ع`);
      reset();
      void utils.exchange.list.invalidate();
    },
    onError: (e: any) => {
      if (e?.data?.code === "PRECONDITION_FAILED") { setWarn(e.message); return; }
      notify.err(e.message);
    },
  });

  const doSettle = (confirmNegative = false) => {
    if (!houseId) { notify.err("اختر صيرفة"); return; }
    if (!supplierId) { notify.err("اختر مورّداً"); return; }
    if (!effBranch) { notify.err("اختر الفرع"); return; }
    if (!isMoneyStr(walletAmount)) { notify.err("أدخل مبلغ السحب من المحفظة"); return; }
    // بالدينار: المسحوب من المحفظة = الدين المُسوّى (لا صرف عملة). بالدولار: حقلان مستقلّان.
    const effSettledIqd = currency === "IQD" ? walletAmount : settledIqd;
    if (!isMoneyStr(effSettledIqd)) { notify.err("أدخل الدين المُسوّى بالدينار"); return; }
    if (commission && !isMoneyStr(commission)) { notify.err("عمولة غير صالحة"); return; }
    if (currency === "USD" && rate && !isRateStr(rate)) { notify.err("سعر صرف غير صالح"); return; }
    settle.mutate({
      exchangeHouseId: houseId,
      branchId: effBranch,
      supplierId,
      currency,
      walletAmount,
      settledIqd: effSettledIqd,
      commission: commission || undefined,
      exchangeRate: currency === "USD" ? (rate || undefined) : undefined,
      confirmNegative,
      clientRequestId: newClientRequestId("exset"),
    });
  };

  return (
    <div className="space-y-4" dir="rtl">
      <PageHeader
        icon={<HandCoins className="h-5 w-5 text-primary" />}
        title="تسديد مورد عبر الصيرفة"
        description="يخفض رصيدنا لدى الصيرفة ودين المورد معاً — بلا مساس بخزينة الفرع. العمولة مصروف مستقل."
      />

      <Card className="p-4 space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">الصيرفة</label>
            <select className={`${selectCls} w-full`} value={houseId} onChange={(e) => setHouseId(Number(e.target.value))}>
              <option value={0}>— اختر —</option>
              {houseRows.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">المورد</label>
            <select className={`${selectCls} w-full`} value={supplierId} onChange={(e) => setSupplierId(Number(e.target.value))}>
              <option value={0}>— اختر —</option>
              {supRows.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">الفرع</label>
            <select className={`${selectCls} w-full`} value={effBranch} onChange={(e) => setBranchId(Number(e.target.value))} disabled={!isAdmin}>
              <option value={0}>— اختر —</option>
              {(branches.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
        </div>

        {(house || supplier) && (
          <div className="flex flex-wrap gap-4 rounded-md bg-muted/40 px-3 py-2 text-sm">
            {house && <><span>رصيد الدولار: <BalanceTag value={house.balanceUsd} unit="$" /></span>
            <span>رصيد الدينار: <BalanceTag value={house.balanceIqd} unit="د.ع" /></span>
            <span className="text-muted-foreground">متوسط كلفة الدولار: <span dir="ltr">{D(house.usdCostRate).isZero() ? "—" : fmtAr(house.usdCostRate)}</span></span></>}
            {supplier && <span>دين المورد الحالي: <span dir="ltr" className="font-medium">{formatIqd(supplier.currentBalance)}</span></span>}
          </div>
        )}

        <div className="flex gap-1 rounded-md border bg-background p-0.5 w-fit">
          {(["USD", "IQD"] as const).map((c) => (
            <button key={c} onClick={() => setCurrency(c)}
              className={currency === c ? "px-4 py-1.5 rounded-sm bg-primary text-primary-foreground text-sm" : "px-4 py-1.5 rounded-sm text-muted-foreground hover:text-foreground text-sm"}>
              {c === "USD" ? "بالدولار" : "بالدينار"}
            </button>
          ))}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">المسحوب من المحفظة ({currency === "USD" ? "$" : "د.ع"})</label>
            <Input value={walletAmount} onChange={(e) => setWalletAmount(e.target.value)} dir="ltr" inputMode="decimal" placeholder="0.00" className="tabular-nums" />
          </div>
          {currency === "USD" && (
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">الدين المُسوّى من المورد (د.ع)</label>
              <Input value={settledIqd} onChange={(e) => setSettledIqd(e.target.value)} dir="ltr" inputMode="decimal" placeholder="0.00" className="tabular-nums" />
            </div>
          )}
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">العمولة ({currency === "USD" ? "$" : "د.ع"}) — اختياري</label>
            <Input value={commission} onChange={(e) => setCommission(e.target.value)} dir="ltr" inputMode="decimal" placeholder="0.00" className="tabular-nums" />
          </div>
          {currency === "USD" && (
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">سعر صرف التسديد (للتدقيق) — اختياري</label>
              <Input value={rate} onChange={(e) => setRate(e.target.value)} dir="ltr" inputMode="decimal" placeholder="1450" className="tabular-nums" />
            </div>
          )}
        </div>

        {fxPreview !== null && (
          <div className="rounded-md bg-muted/40 px-3 py-2 text-sm">
            فرق الصرف المتوقَّع:{" "}
            <span dir="ltr" className={D(fxPreview).isNegative() ? "text-money-negative font-medium" : "text-money-positive font-medium"}>
              {fmtAr(D(fxPreview).abs().toFixed(2))} د.ع {D(fxPreview).isZero() ? "" : D(fxPreview).isPositive() ? "(مكسب)" : "(خسارة)"}
            </span>
            <span className="text-[11px] text-muted-foreground mr-2">= الدين المُسوّى − (المسحوب × متوسط الكلفة)</span>
          </div>
        )}

        <div>
          <Button onClick={() => doSettle(false)} disabled={settle.isPending} className="gap-1.5">
            <HandCoins className="h-4 w-4" />{settle.isPending ? "جارٍ…" : "تنفيذ التسديد"}
          </Button>
        </div>

        {warn && (
          <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-3">
            <div className="text-sm font-semibold text-amber-800 dark:text-amber-300 mb-1">تحذير: رصيد المحفظة قد يصبح سالباً</div>
            <div className="text-xs text-amber-700 dark:text-amber-400 mb-3">{warn}</div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setWarn(null)}>إلغاء</Button>
              <Button size="sm" onClick={() => { setWarn(null); doSettle(true); }} disabled={settle.isPending}>متابعة على أيّ حال</Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
