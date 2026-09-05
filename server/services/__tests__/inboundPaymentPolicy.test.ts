import { describe, expect, it } from "vitest";
import {
  INBOUND_ENABLED_PAYMENT_METHODS,
  INBOUND_PAYMENT_DISABLED_MESSAGE,
  INBOUND_TELECOM_DISABLED_MESSAGE,
  isInboundPaymentMethodEnabled,
} from "@shared/inboundPaymentPolicy";

/** المرفوض بنيوياً في منافذ القبض: رصيد زين (مساره شاشة البطاقات الرقمية) والقيم المجهولة. */
const REJECTED = ["TELECOM", "FUTURE_PROVIDER"] as const;
import { assertInboundPaymentMethodEnabled } from "../inboundPaymentPolicy";
import { createVoucherTx } from "../voucher/create";
import { payLine } from "../installment/payment";
import { withdraw } from "../digitalCards/walletOpsService";

const ACTORS = ["admin", "manager", "accountant", "cashier"] as const;
const PARTIES = ["CUSTOMER", "SUPPLIER", "OTHER"] as const;

describe("سياسة القبض العامّة", () => {
  it("تسمح بالطرق المدعومة وترفض المجهول ورصيد زين", () => {
    for (const method of INBOUND_ENABLED_PAYMENT_METHODS) {
      expect(isInboundPaymentMethodEnabled(method)).toBe(true);
      expect(() => assertInboundPaymentMethodEnabled(method)).not.toThrow();
    }
    expect(isInboundPaymentMethodEnabled("TELECOM")).toBe(false);
    expect(isInboundPaymentMethodEnabled("FUTURE_PROVIDER")).toBe(false);
    expect(isInboundPaymentMethodEnabled(null)).toBe(false);
    expect(() => assertInboundPaymentMethodEnabled("FUTURE_PROVIDER")).toThrow(INBOUND_PAYMENT_DISABLED_MESSAGE);
    expect(() => assertInboundPaymentMethodEnabled("TELECOM")).toThrow(INBOUND_TELECOM_DISABLED_MESSAGE);
  });

  it.each(ACTORS)("سند القبض بطريقةٍ غير مدعومة يُرفض قبل لمس المعاملة — %s", async (role) => {
    for (const partyType of PARTIES) {
      for (const paymentMethod of REJECTED) {
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
        }, { userId: 1, branchId: 1, role })).rejects.toThrow();
      }
    }
  });

  it.each(ACTORS)("تحصيل القسط بطريقةٍ غير مدعومة يُرفض قبل قراءة القاعدة — %s", async (role) => {
    for (const paymentMethod of REJECTED) {
      await expect(payLine(
        { lineId: 999, paymentMethod: paymentMethod as never, clientRequestId: crypto.randomUUID() },
        { userId: 1, branchId: 1, role },
      )).rejects.toThrow();
    }
  });

  it.each(ACTORS)("سحب المحفظة بطريقةٍ غير مدعومة يُرفض قبل لمس المعاملة — %s", async (role) => {
    await expect(withdraw({} as never, {
      walletId: 999,
      amount: "100.00",
      paymentMethod: "TELECOM" as never,
      clientRequestId: `wallet-${role}`,
    }, { userId: 1, branchId: 1, role })).rejects.toThrow(INBOUND_TELECOM_DISABLED_MESSAGE);
  });
});
