import type Decimal from "decimal.js";
import { D, roundCashIQD, round2 } from "@/lib/money";
import { buildDeliveryPayload, saleReceiptAmounts } from "@/components/pos/deliveryMode";
import { paymentMethodLabel } from "@/lib/paymentMethod";
import {
  type CartItem,
  type PaymentMethod,
  type PosPaymentLegDraft,
  type POSTab,
  type Receipt,
  CASHIER_INVOICE_DISCOUNT_MAX_PCT,
  computeInvoiceDiscount,
  itemTotal,
  money,
} from "./posShared";

import { toNormalizedNumber } from "@shared/numberNormalize";
import { checkoutExtraTotal } from "./checkoutExtraAmounts";

export function parsePosLegAmountD(rawAmount: string): Decimal {
  const norm = toNormalizedNumber(rawAmount ?? "").trim();
  const n = Number(norm);
  return norm !== "" && Number.isFinite(n) && n > 0 ? round2(D(norm)) : D(0);
}

export function computeSplitLegFingerprint(
  leg: Pick<PosPaymentLegDraft, "method" | "amount" | "paymentRef">,
  feeAmount: Decimal = D(0),
): string {
  const amtD = parsePosLegAmountD(leg.amount).plus(feeAmount);
  return `${leg.method}|${amtD.toFixed(2)}|${(leg.paymentRef ?? "").trim().toUpperCase()}`;
}

export function isSplitLegExternalConfirmed(leg: PosPaymentLegDraft, feeAmount: Decimal = D(0)): boolean {
  if (leg.method === "CASH") return true;
  const ep = leg.externalPayment;
  if (!ep || ep.state !== "CONFIRMED" || ep.attemptId == null) return false;
  return ep.fingerprint === computeSplitLegFingerprint(leg, feeAmount);
}

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
  const remainingHeaderPctOnSubtotalD =
    subtotalD.gt(0) && referenceGrossD.gt(0)
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
  const paymentLegs = activeTab.paymentLegs ?? [];
  const serviceChargeD = checkoutExtraTotal(activeTab.extraCharges),chargeOnly=cart.length===0&&serviceChargeD.gt(0);
  const isSplitPayment = paymentLegs.length > 0;
  const splitHasNonCash = isSplitPayment && paymentLegs.some((l) => l.method !== "CASH");
  const splitHasCash = isSplitPayment && paymentLegs.some((l) => l.method === "CASH");
  const rawLegsPaidD = isSplitPayment
    ? paymentLegs.reduce((sum, l) => sum.plus(parsePosLegAmountD(l.amount)), D(0))
    : D(0);
  const nonCashLegsPaidD = isSplitPayment
    ? paymentLegs.reduce(
        (sum, l) =>
          l.method === "CASH" ? sum : sum.plus(parsePosLegAmountD(l.amount)),
        D(0),
      )
    : D(0);

  const paidD = isSplitPayment ? rawLegsPaidD : D(activeTab.payInput || 0);

  const cashRoundedTotalD =
    (isSplitPayment ? splitHasCash && !splitHasNonCash
      : activeTab.method === "CASH") &&
    !cartHasDigital &&
    !codMode
      ? roundCashIQD(netAfterHeaderD.toFixed(2))
      : netAfterHeaderD;
  const cashRoundedPaidD =
    (isSplitPayment ? splitHasCash && !splitHasNonCash
      : activeTab.method === "CASH") &&
    !cartHasDigital &&
    !codMode
      ? roundCashIQD(paidD.toFixed(2))
      : paidD;

  const cashRoundedTotal = cashRoundedTotalD.toNumber();
  const cashRoundedPaid = cashRoundedPaidD.toNumber();

  const isZeroPayCredit =
    !isSplitPayment &&
    activeTab.customerId != null &&
    activeTab.payInput.trim() !== "" &&
    paidD.eq(0) &&
    cashRoundedTotalD.gt(0);
  const isCredit = isSplitPayment
    ? cashRoundedTotalD.gt(0) && paidD.lt(cashRoundedTotalD)
    : isZeroPayCredit || (paidD.gt(0) && paidD.lt(cashRoundedTotalD));
  const isChange = paidD.gt(0) && paidD.gte(cashRoundedTotalD);

  const effectiveTotalD =
    (isSplitPayment ? splitHasCash && !splitHasNonCash
      : activeTab.method === "CASH") && !isCredit
      ? cashRoundedTotalD
      : netAfterHeaderD;
  const total = round2(effectiveTotalD).toNumber();
  const paid = round2(paidD).toNumber();
  const change = round2(paidD.minus(effectiveTotalD)).toNumber();
  const credit = round2(effectiveTotalD.minus(paidD)).toNumber();
  const cashRoundingDelta =
    (isSplitPayment ? splitHasCash && !splitHasNonCash
      : activeTab.method === "CASH")
      ? cashRoundedTotalD.minus(netAfterHeaderD).toNumber()
      : 0;

  const splitInvalidLeg =
    isSplitPayment &&
    (paymentLegs.length < 2 || paymentLegs.some((l) => parsePosLegAmountD(l.amount).lte(0)));
  const splitNonCashOverpay =
    isSplitPayment &&
    (nonCashLegsPaidD.gt(chargeOnly?serviceChargeD:effectiveTotalD) || (!splitHasCash && paidD.gt(chargeOnly?serviceChargeD:effectiveTotalD)));

  const deliveryFeeHeldD = deliveryPayload?.feeCollection === "COUNTER" ? D(deliveryPayload.fee) : D(0);
  const externalPaymentAmount = round2(D(isCredit ? paid : total).plus(deliveryFeeHeldD)
      .plus(serviceChargeD)).toFixed(2);
  const externalPaymentFingerprint = `${activeTab.method}|${externalPaymentAmount}|${(activeTab.paymentRef ?? "").trim().toUpperCase()}`;
  const externalPaymentConfirmed = isSplitPayment
    ? !splitInvalidLeg &&
      !splitNonCashOverpay &&
      paymentLegs.every((leg, index) => isSplitLegExternalConfirmed(leg, index === 0&&!chargeOnly ? deliveryFeeHeldD.plus(serviceChargeD) : D(0)))
    : activeTab.method === "CASH" ||
      (activeTab.externalPayment?.state === "CONFIRMED" &&
        activeTab.externalPayment.fingerprint === externalPaymentFingerprint &&
        activeTab.externalPayment.attemptId != null);

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
    externalPaymentAmount, deliveryFeeHeldD,
    externalPaymentFingerprint,
    externalPaymentConfirmed,
    isSplitPayment,
    splitInvalidLeg,
    splitNonCashOverpay,
  };
}

