import { describe, expect, it } from "vitest";
import { emptyCustomization } from "@/components/CustomizationDialog";
import { prepareReceptionDraftCart, updateRestoredReceptionCustomization } from "@/lib/receptionWorkspaceState";
import { addPlainCustomizationPiece, canAddPlainCustomizationPiece } from "./cartCustomization";
import { effectivePrice, lineTotal, withReceptionLineDiscount, type CartLine, type PosRow } from "./cartMath";
import { buildDraftPayload } from "./draftPayloadBuilder";

function customized(qty = 2): CartLine {
  return {
    key: "custom",
    row: {
      variantId: 1, productUnitId: 1, productName: "درع", sku: "AWARD", unitName: "قطعة",
      conversionFactor: "1", price: "10000", stockBase: 10, isCustomizable: true, isService: false,
    } as PosRow,
    qty,
    custom: { ...emptyCustomization("درع"), unitPrice: "2000", customizationText: "شكراً" },
  };
}

describe("فصل القطعة الجاهزة عن تخصيص الاستقبال", () => {
  it("does not subtract the addon twice from a legacy discounted catalog-price reference", () => {
    const source = { ...customized(), origPrice: 10000, disc: 10 };
    expect(addPlainCustomizationPiece([source], source.key, "plain")[0].origPrice).toBe(10000);
  });

  it("discounts the product plus customization and keeps the plain piece undiscounted", () => {
    const discounted = withReceptionLineDiscount(customized(), 10);
    expect(discounted).toMatchObject({ customBasePrice: 10000, origPrice: 12000, disc: 10 });
    expect(effectivePrice(discounted)).toBe(10800);
    expect(addPlainCustomizationPiece([discounted], discounted.key, "plain")[0].origPrice).toBe(10000);
    expect(effectivePrice(withReceptionLineDiscount(discounted, null))).toBe(12000);
    const edited = updateRestoredReceptionCustomization(discounted, { ...discounted.custom!, unitPrice: "3000" });
    expect(effectivePrice(edited)).toBe(11700);
    expect(addPlainCustomizationPiece([edited], edited.key, "plain")[0].origPrice).toBe(10000);
  });

  it("keeps the undiscounted product base through a discounted draft and a catalog price change", () => {
    const source = { ...customized(), customBasePrice: 10000, origPrice: 12000, disc: 10 };
    const payload = buildDraftPayload({ customer: {}, effectiveTier: "RETAIL", channel: "WALK_IN", channelHandle: "", linkedConversationId: null, cart: [source] });
    expect(payload.lines[0].unitPrice).toBe("10800.00");
    const restored = prepareReceptionDraftCart(payload.lines.map((line, index) => ({
      ...line, id: index + 1, printSpec: "printSpec" in line ? line.printSpec : null,
      designImages: "designImages" in line ? line.designImages : null,
    })), [{ ...source.row, price: "50000" }]);
    expect(restored.ok).toBe(true);
    if (restored.ok) {
      expect(effectivePrice(restored.cart[0])).toBe(10800);
      const [plain] = addPlainCustomizationPiece(restored.cart, restored.cart[0].key, "plain");
      expect(effectivePrice(plain)).toBe(10000);
      expect(plain).not.toHaveProperty("disc");
    }
  });

  it("blocks an ambiguous old draft without losing its price or guessing a base after editing and resaving", () => {
    const source = customized();
    const legacy = {
      id: 1, quantity: "2", lineKind: "CUSTOM", variantId: 1, productUnitId: 1,
      title: "درع", unitPrice: "10800", designImages: null,
      printSpec: JSON.stringify(source.custom),
    };
    const restored = prepareReceptionDraftCart([legacy], [{ ...source.row, price: "50000" }]);
    if (!restored.ok) throw new Error("expected intact legacy draft");
    const line = restored.cart[0];
    expect(line.customBasePrice).toBeNull();
    expect(effectivePrice(line)).toBe(10800);
    expect(canAddPlainCustomizationPiece(line)).toBe(false);
    expect(addPlainCustomizationPiece(restored.cart, line.key, "plain")).toBe(restored.cart);
    const edited = updateRestoredReceptionCustomization(line, { ...line.custom!, unitPrice: "3000" });
    expect(edited.customBasePrice).toBeNull();
    const payload = buildDraftPayload({ customer: {}, effectiveTier: "RETAIL", channel: "WALK_IN", channelHandle: "", linkedConversationId: null, cart: [edited] });
    expect(JSON.parse(payload.lines[0].printSpec!)).toHaveProperty("customBasePrice", null);
    expect(canAddPlainCustomizationPiece(edited)).toBe(false);
  });

  it("does not infer a product base from an ambiguous historical line total", () => {
    const source = { ...customized(), origPrice: 11000 };
    expect(canAddPlainCustomizationPiece(source)).toBe(false);
    expect(addPlainCustomizationPiece([source], source.key, "plain")).toEqual([source]);
  });

  it("keeps two products and charges customization once", () => {
    const source = customized();
    const next = addPlainCustomizationPiece([source], source.key, "plain");
    expect(next.map((line) => [line.qty, Boolean(line.custom)])).toEqual([[1, false], [1, true]]);
    expect(next.reduce((total, line) => total + lineTotal(line), 0)).toBe(22000);
    expect(source.qty).toBe(2);
  });

  it("adds a plain piece beside a single customized piece", () => {
    const source = customized(1);
    const next = addPlainCustomizationPiece([source], source.key, "plain");
    expect(next[1]).toBe(source);
    expect(next.reduce((total, line) => total + line.qty, 0)).toBe(2);
  });

  it("splits one piece at a time without changing the other customization", () => {
    const source = customized(3);
    const other = { ...customized(1), key: "other", custom: { ...source.custom!, customizationText: "مبارك" } };
    const next = addPlainCustomizationPiece([source, other], source.key, "plain");
    expect(next.map((line) => line.qty)).toEqual([1, 2, 1]);
    expect(next[2]).toBe(other);
    expect(next[1].custom).toBe(source.custom);
  });

  it("uses the historical base price without inheriting discount, coupon or delivery", () => {
    const source = {
      ...customized(), customBasePrice: 9000, origPrice: 11000, disc: 10, couponPriceSnapshot: 8000,
      couponBasePromotion: { promotionId: 3, promotionName: "عرض", promotionEffectivePrice: "7000" },
      row: { ...customized().row, price: "15000", promotionId: 4, promotionName: "كوبون", promotionEffectivePrice: "6000" },
      custom: { ...customized().custom!, hasDelivery: true, deliveryCost: "5000", designImages: [{ id: "img", dataUrl: "data:image/png;base64,AA==", isPrimary: true }] },
    };
    const [plain, remaining] = addPlainCustomizationPiece([source], source.key, "plain");
    expect(effectivePrice(plain)).toBe(9000);
    expect(plain).not.toHaveProperty("disc");
    expect(plain).not.toHaveProperty("couponPriceSnapshot");
    expect(plain).not.toHaveProperty("couponBasePromotion");
    expect(plain).not.toHaveProperty("custom");
    expect(plain.row.promotionEffectivePrice).toBeNull();
    expect(remaining.origPrice).toBe(11000);
    expect(remaining.custom).toBe(source.custom);
  });

  it("does not merge the plain piece into an existing discounted line", () => {
    const source = customized();
    const discounted = { key: "discounted", row: source.row, qty: 1, disc: 20 };
    const next = addPlainCustomizationPiece([discounted, source], source.key, "plain");
    expect(next).toHaveLength(3);
    expect(next[1]).toBe(discounted);
    expect(effectivePrice(next[0])).toBe(10000);
  });

  it("preserves fractional historical prices without subtraction drift", () => {
    const source = { ...customized(), customBasePrice: 10.1, origPrice: 10.3, custom: { ...customized().custom!, unitPrice: "0.2" } };
    expect(addPlainCustomizationPiece([source], source.key, "plain")[0].origPrice).toBe(10.1);
  });

  it.each([
    { manualService: true }, { digital: {} }, { qty: 0 }, { qty: 1.5 },
    { custom: undefined }, { origPrice: 1000 },
  ])("leaves an ineligible line unchanged: %j", (overrides) => {
    const cart = [{ ...customized(), ...overrides } as CartLine];
    expect(addPlainCustomizationPiece(cart, cart[0].key, "plain")).toBe(cart);
  });

  it("preserves independent kinds, quantity and historical prices through draft save and resume", () => {
    const source = { ...customized(), customBasePrice: 9000, origPrice: 11000 };
    const cart = addPlainCustomizationPiece([source], source.key, "plain");
    const payload = buildDraftPayload({ customer: {}, effectiveTier: "RETAIL", channel: "WALK_IN", channelHandle: "", linkedConversationId: null, cart });
    expect(payload.lines.map((line) => [line.lineKind, line.quantity, line.unitPrice])).toEqual([
      ["GOODS", "1", "9000.00"], ["CUSTOM", "1", "11000.00"],
    ]);
    const restored = prepareReceptionDraftCart(payload.lines.map((line, index) => ({
      ...line, id: index + 1, printSpec: "printSpec" in line ? line.printSpec : null,
      designImages: "designImages" in line ? line.designImages : null,
    })), [{ ...source.row, price: "20000" }]);
    expect(restored.ok).toBe(true);
    if (restored.ok) {
      expect(restored.cart.map(effectivePrice)).toEqual([9000, 11000]);
      expect(restored.cart.map((line) => Boolean(line.custom))).toEqual([false, true]);
    }
  });
});
