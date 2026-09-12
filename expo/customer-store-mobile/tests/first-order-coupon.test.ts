import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
const api = readFileSync(resolve(root, "lib/storefront-api.ts"), "utf8");
const loyalty = readFileSync(resolve(root, "app/loyalty.tsx"), "utf8");

describe("first-order coupon request contract", () => {
  it("uses the verified-session mutation and states that the customer requests it", () => {
    expect(api).toContain("requestStorefrontFirstOrderCoupon");
    expect(api).toContain('"storefront.requestFirstOrderCoupon"');
    expect(loyalty).toContain("اطلبه بنفسك قبل إنشاء أول طلب");
    expect(loyalty).toContain("طلب كوبون الطلب الأول");
  });
});
