import { describe, expect, it } from "vitest";
import { hashCouponCode, normalizeCouponCode } from "../couponService";

describe("coupon code identity", () => {
  it("normalizes case and whitespace consistently", () => {
    expect(normalizeCouponCode(" crm-abc-123 \n")).toBe("CRM-ABC-123");
    expect(hashCouponCode("crm-abc-123")).toBe(hashCouponCode(" CRM-ABC-123 "));
  });

  it("does not expose the coupon value in the lookup hash", () => {
    const hash = hashCouponCode("CRM-SECRET-999");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain("SECRET");
  });
});