export function computePosSaleReceiptSnapshot(params: {
  activeTab: POSTab;
  effectiveTotalD: Decimal;
  cashRoundedPaidD: Decimal;
  paidD: Decimal;
  isCredit: boolean;
  codMode: boolean;
}) {
  const { activeTab, effectiveTotalD, cashRoundedPaidD, paidD, isCredit, codMode } = params;
  const legs = activeTab.paymentLegs ?? [];
  const splitActive = legs.length > 0;
  const splitMethods = new Set(legs.map((l) => l.method));
  const effectiveMethodCode: PaymentMethod | "MIXED" = splitActive
    ? splitMethods.size > 1 ? "MIXED" : (legs[0]?.method ?? activeTab.method)
    : activeTab.method;
  const cashFull = !splitActive && activeTab.method === "CASH" && !isCredit;
  const displayPaidD = cashFull ? cashRoundedPaidD : paidD;
  const receiptCalcMethod = splitActive
    ? legs.some((l) => l.method === "CASH") ? "CASH" : "CARD"
    : activeTab.method;
  const { received: finalReceivedD, change: finalChangeD, credit: finalCreditD } =
    saleReceiptAmounts({ codMode, method: receiptCalcMethod, paidNow: displayPaidD, total: effectiveTotalD, isCredit });
  let nonCashSumD = D(0);
  for (const l of legs) {
    if (l.method !== "CASH") nonCashSumD = nonCashSumD.plus(parsePosLegAmountD(l.amount));
  }
  let nonCashRem = nonCashSumD.gt(effectiveTotalD) ? effectiveTotalD : nonCashSumD;
  const cappedPaidD = paidD.gt(effectiveTotalD) ? effectiveTotalD : paidD;
  const cashDiffD = cappedPaidD.minus(nonCashRem);
  let cashRem = cashDiffD.gt(0) ? cashDiffD : D(0);
  const paymentLegs: Receipt["paymentLegs"] = splitActive
    ? legs
        .map((l) => {
          const rawD = parsePosLegAmountD(l.amount);
          const netD = l.method === "CASH"
            ? rawD.gt(cashRem) ? cashRem : rawD
              : rawD.gt(nonCashRem) ? nonCashRem : rawD;
          if (l.method === "CASH") cashRem = cashRem.minus(netD);
          else nonCashRem = nonCashRem.minus(netD);
          return {
            method: paymentMethodLabel(l.method),
            amount: netD.toNumber(),
            reference: l.paymentRef.trim() || null,
          };
        })
        .filter((l) => l.amount > 0)
    : undefined;
  return {
    effectiveMethodCode,
    method: paymentMethodLabel(effectiveMethodCode),
    total: round2(effectiveTotalD).toNumber(),
    received: round2(finalReceivedD).toNumber(),
    change: round2(finalChangeD).toNumber(),
    credit: round2(finalCreditD).toNumber(),
    paymentLegs,
  };
}

