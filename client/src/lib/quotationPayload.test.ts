import { describe, expect, it } from "vitest";
import { buildQuotationLinePayload } from "./quotationPayload";

const line = (
  price: string,
  referencePrice?: string,
  priceSource?: "TIER" | "CONTRACT" | "MANUAL" | null,
) => ({
  variantId: 1,
  productUnitId: 7,
  qty: 2,
  price,
  referencePrice,
  priceSource,
  discount: "0",
  discountType: "amount" as const,
});

describe("buildQuotationLinePayload", () => {
  it("لا يحوّل السعر الآلي المطابق لمرجعه إلى override", () => {
    const payload = buildQuotationLinePayload(line("80.0", "80.00", "CONTRACT"));
    expect(payload).not.toHaveProperty("unitPriceOverride");
  });

  it("لا يحوّل صفر placeholder لفئة مفقودة إلى تجاوز مجاني", () => {
    expect(buildQuotationLinePayload(line("0", "0", "TIER"))).not.toHaveProperty("unitPriceOverride");
  });

  it("يرسل السعر المختلف يدوياً كتجاوز صريح", () => {
    expect(buildQuotationLinePayload(line("90", "80.00", "CONTRACT"))).toMatchObject({
      unitPriceOverride: "90.00",
    });
  });

  it("يحافظ على وسم MANUAL حتى لو ساوى السعر المرجعي رقمياً", () => {
    expect(buildQuotationLinePayload(line("80", "80.00", "MANUAL"))).toMatchObject({
      unitPriceOverride: "80.00",
    });
  });

  it("يحافظ fail-safe على سعر سطر legacy بلا مرجع", () => {
    expect(buildQuotationLinePayload(line("75", "75.00", null))).toMatchObject({
      unitPriceOverride: "75.00",
    });
  });
});
