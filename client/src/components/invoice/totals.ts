/**
 * Decimal-safe totals calculator for the invoice editor.
 * Ported from `_design-bundle/project/invoice-footer.jsx#calcTotals` but uses
 * decimal.js (round HALF_UP) per the project's money rules — NO parseFloat.
 */
import Decimal from "decimal.js";
import { D, round2 } from "@/lib/money";
import type { InvoiceLine, InvoiceState } from "./types";

export interface InvoiceTotals {
  /** sum of (price × qty) over lines, 2dp string. */
  subtotal: string;
  /** sum of per-line discounts, 2dp string. */
  totalDiscount: string;
  /** global (footer) discount amount, 2dp string. */
  globalDiscAmt: string;
  /** subtotal − line discounts − global discount, 2dp string. */
  afterDiscount: string;
  /** sum of per-line tax (applied to post-line-discount base), 2dp string. */
  totalTax: string;
  shipping: string;
  otherExpenses: string;
  /** afterDiscount + totalTax + shipping + otherExpenses, 2dp string. */
  grandTotal: string;
  /** grandTotal − paidAmount (may be negative = change due back). */
  remaining: string;
}

Decimal.set({ rounding: Decimal.ROUND_HALF_UP });

/**
 * decimal.js يرمي خطأً على نصّ غير صالح (مثل «12a» أو «1.2.3») وهو ما يحدث طبيعياً
 * أثناء كتابة المستخدم في حقول المبالغ (المدفوع/الخصم/الشحن/ضريبة السطر). هذا الغلاف
 * يُرجع 0 بدل الرمي حتى لا ينهار محرّر الفاتورة أثناء الرسم — التحقّق الصارم يبقى عند الحفظ.
 */
function safeD(v: string | number): Decimal {
  try {
    return D(v);
  } catch {
    return new Decimal(0);
  }
}

export function calcTotals(items: InvoiceLine[], state: InvoiceState): InvoiceTotals {
  let subtotal = new Decimal(0);
  let totalDiscount = new Decimal(0);
  let totalTax = new Decimal(0);

  for (const item of items) {
    const price = safeD(item.price);
    const qty = safeD(item.qty);
    const lineBase = price.times(qty);
    subtotal = subtotal.plus(lineBase);

    const discRaw = safeD(item.discount);
    const disc =
      item.discountType === "percent"
        ? lineBase.times(discRaw).dividedBy(100)
        : discRaw;
    totalDiscount = totalDiscount.plus(disc);

    const afterDisc = lineBase.minus(disc);
    const taxPct = safeD(item.tax);
    const tax = afterDisc.times(taxPct).dividedBy(100);
    totalTax = totalTax.plus(tax);
  }

  const afterItemDisc = subtotal.minus(totalDiscount);
  const gdRaw = safeD(state.globalDiscount);
  const globalDiscAmt =
    state.globalDiscountType === "percent"
      ? afterItemDisc.times(gdRaw).dividedBy(100)
      : gdRaw;
  const afterGlobalDisc = afterItemDisc.minus(globalDiscAmt);

  const shipping = safeD(state.shipping);
  const otherExpenses = safeD(state.otherExpenses);
  const grandTotal = afterGlobalDisc.plus(totalTax).plus(shipping).plus(otherExpenses);
  const paid = safeD(state.paidAmount);
  const remaining = grandTotal.minus(paid);

  return {
    subtotal: round2(subtotal).toFixed(2),
    totalDiscount: round2(totalDiscount).toFixed(2),
    globalDiscAmt: round2(globalDiscAmt).toFixed(2),
    afterDiscount: round2(afterGlobalDisc).toFixed(2),
    totalTax: round2(totalTax).toFixed(2),
    shipping: round2(shipping).toFixed(2),
    otherExpenses: round2(otherExpenses).toFixed(2),
    grandTotal: round2(grandTotal).toFixed(2),
    remaining: round2(remaining).toFixed(2),
  };
}

/** Per-line total (after discount + tax) — 2dp string. */
export function calcLineTotal(item: InvoiceLine): string {
  const price = safeD(item.price);
  const qty = safeD(item.qty);
  const lineBase = price.times(qty);
  const discRaw = safeD(item.discount);
  const disc =
    item.discountType === "percent"
      ? lineBase.times(discRaw).dividedBy(100)
      : discRaw;
  const afterDisc = lineBase.minus(disc);
  const taxPct = safeD(item.tax);
  const tax = afterDisc.times(taxPct).dividedBy(100);
  return round2(afterDisc.plus(tax)).toFixed(2);
}

/** Per-line margin percent (price-vs-costBase). Returns 2dp string (e.g. "23.45"), or "0" when no cost. */
export function calcMargin(item: InvoiceLine): string {
  const cost = safeD(item.costBase);
  const price = safeD(item.price);
  if (cost.lessThanOrEqualTo(0) || price.lessThanOrEqualTo(0)) return "0";
  return round2(price.minus(cost).dividedBy(cost).times(100)).toFixed(2);
}

/** Pretty-format a decimal-string amount for Arabic UI (en-US digits, currency suffix).
 *  §٥: نحوّل إلى Decimal أولاً ثم نقرّب HALF_UP ⇒ لا انجراف float قبل التقريب. */
export function fmtMoney(amount: string | number, currency: "IQD" | "USD" = "IQD"): string {
  const sym = currency === "USD" ? "$" : "د.ع";
  try {
    const d = D(amount);
    if (!d.isFinite()) return `0 ${sym}`;
    return `${d.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber().toLocaleString("en-US")} ${sym}`;
  } catch {
    return `0 ${sym}`;
  }
}

export function fmtNum(n: string | number | null | undefined): string {
  if (n == null) return "0";
  const v = Number(n);
  if (!isFinite(v)) return "0";
  return v.toLocaleString("en-US");
}
