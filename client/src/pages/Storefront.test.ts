import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import {
  BundleMedia,
  addStorefrontCartLine,
  addStorefrontCartLines,
  collectStorefrontFailures,
  formatStorefrontReservationDeadline,
  getStorefrontCustomizationConfig,
  loadCheckoutAttempt,
  loadGuestTrackingOrders,
  rememberGuestTrackingOrder,
  recordStorefrontCartChange,
  reconcileStorefrontCartQuote,
  reconcileStorefrontCartPricing,
  saveCheckoutAttempt,
  saveStorefrontSnapshot,
  setStorefrontCartQuantity,
  storefrontCheckoutFingerprint,
  storefrontCategoryCount,
  storefrontMediaUrls,
  storefrontVariantMedia,
  clampStorefrontZoomPoint,
  getStorefrontSearchSuggestions,
  recommendationActionLabel,
  shouldAutoLoadStorefrontNextPage,
  storefrontTurnstileSubmissionReady,
  storefrontProductCanBeOrdered,
  STOREFRONT_CUSTOMIZABLE_UNAVAILABLE_MESSAGE,
  validateStorefrontCheckout,
  type CartLine,
  type CheckoutForm,
} from "./Storefront";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";

describe("storefront related product actions", () => {
  it("يفصل الإضافة المباشرة عن المنتجات التي تحتاج اختياراً", () => {
    const base = { productId: 1, productName: "دفتر", imageUrl: null, price: "5000", productUnitId: 11, unitName: "قطعة", inStock: true };
    expect(recommendationActionLabel(base)).toBe("أضف إلى السلة");
    expect(recommendationActionLabel({ ...base, isCustomizable: true })).toBe(STOREFRONT_CUSTOMIZABLE_UNAVAILABLE_MESSAGE);
    expect(storefrontProductCanBeOrdered({ ...base, isCustomizable: true })).toBe(false);
    expect(recommendationActionLabel({ ...base, variants: [{ label: "لون", units: [{ productUnitId: 11, price: "5000", salePrice: null, unitName: "قطعة", inStock: true }] }, { label: "قياس", units: [{ productUnitId: 12, price: "5000", salePrice: null, unitName: "قطعة", inStock: true }] }] })).toBe("اختر الخيارات");
    expect(recommendationActionLabel({ ...base, variants: [{ label: "قياس", units: [{ productUnitId: 11, price: "5000", salePrice: null, unitName: "قطعة", inStock: true }, { productUnitId: 12, price: "9000", salePrice: null, unitName: "علبة", inStock: true }] }] })).toBe("اختر الخيارات");
    expect(recommendationActionLabel({ ...base, inStock: false })).toBe("غير متوفر");
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
  it("keeps customizable products visible but fails closed before cart or checkout", () => {
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
    const blocked = addStorefrontCartLine(base, { productUnitId: 21, productId: 9, productName: "دعوة", imageUrl: null, unitName: "قطعة", isCustomizable: true, customization: { kind: "PRINT", service: "اسم أو عبارة", message: "سارة" } }, "2500");
    expect(blocked.size).toBe(0);
    const source = readFileSync(new URL("./Storefront.tsx", import.meta.url), "utf8");
    expect(source).toContain("detailQ.data.isCustomizable ? (");
    expect(source).toContain(") : customizationConfig ? (");
    expect(source).toContain("disabled={detailQ.data.isCustomizable ||");
    expect(source).toContain("disabled={!storefrontProductCanBeOrdered(p)}");
    expect(source).toContain("cartHasUnsupportedCustomization");
    expect(source).toContain(STOREFRONT_CUSTOMIZABLE_UNAVAILABLE_MESSAGE);
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

  it("يربط معرض التفاصيل بالبديل المختار ويرجع للمعرض العام عند غيابه", () => {
    const product = {
      imageUrl: "/product.webp",
      imageUrls: ["/product.webp", "/shared.webp"],
      variants: [
        {
          variantId: 11,
          imageUrl: "/red.webp",
          imageUrls: ["/red.webp", "/shared.webp"],
        },
        {
          variantId: 12,
          imageUrl: "/blue.webp",
          imageUrls: ["/blue.webp", "/shared.webp"],
        },
      ],
    };

    expect(storefrontVariantMedia(product, 12)).toEqual({
      urls: ["/blue.webp", "/shared.webp"],
      fallbackUrl: "/blue.webp",
    });
    expect(storefrontVariantMedia(product, 999)).toEqual({
      urls: ["/product.webp", "/shared.webp"],
      fallbackUrl: "/product.webp",
    });
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
    expect(html).toContain('aria-label="بكج العودة إلى المدرسة — صورة 1 من 4"');
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

  it("never lets a known low-stock cart line exceed the available quantity", () => {
    const limited = { ...line, stockLimit: 2 };
    const cart = new Map([[limited.cartKey, limited]]);

    expect(setStorefrontCartQuantity(cart, limited.cartKey, 99).get(limited.cartKey)?.qty).toBe(2);
    expect(addStorefrontCartLine(cart, {
      productUnitId: limited.productUnitId,
      productId: limited.productId,
      productName: limited.name,
      imageUrl: limited.imageUrl,
      unitName: limited.unitName,
      stockLimit: 2,
    }, limited.price).get(limited.cartKey)?.qty).toBe(2);
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

describe("getStorefrontSearchSuggestions", () => {
  const p = (productId: number, productName: string, brand: string | null = null) => ({ productId, productName, brand });

  it("returns nothing until the term is at least two characters", () => {
    const items = [p(1, "دفتر A5"), p(2, "قلم أزرق")];
    expect(getStorefrontSearchSuggestions(items, "")).toEqual([]);
    expect(getStorefrontSearchSuggestions(items, " ")).toEqual([]);
    expect(getStorefrontSearchSuggestions(items, "د")).toEqual([]);
    expect(getStorefrontSearchSuggestions(items, "دف")).toHaveLength(1);
  });

  it("matches inside product name and brand together", () => {
    const items = [p(1, "دفتر", "Stabilo"), p(2, "قلم أحمر", "Faber"), p(3, "علبة أقلام", "Stabilo")];
    // نصّ الماركة يجب أن يُطابق كنصّ المنتج
    expect(getStorefrontSearchSuggestions(items, "stab").map((it) => it.productId)).toEqual([1, 3]);
  });

  it("normalizes alef variants (أ/إ/آ → ا) and taa marbuta (ة → ه)", () => {
    // العقد: normalizeStorefrontArabic يوحّد الألفات والتاء المربوطة فقط — بلا تشكيل.
    // مقاسٌ على السلوك الفعليّ لا الطموح، فلا يشيخ الاختبار أمام تحسّنٍ لاحقٍ في التطبيع.
    const items = [p(1, "أوراق ملوّنة"), p(2, "مسطرة"), p(3, "علبة"), p(4, "دفتر")];
    expect(getStorefrontSearchSuggestions(items, "اوراق").map((it) => it.productId)).toEqual([1]);
    expect(getStorefrontSearchSuggestions(items, "علبه").map((it) => it.productId)).toEqual([3]);
  });

  it("caps at six suggestions to keep the dropdown scannable", () => {
    const items = Array.from({ length: 12 }, (_, i) => p(i + 1, `دفتر رقم ${i + 1}`));
    expect(getStorefrontSearchSuggestions(items, "دفتر")).toHaveLength(6);
  });

  it("preserves the input list order (caller pre-filters/sorts)", () => {
    // العقد: نُقلّص فقط، لا نُعيد الترتيب — الفلترة/الفرز مسؤولية المستدعي (filteredItems)
    const items = [p(3, "دفتر C"), p(1, "دفتر A"), p(2, "دفتر B")];
    expect(getStorefrontSearchSuggestions(items, "دفتر").map((it) => it.productId)).toEqual([3, 1, 2]);
  });

  it("handles null/undefined brand safely", () => {
    const items = [p(1, "دفتر"), { productId: 2, productName: "قلم" }];
    // undefined brand يجب ألّا يرمي؛ يُعامَل كأنّه سلسلة فارغة
    expect(() => getStorefrontSearchSuggestions(items as never, "قلم")).not.toThrow();
    expect(getStorefrontSearchSuggestions(items as never, "قلم")).toHaveLength(1);
  });
});

describe("storefront checkout validation", () => {
  it("returns Arabic field errors in focus order", () => {
    expect(validateStorefrontCheckout({
      name: " ",
      phone: "+964",
      governorate: "",
      address: "بغ",
      notes: "",
    })).toEqual({
      name: "اكتب الاسم الكامل لاستلام الطلب.",
      phone: "اكتب رقم هاتف صالحاً للتواصل معك.",
      governorate: "اختر المحافظة.",
      address: "اكتب عنواناً واضحاً من 3 أحرف على الأقل.",
    });
  });

  it("accepts complete Iraqi checkout details", () => {
    expect(validateStorefrontCheckout({
      name: "سارة أحمد",
      phone: "+9647701234567",
      governorate: "baghdad",
      address: "بغداد، المنصور",
      notes: "",
    })).toEqual({});
  });
});

describe("storefront action contrast", () => {
  it("keeps the storefront action tokens above 4.5:1 against white text", () => {
    const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
    const colors = ["store-accent", "store-accent-strong"].map((token) => {
      const match = css.match(new RegExp(`--${token}:\\s*(#[0-9a-f]{6})`, "i"));
      expect(match, `missing --${token}`).not.toBeNull();
      return match![1];
    });
    const luminance = (hex: string) => {
      const channels = hex.slice(1).match(/../g)!.map((part) => Number.parseInt(part, 16) / 255).map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    for (const color of colors) expect(1.05 / (luminance(color) + 0.05)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("storefront guest tracking ownership", () => {
  it("stores at most five opaque order tokens without phone or customer PII", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
      removeItem: vi.fn((key: string) => { values.delete(key); }),
    };
    for (let index = 1; index <= 6; index += 1) {
      rememberGuestTrackingOrder({
        orderNumber: `ORD-${index}`,
        trackingToken: `${String(index).repeat(60)}.opaque`,
        expiresAt: "2099-01-01T00:00:00.000Z",
        phone: "+9647700000000",
      } as never, storage, 1_700_000_000_000 + index);
    }
    const stored = loadGuestTrackingOrders(storage, 1_700_000_100_000);
    expect(stored).toHaveLength(5);
    expect(stored[0].orderNumber).toBe("ORD-6");
    expect(values.values().next().value).not.toContain("phone");
    expect(values.values().next().value).not.toContain("9647700000000");
  });

  it("does not call the deprecated order-number plus phone endpoint", () => {
    const source = readFileSync(new URL("./Storefront.tsx", import.meta.url), "utf8");
    expect(source).toContain("trackOrderByToken.useMutation");
    expect(source).not.toContain("trackOrder.fetch");
    expect(source).toContain("quoteOrderPrivate.useMutation");
  });
});
