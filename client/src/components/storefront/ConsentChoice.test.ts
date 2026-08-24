import { describe, expect, it } from "vitest";

import { readStorefrontConsent } from "./ConsentChoice";

function storage(value: string | null): Pick<Storage, "getItem"> {
  return { getItem: () => value };
}

describe("storefront consent", () => {
  it("defaults to no consent for missing or malformed values", () => {
    expect(readStorefrontConsent(storage(null))).toBeNull();
    expect(readStorefrontConsent(storage("not-json"))).toBeNull();
    expect(readStorefrontConsent(storage(JSON.stringify({ analytics: true })))).toBeNull();
  });

  it("reads explicit analytics and marketing choices only", () => {
    const incomplete = JSON.stringify({ analytics: true, marketing: false });
    expect(readStorefrontConsent(storage(incomplete))).toBeNull();
    expect(readStorefrontConsent(storage(JSON.stringify({ necessary: true, analytics: true, marketing: false, updatedAt: "2026-08-24T00:00:00.000Z" })))).toEqual({
      necessary: true,
      analytics: true,
      marketing: false,
      updatedAt: "2026-08-24T00:00:00.000Z",
    });
  });
});
