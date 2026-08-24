import { describe, expect, it } from "vitest";

import { addProductToCart, sanitizeCartLines } from "../lib/cart-context";
import type { Product } from "../shared/storefront";

function makeProduct(id: string): Product {
  return {
    id,
    title: `منتج ${id}`,
    subtitle: "وحدة",
    categoryId: "1",
    description: "منتج اختباريّ",
    icon: "menu-book",
    accent: "#E7F1EC",
    availability: "متوفر",
    price: "1000",
  };
}

/**
 * حدود السلة موثَّقة في PRODUCTION_READINESS.md § الجدول:
 *   - MAX_CART_LINES = 30
 *   - MAX_QUANTITY_PER_LINE = 999
 *   - MAX_TOTAL_QUANTITY = 10,000
 *
 * كسرُ أيٍّ منها = حمولة غير منطقيّة على الخادم أو تخزين محلّيّ فاسد.
 */
describe("حدود سلة مكتبة العربية", () => {
  it("لا تتجاوز الكمية في السطر الواحد 999 مهما تكرّرت الإضافة", () => {
    const product = makeProduct("A");
    let cart: ReturnType<typeof addProductToCart> = [];
    // ١٥٠٠ ضغطة على «+» — يجب أن يقف عند ٩٩٩
    for (let i = 0; i < 1500; i += 1) cart = addProductToCart(cart, product);
    expect(cart).toHaveLength(1);
    expect(cart[0].quantity).toBe(999);
  });

  it("لا تقبل السلة أكثر من ٣٠ سطراً — المنتجات الإضافيّة تُهمَل بلا كسر", () => {
    let cart: ReturnType<typeof addProductToCart> = [];
    // ٤٠ منتجاً مختلفاً — يجب أن يبقى ٣٠ فقط
    for (let i = 0; i < 40; i += 1) cart = addProductToCart(cart, makeProduct(`p-${i}`));
    expect(cart).toHaveLength(30);
    // المنتج الحاديّ والثلاثون لم يُضَف
    expect(cart.find((line) => line.product.id === "p-30")).toBeUndefined();
    // المنتج الأوّل مضاف
    expect(cart.find((line) => line.product.id === "p-0")).toBeDefined();
  });

  it("sanitizeCartLines يقصّ الكميّة الإجماليّة إلى ١٠٬٠٠٠ عند الاستعادة من التخزين", () => {
    // نُهيّئ ٣٠ سطراً كلٌّ منها ٩٩٩ — الإجماليّ ٢٩٬٩٧٠، يقصّ إلى ١٠٬٠٠٠
    const rawLines = Array.from({ length: 30 }, (_, i) => ({ product: makeProduct(`p-${i}`), quantity: 999 }));
    const restored = sanitizeCartLines(rawLines);
    const total = restored.reduce((sum, line) => sum + line.quantity, 0);
    expect(total).toBeLessThanOrEqual(10_000);
  });

  it("sanitizeCartLines يرفض السطر الذي منتجه غير صالح", () => {
    const restored = sanitizeCartLines([
      { product: makeProduct("valid"), quantity: 5 },
      { product: null, quantity: 3 },
      { product: undefined, quantity: 2 },
      { product: "not-an-object", quantity: 1 },
      { quantity: 4 }, // بلا حقل product
    ]);
    expect(restored).toHaveLength(1);
    expect(restored[0].product.id).toBe("valid");
  });

  it("sanitizeCartLines يرفض القيمة الجذر غير المصفوفة", () => {
    expect(sanitizeCartLines(null)).toEqual([]);
    expect(sanitizeCartLines(undefined)).toEqual([]);
    expect(sanitizeCartLines("string")).toEqual([]);
    expect(sanitizeCartLines({ product: makeProduct("A"), quantity: 1 })).toEqual([]);
  });

  it("addProductToCart لا يزيد السلة عن ٣٠ سطراً حتى بمنتجاتٍ جديدة", () => {
    // نبني سلّةً بـ٣٠ سطراً بأقصى كميّة، ثمّ نحاول إضافة منتج جديد
    let cart: ReturnType<typeof addProductToCart> = [];
    for (let i = 0; i < 30; i += 1) cart = addProductToCart(cart, makeProduct(`p-${i}`));
    expect(cart).toHaveLength(30);
    const overflow = addProductToCart(cart, makeProduct("p-31"));
    expect(overflow).toHaveLength(30); // لا زيادة
    expect(overflow.find((line) => line.product.id === "p-31")).toBeUndefined();
  });
});
