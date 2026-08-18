import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BundleMedia,
  addStorefrontCartLine,
  addStorefrontCartLines,
  collectStorefrontFailures,
  formatStorefrontReservationDeadline,
  loadCheckoutAttempt,
  recordStorefrontCartChange,
  reconcileStorefrontCartQuote,
  reconcileStorefrontCartPricing,
  saveCheckoutAttempt,
  saveStorefrontSnapshot,
  setStorefrontCartQuantity,
  storefrontCheckoutFingerprint,
  storefrontCategoryCount,
  type CartLine,
  type CheckoutForm,
} from "./Storefront";

describe("storefront reservation deadline", () => {
  it("يعرض لقطة المهلة بتوقيت بغداد بوضوح", () => {
    const formatted = formatStorefrontReservationDeadline("2026-08-18T12:30:00.000Z");
    expect(formatted).toContain("٢٠٢٦");
    expect(formatted).toContain("٣:٣٠");
  });
});

describe("storefront bundle media", () => {
  it("يعرض حتى أربع صور مكوّنات في شبكة واحدة دون تكرار النص البديل", () => {
    const html = renderToStaticMarkup(createElement(BundleMedia, {
      urls: ["/a.webp", "/b.webp", "/c.webp", "/d.webp", "/ignored.webp"],
      fallbackUrl: "/a.webp",
      alt: "بكج العودة إلى المدرسة",
    }));

    expect(html.match(/<img/g)).toHaveLength(4);
    expect(html).toContain('role="img"');
    expect(html).toContain("صور مكوّنات البكج: بكج العودة إلى المدرسة");
    expect(html).not.toContain("/ignored.webp");
  });

  it("يعرض الصورة التسويقية الخاصة منفردة عند عدم إرجاع صور المكوّنات", () => {
    const html = renderToStaticMarkup(createElement(BundleMedia, {
      urls: undefined,
      fallbackUrl: "/bundle.webp",
      alt: "بكج خاص",
    }));

    expect(html.match(/<img/g)).toHaveLength(1);
    expect(html).toContain('/bundle.webp');
    expect(html).not.toContain("صور مكوّنات البكج");
  });
});

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

  it("adds several colours in one operation while preserving each variant as its own order line", () => {
    const existing: CartLine = { ...line, qty: 2 };
    const result = addStorefrontCartLines(new Map([[existing.productUnitId, existing]]), [
      {
        productUnitId: existing.productUnitId,
        productId: existing.productId,
        productName: "قلم",
        imageUrl: null,
        unitName: "قطعة",
        variantLabel: "أزرق",
        effectivePrice: "500",
        quantity: 3,
      },
      {
        productUnitId: 12,
        productId: existing.productId,
        productName: "قلم",
        imageUrl: null,
        unitName: "قطعة",
        variantLabel: "أحمر",
        effectivePrice: "500",
        quantity: 2,
      },
    ]);

    expect(result.get(11)).toMatchObject({ qty: 5, name: "قلم — أزرق" });
    expect(result.get(12)).toMatchObject({ qty: 2, name: "قلم — أحمر" });
    expect(result.size).toBe(2);
  });

  it("ignores zero or invalid multi-variant quantities", () => {
    const result = addStorefrontCartLines(new Map(), [{
      productUnitId: 12,
      productId: 7,
      productName: "قلم",
      imageUrl: null,
      unitName: "قطعة",
      effectivePrice: "500",
      quantity: 0,
    }, {
      productUnitId: 13,
      productId: 7,
      productName: "قلم",
      imageUrl: null,
      unitName: "قطعة",
      effectivePrice: "500",
      quantity: 1.5,
    }]);
    expect(result.size).toBe(0);
  });

  it("persists the checkout request key across reload and keeps the fingerprint deterministic", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
      removeItem: vi.fn((key: string) => { values.delete(key); }),
    };
    const cart = new Map([[line.productUnitId, line]]);
    const fingerprint = storefrontCheckoutFingerprint(cart, form);
    const attempt = { clientRequestId: "sf-stable", fingerprint, expectedGrandTotal: "500.00", createdAt: 123 };
    expect(saveCheckoutAttempt(attempt, storage)).toBe(true);
    expect(loadCheckoutAttempt(storage)).toEqual(attempt);
    expect(storefrontCheckoutFingerprint(new Map(Array.from(cart).reverse()), { ...form })).toBe(fingerprint);
  });

  it("changes the retry fingerprint when the monetary/cart intent changes", () => {
    const cart = new Map([[line.productUnitId, line]]);
    const changed = new Map([[line.productUnitId, { ...line, price: "750", qty: 2 }]]);
    expect(storefrontCheckoutFingerprint(changed, form)).not.toBe(storefrontCheckoutFingerprint(cart, form));
  });

  it("refreshes a conflicted cart price so the next confirmation carries a new accepted fingerprint", () => {
    const original = new Map([[line.productUnitId, line]]);
    const originalFingerprint = storefrontCheckoutFingerprint(original, form);
    const refreshed = reconcileStorefrontCartPricing(original, new Map([
      [line.productId, {
        productId: line.productId,
        storeUnits: [{ productUnitId: line.productUnitId, price: "750.00", salePrice: null }],
      }],
    ]));

    expect(refreshed).toMatchObject({ priceChanged: 1, unavailable: 0, unresolved: 0 });
    expect(refreshed.cart.get(line.productUnitId)?.price).toBe("750.00");
    expect(storefrontCheckoutFingerprint(refreshed.cart, form)).not.toBe(originalFingerprint);
  });

  it("applies a quantity-threshold quote instead of repeating the qty=1 catalog price", () => {
    const twoItems = new Map([[line.productUnitId, { ...line, price: "100.00", qty: 2 }]]);
    const refreshed = reconcileStorefrontCartQuote(twoItems, [{
      productUnitId: line.productUnitId,
      quantity: 2,
      unitPrice: "90.00",
    }]);

    expect(refreshed).toMatchObject({ priceChanged: 1, unresolved: 0 });
    expect(refreshed.cart.get(line.productUnitId)).toMatchObject({ qty: 2, price: "90.00" });
  });
});
