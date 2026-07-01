// تبويب «العمليات» — إيداع نقد / سحب / شراء دولار من الصيرفة.
// الإيداع والسحب نقلُ أصلٍ بين الخزينة والصيرفة؛ شراء الدولار يحوّل دينار→دولار ويحدّث متوسط الكلفة.
import { useMemo, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, DollarSign, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/form/MoneyInput";
import { PageHeader } from "@/components/PageHeader";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { D, fmtAr, formatIqd } from "@/lib/money";
import { BalanceTag, isMoneyStr, isRateStr, newClientRequestId, selectCls, type ExchangeRow } from "@/components/exchange/shared";

type Action = "deposit" | "withdraw" | "buyUsd";
type Currency = "IQD" | "USD";

export default function ExchangeOperations() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const branches = trpc.branches.list.useQuery();
  const houses = trpc.exchange.list.useQuery({ activeOnly: true, limit: 200, offset: 0 });

  const [houseId, setHouseId] = useState<number>(0);
  const [action, setAction] = useState<Action>("deposit");
  const [branchId, setBranchId] = useState<number>(0);
  // إيداع/سحب دولار مباشر (معزول تماماً عن الدينار) — مستقلّ عن شراء الدولار (تحويل داخلي).
  const [currency, setCurrency] = useState<Currency>("IQD");
  const [amount, setAmount] = useState("");
  const [depositRate, setDepositRate] = useState(""); // سعر مرجعي لإيداع الدولار (يُحدّث WAVG)
  const [usdAmount, setUsdAmount] = useState("");
  const [rate, setRate] = useState("");
  const [notes, setNotes] = useState("");
  const [warn, setWarn] = useState<string | null>(null);

  const rows = (houses.data ?? []) as ExchangeRow[];
  const house = rows.find((h) => h.id === houseId) ?? null;
  const isAdmin = me.data?.role === "admin";
  const effBranch = isAdmin ? branchId : (me.data?.branchId ?? branchId);

  const onErr = (e: any, retry: () => void) => {
    if (e?.data?.code === "PRECONDITION_FAILED") {
      setWarn(e.message);
      pendingRetry = retry;
      return;
    }
    notify.err(e.message);
  };
  const reset = () => { setAmount(""); setDepositRate(""); setUsdAmount(""); setRate(""); setNotes(""); setWarn(null); };
  const afterOk = (msg: string) => {
    notify.ok(msg);
    reset();
    void utils.exchange.list.invalidate();
  };

  const deposit = trpc.exchange.deposit.useMutation({ onSuccess: () => afterOk("تمّ الإيداع"), onError: (e) => notify.err(e.message) });
  const withdraw = trpc.exchange.withdraw.useMutation({ onSuccess: () => afterOk("تمّ السحب"), onError: (e) => onErr(e, () => doWithdraw(true)) });
  const buyUsd = trpc.exchange.buyUsd.useMutation({ onSuccess: (r) => afterOk(`تمّ شراء الدولار — متوسط الكلفة الجديد ${r.newRate}`), onError: (e) => onErr(e, () => doBuyUsd(true)) });

  const guard = (): boolean => {
    if (!houseId) { notify.err("اختر صيرفة"); return false; }
    if (!effBranch) { notify.err("اختر الفرع"); return false; }
    return true;
  };
  const doDeposit = () => {
    if (!guard()) return;
    if (!isMoneyStr(amount)) { notify.err("أدخل مبلغاً صحيحاً"); return; }
    if (currency === "USD" && !isRateStr(depositRate)) { notify.err("أدخل سعراً مرجعياً صحيحاً لإيداع الدولار"); return; }
    deposit.mutate({
      exchangeHouseId: houseId,
      branchId: effBranch,
      amount,
      currency,
      exchangeRate: currency === "USD" ? depositRate : undefined,
      notes: notes || undefined,
      clientRequestId: newClientRequestId("exdep"),
    });
  };
  const doWithdraw = (confirmNegative = false) => {
    if (!guard()) return;
    if (!isMoneyStr(amount)) { notify.err("أدخل مبلغاً صحيحاً"); return; }
    withdraw.mutate({ exchangeHouseId: houseId, branchId: effBranch, amount, currency, notes: notes || undefined, confirmNegative, clientRequestId: newClientRequestId("exwd") });
  };
  const doBuyUsd = (confirmNegative = false) => {
    if (!guard()) return;
    if (!isMoneyStr(usdAmount)) { notify.err("أدخل مبلغ دولار صحيحاً"); return; }
    if (!isRateStr(rate)) { notify.err("أدخل سعر صرف صحيحاً"); return; }
    buyUsd.mutate({ exchangeHouseId: houseId, branchId: effBranch, usdAmount, exchangeRate: rate, notes: notes || undefined, confirmNegative, clientRequestId: newClientRequestId("exfxb") });
  };

  const iqdSpent = useMemo(() => {
    if (!usdAmount || !rate) return null;
    try { return D(usdAmount).times(D(rate)).toFixed(2); } catch { return null; }
  }, [usdAmount, rate]);

  const pending = deposit.isPending || withdraw.isPending || buyUsd.isPending;

  return (
    <div className="space-y-4" dir="rtl">
      <PageHeader
        icon={<Wallet className="h-5 w-5 text-primary" />}
        title="عمليات الصيرفة"
        description="إيداع نقد لدى الصيرفة، أو سحبه، أو شراء دولار بتحديث متوسط الكلفة."
      />

      <Card className="p-4 space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">الصيرفة</label>
            <select className={`${selectCls} w-full`} value={houseId} onChange={(e) => setHouseId(Number(e.target.value))}>
              <option value={0}>— اختر —</option>
              {rows.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
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

        {house && (
          <div className="flex flex-wrap gap-4 rounded-md bg-muted/40 px-3 py-2 text-sm">
            <span>رصيد الدينار: <BalanceTag value={house.balanceIqd} unit="د.ع" /></span>
            <span>رصيد الدولار: <BalanceTag value={house.balanceUsd} unit="$" /></span>
            <span className="text-muted-foreground">متوسط كلفة الدولار: <span dir="ltr">{D(house.usdCostRate).isZero() ? "—" : fmtAr(house.usdCostRate)}</span></span>
          </div>
        )}

        {/* اختيار العملية */}
        <div className="flex flex-wrap gap-1 rounded-md border bg-background p-0.5 w-fit">
          {([
            ["deposit", "إيداع", ArrowDownToLine],
            ["withdraw", "سحب", ArrowUpFromLine],
            ["buyUsd", "شراء دولار", DollarSign],
          ] as const).map(([a, lbl, Icon]) => (
            <button
              key={a}
              onClick={() => { setAction(a); setCurrency("IQD"); reset(); }}
              className={action === a ? "px-3 py-1.5 rounded-sm bg-primary text-primary-foreground text-sm flex items-center gap-1.5" : "px-3 py-1.5 rounded-sm text-muted-foreground hover:text-foreground text-sm flex items-center gap-1.5"}
            >
              <Icon className="h-3.5 w-3.5" />{lbl}
            </button>
          ))}
        </div>

        {/* اختيار العملة — إيداع/سحب دولار مباشر معزول تماماً عن الدينار (رصيدان مستقلّان). */}
        {(action === "deposit" || action === "withdraw") && (
          <div className="flex gap-1 rounded-md border bg-background p-0.5 w-fit">
            {(["IQD", "USD"] as const).map((c) => (
              <button key={c} onClick={() => { setCurrency(c); setWarn(null); }}
                className={currency === c ? "px-4 py-1.5 rounded-sm bg-primary text-primary-foreground text-sm" : "px-4 py-1.5 rounded-sm text-muted-foreground hover:text-foreground text-sm"}>
                {c === "IQD" ? "بالدينار" : "بالدولار"}
              </button>
            ))}
          </div>
        )}

        {/* النماذج */}
        {action === "deposit" && (
          <div className="grid gap-4 sm:grid-cols-2 items-end">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">مبلغ الإيداع ({currency === "USD" ? "$" : "د.ع"})</label>
              <MoneyInput value={amount} onChange={setAmount} placeholder="0.00" />
            </div>
            {currency === "USD" ? (
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">سعر مرجعي (دينار/دولار)</label>
                <MoneyInput value={depositRate} onChange={setDepositRate} decimals={4} placeholder="1450" />
              </div>
            ) : (
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">ملاحظات</label>
                <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
              </div>
            )}
            {currency === "USD" && (
              <div className="sm:col-span-2">
                <label className="text-xs text-muted-foreground mb-1 block">ملاحظات</label>
                <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
              </div>
            )}
            <div className="sm:col-span-2">
              <Button onClick={doDeposit} disabled={pending} className="gap-1.5">
                <ArrowDownToLine className="h-4 w-4" />{pending ? "جارٍ…" : "تنفيذ الإيداع"}
              </Button>
              <p className="text-[11px] text-muted-foreground mt-1.5">
                {currency === "USD"
                  ? "دولار مباشر لمحفظة الصيرفة الدولارية (لا يمسّ رصيدنا الديناري إطلاقاً). السعر المرجعي يُحدّث متوسط كلفة المحفظة (WAVG)."
                  : "يخرج النقد من خزينة الفرع ويصبح رصيداً لنا لدى الصيرفة (نقل أصل)."}
              </p>
            </div>
          </div>
        )}

        {action === "withdraw" && (
          <div className="grid gap-4 sm:grid-cols-2 items-end">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">مبلغ السحب ({currency === "USD" ? "$" : "د.ع"})</label>
              <MoneyInput value={amount} onChange={setAmount} placeholder="0.00" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">ملاحظات</label>
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
            <div className="sm:col-span-2">
              <Button onClick={() => doWithdraw(false)} disabled={pending} className="gap-1.5">
                <ArrowUpFromLine className="h-4 w-4" />{pending ? "جارٍ…" : "تنفيذ السحب"}
              </Button>
              <p className="text-[11px] text-muted-foreground mt-1.5">
                {currency === "USD"
                  ? "دولار مباشر من محفظة الصيرفة الدولارية (لا يمسّ رصيدنا الديناري إطلاقاً)."
                  : "يعود النقد من رصيدنا لدى الصيرفة إلى خزينة الفرع."}
              </p>
            </div>
          </div>
        )}

        {action === "buyUsd" && (
          <div className="grid gap-4 sm:grid-cols-3 items-end">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">مبلغ الدولار ($)</label>
              <MoneyInput value={usdAmount} onChange={setUsdAmount} placeholder="0.00" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">سعر الصرف (دينار/دولار)</label>
              <MoneyInput value={rate} onChange={setRate} decimals={4} placeholder="1450" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">الكلفة بالدينار</label>
              <div className="h-9 flex items-center px-3 rounded-md bg-muted/50 tabular-nums text-sm" dir="ltr">
                {iqdSpent ? formatIqd(iqdSpent) : "—"}
              </div>
            </div>
            <div className="sm:col-span-3">
              <Button onClick={() => doBuyUsd(false)} disabled={pending} className="gap-1.5">
                <DollarSign className="h-4 w-4" />{pending ? "جارٍ…" : "تنفيذ الشراء"}
              </Button>
              <p className="text-[11px] text-muted-foreground mt-1.5">يحوّل دينارَك لدى الصيرفة إلى دولار ويحدّث متوسط الكلفة المرجّح (WAVG).</p>
            </div>
          </div>
        )}

        {warn && (
          <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-3">
            <div className="text-sm font-semibold text-amber-800 dark:text-amber-300 mb-1">تحذير: الرصيد قد يصبح سالباً</div>
            <div className="text-xs text-amber-700 dark:text-amber-400 mb-3">{warn}</div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setWarn(null)}>إلغاء</Button>
              <Button size="sm" onClick={() => { setWarn(null); pendingRetry?.(); }} disabled={pending}>متابعة على أيّ حال</Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

// مرجع دالّة إعادة المحاولة بعد تأكيد التجاوز (خارج الحالة لتفادي إعادة الإنشاء).
let pendingRetry: (() => void) | null = null;
