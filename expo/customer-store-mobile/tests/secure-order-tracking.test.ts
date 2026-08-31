import { describe, expect, it } from "vitest";

import { secureTrackingRequest } from "@/lib/storefront-api";

describe("secure order tracking adapter", () => {
  it("uses the authenticated POST contract without putting the session in a route", () => {
    expect(secureTrackingRequest({
      orderNumber: "ord-100001",
      customerSessionToken: "s".repeat(80),
    })).toEqual({
      procedure: "storefront.trackOrderPrivate",
      input: { customerSessionToken: "s".repeat(80), orderNumber: "ORD-100001" },
    });
  });

  it("uses the opaque guest token and never falls back to phone lookup", () => {
    const token = `a${"b".repeat(80)}`;
    expect(secureTrackingRequest({ orderNumber: "ORD-100001", guestTrackingToken: token, customerSessionToken: "s".repeat(80) })).toEqual({
      procedure: "storefront.trackOrderByToken",
      input: { trackingToken: token },
    });
    expect(() => secureTrackingRequest({ orderNumber: "ORD-100001" })).toThrow(/صلاحية محفوظة/);
  });
});
