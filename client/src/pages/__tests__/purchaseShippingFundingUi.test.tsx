import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  calcPurchaseLandedCost,
  PurchaseShippingCard,
} from "@/components/purchases/PurchaseShippingCard";
import { purchaseShippingAdjustmentLabel } from "@/components/purchases/purchaseGovernanceUiPolicy";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

function card(source?: "ACCRUAL" | "DRAWER", shippingCost = "2000.00", paymentRecorded = false) {
  const landed = calcPurchaseLandedCost({
    shippingCost,
    customsCost: "0",
    docSubtotal: "1000",
    docGrossSubtotal: "1000",
    currency: "IQD",
    agreedRate: "1",
    items: [],
    taxEnabled: false,
  });
  return renderToStaticMarkup(
    <PurchaseShippingCard
      shippingCost={shippingCost}
      customsCost="0"
      onShippingCostChange={() => undefined}
      onCustomsCostChange={() => undefined}
      landed={landed}
      shippingFundingSource={source}
      paymentRecorded={paymentRecorded}
      onShippingFundingSourceChange={() => undefined}
    />,
  );
}

describe("purchase shipping declaration display contract", () => {
  it("defaults to paid shipping recorded immediately in the creator drawer", () => {
    const html = card();
    expect(html).toContain('role="combobox"');
    expect(html).toContain("فور حفظ الفاتورة من درج ورديتك المفتوحة");
    expect(html).toContain("حتى بعد إغلاق الوردية");
  });
  it("keeps an explicit unpaid option without debiting cash", () => {
    const html = card("ACCRUAL");
    expect(html).toContain("إدخال تكلفة الشحن لا يعني دفعها");
    expect(html).not.toContain("فور حفظ الفاتورة من درج ورديتك المفتوحة");
  });
  it("offers no cash declaration when no shipping or customs charge exists", () => {
    expect(card("ACCRUAL", "0")).not.toContain('role="combobox"');
  });
  it("locks the paid amount and source instead of permitting edits to recorded cash", () => {
    const html = card("DRAWER", "2000.00", true);
    expect(html).toContain("مبلغ الدفع ومصدره ثابتان");
    expect(html).toContain('disabled=""');
  });
  it("distinguishes refund and correction states from an unpaid shipping bill", () => {
    expect(purchaseShippingAdjustmentLabel("REFUND_PENDING")).toContain("استرداد");
    expect(purchaseShippingAdjustmentLabel("REFUNDED")).toContain("تم استرداد");
    expect(purchaseShippingAdjustmentLabel("RECOGNITION_REVERSED")).toContain("معكوس");
    expect(purchaseShippingAdjustmentLabel("PAID")).toBeNull();
  });
});
