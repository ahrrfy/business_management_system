import { D, round2 } from "@/lib/money";

export interface CorrectionComparisonPayload {
  customerId?: number | null;
  contactName?: string | null;
  contactPhone?: string | null;
  priceTier?: string | null;
  lines?: Array<{
    productUnitId: number;
    quantity: string;
    unitPriceOverride?: string;
    discountPercent?: string;
    discountAmount?: string;
    isGift?: boolean;
  }>;
  invoiceDiscount?: string | null;
  deliveryFee?: string | null;
  deliveryFree?: boolean;
  deliveryWaivedAmount?: string | null;
  taxRatePercent?: string | null;
  dueDate?: string | null;
  notes?: string | null;
  additionalPayment?: { amount: string; method: string; shiftId?: number | null } | null;
  overpayHandling?: "CREDIT" | "CASH_REFUND" | null;
}

export interface CorrectionComparisonSource {
  total: string;
  paidAmount: string;
  paymentMethod?: string | null;
  customerId?: number | null;
  customerName?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
  priceTier?: string | null;
  dueDate?: Date | string | null;
  notes?: string | null;
  discountAmount?: string | null;
  taxAmount?: string | null;
  deliveryFee?: string | null;
  deliveryFree?: boolean | null;
  deliveryWaivedAmount?: string | null;
  items: Array<{
    productUnitId?: number | null;
    productName?: string | null;
    variantName?: string | null;
    unitName?: string | null;
    quantity: string;
    unitPrice: string;
    total: string;
    isGift?: boolean | null;
  }>;
}

export interface CorrectionComparisonCatalogRow {
  productUnitId: number;
  productName: string;
  variantName?: string | null;
  unitName: string;
  price?: string | null;
}

export interface CorrectionComparisonLine {
  productUnitId: number;
  name: string;
  unitName: string;
  quantity: string;
  unitPrice: string;
  total: string;
  isGift: boolean;
  change: "same" | "added" | "changed" | "removed";
}

function methodAfterCorrection(current: string | null | undefined, incoming?: string): string | null {
  if (!incoming) return current ?? null;
  if (!current) return incoming;
  return current === incoming ? current : "MIXED";
}

function displayName(row: { productName?: string | null; variantName?: string | null }): string {
  return [row.productName || "صنف", row.variantName].filter(Boolean).join(" — ");
}

export function buildSalesCorrectionComparison(
  source: CorrectionComparisonSource,
  payload: CorrectionComparisonPayload | null | undefined,
  catalog: CorrectionComparisonCatalogRow[],
) {
  const requestedLines = payload?.lines ?? [];
  const catalogByUnit = new Map(catalog.map((row) => [Number(row.productUnitId), row]));
  const beforeByUnit = new Map(source.items.map((item) => [Number(item.productUnitId ?? 0), item]));

  const afterLines: CorrectionComparisonLine[] = requestedLines.map((line) => {
    const unitId = Number(line.productUnitId);
    const cat = catalogByUnit.get(unitId);
    const before = beforeByUnit.get(unitId);
    const isGift = line.isGift === true;
    const unitPrice = isGift ? D(0) : D(line.unitPriceOverride ?? cat?.price ?? before?.unitPrice ?? "0");
    const gross = unitPrice.mul(D(line.quantity));
    const roundedGross = round2(gross);
    const requestedDiscount = isGift
      ? D(0)
      : line.discountAmount != null
        ? round2(D(line.discountAmount))
        : round2(gross.mul(D(line.discountPercent ?? "0")).div(100));
    const discount = requestedDiscount.gt(roundedGross) ? roundedGross : requestedDiscount;
    const net = gross.minus(discount);
    const total = round2(net.isNegative() ? D(0) : net);
    const changed = before != null && (
      !D(before.quantity).eq(D(line.quantity))
      || !D(before.unitPrice).eq(unitPrice)
      || !D(before.total).eq(total)
      || Boolean(before.isGift) !== isGift
    );
    return {
      productUnitId: unitId,
      name: displayName(cat ?? before ?? {}),
      unitName: cat?.unitName ?? before?.unitName ?? "وحدة",
      quantity: D(line.quantity).toString(),
      unitPrice: round2(unitPrice).toFixed(2),
      total: total.toFixed(2),
      isGift,
      change: before ? (changed ? "changed" : "same") : "added",
    };
  });

  const afterUnitIds = new Set(afterLines.map((line) => line.productUnitId));
  const removedLines: CorrectionComparisonLine[] = source.items
    .filter((item) => !afterUnitIds.has(Number(item.productUnitId ?? 0)))
    .map((item) => ({
      productUnitId: Number(item.productUnitId ?? 0),
      name: displayName(item),
      unitName: item.unitName ?? "وحدة",
      quantity: D(item.quantity).toString(),
      unitPrice: round2(D(item.unitPrice)).toFixed(2),
      total: round2(D(item.total)).toFixed(2),
      isGift: Boolean(item.isGift),
      change: "removed",
    }));

  const subtotal = round2(afterLines.reduce((sum, line) => sum.plus(D(line.total)), D(0)));
  const requestedDiscount = D(payload?.invoiceDiscount ?? "0");
  const invoiceDiscount = round2(requestedDiscount.gt(subtotal) ? subtotal : requestedDiscount);
  const afterDiscount = round2(subtotal.minus(invoiceDiscount));
  const tax = round2(afterDiscount.mul(D(payload?.taxRatePercent ?? "0")).div(100));
  const total = round2(afterDiscount.plus(tax).plus(D(payload?.deliveryFee ?? "0")));
  const originalPaid = round2(D(source.paidAmount));
  const additional = round2(D(payload?.additionalPayment?.amount ?? "0"));
  const availablePaid = originalPaid.plus(additional);
  const paid = round2(availablePaid.gt(total) ? total : availablePaid);
  const dueRaw = total.minus(paid);
  const due = round2(dueRaw.isNegative() ? D(0) : dueRaw);
  const overpayRaw = originalPaid.minus(total);
  const overpay = round2(overpayRaw.isNegative() ? D(0) : overpayRaw);

  return {
    beforeTotal: round2(D(source.total)).toFixed(2),
    beforePaid: originalPaid.toFixed(2),
    afterSubtotal: subtotal.toFixed(2),
    afterDiscount: invoiceDiscount.toFixed(2),
    afterTax: tax.toFixed(2),
    afterDelivery: round2(D(payload?.deliveryFee ?? "0")).toFixed(2),
    afterDeliveryFree: payload?.deliveryFree === true,
    afterDeliveryWaived: round2(D(payload?.deliveryWaivedAmount ?? "0")).toFixed(2),
    afterTotal: total.toFixed(2),
    afterPaid: paid.toFixed(2),
    afterDue: due.toFixed(2),
    overpay: overpay.toFixed(2),
    overpayHandling: payload?.overpayHandling ?? null,
    paymentMethod: methodAfterCorrection(source.paymentMethod, payload?.additionalPayment?.method),
    afterLines,
    removedLines,
  };
}
