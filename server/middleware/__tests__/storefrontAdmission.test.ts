import { describe, expect, it } from "vitest";
import {
  publicBatchCost,
  storefrontResourceAdmission,
} from "../storefrontAdmission";

describe("public batch classification", () => {
  it("starts in observe by default", () => {
    expect(storefrontResourceAdmission().policy.mode).toBe("observe");
  });
  it.each([
    "storefront.submitProductReview",
    "storefront.submitPublicProductReview",
  ])(
    "adds the whole-operation review peak for %s to concurrent batch work",
    (path) => {
      expect(publicBatchCost([path, "storefront.catalog"])).toEqual({
        lane: "public-read",
        cost: 5,
      });
      expect(publicBatchCost([path, path])).toEqual({
        lane: "public-read",
        cost: 6,
      });
    },
  );
  it("charges each repeated order procedure", () => {
    expect(
      publicBatchCost(["storefront.createOrder", "storefront.createOrder"]),
    ).toEqual({ lane: "public-order", cost: 2 });
  });
  it("demotes mixed authenticated-admin batches, including private members", () => {
    expect(publicBatchCost(["storefront.catalog", "reports.summary"])).toEqual({
      lane: "public-read",
      cost: 3,
    });
    expect(publicBatchCost(["storefront.createOrder", "sales.create"])).toEqual(
      { lane: "public-read", cost: 2, mixedOrder: true },
    );
    expect(publicBatchCost(["sales.create"])).toBeNull();
  });
  it("reserves the once-per-request two-read auth peak without charging every member", () => {
    expect(publicBatchCost(["storefront.offers"])).toEqual({
      lane: "public-read",
      cost: 2,
    });
    expect(publicBatchCost(["storefront.createOrder"])).toEqual({
      lane: "public-order",
      cost: 2,
    });
    expect(
      publicBatchCost(["storefront.offers", "storefront.banners"]),
    ).toEqual({ lane: "public-read", cost: 2 });
    expect(publicBatchCost(["storefront.quoteOrderPrivate"])).toEqual({
      lane: "public-order",
      cost: 2,
    });
  });
});
import { publicBatchCost as checkoutBatchCost } from "../storefrontAdmission";
describe("checkout quotation classification", () => {
  it("protects both quote transports and rejects mixed quote/read batches", () => {
    for (const path of [
      "storefront.quoteOrder",
      "storefront.quoteOrderPrivate",
    ])
      expect(checkoutBatchCost([path])).toMatchObject({
        lane: "public-order",
        cost: 2,
      });
    expect(
      checkoutBatchCost(["storefront.quoteOrder", "storefront.catalog"]),
    ).toMatchObject({ mixedOrder: true });
  });
});
