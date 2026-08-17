import { describe, expect, it } from "vitest";
import {
  hasOverfilledPublicSensitiveBatch,
  parseCanonicalTrpcProcedures,
} from "../../middleware/publicSensitiveBatch";

describe("public sensitive tRPC batch guard", () => {
  it("يرفض دفعة تضم طلبي متجر، فلا يضخّم حد الطلب إلى 20x", () => {
    expect(hasOverfilledPublicSensitiveBatch("/storefront.createOrder,storefront.createOrder")).toBe(true);
  });

  it("يرفض تكرار quote أو جمع quote مع create في دفعة واحدة", () => {
    expect(hasOverfilledPublicSensitiveBatch("/storefront.quoteOrder,storefront.quoteOrder")).toBe(true);
    expect(hasOverfilledPublicSensitiveBatch("/storefront.quoteOrder,storefront.createOrder")).toBe(true);
  });

  it("يرفض fail-closed الفاصلة والنقطة المرمزتين قبل أن يفكهما tRPC", () => {
    expect(parseCanonicalTrpcProcedures("/storefront.createOrder%2Cstorefront%2EcreateOrder")).toBeNull();
    expect(hasOverfilledPublicSensitiveBatch("/storefront.createOrder%2Cstorefront%2EcreateOrder")).toBe(true);
    expect(parseCanonicalTrpcProcedures("/storefront.quoteOrder%2cstorefront.quoteOrder")).toBeNull();
  });

  it("يطابق اسم الإجراء كاملاً لا substring مصطنعاً", () => {
    expect(hasOverfilledPublicSensitiveBatch("/fake.storefront.createOrder,fake.storefront.createOrder")).toBe(false);
  });

  it("يبقي طلباً حساساً واحداً أو قراءات عادية قابلة للعمل", () => {
    expect(hasOverfilledPublicSensitiveBatch("/storefront.createOrder")).toBe(false);
    expect(hasOverfilledPublicSensitiveBatch("/storefront.createOrder,storefront.catalog")).toBe(false);
  });

  it("يبقي الحماية السابقة للنقاط الحساسة الأخرى", () => {
    expect(hasOverfilledPublicSensitiveBatch("/auth.login,storefront.trackOrder")).toBe(true);
  });
});
