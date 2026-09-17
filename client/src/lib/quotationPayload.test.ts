import { describe, expect, it } from "vitest";
import { buildQuotationLinePayload } from "./quotationPayload";

const line = (price: string, referencePrice?: string) => ({
  variantId: 1,
  productUnitId: 7,
  qty: 2,
  price,
  referencePrice,
  discount: "0",
  discountType: "amount" as const,
});

describe("buildQuotationLinePayload", () => {
  it("لا يحوّل السعر الآلي المطابق لمرجعه إلى override", () => {
    const payload = buildQuotationLinePayload(line("80.0", "80.00"));
    expect(payload).not.toHaveProperty("unitPriceOverride");
  });

  it("يرسل السعر المختلف يدوياً كتجاوز صريح", () => {
    expect(buildQuotationLinePayload(line("90", "80.00"))).toMatchObject({
      unitPriceOverride: "90.00",
    });
  });

  it("يحافظ fail-safe على سعر سطر legacy بلا مرجع", () => {
    expect(buildQuotationLinePayload(line("75"))).toMatchObject({
      unitPriceOverride: "75.00",
    });
  });
});
