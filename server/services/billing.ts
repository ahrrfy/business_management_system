import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { clampMoney, money, round2, sumMoney } from "./money";

export interface LineInput {
  unitPrice: Decimal;
  quantity: Decimal;
  discountPercent?: string | null;
  discountAmount?: string | null;
}
export interface LineResult {
  unitPrice: string;
  quantity: string;
  discountAmount: string;
  total: string;
}

/** Line total = unitPrice × quantity − discount (amount overrides percent), clamped to gross. */
export function computeLineTotal(l: LineInput): LineResult {
  // سياسة #14: لا أسعار/كميات/خصومات سالبة. السعر/الكمية صفر مسموح للهدايا الترويجية (total=0).
  if (l.unitPrice.lt(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "السعر لا يصحّ أن يكون سالباً" });
  if (l.quantity.lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "الكمية يجب أن تكون موجبة" });
  const gross = l.unitPrice.times(l.quantity);
  let disc: Decimal;
  if (l.discountAmount != null && l.discountAmount !== "") disc = money(l.discountAmount);
  else if (l.discountPercent != null && l.discountPercent !== "") {
    const pct = money(l.discountPercent);
    if (pct.lt(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "نسبة الخصم لا يصحّ أن تكون سالبة" });
    disc = gross.times(pct).dividedBy(100);
  } else disc = new Decimal(0);
  if (disc.lt(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "الخصم لا يصحّ أن يكون سالباً" });
  disc = clampMoney(round2(disc), round2(gross));
  return {
    unitPrice: l.unitPrice.toDecimalPlaces(2).toFixed(2),
    quantity: l.quantity.toDecimalPlaces(3).toFixed(3),
    discountAmount: disc.toFixed(2),
    total: round2(gross.minus(disc)).toFixed(2),
  };
}

export interface InvoiceTotalsInput {
  lineTotals: string[];
  invoiceDiscount?: string | null;
  taxRatePercent?: string | null;
  /** أجرة توصيل/شحن تُضاف على رأس الفاتورة (بعد الضريبة، لا تُخصم منها ولا تحمل تكلفة) — إيرادُ شحن.
   *  الافتراضي 0 ⇒ سلوك متطابق للمسارات القائمة (POS/بيع عادي). يُستعمل في إرسال طلب المتجر (COD). */
  deliveryFee?: string | null;
}
export interface InvoiceTotals {
  subtotal: string;
  discountAmount: string;
  taxAmount: string;
  total: string;
}

/** subtotal = Σ line totals; tax on (subtotal − invoiceDiscount), rounded once; total = taxable + tax. */
export function computeInvoiceTotals(i: InvoiceTotalsInput): InvoiceTotals {
  // سياسة #14: لا خصم/ضريبة سالبة على رأس الفاتورة (تُنشئ خصماً خفياً أو ضريبةً عكسية).
  const subtotal = round2(sumMoney(i.lineTotals));
  // قرّب الخصم مرة واحدة عند الإدخال (يمنع انجراف 0.01 بين total و subtotal−discount+tax).
  const rawDiscount = round2(money(i.invoiceDiscount ?? "0"));
  if (rawDiscount.lt(0)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "خصم الفاتورة لا يصحّ أن يكون سالباً" });
  }
  const rawTax = money(i.taxRatePercent ?? "0");
  if (rawTax.lt(0)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "نسبة الضريبة لا يصحّ أن تكون سالبة" });
  }
  const discount = clampMoney(rawDiscount, subtotal);
  const taxable = subtotal.minus(discount);
  const tax = round2(taxable.times(rawTax).dividedBy(100));
  const rawFee = round2(money(i.deliveryFee ?? "0"));
  if (rawFee.lt(0)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "أجرة التوصيل لا تصحّ أن تكون سالبة" });
  }
  return {
    subtotal: subtotal.toFixed(2),
    discountAmount: discount.toFixed(2),
    taxAmount: tax.toFixed(2),
    total: round2(taxable.plus(tax).plus(rawFee)).toFixed(2),
  };
}

/** Snapshot of the variant's cost per base unit at sale time. */
export const snapshotUnitCost = (variantCostPrice: string): string => round2(money(variantCostPrice)).toFixed(2);

/** COGS = Σ (unitCost × baseQuantity). */
export function computeInvoiceCost(lines: { unitCost: string; baseQuantity: number }[]): string {
  return round2(
    lines.reduce<Decimal>((a, l) => a.plus(money(l.unitCost).times(l.baseQuantity)), new Decimal(0))
  ).toFixed(2);
}

export interface BelowCostLine {
  total: string;
  unitCost: string;
  baseQuantity: number;
}

/** SALES-01/02: هل تَبيع الفاتورة بأقل من التكلفة؟ يَكشف (أ) بنداً يُباع تحت تكلفته (سعر/خصم سطر)
 *  أو (ب) فاتورةً يَنزل صافيها (subtotal − discount) تحت COGS الكلّي. الهدايا (تكلفة=صفر) ليست
 *  «تحت التكلفة». مشترك بين saleService و printSaleService فلا تَنجرف سياسة القناتين. */
export function isInvoiceBelowCost(
  lines: BelowCostLine[],
  subtotal: string,
  discountAmount: string,
  costTotal: string | Decimal,
): boolean {
  const lineBelowCost = lines.some((l) => money(l.total).lt(money(l.unitCost).times(l.baseQuantity)));
  const revenue = money(subtotal).minus(money(discountAmount));
  return lineBelowCost || revenue.lt(money(costTotal));
}
