import { describe, expect, it } from "vitest";

import { isAllowedStorefrontNotificationPath, storefrontPathFromNotificationData } from "../lib/customer-notification-routes";

describe("storefront notification routes", () => {
  it("accepts only internal storefront destinations", () => {
    expect(isAllowedStorefrontNotificationPath("/product/42")).toBe(true);
    expect(isAllowedStorefrontNotificationPath("/orders")).toBe(true);
    expect(isAllowedStorefrontNotificationPath("https://example.com")).toBe(false);
    expect(isAllowedStorefrontNotificationPath("//example.com")).toBe(false);
  });

  it("extracts a valid route from notification data", () => {
    expect(storefrontPathFromNotificationData({ path: "/cart" })).toBe("/cart");
    expect(storefrontPathFromNotificationData({ path: "/product/not-a-number" })).toBeNull();
    expect(storefrontPathFromNotificationData(null)).toBeNull();
  });
});
