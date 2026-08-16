import { describe, expect, it } from "vitest";
import { hasOverfilledPublicSensitiveBatch } from "../../middleware/publicSensitiveBatch";

describe("public sensitive tRPC batch guard", () => {
  it("يرفض دفعة تضم طلبي متجر، فلا يضخّم حد الطلب إلى 20x", () => {
    expect(hasOverfilledPublicSensitiveBatch("/storefront.createOrder,storefront.createOrder")).toBe(true);
  });

  it("يبقي طلباً حساساً واحداً أو قراءات عادية قابلة للعمل", () => {
    expect(hasOverfilledPublicSensitiveBatch("/storefront.createOrder")).toBe(false);
    expect(hasOverfilledPublicSensitiveBatch("/storefront.createOrder,storefront.catalog")).toBe(false);
  });

  it("يبقي الحماية السابقة للنقاط الحساسة الأخرى", () => {
    expect(hasOverfilledPublicSensitiveBatch("/auth.login,storefront.trackOrder")).toBe(true);
  });
});
