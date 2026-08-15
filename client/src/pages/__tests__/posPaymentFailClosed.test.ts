import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  POS_EXTERNAL_PAYMENT_DISABLED_MESSAGE,
  POS_EXTERNAL_PAYMENT_METHODS,
  isPosPaymentMethodEnabled,
} from "@shared/posPaymentPolicy";

const readPage = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

describe("POS external payment fail-closed UX contract", () => {
  it("enables CASH only, including unknown future methods", () => {
    expect(isPosPaymentMethodEnabled("CASH")).toBe(true);
    for (const method of POS_EXTERNAL_PAYMENT_METHODS) {
      expect(isPosPaymentMethodEnabled(method)).toBe(false);
    }
    expect(isPosPaymentMethodEnabled("FUTURE_PROVIDER")).toBe(false);
    expect(isPosPaymentMethodEnabled(null)).toBe(false);
  });

  it("disables POS external controls, explains why, and does not restore stale confirmation", () => {
    const source = readPage("POS.tsx");

    expect(source).toContain('id="pos-external-payment-disabled"');
    expect(source).toContain("POS_EXTERNAL_PAYMENT_DISABLED_MESSAGE");
    expect(source).toContain('disabled aria-describedby="pos-external-payment-disabled"');
    expect(source).toContain('method: "CASH"');
    expect(source).toContain('paymentRef: ""');
    expect(source).toContain("externalPayment: null");
    expect(source).not.toContain('onClick={() => setMethod("CARD")}');
    expect(POS_EXTERNAL_PAYMENT_DISABLED_MESSAGE).toMatch(/غير مفعّلة.*مزوّد.*تسوية موثوقين/);
  });

  it("disables PrintPOS external controls and clears stale external drafts", () => {
    const source = readPage("PrintPOS.tsx");

    expect(source).toContain('id="print-pos-external-payment-disabled"');
    expect(source).toContain("POS_EXTERNAL_PAYMENT_DISABLED_MESSAGE");
    expect(source).toContain('<Method m="CARD" Icon={CreditCard} label="بطاقة" disabled />');
    expect(source).toContain('<Method m="TRANSFER" Icon={RefreshCw} label="تحويل" disabled />');
    expect(source).toContain('method: "CASH"');
    expect(source).toContain('paymentRef: ""');
    expect(source).toContain("externalPayment: null");
  });

  it("offers CASH only when collecting a later invoice payment", () => {
    const source = readPage("InvoiceDetail.tsx");

    expect(source).toContain('const ENABLED_COLLECTION_METHODS = METHODS.filter((method) => method.v === "CASH")');
    expect(source).toContain("ENABLED_COLLECTION_METHODS.map");
    expect(source).toContain('if (payMethod !== "CASH") return setError(POS_EXTERNAL_PAYMENT_DISABLED_MESSAGE)');
    expect(source).toContain("{POS_EXTERNAL_PAYMENT_DISABLED_MESSAGE}");
  });
});
