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

function digitalLine(token: string, studentName?: string): InvoiceLine {
  return {
    ...line(77, "100.00"),
    discount: "0",
    discountType: "amount",
    digital: {
      providerId: 5,
      offeringId: 9,
      priceVersionId: 42,
      sellPriceSnapshot: "100.00",
      providerShareSnapshot: "80.00",
      providerReference: "REF-ONE",
      providerBasketKey: "basket-1",
      student: studentName ? { studentName, studentPhone: "07701234567" } : undefined,
      internalLineToken: token,
    },
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
      pricesByUnitId: {
        11: { price: "800.00", priceSource: "TIER" },
        22: { price: "1500.00", priceSource: "CONTRACT" },
      },
    });

    expect(next.tier).toBe("WHOLESALE");
    expect(next.items.map((item) => item.price)).toEqual(["800.00", "1500.00"]);
    expect(next.items.map((item) => item.referencePrice)).toEqual(["800.00", "1500.00"]);
    expect(next.items.map((item) => item.priceSource)).toEqual(["TIER", "CONTRACT"]);
    expect(next.items.map((item) => item.discount)).toEqual(["5", "5"]);
  });

  it("changes the customer and effective contract prices atomically", () => {
    const state = {
      ...createInitialState("QUOTATION"),
      entityId: 3,
      items: [line(11, "1000.00"), line(22, "2000.00")],
    };

    const next = invoiceReducer(state, {
      type: "SET_ENTITY_PRICES",
      id: 9,
      pricesByUnitId: { 11: { price: "700.00", priceSource: "CONTRACT" } },
    });

    expect(next.entityId).toBe(9);
    expect(next.items.map((item) => item.price)).toEqual(["700.00", "2000.00"]);
    expect(next.items.map((item) => item.referencePrice)).toEqual(["700.00", undefined]);
    expect(next.items.map((item) => item.priceSource)).toEqual(["CONTRACT", undefined]);
  });

  it("keeps a line unchanged when the server did not return its unit", () => {
    const state = {
      ...createInitialState("QUOTATION"),
      items: [line(11, "1000.00"), line(22, "2000.00")],
    };

    const next = invoiceReducer(state, {
      type: "SET_TIER_PRICES",
      tier: "GOVERNMENT",
      pricesByUnitId: { 11: { price: "900.00", priceSource: "TIER" } },
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
      pricesByUnitId: { 33: { price: "1.00", priceSource: "TIER" } },
    });
    expect(repriced.items.map((item) => item.price)).toEqual(["5000.00", "5000.00"]);
  });
});

describe("invoiceReducer digital-card identity", () => {
  it("يبقي مثيلين من الوحدة نفسها مستقلين ويحفظ الطالب والمفتاح لكل واحد", () => {
    const state = createInitialState("SALE");
    const next = invoiceReducer(state, {
      type: "ADD_ITEMS",
      items: [digitalLine("card-a", "مريم"), digitalLine("card-b", "سارة")],
    });

    expect(next.items).toHaveLength(2);
    expect(next.items.map((item) => item.qty)).toEqual([1, 1]);
    expect(next.items.map((item) => item.digital?.internalLineToken)).toEqual(["card-a", "card-b"]);
    expect(next.items.map((item) => item.digital?.student?.studentName)).toEqual(["مريم", "سارة"]);
  });

  it("يواصل دمج الصنف العادي ولا يدمجه مع مثيل رقمي من الوحدة نفسها", () => {
    const state = {
      ...createInitialState("SALE"),
      items: [digitalLine("card-a")],
    };
    const next = invoiceReducer(state, {
      type: "ADD_ITEMS",
      items: [line(77, "100.00"), line(77, "100.00")],
    });

    expect(next.items).toHaveLength(2);
    expect(next.items[0].digital?.internalLineToken).toBe("card-a");
    expect(next.items[1].qty).toBe(2);
  });

  it("يثبّت كمية وسعر المثيل الرقمي عند التعديل أو تغيير فئة السعر", () => {
    const state = {
      ...createInitialState("SALE"),
      items: [digitalLine("card-a")],
    };
    const withQuantity = invoiceReducer(state, { type: "UPDATE_ITEM", idx: 0, field: "qty", value: 8 });
    const withPrice = invoiceReducer(withQuantity, { type: "UPDATE_ITEM", idx: 0, field: "price", value: "1.00" });
    const repriced = invoiceReducer(withPrice, {
      type: "SET_TIER_PRICES",
      tier: "WHOLESALE",
      pricesByUnitId: { 77: "2.00" },
    });

    expect(repriced.items[0].qty).toBe(1);
    expect(repriced.items[0].price).toBe("100.00");
    expect(repriced.tier).toBe("WHOLESALE");
  });
});
