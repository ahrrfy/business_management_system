import { describe, expect, it } from "vitest";
import {
  captureReservationAvailability,
  findReservationAvailabilityDrops,
  findReservationStockShortages,
  reservationConversionClosedMessage,
  reservationConversionErrorClosesDialog,
  type ReservationConversionSnapshot,
} from "./reservationConversionGuard";

function detail(overrides: Partial<ReservationConversionSnapshot> = {}): ReservationConversionSnapshot {
  return {
    status: "ACTIVE",
    expiresAt: "2026-08-13T12:00:00.000Z",
    lines: [{
      variantId: 7,
      productName: "دفتر",
      baseQuantity: 4,
      fulfilledBase: 0,
      currentOnHandBase: 10,
      currentAvailableBase: 6,
    }],
    ...overrides,
  };
}

describe("reservation conversion guard", () => {
  it("يغلق التحويل برسالة واضحة عند انقضاء الحجز داخل الحوار", () => {
    expect(reservationConversionClosedMessage(detail(), Date.parse("2026-08-13T12:00:00.000Z")))
      .toContain("انتهت مدّة الحجز");
    expect(reservationConversionClosedMessage(detail({ status: "CANCELLED" }), Date.parse("2026-08-13T11:00:00.000Z")))
      .toContain("تغيّرت حالة الحجز");
    expect(reservationConversionErrorClosesDialog(new Error("لا يمكن تحويل حجز حالته EXPIRED"))).toBe(true);
  });

  it("يكشف هبوط ATP بعد فتح الحوار من دون إسقاط أولوية الحجز", () => {
    const initial = captureReservationAvailability(detail());
    const fresh = detail({
      lines: [{
        variantId: 7,
        productName: "دفتر",
        baseQuantity: 4,
        fulfilledBase: 0,
        currentOnHandBase: 10,
        currentAvailableBase: 2,
      }],
    });
    expect(findReservationAvailabilityDrops(initial, fresh)).toEqual([expect.objectContaining({
      variantId: 7,
      previousAvailableBase: 6,
      currentAvailableBase: 2,
    })]);
    expect(findReservationStockShortages(fresh)).toEqual([]);
  });

  it("يفحص الرصيد الفعلي لا ATP: حجوزات الآخرين لا تمنع صاحب الحجز", () => {
    const prioritized = detail({
      lines: [{
        variantId: 7,
        productName: "دفتر",
        baseQuantity: 4,
        fulfilledBase: 0,
        currentOnHandBase: 4,
        currentAvailableBase: -5,
      }],
    });
    expect(findReservationStockShortages(prioritized)).toEqual([]);
  });

  it("يجمع السطور المكررة للصنف قبل تقرير النقص الفعلي", () => {
    const shortage = detail({
      lines: [
        { variantId: 7, productName: "دفتر", baseQuantity: 3, fulfilledBase: 0, currentOnHandBase: 4, currentAvailableBase: 0 },
        { variantId: 7, productName: "دفتر", baseQuantity: 2, fulfilledBase: 0, currentOnHandBase: 4, currentAvailableBase: 0 },
      ],
    });
    expect(findReservationStockShortages(shortage)).toEqual([expect.objectContaining({
      variantId: 7,
      remainingBase: 5,
      currentOnHandBase: 4,
    })]);
  });
});
