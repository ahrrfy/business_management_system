import { describe, expect, it } from "vitest";
import {
  INBOUND_NON_CASH_PAYMENT_METHODS,
  INBOUND_PAYMENT_DISABLED_MESSAGE,
  isInboundPaymentMethodEnabled,
} from "@shared/inboundPaymentPolicy";
import { assertInboundPaymentMethodEnabled } from "../inboundPaymentPolicy";
import { createVoucherTx } from "../voucher/create";
import { payLine } from "../installment/payment";
import { withdraw } from "../digitalCards/walletOpsService";

const ACTORS = ["admin", "manager", "accountant", "cashier"] as const;
const PARTIES = ["CUSTOMER", "SUPPLIER", "OTHER"] as const;

describe("general inbound payment policy", () => {
  it("enables CASH only and rejects future unknown methods", () => {
    expect(isInboundPaymentMethodEnabled("CASH")).toBe(true);
    for (const method of INBOUND_NON_CASH_PAYMENT_METHODS) {
      expect(isInboundPaymentMethodEnabled(method)).toBe(false);
    }
    expect(isInboundPaymentMethodEnabled("FUTURE_PROVIDER")).toBe(false);
    expect(isInboundPaymentMethodEnabled(null)).toBe(false);
    expect(() => assertInboundPaymentMethodEnabled("CASH")).not.toThrow();
    expect(() => assertInboundPaymentMethodEnabled("FUTURE_PROVIDER")).toThrow(INBOUND_PAYMENT_DISABLED_MESSAGE);
  });

  it.each(ACTORS)("rejects every user-entered non-cash voucher receipt for %s before touching tx", async (role) => {
    for (const partyType of PARTIES) {
      for (const paymentMethod of INBOUND_NON_CASH_PAYMENT_METHODS) {
        await expect(createVoucherTx({} as never, {
          voucherType: "RECEIPT",
          branchId: 1,
          amount: "100.00",
          paymentMethod: paymentMethod as never,
          partyType,
          partyId: partyType === "OTHER" ? null : 1,
          counterpartyName: partyType === "OTHER" ? "طرف اختباري" : null,
          description: "قبض غير نقدي غير موثّق",
          clientRequestId: `svc-${role}-${partyType}-${paymentMethod}`,
        }, { userId: 1, branchId: 1, role })).rejects.toThrow(INBOUND_PAYMENT_DISABLED_MESSAGE);
      }
    }
  });

  it.each(ACTORS)("rejects every non-cash installment collection for %s before DB lookup", async (role) => {
    for (const paymentMethod of INBOUND_NON_CASH_PAYMENT_METHODS) {
      await expect(payLine(
        { lineId: 999, paymentMethod: paymentMethod as never },
        { userId: 1, branchId: 1, role },
      )).rejects.toThrow(INBOUND_PAYMENT_DISABLED_MESSAGE);
    }
  });

  it.each(ACTORS)("rejects non-cash wallet withdrawal for %s before touching tx", async (role) => {
    await expect(withdraw({} as never, {
      walletId: 999,
      amount: "100.00",
      paymentMethod: "TRANSFER",
      clientRequestId: `wallet-${role}`,
    }, { userId: 1, branchId: 1, role })).rejects.toThrow(INBOUND_PAYMENT_DISABLED_MESSAGE);
  });
});
