import { describe, expect, it } from "vitest";

import { addProductToCart, sanitizeCartLines } from "../lib/cart-context";
import { canonicalIraqiLocalPhone, normalizeIraqiPhone } from "../lib/iraqi-phone";
import { catalogDisplayState, formatIqd, productDiscountPercent, storefrontDisplayPrice, storefrontMutationHeaders } from "../lib/storefront-api";
import type { Product } from "../shared/storefront";

const testProduct: Product = {
  id: "test-product",
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
  it("ترفض السلة المخزنة القيم غير الصالحة وتفرض حد الكمية", () => {
    const restored = sanitizeCartLines([{ product: testProduct, quantity: 5_000 }, { product: null, quantity: 1 }]);
    expect(restored).toHaveLength(1);
    expect(restored[0].quantity).toBe(999);
  });

  it("يزيد زر الإضافة كمية المنتج نفسه في السلة مع كل ضغطة", () => {
    const firstPress = addProductToCart([], testProduct);
    const secondPress = addProductToCart(firstPress, testProduct);
    expect(firstPress).toEqual([{ product: testProduct, quantity: 1 }]);
    expect(secondPress).toEqual([{ product: testProduct, quantity: 2 }]);
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
});
