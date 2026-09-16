import { describe, expect, it } from "vitest";

import { secureOrderCancellationRequest } from "@/lib/storefront-api";

describe("secure storefront order cancellation adapter", () => {
  it("uses the authenticated POST contract for a verified customer", () => {
    expect(secureOrderCancellationRequest({
      orderNumber: "ord-100001",
      customerSessionToken: "s".repeat(80),
    })).toEqual({
      procedure: "storefront.cancelOrderPrivate",
      input: { customerSessionToken: "s".repeat(80), orderNumber: "ORD-100001" },
    });
  });

  it("uses only the opaque guest token and rejects an unauthorised request", () => {
    const token = `a${"b".repeat(80)}`;
    expect(secureOrderCancellationRequest({
      orderNumber: "ORD-100001",
      guestTrackingToken: token,
      customerSessionToken: "s".repeat(80),
    })).toEqual({
      procedure: "storefront.cancelOrderByToken",
      input: { trackingToken: token },
    });
    expect(() => secureOrderCancellationRequest({ orderNumber: "ORD-100001" })).toThrow(/صلاحية محفوظة/);
  });
});
