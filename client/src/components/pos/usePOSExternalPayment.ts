import { checkoutExtraTotal } from "@/components/pos/checkoutExtraAmounts";
import type { CartItem, POSTab, ShiftData } from "@/components/pos/posShared";
import { computeSplitLegFingerprint, parsePosLegAmountD } from "@/components/pos/posTotals";
import { newClientRequestId } from "@/lib/countQueue";
import { D } from "@/lib/money";
import { notify } from "@/lib/notify";
import { getDeviceCode } from "@/lib/offline/outbox";
import { trpc } from "@/lib/trpc";

interface UsePOSExternalPaymentOptions {
  branchId: number;
  shift: ShiftData | undefined;
  activeTab: POSTab;
  cart: CartItem[];
  cartHasDigital: boolean;
  isSplitPayment: boolean;
  total: number;
  deliveryFeeHeldD: ReturnType<typeof D>;
  externalPaymentAmount: string;
  externalPaymentFingerprint: string;
  patchTab: (tabId: number, patch: Partial<POSTab>) => void;
  patchLegExternalPayment: (
    tabId: number,
    legId: string,
    next: NonNullable<POSTab["externalPayment"]>,
  ) => void;
  setConfirmingLegId: (legId: string | null) => void;
  startDigitalFulfillment: (cardOverride?: {
    reference: string;
    requestId: string;
    deviceId: string;
  }) => Promise<void>;
}

/** Coordinates non-cash external terminal/transfer payment initiation and verification for POS tabs/legs. */
export function usePOSExternalPayment(options: UsePOSExternalPaymentOptions) {
  const {
    branchId,
    shift,
    activeTab,
    cart,
    cartHasDigital,
    isSplitPayment,
    total,
    deliveryFeeHeldD,
    externalPaymentAmount,
    externalPaymentFingerprint,
    patchTab,
    patchLegExternalPayment,
    setConfirmingLegId,
    startDigitalFulfillment,
  } = options;

  const initiateExternalPayment = trpc.sales.initiateExternalPayment.useMutation();
  const confirmExternalPaymentMutation = trpc.sales.confirmExternalPayment.useMutation();

  async function confirmCurrentExternalPayment(legId?: string) {
    const leg = legId ? (activeTab.paymentLegs ?? []).find((l) => l.id === legId) : null;
    const method = leg ? leg.method : activeTab.method;
    if (
      !shift ||
      (!cart.length && !checkoutExtraTotal(activeTab.extraCharges).gt(0)) ||
      (legId && !leg) ||
      method === "CASH"
    ) {
      return;
    }
    if (cartHasDigital && method !== "CARD") {
      notify.err("البيع الرقمي نقداً أو ببطاقة فقط.");
      return;
    }
    const tabId = activeTab.id;
    const reference = (leg ? leg.paymentRef : (activeTab.paymentRef ?? "")).trim();
    if (!reference) {
      notify.err("أدخل مرجع الدفع الخارجي أولاً.");
      return;
    }
    if (
      leg
        ? parsePosLegAmountD(leg.amount).lte(0)
        : activeTab.payInput.trim() !== "" && D(activeTab.payInput).lte(0)
    ) {
      notify.err("مبلغ الدفع يجب أن يكون موجباً قبل تأكيد العملية الخارجية.");
      return;
    }
    const feeForLeg =
      leg && cart.length > 0 && activeTab.paymentLegs?.[0]?.id === leg.id
        ? deliveryFeeHeldD.plus(checkoutExtraTotal(activeTab.extraCharges))
        : D(0);
    const amountStr = leg ? parsePosLegAmountD(leg.amount).plus(feeForLeg).toFixed(2) : externalPaymentAmount;
    const fingerprint = leg ? computeSplitLegFingerprint(leg, feeForLeg) : externalPaymentFingerprint;
    const curExt = leg ? leg.externalPayment : activeTab.externalPayment;
    const prior = curExt?.fingerprint === fingerprint ? curExt : null;
    const requestId = cartHasDigital
      ? `${activeTab.clientRequestId}:card`
      : (prior?.requestId ?? newClientRequestId());
    let deviceId = prior?.deviceId;
    if (!deviceId) {
      try {
        deviceId = await getDeviceCode();
      } catch {
        notify.err("تعذّر تحديد جهاز الكاشير — لا يمكن تأكيد دفع خارجي بلا هوية جهاز.");
        return;
      }
    }
    if (cartHasDigital) {
      if (
        legId ||
        isSplitPayment ||
        activeTab.couponCode ||
        checkoutExtraTotal(activeTab.extraCharges).gt(0) ||
        !D(amountStr).eq(total)
      ) {
        notify.err("قبض البطاقة الرقمية يتطلب كامل المبلغ دون دفعات مقسمة أو إضافات");
        return;
      }
      await startDigitalFulfillment({ reference, requestId: `${activeTab.clientRequestId}:card`, deviceId });
      return;
    }
    const writeExt = (state: "INITIATED" | "CONFIRMED", attemptId: number | null) => {
      const nextExt = { attemptId, requestId, fingerprint, state, deviceId: deviceId! };
      if (legId) patchLegExternalPayment(tabId, legId, nextExt);
      else patchTab(tabId, { externalPayment: nextExt });
    };
    if (legId) setConfirmingLegId(legId);
    writeExt(prior?.state ?? "INITIATED", prior?.attemptId ?? null);
    try {
      let attemptId = prior?.attemptId ?? null;
      if (!attemptId) {
        const initiated = await initiateExternalPayment.mutateAsync({
          branchId,
          method,
          amount: amountStr,
          reference,
          requestId,
          deviceId,
        });
        attemptId = initiated.attemptId;
        writeExt("INITIATED", attemptId);
      }
      await confirmExternalPaymentMutation.mutateAsync({ branchId, attemptId, deviceId });
      writeExt("CONFIRMED", attemptId);
      notify.ok("تأكّد الدفع الخارجي", `ثُبّت المرجع ${reference} وأصبح جاهزاً للاستهلاك مرةً واحدة.`);
    } catch (error) {
      notify.err(error instanceof Error ? error.message : "تعذّر تثبيت تأكيد الدفع الخارجي");
    } finally {
      if (legId) setConfirmingLegId(null);
    }
  }

  return {
    confirmCurrentExternalPayment,
    externalPaymentPending: initiateExternalPayment.isPending || confirmExternalPaymentMutation.isPending,
  };
}
