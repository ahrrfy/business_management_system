import { D, roundCashIQD } from "@/lib/money";
import { paymentMethodLabel } from "@/lib/paymentMethod";
import { type PosPaymentLegDraft, type Receipt } from "@/components/pos/posShared";
import { isSplitLegExternalConfirmed, parsePosLegAmountD } from "@/components/pos/posTotals";
import type { PaymentMethod } from "./PrintPosCheckout";
import type { PrintCartLine as CartLine } from "@/components/printPos/PrintCartList";

export function computePrintPosSplitMetrics(params: {
  splitMode?: boolean;
  splitLegs?: PosPaymentLegDraft[];
  editingInvoice: unknown;
  total: number;
  extraAmount?: string;
  chargeOnly?:boolean;
}) {
  const splitLegs = params.splitLegs ?? [];
  const isSplitPayment = Boolean(params.splitMode && splitLegs.length > 0 && !params.editingInvoice);
  const splitTotalPaidD = isSplitPayment
    ? splitLegs.reduce((sum, l) => sum.plus(parsePosLegAmountD(l.amount)), D(0))
    : D(0);
  const splitNonCashPaidD = isSplitPayment
    ? splitLegs.reduce((sum, l) =>
          l.method === "CASH" ? sum : sum.plus(parsePosLegAmountD(l.amount)), D(0))
    : D(0);
  const splitHasCash = isSplitPayment && splitLegs.some((l) => l.method === "CASH");
  const splitNonCashOverpay =
    isSplitPayment &&
    (splitNonCashPaidD.gt(D(params.chargeOnly?params.extraAmount??0:params.total)) || (!splitHasCash && splitTotalPaidD.gt(D(params.chargeOnly?params.extraAmount??0:params.total))));
  const splitLegsValid =
    isSplitPayment &&
    splitLegs.length >= 2 &&
    !splitNonCashOverpay &&
    splitLegs.every((l, index) => parsePosLegAmountD(l.amount).gt(0) && isSplitLegExternalConfirmed(l,
          index === 0&&!params.chargeOnly ? D(params.extraAmount ?? 0) : D(0),
        ));
  return {
    splitLegs,
    isSplitPayment,
    splitTotalPaidD,
    splitNonCashPaidD,
    splitHasCash,
    splitNonCashOverpay,
    splitLegsValid,
  };
}

export function buildInitialPrintSplitLegs(params: {
  payInput: string;
  total: number;
  method: PaymentMethod;
  paymentRef?: string;
}): PosPaymentLegDraft[] {
  const currentEntered = Number(params.payInput || 0);
  const firstAmt =
    currentEntered > 0 && currentEntered < params.total
      ? String(currentEntered)
      : params.total > 0
        ? String(Math.floor(params.total / 2))
        : "";
  const secondAmt = Math.max(0, params.total - Number(firstAmt || 0));
  const firstMethod: PaymentMethod = params.method;
  const secondMethod: PaymentMethod = firstMethod === "CASH" ? "CARD" : "CASH";
  return [
    {
      id: crypto.randomUUID(),
      method: firstMethod,
      amount: firstAmt,
      paymentRef: params.paymentRef ?? "",
      externalPayment: null,
    },
    {
      id: crypto.randomUUID(),
      method: secondMethod,
      amount: secondAmt > 0 ? String(secondAmt) : "",
      paymentRef: "",
      externalPayment: null,
    },
  ];
}

export function appendPrintSplitLeg(
  existing: PosPaymentLegDraft[],
  total: number,
  currentSplitTotalPaid: number,
): PosPaymentLegDraft[] {
  if (existing.length >= 4) return existing;
  const usedMethods = new Set(existing.map((l) => l.method));
  const nextMethod: PaymentMethod = !usedMethods.has("CASH")
    ? "CASH"
    : !usedMethods.has("CARD")
      ? "CARD"
      : !usedMethods.has("TRANSFER")
        ? "TRANSFER"
        : "WALLET";
  const rem = Math.max(0, total - currentSplitTotalPaid);
  return [
    ...existing,
    {
      id: crypto.randomUUID(),
      method: nextMethod,
      amount: rem > 0 ? String(rem) : "",
      paymentRef: "",
      externalPayment: null,
    },
  ];
}

