import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BundleMedia,
  addStorefrontCartLine,
  addStorefrontCartLines,
  collectStorefrontFailures,
  formatStorefrontReservationDeadline,
  getStorefrontCustomizationConfig,
  loadCheckoutAttempt,
  recordStorefrontCartChange,
  reconcileStorefrontCartQuote,
  reconcileStorefrontCartPricing,
  saveCheckoutAttempt,
  saveStorefrontSnapshot,
  setStorefrontCartQuantity,
  storefrontCheckoutFingerprint,
  storefrontCategoryCount,
  storefrontMediaUrls,
  clampStorefrontZoomPoint,
  getStorefrontSearchSuggestions,
  shouldAutoLoadStorefrontNextPage,
  storefrontTurnstileSubmissionReady,
  type CartLine,
  type CheckoutForm,
} from "./Storefront";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";

describe("storefront search suggestions", () => {
  it("يطبع اقتراحات عربية من الاسم أو الماركة ويحدها بستة عناصر", () => {
    const products = Array.from({ length: 8 }, (_, index) => ({ productId: index, productName: `دفتر عربي ${index}`, brand: index === 7 ? "مختلف" : "العربية" }));
    expect(getStorefrontSearchSuggestions(products, "دفتر")).toHaveLength(6);
    expect(getStorefrontSearchSuggestions(products, "العربية")[0]?.productId).toBe(0);
    expect(getStorefrontSearchSuggestions(products, "د")).toHaveLength(0);
  });
});

describe("storefront Turnstile submission gate", () => {
  it("fails closed until ordering, public site key and a fresh token are all present", () => {
    expect(storefrontTurnstileSubmissionReady(false, "site-key", "token")).toBe(false);
    expect(storefrontTurnstileSubmissionReady(true, null, "token")).toBe(false);
    expect(storefrontTurnstileSubmissionReady(true, "site-key", null)).toBe(false);
    expect(storefrontTurnstileSubmissionReady(true, "site-key", "token")).toBe(true);
  });
});

describe("storefront customization", () => {
  it("requires an active server template for printing products and keeps different customizations as separate cart lines", () => {
    expect(getStorefrontCustomizationConfig(false, "PRINT")).toBeNull();
    expect(getStorefrontCustomizationConfig(true, null)).toBeNull();
    expect(getStorefrontCustomizationConfig(true, "PRINT")).toBeNull();
    const template = {
      id: 10,
      kind: "PRINT" as const,
      title: "خصّص طلبك",
      description: "أكمل البيانات",
      fields: [{
        id: 1,
        fieldKey: "service",
        label: "نوع التنفيذ",
        fieldType: "SELECT" as const,
        isRequired: true,
        sortOrder: 10,
        maxLength: null,
        options: [{ value: "text", label: "اسم أو عبارة", priceDelta: "0" }],
        dependency: null,
        priceDelta: "0",
      }],
    };
    const config = getStorefrontCustomizationConfig(true, "PRINT", template);
    expect(config?.kind).toBe("PRINT");
    expect(config?.fields[0]?.fieldKey).toBe("service");
    expect(config?.fields[0]?.isRequired).toBe(true);
    const base = new Map<string, CartLine>();
    const first = addStorefrontCartLine(base, { productUnitId: 21, productId: 9, productName: "دعوة", imageUrl: null, unitName: "قطعة", customization: { kind: "PRINT", service: "اسم أو عبارة", message: "سارة" } }, "2500");
    const second = addStorefrontCartLine(first, { productUnitId: 21, productId: 9, productName: "دعوة", imageUrl: null, unitName: "قطعة", customization: { kind: "PRINT", service: "اسم أو عبارة", message: "ليان" } }, "2500");
    expect(second.size).toBe(2);
  });
});

describe("storefront reservation deadline", () => {
  it("يعرض لقطة المهلة بتوقيت بغداد بوضوح", () => {
    const formatted = formatStorefrontReservationDeadline("2026-08-18T12:30:00.000Z");
    expect(formatted).toContain("٢٠٢٦");
    expect(formatted).toContain("٣:٣٠");
  });
});

describe("storefront media sources", () => {
  it("يحافظ على ترتيب الصور الحقيقية ويزيل التكرار ويحدّ العدد", () => {
    expect(storefrontMediaUrls(["/one.webp", "/two.webp", "/one.webp"], "/three.webp", 3)).toEqual([
      "/one.webp",
      "/two.webp",
      "/three.webp",
    ]);
  });
});

describe("storefront zoom lens", () => {
  it("keeps the single zoom lens inside the image frame at every edge", () => {
    const squareTopLeft = clampStorefrontZoomPoint({ x: 0, y: 0 }, 600, 600);
    expect(squareTopLeft.x).toBeCloseTo(21.3333, 4);
    expect(squareTopLeft.y).toBeCloseTo(21.3333, 4);
    const squareBottomRight = clampStorefrontZoomPoint({ x: 100, y: 100 }, 600, 600);
    expect(squareBottomRight.x).toBeCloseTo(78.6667, 4);
    expect(squareBottomRight.y).toBeCloseTo(78.6667, 4);
    expect(clampStorefrontZoomPoint({ x: 50, y: 50 }, 600, 600)).toEqual({ x: 50, y: 50 });
    const wide = clampStorefrontZoomPoint({ x: 0, y: 100 }, 1200, 720);
    expect(wide.x).toBeCloseTo(10.6667, 4);
    expect(wide.y).toBeCloseTo(82.2222, 4);
    const narrow = clampStorefrontZoomPoint({ x: 100, y: 0 }, 320, 480);
    expect(narrow.x).toBeCloseTo(60, 4);
    expect(narrow.y).toBeCloseTo(26.6667, 4);
  });
});

