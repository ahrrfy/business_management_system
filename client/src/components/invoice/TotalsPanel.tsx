/**
 * TotalsPanel — financial summary + payment block.
 * Ported from `_design-bundle/project/invoice-footer.jsx#TotalsPanel`.
 */
import { useEffect, type Dispatch } from "react";
import { Calculator, CreditCard, Gift, Lock, Package, Percent, Truck } from "lucide-react";
import { MoneyInput } from "@/components/form/MoneyInput";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { calcTotals, fmtNum } from "./totals";
import { PAYMENT_METHODS, type InvoiceAction, type InvoiceLine, type InvoiceState, type PaymentMethod } from "./types";
import { POS_EXTERNAL_PAYMENT_DISABLED_MESSAGE, isPosPaymentMethodEnabled } from "@shared/posPaymentPolicy";

export interface TotalsPanelProps {
  items: InvoiceLine[];
  state: InvoiceState;
  dispatch: Dispatch<InvoiceAction>;
  /** false = hide the shipping input (backend doesn't persist it). Default true to preserve existing screens. */
  showShipping?: boolean;
  /** false = hide the other-expenses input (backend doesn't persist it). Default true. */
  showOtherExpenses?: boolean;
  /** true = show the invoice-level tax toggle + rate field (e.g. SALE for customers needing a tax invoice). Default false to preserve existing screens. */
  showTaxToggle?: boolean;
  /** false = hide the global-discount editor (backend doesn't persist it — e.g. purchase/return). Default true. */
  showDiscount?: boolean;
  /** false = hide the payment block (method + paid amount) — screens that persist payment elsewhere (purchase receive) or via a dedicated control (return settlement). Default true. */
  showPayment?: boolean;
  /**
   * مبلغ الخصم المعروض (2dp) — يُمرَّر حين يشتقّه الأب بترتيب تقريبٍ مختلف عن `calcTotals`.
   * الشراء يشتقّه بترتيب الخادم (سطراً سطراً) فقد يفترق عن اشتقاق `calcTotals` بفلسٍ على
   * أسعار الدولار ذات الأربع منازل ⇒ يُعرض ما **يُرسَل فعلاً** لا رقماً موازياً («المعروض = المحفوظ»).
   */
  overrideDiscountAmount?: string;
  /** override the displayed/driving grand total (2dp string). SALE_RETURN passes the server-equivalent
   *  proportional refund so the panel's total, paid-placeholder and «الكل» button reflect what the server
   *  actually refunds — not the editor-derived value (which ignores the invoice-level discount/tax). */
  overrideGrandTotal?: string;
  /** تسمية سطر الشحن. فاتورة البيع تسمّيه «أجرة التوصيل» (إيراد يُقبض من الزبون)، بخلاف الشراء
   *  حيث «مصاريف شحن» (تكلفة نتحمّلها) — نفس الحقل بدلالتين متعاكستين. */
  shippingLabel?: string;
  /** true = إظهار مفتاح «مجاني» بجانب أجرة التوصيل (فاتورة البيع). Default false للشاشات الأخرى. */
  allowFreeShipping?: boolean;
  /** SALES/POS money-in is CASH-only until a trusted provider + reconciliation lifecycle is enabled. */
  cashOnlyPayment?: boolean;
}

