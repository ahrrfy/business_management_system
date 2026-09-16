import { describe, expect, it } from "vitest";
import { createInitialState, invoiceReducer } from "../reducer";
import type { InvoiceLine } from "../types";

function line(productUnitId: number, price: string): InvoiceLine {
  return {
    productId: productUnitId,
    variantId: productUnitId,
    productUnitId,
    name: `item-${productUnitId}`,
    sku: `sku-${productUnitId}`,
    barcode: null,
    unit: "قطعة",
    qty: 1,
    conversionFactor: "1",
    stockBase: 10,
    price,
    costBase: "0",
    discount: "5",
    discountType: "percent",
    note: "",
  };
}

describe("invoiceReducer tier repricing", () => {
  it("changes the tier and all returned unit prices atomically", () => {
    const state = {
      ...createInitialState("SALE"),
      items: [line(11, "1000.00"), line(22, "2000.00")],
    };

    const next = invoiceReducer(state, {
      type: "SET_TIER_PRICES",
      tier: "WHOLESALE",
      pricesByUnitId: { 11: "800.00", 22: "1500.00" },
    });

    expect(next.tier).toBe("WHOLESALE");
    expect(next.items.map((item) => item.price)).toEqual(["800.00", "1500.00"]);
    expect(next.items.map((item) => item.discount)).toEqual(["5", "5"]);
  });

  it("keeps a line unchanged when the server did not return its unit", () => {
    const state = {
      ...createInitialState("QUOTATION"),
      items: [line(11, "1000.00"), line(22, "2000.00")],
    };

    const next = invoiceReducer(state, {
      type: "SET_TIER_PRICES",
      tier: "GOVERNMENT",
      pricesByUnitId: { 11: "900.00" },
    });

    expect(next.items.map((item) => item.price)).toEqual(["900.00", "2000.00"]);
  });

  it("keeps repeated digital cards as independent fulfillment lines", () => {
    const digital = (lineKey: string): InvoiceLine => ({
      ...line(33, "5000.00"),
      discount: "0",
      digital: {
        offeringId: 7,
        providerId: 2,
        priceVersionId: 19,
        sellPriceSnapshot: "5000.00",
        lineKey,
        providerName: "المزوّد",
        offeringType: "TELECOM_CARD",
        providerReference: "TX-1",
        providerBasketKey: "basket-1",
        faceValue: "5000.00",
        subscriptionDurationDays: null,
        requiresStudentData: false,
      },
    });
    const state = createInitialState("SALE");

    const next = invoiceReducer(state, {
      type: "ADD_ITEMS",
      items: [digital("digital-1"), digital("digital-2")],
    });

    expect(next.items).toHaveLength(2);
    expect(next.items.map((item) => item.digital?.lineKey)).toEqual(["digital-1", "digital-2"]);
    expect(next.items.map((item) => item.qty)).toEqual([1, 1]);

    const repriced = invoiceReducer(next, {
      type: "SET_TIER_PRICES",
      tier: "WHOLESALE",
      pricesByUnitId: { 33: "1.00" },
    });
    expect(repriced.items.map((item) => item.price)).toEqual(["5000.00", "5000.00"]);
  });
});
