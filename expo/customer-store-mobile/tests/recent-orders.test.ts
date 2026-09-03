import { describe, expect, it } from "vitest";

import {
  findTrustedRecentOrder,
  mergeRecentOrder,
  sanitizeRecentOrders,
} from "../lib/recent-orders";

describe("recent storefront orders", () => {
  it("يحفظ المرجع الأدنى للتتبع ويضع آخر طلب أولاً بلا تكرار", () => {
    const first = {
      orderNumber: "ORD-100001",
      phone: "+9647801234567",
      total: "15000.00",
      placedAt: "2026-08-31T08:00:00.000Z",
      reservationExpiresAt: "2026-09-01T08:00:00.000Z",
      guestTrackingToken: `${"a".repeat(32)}.abc.${"b".repeat(43)}`,
      guestTrackingExpiresAt: "2026-09-07T08:00:00.000Z",
    };
    const updated = {
      ...first,
      total: "14000.00",
      placedAt: "2026-08-31T09:00:00.000Z",
    };

    expect(mergeRecentOrder([first], updated)).toEqual([updated]);
  });

  it("يرفض السجلات غير الصالحة ويحد السجل بخمسة طلبات", () => {
    const values = Array.from({ length: 7 }, (_, index) => ({
      orderNumber: `ORD-${100001 + index}`,
      phone: "+9647801234567",
      total: "15000.00",
      placedAt: `2026-08-${String(31 - index).padStart(2, "0")}T08:00:00.000Z`,
      reservationExpiresAt: "2026-09-01T08:00:00.000Z",
    }));

    expect(
      sanitizeRecentOrders([null, { orderNumber: "" }, ...values]),
    ).toHaveLength(5);
    expect(findTrustedRecentOrder(values, "ORD-999999")).toBeNull();
    expect(findTrustedRecentOrder(values, "ord-100001")?.orderNumber).toBe(
      "ORD-100001",
    );
  });
});
