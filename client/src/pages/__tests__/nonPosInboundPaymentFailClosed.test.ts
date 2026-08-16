import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  INBOUND_ENABLED_PAYMENT_METHODS,
  INBOUND_TELECOM_DISABLED_MESSAGE,
  inboundPaymentRejectionMessage,
  isInboundPaymentMethodEnabled,
} from "@shared/inboundPaymentPolicy";

const readPage = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

describe("سياسة القبض خارج نقاط البيع", () => {
  it("مصدر حقيقة واحد: المدعوم مسموح والمجهول مرفوض", () => {
    for (const method of INBOUND_ENABLED_PAYMENT_METHODS) {
      expect(isInboundPaymentMethodEnabled(method)).toBe(true);
    }
    expect(isInboundPaymentMethodEnabled("TELECOM")).toBe(false);
    expect(isInboundPaymentMethodEnabled("FUTURE_PROVIDER")).toBe(false);
    expect(isInboundPaymentMethodEnabled(null)).toBe(false);
    expect(inboundPaymentRejectionMessage("TELECOM")).toBe(INBOUND_TELECOM_DISABLED_MESSAGE);
  });

  it("سند القبض يعرض الطرق المدعومة كلّها بلا قائمة موازية مُقفلة", () => {
    const source = readPage("_VoucherFormShared.tsx");
    expect(source).toContain("disabled={!isInboundPaymentMethodEnabled(m.value)}");
    expect(source).not.toContain("CASH_METHODS");
    expect(source).not.toContain('if (isReceipt && method !== "CASH")');
  });

  it("تحصيل القسط يجمع مرجع العملية وآخر ٤ من البطاقة ويُمرّرهما", () => {
    const source = readPage("InstallmentPlans.tsx");
    expect(source).not.toContain('const method = "CASH" as const');
    expect(source).toContain("isInboundPaymentMethodEnabled");
    expect(source).toContain("referenceNumber: method === \"CASH\" ? undefined : reference.trim()");
    expect(source).toContain("cardLastFour: method === \"CARD\" ? cardLastFour : undefined");
  });

  it("سحب المحفظة بالتحويل يجمع مرجع الحوالة ويُمرّره (لا UUID داخليّ)", () => {
    const source = readFileSync(new URL("../digitalCards/WalletOpsDialogs.tsx", import.meta.url), "utf8");
    expect(source).not.toContain('mode === "withdraw" && method !== "CASH"');
    expect(source).toContain("referenceNumber: reference.trim()");
    expect(source).toContain('id="wm-reference"');
  });
});
