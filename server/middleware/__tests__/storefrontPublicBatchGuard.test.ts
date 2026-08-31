import { describe, expect, it } from "vitest";
import { hasOverfilledPublicSensitiveBatch } from "../publicSensitiveBatch";

describe("storefront public sensitive batch guard", () => {
  it.each([
    "storefront.quoteOrderPrivate",
    "storefront.trackOrderPrivate",
    "storefront.trackOrderByToken",
  ])("counts repeated %s operations against the per-request limit", (procedure) => {
    expect(hasOverfilledPublicSensitiveBatch(`/${procedure},${procedure}`)).toBe(true);
    expect(hasOverfilledPublicSensitiveBatch(`/${procedure}`)).toBe(false);
  });

  it("blocks a mixed batch of private quote and tracking surfaces", () => {
    expect(
      hasOverfilledPublicSensitiveBatch(
        "/storefront.quoteOrderPrivate,storefront.trackOrderPrivate,storefront.trackOrderByToken",
      ),
    ).toBe(true);
  });
});
