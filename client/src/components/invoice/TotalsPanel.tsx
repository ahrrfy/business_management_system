/**
 * TotalsPanel — financial summary + payment block.
 * Ported from `_design-bundle/project/invoice-footer.jsx#TotalsPanel`.
 */
import type { Dispatch } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { calcTotals, fmtNum } from "./totals";
import { PAYMENT_METHODS, type InvoiceAction, type InvoiceLine, type InvoiceState, type PaymentMethod } from "./types";

export interface TotalsPanelProps {
  items: InvoiceLine[];
  state: InvoiceState;
  dispatch: Dispatch<InvoiceAction>;
}

export function TotalsPanel({ items, state, dispatch }: TotalsPanelProps) {
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
        <span className="text-base">🧮</span>
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
        {Number(t.totalDiscount) > 0 && (
          <div className={rowCls}>
            <span className={cn(labelCls, "text-rose-600")}>خصم الأصناف (−)</span>
            <span className={cn(valueCls, "text-rose-600")} dir="ltr">−{fmtNum(t.totalDiscount)}</span>
          </div>
        )}

        {/* Global discount editor */}
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

        {/* Tax */}
        {Number(t.totalTax) > 0 && (
          <div className={rowCls}>
            <span className={labelCls}>الضريبة (+)</span>
            <span className={valueCls} dir="ltr">{fmtNum(t.totalTax)}</span>
          </div>
        )}

        {/* Shipping */}
        <div className={rowCls}>
          <span className={labelCls}>🚛 مصاريف شحن</span>
          <Input
            dir="ltr"
            value={state.shipping || ""}
            onChange={(e) => dispatch({ type: "SET_FIELD", field: "shipping", value: e.target.value })}
            placeholder="0"
            className="h-7 w-24 text-center text-xs font-bold"
          />
        </div>

        {/* Other expenses */}
        <div className={cn(rowCls, "border-b pb-2.5")}>
          <span className={labelCls}>📦 مصاريف أخرى</span>
          <Input
            dir="ltr"
            value={state.otherExpenses || ""}
            onChange={(e) => dispatch({ type: "SET_FIELD", field: "otherExpenses", value: e.target.value })}
            placeholder="0"
            className="h-7 w-24 text-center text-xs font-bold"
          />
        </div>

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

      {/* Payment section */}
      <div className="border-t-2 px-4 py-3">
        <div className="mb-2 flex items-center gap-1.5 text-xs font-extrabold">💳 الدفع</div>

        {state.paymentTerms === "CREDIT" ? (
          <div className="flex items-center gap-2 rounded-lg border border-amber-300/40 bg-amber-50 px-3.5 py-3 text-amber-700">
            <span className="text-xl">🔒</span>
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
                    <span>{m.icon}</span>
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
    </section>
  );
}