export function patchPrintSplitLeg(
  existing: PosPaymentLegDraft[],
  legId: string,
  legPatch: Partial<Pick<PosPaymentLegDraft, "method" | "amount" | "paymentRef">>,
  total: number,
): PosPaymentLegDraft[] {
  const idx = existing.findIndex((l) => l.id === legId);
  if (idx < 0) return existing;
  const next = existing.map((leg) => {
    if (leg.id !== legId) return leg;
    const invalidateExt =
      (legPatch.method !== undefined && legPatch.method !== leg.method) ||
      (legPatch.amount !== undefined && legPatch.amount !== leg.amount) ||
      (legPatch.paymentRef !== undefined && legPatch.paymentRef !== leg.paymentRef);
    return {
      ...leg,
      ...legPatch,
      ...(invalidateExt ? { externalPayment: null } : {}),
    };
  });
  if (
    next.length === 2 &&
    idx === 0 &&
    legPatch.amount !== undefined &&
    total > 0 &&
    next[1].externalPayment?.state !== "CONFIRMED"
  ) {
    const amt0 = Number(legPatch.amount);
    if (Number.isFinite(amt0) && amt0 >= 0 && amt0 <= total && legPatch.amount.trim() !== "") {
      const rem = Math.max(0, total - amt0);
      next[1] = {
        ...next[1],
        amount: rem > 0 ? String(rem) : "",
        externalPayment: null,
      };
    }
  }
  return next;
}

export function buildPrintSplitSubmitPayload(params: {
  cart: CartLine[];
  splitLegs: PosPaymentLegDraft[];
  total: number;
  isReservation: boolean;
  customerName?: string;
}) {
  const { cart, splitLegs, total, isReservation, customerName } = params;
  const splitTotalPaidD = splitLegs.reduce((sum, l) => sum.plus(parsePosLegAmountD(l.amount)), D(0));
  const splitNonCashPaidD = splitLegs.reduce(
    (sum, l) =>
      l.method === "CASH" ? sum : sum.plus(parsePosLegAmountD(l.amount)),
    D(0),
  );
  const paid = splitTotalPaidD.toNumber();
  const isCredit = !isReservation && paid < total;
  const splitMethods = new Set(splitLegs.map((l) => l.method));
  const effectiveMethod: PaymentMethod | "MIXED" =
    splitMethods.size > 1 ? "MIXED" : ((splitLegs[0]?.method as PaymentMethod | undefined) ?? "CASH");
  const allCashSplit = splitLegs.every((l) => l.method === "CASH");
  const cashTotal = allCashSplit ? roundCashIQD(total).toNumber() : total;
  const cashFull = allCashSplit && !isCredit && !isReservation;
  const finalTotal = cashFull ? cashTotal : total;
  let nonCashRemD = splitNonCashPaidD.gt(D(finalTotal)) ? D(finalTotal) : splitNonCashPaidD;
  const cappedPaidD = splitTotalPaidD.gt(D(finalTotal)) ? D(finalTotal) : splitTotalPaidD;
  const cashDiffD = cappedPaidD.minus(nonCashRemD);
  let cashRemD = cashDiffD.gt(0) ? cashDiffD : D(0);
  const receiptLegs: Receipt["paymentLegs"] = splitLegs
    .map((l) => {
      const rawD = parsePosLegAmountD(l.amount);
      const netD =
        l.method === "CASH"
          ? rawD.gt(cashRemD)
            ? cashRemD
            : rawD
          : rawD.gt(nonCashRemD)
            ? nonCashRemD
            : rawD;
      if (l.method === "CASH") cashRemD = cashRemD.minus(netD);
      else nonCashRemD = nonCashRemD.minus(netD);
      return {
        method: paymentMethodLabel(l.method),
        amount: netD.toNumber(),
        reference: l.paymentRef.trim() || null,
      };
    })
    .filter((l) => l.amount > 0);
  const pendingSnapshot = {
    lines: cart.map((c) => ({
      name: c.svc.productName,
      unit: c.svc.unitName,
      qty: c.qty,
      price: c.price,
      total: c.price * c.qty,
    })),
    customerName,
    method: effectiveMethod,
    paymentLegs: receiptLegs,
    cashTotal: finalTotal,
    rawTotal: total,
    cashRounding: cashFull ? cashTotal - total : 0,
    received: isReservation || isCredit ? paid : finalTotal,
    change: isReservation || isCredit ? 0 : Math.max(0, paid - finalTotal),
    credit: isReservation || isCredit ? Math.max(0, total - paid) : 0,
    isCredit: Boolean(isCredit || isReservation),
  };
  const splitDeviceId = splitLegs.find((l) => l.method !== "CASH")?.externalPayment?.deviceId;
  const paymentsPayload = splitLegs.map((l) => ({
    amount: parsePosLegAmountD(l.amount).toFixed(2),
    method: l.method,
    ...(l.method !== "CASH"
      ? {
          reference: l.paymentRef.trim(),
          externalPaymentAttemptId: l.externalPayment!.attemptId!,
        }
      : {}),
  }));
  return {
    isCredit,
    cashFull,
    pendingSnapshot,
    splitDeviceId,
    paymentsPayload,
  };
}
