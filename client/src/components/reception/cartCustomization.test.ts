import { describe, expect, it } from "vitest";
import { emptyCustomization } from "@/components/CustomizationDialog";
import { prepareReceptionDraftCart } from "@/lib/receptionWorkspaceState";
import { addPlainCustomizationPiece } from "./cartCustomization";
import { effectivePrice, lineTotal, type CartLine, type PosRow } from "./cartMath";
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
      ...customized(), origPrice: 11000, disc: 10, couponPriceSnapshot: 8000,
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
    const source = { ...customized(), origPrice: 10.3, custom: { ...customized().custom!, unitPrice: "0.2" } };
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
    const source = { ...customized(), origPrice: 11000 };
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
