import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { collectStorefrontFailures, storefrontCategoryCount } from "./Storefront";

describe("storefront source failures", () => {
  it("keeps every failed public source explicit instead of treating it as empty data", () => {
    expect(
      collectStorefrontFailures({
        settings: true,
        categories: true,
        offers: true,
        catalog: true,
      }),
    ).toEqual(["settings", "categories", "offers", "catalog"]);
  });

  it("does not report successful sources as failures", () => {
    expect(
      collectStorefrontFailures({
        settings: false,
        categories: true,
        offers: false,
        catalog: false,
      }),
    ).toEqual(["categories"]);
  });

  it("renders retryable failures and fails closed when settings are unknown", () => {
    const source = readFileSync(new URL("./Storefront.tsx", import.meta.url), "utf8");

    expect(source).toContain("تعذّر تحميل بعض بيانات المتجر");
    expect(source).toContain("settingsQ.refetch()");
    expect(source).toContain("categoriesQ.refetch()");
    expect(source).toContain("offersQ.refetch()");
    expect(source).toContain("catalogQ.refetch()");
    expect(source).toContain("const storeOpen = settingsQ.isSuccess && settingsQ.data.isOpen");
  });
});

describe("storefront availability contract", () => {
  const category = { productCount: 12, availableCount: 8 };

  it("shows available category counts for the default in-stock view", () => {
    expect(storefrontCategoryCount(category, "IN_STOCK")).toBe(8);
  });

  it("shows total category counts when the visitor asks for all products", () => {
    expect(storefrontCategoryCount(category, "ALL")).toBe(12);
  });

  it("passes availability to the catalog API instead of relying only on client filtering", () => {
    const source = readFileSync(new URL("./Storefront.tsx", import.meta.url), "utf8");

    expect(source).toMatch(/const catalogInput = \{[\s\S]*?availability,[\s\S]*?\} as const;/);
    expect(source).toContain("trpc.storefront.catalog.useQuery(\n    catalogInput");
  });
});