export function TotalsPanel({
  items,
  state,
  dispatch,
  showShipping = true,
  showOtherExpenses = true,
  showTaxToggle = false,
  showDiscount = true,
  showPayment = true,
  overrideGrandTotal,
  overrideDiscountAmount,
  shippingLabel = "مصاريف شحن",
  allowFreeShipping = false,
  cashOnlyPayment = false,
}: TotalsPanelProps) {
  const t = calcTotals(items, state);
  // (0152) «مجاني» صار حالةً صريحة لا استنتاجاً من الصفر — فالصفر كان يخلط «أُهديت الأجرة»
  // بـ«لا توصيل أصلاً». والمبلغ المُدخَل يبقى ظاهراً ليُطبَع «مجاناً — قيمته X».
  const isFreeShipping = state.shippingFree === true;
  const currSym = state.currency === "USD" ? "$" : "د.ع";
  const effectiveGrandTotal = overrideGrandTotal ?? t.grandTotal;
  const grandTotalNum = Number(effectiveGrandTotal);
  const paidNum = Number(state.paidAmount || "0");
  const remainingNum = grandTotalNum - paidNum;

  useEffect(() => {
    if (cashOnlyPayment && !isPosPaymentMethodEnabled(state.paymentMethod)) {
      dispatch({ type: "SET_FIELD", field: "paymentMethod", value: "CASH" });
    }
  }, [cashOnlyPayment, dispatch, state.paymentMethod]);

  const rowCls = "flex items-center justify-between py-1.5";
  const labelCls = "text-sm font-semibold text-muted-foreground";
  const valueCls = "text-sm font-bold";

  return (
    <section className="overflow-hidden rounded-xl border bg-card">
      <header className="flex items-center gap-2 border-b bg-muted px-4 py-2.5">
        <Calculator aria-hidden className="size-5" />
        <span className="text-sm font-extrabold">ملخص المبالغ</span>
      </header>

      <div className="px-4 py-2.5">
        {/* Subtotal */}
        <div className={rowCls}>
          <span className={labelCls}>المجموع الفرعي</span>
          <span className={valueCls} dir="ltr">
            {fmtNum(t.subtotal)} <span className="text-[11px] text-muted-foreground">{currSym}</span>
          </span>
        </div>

        {/* Item discounts */}
        {showDiscount && Number(t.totalDiscount) > 0 && (
          <div className={rowCls}>
            <span className={cn(labelCls, "text-rose-600")}>خصم المنتجات (−)</span>
            <span className={cn(valueCls, "text-rose-600")} dir="ltr">−{fmtNum(t.totalDiscount)}</span>
          </div>
        )}

        {/* Global discount editor — يُخفى في شاشات لا تحفظه (شراء/مرتجع) فلا يظهر إجمالي مخالف للمحفوظ */}
        {showDiscount && (
        <div className={cn(rowCls, "border-b border-dashed pb-2")}>
          <div className="flex items-center gap-2">
            <span className={labelCls}>خصم إجمالي</span>
            <MoneyInput
              value={state.globalDiscount}
              onChange={(value) => dispatch({ type: "SET_FIELD", field: "globalDiscount", value })}
              className="h-7 w-14 text-center text-xs font-bold"
              aria-label="مبلغ الخصم الإجمالي"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 min-w-11 px-1.5 text-xs font-bold text-primary"
              onClick={() =>
                dispatch({
                  type: "SET_FIELD",
                  field: "globalDiscountType",
                  value: state.globalDiscountType === "percent" ? "amount" : "percent",
                })
              }
              // ٢٣/٨ (بلاغ فحص UX): كان `#` وحدَه مبهماً بالعربية. صار «د.ع» صريحاً + `title` يشرح.
              title="اضغط لتبديل بين نسبة مئوية (%) ومبلغ ثابت (د.ع)"
              aria-label={state.globalDiscountType === "percent" ? "الخصم نسبةٌ مئويّة — اضغط للتحويل إلى مبلغ" : "الخصم مبلغٌ بالدينار — اضغط للتحويل إلى نسبة"}
            >
              {state.globalDiscountType === "percent" ? "%" : "د.ع"}
            </Button>
          </div>
          {Number(overrideDiscountAmount ?? t.globalDiscAmt) > 0 && (
            <span className={cn(valueCls, "text-rose-600")} dir="ltr">
              −{fmtNum(overrideDiscountAmount ?? t.globalDiscAmt)}
            </span>
          )}
        </div>
        )}

        {/* Invoice-level tax toggle (optional — applied on (subtotal − discounts) عند الحاجة) */}
        {showTaxToggle && (
          <div className={cn(rowCls, "border-b border-dashed pb-2")}>
            <div className="flex items-center gap-2">
              <Switch
                checked={state.taxEnabled}
                onCheckedChange={(v) => dispatch({ type: "SET_FIELD", field: "taxEnabled", value: v })}
                aria-label="تطبيق ضريبة على الفاتورة"
              />
              <span className={cn(labelCls, "inline-flex items-center gap-1.5")}>
                <Percent aria-hidden className="size-3.5" /> تطبيق ضريبة
              </span>
            </div>
            {state.taxEnabled && (
              <div className="flex items-center gap-1">
                {/* حقلٌ خام سابقاً: كان يقبل «5%» أو حروفاً أو نسبةً > ١٠٠ فيرمي `D()` عند الحفظ
                    برسالة «قيمة مالية غير صالحة» لا تدلّ على الحقل — وهي إحدى الطرق التي كان
                    يتعذّر بها إتمام الفاتورة الآجلة. الآن: تطبيعٌ موحَّد + منزلتان + سقف ١٠٠
                    (مرآة `percentString` خادمياً). */}
                <MoneyInput
                  value={state.taxRatePercent}
                  onChange={(raw) => {
                    const n = Number(raw);
                    const value = raw !== "" && raw !== "." && Number.isFinite(n) && n > 100 ? "100" : raw;
                    dispatch({ type: "SET_FIELD", field: "taxRatePercent", value });
                  }}
                  className="h-7 w-14 text-center text-xs font-bold"
                  ariaLabel="نسبة الضريبة"
                />
                <span className="text-xs font-bold text-muted-foreground">%</span>
              </div>
            )}
          </div>
        )}

        {/* Tax */}
        {Number(t.totalTax) > 0 && (
          <div className={rowCls}>
            <span className={labelCls}>الضريبة{showTaxToggle && state.taxEnabled ? ` (${fmtNum(state.taxRatePercent)}%)` : ""} (+)</span>
            <span className={valueCls} dir="ltr">{fmtNum(t.totalTax)}</span>
          </div>
        )}

        {/* Shipping */}
        {showShipping && (
          <div className={rowCls}>
            <span className={cn(labelCls, "inline-flex items-center gap-1.5")}>
              <Truck aria-hidden className="size-4" /> {shippingLabel}
            </span>
            <div className="flex items-center gap-1.5">
              {/* «مجاني»: يُصفّر الأجرة فلا يُسجَّل إيراد توصيل أصلاً (لا خصمَ صوريّ على إيرادٍ وهميّ).
                  مفتاحٌ لا زرّ: يُظهر الحالة الحاليّة ويسمح بالرجوع. */}
              {allowFreeShipping && (
                <Button
                  type="button"
                  size="sm"
                  variant={isFreeShipping ? "default" : "outline"}
                  aria-pressed={isFreeShipping}
                  className="h-7 px-2 text-[11px] font-bold"
                  onClick={() => dispatch({ type: "SET_FIELD", field: "shippingFree", value: !isFreeShipping })}
                >
                  <Gift aria-hidden className="size-3.5" />
                  مجاني
                </Button>
              )}
              <MoneyInput
                value={state.shipping || ""}
                onChange={(value) => dispatch({ type: "SET_FIELD", field: "shipping", value })}
                placeholder="0"
                className="h-7 w-24 text-center text-xs font-bold"
              />
            </div>
          </div>
        )}
        {/* شفافيةٌ للموظّف: يرى بالضبط ما سيُطبَع للزبون في كلّ حالة. */}
        {showShipping && allowFreeShipping && isFreeShipping && (
          <p
            className={cn(
              "pb-1.5 text-[11px] font-semibold",
              Number(state.shipping || "0") > 0 ? "text-muted-foreground" : "text-destructive",
            )}
            role={Number(state.shipping || "0") > 0 ? undefined : "alert"}
          >
            {Number(state.shipping || "0") > 0
              ? `سيُطبَع على الفاتورة: «التوصيل مجاناً — قيمته ${fmtNum(state.shipping)} ${currSym}» ولن يُضاف للإجمالي.`
              : "أدخِل قيمة الأجرة — إلزامية عند الإهداء كي تُطبَع للزبون وتُحصى في التقارير."}
          </p>
        )}

        {/* Other expenses */}
        {showOtherExpenses && (
          <div className={cn(rowCls, "border-b pb-2.5")}>
            <span className={cn(labelCls, "inline-flex items-center gap-1.5")}>
              <Package aria-hidden className="size-4" /> مصاريف أخرى
            </span>
            <MoneyInput
              value={state.otherExpenses || ""}
              onChange={(value) => dispatch({ type: "SET_FIELD", field: "otherExpenses", value })}
              placeholder="0"
              className="h-7 w-24 text-center text-xs font-bold"
            />
          </div>
        )}

        {/* Grand total */}
        <div className="mt-1 flex items-center justify-between py-3">
          <span className="text-base font-extrabold">الإجمالي النهائي</span>
          <div className="flex items-baseline gap-1.5">
            <span className="text-3xl font-extrabold leading-none tracking-tight text-primary" dir="ltr">
              {fmtNum(effectiveGrandTotal)}
            </span>
            <span className="text-sm font-semibold text-muted-foreground">{currSym}</span>
          </div>
        </div>
      </div>

      {/* Payment section — يُخفى في شاشات تحفظ الدفع في مكان آخر (استلام الشراء) أو عبر مفتاح مخصّص (تسوية المرتجع) */}
      {showPayment && (
      <div className="border-t-2 px-4 py-3">
        <div className="mb-2 flex items-center gap-1.5 text-xs font-extrabold">
          <CreditCard aria-hidden className="size-4" /> الدفع
        </div>

        {state.paymentTerms === "CREDIT" ? (
          <div className="flex items-center gap-2 rounded-lg border border-amber-300/40 bg-amber-50 px-3.5 py-3 text-amber-700">
            <Lock aria-hidden className="size-5" />
            <div>
              <div className="text-sm font-extrabold">دفع آجل (ذمة)</div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                المبلغ الكامل سيُسجَّل كذمة على {state.entityId ? "الحساب المحدد" : "العميل/المورد"}
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* Payment method buttons */}
            <div className="mb-2.5 flex flex-wrap gap-1.5">
              {PAYMENT_METHODS.map((m) => {
                const active = state.paymentMethod === m.value;
                const enabled = !cashOnlyPayment || isPosPaymentMethodEnabled(m.value);
                return (
                  <button
                    key={m.value}
                    type="button"
                    onClick={() => {
                      if (!enabled) return;
                      dispatch({ type: "SET_FIELD", field: "paymentMethod", value: m.value as PaymentMethod });
                    }}
                    disabled={!enabled}
                    aria-describedby={!enabled ? "invoice-external-payment-disabled" : undefined}
                    title={enabled ? m.label : POS_EXTERNAL_PAYMENT_DISABLED_MESSAGE}
                    className={cn(
                      "flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-bold transition",
                      "outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      active
                        ? "border-primary bg-primary/10 text-primary"
                        : enabled
                          ? "border-input bg-card text-foreground hover:bg-muted"
                          : "cursor-not-allowed border-input bg-muted/40 text-muted-foreground/45",
                    )}
                  >
                    {(() => { const MIcon = m.icon; return <MIcon aria-hidden className="size-4" />; })()}
                    {m.label}
                  </button>
                );
              })}
            </div>
            {cashOnlyPayment && (
              <p id="invoice-external-payment-disabled" className="mb-2 text-[10px] leading-relaxed text-muted-foreground">
                {POS_EXTERNAL_PAYMENT_DISABLED_MESSAGE}
              </p>
            )}

            {/* Paid amount */}
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="shrink-0 text-xs font-semibold text-muted-foreground">المدفوع:</span>
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                <MoneyInput
                  value={state.paidAmount || ""}
                  placeholder={String(effectiveGrandTotal)}
                  onChange={(value) => dispatch({ type: "SET_FIELD", field: "paidAmount", value })}
                  className="h-9 min-w-0 flex-1 text-center text-sm font-extrabold"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-9 shrink-0 border-primary bg-primary/10 text-primary"
                  onClick={() => dispatch({ type: "SET_FIELD", field: "paidAmount", value: effectiveGrandTotal })}
                >
                  الكل
                </Button>
              </div>
            </div>

            {items.length > 0 && paidNum > 0 && remainingNum !== 0 && (
              <div
                className={cn(
                  "mt-1 flex items-center justify-between rounded-lg border px-3 py-2",
                  remainingNum > 0
                    ? "border-amber-400/40 bg-amber-50 text-amber-700"
                    : "border-emerald-400/40 bg-emerald-50 text-emerald-700"
                )}
              >
                <span className="text-sm font-bold">{remainingNum > 0 ? "المتبقي (ذمة)" : "الباقي للعميل"}</span>
                <span className="text-xl font-extrabold" dir="ltr">
                  {fmtNum(Math.abs(remainingNum))} <span className="text-xs">{currSym}</span>
                </span>
              </div>
            )}
          </>
        )}
      </div>
      )}
    </section>
  );
}
