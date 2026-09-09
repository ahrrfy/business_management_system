import { describe, expect, it } from "vitest";
import { hasOverfilledPublicSensitiveBatch } from "../publicSensitiveBatch";

describe("storefront public sensitive batch guard", () => {
  it.each([
    "storefront.quoteOrderPrivate",
    "storefront.trackOrderPrivate",
    "storefront.trackOrderByToken",
    "storefront.trackQuoteRequestPrivate",
    "storefront.trackQuoteRequestByToken",
    "storefront.cancelOrderPrivate",
    "storefront.cancelOrderByToken",
  ])("counts repeated %s operations against the per-request limit", (procedure) => {
    expect(hasOverfilledPublicSensitiveBatch(`/${procedure},${procedure}`)).toBe(true);
    expect(hasOverfilledPublicSensitiveBatch(`/${procedure}`)).toBe(false);
  });

  it("blocks a mixed batch of private quote, tracking, and cancellation surfaces", () => {
    expect(
      hasOverfilledPublicSensitiveBatch(
        "/storefront.quoteOrderPrivate,storefront.trackOrderPrivate,storefront.trackQuoteRequestByToken,storefront.cancelOrderPrivate",
      ),
    ).toBe(true);
  });
});
