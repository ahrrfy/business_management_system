// تبويب «تسديد مورد» — تسديد ذمّة مورد عبر الصيرفة (دولار أو دينار) مع معاينة فرق الصرف والعمولة.
// لا يمسّ الخزينة (النقد غادر عند الإيداع): يخفض محفظة الصيرفة ودين المورد فقط.
import { useMemo, useState } from "react";
import { HandCoins } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { MoneyInput } from "@/components/form/MoneyInput";
import { PageHeader } from "@/components/PageHeader";
import { trpc } from "@/lib/trpc";
import { moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";
import { notify } from "@/lib/notify";
import { D, fmtAr, formatIqd } from "@/lib/money";
import { BalanceTag, isMoneyStr, isRateStr, NetExposureTag, newClientRequestId, selectCls, type ExchangeRow } from "@/components/exchange/shared";

type Currency = "USD" | "IQD";

export default function ExchangeSettle() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const branches = trpc.branches.list.useQuery();
  const houses = trpc.exchange.list.useQuery({ activeOnly: true, limit: 200, offset: 0 });
  const suppliers = trpc.suppliers.list.useQuery();

  const [houseId, setHouseId] = useState(0);
  const [supplierId, setSupplierId] = useState(0);
  const [purchaseOrderId, setPurchaseOrderId] = useState(0);
  const [branchId, setBranchId] = useState(0);
  const [currency, setCurrency] = useState<Currency>("USD");
  const [walletAmount, setWalletAmount] = useState("");
  const [settledIqd, setSettledIqd] = useState("");
  const [settledUsd, setSettledUsd] = useState("");
  const [commission, setCommission] = useState("");
  const [rate, setRate] = useState("");
  const [warn, setWarn] = useState<string | null>(null);

  const houseRows = (houses.data ?? []) as ExchangeRow[];
  const house = houseRows.find((h) => h.id === houseId) ?? null;
  const supRows = (suppliers.data ?? []) as Array<{ id: number; name: string; currentBalance: string; currentBalanceUsd?: string }>;
  const supplier = supRows.find((s) => s.id === supplierId) ?? null;
  const purchases = trpc.purchases.list.useQuery(
    { supplierId: supplierId || undefined, limit: 200 },
    { enabled: supplierId > 0 },
  );
  const usdOrders = ((purchases.data ?? []) as Array<{
    id: number; poNumber: string; agreedCurrency?: string; usdTotal?: string | null;
    paidUsd?: string | null; returnedUsd?: string | null; agreedRate?: string | null; status: string;
  }>).filter((p) => p.agreedCurrency === "USD" && p.status !== "CANCELLED" &&
    D(p.usdTotal ?? 0).minus(D(p.paidUsd ?? 0)).minus(D(p.returnedUsd ?? 0)).gt(0));
  const selectedPo = usdOrders.find((p) => p.id === purchaseOrderId) ?? null;
  const isAdmin = me.data?.role === "admin";
  const effBranch = isAdmin ? branchId : (me.data?.branchId ?? branchId);
  // التسديد treasuryManagerProcedure(["manager","accountant"],"treasury","FULL") في الخادم —
  // منح treasury=READ يفتح الشاشة قراءةً لكن الخادم يرفض التنفيذ بـ403 ⇒ نعطّل زرّ التنفيذ
  // بنفس دالّة الخادم moduleAccessAllowed (لا قائمة أدوار حرفية) فلا تباعُد — نمط InvoiceDetail.
  const canWrite = !!me.data?.role &&
    moduleAccessAllowed(me.data.role as RoleKey, (me.data.permissionsOverride ?? null) as PermissionMap | null, "treasury", "FULL", ["manager", "accountant"]);

  // معاينة فرق الصرف = الدين المُسوّى − كلفة ما خرج من المحفظة.
  // فرق الصرف يَنشأ بالدولار فقط (بالدينار: المسحوب = المُسوّى ⇒ صفر دائماً).
  const fxPreview = useMemo(() => {
    if (!walletAmount || !selectedPo || !settledUsd) return null;
    try {
      const carryingIqd = D(settledUsd).times(D(selectedPo.agreedRate ?? 0));
      const walletCostIqd = currency === "USD"
        ? D(walletAmount).times(D(house?.usdCostRate ?? 0))
        : D(walletAmount);
      return carryingIqd.minus(walletCostIqd).toFixed(2);
    } catch { return null; }
  }, [walletAmount, settledUsd, currency, house, selectedPo]);

  const resetAmounts = () => {
    setWalletAmount("");
    setSettledIqd("");
    setSettledUsd("");
    setCommission("");
    setRate("");
    setWarn(null);
  };
  const reset = () => {
    resetAmounts();
    setPurchaseOrderId(0);
  };
  const settle = trpc.exchange.settle.useMutation({
    onSuccess: (r) => {
      const fx = D(r.fxDiff);
      const voucher = r.voucherNumber ? ` وإنشاء سند الصرف ${r.voucherNumber}` : "";
      notify.ok(fx.isZero() ? `تمّ التسديد${voucher}` : `تمّ التسديد${voucher} — ${fx.isPositive() ? "مكسب" : "خسارة"} صرف ${fmtAr(fx.abs().toFixed(2))} د.ع`);
      reset();
      void utils.exchange.list.invalidate();
      // دين المورد المعروض هنا من suppliers.list — بلا إبطالٍ يبقى «دين المورد الحالي» قديماً
      // على الشاشة بعد التسديد فيُغري بتسديدٍ مزدوج بالخطأ.
      void utils.suppliers.list.invalidate();
      void utils.reports.supplierStatement.invalidate();
      void utils.vouchers.list.invalidate();
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
    if (currency === "USD") {
      if (!purchaseOrderId || !selectedPo) { notify.err("اختر فاتورة شراء دولارية"); return; }
      if (!isMoneyStr(settledUsd)) { notify.err("أدخل مبلغ الدولار الواصل للمورد"); return; }
      const remainingUsd = D(selectedPo.usdTotal ?? 0).minus(D(selectedPo.paidUsd ?? 0)).minus(D(selectedPo.returnedUsd ?? 0));
      if (D(settledUsd).gt(remainingUsd)) { notify.err("مبلغ الدولار يتجاوز المتبقي على الفاتورة"); return; }
      if (!D(walletAmount).eq(D(settledUsd))) {
        notify.err("المسحوب من محفظة الدولار يجب أن يساوي الدولار الواصل للمورد"); return;
      }
    }
    const effSettledIqd = currency === "IQD"
      ? walletAmount
      : D(settledUsd).times(D(selectedPo?.agreedRate ?? 0)).toFixed(2);
    if (commission && !isMoneyStr(commission)) { notify.err("عمولة غير صالحة"); return; }
    if (currency === "USD" && rate && !isRateStr(rate)) { notify.err("سعر صرف غير صالح"); return; }
    settle.mutate({
      exchangeHouseId: houseId,
      branchId: effBranch,
      supplierId,
      purchaseOrderId: currency === "USD" ? purchaseOrderId : undefined,
      currency,
      walletAmount,
      settledIqd: effSettledIqd,
      settledUsd: currency === "USD" ? settledUsd : undefined,
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
        {!canWrite && (
          <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            صلاحيتك على الخزينة قراءة فقط — تنفيذ التسديد يتطلّب صلاحية كاملة على وحدة الخزينة.
          </div>
        )}
        <div className={`grid gap-4 ${currency === "USD" ? "sm:grid-cols-4" : "sm:grid-cols-3"}`}>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">الصيرفة</label>
            <select className={`${selectCls} w-full`} value={houseId} onChange={(e) => setHouseId(Number(e.target.value))}>
              <option value={0}>— اختر —</option>
              {houseRows.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">المورد</label>
            <select className={`${selectCls} w-full`} value={supplierId} onChange={(e) => {
              setSupplierId(Number(e.target.value));
              setPurchaseOrderId(0);
            }}>
              <option value={0}>— اختر —</option>
              {supRows.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          {currency === "USD" && (
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">فاتورة الشراء الدولارية</label>
              <select className={`${selectCls} w-full`} value={purchaseOrderId} onChange={(e) => setPurchaseOrderId(Number(e.target.value))}>
                <option value={0}>— اختر —</option>
                {usdOrders.map((p) => {
                  const rem = D(p.usdTotal ?? 0).minus(D(p.paidUsd ?? 0)).minus(D(p.returnedUsd ?? 0)).toFixed(2);
                  return <option key={p.id} value={p.id}>{p.poNumber} — متبقي {rem}$</option>;
                })}
              </select>
            </div>
          )}
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
            <span className="text-muted-foreground">متوسط كلفة الدولار: <span dir="ltr">{D(house.usdCostRate).isZero() ? "—" : fmtAr(house.usdCostRate)}</span></span>
            <span>صافي التعرّض: <NetExposureTag house={house} /></span></>}
            {supplier && <>
              <span>الدين الدفتري: <span dir="ltr" className="font-medium">{formatIqd(supplier.currentBalance)}</span></span>
              <span>الدين الدولاري: <span dir="ltr" className="font-medium">{fmtAr(supplier.currentBalanceUsd ?? "0")} $</span></span>
            </>}
          </div>
        )}

        <div className="flex gap-1 rounded-md border bg-background p-0.5 w-fit">
          {(["USD", "IQD"] as const).map((c) => (
            <button key={c} onClick={() => {
              if (c === currency) return;
              setCurrency(c);
              reset();
            }}
              className={currency === c ? "px-4 py-1.5 rounded-sm bg-primary text-primary-foreground text-sm" : "px-4 py-1.5 rounded-sm text-muted-foreground hover:text-foreground text-sm"}>
              {c === "USD" ? "بالدولار" : "بالدينار"}
            </button>
          ))}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {currency === "USD" && (
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">الدولار الواصل للمورد ($)</label>
              <MoneyInput value={settledUsd} onChange={(v) => {
                setSettledUsd(v);
                setWalletAmount(v);
                if (selectedPo?.agreedRate && v) {
                  try {
                    setSettledIqd(D(v).times(D(selectedPo.agreedRate)).toFixed(2));
                  } catch {
                    setSettledIqd("");
                  }
                }
              }} placeholder="0.00" />
            </div>
          )}
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">
              {currency === "USD" ? "المسحوب من محفظة الدولار ($)" : "المبلغ الواصل للمورد والمسحوب من محفظة الدينار (د.ع)"}
            </label>
            <MoneyInput value={walletAmount} onChange={setWalletAmount} placeholder="0.00" />
          </div>
          {currency === "USD" && selectedPo && (
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">القيمة الدفترية المُطفأة (د.ع)</label>
              <MoneyInput value={settledIqd} onChange={() => {}} placeholder="0.00" />
            </div>
          )}
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">العمولة ({currency === "USD" ? "$" : "د.ع"}) — اختياري</label>
            <MoneyInput value={commission} onChange={setCommission} placeholder="0.00" />
          </div>
          {currency === "USD" && (
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">سعر صرف التسديد (للتدقيق) — اختياري</label>
              <MoneyInput value={rate} onChange={setRate} decimals={4} placeholder="1450" />
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
          <Button onClick={() => doSettle(false)} disabled={settle.isPending || !canWrite} className="gap-1.5">
            <HandCoins className="h-4 w-4" />{settle.isPending ? "جارٍ…" : "تنفيذ التسديد"}
          </Button>
        </div>

        {warn && (
          <div className="rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-3">
            <div className="text-sm font-semibold text-[var(--sem-warn)] mb-1">تحذير: رصيد المحفظة قد يصبح سالباً</div>
            <div className="text-xs text-[var(--sem-warn)] mb-3">{warn}</div>
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