export function validatePosSaleBeforeSubmit(params: {
  activeTab: POSTab;
  cart: CartItem[];
  codMode: boolean;
  isSplitPayment: boolean;
  splitInvalidLeg: boolean;
  splitNonCashOverpay: boolean;
  externalPaymentConfirmed: boolean;
  isCredit: boolean;
}): string | null {
  const { activeTab, cart, codMode, isSplitPayment, splitInvalidLeg, splitNonCashOverpay, externalPaymentConfirmed, isCredit } = params;
  if (isSplitPayment) {
    if (cart.some((c) => c.digital)) return "تقسيم الدفع غير متاح لفاتورة تحتوي بطاقات رقمية.";
    if (splitInvalidLeg) return "أدخل مبلغاً موجباً لكل دفعة من الدفعات المقسّمة.";
    if (splitNonCashOverpay) return "مجموع الدفعات غير النقدية لا يمكن أن يتجاوز إجمالي الفاتورة.";
    if (!externalPaymentConfirmed) return "أكمل مرجع العملية وثبّت نجاح كل دفعة غير نقدية لدى المزوّد قبل إتمام البيع.";
  } else if (activeTab.method !== "CASH" && !externalPaymentConfirmed) {
    return "أدخل مرجع العملية وثبّت نجاح الدفع لدى المزوّد قبل إتمام البيع.";
  }
  if (!codMode && !isSplitPayment && activeTab.payInput.trim() !== "" && D(activeTab.payInput).eq(0) && activeTab.customerId == null) {
    return "أدخل المبلغ المقبوض، أو امسح الحقل للدفع النقدي الكامل. للبيع الآجل اختر عميلاً أولاً.";
  }
  if (!isSplitPayment && activeTab.payInput.trim() !== "" && D(activeTab.payInput).lt(0)) {
    return "المبلغ المقبوض لا يكون سالباً — صحّح المبلغ أو امسح الحقل للدفع الكامل.";
  }
  if (!codMode && isCredit && activeTab.customerId == null) {
    return "البيع الآجل يتطلّب اختيار عميل.";
  }
  return null;
}

export interface CustomerCreditLimitCheckParams {
  selectedCustomer:
    | { creditLimit?: string | number | null; currentBalance?: string | number | null;
      } | null | undefined;
  isCredit: boolean;
  creditAmount: number;
}

/**
 * فحص سقف الائتمان قبل إرسال البيع في نقطة البيع:
 * - حدّ ائتمان صفر (نقدي فقط): يطلب موافقة مدير فوراً
 * - تجاوز سقف الائتمان (الرصيد السابق + هذا البيع > السقف): يطلب موافقة مدير فوراً
 * - سقف غير محدود (null) أو بيع ضمن السقف: يعيد null (مسموح)
 */
export function evaluatePosCreditPrompt({
  selectedCustomer,
  isCredit,
  creditAmount,
}: CustomerCreditLimitCheckParams): string | null {
  if (!isCredit || !selectedCustomer || selectedCustomer.creditLimit == null) return null;
  const limit = Number(selectedCustomer.creditLimit);
  const balance = Number(selectedCustomer.currentBalance ?? 0);
  if (limit === 0) {
    return balance > 0
      ? `هذا العميل نقديٌّ فقط (حدّ ائتمانه صفر) وعليه رصيد سابق (${balance.toFixed(2)}) — لا يمكن البيع بالآجل دون موافقة مدير`
      : "هذا العميل نقديٌّ فقط (حدّ ائتمانه صفر) — لا يمكن البيع بالآجل دون موافقة مدير";
  }
  const projected = balance + creditAmount;
  if (projected > limit) {
    const available = limit - balance;
    return `تجاوز حدّ الائتمان: على العميل ${balance.toFixed(2)} وهذا البيع يضيف ${creditAmount.toFixed(2)}، وسقفه ${limit.toFixed(2)} — المتاح ${available <= 0 ? "0.00" : available.toFixed(2)} — لا يمكن البيع بالآجل دون موافقة مدير`;
  }
  return null;
}
