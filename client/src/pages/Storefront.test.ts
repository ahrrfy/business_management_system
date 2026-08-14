import { describe, expect, it, vi } from "vitest";
import {
  addStorefrontCartLine,
  collectStorefrontFailures,
  recordStorefrontCartChange,
  saveStorefrontSnapshot,
  setStorefrontCartQuantity,
  storefrontCategoryCount,
  type CartLine,
  type CheckoutForm,
} from "./Storefront";

describe("storefront source failures", () => {
  it("keeps every failed public source explicit instead of treating it as empty data", () => {
    expect(
      collectStorefrontFailures({
        settings: true,
        categories: true,
        offers: true,
        catalog: true,
      }),
    ).toEqual(["settings", "categories", "offers", "catalog"]);
  });

  it("does not report successful sources as failures", () => {
    expect(
      collectStorefrontFailures({
        settings: false,
        categories: true,
        offers: false,
        catalog: false,
      }),
    ).toEqual(["categories"]);
  });

});

describe("storefront availability contract", () => {
  const category = { productCount: 12, availableCount: 8 };

  it("shows available category counts for the default in-stock view", () => {
    expect(storefrontCategoryCount(category, "IN_STOCK")).toBe(8);
  });

  it("shows total category counts when the visitor asks for all products", () => {
    expect(storefrontCategoryCount(category, "ALL")).toBe(12);
  });

});

describe("storefront persistence safety", () => {
  const form: CheckoutForm = {
    name: "زبون",
    phone: "+964 7700000000",
    governorate: "baghdad",
    address: "بغداد",
    notes: "",
  };
  const line: CartLine = {
    productUnitId: 11,
    productId: 7,
    name: "دفتر",
    price: "500",
    imageUrl: null,
    unitName: "قطعة",
    qty: 1,
  };

  it("reports success only after both cart and checkout form are persisted", () => {
    const storage = {
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };

    expect(saveStorefrontSnapshot(new Map([[line.productUnitId, line]]), form, storage)).toBe(true);
    expect(storage.setItem).toHaveBeenCalledTimes(2);
  });

  it("reports quota/storage failure and still attempts both halves of the order", () => {
    const storage = {
      setItem: vi
        .fn()
        .mockImplementationOnce(() => undefined)
        .mockImplementationOnce(() => {
          throw new DOMException("Quota exceeded", "QuotaExceededError");
        }),
      removeItem: vi.fn(),
    };

    expect(saveStorefrontSnapshot(new Map([[line.productUnitId, line]]), form, storage)).toBe(false);
    expect(storage.setItem).toHaveBeenCalledTimes(2);
  });

  it("marks add, quantity change, and removal as unsaved cart interactions", () => {
    const markChanged = vi.fn();
    const added = addStorefrontCartLine(
      new Map(),
      {
        productUnitId: line.productUnitId,
        productId: line.productId,
        productName: line.name,
        imageUrl: line.imageUrl,
        unitName: line.unitName,
      },
      line.price,
    );
    recordStorefrontCartChange(markChanged);
    const increased = setStorefrontCartQuantity(added, line.productUnitId, 3);
    recordStorefrontCartChange(markChanged);
    const removed = setStorefrontCartQuantity(increased, line.productUnitId, 0);
    recordStorefrontCartChange(markChanged);

    expect(added.get(line.productUnitId)?.qty).toBe(1);
    expect(increased.get(line.productUnitId)?.qty).toBe(3);
    expect(removed.has(line.productUnitId)).toBe(false);
    expect(markChanged).toHaveBeenCalledTimes(3);
  });
});
