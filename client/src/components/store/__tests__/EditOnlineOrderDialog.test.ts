import { describe, expect, it } from "vitest";
import {
  computeEditOnlineOrderTotals,
  resolveEditableDeliveryZoneOptions,
  splitShippingAddressAndNotes,
} from "../EditOnlineOrderDialog";

describe("EditOnlineOrderDialog helpers — dynamic zones, notes split, and threshold parity", () => {
  it("splits persisted shippingAddress and trailing '\\nملاحظة:' cleanly without losing multi-line notes", () => {
    expect(
      splitShippingAddressAndNotes("المنصور شارع 14\nملاحظة: الطابق الثاني قرب الصيدلية"),
    ).toEqual({
      shippingAddress: "المنصور شارع 14",
      notes: "الطابق الثاني قرب الصيدلية",
    });

    expect(splitShippingAddressAndNotes("ملاحظة: اتصال مسبق فقط")).toEqual({
      shippingAddress: "",
      notes: "اتصال مسبق فقط",
    });

    expect(splitShippingAddressAndNotes("الكرادة داخل")).toEqual({
      shippingAddress: "الكرادة داخل",
      notes: "",
    });
  });

  it("uses dynamic deliveryZones fees and hides deactivated zones unless currently selected on the order", () => {
    const dbZones = [
      { id: "baghdad", name: "بغداد المحدثة", deliveryFee: 4000, isActive: true },
      { id: "basra", name: "البصرة المحدثة", deliveryFee: 9000, isActive: true },
      { id: "kirkuk", name: "كركوك الموقوفة", deliveryFee: 11000, isActive: false },
    ];

    const forBaghdad = resolveEditableDeliveryZoneOptions(dbZones, "baghdad");
    expect(forBaghdad.map((z) => z.id)).toEqual(["baghdad", "basra"]);
    expect(forBaghdad.find((z) => z.id === "baghdad")?.deliveryFee).toBe(4000);
    expect(forBaghdad.find((z) => z.id === "basra")?.deliveryFee).toBe(9000);

    // If an existing order was placed for kirkuk before deactivation, keep kirkuk selectable
    const forKirkuk = resolveEditableDeliveryZoneOptions(dbZones, "kirkuk");
    expect(forKirkuk.map((z) => z.id)).toEqual(["baghdad", "basra", "kirkuk"]);
  });

  it("evaluates free-shipping threshold against pre-discount retail subtotal and honors governorate override & couponFreeShipping", () => {
    const zones = [
      { id: "baghdad", name: "بغداد", deliveryFee: 4000, isActive: true },
      { id: "basra", name: "البصرة", deliveryFee: 9000, isActive: true },
    ];

    // Wholesale order: 12 * 3500 = 42,000 subtotal, pricingBenefitDiscount = 12,000 => retail = 54,000
    // Baghdad threshold = 50,000 => FREE!
    const baghdadTotals = computeEditOnlineOrderTotals({
      governorate: "baghdad",
      zones,
      items: [{ unitPrice: 3500, retailUnitPrice: 4500, quantity: 12, lineTotal: 42000 }],
      itemsModified: false,
      freeShippingThresholdSetting: "50000.00",
      freeShippingThresholdGovernoratesSetting: "60000.00",
      pricingBenefitDiscount: "12000.00",
      couponDiscount: "0.00",
      couponFreeShipping: false,
    });
    expect(baghdadTotals.eligibilitySubtotal).toBe(54000);
    expect(baghdadTotals.isFreeDelivery).toBe(true);
    expect(baghdadTotals.finalDeliveryFee).toBe(0);
    expect(baghdadTotals.grandTotal).toBe(42000);

    // Same order switched to Basra: governorate threshold = 60,000 > 54,000 => dynamic 9,000 IQD fee
    const basraTotals = computeEditOnlineOrderTotals({
      governorate: "basra",
      zones,
      items: [{ unitPrice: 3500, retailUnitPrice: 4500, quantity: 12, lineTotal: 42000 }],
      itemsModified: false,
      freeShippingThresholdSetting: "50000.00",
      freeShippingThresholdGovernoratesSetting: "60000.00",
      pricingBenefitDiscount: "12000.00",
      couponDiscount: "0.00",
      couponFreeShipping: false,
    });
    expect(basraTotals.isFreeDelivery).toBe(false);
    expect(basraTotals.baseDeliveryFee).toBe(9000);
    expect(basraTotals.finalDeliveryFee).toBe(9000);
    expect(basraTotals.grandTotal).toBe(51000);

    // Free-shipping coupon in Basra waives the 9,000 fee even below 60,000 threshold
    const couponFreeTotals = computeEditOnlineOrderTotals({
      governorate: "basra",
      zones,
      items: [{ unitPrice: 4500, retailUnitPrice: 4500, quantity: 2, lineTotal: 9000 }],
      itemsModified: false,
      freeShippingThresholdSetting: "50000.00",
      freeShippingThresholdGovernoratesSetting: "60000.00",
      pricingBenefitDiscount: "0.00",
      couponDiscount: "0.00",
      couponFreeShipping: true,
    });
    expect(couponFreeTotals.isFreeDelivery).toBe(true);
    expect(couponFreeTotals.couponShippingFree).toBe(true);
    expect(couponFreeTotals.finalDeliveryFee).toBe(0);
    expect(couponFreeTotals.grandTotal).toBe(9000);
  });
});
