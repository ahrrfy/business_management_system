import { AppSelect } from "@/components/ui/AppSelect";
import { D, fmt, moneyInput } from "@/lib/money";

/** Invoice credit terms and the courier's collection instruction are separate decisions. */
export function CreditCollectionChoice({
  creditAmount, otherGoodsAmount = "0", fee, feeCollection, value, onChange, disabled = false,
}: {
  creditAmount: string;
  otherGoodsAmount?: string;
  fee: string;
  feeCollection: string;
  value: boolean | undefined;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  if (!D(creditAmount).gt(0)) return null;
  const goods = D(otherGoodsAmount).plus(value === true ? creditAmount : 0);
  const courierFee = feeCollection === "COURIER" ? moneyInput(fee) : D(0);
  return (
    <div className="space-y-2 rounded-md border p-3 text-sm">
      <label className="block space-y-1">
        <span>الرصيد الآجل: {fmt(creditAmount)} د.ع — من يحصّله؟</span>
        <AppSelect
          aria-label="تحصيل الرصيد الآجل مع المندوب"
          value={value == null ? "" : value ? "collect" : "account"}
          onValueChange={(next) => { if (next) onChange(next === "collect"); }}
          disabled={disabled}
        >
          <option value="">اختر طريقة تحصيل الآجل صراحةً</option>
          <option value="collect">يُحصّل مع المندوب</option>
          <option value="account">يبقى على حساب العميل</option>
        </AppSelect>
      </label>
      {value != null && (
        <p data-testid="credit-collection-summary" className="text-xs leading-6 text-muted-foreground">
          تحصيل للمكتبة: <b data-testid="credit-goods-due" className="tabular-nums text-foreground">{fmt(goods.toFixed(2))} د.ع</b>
          {" + "}أجرة يقبضها المندوب: <b className="tabular-nums text-foreground">{fmt(courierFee.toFixed(2))} د.ع</b>
          {" = "}عند الاستلام: <b data-testid="credit-at-door" className="tabular-nums text-foreground">{fmt(goods.plus(courierFee).toFixed(2))} د.ع</b>.
          {value === false && <> الرصيد الآجل {fmt(creditAmount)} د.ع يبقى على العميل خارج تحصيل المندوب.</>}
        </p>
      )}
    </div>
  );
}
