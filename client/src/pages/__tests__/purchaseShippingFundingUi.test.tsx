import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  calcPurchaseLandedCost,
  PurchaseShippingCard,
} from "@/components/purchases/PurchaseShippingCard";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

function card(source?: "ACCRUAL" | "DRAWER", shippingCost = "2000.00") {
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
      onShippingFundingSourceChange={() => undefined}
    />,
  );
}

describe("purchase shipping declaration display contract", () => {
  it("defaults to unpaid; entering a cost never claims a cash payment", () => {
    const html = card();
    expect(html).toContain('role="combobox"');
    expect(html).toContain("إدخال تكلفة الشحن لا يعني دفعها");
    expect(html).not.toContain("تصريح دفع صريح");
  });
  it("shows creator-drawer attribution and closure warning only for explicit paid declaration", () => {
    const html = card("DRAWER");
    expect(html).toContain("تصريح دفع صريح");
    expect(html).toContain("لا يخصم من وردية المعتمد ولا من الخزينة");
    expect(html).toContain("لا تغلق الوردية قبل توثيق المصروف");
  });
  it("offers no cash declaration when no shipping or customs charge exists", () => {
    expect(card("ACCRUAL", "0")).not.toContain('role="combobox"');
  });
});
