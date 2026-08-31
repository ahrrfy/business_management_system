import { describe, expect, it } from "vitest";

import { addProductToCart, sanitizeCartLines } from "../lib/cart-context";
import { canonicalIraqiLocalPhone, normalizeIraqiPhone } from "../lib/iraqi-phone";
import { marketingCarouselGeometry } from "../lib/marketing-carousel-layout";
import { catalogDisplayState, classifyNetworkError, formatIqd, productDiscountPercent, storefrontDisplayPrice, storefrontMutationHeaders } from "../lib/storefront-api";
import type { Product } from "../shared/storefront";

const testProduct: Product = {
  id: "test-product",
  productId: 1,
  productUnitId: 10,
  variantId: 20,
  title: "منتج اختبار",
  subtitle: "وحدة",
  categoryId: "1",
  description: "منتج يستخدم فقط للتحقق من صحة السلة.",
  icon: "menu-book",
  accent: "#E7F1EC",
  availability: "متوفر",
  price: "1000",
};

describe("واجهة كتالوج مكتبة العربية", () => {
  it("يبقي بطاقة البطل داخل عروض الهواتف الصغيرة والقياسية", () => {
    expect(marketingCarouselGeometry(320)).toEqual({ cardWidth: 288, sideInset: 16 });
    expect(marketingCarouselGeometry(390)).toEqual({ cardWidth: 358, sideInset: 16 });
  });

  it("ترفض السلة المخزنة القيم غير الصالحة وتفرض حد الكمية", () => {
    const restored = sanitizeCartLines([{ product: testProduct, quantity: 5_000 }, { product: null, quantity: 1 }]);
    expect(restored).toHaveLength(1);
    expect(restored[0].quantity).toBe(999);
  });

  it("يزيد زر الإضافة كمية المنتج نفسه في السلة مع كل ضغطة", () => {
    const firstPress = addProductToCart([], testProduct);
    const secondPress = addProductToCart(firstPress, testProduct);
    expect(firstPress).toHaveLength(1);
    expect(firstPress[0]).toMatchObject({ product: testProduct, quantity: 1, selectionDetails: { productUnitId: 10 } });
    expect(secondPress).toHaveLength(1);
    expect(secondPress[0]).toMatchObject({ product: testProduct, quantity: 2, selectionDetails: { productUnitId: 10 } });
  });

  it("يحسب شارة الخصم من السعرين الحقيقيين ويستخدم أرقاماً لاتينية", () => {
    expect(productDiscountPercent({ ...testProduct, price: "10000", salePrice: "7500" })).toBe(25);
    expect(productDiscountPercent({ ...testProduct, price: "10000", salePrice: "10000" })).toBeNull();
    expect(productDiscountPercent({ ...testProduct, price: "10000", salePrice: null })).toBeNull();
    expect(productDiscountPercent({ ...testProduct, price: "10000", salePrice: "0" })).toBeNull();
    expect(storefrontDisplayPrice({ ...testProduct, price: "10000", salePrice: "0" })).toBe("10000");
    expect(formatIqd("12500")).toContain("12,500");
  });

  it("يرسل طلبات التطبيق الأصلية مع برهان العميل الذي يتطلبه حارس CSRF", () => {
    expect(storefrontMutationHeaders("android")).toMatchObject({ "x-alrueya-client": "android-native" });
    expect(storefrontMutationHeaders("web")).toMatchObject({ "x-erp-csrf": "1" });
  });

  it("لا يعلن فراغ الكتالوج قبل اكتمال تحميله", () => {
    expect(catalogDisplayState([], true, null)).toBe("LOADING");
    expect(catalogDisplayState([], false, "network")).toBe("ERROR");
    expect(catalogDisplayState([], false, null)).toBe("EMPTY");
    expect(catalogDisplayState([testProduct], false, null)).toBe("READY");
  });

  it("يفصل مفتاح العراق عن الحقل المحلي ويطبع E.164 الصحيح", () => {
    expect(canonicalIraqiLocalPhone("07٧٣٨٣٧٦٧٨٧")).toBe("7738376787");
    expect(canonicalIraqiLocalPhone("+964 7838376787")).toBe("7838376787");
    expect(normalizeIraqiPhone("7838376787")).toBe("+9647838376787");
    expect(normalizeIraqiPhone("783837678")).toBeNull();
  });

  it("يقبل حقل الهاتف الأرقام العربية-الهندية والفارسية معاً وينسّق بلصق E.164 الطويل", () => {
    // U+0660..0669 (عربيّ-هنديّ) و U+06F0..06F9 (فارسيّ) — كلاهما يظهر على لوحات مفاتيح عراقيّة/إيرانيّة.
    expect(canonicalIraqiLocalPhone("۰۷۷۳۸۳۷۶۷۸۷")).toBe("7738376787");
    // لصق بصيغة E.164 كاملاً مع مسافات = ٢٠ محرفاً — يجب ألا يُقصّ إلى ١١.
    expect(canonicalIraqiLocalPhone("+964 771 234 5678")).toBe("7712345678");
    expect(normalizeIraqiPhone("+964 771 234 5678")).toBe("+9647712345678");
  });

  it("يصنّف أخطاء الشبكة إلى رسائل عربيّة مفهومة للعميل", () => {
    const offline = new TypeError("Network request failed");
    expect(classifyNetworkError(offline)).toMatchObject({ kind: "OFFLINE" });
    expect(classifyNetworkError(offline).message).toContain("لا يوجد اتصال");

    const timeout = new Error("aborted"); (timeout as Error).name = "AbortError";
    expect(classifyNetworkError(timeout)).toMatchObject({ kind: "TIMEOUT" });

    expect(classifyNetworkError(new Error("فشل الاتصال بالمتجر (502)"))).toMatchObject({ kind: "SERVER" });
    expect(classifyNetworkError(new Error("فشل الاتصال بالمتجر (429)"))).toMatchObject({ kind: "SERVER" });
    expect(classifyNetworkError(new Error("فشل الاتصال بالمتجر (401)"))).toMatchObject({ kind: "CLIENT" });
    expect(classifyNetworkError(new Error("سبب اعتيادي (400)"))).toMatchObject({ kind: "CLIENT" });
    expect(classifyNetworkError("string not error")).toMatchObject({ kind: "UNKNOWN" });
  });
});
