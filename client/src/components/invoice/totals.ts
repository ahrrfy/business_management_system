/**
 * Decimal-safe totals calculator for the invoice editor.
 * Ported from `_design-bundle/project/invoice-footer.jsx#calcTotals` but uses
 * decimal.js (round HALF_UP) per the project's money rules — NO parseFloat.
 *
 * §١٤ (سياسة المشروع): ضريبة على مستوى الفاتورة فقط (`state.taxEnabled` + `state.taxRatePercent`).
 * لا ضريبة قابلة للتحرير لكل سطر — البنود لا تحمل نسبة ضريبة خاصّة بها؛ الحصّة تُوزَّع حسابياً
 * للعرض فقط عبر `allocateLineTax` (تفصيل بصري، لا يُحفظ في قاعدة البيانات — تُطابق سطر الضريبة
 * الظاهر في `TotalsPanel` وحقل `invoices.taxAmount` الذي يحسبه `computeInvoiceTotals` خادمياً).
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
  /** ضريبة الفاتورة الكلّية (على المستوى الفاتوريّ لا السطريّ)، 2dp. */
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
 * أثناء كتابة المستخدم في حقول المبالغ (المدفوع/الخصم/الشحن). هذا الغلاف يُرجع 0 بدل
 * الرمي حتى لا ينهار محرّر الفاتورة أثناء الرسم — التحقّق الصارم يبقى عند الحفظ.
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
  }

  const afterItemDisc = subtotal.minus(totalDiscount);
  const gdRaw = safeD(state.globalDiscount);
  const globalDiscAmt =
    state.globalDiscountType === "percent"
      ? afterItemDisc.times(gdRaw).dividedBy(100)
      : gdRaw;
  const afterGlobalDisc = afterItemDisc.minus(globalDiscAmt);

  // ضريبة مستوى الفاتورة (اختيارية) — على (المجموع الفرعي − كل الخصومات)، مطابقة تماماً
  // لـcomputeInvoiceTotals الخادمية (سياسة #14: لا تُطبَّق إلا بتفعيل صريح من المستخدم).
  let totalTax = new Decimal(0);
  if (state.taxEnabled) {
    const invoiceTaxRate = safeD(state.taxRatePercent ?? "0");
    totalTax = afterGlobalDisc.times(invoiceTaxRate).dividedBy(100);
  }

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

/** Per-line total (after discount, pre-tax) — 2dp string. الضريبة على مستوى الفاتورة لا السطر. */
export function calcLineTotal(item: InvoiceLine): string {
  const price = safeD(item.price);
  const qty = safeD(item.qty);
  const lineBase = price.times(qty);
  const discRaw = safeD(item.discount);
  const disc =
    item.discountType === "percent"
      ? lineBase.times(discRaw).dividedBy(100)
      : discRaw;
  return round2(lineBase.minus(disc)).toFixed(2);
}

/** Per-line margin percent (price-vs-costBase). Returns 2dp string (e.g. "23.45"), or "0" when no cost. */
export function calcMargin(item: InvoiceLine): string {
  const cost = safeD(item.costBase);
  const price = safeD(item.price);
  if (cost.lessThanOrEqualTo(0) || price.lessThanOrEqualTo(0)) return "0";
  return round2(price.minus(cost).dividedBy(cost).times(100)).toFixed(2);
}

/**
 * توزيع ضريبة الفاتورة الكلّية على السطور تناسبياً مع حصّة كلّ سطر من `taxableBase`
 * (المجموع الفرعي بعد كل الخصومات). خوارزمية «آخر سطر ذي مبلغ يمتصّ فرق التقريب»
 * تضمن ثابتاً صارماً: **مجموع الحصص = totalTax بالضبط دائماً** (لا انجراف سنتات، حتى مع
 * تقريب HALF_UP وتوزيعات غير مُتقاسِمة). للعرض فقط — لا يُحفظ لكل سطر في قاعدة البيانات.
 *
 * حالات حدّية: 0 سطور ⇒ []؛ totalTax≤0 أو taxableBase≤0 ⇒ كل الحصص "0.00"؛ لا سطور
 * ذات total>0 مع ضريبة موجبة ⇒ تُعاد الحصص "0.00" (لا يوجد سطر يستحقّ التخصيص).
 */
export function allocateLineTax(
  lines: { total: string }[],
  totalTax: string,
  taxableBase: string,
): string[] {
  const n = lines.length;
  if (n === 0) return [];
  const T = safeD(totalTax);
  const B = safeD(taxableBase);
  const zeros = () => Array<string>(n).fill("0.00");
  if (T.lte(0) || B.lte(0)) return zeros();

  const shares: string[] = new Array(n).fill("0.00");
  let running = new Decimal(0);
  let lastNonZero = -1;
  for (let i = 0; i < n; i++) {
    const lineTotal = safeD(lines[i].total);
    if (lineTotal.lte(0)) continue;
    lastNonZero = i;
    const share = round2(lineTotal.times(T).dividedBy(B));
    shares[i] = share.toFixed(2);
    running = running.plus(share);
  }

  if (lastNonZero < 0) return zeros(); // لا سطر يستحقّ التخصيص
  const diff = round2(T.minus(running));
  if (!diff.isZero()) {
    shares[lastNonZero] = round2(safeD(shares[lastNonZero]).plus(diff)).toFixed(2);
  }
  return shares;
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
