import { describe, expect, it } from "vitest";
import { storefrontCatalogProductScope } from "../../components/storefront/storefrontCatalogModel";

describe("storefront product refinements", () => {
  it("keeps empty themed results empty instead of widening to the entire catalog", () => {
    expect(storefrontCatalogProductScope(false, new Set([1, 2]), [])).toEqual(
      [],
    );
    expect(storefrontCatalogProductScope(true, new Set([1, 2]), [])).toEqual(
      [],
    );
  });

  it("intersects a wishlist with the selected thematic scope", () => {
    expect(
      storefrontCatalogProductScope(true, new Set([1, 2, 3]), [2, 4]),
    ).toEqual([2]);
    expect(storefrontCatalogProductScope(true, new Set(), undefined)).toEqual(
      [],
    );
  });

  it("leaves category/search discovery unrestricted when no product scope was chosen", () => {
    expect(
      storefrontCatalogProductScope(false, new Set([1]), undefined),
    ).toBeUndefined();
  });
});
