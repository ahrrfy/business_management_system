import { describe, expect, it } from "vitest";

import {
  validateExpoPushToken,
  validateStorefrontPushDestination,
  StorefrontPushValidationError,
} from "../storeAdmin/storefrontPushCampaignService";

describe("storefront push campaign validation", () => {
  it("accepts Expo tokens and internal storefront paths only", () => {
    expect(validateExpoPushToken("ExponentPushToken[Abcdefghijk_123456789]")).toContain("ExponentPushToken[");
    expect(validateStorefrontPushDestination("/product/42")).toBe("/product/42");
    expect(validateStorefrontPushDestination("/orders")).toBe("/orders");
  });

  it("rejects arbitrary URLs and malformed device tokens", () => {
    expect(() => validateStorefrontPushDestination("https://attacker.example")).toThrow(StorefrontPushValidationError);
    expect(() => validateStorefrontPushDestination("//attacker.example")).toThrow(StorefrontPushValidationError);
    expect(() => validateExpoPushToken("not-a-device-token")).toThrow(StorefrontPushValidationError);
  });
});
