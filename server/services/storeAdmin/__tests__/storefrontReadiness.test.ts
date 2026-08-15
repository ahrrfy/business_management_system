import { describe, expect, it } from "vitest";
import { evaluateStorefrontProductEligibility } from "../../storefrontEligibilityService";

const unit = (over: Partial<{
  isActive: boolean;
  isStoreSaleUnit: boolean;
  retailPrice: string | null;
  conversionFactor: string;
  stockBase: number | null;
}> = {}) => ({
  isActive: true,
  isStoreSaleUnit: true,
  retailPrice: "1000.00",
  conversionFactor: "1",
  stockBase: 10,
  ...over,
});

const product = (units: ReturnType<typeof unit>[]) => ({
  isActive: true,
  isService: false,
  showInStore: true,
  variants: [{ isActive: true, units }],
});

describe("storefront eligibility contract", () => {
  it("يفصل المنشور عن المتاح عندما يكون الرصيد أقل من معامل وحدة البيع", () => {
    expect(evaluateStorefrontProductEligibility(product([
      unit({ conversionFactor: "12", stockBase: 1 }),
    ]))).toEqual({
      publishable: true,
      available: false,
      reasons: ["BELOW_SALE_UNIT_FACTOR"],
    });
  });

  it("نجاح وحدة واحدة يكفي لتوفّر المنتج ولا تلوّثه أسباب الوحدات النافدة", () => {
    expect(evaluateStorefrontProductEligibility(product([
      unit({ stockBase: 0 }),
      unit({ conversionFactor: "12", stockBase: 24 }),
    ]))).toEqual({ publishable: true, available: true, reasons: [] });
  });

  it("يفسّر حواجز النشر قبل المخزون", () => {
    expect(evaluateStorefrontProductEligibility({
      ...product([unit({ retailPrice: null, stockBase: null })]),
      showInStore: false,
    })).toEqual({
      publishable: false,
      available: false,
      reasons: ["PRODUCT_HIDDEN"],
    });
    expect(evaluateStorefrontProductEligibility(product([
      unit({ retailPrice: null, stockBase: 100 }),
    ])).reasons).toEqual(["NO_RETAIL_PRICE"]);
  });
});