describe("storefront bundle media", () => {
  it("يعرض صورة واحدة في كل لحظة مع عداد السلايد دون تكرار النص البديل", () => {
    const html = renderToStaticMarkup(createElement(BundleMedia, {
      urls: ["/a.webp", "/b.webp", "/c.webp", "/d.webp", "/ignored.webp"],
      fallbackUrl: "/a.webp",
      alt: "بكج العودة إلى المدرسة",
    }));

    expect(html.match(/<img/g)).toHaveLength(1);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="معاينة 1 من 4"');
    expect(html).toContain("/a.webp");
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

describe("storefront automatic product loading", () => {
  it("loads the next page only when the sentinel is visible and no request/error is active", () => {
    expect(shouldAutoLoadStorefrontNextPage({ isIntersecting: true, hasNextPage: true, isFetchingNextPage: false, isError: false })).toBe(true);
    expect(shouldAutoLoadStorefrontNextPage({ isIntersecting: false, hasNextPage: true, isFetchingNextPage: false, isError: false })).toBe(false);
    expect(shouldAutoLoadStorefrontNextPage({ isIntersecting: true, hasNextPage: false, isFetchingNextPage: false, isError: false })).toBe(false);
    expect(shouldAutoLoadStorefrontNextPage({ isIntersecting: true, hasNextPage: true, isFetchingNextPage: true, isError: false })).toBe(false);
    expect(shouldAutoLoadStorefrontNextPage({ isIntersecting: true, hasNextPage: true, isFetchingNextPage: false, isError: true })).toBe(false);
  });
});

describe("storefront checkout phone direction", () => {
  it("renders the country code control and national number in an LTR wrapper", () => {
    const html = renderToStaticMarkup(createElement(IntlPhoneInput, { value: "+9647701234567", onChange: vi.fn() }));
    expect(html).toContain('dir="ltr"');
    expect(html.indexOf("مفتاح الدولة")).toBeLessThan(html.indexOf("<input"));
    expect(html).toContain('value="7701234567"');
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
    cartKey: "11:",
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

    expect(saveStorefrontSnapshot(new Map([[line.cartKey, line]]), form, storage)).toBe(true);
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

    expect(saveStorefrontSnapshot(new Map([[line.cartKey, line]]), form, storage)).toBe(false);
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
    const increased = setStorefrontCartQuantity(added, line.cartKey, 3);
    recordStorefrontCartChange(markChanged);
    const removed = setStorefrontCartQuantity(increased, line.cartKey, 0);
    recordStorefrontCartChange(markChanged);

    expect(added.get(line.cartKey)?.qty).toBe(1);
    expect(increased.get(line.cartKey)?.qty).toBe(3);
    expect(removed.has(line.cartKey)).toBe(false);
    expect(markChanged).toHaveBeenCalledTimes(3);
  });

  it("adds several colours in one operation while preserving each variant as its own order line", () => {
    const existing: CartLine = { ...line, cartKey: "11:", qty: 2 };
    const result = addStorefrontCartLines(new Map([[existing.cartKey, existing]]), [
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

    expect(result.get("11:")).toMatchObject({ qty: 5, name: "قلم — أزرق" });
    expect(result.get("12:")).toMatchObject({ qty: 2, name: "قلم — أحمر" });
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
    const cart = new Map([[line.cartKey, line]]);
    const fingerprint = storefrontCheckoutFingerprint(cart, form);
    const attempt = { clientRequestId: "sf-stable", fingerprint, expectedGrandTotal: "500.00", createdAt: 123 };
    expect(saveCheckoutAttempt(attempt, storage)).toBe(true);
    expect(loadCheckoutAttempt(storage)).toEqual(attempt);
    expect(storefrontCheckoutFingerprint(new Map(Array.from(cart).reverse()), { ...form })).toBe(fingerprint);
  });

  it("changes the retry fingerprint when the monetary/cart intent changes", () => {
    const cart = new Map([[line.cartKey, line]]);
    const changed = new Map([[line.cartKey, { ...line, price: "750", qty: 2 }]]);
    expect(storefrontCheckoutFingerprint(changed, form)).not.toBe(storefrontCheckoutFingerprint(cart, form));
  });

  it("refreshes a conflicted cart price so the next confirmation carries a new accepted fingerprint", () => {
    const original = new Map([[line.cartKey, line]]);
    const originalFingerprint = storefrontCheckoutFingerprint(original, form);
    const refreshed = reconcileStorefrontCartPricing(original, new Map([
      [line.productId, {
        productId: line.productId,
        storeUnits: [{ productUnitId: line.productUnitId, price: "750.00", salePrice: null }],
      }],
    ]));

    expect(refreshed).toMatchObject({ priceChanged: 1, unavailable: 0, unresolved: 0 });
    expect(refreshed.cart.get(line.cartKey)?.price).toBe("750.00");
    expect(storefrontCheckoutFingerprint(refreshed.cart, form)).not.toBe(originalFingerprint);
  });

  it("applies a quantity-threshold quote instead of repeating the qty=1 catalog price", () => {
    const twoItems = new Map([[line.cartKey, { ...line, price: "100.00", qty: 2 }]]);
    const refreshed = reconcileStorefrontCartQuote(twoItems, [{
      productUnitId: line.productUnitId,
      quantity: 2,
      unitPrice: "90.00",
    }]);

    expect(refreshed).toMatchObject({ priceChanged: 1, unresolved: 0 });
    expect(refreshed.cart.get(line.cartKey)).toMatchObject({ qty: 2, price: "90.00" });
  });
});
