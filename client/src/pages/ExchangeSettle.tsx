import { useRef, useState } from "react";
import { HandCoins } from "lucide-react";
import { Link, useSearch } from "wouter";
import { AppSelect } from "@/components/ui/AppSelect";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FormError } from "@/components/form/FormError";
import { MoneyInput } from "@/components/form/MoneyInput";
import { PageHeader } from "@/components/PageHeader";
import { useOperationPermission } from "@/hooks/useOperationPermission";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { D, fmtAr, formatIqd } from "@/lib/money";
import {
  BalanceTag,
  isMoneyStr,
  isRateStr,
  newClientRequestId,
} from "@/components/exchange/shared";

type Currency = "USD" | "IQD";
const label = "mb-1 block text-sm font-medium";

export default function ExchangeSettle() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const operation = useOperationPermission("exchange.settle");
  const branches = trpc.branches.list.useQuery();
  const houses = trpc.exchange.list.useQuery({
    activeOnly: true,
    limit: 200,
    offset: 0,
  });
  const suppliers = trpc.suppliers.list.useQuery();
  const search = useSearch();

  const [houseId, setHouseId] = useState(0);
  const [supplierId, setSupplierId] = useState(() => {
    const id = Number(new URLSearchParams(search).get("supplierId"));
    return Number.isSafeInteger(id) && id > 0 ? id : 0;
  });
  const [branchId, setBranchId] = useState(0);
  const [currency, setCurrency] = useState<Currency>("IQD");
  const [amount, setAmount] = useState("");
  const [commission, setCommission] = useState("");
  const [rate, setRate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const request = useRef<{ fingerprint: string; id: string } | null>(null);

  // The server uses the account's assigned branch if there is one.
  const effBranch = me.data?.branchId ?? branchId;
  const house = (houses.data ?? []).find((row) => row.id === houseId);
  const supplier = (suppliers.data ?? []).find((row) => row.id === supplierId);
  const usd = currency === "USD";
  const unit = usd ? "$" : "د.ع";
  const total =
    isMoneyStr(amount) && (!commission || isMoneyStr(commission))
      ? D(amount)
          .plus(commission || "0")
          .toFixed(2)
      : null;
  const ready =
    operation.allowed && !!house && !!supplier && effBranch > 0 && !!amount;

  const clearMessages = () => {
    setError(null);
    setWarning(null);
  };
  const resetAmounts = () => {
    setAmount("");
    setCommission("");
    setRate("");
    clearMessages();
  };
  const settle = trpc.exchange.settle.useMutation({
    onSuccess: (result) => {
      const fx = D(result.fxDiff);
      const receipt = result.voucherNumber
        ? ` · سند الصرف ${result.voucherNumber}`
        : "";
      const difference = fx.isZero()
        ? ""
        : ` · ${fx.gt(0) ? "مكسب" : "خسارة"} صرف ${formatIqd(fx.abs().toFixed(2))}`;
      notify.ok(`تم سداد حساب المورد وتحديث المستحقات${receipt}${difference}`);
      request.current = null;
      resetAmounts();
      void Promise.all([
        utils.exchange.list.invalidate(),
        utils.exchange.statement.invalidate(),
        utils.suppliers.list.invalidate(),
        utils.suppliers.get.invalidate({ supplierId }),
        utils.reports.supplierStatement.invalidate(),
        utils.purchases.list.invalidate(),
        utils.purchases.get.invalidate(),
        utils.supplierPayments.paymentSources.invalidate(),
        utils.vouchers.list.invalidate(),
      ]);
    },
    onError: (err) => {
      if (
        err.data?.code === "PRECONDITION_FAILED" &&
        err.message.includes("سيصبح الفرق ديناً للصيرفة")
      ) {
        setWarning(err.message);
      } else {
        setWarning(null);
        setError(err.message);
      }
    },
  });

  const doSettle = (confirmNegative = false) => {
    if (!ready || !house || !supplier || settle.isPending) return;
    clearMessages();
    if (!isMoneyStr(amount) || !D(amount).gt(0)) {
      setError("أدخل مبلغ الدفعة أكبر من صفر.");
      return;
    }
    if (commission && !isMoneyStr(commission)) {
      setError("تحقّق من مبلغ العمولة.");
      return;
    }
    if (usd && rate && (!isRateStr(rate) || !D(rate).gt(0))) {
      setError("أدخل سعر صرف أكبر من صفر.");
      return;
    }
    const payload = {
      exchangeHouseId: house.id,
      branchId: effBranch,
      supplierId: supplier.id,
      allocationMode: "ACCOUNT" as const,
      currency,
      walletAmount: amount,
      commission: commission || undefined,
      exchangeRate: usd ? rate || undefined : undefined,
    };
    const fingerprint = JSON.stringify(payload);
    if (request.current?.fingerprint !== fingerprint)
      request.current = { fingerprint, id: newClientRequestId("exset") };
    settle.mutate({
      ...payload,
      clientRequestId: request.current.id,
      confirmNegative,
    });
  };

  return (
    <div className="space-y-4" dir="rtl">
      <PageHeader
        icon={<HandCoins className="size-5 text-primary" />}
        title="تسديد مورد عبر الصيرفة"
        description="أدخل دفعة واحدة. يوزّعها النظام على أقدم المستحقات ويحدّث رصيد حساب المورد."
      />
      <Card className="p-4">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!warning) doSettle();
          }}
        >
          {me.data && !operation.allowed && (
            <p className="text-sm text-muted-foreground">
              حسابك لا يملك صلاحية تسجيل سداد من محفظة الصيرفة.
            </p>
          )}
          <fieldset className="space-y-4" disabled={settle.isPending}>
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label className={label} htmlFor="exchange-settle-house">
                  الصيرفة
                </label>
                <AppSelect
                  id="exchange-settle-house"
                  value={String(houseId)}
                  disabled={settle.isPending}
                  onValueChange={(v) => {
                    setHouseId(Number(v));
                    resetAmounts();
                  }}
                >
                  <option value="0">اختر الصيرفة</option>
                  {(houses.data ?? []).map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name}
                    </option>
                  ))}
                </AppSelect>
              </div>
              <div>
                <label className={label} htmlFor="exchange-settle-supplier">
                  المورد
                </label>
                <AppSelect
                  id="exchange-settle-supplier"
                  value={String(supplierId)}
                  disabled={settle.isPending}
                  onValueChange={(v) => {
                    setSupplierId(Number(v));
                    resetAmounts();
                  }}
                >
                  <option value="0">اختر المورد</option>
                  {(suppliers.data ?? []).map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name}
                    </option>
                  ))}
                </AppSelect>
              </div>
              <div>
                <label className={label} htmlFor="exchange-settle-branch">
                  الفرع
                </label>
                <AppSelect
                  id="exchange-settle-branch"
                  value={String(effBranch)}
                  disabled={
                    !me.data || me.data.branchId != null || settle.isPending
                  }
                  onValueChange={(v) => {
                    setBranchId(Number(v));
                    resetAmounts();
                  }}
                >
                  <option value="0">اختر الفرع</option>
                  {(branches.data ?? []).map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name}
                    </option>
                  ))}
                </AppSelect>
              </div>
            </div>

            {supplier && (
              <div className="space-y-1 rounded-md bg-muted px-3 py-2 text-sm">
                <div className="flex flex-wrap gap-x-5 gap-y-1">
                  <span className="inline-flex items-baseline gap-1.5">
                    <span>ذمة المورد بالدينار:</span>
                    <strong dir="ltr">
                      {formatIqd(supplier.currentBalance)}
                    </strong>
                  </span>
                  {D(supplier.currentBalanceUsd ?? 0).gt(0) && (
                    <span className="inline-flex items-baseline gap-1.5">
                      <span>منها مستحقات بالدولار:</span>
                      <strong dir="ltr">
                        {fmtAr(supplier.currentBalanceUsd ?? "0")} $
                      </strong>
                    </span>
                  )}
                </div>
                <Link
                  className="inline-block text-primary underline"
                  href={`/suppliers?tab=statement&id=${supplier.id}`}
                >
                  كشف حساب المورد
                </Link>
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label className={label} htmlFor="exchange-settle-currency">
                  محفظة الدفع
                </label>
                <AppSelect
                  id="exchange-settle-currency"
                  value={currency}
                  disabled={settle.isPending}
                  onValueChange={(v) => {
                    setCurrency(v as Currency);
                    resetAmounts();
                  }}
                >
                  <option value="IQD">محفظة الدينار</option>
                  <option value="USD">محفظة الدولار</option>
                </AppSelect>
                {house && (
                  <p className="mt-1 text-sm text-muted-foreground">
                    رصيد المحفظة:{" "}
                    <BalanceTag
                      value={usd ? house.balanceUsd : house.balanceIqd}
                      unit={unit}
                    />
                  </p>
                )}
              </div>
              <div>
                <label className={label} htmlFor="exchange-settle-amount">
                  مبلغ الدفعة ({unit})
                </label>
                <MoneyInput
                  id="exchange-settle-amount"
                  value={amount}
                  onChange={(v) => {
                    setAmount(v);
                    clearMessages();
                  }}
                  placeholder="0.00"
                />
              </div>
              <div>
                <label className={label} htmlFor="exchange-settle-fee">
                  عمولة الصيرفة ({unit}) — اختياري
                </label>
                <MoneyInput
                  id="exchange-settle-fee"
                  value={commission}
                  onChange={(v) => {
                    setCommission(v);
                    clearMessages();
                  }}
                  placeholder="0.00"
                />
              </div>
            </div>
            <p className="text-sm text-muted-foreground">
              {usd
                ? "تُسدّد دفعة الدولار أقدم فواتير الدولار تلقائياً."
                : "تُسدّد دفعة الدينار أقدم المستحقات بالقيمة المثبتة في الدفتر."}
            </p>
            {usd && (
              <details className="text-sm">
                <summary className="cursor-pointer text-muted-foreground">
                  سعر صرف محفظة الدولار (اختياري)
                </summary>
                <MoneyInput
                  aria-label="سعر صرف محفظة الدولار"
                  className="mt-2 max-w-xs"
                  value={rate}
                  decimals={4}
                  onChange={(v) => {
                    setRate(v);
                    clearMessages();
                  }}
                  placeholder="د.ع لكل دولار"
                />
              </details>
            )}
            {total && (
              <p className="rounded-md bg-muted px-3 py-2 text-sm">
                إجمالي الخصم من المحفظة مع العمولة:{" "}
                <strong dir="ltr">
                  {fmtAr(total)} {unit}
                </strong>
              </p>
            )}
          </fieldset>

          <FormError message={error} />
          {warning ? (
            <div
              role="alert"
              className="space-y-2 rounded-md border bg-muted p-3 text-sm"
            >
              <p>{warning}</p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  onClick={() => doSettle(true)}
                  disabled={settle.isPending || !ready}
                >
                  تأكيد السداد بالدين
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setWarning(null)}
                >
                  رجوع إلى المبلغ
                </Button>
              </div>
            </div>
          ) : (
            <Button type="submit" disabled={settle.isPending || !ready}>
              <HandCoins className="size-4" /> تسجيل السداد
            </Button>
          )}
        </form>
      </Card>
    </div>
  );
}
