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
  const gross = l.unitPrice.times(l.quantity);
  let disc: Decimal;
  if (l.discountAmount != null && l.discountAmount !== "") disc = money(l.discountAmount);
  else if (l.discountPercent != null && l.discountPercent !== "")
    disc = gross.times(money(l.discountPercent)).dividedBy(100);
  else disc = new Decimal(0);
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
}
export interface InvoiceTotals {
  subtotal: string;
  discountAmount: string;
  taxAmount: string;
  total: string;
}

/** subtotal = Σ line totals; tax on (subtotal − invoiceDiscount), rounded once; total = taxable + tax. */
export function computeInvoiceTotals(i: InvoiceTotalsInput): InvoiceTotals {
  const subtotal = round2(sumMoney(i.lineTotals));
  const discount = clampMoney(money(i.invoiceDiscount ?? "0"), subtotal);
  const taxable = subtotal.minus(discount);
  const tax = round2(taxable.times(money(i.taxRatePercent ?? "0")).dividedBy(100));
  return {
    subtotal: subtotal.toFixed(2),
    discountAmount: discount.toFixed(2),
    taxAmount: tax.toFixed(2),
    total: round2(taxable.plus(tax)).toFixed(2),
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
