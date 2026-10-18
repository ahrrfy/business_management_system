import React from "react";
import { Router } from "wouter";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  calcPurchaseLandedCost,
  PurchaseShippingCard,
} from "@/components/purchases/PurchaseShippingCard";
import { purchaseShippingAdjustmentLabel } from "@/components/purchases/purchaseGovernanceUiPolicy";
import { PurchaseShippingRefund } from "@/components/purchases/PurchaseShippingRefund";

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
  it("shows the refund as a separate inbound voucher and receiving drawer", () => {
    const html = renderToStaticMarkup(<Router ssrPath="/purchases/1"><PurchaseShippingRefund refund={{ receiptId: 15, voucherNumber: "RV-15",
      amount: "2000.00", cashBucket: "DRAWER", shiftId: 91, occurredAt: "2026-10-18T12:00:00Z" }} /></Router>);
    expect(html).toContain("استرداد فعلي للشحن");
    expect(html).toContain("إلى درج الوردية #91");
    expect(html).toContain("سند قبض الاسترداد: RV-15");
  });
});
