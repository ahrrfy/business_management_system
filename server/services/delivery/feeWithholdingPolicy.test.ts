import { describe, expect, it } from "vitest";
import { isWithholdableShopFeeSource } from "./feeWithholdingPolicy";

describe("isWithholdableShopFeeSource", () => {
  it("يسمح بحسم أجرة التوصيل على المكتبة لفواتير البيع وأوامر الشغل والمتجر الإلكتروني", () => {
    expect(isWithholdableShopFeeSource("ONLINE_ORDER")).toBe(true);
    expect(isWithholdableShopFeeSource("INVOICE")).toBe(true);
    expect(isWithholdableShopFeeSource("WORK_ORDER")).toBe(true);
  });

  it("يُبقي معالجة النقص والتجهيز المستقل خارج الحسم التلقائي من التوريد", () => {
    expect(isWithholdableShopFeeSource("AFTERCARE_EXECUTION")).toBe(false);
    expect(isWithholdableShopFeeSource("FULFILLMENT_REQUEST")).toBe(false);
    expect(isWithholdableShopFeeSource(null)).toBe(false);
    expect(isWithholdableShopFeeSource(undefined)).toBe(false);
  });
});
