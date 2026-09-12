import { D, roundCashIQD, round2 } from "@/lib/money";
import { buildDeliveryPayload } from "@/components/pos/deliveryMode";
import {
  type CartItem,
  type POSTab,
  CASHIER_INVOICE_DISCOUNT_MAX_PCT,
  computeInvoiceDiscount,
  itemTotal,
  money,
} from "./posShared";

export interface ComputePOSTotalsParams {
  cart: CartItem[];
  activeTab: POSTab;
}

export function computePOSTotals({ cart, activeTab }: ComputePOSTotalsParams) {
  const subtotalD = cart.reduce((s, c) => s.plus(D(itemTotal(c))), D(0));
  const cartHasDigital = cart.some((c) => c.digital);
  const cartAllDigital = cart.length > 0 && cart.every((c) => c.digital);
  const invoiceDiscountAllowed = !cartAllDigital && !cartHasDigital;

  const referenceGrossD = cart.reduce((s, c) => {
    if (c.digital) return s;
    const refUnit = D((c.row as any).contractUnitPrice ?? c.row.price ?? 0);
    return s.plus(refUnit.times(c.qty));
  }, D(0));

  const priorDeviationRatioD = referenceGrossD.gt(0)
    ? referenceGrossD.minus(subtotalD).div(referenceGrossD)
    : D(0);

  const remainingHeaderAuthorityFractionD = D(0.15).minus(priorDeviationRatioD);
  const remainingHeaderPctOnSubtotalD = (subtotalD.gt(0) && referenceGrossD.gt(0))
    ? remainingHeaderAuthorityFractionD.times(referenceGrossD).div(subtotalD).times(100)
    : D(CASHIER_INVOICE_DISCOUNT_MAX_PCT);

  const effectiveHeaderCapPctD = (remainingHeaderPctOnSubtotalD.lt(0)
    ? D(0)
    : remainingHeaderPctOnSubtotalD.gt(CASHIER_INVOICE_DISCOUNT_MAX_PCT)
      ? D(CASHIER_INVOICE_DISCOUNT_MAX_PCT)
      : remainingHeaderPctOnSubtotalD).toDecimalPlaces(2, 1 /* ROUND_DOWN */);

  const discountCalc = computeInvoiceDiscount({
    subtotalD,
    effectiveHeaderCapPctD,
    invoiceDiscountAllowed,
    type: activeTab.invoiceDiscountType ?? "percent",
    value: activeTab.invoiceDiscountValue ?? (activeTab.invoiceDiscountPct || ""),
  });

  const {
    discountAmountD: invoiceDiscountAmountD,
    discountAmount: invoiceDiscountAmount,
    discountPctD: invoiceDiscountPctD,
    maxDiscountAmount,
  } = discountCalc;

  const subtotal = round2(subtotalD).toNumber();
  const netAfterHeaderD = subtotalD.minus(invoiceDiscountAmountD);
  const codMode = activeTab.delivery != null;
  const deliveryPayload = activeTab.delivery ? buildDeliveryPayload(activeTab.delivery) : null;
  const paidD = D(activeTab.payInput || 0);

  const cashRoundedTotalD = activeTab.method === "CASH" && !cartHasDigital && !codMode
    ? roundCashIQD(netAfterHeaderD.toFixed(2))
    : netAfterHeaderD;
  const cashRoundedPaidD = activeTab.method === "CASH" && !cartHasDigital && !codMode
    ? roundCashIQD(paidD.toFixed(2))
    : paidD;

  const cashRoundedTotal = cashRoundedTotalD.toNumber();
  const cashRoundedPaid = cashRoundedPaidD.toNumber();

  const isCredit = paidD.gt(0) && paidD.lt(cashRoundedTotalD);
  const isChange = paidD.gt(0) && paidD.gte(cashRoundedTotalD);

  const effectiveTotalD = (activeTab.method === "CASH" && !isCredit) ? cashRoundedTotalD : netAfterHeaderD;
  const total = round2(effectiveTotalD).toNumber();
  const paid = round2(paidD).toNumber();
  const change = round2(paidD.minus(effectiveTotalD)).toNumber();
  const credit = round2(effectiveTotalD.minus(paidD)).toNumber();
  const cashRoundingDelta = activeTab.method === "CASH" ? cashRoundedTotalD.minus(netAfterHeaderD).toNumber() : 0;

  const externalPaymentAmount = money(isCredit ? paid : total);
  const externalPaymentFingerprint = `${activeTab.method}|${externalPaymentAmount}|${(activeTab.paymentRef ?? "").trim().toUpperCase()}`;
  const externalPaymentConfirmed = activeTab.method === "CASH"
    || (activeTab.externalPayment?.state === "CONFIRMED"
      && activeTab.externalPayment.fingerprint === externalPaymentFingerprint
      && activeTab.externalPayment.attemptId != null);

  return {
    subtotalD,
    subtotal,
    cartHasDigital,
    cartAllDigital,
    invoiceDiscountAllowed,
    referenceGrossD,
    effectiveHeaderCapPctD,
    discountCalc,
    invoiceDiscountAmountD,
    invoiceDiscountAmount,
    invoiceDiscountPctD,
    maxDiscountAmount,
    netAfterHeaderD,
    codMode,
    deliveryPayload,
    paidD,
    cashRoundedTotalD,
    cashRoundedPaidD,
    cashRoundedTotal,
    cashRoundedPaid,
    isCredit,
    isChange,
    effectiveTotalD,
    total,
    paid,
    change,
    credit,
    cashRoundingDelta,
    externalPaymentAmount,
    externalPaymentFingerprint,
    externalPaymentConfirmed,
  };
}
