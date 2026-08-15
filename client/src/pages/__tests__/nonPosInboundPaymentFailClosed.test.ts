import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  INBOUND_NON_CASH_PAYMENT_METHODS,
  INBOUND_PAYMENT_DISABLED_MESSAGE,
  isInboundPaymentMethodEnabled,
} from "@shared/inboundPaymentPolicy";

const readPage = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

describe("non-POS inbound payment fail-closed UX", () => {
  it("shares the CASH-only policy with the server", () => {
    expect(isInboundPaymentMethodEnabled("CASH")).toBe(true);
    for (const method of INBOUND_NON_CASH_PAYMENT_METHODS) {
      expect(isInboundPaymentMethodEnabled(method)).toBe(false);
    }
    expect(INBOUND_PAYMENT_DISABLED_MESSAGE).toMatch(/إثبات مستقل.*تسوية مصرفية موثوقة/);
  });

  it("offers CASH only for voucher receipts while preserving payment-out methods", () => {
    const source = readPage("_VoucherFormShared.tsx");
    expect(source).toContain("isReceipt ? CASH_METHODS : METHODS");
    expect(source).toContain('id="voucher-inbound-payment-policy"');
    expect(source).toContain("INBOUND_PAYMENT_DISABLED_MESSAGE");
    expect(source).toContain('if (isReceipt && method !== "CASH")');
  });

  it("locks installment collection to CASH and explains the trusted-evidence requirement", () => {
    const source = readPage("InstallmentPlans.tsx");
    expect(source).toContain('const method = "CASH" as const');
    expect(source).toContain('aria-describedby="installment-inbound-payment-policy"');
    expect(source).not.toContain('<option value="WALLET">محفظة</option>');
    expect(source).toContain("INBOUND_PAYMENT_DISABLED_MESSAGE");
    expect(source).toContain('l.receiptPaymentMethod === "CHECK"');
    expect(source).toContain("وسيُحصّل الآن نقداً");
  });

  it("removes TRANSFER from wallet withdrawal but preserves it for deposits", () => {
    const source = readFileSync(new URL("../digitalCards/WalletOpsDialogs.tsx", import.meta.url), "utf8");
    expect(source).toContain('{isDep && <option value="TRANSFER">تحويل بنكي</option>}');
    expect(source).toContain('if (mode === "withdraw") setMethod("CASH")');
    expect(source).toContain('mode === "withdraw" && method !== "CASH"');
    expect(source).toContain('id="wallet-withdraw-inbound-payment-policy"');
  });
});
