/**
 * TotalsPanel — financial summary + payment block.
 * Ported from `_design-bundle/project/invoice-footer.jsx#TotalsPanel`.
 */
import type { Dispatch } from "react";
import { Calculator, CreditCard, Lock, Package, Percent, Truck } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { calcTotals, fmtNum } from "./totals";
import { PAYMENT_METHODS, type InvoiceAction, type InvoiceLine, type InvoiceState, type PaymentMethod } from "./types";

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
}: TotalsPanelProps) {
  const t = calcTotals(items, state);
  const currSym = state.currency === "USD" ? "$" : "د.ع";
  const grandTotalNum = Number(t.grandTotal);
  const paidNum = Number(state.paidAmount || "0");
  const remainingNum = grandTotalNum - paidNum;

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
            <Input
              dir="ltr"
              value={state.globalDiscount}
              onChange={(e) => dispatch({ type: "SET_FIELD", field: "globalDiscount", value: e.target.value })}
              className="h-7 w-14 text-center text-xs font-bold"
              aria-label="مبلغ الخصم الإجمالي"
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-7 w-7 text-xs font-bold text-primary"
              onClick={() =>
                dispatch({
                  type: "SET_FIELD",
                  field: "globalDiscountType",
                  value: state.globalDiscountType === "percent" ? "amount" : "percent",
                })
              }
              aria-label="تبديل نوع الخصم"
            >
              {state.globalDiscountType === "percent" ? "%" : "#"}
            </Button>
          </div>
          {Number(t.globalDiscAmt) > 0 && (
            <span className={cn(valueCls, "text-rose-600")} dir="ltr">−{fmtNum(t.globalDiscAmt)}</span>
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
                <Input
                  dir="ltr"
                  value={state.taxRatePercent}
                  onChange={(e) => dispatch({ type: "SET_FIELD", field: "taxRatePercent", value: e.target.value })}
                  className="h-7 w-14 text-center text-xs font-bold"
                  aria-label="نسبة الضريبة"
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
              <Truck aria-hidden className="size-4" /> مصاريف شحن
            </span>
            <Input
              dir="ltr"
              value={state.shipping || ""}
              onChange={(e) => dispatch({ type: "SET_FIELD", field: "shipping", value: e.target.value })}
              placeholder="0"
              className="h-7 w-24 text-center text-xs font-bold"
            />
          </div>
        )}

        {/* Other expenses */}
        {showOtherExpenses && (
          <div className={cn(rowCls, "border-b pb-2.5")}>
            <span className={cn(labelCls, "inline-flex items-center gap-1.5")}>
              <Package aria-hidden className="size-4" /> مصاريف أخرى
            </span>
            <Input
              dir="ltr"
              value={state.otherExpenses || ""}
              onChange={(e) => dispatch({ type: "SET_FIELD", field: "otherExpenses", value: e.target.value })}
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
              {fmtNum(t.grandTotal)}
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
                return (
                  <button
                    key={m.value}
                    type="button"
                    onClick={() => dispatch({ type: "SET_FIELD", field: "paymentMethod", value: m.value as PaymentMethod })}
                    className={cn(
                      "flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-bold transition",
                      "outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      active ? "border-primary bg-primary/10 text-primary" : "border-input bg-card text-foreground hover:bg-muted"
                    )}
                  >
                    {(() => { const MIcon = m.icon; return <MIcon aria-hidden className="size-4" />; })()}
                    {m.label}
                  </button>
                );
              })}
            </div>

            {/* Paid amount */}
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="shrink-0 text-xs font-semibold text-muted-foreground">المدفوع:</span>
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                <Input
                  dir="ltr"
                  value={state.paidAmount || ""}
                  placeholder={String(t.grandTotal)}
                  onChange={(e) => dispatch({ type: "SET_FIELD", field: "paidAmount", value: e.target.value })}
                  className="h-9 min-w-0 flex-1 text-center text-sm font-extrabold"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-9 shrink-0 border-primary bg-primary/10 text-primary"
                  onClick={() => dispatch({ type: "SET_FIELD", field: "paidAmount", value: t.grandTotal })}
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
