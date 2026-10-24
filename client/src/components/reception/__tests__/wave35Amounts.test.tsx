// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import {
  useReceptionAmounts,
  type ReceptionAmountsInput,
} from "../ReceptionAmounts";
import {
  buildReceptionCheckoutPayload,
  type ReceptionCheckoutPayloadInput,
} from "../ReceptionCheckoutPayload";
import { D } from "@/lib/money";
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });

function amounts(
  price: string,
  paid: string,
  extra: Partial<ReceptionAmountsInput> = {},
) {
  const host = document.createElement("div");
  const root = createRoot(host);
  let result!: ReturnType<typeof useReceptionAmounts>;
  const input = {
    cart: [
      {
        key: "goods",
        qty: 1,
        row: {
          variantId: 1,
          productUnitId: 2,
          price,
          isService: false,
          isPrintService: false,
        },
      },
    ],
    orderDelivery: null,
    activeDraft: null,
    offline: false,
    invoiceDiscountPct: "",
    draftHeld: "0",
    method: "CARD",
    splitPayment: { hasCash: true, hasNonCash: false },
    payInput: paid,
    customer: { customerId: 7 },
    phoneResolution: "RESOLVED",
    deferred: false,
    setDeferred: vi.fn(),
    ...extra,
  } as ReceptionAmountsInput;
  function Harness() {
    result = useReceptionAmounts(input);
    return null;
  }
  act(() => root.render(<Harness />));
  act(() => root.unmount());
  return result;
}

describe("reception split amounts and wire", () => {
  it.each([
    ["7400", "7450", false, 7400, 50],
    ["7400", "7500", true, 7500, 0],
    ["7340", "7250", true, 7250, 0],
  ])(
    "applies cash rounding only when the rounded balance is covered (%s/%s)",
    (price, paid, rounded, expected, change) => {
      const value = amounts(price, paid);
      expect(value.cashRoundActive).toBe(rounded);
      expect(value.expectedNow).toBe(expected);
      expect(value.change).toBe(change);
    },
  );
  it("keeps mixed rails and deferred partial payment at original prices", () => {
    expect(
      amounts("7400", "7500", {
        splitPayment: { hasCash: true, hasNonCash: true },
      }).expectedNow,
    ).toBe(7400);
    const partial = amounts("7400", "4000", { deferred: true });
    expect(partial.cashRoundActive).toBe(false);
    expect(partial.remaining).toBe(3400);
  });
  it("subtracts existing deposits once and separates the delivery fee", () => {
    const value = amounts("10000", "7000", {
      activeDraft: { id: 8, version: 1 },
      draftHeld: "3000",
      orderDelivery: { fee: "5000", feeCollection: "COUNTER" } as any,
      splitPayment: { hasCash: true, hasNonCash: true },
    });
    expect(value.expectedNow).toBe(7000);
    expect(value.heldDelivery).toBe(5000);
    expect(value.change).toBe(0);
  });
  it("sends raw legs plus the applied echo, without legacy scalar payment fields or fee duplication", () => {
    const legs = [
      { amount: "5000.00", method: "CASH" as const },
      {
        amount: "3000.00",
        method: "CARD" as const,
        externalPaymentAttemptId: 11,
        externalPaymentDeviceId: "terminal",
      },
    ];
    const fee = {
      method: "CARD",
      externalPaymentAttemptId: 12,
      externalPaymentDeviceId: "terminal",
    };
    const input = {
      payments: legs,
      heldDelivery: "5000",
      deliveryFeeTender: fee,
      branchId: 1,
      cashRoundActive: false,
      effectiveGrandD: D(7000),
      regularSumRawD: D(7000),
      invoiceDiscountAmountD: D(0),
      mixedRoundApplied: false,
      mixedCarrier: null,
      mixedDeltaAppliedD: D(0),
      printLines: [],
      customWithDeposits: [],
      method: "CARD",
      paymentReference: "old-reference",
      channel: "WALK_IN",
      channelHandle: "",
      receptionPhone: "",
      regularLines: [],
      orderDelivery: null,
      hasGrandShortfall: false,
      isReserve: false,
      hasDirectShortfall: false,
      deferred: false,
      customer: { customerId: 7 },
      shift: { id: 4 },
      customerId: 7,
      customerName: null,
      receiptPhone: "",
      appliedPaidD: D(7000),
      orderFeeHeldD: D(5000),
      routeDeliveryToWO: false,
      opts: { quickFullPay: false },
      mgrCredsRef: { current: null },
      reqIdRef: { current: "request" },
      effectiveTier: "RETAIL",
      couponCode: null,
    } as unknown as ReceptionCheckoutPayloadInput;
    const payload = buildReceptionCheckoutPayload(input).directCheckoutPayload;
    expect(payload.payments).toBe(legs);
    expect(payload.paidAmount).toBe("7000.00");
    expect(payload.paymentMethod).toBeUndefined();
    expect(payload.paymentReference).toBeUndefined();
    expect(payload.deliveryFeeHeld).toBe("5000");
    expect(payload.deliveryFeeTender).toBe(fee);
  });
});
